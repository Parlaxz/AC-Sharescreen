import { HostPublisher } from "@screenlink/vdo-adapter";
import type { MediaStatsSnapshot } from "./media-stats-service.js";
import type { ProcessAudioController } from "../audio/ProcessAudioController.js";
import { extractDataReceivedEvent, extractPeerUuid } from "./sdk-event-normalizer.js";
import { applySenderSettings } from "./quality-coordinator.js";
import type { SenderSettingsInput, SenderSettingsReadback } from "./quality-coordinator.js";

export type AudioState = "disabled" | "active" | "error";

export type PublisherState =
  | "idle"
  | "selecting-source"
  | "starting"
  | "sharing"
  | "stopping"
  | "error";

export interface PublisherConfig {
  sourceId: string;
  password: string;
  streamId: string;
  videoBitrate: number;
  videoWidth: number;
  videoHeight: number;
  videoFps: number;
  /** Stage 17: Requested video codec from group defaults ("auto", "vp9", "h264", "vp8", "av1") */
  codec?: string;
  /** Stage 17: Content hint from group defaults ("detail", "motion", "text", "auto") */
  contentHint?: string;
  /** Stage 17: Degradation preference from group defaults ("balanced", "maintain-resolution", "maintain-framerate") */
  degradationPreference?: string;
  /** Stage 17: Capture width from group defaults (informational) */
  captureWidth?: number;
  /** Stage 17: Capture height from group defaults (informational) */
  captureHeight?: number;
  /** Stage 17: Capture FPS from group defaults (informational) */
  captureFps?: number;
}

export interface PerPeerApplyResult {
  /** UUID of the viewer peer */
  peerUuid: string;
  /** Whether application succeeded */
  success: boolean;
  /** Error message on failure */
  error?: string;
  /** Readback of actual applied values (null on failure or no video sender) */
  readback: SenderSettingsReadback | null;
}

export type ApplyOverallStatus = "all-succeeded" | "partial" | "all-failed";

export interface ApplyVideoSenderSettingsResult {
  /** Per-peer results in iteration order of SDK connections */
  results: PerPeerApplyResult[];
  /** Overall status across all peers */
  overall: ApplyOverallStatus;
}

export interface PublisherEvents {
  onStateChange: (state: PublisherState) => void;
  onStats: (stats: MediaStatsSnapshot) => void;
  onError: (error: Error) => void;
  onTrackEnded: (track: MediaStreamTrack) => void;
}

export class PublisherManager {
  private publisher: HostPublisher | null = null;
  private audioController: ProcessAudioController | null = null;
  private combinedStream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private state: PublisherState = "idle";
  private _audioState: AudioState = "disabled";
  private events: PublisherEvents;
  private config: PublisherConfig | null = null;
  private stopping_: boolean = false;
  private stopPromise_: Promise<void> | null = null;
  private static nextId = 0;
  private readonly instanceId: number;
  private appliedAudioMode: 'none' | 'system' | 'application' | 'monitor' | 'test-tone' = 'none';
  /** Track the currently published video track for replaceTrack and track-ended detection. */
  private _publishedVideoTrack: MediaStreamTrack | null = null;
  private mediaBindHandler: ((peerUuid: string, token: string, viewerSessionId?: string) => void) | null = null;
  /**
   * Handler for VDO SDK peerConnected events. Fires when a viewer's
   * media peer connection is established. Triggers quality reconciliation
   * so that any stored viewer quality request is applied to the now-ready
   * RTCRtpSender.
   */
  private peerConnectedHandler: ((peerUuid: string) => void) | null = null;
  /**
   * Handler for VDO SDK peerDisconnected events. Fires when the SDK
   * reports that a media peer has gone away — used as a fallback
   * cleanup path when the viewer crashes or closes its tab without
   * sending a `stream.leave` message first.
   */
  private peerDisconnectedHandler: ((peerUuid: string) => void) | null = null;
  /**
   * Tracks whether the peerDisconnected SDK listener has been attached
   * for the current publisher instance. Prevents duplicate listener
   * attachment across setOnPeerDisconnected + startPublishing calls.
   * Reset in stopCapture.
   */
  private _peerDisconnectedAttached: boolean = false;

  constructor(events: PublisherEvents) {
    PublisherManager.nextId++;
    this.instanceId = PublisherManager.nextId;
    this.events = events;
    console.log(`[PublisherManager] constructed id=${this.instanceId}`);
  }

  getState(): PublisherState {
    return this.state;
  }

  getPublisher(): HostPublisher | null {
    return this.publisher;
  }

  getAudioTrack(): MediaStreamTrack | null {
    return this.audioController?.getTrack() ?? this.audioTrack;
  }

  getAudioState(): AudioState {
    return this._audioState;
  }

  getInstanceId(): number {
    return this.instanceId;
  }

  /**
   * Register a handler for media.bind messages received via the VDO data channel.
   * Stage 5: Uses the actual media peer UUID from the VDO SDK callback, not the
   * group control envelope senderDeviceId.
   */
  setOnMediaBind(handler: (peerUuid: string, token: string, viewerSessionId?: string) => void): void {
    this.mediaBindHandler = handler;
  }

  /**
   * Register a handler for the VDO SDK's `peerDisconnected` event.
   * The handler is called with the peer UUID of the viewer that
   * disconnected. Used to clean up ScreenLink-owned viewer state
   * (mapping entry, stats polling) when the viewer disconnects
   * abruptly without sending a `stream.leave` first.
   *
   * The actual peer connection is owned by the SDK and is closed by
   * the SDK itself; this handler must NOT close the PC directly.
   */
  setOnPeerDisconnected(handler: (peerUuid: string) => void): void {
    this.peerDisconnectedHandler = handler;
    // If publisher exists, attach the SDK listener immediately.
    // Guard against duplicate attachment via _peerDisconnectedAttached
    // (the listener may already have been attached in startPublishing).
    if (this.publisher && !this._peerDisconnectedAttached) {
      this.attachPeerDisconnectedListener();
      this._peerDisconnectedAttached = true;
    }
  }

  /**
   * Register a handler for VDO SDK peerConnected events.
   * Fires when a viewer's media connection is established.
   * The handler receives the peer UUID of the connected viewer.
   */
  setOnPeerConnected(handler: (peerUuid: string) => void): void {
    this.peerConnectedHandler = handler;
  }

  /**
   * Attach the peerDisconnected SDK listener for the current publisher.
   * Safe to call multiple times; guarded by _peerDisconnectedAttached.
   * Using extractPeerUuid to normalize both Event-object and direct-UUID shapes.
   */
  private attachPeerDisconnectedListener(): void {
    const sdk = this.publisher?.getSDK();
    if (!sdk || typeof (sdk as { on?: unknown }).on !== "function") return;
    (sdk as { on: (event: string, handler: (...args: unknown[]) => void) => void }).on(
      "peerDisconnected",
      (...args: unknown[]) => {
        const { uuid } = extractPeerUuid(args[0]);
        if (!uuid) return;
        try {
          this.peerDisconnectedHandler?.(uuid);
        } catch {
          // ignore handler errors
        }
      },
    );
  }

  setAudioController(controller: ProcessAudioController, mode: 'system' | 'application' | 'monitor' | 'test-tone'): void {
    const previous = this.audioController;

    this.audioController = controller;
    this.audioTrack = controller.getTrack();
    this.appliedAudioMode = mode;
    this._audioState = "active";

    console.log('[PublisherManager] controllerSet', {
      managerInstanceId: this.instanceId,
      controllerId: controller.getInstanceId?.() ?? 'unknown',
      mode,
      hasAudioTrack: this.audioTrack !== null,
      audioTrackReadyState: this.audioTrack?.readyState ?? null,
    });

    if (previous && previous !== controller) {
      previous.close('replacement').catch(() => {});
    }
  }

  /** Remove a previously set audio controller without closing it (caller owns teardown). */
  clearAudioController(): void {
    this.audioController = null;
    this.audioTrack = null;
    this.appliedAudioMode = 'none';
    this._audioState = "disabled";
  }

  private buildCombinedStream(baseStream: MediaStream): MediaStream {
    const videoTracks = baseStream.getVideoTracks();
    const audioController = this.audioController;
    const audioTrack = audioController?.getTrack() ?? null;

    console.log('[PublisherManager] audio input', {
      managerInstanceId: this.instanceId,
      hasAudioController: audioController !== null,
      controllerId: audioController?.getInstanceId?.() ?? null,
      appliedAudioMode: this.appliedAudioMode,
      hasAudioTrack: audioTrack !== null,
      audioTrack: audioTrack ? {
        id: audioTrack.id,
        kind: audioTrack.kind,
        enabled: audioTrack.enabled,
        muted: audioTrack.muted,
        readyState: audioTrack.readyState,
      } : null,
    });

    const stream = new MediaStream();

    if (videoTracks.length > 0) {
      stream.addTrack(videoTracks[0]);
    }

    if (audioTrack) {
      if (audioTrack.kind !== 'audio') {
        throw new Error('publisher-audio-track-wrong-kind');
      }
      if (audioTrack.readyState !== 'live') {
        throw new Error(`publisher-audio-track-${audioTrack.readyState}`);
      }
      const ctrlState = audioController?.getState();
      if (ctrlState === 'rendering' || ctrlState === 'primed') {
        stream.addTrack(audioTrack);
      } else {
        console.warn('[PublisherManager] Audio track is live but controller state is',
          ctrlState, '- skipping audio from combined stream');
      }
    }

    return stream;
  }

  private setState(newState: PublisherState): void {
    this.state = newState;
    this.events.onStateChange(newState);
  }

  async startPublishing(stream: MediaStream, config: PublisherConfig): Promise<void> {
    let originalStream = stream;
    // If we have an audio controller, build a combined stream with video + audio
    if (this.audioController) {
      this.combinedStream = this.buildCombinedStream(stream);
      stream = this.combinedStream;
    }

    // ── Pre-publish diagnostics ───────────────────────────────────
    // Safely log combined stream counts, track states, and video settings.
    const videoTrack = stream.getVideoTracks()[0];
    const audioTracks = stream.getAudioTracks();
    const videoSettings = videoTrack?.getSettings?.() ?? null;

    console.log('[PublisherManager] combined stream', {
      managerInstanceId: this.instanceId,
      videoTracks: stream.getVideoTracks().length,
      audioTracks: audioTracks.length,
      controllerId: this.audioController?.getInstanceId?.() ?? null,
    });

    console.log('[PublisherManager] pre-publish track diagnostics', {
      videoTrack: videoTrack ? {
        id: videoTrack.id,
        kind: videoTrack.kind,
        enabled: videoTrack.enabled,
        muted: videoTrack.muted,
        readyState: videoTrack.readyState,
        label: videoTrack.label,
        contentHint: (videoTrack as MediaStreamTrack & { contentHint?: string }).contentHint,
      } : null,
      videoSettings: videoSettings ? {
        width: videoSettings.width,
        height: videoSettings.height,
        frameRate: videoSettings.frameRate,
        deviceId: videoSettings.deviceId ? '(present)' : undefined,
      } : null,
      audioTracks: audioTracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
        label: t.label,
      })),
      requestedVideoBitrate: config.videoBitrate,
      requestedResolution: `${config.videoWidth}x${config.videoHeight} @ ${config.videoFps}fps`,
      requestedCodec: config.codec ?? 'auto',
    });

    const publisher = new HostPublisher();

    console.log('[PublisherManager] Connecting publisher...');
    // Stage 17: Pass requested codec from group defaults to HostPublisher
    // so codec preferences are applied during connection setup.
    await publisher.createAndConnect({
      password: config.password,
      requestedCodec: config.codec ?? "auto",
    });

    // Register dataReceived handler for media.bind messages (Stage 5)
    // Uses EventTarget CustomEvent semantics (SDK 1.3.18): the SDK passes
    // a single Event argument whose detail = { data, uuid, streamID }.
    // The extractDataReceivedEvent helper normalizes this safely.
    if (this.mediaBindHandler) {
      const sdk = publisher.getSDK();
      if (sdk) {
        sdk.on("dataReceived", (...args: unknown[]) => {
          const normalized = extractDataReceivedEvent(args[0]);
          if (!normalized.valid || !normalized.data) return;
          const data = normalized.data as Record<string, unknown>;
          if (data.type === "media.bind" && data.token && typeof data.token === "string") {
            const viewerSessionId = typeof data.viewerSessionId === "string" ? data.viewerSessionId : undefined;
            this.mediaBindHandler!(normalized.uuid!, data.token, viewerSessionId);
            console.log('[PublisherManager] media.bind consumed', {
              peerUuid: normalized.uuid?.slice(0, 8) + '…',
              bindType: 'media.bind',
              viewerSessionId: viewerSessionId?.slice(0, 8) + '…',
            });
          }
        });
      }
    }

    // Register peerConnected handler for viewer-connected reconciliation.
    // When a viewer peer connects (after successful binding), trigger quality
    // reconciliation so stored viewer requests are applied to the now-ready
    // RTCRtpSender. Also logs sender diagnostics for debugging.
    // Defensive check: if SDK mock or older SDK doesn't support .on, skip.
    // Using extractPeerUuid to normalize both Event-object and direct-UUID shapes.
    {
      const sdk = publisher.getSDK();
      if (sdk && typeof (sdk as { on?: unknown }).on === "function") {
        (sdk as { on: (event: string, handler: (...args: unknown[]) => void) => void }).on("peerConnected", (...args: unknown[]) => {
          this.logSenderDiagnostics('viewer-connected');
          const { uuid } = extractPeerUuid(args[0]);
          if (uuid) {
            try {
              this.peerConnectedHandler?.(uuid);
            } catch {
              // ignore handler errors
            }
          }
        });
      }
    }

    // [Fix] Register peerDisconnected handler if one was registered before
    // startPublishing (via setOnPeerDisconnected). This mirrors the pattern
    // used by mediaBindHandler above and peerConnectedHandler — the SDK
    // publisher exists (local variable) but this.publisher is not yet set,
    // so we attach via the local `publisher` variable directly.
    // The _peerDisconnectedAttached guard also prevents duplicate attachment
    // when setOnPeerDisconnected is called after startPublishing.
    if (this.peerDisconnectedHandler && !this._peerDisconnectedAttached) {
      const sdk = publisher.getSDK();
      if (sdk && typeof (sdk as { on?: unknown }).on === "function") {
        (sdk as { on: (event: string, handler: (...args: unknown[]) => void) => void }).on(
          "peerDisconnected",
          (...args: unknown[]) => {
            const { uuid } = extractPeerUuid(args[0]);
            if (!uuid) return;
            try {
              this.peerDisconnectedHandler?.(uuid);
            } catch {
              // ignore handler errors
            }
          },
        );
        this._peerDisconnectedAttached = true;
      }
    }

    // Stage 17: Apply contentHint to the video track from group defaults (BEFORE publish)
    if (config.contentHint && config.contentHint !== "auto") {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && typeof videoTrack.contentHint !== "undefined") {
        videoTrack.contentHint = config.contentHint as MediaStreamTrack["contentHint"];
      }
    }

    // ── Pre-publish invariants ───────────────────────────────────
    const vt = stream.getVideoTracks()[0];
    if (!vt) {
      throw new Error("video-track-missing-before-publish");
    }
    if (vt.kind !== "video") {
      throw new Error("video-track-wrong-kind-before-publish");
    }
    if (vt.readyState !== "live") {
      throw new Error("video-track-not-live-before-publish");
    }
    if (!vt.enabled) {
      throw new Error("video-track-disabled-before-publish");
    }

    if (this.combinedStream) {
      const originalVideoTrack = originalStream.getVideoTracks()[0];
      const combinedVideoTrack = this.combinedStream.getVideoTracks()[0];
      if (!combinedVideoTrack || combinedVideoTrack !== originalVideoTrack) {
        throw new Error("video-track-lost-in-combined-stream");
      }
    }

    if (this.audioController) {
      const audioTracks = stream.getAudioTracks();
      const hasLiveAudio = audioTracks.some(t => t.readyState === "live");
      if (!hasLiveAudio) {
        throw new Error("audio-track-missing-before-publish");
      }
    }

    console.log('[PublisherManager] Publishing stream...');
    await publisher.publish(stream, {
      streamID: config.streamId,
      label: "ScreenLink Host",
      password: config.password,
      videoBitrate: config.videoBitrate,
      videoResolution: {
        width: config.videoWidth,
        height: config.videoHeight,
        frameRate: config.videoFps,
      },
      audioBitrate: 64000, // 64 kbps -> 8 kB/s for Opus stereo
    });

    // Stage 17: Apply degradationPreference to sender encoding parameters
    if (config.degradationPreference) {
      try {
        const sdk = publisher.getSDK();
        if (sdk) {
          for (const [, group] of sdk.connections) {
            const pc = group.publisher?.pc;
            if (!pc) continue;
            const sender = pc.getSenders().find(s => s.track?.kind === "video");
            if (!sender) continue;
            const params = sender.getParameters();
            if (params) {
              // degradationPreference is a top-level RTCRtpSendParameters field.
              // Setting it on the encoding level is incorrect.
              (params as unknown as { degradationPreference: RTCDegradationPreference }).degradationPreference = config.degradationPreference as RTCDegradationPreference;
              try {
                await sender.setParameters(params);
              } catch (err) {
                console.warn("[PublisherManager] Failed to set degradationPreference:", err);
              }
            }
          }
        }
      } catch (err) {
        console.warn("[PublisherManager] Failed to apply degradationPreference:", err);
      }
    }

    this.publisher = publisher;
    this.config = config;
    this._publishedVideoTrack = stream.getVideoTracks()[0] ?? null;

    // Wire track-ended handler so StreamSessionManager can react when the
    // published video track ends (e.g. browser ends the source track).
    // The handler receives the actual track reference so the caller can
    // check whether it is still the current published track.
    if (this._publishedVideoTrack) {
      this._publishedVideoTrack.onended = () => {
        this.events.onTrackEnded(this._publishedVideoTrack!);
      };
    }

    this.setState("sharing");

    // Log sender presence immediately after publish
    this.logSenderDiagnostics('after-publish');

    // Post-publish bitrate enforcement: verify the sender encoding
    // actually has the requested maxBitrate (in bps). If not, correct it.
    try {
      const sdk = publisher.getSDK();
      if (sdk) {
        for (const [, group] of sdk.connections) {
          const pc = group.publisher?.pc;
          if (!pc) continue;
          const sender = pc.getSenders().find(s => s.track?.kind === "video");
          if (!sender) continue;
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) continue;
          const enc = params.encodings[0];
          if (!enc) continue;
          const appliedBitrate = enc.maxBitrate ?? 0;
          const requestedBps = config.videoBitrate * 1000;

          // Log readback
          const match = appliedBitrate === requestedBps;
          console.log('[PublisherManager] post-publish bitrate readback', {
            requestedKbps: config.videoBitrate,
            requestedBps,
            appliedBps: appliedBitrate,
            match,
          });

          // If mismatch, correct it — preserve other encoding params
          if (!match && requestedBps > 0) {
            enc.maxBitrate = requestedBps;
            await sender.setParameters(params).catch((setErr) => {
              console.warn('[PublisherManager] bitrate correction setParameters failed:', setErr);
            });
            // Read back after correction
            const correctedParams = sender.getParameters();
            const correctedBps = correctedParams.encodings?.[0]?.maxBitrate ?? 0;
            console.log('[PublisherManager] bitrate correction result', {
              requestedBps,
              correctedBps,
              corrected: correctedBps === requestedBps,
            });
          }
        }
      }
    } catch (err) {
      console.warn('[PublisherManager] Post-publish bitrate enforcement failed:', err);
    }
  }

  /**
   * Log sender diagnostics for all publisher peer connections.
   * Context label distinguishes initial publish vs viewer-connected re-evaluation.
   * Never logs tokens or other secrets.
   */
  private logSenderDiagnostics(context: string): void {
    if (!this.publisher) return;
    try {
      const sdk = this.publisher.getSDK();
      if (!sdk) return;
      const entries = Array.from(sdk.connections.entries());
      const allSenders = entries.flatMap(([uuid, g]) => {
        const pc = g.publisher?.pc;
        if (!pc) return [];
        return pc.getSenders().map((s) => ({
          peer: uuid.slice(0, 8) + '…',
          kind: s.track?.kind ?? 'null',
          trackId: s.track?.id?.slice(0, 8) + '…',
          enabled: s.track?.enabled,
          muted: s.track?.muted,
          readyState: s.track?.readyState,
        }));
      });
      if (allSenders.length > 0) {
        console.log(`[PublisherManager] sender diagnostics [${context}]`, allSenders);
      } else {
        console.log(`[PublisherManager] no senders yet [${context}]`);
      }
    } catch (err) {
      console.warn(`[PublisherManager] Sender diagnostic failed [${context}]:`, err);
    }
  }

  /**
   * Detach the track-ended handler from the currently published video track.
   * Called _before_ the old capture track is ended (e.g. before a new
   * getDisplayMedia call) so that the onended handler does not fire and
   * trigger an unwanted stream-stop while switching sources.
   *
   * The onended handler is re-wired by replaceVideoTrack on the new track.
   */
  detachTrackEnded(): void {
    if (this._publishedVideoTrack) {
      this._publishedVideoTrack.onended = null;
    }
  }

  /**
   * Re-attach the track-ended handler to the currently published video track.
   * Called after a failed source switch to restore the handler that was
   * removed by detachTrackEnded(). Without this, the old track ending
   * naturally (user closes source app) would never trigger stopStream.
   */
  reattachTrackEnded(): void {
    if (this._publishedVideoTrack) {
      this._publishedVideoTrack.onended = () => {
        this.events.onTrackEnded(this._publishedVideoTrack!);
      };
    }
  }

  /**
   * Replace the video track on the publisher with a new one.
   * Delegates to HostPublisher.replaceVideoTrack which calls the SDK's
   * public replaceTrack. Updates the internal combined stream reference
   * and publishes the new track together with existing audio.
   *
   * Throws if the replacement fails. The caller is responsible for
   * cleaning up the new track on failure.
   *
   * @returns The old video track that was replaced.
   */
  async replaceVideoTrack(newTrack: MediaStreamTrack): Promise<MediaStreamTrack> {
    if (!this.publisher) throw new Error("replaceVideoTrack: no publisher active");
    const oldTrack = this._publishedVideoTrack;
    if (!oldTrack) throw new Error("replaceVideoTrack: no current video track");

    // Clear the onended handler on the old track so it does not trigger
    // a stop when the browser ends it (which happens when the old
    // capture stream is closed).
    oldTrack.onended = null;

    await this.publisher.replaceVideoTrack(oldTrack, newTrack);

    // Update combined stream reference so self-view and track tracking
    // reflect the new source.
    if (this.combinedStream) {
      this.combinedStream.removeTrack(oldTrack);
      this.combinedStream.addTrack(newTrack);
    }

    this._publishedVideoTrack = newTrack;

    // Wire the new track's ended event.
    newTrack.onended = () => {
      this.events.onTrackEnded(newTrack);
    };

    console.log('[PublisherManager] replaceVideoTrack succeeded', {
      oldTrackId: oldTrack.id.slice(0, 8) + '…',
      newTrackId: newTrack.id.slice(0, 8) + '…',
      newLabel: newTrack.label,
    });

    return oldTrack;
  }

  async stopCapture(): Promise<void> {
    // Return existing promise if already stopping (awaitable idempotency)
    if (this.stopping_) {
      await this.stopPromise_;
      return;
    }
    this.stopping_ = true;
    this.setState("stopping");

    this.stopPromise_ = (async () => {
      try {
        // 1. Stop publisher first (before its media tracks die)
        if (this.publisher) {
          await this.publisher.stopPublishing();
          await this.publisher.disconnect();
          this.publisher = null;
        }

        // 2. Stop audio controller
        if (this.audioController) {
          console.log('[PublisherManager] closing audio controller', {
            managerInstanceId: this.instanceId,
            controllerId: this.audioController.getInstanceId?.() ?? 'unknown',
          });
          await this.audioController.close('shutdown');
          this.audioController = null;
        }

        // 3. Stop audio tracks from combined stream (video track is owned by StreamSessionManager)
        if (this.combinedStream) {
          this.combinedStream.getAudioTracks().forEach(t => t.stop());
          this.combinedStream = null;
        }

        // 4. Clear published video track reference
        if (this._publishedVideoTrack) {
          this._publishedVideoTrack.onended = null;
          this._publishedVideoTrack = null;
        }

        this.audioTrack = null;
        this.appliedAudioMode = 'none';
        this._audioState = "disabled";
        this.config = null;
        this.peerDisconnectedHandler = null;
        this._peerDisconnectedAttached = false;

        this.setState("idle");
      } finally {
        this.stopping_ = false;
        this.stopPromise_ = null;
      }
    })();

    return this.stopPromise_;
  }

  /**
   * Apply video sender settings (bitrate, framerate, degradation preference,
   * scale) to every currently-connected viewer's video sender.
   *
   * Returns structured per-peer results with applied/readback state, so
   * callers can verify the actual parameter values that took effect.
   *
   * Delegates to the shared `applySenderSettings` from quality-coordinator
   * for the per-sender encoding parameter modification.
   */
  async applyVideoSenderSettings(settings: SenderSettingsInput): Promise<ApplyVideoSenderSettingsResult> {
    if (!this.publisher) {
      return { results: [], overall: "all-succeeded" };
    }
    const sdk = this.publisher.getSDK();
    if (!sdk) {
      return { results: [], overall: "all-succeeded" };
    }

    const results: PerPeerApplyResult[] = [];
    let successCount = 0;
    let failCount = 0;

    for (const [peerUuid, group] of sdk.connections) {
      const pc = group.publisher?.pc;
      if (!pc) continue;
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (!sender) {
        // No video sender for this peer — skip with a non-error entry
        results.push({
          peerUuid,
          success: true,
          readback: null,
        });
        successCount++;
        continue;
      }

      try {
        const readback = await applySenderSettings(sender, settings);
        results.push({ peerUuid, success: true, readback });
        successCount++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ peerUuid, success: false, error: message, readback: null });
        failCount++;
      }
    }

    let overall: ApplyOverallStatus;
    if (failCount === 0) {
      overall = "all-succeeded";
    } else if (successCount === 0) {
      overall = "all-failed";
    } else {
      overall = "partial";
    }

    return { results, overall };
  }

  hasAudio(): boolean {
    const track = this.audioController?.getTrack() ?? this.audioTrack;
    return track?.readyState === "live";
  }

  destroy(): void {
    this.stopCapture().catch(() => {});
  }
}
