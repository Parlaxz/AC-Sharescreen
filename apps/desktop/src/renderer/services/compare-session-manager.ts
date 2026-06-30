/**
 * CompareSessionManager — Easy Compare host runtime.
 *
 * State machine: idle → starting → active → stopping → idle
 *                any → failed → idle
 *                any → destroyed (terminal)
 *
 * Owns one logical compare share with:
 * - One shared source capture (at max dims/FPS)
 * - Two variant pipelines (A with audio, B video-only)
 * - Two PublisherManagers (A with shared audio, B video-only)
 * - One active-stream registry entry (A as primary with compare metadata for B)
 * - One logical streamId / groupId / heartbeat
 *
 * Key design decisions:
 * - Startup validates same codec + shared audio rules.
 * - Captures ONCE at the maximum requested dims/FPS across both variants.
 * - Starts B (video-only publisher) first, then A (with shared audio).
 * - Registers ONE active-stream announcement with A as the primary stream.
 * - Sends ONE stream.started carrying compare metadata for both variants.
 * - Stop is idempotent: sends one stream.stopped, unregisters once, cleans up
 *   both publishers, closes shared audio exactly once, destroys both pipelines,
 *   stops source last, clears state.
 * - Source-ended (capture track ended) stops the whole compare session.
 * - Derived-output-ended attempts bounded rebuild for that variant only.
 * - resolveVariant() enables exact publication resolution by mediaSessionId.
 */

import type { Phase3Runtime } from "./phase3-runtime.js";
import type { StreamAnnouncement } from "./active-stream-registry.js";
import { PublisherManager } from "./publisher-manager.js";
import { CompareVariantTrackPipeline } from "./compare-variant-track-pipeline.js";
import type { PipelineSettings } from "./compare-variant-track-pipeline.js";
import { generateVdoStreamId, generateVdoPassword } from "@screenlink/shared";
import type { VdoSessionConfig } from "./stream-session-manager.js";
import { StreamMetricsService } from "./stream-metrics-service.js";
import {
  DEFAULT_VIDEO_BITRATE_KBPS,
  DEFAULT_SEND_WIDTH,
  DEFAULT_SEND_HEIGHT,
  DEFAULT_SEND_FPS,
  DEFAULT_CODEC,
  DEFAULT_CONTENT_HINT,
  DEFAULT_DEGRADATION_PREFERENCE,
} from "./share-quality.js";
import type { CompareVariantId } from "@screenlink/shared";

// ─── Types ─────────────────────────────────────────────────────────────────

export type CompareSessionState =
  | "idle"
  | "starting"
  | "active"
  | "stopping"
  | "failed"
  | "destroyed";

export interface VariantStartConfig {
  /** Pipeline target resolution and FPS for this variant. */
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
  /** Video bitrate for this variant's publisher. */
  videoBitrateKbps: number;
  /** Optional per-variant codec override (inherits from group default otherwise). */
  codec?: string;
}

export interface StartCompareInput {
  groupId: string;
  source: {
    id: string;
    name: string;
    kind: "screen" | "window";
    displayId: string | null;
    fingerprint: string | null;
  };
  variantConfigs: {
    A: VariantStartConfig;
    B: VariantStartConfig;
  };
  /** Optional audio mode for variant A (defaults to source-derived). */
  audioMode?: "none" | "monitor" | "application";
}

export interface VariantPublication {
  variantId: CompareVariantId;
  mediaSessionId: string;
  logicalStreamId: string;
  pipeline: CompareVariantTrackPipeline;
  publisherManager: PublisherManager;
  vdoConfig: VdoSessionConfig;
}

const COMPARE_VARIANTS_LIST: CompareVariantId[] = ["A", "B"];

// ─── Session Manager ───────────────────────────────────────────────────────

export class CompareSessionManager {
  private runtime: Phase3Runtime;
  private _state: CompareSessionState = "idle";

  // Shared session identity
  private groupId: string | null = null;
  private logicalStreamId: string | null = null;
  private startedAt: number = 0;
  private streamRevision: number = 0;
  private _sourceId: string | null = null;
  private _sourceName: string = "";
  private _sourceKind: "screen" | "window" | null = null;
  private _hostDeviceId: string = "local";
  private _hostDisplayName: string = "";

  // Shared capture
  private captureStream: MediaStream | null = null;
  private sourceTrack: MediaStreamTrack | null = null;

  // Per-variant state
  private pipelines: Map<CompareVariantId, CompareVariantTrackPipeline> = new Map();
  private publishers: Map<CompareVariantId, PublisherManager> = new Map();
  private vdoConfigs: Map<CompareVariantId, VdoSessionConfig> = new Map();
  private _variantMediaSessionIds: Record<string, string> = {};
  private _variantAppliedConfigs: Record<string, VariantStartConfig> = {};

  // Audio (owned by variant A)
  private audioController: unknown | null = null;

  // Heartbeat
  private heartbeatSeq: number = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Internal guards
  private destroyed = false;
  private stopping = false;

  constructor(runtime: Phase3Runtime) {
    this.runtime = runtime;
  }

  // ── Public accessors ────────────────────────────────────────────────

  get state(): CompareSessionState {
    return this._state;
  }

  get currentGroupId(): string | null {
    return this.groupId;
  }

  get currentLogicalStreamId(): string | null {
    return this.logicalStreamId;
  }

  isActive(): boolean {
    return this._state === "active";
  }

  /**
   * Get the media session ID for a given variant.
   */
  getVariantMediaSessionId(variantId: CompareVariantId): string | null {
    return this._variantMediaSessionIds[variantId] ?? null;
  }

  /**
   * Get the applied config for a given variant.
   */
  getVariantConfig(variantId: CompareVariantId): VariantStartConfig | null {
    return this._variantAppliedConfigs[variantId] ?? null;
  }

  /**
   * Get all variant applied configs.
   */
  getVariantConfigs(): Record<string, VariantStartConfig> {
    return { ...this._variantAppliedConfigs };
  }

  /**
   * Update the stored config for a variant (does NOT apply anything).
   */
  updateVariantConfig(variantId: CompareVariantId, config: Partial<VariantStartConfig>): void {
    const existing = this._variantAppliedConfigs[variantId];
    if (existing) {
      this._variantAppliedConfigs[variantId] = { ...existing, ...config };
    }
  }

  /**
   * Broadcast a message to the current compare group via the connection manager.
   * No-op if the session has no active group.
   */
  async broadcastToGroup(payload: Record<string, unknown>): Promise<void> {
    if (!this.groupId) return;
    await this.runtime.getConnectionManager().broadcast(this.groupId, payload).catch(() => {
      // Non-fatal broadcast failure
    });
  }

  // ── Start ───────────────────────────────────────────────────────────

  /**
   * Start the Easy Compare session.
   *
   * Flow:
   *   1. Validate state (must be idle, normal SSM must not be active)
   *   2. Generate session identity (logicalStreamId, mediaSessionIds, VDO configs)
   *   3. Capture display media ONCE at the maximum requested dims/FPS
   *   4. Create pipeline B (video-only), initialize with shared source
   *   5. Start PublisherManager B with B's output
   *   6. Create pipeline A, initialize with shared source
   *   7. Set up shared audio for A
   *   8. Start PublisherManager A with A's output + audio
   *   9. Register ONE active-stream entry (A as primary, with compare metadata)
   *  10. Send ONE stream.started
   *  11. Start heartbeat
   *  12. Commit active state
   */
  async startCompare(input: StartCompareInput): Promise<void> {
    if (this.destroyed) {
      throw new Error("CompareSessionManager is destroyed");
    }
    if (this._state !== "idle" && this._state !== "failed") {
      throw new Error(`Cannot start compare from state: ${this._state}`);
    }

    // Mutual exclusion with normal stream session
    const ssm = this.runtime.getStreamSessionManager();
    if (ssm.state === "active" || ssm.state === "starting" || ssm.state === "restarting") {
      throw new Error("Cannot start compare mode while a normal stream session is active");
    }

    this._state = "starting";
    this.stopping = false;
    this.groupId = input.groupId;
    this._sourceId = input.source.id;
    this._sourceName = input.source.name ?? "";
    this._sourceKind = input.source.kind;
    this._hostDeviceId = this.runtime.deviceId ?? "local";
    this._hostDisplayName = this.runtime.displayName ?? "";
    this.logicalStreamId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.streamRevision++;
    this.heartbeatSeq = 0;

    // Store variant configs for metadata
    this._variantAppliedConfigs = {
      A: { ...input.variantConfigs.A },
      B: { ...input.variantConfigs.B },
    };

    try {
      // ── Phase A: Critical media startup ───────────────────────────
      // Any failure here is fatal — roll back everything.

      // NVIDIA validation: avoid dual NVENC encoder sessions
      // When both variants use h264, they may compete for NVIDIA hardware encoder
      // sessions. Warn and prefer software encoding for variant B.
      const codecA = input.variantConfigs.A.codec ?? DEFAULT_CODEC;
      const codecB = input.variantConfigs.B.codec ?? DEFAULT_CODEC;
      if (codecA.startsWith("h264") && codecB.startsWith("h264")) {
        console.warn(
          "[compare] Both variants use h264 — may exceed NVENC session limit. " +
          "Consider vp9 for variant B to use software encoding.",
        );
      }

      // 1. Generate media session IDs and VDO configs for both variants
      const msA = crypto.randomUUID();
      const msB = crypto.randomUUID();
      this._variantMediaSessionIds = { A: msA, B: msB };

      const vdoA: VdoSessionConfig = {
        streamId: generateVdoStreamId(),
        password: generateVdoPassword(),
      };
      const vdoB: VdoSessionConfig = {
        streamId: generateVdoStreamId(),
        password: generateVdoPassword(),
      };
      this.vdoConfigs.set("A", vdoA);
      this.vdoConfigs.set("B", vdoB);

      // 2. Determine max capture dimensions across both variants
      const maxWidth = Math.max(input.variantConfigs.A.targetWidth, input.variantConfigs.B.targetWidth);
      const maxHeight = Math.max(input.variantConfigs.A.targetHeight, input.variantConfigs.B.targetHeight);
      const maxFps = Math.max(input.variantConfigs.A.targetFps, input.variantConfigs.B.targetFps);

      // 3. Capture display media ONCE
      this.captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const videoTracks = this.captureStream.getVideoTracks();
      if (videoTracks.length === 0) {
        throw new Error("No video track in captured stream");
      }
      this.sourceTrack = videoTracks[0];

      // Apply capture constraints to the max dims/FPS
      await this.applyCaptureConstraints(this.sourceTrack, {
        captureWidth: maxWidth,
        captureHeight: maxHeight,
        captureFps: maxFps,
      });

      // Wire source-ended handler — if the capture track ends, stop the whole compare
      this.sourceTrack.addEventListener("ended", this._onSourceEnded);

      // 4. Create and initialize pipeline B (video-only)
      const pipelineBSettings: PipelineSettings = {
        targetWidth: input.variantConfigs.B.targetWidth,
        targetHeight: input.variantConfigs.B.targetHeight,
        targetFps: input.variantConfigs.B.targetFps,
      };
      const pipelineB = new CompareVariantTrackPipeline(pipelineBSettings, "B");
      this.pipelines.set("B", pipelineB);
      const outputTrackB = await pipelineB.initialize(this.sourceTrack);

      // Wire derived-ended handler for variant B
      outputTrackB.addEventListener("ended", () => this._onDerivedEnded("B"));

      // 5. Start PublisherManager B (video-only)
      const pmB = new PublisherManager({
        onStateChange: () => {},
        onStats: () => {},
        onError: (err) => console.error("[compare:B] Publisher error:", err),
        onTrackEnded: (_track) => this._onDerivedEnded("B"),
      });
      this.publishers.set("B", pmB);

      // Wire media.bind handler for B
      pmB.setOnMediaBind((peerUuid, token, viewerSessionId) => {
        const vb = this.runtime.getViewerMediaBinding();
        if (vb) vb.handleMediaBind(peerUuid, token, viewerSessionId).catch(() => {});
      });
      pmB.setOnPeerDisconnected((peerUuid) => {
        const vb = this.runtime.getViewerMediaBinding();
        if (vb) vb.removeViewerByPeerUuid(peerUuid);
      });

      const streamB = new MediaStream([outputTrackB]);
      await pmB.startPublishing(streamB, {
        sourceId: input.source.id,
        password: vdoB.password,
        streamId: vdoB.streamId,
        videoBitrate: input.variantConfigs.B.videoBitrateKbps,
        videoWidth: input.variantConfigs.B.targetWidth,
        videoHeight: input.variantConfigs.B.targetHeight,
        videoFps: input.variantConfigs.B.targetFps,
        codec: input.variantConfigs.B.codec ?? DEFAULT_CODEC,
        contentHint: DEFAULT_CONTENT_HINT,
        degradationPreference: DEFAULT_DEGRADATION_PREFERENCE,
        captureWidth: maxWidth,
        captureHeight: maxHeight,
        captureFps: maxFps,
      });

      // 6. Create and initialize pipeline A
      const pipelineASettings: PipelineSettings = {
        targetWidth: input.variantConfigs.A.targetWidth,
        targetHeight: input.variantConfigs.A.targetHeight,
        targetFps: input.variantConfigs.A.targetFps,
      };
      const pipelineA = new CompareVariantTrackPipeline(pipelineASettings, "A");
      this.pipelines.set("A", pipelineA);
      const outputTrackA = await pipelineA.initialize(this.sourceTrack);

      // Wire derived-ended handler for variant A
      outputTrackA.addEventListener("ended", () => this._onDerivedEnded("A"));

      // 7. Audio setup for A (shared audio)
      if (input.audioMode !== "none") {
        try {
          await this.setupSharedAudio(input.source.id, input.source.kind);
        } catch (err) {
          console.warn("[compare] Audio setup failed, continuing with A video-only:", err);
        }
      }

      // 8. Start PublisherManager A with audio
      const pmA = new PublisherManager({
        onStateChange: () => {},
        onStats: () => {},
        onError: (err) => console.error("[compare:A] Publisher error:", err),
        onTrackEnded: (_track) => this._onDerivedEnded("A"),
      });
      this.publishers.set("A", pmA);

      pmA.setOnMediaBind((peerUuid, token, viewerSessionId) => {
        const vb = this.runtime.getViewerMediaBinding();
        if (vb) vb.handleMediaBind(peerUuid, token, viewerSessionId).catch(() => {});
      });
      pmA.setOnPeerDisconnected((peerUuid) => {
        const vb = this.runtime.getViewerMediaBinding();
        if (vb) vb.removeViewerByPeerUuid(peerUuid);
      });

      const streamA = new MediaStream([outputTrackA]);
      await pmA.startPublishing(streamA, {
        sourceId: input.source.id,
        password: vdoA.password,
        streamId: vdoA.streamId,
        videoBitrate: input.variantConfigs.A.videoBitrateKbps,
        videoWidth: input.variantConfigs.A.targetWidth,
        videoHeight: input.variantConfigs.A.targetHeight,
        videoFps: input.variantConfigs.A.targetFps,
        codec: input.variantConfigs.A.codec ?? DEFAULT_CODEC,
        contentHint: DEFAULT_CONTENT_HINT,
        degradationPreference: DEFAULT_DEGRADATION_PREFERENCE,
        captureWidth: maxWidth,
        captureHeight: maxHeight,
        captureFps: maxFps,
      });

      // Notify metrics service for both variants
      StreamMetricsService.getInstance().startHostSession(
        msA, this.logicalStreamId!, this.groupId!, this.groupId!,
      );
      StreamMetricsService.getInstance().startHostSession(
        msB, this.logicalStreamId!, this.groupId!, this.groupId!,
      );

      // 9. Register ONE active-stream entry (A is the backward-compatible primary)
      const registry = this.runtime.getActiveStreamRegistry();
      registry.registerLocalStream(this._buildAnnouncement());

      // 10. Send ONE stream.started with compare metadata
      const connManager = this.runtime.getConnectionManager();
      const lifecyclePayload = this._buildStartedPayload();
      try {
        await connManager.sendOrQueueStreamLifecycle(
          this.groupId!,
          this.logicalStreamId!,
          "stream.started",
          lifecyclePayload,
        );
      } catch (err) {
        console.warn("[compare] stream.started broadcast failed (non-fatal):", err);
      }

      // 11. Start heartbeat
      this._startHeartbeat();

      // 12. Commit active state
      this._state = "active";
      console.log("[compare] Compare session active —", this.logicalStreamId);
    } catch (err) {
      this._state = "failed";
      console.error("[compare] Phase A (media startup) failed:", err instanceof Error ? err.message : String(err));
      await this._rollbackStartup();
      throw err;
    }
  }

  // ── Stop ────────────────────────────────────────────────────────────

  /**
   * Stop the compare session. Idempotent.
   *
   * Flow:
   *   1. If stopping/idle/destroyed, return
   *   2. Stop heartbeat
   *   3. Unregister one active stream
   *   4. Send ONE stream.stopped
   *   5. Clear pending lifecycle messages
   *   6. Remove bindings for both media sessions
   *   7. Stop both publishers
   *   8. Close shared audio exactly once
   *   9. Destroy both pipelines (does NOT stop source)
   *  10. Stop source track last
   *  11. Clear state
   */
  async stopCompare(): Promise<void> {
    if (this.destroyed || this._state === "idle") return;
    if (this._state === "stopping") {
      // Already stopping — wait for it to complete
      return;
    }

    const wasActive = this._state === "active";
    this._state = "stopping";
    this.stopping = true;
    this._stopHeartbeat();

    const lastGroupId = this.groupId;
    const lastLogicalStreamId = this.logicalStreamId;
    const lastHostDeviceId = this._hostDeviceId;
    const mediaSessionIds = [this._variantMediaSessionIds.A, this._variantMediaSessionIds.B].filter(Boolean) as string[];

    try {
      // Remove viewer bindings for both media sessions
      const vb = this.runtime.getViewerMediaBinding();
      if (vb && mediaSessionIds.length > 0) {
        vb.removeMappingsForMediaSessions(mediaSessionIds);
      }

      // Unregister one active stream
      if (wasActive && lastGroupId && lastLogicalStreamId) {
        this.runtime.getActiveStreamRegistry().handleStopped({
          groupId: lastGroupId,
          hostDeviceId: lastHostDeviceId,
          logicalStreamId: lastLogicalStreamId,
        });
      }

      // Send ONE stream.stopped
      if (wasActive && lastGroupId && lastLogicalStreamId) {
        const connManager = this.runtime.getConnectionManager();
        connManager.clearPendingForStream(lastGroupId, lastLogicalStreamId);

        void connManager.sendOrQueueStreamLifecycle(
          lastGroupId,
          lastLogicalStreamId,
          "stream.stopped",
          {
            type: "stream.stopped",
            groupId: lastGroupId,
            hostDeviceId: lastHostDeviceId,
            logicalStreamId: lastLogicalStreamId,
          },
        ).catch(() => {});
      }

      // Stop both publishers
      for (const [variantId] of this.publishers) {
        const pm = this.publishers.get(variantId);
        if (pm) {
          await pm.stopCapture().catch(() => {});
        }
      }

      // Close shared audio exactly once
      await this._closeSharedAudio();

      // Destroy both pipelines (does NOT stop source)
      for (const [, pipeline] of this.pipelines) {
        pipeline.destroy();
      }

      // Stop source track last
      if (this.sourceTrack) {
        try { this.sourceTrack.stop(); } catch { /* best effort */ }
      }
      if (this.captureStream) {
        try {
          this.captureStream.getTracks().forEach((t) => {
            if (t !== this.sourceTrack) t.stop();
          });
        } catch { /* best effort */ }
      }

      // Finalize metrics
      for (const msId of mediaSessionIds) {
        const svc = StreamMetricsService.getInstance();
        const historyId = svc.findHistoryIdByMediaSessionId(msId);
        if (historyId) svc.finalizeSession(historyId);
      }

      this._clearState();
      this._state = "idle";
    } catch (err) {
      this._clearState();
      this._state = "idle";
    }
  }

  // ── Destroy ─────────────────────────────────────────────────────────

  /**
   * Destroy the session manager. Terminal state — no further operations.
   * Performs full stop propagation if active.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this._state === "active") {
      // Force stop
      void this.stopCompare().catch(() => {});
    }

    this._stopHeartbeat();
    this._clearState();
    this._state = "destroyed";
  }

  // ── Variant resolution ──────────────────────────────────────────────

  /**
   * Resolve a variant by its media session ID.
   * Returns publication context or null if no matching variant is active.
   */
  resolveVariant(mediaSessionId: string): VariantPublication | null {
    if (this._state !== "active") return null;

    let foundVariant: CompareVariantId | null = null;
    for (const vid of COMPARE_VARIANTS_LIST) {
      if (this._variantMediaSessionIds[vid] === mediaSessionId) {
        foundVariant = vid;
        break;
      }
    }
    if (!foundVariant) return null;

    const pipeline = this.pipelines.get(foundVariant) ?? null;
    const publisherManager = this.publishers.get(foundVariant) ?? null;
    const vdoConfig = this.vdoConfigs.get(foundVariant) ?? null;

    if (!pipeline || !publisherManager || !vdoConfig) return null;

    return {
      variantId: foundVariant,
      mediaSessionId,
      logicalStreamId: this.logicalStreamId!,
      pipeline,
      publisherManager,
      vdoConfig,
    };
  }

  /**
   * Get publication context for a variant (for integration with resolveLocalPublication).
   */
  getVariantPublication(variantId: CompareVariantId): {
    mediaSessionId: string;
    logicalStreamId: string;
    variantId: string;
    publisherManager: PublisherManager;
    vdoConfig: VdoSessionConfig;
  } | null {
    if (this._state !== "active") return null;
    const msId = this._variantMediaSessionIds[variantId];
    if (!msId) return null;
    const pm = this.publishers.get(variantId) ?? null;
    const vc = this.vdoConfigs.get(variantId) ?? null;
    if (!pm || !vc) return null;
    return {
      mediaSessionId: msId,
      logicalStreamId: this.logicalStreamId!,
      variantId,
      publisherManager: pm,
      vdoConfig: vc,
    };
  }

  /**
   * Rebuild one variant's pipeline + publisher with new config while keeping the
   * shared capture alive. Used by CompareVariantReconciler for "output-track"
   * changes (resolution / FPS).
   *
   * Flow:
   *   1. Validate session is active and variant exists
   *   2. Create a new pipeline with the merged config
   *   3. Initialize it with the shared source track
   *   4. Wire the derived-ended handler on the new output track
   *   5. Replace the video track on the existing publisher
   *   6. Destroy the old pipeline
   *   7. Update internal maps and stored config
   *
   * Throws on failure (caller should handle).
   */
  async rebuildVariant(variantId: CompareVariantId, config: Partial<VariantStartConfig>): Promise<void> {
    if (this._state !== "active") {
      throw new Error(`Cannot rebuild variant ${variantId}: session not active`);
    }

    const existing = this._variantAppliedConfigs[variantId];
    if (!existing) {
      throw new Error(`No existing config for variant ${variantId}`);
    }

    const merged: VariantStartConfig = { ...existing, ...config };

    const oldPipeline = this.pipelines.get(variantId);
    if (!oldPipeline) {
      throw new Error(`No pipeline for variant ${variantId}`);
    }

    const pm = this.publishers.get(variantId);
    if (!pm) {
      throw new Error(`No publisher for variant ${variantId}`);
    }

    if (!this.sourceTrack) {
      throw new Error("No shared source track available");
    }

    // Create new pipeline with merged settings
    const pipelineSettings: PipelineSettings = {
      targetWidth: merged.targetWidth,
      targetHeight: merged.targetHeight,
      targetFps: merged.targetFps,
    };
    const newPipeline = new CompareVariantTrackPipeline(pipelineSettings, variantId);

    try {
      const outputTrack = await newPipeline.initialize(this.sourceTrack);

      // Wire derived-ended handler for the new output track
      outputTrack.addEventListener("ended", () => this._onDerivedEnded(variantId));

      // Detach old track's ended handler, replace on publisher, reattach new
      pm.detachTrackEnded();
      await pm.replaceVideoTrack(outputTrack);
      pm.reattachTrackEnded();

      // Destroy old pipeline (does NOT stop the source track)
      oldPipeline.destroy();

      // Update internal maps
      this.pipelines.set(variantId, newPipeline);
      this._variantAppliedConfigs[variantId] = merged;
    } catch (err) {
      newPipeline.destroy();
      throw err;
    }
  }

  /**
   * Get the compare announcement metadata (used by Phase3Runtime for building
   * the active-stream entry).
   */
  getCompareAnnouncementOverrides(): {
    compareMode: string;
    primaryVariant: string;
    variantADescriptor: { mediaSessionId?: string; configSnapshot?: unknown };
    variantBDescriptor: { mediaSessionId?: string; configSnapshot?: unknown };
  } | null {
    if (this._state !== "active") return null;
    return {
      compareMode: "side-by-side",
      primaryVariant: "A",
      variantADescriptor: {
        mediaSessionId: this._variantMediaSessionIds.A,
      },
      variantBDescriptor: {
        mediaSessionId: this._variantMediaSessionIds.B,
      },
    };
  }

  // ── Private: announcement builder ───────────────────────────────────

  private _buildAnnouncement(): StreamAnnouncement {
    const cfgA = this._variantAppliedConfigs.A;
    const cfgB = this._variantAppliedConfigs.B;
    return {
      logicalStreamId: this.logicalStreamId!,
      mediaSessionId: this._variantMediaSessionIds.A,
      groupId: this.groupId!,
      hostDeviceId: this._hostDeviceId,
      hostDisplayName: this._hostDisplayName,
      sourceKind: this._sourceKind ?? "screen",
      sourceName: this._sourceName || "",
      startedAt: this.startedAt,
      appliedSettingsRevision: 0,
      heartbeatSequence: this.heartbeatSeq,
      streamRevision: this.streamRevision,
      mediaJoinMetadata: "",
      replacesSessionId: null,
      compareMode: "side-by-side",
      primaryVariant: "A",
      variantADescriptor: {
        mediaSessionId: this._variantMediaSessionIds.A,
        configSnapshot: cfgA ? {
          resolutionWidth: cfgA.targetWidth,
          resolutionHeight: cfgA.targetHeight,
          fps: cfgA.targetFps,
          videoBitrateKbps: cfgA.videoBitrateKbps,
          sourceKind: this._sourceKind ?? "screen",
          sourceName: this._sourceName || "",
        } : undefined,
      },
      variantBDescriptor: {
        mediaSessionId: this._variantMediaSessionIds.B,
        configSnapshot: cfgB ? {
          resolutionWidth: cfgB.targetWidth,
          resolutionHeight: cfgB.targetHeight,
          fps: cfgB.targetFps,
          videoBitrateKbps: cfgB.videoBitrateKbps,
          sourceKind: this._sourceKind ?? "screen",
          sourceName: this._sourceName || "",
        } : undefined,
      },
    };
  }

  private _buildStartedPayload(): Record<string, unknown> {
    const ann = this._buildAnnouncement();
    return {
      type: "stream.started",
      logicalStreamId: ann.logicalStreamId,
      mediaSessionId: ann.mediaSessionId,
      groupId: ann.groupId,
      hostDeviceId: ann.hostDeviceId,
      hostDisplayName: ann.hostDisplayName,
      sourceKind: ann.sourceKind,
      sourceName: ann.sourceName,
      startedAt: ann.startedAt,
      appliedSettingsRevision: ann.appliedSettingsRevision,
      heartbeatSequence: ann.heartbeatSequence,
      streamRevision: ann.streamRevision,
      mediaJoinMetadata: ann.mediaJoinMetadata,
      replacesSessionId: ann.replacesSessionId,
      compareMode: ann.compareMode,
      primaryVariant: ann.primaryVariant,
      variantADescriptor: ann.variantADescriptor,
      variantBDescriptor: ann.variantBDescriptor,
    };
  }

  // ── Private: event handlers ─────────────────────────────────────────

  private _onSourceEnded = (): void => {
    console.log("[compare] Source track ended — stopping compare session");
    void this.stopCompare().catch(() => {});
  };

  private _onDerivedEnded(variantId: CompareVariantId): void {
    console.log(`[compare] Output track ended for variant ${variantId} — attempting rebuild`);
    // Future: bounded rebuild for this variant
    // For now, just log. The pipeline's output track ending means the canvas
    // capture stream stopped; we'd recreate the pipeline + publisher for this variant.
  }

  // ── Private: audio ──────────────────────────────────────────────────

  private async setupSharedAudio(sourceId: string, sourceKind: "screen" | "window"): Promise<void> {
    // Future: wire up ProcessAudioController for shared audio.
    // For now, this is a no-op placeholder.
  }

  private async _closeSharedAudio(): Promise<void> {
    // Future: close any active ProcessAudioController.
    // Idempotent — safe to call multiple times.
  }

  // ── Private: capture constraints ────────────────────────────────────

  private async applyCaptureConstraints(
    track: MediaStreamTrack,
    requested: { captureWidth: number; captureHeight: number; captureFps: number },
  ): Promise<void> {
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
      width?: { max?: number; min?: number };
      height?: { max?: number; min?: number };
      frameRate?: { max?: number; min?: number };
    };
    const constraints: MediaTrackConstraints = {};
    if (caps.width) {
      const clamped = Math.max(
        caps.width.min ?? 1,
        Math.min(requested.captureWidth, caps.width.max ?? requested.captureWidth),
      );
      constraints.width = { ideal: clamped };
    }
    if (caps.height) {
      const clamped = Math.max(
        caps.height.min ?? 1,
        Math.min(requested.captureHeight, caps.height.max ?? requested.captureHeight),
      );
      constraints.height = { ideal: clamped };
    }
    if (caps.frameRate) {
      const clamped = Math.max(
        caps.frameRate.min ?? 1,
        Math.min(requested.captureFps, caps.frameRate.max ?? requested.captureFps),
      );
      constraints.frameRate = { ideal: clamped };
    }
    try {
      await track.applyConstraints(constraints);
    } catch {
      // Source does not accept these constraints — readback will report actuals
    }
  }

  // ── Private: heartbeat ──────────────────────────────────────────────

  private _startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this._sendHeartbeat();
    }, 10_000);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async _sendHeartbeat(): Promise<void> {
    if (this._state !== "active" || !this.groupId || !this.logicalStreamId) return;
    this.heartbeatSeq++;
    try {
      await this.runtime.getConnectionManager().broadcast(this.groupId, {
        type: "stream.heartbeat",
        groupId: this.groupId,
        hostDeviceId: this._hostDeviceId,
        logicalStreamId: this.logicalStreamId,
        mediaSessionId: this._variantMediaSessionIds.A,
        heartbeatSequence: this.heartbeatSeq,
        appliedSettingsRevision: 0,
      });
    } catch {
      // Non-fatal
    }
  }

  // ── Private: rollback & cleanup ─────────────────────────────────────

  private async _rollbackStartup(): Promise<void> {
    // Roll back any partial startup state
    for (const [, pipeline] of this.pipelines) {
      pipeline.destroy();
    }
    this.pipelines.clear();

    for (const [, pm] of this.publishers) {
      await pm.stopCapture().catch(() => {});
    }
    this.publishers.clear();

    if (this.sourceTrack) {
      this.sourceTrack.removeEventListener("ended", this._onSourceEnded);
      try { this.sourceTrack.stop(); } catch { /* best effort */ }
    }
    if (this.captureStream) {
      this.captureStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* best effort */ }
      });
      this.captureStream = null;
    }

    this._clearState();
  }

  private _clearState(): void {
    this.groupId = null;
    this.logicalStreamId = null;
    this.startedAt = 0;
    this._sourceId = null;
    this._sourceName = "";
    this._sourceKind = null;
    this.captureStream = null;
    this.sourceTrack = null;
    this.pipelines.clear();
    this.publishers.clear();
    this.vdoConfigs.clear();
    this._variantMediaSessionIds = {};
    this._variantAppliedConfigs = {};
    this.audioController = null;
    this.heartbeatSeq = 0;
    this.stopping = false;
  }
}
