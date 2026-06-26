import type { Phase3Runtime } from "./phase3-runtime.js";
import type { StreamAnnouncement } from "./active-stream-registry.js";
import { PublisherManager } from "./publisher-manager.js";
import {
  generateVdoStreamId,
  generateVdoPassword,
  type AudioMode,
  normalizeAudioMode,
} from "@screenlink/shared";
import { ProcessAudioController } from "../audio/ProcessAudioController.js";
import type { SessionQualityOverride } from "./share-quality.js";
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
  /** Gate 4.4 — actual capture dimensions read back from the track. */
  private actualCaptureWidth: number = 0;
  private actualCaptureHeight: number = 0;
  private actualCaptureFps: number = 0;
  private _sourceId: string | null = null;
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
   * Get the source ID used for this session (if any).
   */
  getSourceId(): string | null {
    return this._sourceId;
  }

  /**
   * Get the raw capture stream from getDisplayMedia.
   * Returns null when no stream is active. Used for self-viewing
   * preview — the local viewer attaches this stream directly to a
   * <video> element instead of going through the VDO relay.
   */
  getCaptureStream(): MediaStream | null {
    return this.captureStream;
  }

  /**
   * Gate 4.4 — read back the actual capture dimensions and FPS from
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
    this._sourceKind = input.source.kind;
    this._explicitAudioMode = input.audioMode ?? null;
    this._isAudioDegraded = false;
    this._sessionQualityOverride = input.qualityOverride ?? null;

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

      // Gate 4.4: apply capture constraints and read back actual
      // dimensions so downstream code (host-limit clamping, scale
      // calculation) operates on real values, not requested values.
      await this.applyCaptureConstraints(this.currentTrack, {
        captureWidth,
        captureHeight,
        captureFps,
      });

      // 3. Audio setup respecting user's explicit choice
      // - audioMode === "none" → skip audio entirely (no degrade, user chose no audio)
      // - audioMode === "monitor" | "application" → use that mode explicitly
      // - audioMode omitted → source-derived mode (backward compat)
      if (input.audioMode === "none") {
        // User explicitly chose no audio — skip setupSourceAudio entirely
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
          console.warn("[SSM] Audio setup failed, continuing with video only:", err);
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
      // The previous order (broadcast → handleStopped) waited for the
      // mesh broadcast to resolve before clearing the local store, which
      // could keep the "Live" badge visible for several seconds if a
      // peer was slow or unreachable. We notify peers in the background
      // after the local state is already consistent.
      if (lastGroupId && lastLogicalStreamId) {
        this.runtime.getActiveStreamRegistry().handleStopped({
          groupId: lastGroupId,
          hostDeviceId: lastHostDeviceId,
          logicalStreamId: lastLogicalStreamId,
        });
      }

      // Announce stream.stopped to peers (fire-and-forget so the local
      // stop is not blocked by peer reachability). Errors are best-effort.
      if (lastGroupId && lastLogicalStreamId) {
        const connManager = this.runtime.getConnectionManager();
        void connManager.broadcast(lastGroupId, {
          type: "stream.stopped",
          groupId: lastGroupId,
          hostDeviceId: lastHostDeviceId,
          logicalStreamId: lastLogicalStreamId,
        }).catch(() => {});
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
   * Restart stream with a real lifecycle: stop current publication/audio,
   * preserve logicalStreamId and source selection, create new mediaSessionId
   * and VDO credentials, restart publication with current defaults, and
   * broadcast stream.restarted.
   *
   * Transitions: active → restarting → active
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
      const newMediaSessionId = crypto.randomUUID();
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
        onError: (err) => console.error("[SSM] Publisher error:", err),
        onTrackEnded: () => {
          this.stopStream().catch(() => {});
        },
      });

      // Wire media.bind handler
      this.publisherManager.setOnMediaBind((peerUuid: string, token: string) => {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        if (viewerBinding) {
          viewerBinding.handleMediaBind(peerUuid, token).catch(() => {});
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
          console.warn("[SSM] Audio setup failed during restart:", err);
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

      // 10. Broadcast stream.restarted with replacesSessionId
      const connManager = this.runtime.getConnectionManager();
      await connManager.broadcast(oldGroupId, {
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
      });

      // 11. Start heartbeat
      this.startHeartbeat();
      this._state = "active";
    } catch (err) {
      this._state = "failed";
      await this.cleanupPublisher();
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
    } catch { /* best effort — store may be unavailable in test envs */ }
  }

  /**
   * Setup source-derived audio based on source kind.
   * screen → startFilteredMonitorAudio via IPC + PCM port → ProcessAudioController
   * window → startApplicationAudio via IPC + PCM port → ProcessAudioController
   *
   * Full audio ownership pipeline (Gate 4.5 — production order):
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

  // ── Private ──────────────────────────────────────────────────

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
   *   dropped — the readback reflects whatever the source produced.
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
      // Heartbeat failures are non-fatal — the stream remains active
      // and the next heartbeat will retry.
    }
  }
}
