import type { Phase3Runtime } from "./phase3-runtime.js";
import type { StreamAnnouncement } from "./active-stream-registry.js";
import { PublisherManager } from "./publisher-manager.js";
import { extractPeerUuid } from "./sdk-event-normalizer.js";
import {
  generateVdoStreamId,
  generateVdoPassword,
  type AudioMode,
  normalizeAudioMode,
} from "@screenlink/shared";
import { ProcessAudioController } from "../audio/ProcessAudioController.js";
import type { SessionQualityOverride } from "./share-quality.js";
import { StreamMetricsService } from "./stream-metrics-service.js";
import {
  validateSessionQualityOverride,
  DEFAULT_VIDEO_BITRATE_KBPS,
  DEFAULT_SEND_WIDTH,
  DEFAULT_SEND_HEIGHT,
  DEFAULT_SEND_FPS,
  DEFAULT_CODEC,
  DEFAULT_CONTENT_HINT,
  DEFAULT_DEGRADATION_PREFERENCE,
} from "./share-quality.js";

/**
 * Stream session state machine:
 *   idle â†’ starting â†’ active â†’ stopping â†’ idle
 *   active â†’ restarting â†’ active
 *   any â†’ failed â†’ idle
 *   any â†’ destroyed (terminal)
 */
export type StreamSessionState =
  | "idle"
  | "starting"
  | "active"
  | "restarting"
  | "stopping"
  | "failed"
  | "destroyed";

export interface StartStreamInput {
  groupId: string;
  source: {
    id: string;
    name: string;
    kind: "screen" | "window";
    displayId: string | null;
    fingerprint: string | null;
  };
  /**
   * Explicit audio mode from ShareSetup.
   * - `"none"` skips audio setup entirely
   * - `"monitor"` uses filtered monitor audio (screen)
   * - `"application"` uses application audio (window)
   * When omitted, source-derived mode is used (backward compat).
   */
  audioMode?: "none" | "monitor" | "application";
  /**
   * Per-session quality override. When present, these values
   * take precedence over the group default for capture and
   * publication. The override is remembered for the lifetime of
   * the session and reused on restart.
   */
  qualityOverride?: SessionQualityOverride;
}

export interface VdoSessionConfig {
  streamId: string;
  password: string;
}

/**
 * C4: StreamSessionManager (Stage 4)
 *
 * Owns ONE local host stream (single-source assumption).
 * - Owns the full lifecycle: capture, publish, register, heartbeat, stop.
 * - Holds an internal PublisherManager for media publication.
 * - Exposes setAudioController() for external audio pipeline setup.
 * - Dashboard must NOT instantiate PublisherManager directly.
 */
export class StreamSessionManager {
  private _state: StreamSessionState = "idle";
  private groupId: string | null = null;
  private logicalStreamId: string | null = null;
  private mediaSessionId: string | null = null;
  private startedAt: number = 0;
  private streamRevision: number = 0;
  private heartbeatSeq: number = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentTrack: MediaStreamTrack | null = null;
  private destroyed = false;
  private _hostDeviceId = "local";
  private _hostDisplayName = "";
  private publisherManager: PublisherManager | null = null;
  private vdoConfig: VdoSessionConfig | null = null;
  private captureStream: MediaStream | null = null;
  /** Gate 4.4 â€” actual capture dimensions read back from the track. */
  private actualCaptureWidth: number = 0;
  private actualCaptureHeight: number = 0;
  private actualCaptureFps: number = 0;
  private _sourceId: string | null = null;
  private _sourceName: string = "";
  private _sourceKind: "screen" | "window" | null = null;
  private _developerMode = false;
  private _audioModeOverride: AudioMode | null = null;
  private _explicitAudioMode: "none" | "monitor" | "application" | null = null;
  private _isAudioDegraded = false;
  /**
   * Per-session quality override. Cleared on stop/reset/destroy.
   * Reused by restart so the same captured values are applied again.
   */
  private _sessionQualityOverride: SessionQualityOverride | null = null;
  /** Guard against concurrent source switches. Set during switchSource. */
  private isSwitchingSource = false;

  constructor(
    private runtime: Phase3Runtime,
  ) {}

  get state(): StreamSessionState {
    return this._state;
  }

  get currentGroupId(): string | null {
    return this.groupId;
  }

  get currentLogicalStreamId(): string | null {
    return this.logicalStreamId;
  }

  get currentMediaSessionId(): string | null {
    return this.mediaSessionId;
  }

  get hostDeviceId(): string {
    return this._hostDeviceId;
  }

  get hostDisplayName(): string {
    return this._hostDisplayName;
  }

  get isAudioDegraded(): boolean {
    return this._isAudioDegraded;
  }

  /**
   * Stage 13: Set developer mode for audio control.
   */
  setDeveloperMode(enabled: boolean): void {
    this._developerMode = enabled;
  }

  /**
   * Stage 13: Set audio mode override (developer mode only).
   * When developer mode is off, the override is ignored and source-derived
   * mode is used instead.
   */
  setAudioModeOverride(mode: AudioMode | null): void {
    this._audioModeOverride = mode;
  }

  /**
   * Stage 13: Resolve the effective audio mode based on source kind and developer mode.
   *
   * Normal mode:
   *   screen â†’ "monitor" (Filtered Monitor Audio)
   *   window â†’ "application" (Application Audio)
   *
   * Developer mode:
   *   Uses explicit override if set, otherwise falls back to source-derived.
   *   Valid modes: none, system, application, monitor, test-tone
   */
  resolveAudioMode(): AudioMode {
    if (this._developerMode && this._audioModeOverride) {
      return this._audioModeOverride;
    }
    // Source-derived mode
    if (this._sourceKind === "screen") return "monitor";
    if (this._sourceKind === "window") return "application";
    return "none";
  }

  /**
   * Expose the internal PublisherManager for external audio controller setup.
   * Returns null if no stream is active.
   */
  getPublisherManager(): PublisherManager | null {
    return this.publisherManager;
  }

  /**
   * Expose the current VDO session config (streamId + password).
   * Returns null if no stream is active.
   */
  getCurrentVdoConfig(): VdoSessionConfig | null {
    return this.vdoConfig;
  }

  /**
   * Get the source ID used for this session (if any).
   */
  getSourceId(): string | null {
    return this._sourceId;
  }

  /**
   * Get the raw capture stream from getDisplayMedia.
   * Returns null when no stream is active. Used for self-viewing
   * preview â€” the local viewer attaches this stream directly to a
   * <video> element instead of going through the VDO relay.
   */
  getCaptureStream(): MediaStream | null {
    return this.captureStream;
  }

  /**
   * Gate 4.4 â€” read back the actual capture dimensions and FPS from
   * the current video track. Returns zeros if no track is active.
   */
  getActualCaptureDimensions(): { width: number; height: number; fps: number } {
    return {
      width: this.actualCaptureWidth,
      height: this.actualCaptureHeight,
      fps: this.actualCaptureFps,
    };
  }

  /**
   * Stage 13: Set the source kind used for audio mode derivation.
   * Called when the source changes to reset the derived mode.
   */
  setSourceKind(kind: "screen" | "window"): void {
    this._sourceKind = kind;
    // Source change resets developer override to derived mode
    if (this._developerMode) {
      this._audioModeOverride = null;
    }
  }

  /**
   * Stage 13: Mark audio as degraded (failure occurred, video preserved).
   */
  markAudioDegraded(): void {
    this._isAudioDegraded = true;
  }

  /**
   * Stage 13: Clear audio degraded status (audio recovered).
   */
  clearAudioDegraded(): void {
    this._isAudioDegraded = false;
  }

  /**
   * Set the real device identity for this session.
   * Must be called before startStream to use real identity in broadcasts.
   */
  setDeviceIdentity(deviceId: string, displayName: string): void {
    this._hostDeviceId = deviceId;
    this._hostDisplayName = displayName;
  }

  /**
   * Set audio controller on the internal PublisherManager.
   * Must be called before startStream to include audio in the initial publish.
   * Can also be called after startStream to replace the audio track.
   */
  setAudioController(controller: ProcessAudioController | null, mode: string): void {
    if (!this.publisherManager) return;
    if (controller) {
      this.publisherManager.setAudioController(controller, mode as any);
    } else {
      this.publisherManager.clearAudioController();
    }
  }

  /**
   * Build the current StreamAnnouncement for local registration.
   */
  private buildAnnouncement(): StreamAnnouncement {
    return {
      logicalStreamId: this.logicalStreamId!,
      mediaSessionId: this.mediaSessionId!,
      groupId: this.groupId!,
      hostDeviceId: this._hostDeviceId,
      hostDisplayName: this._hostDisplayName,
        sourceKind: this._sourceKind ?? this.currentTrack?.kind ?? "screen",
      sourceName: this._sourceName || this.currentTrack?.label || "",
      startedAt: this.startedAt,
      appliedSettingsRevision: 0,
      heartbeatSequence: this.heartbeatSeq,
      streamRevision: this.streamRevision,
      mediaJoinMetadata: "",
      replacesSessionId: null,
      isAudioDegraded: this._isAudioDegraded,
    };
  }

  /**
   * Start a new stream session.
   *
   * Two-phase design:
   *   Phase A (fatal):  validation, capture, audio setup, publish, local registration
   *   Phase B (non-fatal): stream.started announcement, heartbeat, active state
   *
   * A transient control-channel failure during Phase B does NOT destroy
   * the successfully published media stream. The announcement is queued
   * for delivery when the group control connection recovers.
   */
  async startStream(input: StartStreamInput): Promise<void> {
    if (this._state !== "idle" && this._state !== "failed") return;
    if (this.destroyed) return;

    // Mutual exclusivity with compare mode
    const compareSessionManager = (this.runtime as Phase3Runtime & {
      getCompareSessionManager?: () => { isActive: () => boolean } | null;
    }).getCompareSessionManager?.();
    if (compareSessionManager?.isActive()) {
      throw new Error("Cannot start normal stream while compare mode is active");
    }

    if (input.qualityOverride) {
      const err = validateSessionQualityOverride(input.qualityOverride);
      if (err) {
        throw new Error(`Invalid quality override: ${err}`);
      }
    }

    this._state = "starting";
    this.groupId = input.groupId;
    this.logicalStreamId = crypto.randomUUID();
    this.mediaSessionId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.streamRevision++;
    this.heartbeatSeq = 0;
    this._sourceId = input.source.id;
    this._sourceName = input.source.name ?? "";
    this._sourceKind = input.source.kind;
    this._explicitAudioMode = input.audioMode ?? null;
    this._isAudioDegraded = false;
    this._sessionQualityOverride = input.qualityOverride ?? null;

    // â”€â”€ Phase A: Critical media startup (any failure is fatal) â”€â”€â”€â”€â”€â”€â”€â”€
    try {
      // 0. Read group defaults from sync service (Stage 15)
      const syncState = this.runtime.getSyncService().getSyncState(input.groupId);
      const quality = syncState?.state?.defaultQuality?.value ?? null;

      // Derive effective publication settings with this precedence:
      //   1) session quality override (if any)
      //   2) group default
      //   3) hardcoded fallback from shared constants
      const ov = this._sessionQualityOverride;
      const videoBitrate =
        ov?.videoBitrateKbps ?? quality?.video?.videoBitrateKbps ?? DEFAULT_VIDEO_BITRATE_KBPS;
      const videoWidth = ov?.sendWidth ?? quality?.video?.sendWidth ?? DEFAULT_SEND_WIDTH;
      const videoHeight = ov?.sendHeight ?? quality?.video?.sendHeight ?? DEFAULT_SEND_HEIGHT;
      const videoFps = ov?.sendFps ?? quality?.video?.sendFps ?? DEFAULT_SEND_FPS;
      const codec = ov?.codec ?? quality?.video?.codec ?? DEFAULT_CODEC;
      const contentHint =
        ov?.contentHint ?? quality?.video?.contentHint ?? DEFAULT_CONTENT_HINT;
      const degradationPreference =
        ov?.degradationPreference ??
        quality?.video?.degradationPreference ??
        DEFAULT_DEGRADATION_PREFERENCE;
      const captureWidth =
        ov?.captureWidth ?? quality?.video?.captureWidth ?? DEFAULT_SEND_WIDTH;
      const captureHeight =
        ov?.captureHeight ?? quality?.video?.captureHeight ?? DEFAULT_SEND_HEIGHT;
      const captureFps = ov?.captureFps ?? quality?.video?.captureFps ?? DEFAULT_SEND_FPS;
      // Notify metrics service
      StreamMetricsService.getInstance().startHostSession(
        this.mediaSessionId!,
        this.logicalStreamId!,
        this.groupId!,
        this.groupId!,
      );

      // 0. Generate VDO credentials
      const vdoStreamId = generateVdoStreamId();
      const vdoPassword = generateVdoPassword();
      this.vdoConfig = { streamId: vdoStreamId, password: vdoPassword };

      // 1. Create PublisherManager
      this.publisherManager = new PublisherManager({
        onStateChange: () => {
          // Publisher state changes propagated via runtime in future
        },
        onStats: () => {
          // Stats flow through store in future
        },
        onError: (err) => console.error("[stream-session] Publisher error:", err),
        onTrackEnded: (endedTrack: MediaStreamTrack) => {
          // Only stop the stream if the ended track is still the current
          // published track. During source switching, currentTrack is
          // updated before the old track's ended event fires, so this
          // check naturally prevents stopping during a switch.
          if (endedTrack !== this.currentTrack) return;
          this.stopStream().catch(() => {});
        },
      });

      // Stage 5: Wire media.bind handler through the actual VDO data channel
      // Uses the real media peer UUID from the VDO SDK callback, not the
      // group control envelope senderDeviceId.
      this.publisherManager.setOnMediaBind((peerUuid: string, token: string, viewerSessionId?: string) => {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        if (viewerBinding) {
          // Pass the actual media peer UUID to the binding handler
          viewerBinding.handleMediaBind(peerUuid, token, viewerSessionId).catch(() => {});
        }
      });

      // Stage 6: React to VDO peerDisconnected so abrupt disconnects
      // (tab close, crash, network drop) still clean up ScreenLink-owned
      // viewer state. The group-control stream.leave path covers the
      // graceful-exit case; this covers the rest.
      this.publisherManager.setOnPeerDisconnected((peerUuid: string) => {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        if (viewerBinding) {
          viewerBinding.removeViewerByPeerUuid(peerUuid);
        }
      });

      // 2. Capture display media
      this.captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const videoTracks = this.captureStream.getVideoTracks();
      if (videoTracks.length === 0) {
        throw new Error("No video track in captured stream");
      }
      this.currentTrack = videoTracks[0];

      // Gate 4.4: apply capture constraints and read back actual
      // dimensions so downstream code (host-limit clamping, scale
      // calculation) operates on real values, not requested values.
      await this.applyCaptureConstraints(this.currentTrack, {
        captureWidth,
        captureHeight,
        captureFps,
      });

      // 3. Audio setup respecting user's explicit choice
      // - audioMode === "none" â†’ skip audio entirely (no degrade, user chose no audio)
      // - audioMode === "monitor" | "application" â†’ use that mode explicitly
      // - audioMode omitted â†’ source-derived mode (backward compat)
      if (input.audioMode === "none") {
        // User explicitly chose no audio â€” skip setupSourceAudio entirely
      } else {
        try {
          await this.setupSourceAudio(
            input.source.id,
            input.source.kind,
            input.audioMode === "monitor" ? "screen" as const
              : input.audioMode === "application" ? "window" as const
              : input.source.kind,
          );
        } catch (err) {
          console.warn("[stream-session] Audio setup failed, continuing with video only:", err);
          this._isAudioDegraded = true;
        }
      }

      // 4. Publish via PublisherManager with effective quality from group defaults
      // If audio controller was set before startStream (via setAudioController or
      // source-derived audio setup), it will be included in the combined stream.
      // Stage 17: Pass codec, contentHint, degradationPreference, and capture settings
      // from group defaults so PublisherManager can apply them to the media pipeline.
      await this.publisherManager.startPublishing(this.captureStream, {
        sourceId: input.source.id,
        password: vdoPassword,
        streamId: vdoStreamId,
        videoBitrate,
        videoWidth,
        videoHeight,
        videoFps,
        codec,
        contentHint,
        degradationPreference,
        captureWidth,
        captureHeight,
        captureFps,
      });

      // 5. Register locally BEFORE broadcasting so the stream exists
      // when peers respond with snapshots.
      const registry = this.runtime.getActiveStreamRegistry();
      registry.registerLocalStream(this.buildAnnouncement());
    } catch (err) {
      this._state = "failed";
      // Clean up on failure â€” this tears down the publisher, stops capture,
      // and removes any partial registration.
      console.error("[stream-session] Phase A (media startup) failed:", err instanceof Error ? err.message : String(err));
      await this.cleanupPublisher();
      throw err;
    }

    // â”€â”€ Phase B: Control announcement (non-fatal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Media is published and locally registered. A transient group-control
    // failure must not destroy the media stream.
    try {
      const connManager = this.runtime.getConnectionManager();
      const lifecyclePayload: Record<string, unknown> = {
        type: "stream.started",
        logicalStreamId: this.logicalStreamId,
        mediaSessionId: this.mediaSessionId,
        groupId: this.groupId,
        hostDeviceId: this._hostDeviceId,
        hostDisplayName: this._hostDisplayName,
        sourceKind: input.source.kind,
        sourceName: input.source.name,
        startedAt: this.startedAt,
        appliedSettingsRevision: 0,
        heartbeatSequence: this.heartbeatSeq,
        streamRevision: this.streamRevision,
        mediaJoinMetadata: "",
        replacesSessionId: null,
      };

      const result = await connManager.sendOrQueueStreamLifecycle(
        this.groupId!,
        this.logicalStreamId!,
        "stream.started",
        lifecyclePayload,
      );
      console.log(
        "[stream-session] stream.started",
        result === "sent" ? "sent" : "queued for later delivery",
        "â€”",
        this.logicalStreamId,
      );
    } catch (err) {
      // Phase B failure is non-fatal â€” the media stream remains active.
      // The announcement was already queued by sendOrQueueStreamLifecycle
      // if the connection was unavailable.
      console.warn(
        "[stream-session] stream.started broadcast failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Start heartbeat timer (every 10s)
    this.startHeartbeat();

    this._state = "active";
    console.log("[stream-session] stream active â€”", this.logicalStreamId);
  }

  /**
   * Switch the video source of the active stream without disrupting
   * viewer connections or audio.
   *
   * Flow:
   *   1. Guard against concurrent switches
   *   2. Pre-approve the new capture source via IPC
   *   3. Call getDisplayMedia to acquire the new source
   *   4. Validate the new video track
   *   5. Replace the published video track via PublisherManager
   *   6. On failure: stop the new track, leave existing stream unchanged
   *   7. On success: update internal state, stop old capture, broadcast
   *
   * Viewers see a smooth video transition. Audio is untouched.
   */
  async switchSource(source: {
    id: string;
    name: string;
    kind: "screen" | "window";
  }): Promise<void> {
    if (this._state !== "active") return;
    if (this.destroyed) return;
    if (this.isSwitchingSource) {
      console.log("[stream-session] switchSource: already switching, ignoring");
      return;
    }
    if (!this.publisherManager) return;

    this.isSwitchingSource = true;

    let newCaptureStream: MediaStream | null = null;
    let newTrack: MediaStreamTrack | null = null;

    try {
      // 1. Pre-approve the new source so getDisplayMedia skips the system picker
      const api = typeof window !== "undefined"
        ? (window as unknown as { screenlink?: { setSource: (id: string | null) => Promise<void> } }).screenlink
        : null;
      if (api?.setSource) {
        await api.setSource(source.id);
      }

      // Check that the session is still active after the async pre-approval
      if (this._state !== "active" || this.destroyed) {
        if (api?.setSource) {
          await api.setSource(null).catch(() => {});
        }
        return;
      }

      // 2. Detach the old track's ended handler BEFORE calling getDisplayMedia.
      //    The browser ends the old capture track during getDisplayMedia, which
      //    would fire onended and trigger an unwanted stopStream(). By clearing
      //    the handler here, we prevent that race. replaceVideoTrack below will
      //    re-wire the handler on the new track.
      this.publisherManager.detachTrackEnded();

      // 3. Acquire new source â€” the display-media-handler intercepts this
      //    and returns the pre-approved source without showing a picker.
      newCaptureStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const videoTracks = newCaptureStream.getVideoTracks();
      if (videoTracks.length === 0) {
        throw new Error("No video track in switched source");
      }
      newTrack = videoTracks[0];
      if (newTrack.readyState !== "live") {
        throw new Error(`Switched track is not live: ${newTrack.readyState}`);
      }

      // 3. Replace the published video track
      await this.publisherManager.replaceVideoTrack(newTrack);

      // 4. On success: commit the new state
      const oldCaptureStream = this.captureStream;
      const oldTrack = this.currentTrack;

      this.captureStream = newCaptureStream;
      this.currentTrack = newTrack;
      newCaptureStream = null; // prevent cleanup in the catch block
      newTrack = null;

      this._sourceId = source.id;
      this._sourceName = source.name;
      this._sourceKind = source.kind;

      // Apply capture constraints from current quality settings to the new track
      const syncState = this.runtime.getSyncService().getSyncState(this.groupId!);
      const quality = syncState?.state?.defaultQuality?.value ?? null;
      const ov = this._sessionQualityOverride;
      await this.applyCaptureConstraints(this.currentTrack!, {
        captureWidth: ov?.captureWidth ?? quality?.video?.captureWidth ?? DEFAULT_SEND_WIDTH,
        captureHeight: ov?.captureHeight ?? quality?.video?.captureHeight ?? DEFAULT_SEND_HEIGHT,
        captureFps: ov?.captureFps ?? quality?.video?.captureFps ?? DEFAULT_SEND_FPS,
      }).catch(() => {
        // Non-fatal â€” readback will report whatever the source produces
      });

      // Update local registry with new source metadata
      const registry = this.runtime.getActiveStreamRegistry();
      registry.registerLocalStream(this.buildAnnouncement());

      // Broadcast metadata update to remote peers
      const connManager = this.runtime.getConnectionManager();
      void connManager.broadcast(this.groupId!, {
        type: "stream.sourceChanged",
        logicalStreamId: this.logicalStreamId,
        mediaSessionId: this.mediaSessionId,
        sourceKind: source.kind,
        sourceName: source.name,
      }).catch(() => {
        // Non-fatal â€” the video switch is complete regardless
      });

      // 5. Stop old capture tracks (the old track is no longer published)
      if (oldCaptureStream) {
        oldCaptureStream.getTracks().forEach((t) => t.stop());
      }

      console.log("[stream-session] switchSource succeeded:", {
        newSource: source.name,
        newSourceKind: source.kind,
        trackId: this.currentTrack?.id?.slice(0, 8),
      });
    } catch (err) {
      // On failure: leave the existing stream untouched
      console.error("[stream-session] switchSource failed:", err instanceof Error ? err.message : String(err));

      // Clean up the new capture stream/track if acquired
      if (newTrack) {
        newTrack.stop();
      }
      if (newCaptureStream) {
        newCaptureStream.getTracks().forEach((t) => t.stop());
      }

      // Clear the approved source if we set it
      try {
        const api = typeof window !== "undefined"
          ? (window as unknown as { screenlink?: { setSource: (id: string | null) => Promise<void> } }).screenlink
          : null;
        if (api?.setSource) {
          await api.setSource(null).catch(() => {});
        }
      } catch { /* best effort */ }

      // RE-WIRE: restore the track-ended handler on the existing published track
      // detachTrackEnded() was called before getDisplayMedia; without this
      // re-wire, the old track ending naturally would never trigger stopStream.
      if (this.publisherManager) {
        this.publisherManager.reattachTrackEnded();
      }

      throw err;
    } finally {
      this.isSwitchingSource = false;
    }
  }

  /**
   * Stop the current stream session.
   *
   * Full stop flow (Stage 4):
   *   active/restarting â†’ stopping
   *   stop heartbeat
   *   remove local registry stream (immediate)
   *   clear pending lifecycle messages (so stale starts are not flushed)
   *   queue stream.stopped or broadcast
   *   reject pending joins
   *   close viewer mappings
   *   stop publication/capture
   *   clear session-only state
   *   idle (idempotent)
   */
  async stopStream(): Promise<void> {
    if (this._state !== "active" && this._state !== "failed" && this._state !== "restarting") return;
    if (this.destroyed) return;

    this._state = "stopping";
    this.stopHeartbeat();

    // Capture identity before reset
    const lastGroupId = this.groupId;
    const lastLogicalStreamId = this.logicalStreamId;
    const lastHostDeviceId = this._hostDeviceId;

    try {
      // Stop audio helper if active (wrapped for Node.js test compat)
      try {
        const api = typeof window !== "undefined"
          ? (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink
          : null;
        if (api) {
          await api.stopAudio();
        }
      } catch { /* audio stop is best-effort */ }

      // Reject pending joins and close viewer mappings
      const viewerBinding = this.runtime.getViewerMediaBinding();
      if (viewerBinding) {
        const allViewers = viewerBinding.getAllViewers();
        for (const v of allViewers) {
          viewerBinding.removeViewer(v.viewerDeviceId);
        }
      }

      // Remove local registry entry FIRST so the UI updates instantly.
      if (lastGroupId && lastLogicalStreamId) {
        this.runtime.getActiveStreamRegistry().handleStopped({
          groupId: lastGroupId,
          hostDeviceId: lastHostDeviceId,
          logicalStreamId: lastLogicalStreamId,
        });
      }

      // Clear any pending start/restart lifecycle messages for this stream
      // so they are not flushed after reconnect.
      if (lastGroupId && lastLogicalStreamId) {
        const connManager = this.runtime.getConnectionManager();
        connManager.clearPendingForStream(lastGroupId, lastLogicalStreamId);

        // Queue or broadcast stream.stopped (fire-and-forget; errors are non-fatal)
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

      // Stop publication/capture
      await this.cleanupPublisher();

      // Notify metrics service
      if (this.mediaSessionId) {
        const svc = StreamMetricsService.getInstance();
        const historyId = svc.findHistoryIdByMediaSessionId(this.mediaSessionId);
        if (historyId) {
          svc.finalizeSession(historyId);
        }
      }
      this.resetSessionState();
      this._state = "idle";
    } catch (err) {
      this.resetSessionState();
      this._state = "idle";
    }
  }

  /**
   * Restart stream with a real lifecycle: stop current publication/audio,
   * preserve logicalStreamId and source selection, create new mediaSessionId
   * and VDO credentials, restart publication with current defaults, and
   * broadcast stream.restarted.
   *
   * Two-phase design mirrors startStream: Phase A (media) is fatal,
   * Phase B (announcement) is non-fatal.
   *
   * Transitions: active â†’ restarting â†’ active
   */
  async restartStream(): Promise<void> {
    if (this._state !== "active") return;
    if (this.destroyed) return;

    const oldGroupId = this.groupId!;
    const oldLogicalStreamId = this.logicalStreamId!;
    const oldMediaSessionId = this.mediaSessionId!;
    const oldSourceId = this._sourceId;
    const oldSourceKind = this._sourceKind;

    this._state = "restarting";
    this.stopHeartbeat();

    // â”€â”€ Phase A: Critical media restart (any failure is fatal) â”€â”€â”€â”€â”€â”€â”€â”€
    let newMediaSessionId: string;
    try {
      // 1. Stop current publication and audio cleanly
      await this.cleanupPublisher();
      // Also stop capture display tracks
      if (this.captureStream) {
        this.captureStream.getTracks().forEach((t) => t.stop());
        this.captureStream = null;
      }
      this.currentTrack = null;

      // 2. Generate new media session identifiers
      newMediaSessionId = crypto.randomUUID();
      this.mediaSessionId = newMediaSessionId;
      this.startedAt = Date.now();
      this.streamRevision++;
      this.heartbeatSeq = 0;

      // 3. New VDO credentials (streamId + password)
      const vdoStreamId = generateVdoStreamId();
      const vdoPassword = generateVdoPassword();
      this.vdoConfig = { streamId: vdoStreamId, password: vdoPassword };

      // 4. Create new PublisherManager
      this.publisherManager = new PublisherManager({
        onStateChange: () => {},
        onStats: () => {},
        onError: (err) => console.error("[stream-session] Publisher error:", err),
        onTrackEnded: (endedTrack: MediaStreamTrack) => {
          if (endedTrack !== this.currentTrack) return;
          this.stopStream().catch(() => {});
        },
      });

      // Wire media.bind handler
      this.publisherManager.setOnMediaBind((peerUuid: string, token: string, viewerSessionId?: string) => {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        if (viewerBinding) {
          viewerBinding.handleMediaBind(peerUuid, token, viewerSessionId).catch(() => {});
        }
      });

      // Wire peerDisconnected handler for abrupt viewer disconnects.
      this.publisherManager.setOnPeerDisconnected((peerUuid: string) => {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        if (viewerBinding) {
          viewerBinding.removeViewerByPeerUuid(peerUuid);
        }
      });

      // 5. Capture new display media
      this.captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const videoTracks = this.captureStream.getVideoTracks();
      if (videoTracks.length === 0) {
        throw new Error("No video track in captured stream during restart");
      }
      this.currentTrack = videoTracks[0];

      // 7. Read group defaults for publication quality FIRST so
      // captureWidth/Height/Fps are available for the constraint
      // application below. Precedence remains:
      //   1) active session quality override (preserved across restart)
      //   2) group default
      //   3) hardcoded fallback from shared constants
      const syncState = this.runtime.getSyncService().getSyncState(oldGroupId);
      const quality = syncState?.state?.defaultQuality?.value ?? null;
      const ov = this._sessionQualityOverride;
      const videoBitrate =
        ov?.videoBitrateKbps ?? quality?.video?.videoBitrateKbps ?? DEFAULT_VIDEO_BITRATE_KBPS;
      const videoWidth = ov?.sendWidth ?? quality?.video?.sendWidth ?? DEFAULT_SEND_WIDTH;
      const videoHeight = ov?.sendHeight ?? quality?.video?.sendHeight ?? DEFAULT_SEND_HEIGHT;
      const videoFps = ov?.sendFps ?? quality?.video?.sendFps ?? DEFAULT_SEND_FPS;
      const codec = ov?.codec ?? quality?.video?.codec ?? DEFAULT_CODEC;
      const contentHint =
        ov?.contentHint ?? quality?.video?.contentHint ?? DEFAULT_CONTENT_HINT;
      const degradationPreference =
        ov?.degradationPreference ??
        quality?.video?.degradationPreference ??
        DEFAULT_DEGRADATION_PREFERENCE;
      const captureWidth =
        ov?.captureWidth ?? quality?.video?.captureWidth ?? DEFAULT_SEND_WIDTH;
      const captureHeight =
        ov?.captureHeight ?? quality?.video?.captureHeight ?? DEFAULT_SEND_HEIGHT;
      const captureFps = ov?.captureFps ?? quality?.video?.captureFps ?? DEFAULT_SEND_FPS;
      StreamMetricsService.getInstance().startHostSession(
        this.mediaSessionId!,
        this.logicalStreamId!,
        this.groupId!,
        this.groupId!,
      );

      // Bitrate readback: log the effective bitrate after precedence resolution
      // so we can verify a custom 300 Kbps override reaches the publisher.
      console.log("[stream-session] effective video bitrate", {
        overrideKbps: ov?.videoBitrateKbps ?? null,
        groupDefaultKbps: quality?.video?.videoBitrateKbps ?? null,
        fallbackKbps: DEFAULT_VIDEO_BITRATE_KBPS,
        effectiveKbps: videoBitrate,
        effectiveBps: videoBitrate * 1000,
        source: ov?.videoBitrateKbps != null ? "override"
          : quality?.video?.videoBitrateKbps != null ? "group-default"
          : "fallback",
      });

      // Gate 4.4: apply capture constraints and read back actual
      // dimensions so downstream code operates on real values.
      await this.applyCaptureConstraints(this.currentTrack, {
        captureWidth,
        captureHeight,
        captureFps,
      });

      // 6. Re-setup source-derived or explicit audio
      this._isAudioDegraded = false;
      if (oldSourceId && oldSourceKind && this._explicitAudioMode !== "none") {
        try {
          const restartEffectiveKind = this._explicitAudioMode === "monitor"
            ? "screen"
            : this._explicitAudioMode === "application"
              ? "window"
              : oldSourceKind;
          await this.setupSourceAudio(oldSourceId, oldSourceKind, restartEffectiveKind);
        } catch (err) {
          console.warn("[stream-session] Audio setup failed during restart:", err);
          this._isAudioDegraded = true;
        }
      }

      // 8. Publish with new credentials
      await this.publisherManager.startPublishing(this.captureStream, {
        sourceId: vdoStreamId,
        password: vdoPassword,
        streamId: vdoStreamId,
        videoBitrate,
        videoWidth,
        videoHeight,
        videoFps,
        codec,
        contentHint,
        degradationPreference,
        captureWidth,
        captureHeight,
        captureFps,
      });

      // 9. Register locally before broadcasting
      const registry = this.runtime.getActiveStreamRegistry();
      registry.registerLocalStream(this.buildAnnouncement());
    } catch (err) {
      this._state = "failed";
      console.error("[stream-session] Phase A (media restart) failed:", err instanceof Error ? err.message : String(err));
      await this.cleanupPublisher();
      throw err;
    }

    // â”€â”€ Phase B: Control announcement (non-fatal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    try {
      const connManager = this.runtime.getConnectionManager();
      const lifecyclePayload: Record<string, unknown> = {
        type: "stream.restarted",
        logicalStreamId: oldLogicalStreamId,
        mediaSessionId: newMediaSessionId,
        previousMediaSessionId: oldMediaSessionId,
        groupId: oldGroupId,
        hostDeviceId: this._hostDeviceId,
        hostDisplayName: this._hostDisplayName,
        sourceKind: this._sourceKind ?? this.currentTrack?.kind ?? "screen",
        sourceName: this.currentTrack?.label ?? "",
        startedAt: this.startedAt,
        appliedSettingsRevision: 0,
        heartbeatSequence: this.heartbeatSeq,
        streamRevision: this.streamRevision,
        mediaJoinMetadata: "",
        replacesSessionId: oldMediaSessionId,
        isAudioDegraded: this._isAudioDegraded,
      };

      const result = await connManager.sendOrQueueStreamLifecycle(
        oldGroupId,
        oldLogicalStreamId,
        "stream.restarted",
        lifecyclePayload,
      );
      console.log(
        "[stream-session] stream.restarted",
        result === "sent" ? "sent" : "queued for later delivery",
        "â€”",
        oldLogicalStreamId,
      );
    } catch (err) {
      console.warn(
        "[stream-session] stream.restarted broadcast failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }

    // 11. Start heartbeat
    this.startHeartbeat();
    this._state = "active";
  }

  /**
   * Destroy the session manager. Terminal state â€” no further operations allowed.
   * Performs full stop propagation if the stream was active:
   * - broadcasts stream.stopped
   * - removes local registry entry
   * - closes viewer mappings
   * - stops publication/capture
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopHeartbeat();

    // If stream was active, propagate stream.stopped before clearing state
    const wasActive = this._state === "active" || this._state === "restarting";
    const lastGroupId = this.groupId;
    const lastLogicalStreamId = this.logicalStreamId;
    const lastHostDeviceId = this._hostDeviceId;

    // Close viewer mappings
    try {
      const viewerBinding = this.runtime.getViewerMediaBinding();
      if (viewerBinding) {
        const allViewers = viewerBinding.getAllViewers();
        for (const v of allViewers) {
          viewerBinding.removeViewer(v.viewerDeviceId);
        }
      }
    } catch { /* best effort */ }

    // Broadcast stream.stopped and remove registry entry
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

      this.runtime.getActiveStreamRegistry().handleStopped({
        groupId: lastGroupId,
        hostDeviceId: lastHostDeviceId,
        logicalStreamId: lastLogicalStreamId,
      });
    }

    // Always clear the active sharing group reference in the store when
    // the session is destroyed. Otherwise selecting another group after
    // restart would show stale "Host" UI for the wrong group. Fire-and-
    // forget so the destroy() promise resolves promptly.
    void this.clearSharingGroupInStore();

    this.cleanupPublisher().catch(() => {});
    this.resetSessionState();
    this._state = "destroyed";
  }

  private async clearSharingGroupInStore(): Promise<void> {
    try {
      // Dynamic import via a top-level safe accessor to avoid a circular
      // dependency at module init. The store module imports many renderer
      // modules, so a static import here would create a cycle.
      const storeModule = await import("../stores/main-store.js");
      const s = storeModule.useStore.getState();
      s.setSharingGroupId(null);
      s.setIsSharing(false);
      s.setLocalShareState("idle");
    } catch { /* best effort â€” store may be unavailable in test envs */ }
  }

  /**
   * Setup source-derived audio based on source kind.
   * screen â†’ startFilteredMonitorAudio via IPC + PCM port â†’ ProcessAudioController
   * window â†’ startApplicationAudio via IPC + PCM port â†’ ProcessAudioController
   *
   * Full audio ownership pipeline (Gate 4.5 â€” production order):
   *   1) Ensure audio helper exists and is running (main process).
   *   2) Request the PCM MessagePort.
   *   3) Receive the MessagePort via the pcm:port window message.
   *   4) Initialize ProcessAudioController with the port.
   *   5) Start the selected native capture mode (filtered monitor /
   *      application / system / test-tone).
   *   6) Receive the capture stream generation from the start result.
   *   7) Set the controller stream generation IMMEDIATELY (do not wait
   *      for priming first).
   *   8) Wait for the controller to prime.
   *   9) Attach the controller to PublisherManager.
   *  10) Publish the combined media stream.
   *
   * On failure at any stage: destroy the ProcessAudioController, stop
   * native capture, release the PCM port, clear audio ownership, keep
   * video capture, set isAudioDegraded, and preserve a sanitized
   * failure reason. No partial helper ownership may remain.
   */
  private async setupSourceAudio(sourceId: string, sourceKind: "screen" | "window", effectiveKind?: "screen" | "window"): Promise<void> {
    const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
    if (!api) return;
    if (!this.publisherManager) return;

    let controller: ProcessAudioController | null = null;
    let streamGeneration: number | undefined;
    let pcmPortReceived = false;
    const pcmPortPromise = this.waitForPcmPort(5000).then((port) => {
      pcmPortReceived = true;
      return port;
    });

    try {
      // 1) Ensure the audio helper is up before we touch anything else.
      const ensure = await api.ensureAudioHelper();
      if (!ensure?.success) {
        throw new Error(`ensureAudioHelper failed: ${ensure?.error ?? "unknown"}`);
      }

      // 2) Request the PCM MessagePort. This is what will deliver the
      //    port to the renderer via pcm:port window event.
      const portResult = await api.requestAudioPort();
      if (!portResult?.success) {
        throw new Error(`requestAudioPort failed: ${portResult?.error ?? "unknown"}`);
      }

      // 3) Receive the port.
      const pcmPort = await pcmPortPromise;
      if (!pcmPortReceived) {
        throw new Error("PCM MessagePort not received within timeout");
      }

      // 4) Initialize the ProcessAudioController with the port.
      controller = new ProcessAudioController();
      await controller.initialize(pcmPort, {
        onStateChange: (state) => {
          console.log(`[SSM] Audio controller state: ${state}`);
        },
      });

      // 5) Start the selected native capture mode and capture the
      //    stream generation the helper hands back. (This is what
      //    allows us to align the ring buffer with the capture epoch.)
      //    Use effectiveKind when provided (from user's audio mode choice).
      const audioKind = effectiveKind ?? sourceKind;
      if (audioKind === "screen") {
        const result = await api.startFilteredMonitorAudio({
          excludeDiscord: true,
          excludeScreenLink: true,
        });
        if (!result?.success) {
          throw new Error(`startFilteredMonitorAudio failed: ${result?.error ?? "unknown"}`);
        }
        streamGeneration = result.streamGeneration;
        this._sourceKind = "screen";
      } else if (audioKind === "window") {
        const result = await api.startApplicationAudio({ sourceId });
        if (!result?.success) {
          throw new Error(`startApplicationAudio failed: ${result?.error ?? "unknown"}`);
        }
        streamGeneration = result.streamGeneration;
        this._sourceKind = "window";
      }

      // 6 + 7) Set the controller stream generation IMMEDIATELY. The
      //   ring buffer will use this to drop samples that arrived
      //   before the controller was attached, even though we are
      //   about to wait for priming.
      if (streamGeneration !== undefined && controller) {
        controller.setStreamGeneration(streamGeneration);
      }

      // 8) Wait for the controller to prime.
      if (controller) {
        await controller.waitUntilPrimed();
      }

      // 9) Resolve the effective audio mode and attach to the
      //    publisher. The controller is now the source of audio for
      //    the publication.
      const mode = this.resolveAudioMode();
      const publisherMode = mode === "none"
        ? "system"
        : (mode as 'system' | 'application' | 'monitor' | 'test-tone');
      this.publisherManager.setAudioController(controller, publisherMode);
    } catch (err) {
      // Roll back partial audio ownership. The video pipeline stays
      // untouched.
      if (controller) {
        try { (controller as { destroy?: () => void }).destroy?.(); } catch { /* best effort */ }
      }
      // Best-effort stop of any started capture.
      try { await api.stopAudio(); } catch { /* best effort */ }
      // Close the port if it ever arrived.
      if (pcmPortReceived) {
        try {
          // The controller owns the port lifecycle once it is
          // initialized; if initialization failed the port is
          // unattached and the GC will collect it.
        } catch { /* ignore */ }
      }
      throw err;
    }
  }

  /**
   * Wait for a pcm:port window message containing the PCM MessagePort
   * from the audio helper process.
   */
  private waitForPcmPort(timeoutMs: number): Promise<MessagePort> {
    return new Promise((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        if (event.data?.type === "pcm:port") {
          if (typeof window !== "undefined" && window.removeEventListener) {
            window.removeEventListener("message", handler);
          }
          const port = event.ports?.[0];
          if (port) {
            resolve(port);
          } else {
            reject(new Error("pcm:port event missing MessagePort"));
          }
        }
      };
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("message", handler);
      }
      setTimeout(() => {
        if (typeof window !== "undefined" && window.removeEventListener) {
          window.removeEventListener("message", handler);
        }
        reject(new Error("pcm:port wait timeout"));
      }, timeoutMs);
    });
  }

  // â”€â”€ Private â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Gate 4.4: Apply the requested capture constraints to a video
   * track where the underlying getDisplayMedia track supports them.
   * After applying, read back the actual settings and store them
   * so the rest of the pipeline never has to guess at the real
   * capture dimensions.
   *
   * Constraint application:
   * - When capabilities expose ranges, clamp requested values to
   *   the supported range before applying using ideal constraints.
   * - Unsupported constraints (applyConstraints rejects) are silently
   *   dropped â€” the readback reflects whatever the source produced.
   * - Always reads back actual track settings as the source of truth.
   */
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
      // Source does not accept these constraints; readback will
      // report whatever the source actually produced.
    }
    const settings = track.getSettings();
    this.actualCaptureWidth = settings.width ?? 0;
    this.actualCaptureHeight = settings.height ?? 0;
    this.actualCaptureFps = settings.frameRate ?? 0;
  }

  private resetSessionState(): void {
    this.groupId = null;
    this.logicalStreamId = null;
    this.mediaSessionId = null;
    this.startedAt = 0;
    this.currentTrack = null;
    this.captureStream = null;
    this.vdoConfig = null;
    this._sourceId = null;
    this._sourceName = "";
    this._explicitAudioMode = null;
    this._sessionQualityOverride = null;
    this.actualCaptureWidth = 0;
    this.actualCaptureHeight = 0;
    this.actualCaptureFps = 0;
  }

  private async cleanupPublisher(): Promise<void> {
    if (this.publisherManager) {
      await this.publisherManager.stopCapture().catch(() => {});
      this.publisherManager = null;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, 10_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (this._state !== "active" || !this.groupId || !this.logicalStreamId) return;
    if (this.destroyed) return;

    this.heartbeatSeq++;
    try {
      const connManager = this.runtime.getConnectionManager();
      await connManager.broadcast(this.groupId, {
        type: "stream.heartbeat",
        groupId: this.groupId,
        hostDeviceId: this._hostDeviceId,
        hostDisplayName: this._hostDisplayName,
        logicalStreamId: this.logicalStreamId,
        mediaSessionId: this.mediaSessionId,
        heartbeatSequence: this.heartbeatSeq,
        appliedSettingsRevision: 0,
      });
    } catch {
      // Heartbeat failures are non-fatal â€” the stream remains active
      // and the next heartbeat will retry.
    }
  }
}

