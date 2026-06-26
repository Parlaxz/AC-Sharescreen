import { ViewerClient } from "@screenlink/vdo-adapter";
import { getRuntime } from "./phase3-runtime.js";
import type { Phase3Runtime } from "./phase3-runtime.js";
import { extractTrackEvent } from "./sdk-event-normalizer.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * ViewerClient event surface corrected for SDK 1.3.18 EventTarget semantics.
 *
 * SDK 1.3.18 fires events as CustomEvent where the payload lives under
 * `event.detail`. The old positional-arg pattern `(track, stream)` is wrong;
 * the correct handler signature receives a single Event object.
 */
interface ViewerClientEvents {
  on(event: "track", listener: (event: { detail: unknown }) => void): void;
  on(event: "trackAdded", listener: (event: { detail: unknown }) => void): void;
  on(event: "remoteAdded", listener: () => void): void;
}

function asEventTarget(vc: ViewerClient): ViewerClientEvents {
  return vc as unknown as ViewerClientEvents;
}

export type ViewerSessionState =
  | "idle"
  | "connecting"
  | "requesting-join"
  | "waiting-for-host"
  | "accepted"
  | "connecting-media"
  | "watching"
  | "ended"
  | "error";

export interface ViewerSessionOptions {
  groupId: string;
  hostDeviceId: string;
  logicalStreamId: string;
  mediaSessionId: string;
  hostName: string;
  videoElement?: HTMLVideoElement | null;
}

export interface ViewerSessionEvents {
  onStateChange?: (state: ViewerSessionState) => void;
  onStreamReceived?: (stream: MediaStream) => void;
  onError?: (error: string) => void;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Max time (ms) to wait for a video track after view() before timing out. */
const VIEWER_READINESS_TIMEOUT_MS = 15_000;

// ─── ViewerSession ─────────────────────────────────────────────────────────

/**
 * ViewerSession — owns one active viewer watch session.
 *
 * Lifecycle:
 *   start()  → "connecting" → "requesting-join" → "waiting-for-host"
 *            → "accepted" → "connecting-media" → "watching"
 *            → or "error" at any point
 *   stop()   → cleanup → "ended"
 *   retry()  → run the full join flow again
 *   destroy()→ final cleanup, no further use
 *
 * The caller (typically ViewerWorkspace) binds a <video> element via
 * `bindVideoElement()`. When the remote MediaStream arrives, it is
 * automatically attached to that element.
 *
 * ABANDONED FLOW PREVENTION:
 *   A generation counter is incremented on every start() call. After every
 *   awaited operation in runJoinFlow(), the flow verifies its generation is
 *   still current. If destroy() or a new start() replaces the session, old
 *   flows exit immediately without creating ViewerClient, calling view(),
 *   sending bind, mutating state, or attaching tracks.
 */
export class ViewerSession {
  private _state: ViewerSessionState = "idle";
  private viewerClient: ViewerClient | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private _receivedStream: MediaStream | null = null;
  private _destructed = false;

  /** Generation counter: incremented on start(), checked after every await. */
  private static nextGeneration = 0;
  private _generation = -1;

  /** Readiness timeout handle for cleanup. */
  private _readinessTimer: ReturnType<typeof setTimeout> | null = null;

  /** Track IDs already in the received stream (deduplication). */
  private _trackIdsInStream = new Set<string>();

  // Self-viewing support — when the host is the local device,
  // we pipe the capture stream directly instead of VDO relay.
  private selfViewEndedHandler: (() => void) | null = null;

  // Session identity (set by start)
  private groupId = "";
  private hostDeviceId = "";
  private logicalStreamId = "";
  private mediaSessionId = "";
  private hostName = "";

  // Events
  public onStateChange: ((state: ViewerSessionState) => void) | null = null;
  public onStreamReceived: ((stream: MediaStream) => void) | null = null;
  public onError: ((error: string) => void) | null = null;

  get state(): ViewerSessionState {
    return this._state;
  }

  get receivedStream(): MediaStream | null {
    return this._receivedStream;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Start watching a remote stream. Runs the real join flow:
   *   1) Resolve connection + host peer
   *   2) Send stream.join.request
   *   3) Wait for stream.join.response
   *   4) Create ViewerClient, connect, view
   *   5) Send media.bind
   *   6) Receive media tracks
   */
  async start(options: ViewerSessionOptions): Promise<void> {
    if (this._destructed) return;
    this.groupId = options.groupId;
    this.hostDeviceId = options.hostDeviceId;
    this.logicalStreamId = options.logicalStreamId;
    this.mediaSessionId = options.mediaSessionId;
    this.hostName = options.hostName;

    if (options.videoElement) {
      this.videoElement = options.videoElement;
    }

    // Bump generation to invalidate any prior in-flight flow
    ViewerSession.nextGeneration++;
    this._generation = ViewerSession.nextGeneration;

    await this.runJoinFlow();
  }

  /**
   * Check whether this session's generation is still current.
   * After every await in runJoinFlow(), this guard prevents abandoned
   * flows from continuing.
   */
  private isCurrent(): boolean {
    return !this._destructed && this._generation === ViewerSession.nextGeneration;
  }

  /**
   * Bind or rebind the video element. If a stream is already received,
   * it is immediately attached.
   */
  bindVideoElement(el: HTMLVideoElement | null): void {
    this.videoElement = el;
    if (el && this._receivedStream) {
      this.attachStreamToElement(el, this._receivedStream);
    }
  }

  /**
   * Attach a MediaStream to a video element with autoplay and playsInline.
   * Calls play() and surfaces autoplay failures.
   * Applies current muted/volume state.
   */
  private attachStreamToElement(el: HTMLVideoElement, stream: MediaStream): void {
    el.srcObject = stream;
    el.autoplay = true;
    el.playsInline = true;

    // Preserve current mute/volume state — do NOT force el.muted = false.
    // The caller manages mute via volume/muted refs (e.g. media controls).

    el.play().catch((reason) => {
      // Surface real autoplay failures rather than swallowing them
      console.warn('[ViewerSession] video.play() failed (autoplay may be blocked):', reason);
    });
  }

  /**
   * Retry the full join flow. Resets state and runs start() again
   * with the same session parameters.
   */
  async retry(): Promise<void> {
    if (this._destructed) return;
    this.cleanupClient();
    this._receivedStream = null;
    this._trackIdsInStream.clear();

    // Bump generation so in-flight flows from prior retry are abandoned
    ViewerSession.nextGeneration++;
    this._generation = ViewerSession.nextGeneration;

    await this.runJoinFlow();
  }

  /**
   * Stop watching and clean up. Idempotent.
   */
  stop(): void {
    if (this._state === "ended") return;
    this.cancelReadinessTimer();
    this.cleanupClient();
    this._receivedStream = null;
    this._trackIdsInStream.clear();
    this.setState("ended");
  }

  /**
   * Final cleanup. The session cannot be restarted after this.
   * Idempotent.
   */
  destroy(): void {
    if (this._destructed) return;
    this._destructed = true;
    this.cancelReadinessTimer();
    this.cleanupClient();
    this._receivedStream = null;
    this._trackIdsInStream.clear();
    this.videoElement = null;
    this._state = "ended";
    this.onStateChange = null;
    this.onStreamReceived = null;
    this.onError = null;
  }

  // ── Join flow ───────────────────────────────────────────────────────

  private async runJoinFlow(): Promise<void> {
    if (!this.isCurrent()) return;

    this.setState("requesting-join");

    try {
      const runtime = getRuntime();
      if (!runtime || runtime.isDestroyed()) {
        this.setError("runtime not initialized");
        return;
      }

      // ── Self-viewing ──────────────────────────────────────────────
      // When the host is the local device, pipe the capture stream
      // directly instead of going through the VDO relay. This lets
      // the host preview their own share in the ViewerWorkspace.
      if (this.hostDeviceId === runtime.deviceId) {
        await this.startSelfView(runtime);
        return;
      }

      const connManager = runtime.getConnectionManager();
      const conn = connManager.getConnection(this.groupId);
      if (!conn) {
        this.setError("not connected to group");
        return;
      }

      // 1) Resolve host peer
      this.setState("connecting");
      const peerUuid = conn.peerForDevice(this.hostDeviceId);
      if (!peerUuid) {
        this.setError("host not connected");
        return;
      }

      // 2) Send stream.join.request
      this.setState("requesting-join");
      const requestId = crypto.randomUUID();
      await conn.sendToPeer(peerUuid, {
        type: "stream.join.request",
        logicalStreamId: this.logicalStreamId,
        viewerDeviceId: runtime.deviceId ?? "viewer",
        viewerDisplayName: runtime.displayName ?? "Viewer",
        requestId,
      });

      // GENERATION CHECK
      if (!this.isCurrent()) return;

      // 3) Wait for stream.join.response
      this.setState("waiting-for-host");
      const response = await runtime.waitForJoinResponse(requestId, 30_000);

      // GENERATION CHECK
      if (!this.isCurrent()) return;

      if (!response.accepted) {
        this.setError(response.reason ?? "join rejected");
        return;
      }

      // 4) Extract credentials from response
      const joinToken = response.mediaJoinMetadata;
      const responseMediaSessionId = response.mediaSessionId ?? this.mediaSessionId;
      if (!joinToken) {
        this.setError("no join token in response");
        return;
      }

      this.setState("accepted");

      // GENERATION CHECK
      if (!this.isCurrent()) return;

      // 5) Create ViewerClient and connect
      this.setState("connecting-media");
      const viewerClient = new ViewerClient();
      this.viewerClient = viewerClient;

      // Register track event handlers to capture the received MediaStream.
      // SDK 1.3.18 fires trackAdded (primary) with
      //   CustomEvent detail = { track, uuid, streamID }
      // Older SDK paths may fire the "track" event with
      //   CustomEvent detail = { track, streams, uuid }.
      // We use the extractTrackEvent helper to normalize both shapes safely.
      const events = asEventTarget(viewerClient);

      const handleTrackEvent = (event: { detail: unknown }): void => {
        // Abandoned-flow guard: if this session was destroyed/replaced, skip
        if (!this.isCurrent()) return;

        const normalized = extractTrackEvent(event);
        if (!normalized.valid || !normalized.track) return;

        const track = normalized.track as MediaStreamTrack;

        // Only video tracks should trigger the watching transition
        const isVideo = track.kind === "video";

        // Create or get the stable received stream.
        // On first track event, prefer streams[0] from the SDK event (when
        // available and valid), otherwise create a new MediaStream (or fall
        // back to a plain object in test environments where MediaStream is
        // unavailable).
        if (!this._receivedStream) {
          if (
            normalized.streams.length > 0 &&
            normalized.streams[0] !== null &&
            typeof normalized.streams[0] === "object"
          ) {
            this._receivedStream = normalized.streams[0] as MediaStream;
            // Seed the dedupe set with any tracks already in the adopted
            // stream so we do not insert the same track a second time.
            if (typeof (this._receivedStream as unknown as Record<string, unknown>).getTracks === "function") {
              const existing = this._receivedStream.getTracks();
              for (const t of existing) {
                this._trackIdsInStream.add(t.id);
              }
            }
          } else {
            try {
              this._receivedStream = new MediaStream();
            } catch {
              // Non-browser environment (tests): use a plain object
              this._receivedStream = { addTrack: () => {} } as unknown as MediaStream;
            }
          }
        }

        // Avoid duplicate track insertion
        if (track.id && !this._trackIdsInStream.has(track.id)) {
          this._trackIdsInStream.add(track.id);
          // Defensive: only call addTrack if the stream supports it
          if (typeof (this._receivedStream as unknown as Record<string, unknown>).addTrack === "function") {
            this._receivedStream.addTrack(track);
          }
          // Listen for remote track ending (host stopped sharing)
          // Defensive: only addEventListener if track supports it (not all test mocks do)
          if (typeof track.addEventListener === "function") {
            track.addEventListener("ended", handleRemoteTrackEnded, { once: true });
          }
        }

        // Attach to video element if bound
        if (this.videoElement && this._receivedStream) {
          this.attachStreamToElement(this.videoElement, this._receivedStream);
        }

        this.onStreamReceived?.(this._receivedStream);

        // Only transition to watching when a live video track is received
        if (isVideo) {
          this.cancelReadinessTimer();
          this.setState("watching");
        }
      };

      // Primary: SDK 1.3.18 trackAdded (real Alice/Bob watch path)
      events.on("trackAdded", handleTrackEvent);
      // Backward compat: older event shape
      events.on("track", handleTrackEvent);

      // Monitor remote track ended events (host stopped sharing)
      // Use 2s debounce to avoid mistaking brief interruptions for intentional stops
      let remoteTrackEndedTimer: ReturnType<typeof setTimeout> | null = null;
      const handleRemoteTrackEnded = (): void => {
        if (!this.isCurrent()) return;
        if (remoteTrackEndedTimer) clearTimeout(remoteTrackEndedTimer);
        remoteTrackEndedTimer = setTimeout(() => {
          remoteTrackEndedTimer = null;
          if (!this.isCurrent()) return;
          // If still in watching state after debounce, the stream likely ended
          if (this._state === "watching") {
            this.stop();
          }
        }, 2000);
      };

      // Also handle remoteAdded for older SDK signaling
      events.on("remoteAdded", () => {
        // Tracks arrive via the "track" event above; remoteAdded is
        // a legacy signal that the remote peer has joined the media
        // session.
      });

      // Connect to VDO — the join response should always contain the
      // host-generated VDO password.  Fall back to mediaSessionId only
      // for backward compatibility with older hosts that did not send
      // `password` in the join response.  This fallback is intentionally
      // narrow: if neither is available, createAndConnect will reject
      // and the error handler will surface the failure.
      const vdoPassword = response.password ?? responseMediaSessionId;
      await viewerClient.createAndConnect(vdoPassword);

      // GENERATION CHECK
      if (!this.isCurrent()) return;

      // View the stream
      const vdoStreamId = response.streamId ?? this.logicalStreamId;
      await viewerClient.view(vdoStreamId, runtime.displayName ?? "Viewer");

      // GENERATION CHECK
      if (!this.isCurrent()) return;

      // 6) Send media.bind
      // Wait for data channel to open, then send with preference: "any".
      // The sendMediaBind method now handles waiting for dataChannelOpen
      // and bounded retry internally.
      const sdk = viewerClient.getSDK();
      if (sdk && joinToken) {
        for (const [publisherUuid] of sdk.connections) {
          try {
            await viewerClient.sendMediaBind(publisherUuid, joinToken, responseMediaSessionId);
            console.log('[ViewerSession] media.bind delivered to', publisherUuid.slice(0, 8) + '…');
          } catch (err) {
            console.warn('[ViewerSession] media.bind failed for', publisherUuid.slice(0, 8) + '…', err);
          }
        }
      }

      // GENERATION CHECK
      if (!this.isCurrent()) return;

      // 7) Viewer readiness timeout
      // If after view() we only received audio (no video track), remain
      // "connecting-media" and start a timeout to surface the error.
      if (this._state !== "watching") {
        this.startReadinessTimeout();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setError(message);
    }
  }

  /**
   * Start viewer readiness timeout. If no video track arrives within
   * VIEWER_READINESS_TIMEOUT_MS, emit a precise error.
   */
  private startReadinessTimeout(): void {
    this.cancelReadinessTimer();
    this._readinessTimer = setTimeout(() => {
      this._readinessTimer = null;

      // Only fire if still waiting for video
      if (this._destructed || this._state === "watching" || this._state === "error" || this._state === "ended") return;

      // Gather diagnostics for the timeout error
      const stream = this._receivedStream;
      const videoTracks = stream?.getVideoTracks() ?? [];
      const audioTracks = stream?.getAudioTracks() ?? [];

      console.warn('[ViewerSession] readiness timeout', {
        state: this._state,
        hasReceivedStream: stream !== null,
        videoTrackCount: videoTracks.length,
        audioTrackCount: audioTracks.length,
      });

      this.setError("Connected, but no video track was received");
    }, VIEWER_READINESS_TIMEOUT_MS);
  }

  private cancelReadinessTimer(): void {
    if (this._readinessTimer) {
      clearTimeout(this._readinessTimer);
      this._readinessTimer = null;
    }
  }

  /**
   * Self-viewing: host is the local device, so pipe the capture stream
   * directly to the video element instead of routing through VDO relay.
   *
   * Monitors the capture video track's "ended" event to automatically
   * transition the viewer state when the user stops sharing.
   */
  private async startSelfView(runtime: Phase3Runtime): Promise<void> {
    this.setState("connecting");

    const ssm = runtime.getStreamSessionManager();
    const captureStream = ssm.getCaptureStream();
    if (!captureStream) {
      this.setError("no local capture stream");
      return;
    }

    this._receivedStream = captureStream;
    this.onStreamReceived?.(captureStream);

    if (this.videoElement) {
      this.videoElement.srcObject = captureStream;
      this.videoElement.muted = true; // Prevent audio feedback in self-view
      await this.videoElement.play().catch(() => {});
    }

    this.setState("watching");

    // Watch for the capture track ending (user stops sharing).
    const track = captureStream.getVideoTracks()[0];
    if (track) {
      const onEnded = () => {
        track.removeEventListener("ended", onEnded);
        this.selfViewEndedHandler = null;
        this.stop();
      };
      this.selfViewEndedHandler = onEnded;
      track.addEventListener("ended", onEnded);
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private setState(state: ViewerSessionState): void {
    if (this._destructed) return;
    this._state = state;
    this.onStateChange?.(state);
  }

  private setError(error: string): void {
    if (this._destructed) return;
    this.cancelReadinessTimer();
    this._state = "error";
    this.onStateChange?.("error");
    this.onError?.(error);
    this.cleanupClient();
  }

  private cleanupClient(): void {
    // Remove self-view track-end listener
    if (this.selfViewEndedHandler) {
      if (this._receivedStream) {
        const track = this._receivedStream.getVideoTracks()[0];
        if (track) {
          track.removeEventListener("ended", this.selfViewEndedHandler);
        }
      }
      this.selfViewEndedHandler = null;
    }

    if (this.viewerClient) {
      try {
        this.viewerClient.stopViewing().catch(() => {});
        this.viewerClient.disconnect().catch(() => {});
      } catch {
        // Ignore cleanup errors
      }
      this.viewerClient = null;
    }
    // Clear video element
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.srcObject = null;
    }
  }
}
