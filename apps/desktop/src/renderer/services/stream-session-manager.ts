import type { Phase3Runtime } from "./phase3-runtime.js";
import type { StreamAnnouncement } from "./active-stream-registry.js";
import { PublisherManager } from "./publisher-manager.js";
import {
  generateVdoStreamId,
  generateVdoPassword,
  type AudioMode,
  normalizeAudioMode,
} from "@screenlink/shared";
import type { ProcessAudioController } from "../audio/ProcessAudioController.js";

/**
 * Stream session state machine:
 *   idle → starting → active → stopping → idle
 *   active → restarting → active
 *   any → failed → idle
 *   any → destroyed (terminal)
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
  private _sourceKind: "screen" | "window" | null = null;
  private _developerMode = false;
  private _audioModeOverride: AudioMode | null = null;
  private _isAudioDegraded = false;

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
   *   screen → "monitor" (Filtered Monitor Audio)
   *   window → "application" (Application Audio)
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
      sourceKind: this.currentTrack?.kind ?? "screen",
      sourceName: this.currentTrack?.label ?? "",
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
   * Full order within practical Stage 4 scope:
   *   1) idle validation
   *   2) generate VDO credentials
   *   3) create PublisherManager
   *   4) capture display media (getDisplayMedia)
   *   5) publish to VDO
   *   6) register local stream before broadcasting
   *   7) announce stream.started
   *   8) start heartbeat
   *   9) expose active state
   */
  async startStream(input: StartStreamInput): Promise<void> {
    if (this._state !== "idle" && this._state !== "failed") return;
    if (this.destroyed) return;

    this._state = "starting";
    this.groupId = input.groupId;
    this.logicalStreamId = crypto.randomUUID();
    this.mediaSessionId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.streamRevision++;
    this.heartbeatSeq = 0;
    this._sourceKind = input.source.kind;
    this._isAudioDegraded = false;

    try {
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
        onError: (err) => console.error("[SSM] Publisher error:", err),
        onTrackEnded: () => {
          // If display capture track ends, stop the stream
          this.stopStream().catch(() => {});
        },
      });

      // Stage 5: Wire media.bind handler through the actual VDO data channel
      // Uses the real media peer UUID from the VDO SDK callback, not the
      // group control envelope senderDeviceId.
      this.publisherManager.setOnMediaBind((peerUuid: string, token: string) => {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        if (viewerBinding) {
          // Pass the actual media peer UUID to the binding handler
          viewerBinding.handleMediaBind(peerUuid, token).catch(() => {});
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

      // 3. Publish via PublisherManager
      // If audio controller was set before startStream, it will be included.
      await this.publisherManager.startPublishing(this.captureStream, {
        sourceId: input.source.id,
        password: vdoPassword,
        streamId: vdoStreamId,
        videoBitrate: 650, // default; override via quality settings later
        videoWidth: 854,
        videoHeight: 480,
        videoFps: 15,
      });

      // 4. Register locally BEFORE broadcasting so the stream exists
      // when peers respond with snapshots.
      const registry = this.runtime.getActiveStreamRegistry();
      registry.registerLocalStream(this.buildAnnouncement());

      // 5. Announce stream.started to group
      const connManager = this.runtime.getConnectionManager();
      await connManager.broadcast(this.groupId, {
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
      });

      // 6. Start heartbeat timer (every 10s)
      this.startHeartbeat();

      this._state = "active";
    } catch (err) {
      this._state = "failed";
      // Clean up on failure
      await this.cleanupPublisher();
      throw err;
    }
  }

  /**
   * Stop the current stream session.
   *
   * Full stop flow (Stage 4):
   *   active/restarting → stopping
   *   stop heartbeat
   *   broadcast stream.stopped
   *   remove local registry stream
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
      // Reject pending joins and close viewer mappings
      const viewerBinding = this.runtime.getViewerMediaBinding();
      if (viewerBinding) {
        const allViewers = viewerBinding.getAllViewers();
        for (const v of allViewers) {
          viewerBinding.removeViewer(v.viewerDeviceId);
        }
      }

      // Announce stream.stopped
      if (lastGroupId && lastLogicalStreamId) {
        const connManager = this.runtime.getConnectionManager();
        await connManager.broadcast(lastGroupId, {
          type: "stream.stopped",
          groupId: lastGroupId,
          hostDeviceId: lastHostDeviceId,
          logicalStreamId: lastLogicalStreamId,
        });
      }

      // Remove local registry entry
      if (lastGroupId && lastLogicalStreamId) {
        this.runtime.getActiveStreamRegistry().handleStopped({
          groupId: lastGroupId,
          hostDeviceId: lastHostDeviceId,
          logicalStreamId: lastLogicalStreamId,
        });
      }

      // Stop publication/capture
      await this.cleanupPublisher();

      this.resetSessionState();
      this._state = "idle";
    } catch (err) {
      this.resetSessionState();
      this._state = "idle";
    }
  }

  /**
   * Restart stream with a new media session (e.g., after source change).
   * Transitions: active → starting → active (new mediaSessionId)
   */
  async restartStream(newMediaSessionId: string): Promise<void> {
    if (this._state !== "active") return;
    if (this.destroyed) return;

    const oldState = {
      groupId: this.groupId!,
      logicalStreamId: this.logicalStreamId!,
      oldMediaSessionId: this.mediaSessionId!,
    };

    this._state = "restarting";
    this.stopHeartbeat();
    this.mediaSessionId = newMediaSessionId;
    this.startedAt = Date.now();
    this.streamRevision++;
    this.heartbeatSeq = 0;

    try {
      const connManager = this.runtime.getConnectionManager();

      // Register locally with updated mediaSessionId before broadcasting
      const registry = this.runtime.getActiveStreamRegistry();
      registry.registerLocalStream(this.buildAnnouncement());

      // Announce restart with full announcement shape compatible
      // with ActiveStreamRegistry.handleStarted replacement logic.
      // replacesSessionId is set to the old mediaSessionId so the registry
      // recognises this as a replacement (not a new stream).
      await connManager.broadcast(oldState.groupId, {
        type: "stream.restarted",
        logicalStreamId: oldState.logicalStreamId,
        mediaSessionId: newMediaSessionId,
        previousMediaSessionId: oldState.oldMediaSessionId,
        groupId: oldState.groupId,
        hostDeviceId: this._hostDeviceId,
        hostDisplayName: this._hostDisplayName,
        sourceKind: this.currentTrack?.kind ?? "screen",
        sourceName: this.currentTrack?.label ?? "",
        startedAt: this.startedAt,
        appliedSettingsRevision: 0,
        heartbeatSequence: this.heartbeatSeq,
        streamRevision: this.streamRevision,
        mediaJoinMetadata: "",
        replacesSessionId: oldState.oldMediaSessionId,
      });

      this.startHeartbeat();
      this._state = "active";
    } catch (err) {
      this._state = "failed";
      throw err;
    }
  }

  /**
   * Destroy the session manager. Terminal state — no further operations allowed.
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
      connManager.broadcast(lastGroupId, {
        type: "stream.stopped",
        groupId: lastGroupId,
        hostDeviceId: lastHostDeviceId,
        logicalStreamId: lastLogicalStreamId,
      }).catch(() => {});

      this.runtime.getActiveStreamRegistry().handleStopped({
        groupId: lastGroupId,
        hostDeviceId: lastHostDeviceId,
        logicalStreamId: lastLogicalStreamId,
      });
    }

    this.cleanupPublisher().catch(() => {});
    this.resetSessionState();
    this._state = "destroyed";
  }

  // ── Private ──────────────────────────────────────────────────

  private resetSessionState(): void {
    this.groupId = null;
    this.logicalStreamId = null;
    this.mediaSessionId = null;
    this.startedAt = 0;
    this.currentTrack = null;
    this.captureStream = null;
    this.vdoConfig = null;
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
      // Heartbeat failures are non-fatal — the stream remains active
      // and the next heartbeat will retry.
    }
  }
}
