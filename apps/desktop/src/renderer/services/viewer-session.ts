import { ViewerClient } from "@screenlink/vdo-adapter";
import { getRuntime } from "./phase3-runtime.js";
import type { Phase3Runtime } from "./phase3-runtime.js";
import { extractTrackEvent } from "./sdk-event-normalizer.js";
import { StreamMetricsService } from "./stream-metrics-service.js";

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
  | "paused"
  | "reconnecting"
  | "ended"
  | "error";

  /**
   * Pause lifecycle state machine.
   *
   *   playing → pause() → pausing → paused  (connection kept alive)
   *   paused  → resume() → resuming → playing (same connection)
   *
   * The WebRTC connection, sender, binding, and data channel all stay alive
   * through pause/resume. The host disables/re-enables the sender encoding.
   *
   * Transitions are async and guarded by a generation counter so that rapid
   * pause() → resume() → pause() sequences cannot overlap.
   */
  export type ViewerPauseState =
    | "playing"
    | "pausing"
    | "paused"
    | "resuming";

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
  /** Fired when the pause state transitions. Used by ViewerWorkspace for reactive UI updates. */
  onPauseStateChange?: (pauseState: ViewerPauseState) => void;
  /** Fired when a poster frame is captured or cleared. Passes a data: URL or null. */
  onPosterFrameChange?: (poster: string | null) => void;
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
 *   stop()   → async cleanup → "ended"
 *   retry()  → async cleanup → full join flow again
 *   destroy()→ final async cleanup, no further use
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
 *
 * LEAVE/REJOIN LIFECYCLE:
 *   Every Watch attempt is identified by a `viewerSessionId` (a UUID
 *   generated on each start()). The ID is carried through the join
 *   request, the bind handshake, the leave message, and the host-side
 *   mapping, so a delayed leave from a prior attempt can never remove
 *   the active mapping for a newer attempt.
 *
 *   Teardown is fully asynchronous and idempotent. stop(), destroy()
 *   and retry() all share a single teardown promise — repeated calls
 *   await the same cleanup rather than racing each other. A new
 *   start() awaits any in-progress teardown before beginning a new
 *   attempt, so no two ViewerClient instances are ever alive at once.
 */
export class ViewerSession {
  private _state: ViewerSessionState = "idle";
  private viewerClient: ViewerClient | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private _receivedStream: MediaStream | null = null;
  private _destructed = false;

	/**
	 * Instance-local generation counter: incremented on start(), checked
	 * after every await. Unlike the old static counter, this is per-instance
	 * so two ViewerSession instances can run concurrently without one
	 * invalidating the other's in-flight operations.
	 */
	private _nextGeneration = 0;
	private _generation = -1;

  /**
   * Single shared teardown promise. stop(), destroy(), and retry() all
   * route through `tearDown()` and await the same promise — this
   * guarantees that a re-entrant call (e.g. error handler triggering
   * cleanup while a manual stop is in flight) cannot double-clean the
   * ViewerClient.
   */
  private _teardownPromise: Promise<void> | null = null;
  /**
   * Set while a teardown is in progress. Used by start() to detect
   * that it must await the existing teardown before creating a new
   * ViewerClient.
   */
  private _tearingDown = false;

  /** Readiness timeout handle for cleanup. */
  private _readinessTimer: ReturnType<typeof setTimeout> | null = null;

  /** 2-second interval for sending viewer.status reports to the host */
  private _statusInterval: ReturnType<typeof setInterval> | null = null;
  /** Guards the status interval so only one tick runs at a time */
  private _statusReportInFlight = false;

  /** Track IDs already in the received stream (deduplication). */
  private _trackIdsInStream = new Set<string>();

  /** Current pending join request ID, for cancellation on stop/destroy/retry. */
  private _pendingRequestId: string | null = null;

  /** Remote-track-ended debounce timer — instance state for proper cleanup. */
  private _remoteTrackEndedTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tracks the last play() promise so that attachStreamToElement never
   * starts a new play() while a previous one is still settling — avoiding
   * AbortError from overlapping calls.
   */
  private _playPromise: Promise<void> | null = null;

  // Self-viewing support — when the host is the local device,
  // we pipe the capture stream directly instead of VDO relay.
  private selfViewEndedHandler: (() => void) | null = null;

  /** Max self-view retry attempts when capture stream is not yet available. */
  private static readonly SELF_VIEW_MAX_RETRIES = 3;
  /** Delay (ms) between self-view retry attempts. */
  private static readonly SELF_VIEW_RETRY_DELAY_MS = 2_000;
  /** Max wait for media readiness before retrying play() anyway. */
  private static readonly PLAY_RETRY_READY_TIMEOUT_MS = 3_000;
  /** Current self-view retry count. Resets on successful start(). */
  private _selfViewRetryCount = 0;
  /** Handle for cancelling a scheduled self-view retry. */
  private _selfViewRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly HAVE_CURRENT_DATA = typeof HTMLMediaElement === "undefined"
    ? 2
    : HTMLMediaElement.HAVE_CURRENT_DATA;

  // Session identity (set by start)
  private groupId = "";
  private hostDeviceId = "";
  private logicalStreamId = "";
  private mediaSessionId = "";
  private hostName = "";
  private leaveAnnounced = false;

  /**
   * Guards the one-shot auto-retry. Set to true after the first connect
   * timeout triggers an automatic retry. Reset in start() so a fresh
   * Watch attempt gets a new auto-retry budget.
   */
  private _autoRetried = false;

  /**
   * Per-attempt viewer session ID. Generated by start() and propagated
   * through stream.join.request, the media.bind payload, and
   * stream.leave. The host uses it to disambiguate attempts that share
   * the same viewerDeviceId.
   */
  private _viewerSessionId: string | null = null;

	/**
	 * Saved bind parameters for re-sending media.bind after resume.
	 * The host requires media.bind authorisation on the new data channel
	 * before it will deliver video/audio. Without re-sending bind after
	 * view() re-establishes the RTC connection, the host sees a connected
	 * viewer but does not forward media tracks.
	 */
	private _bindToken: string | null = null;
  private _bindMediaSessionId: string | null = null;

  // ── Pause state machine ─────────────────────────────────────────────
  private _pauseState: ViewerPauseState = "playing";
  /** Captured poster frame (data: URL) shown while paused. */
  private _pausePoster: string | null = null;
  /** Current media mode preference. Sent to host to save bandwidth. */
  private _mediaMode: { audioEnabled: boolean; videoEnabled: boolean } = { audioEnabled: true, videoEnabled: true };
	/**
	 * Instance-local pause generation counter. Bumped to cancel in-flight
	 * pause/resume that raced a newer call on this instance. Static would
	 * let one session's pause invalidate another's, so this is per-instance.
	 */
	private _nextPauseGeneration = 0;
	private _pauseGeneration = -1;
  /** Current pending pause operation ID, for cancellation on teardown. */
  private _pendingPauseOperationId: string | null = null;

  // Events
  public onStateChange: ((state: ViewerSessionState) => void) | null = null;
  public onStreamReceived: ((stream: MediaStream) => void) | null = null;
  public onError: ((error: string) => void) | null = null;
  public onPauseStateChange: ((pauseState: ViewerPauseState) => void) | null = null;
  public onPosterFrameChange: ((poster: string | null) => void) | null = null;

  get state(): ViewerSessionState {
    return this._state;
  }

  get receivedStream(): MediaStream | null {
    return this._receivedStream;
  }

  /**
   * The per-attempt viewer session ID. Null until start() is called.
   * Stays stable for the lifetime of one Watch attempt and is replaced
   * on every new start() (or retry()).
   */
  get viewerSessionId(): string | null {
    return this._viewerSessionId;
  }

  /** Current pause state of the media connection. */
  get pauseState(): ViewerPauseState {
    return this._pauseState;
  }

  /** True while the viewer is user-paused (media stopped, signaling alive). */
  get isPaused(): boolean {
    return this._pauseState === "paused";
  }

  /**
   * The captured poster frame (data: URL) shown while paused.
   * Null when not paused or after resume delivers a live frame.
   */
  get pausePoster(): string | null {
    return this._pausePoster;
  }

  /**
   * Pause media playback — acknowledged transaction with host.
   *
   * Captures the current video frame as a poster, then marks the viewer as
   * paused locally and sends an acknowledged pause request to the host.
   * The host disables the sender encoding (active=false) and responds with
   * viewer.paused.result. Only after receiving the host's acknowledgement
   * does the session transition to the "paused" state.
   *
   * State machine: playing → pausing → paused (after host ack)
   *   or: playing → pausing → playing (on host failure/timeout)
   *
   * Self-view pause is local-only — no host message sent.
   */
  async pause(): Promise<void> {
    if (this._destructed || !this.viewerClient) return;
    if (this._pauseState === "paused") return; // idempotent
    if (this._pauseState === "pausing") return; // already in flight

    // If currently resuming, bail so the caller can retry
    if (this._pauseState === "resuming") return;

    this._nextPauseGeneration++;
    this._pauseGeneration = this._nextPauseGeneration;

    this.setPauseState("pausing");

    try {
      // 1) Capture the current video frame before disabling the sender
      this.capturePosterFrame();

      // 2) Pause the bound video element locally so it holds the last frame
      this.videoElement?.pause();

      // 3) Mark local intent — synchronous, no SDK calls
      this.viewerClient.pauseMedia();

      // GENERATION CHECK
      if (!this.isPauseGenerationCurrent()) return;

      // 4) Self-view: skip host confirmation
      if (this.hostDeviceId === getRuntime()?.deviceId) {
        this.setPauseState("paused");
        return;
      }

      // 5) Send acknowledged pause request to host with operationId
      const operationId = crypto.randomUUID();
      this._pendingPauseOperationId = operationId;
      this.sendViewerPauseRequest(true, operationId);

      // GENERATION CHECK
      if (!this.isPauseGenerationCurrent()) {
        this._pendingPauseOperationId = null;
        return;
      }

      // 6) Wait for host acknowledgement (5s timeout)
      const runtime = getRuntime();
      if (runtime && !runtime.isDestroyed()) {
        try {
          const result = await runtime.waitForViewerPauseResult(operationId, 5_000);
          this.assertPauseResult(result, operationId, true);
        } finally {
          this._pendingPauseOperationId = null;
        }
      }

      // GENERATION CHECK
      if (!this.isPauseGenerationCurrent()) return;

      // 7) Host confirmed — transition to paused
      this.setPauseState("paused");
    } catch (err) {
      // Pause failed or timed out — revert to playing
      this.clearPosterFrame();
      this.setPauseState("playing");
      console.error("[ViewerSession] pause failed, returning to playing:", err);
      throw err;
    }
  }

  /**
   * Resume a paused media stream — acknowledged transaction with host.
   *
   * Notifies the host which re-enables the sender encoding (active=true).
   * Only after receiving viewer.paused.result from the host does the
   * session transition to "playing". The poster frame remains visible
   * until a fresh video frame arrives via the track handler.
   *
   * State machine: paused → resuming → playing (after host ack)
   *   or: paused → resuming → paused (on host failure/timeout)
   *
   * Self-view resume is local-only — no host message sent.
   */
  async resume(): Promise<void> {
    if (this._destructed) return;
    if (this._pauseState !== "paused") return; // no-op if not paused

    this._nextPauseGeneration++;
    this._pauseGeneration = this._nextPauseGeneration;

    this.setPauseState("resuming");
    void this.buildAndSendViewerStatus("reconnecting");

    try {
      const vc = this.viewerClient;
      if (!vc) {
        throw new Error("ViewerClient destroyed during pause");
      }

      // 1) Mark local intent — synchronous, no SDK calls
      vc.resumeMedia();

      // GENERATION CHECK
      if (!this.isPauseGenerationCurrent()) return;

      // 2) Self-view: skip host confirmation
      if (this.hostDeviceId === getRuntime()?.deviceId) {
        void this.videoElement?.play().catch(() => {});
        this.setPauseState("playing");
        return;
      }

      // 3) Send acknowledged resume request to host with operationId
      const operationId = crypto.randomUUID();
      this._pendingPauseOperationId = operationId;
      this.sendViewerPauseRequest(false, operationId);

      // GENERATION CHECK
      if (!this.isPauseGenerationCurrent()) {
        this._pendingPauseOperationId = null;
        return;
      }

      // 4) Wait for host acknowledgement (5s timeout)
      const runtime = getRuntime();
      if (runtime && !runtime.isDestroyed()) {
        try {
          const result = await runtime.waitForViewerPauseResult(operationId, 5_000);
          this.assertPauseResult(result, operationId, false);
        } finally {
          this._pendingPauseOperationId = null;
        }
      }

      // GENERATION CHECK
      if (!this.isPauseGenerationCurrent()) return;

      // 5) Host confirmed — transition to playing.
      //    Do NOT clear poster here — keep it visible until the video element
      //    actually starts rendering fresh frames (playing event).
      //    Resume the video element playback so the live stream shows through.
      const videoEl = this.videoElement;
      if (videoEl) {
        const onPlaying = () => {
          videoEl.removeEventListener("playing", onPlaying);
          this.clearPosterFrame();
        };
        videoEl.addEventListener("playing", onPlaying, { once: true });
        void videoEl.play().catch(() => {
          videoEl.removeEventListener("playing", onPlaying);
        });
      }

      this.setPauseState("playing");
    } catch (err) {
      // Resume failed — revert to paused so the user can retry
      this.setPauseState("paused");
      console.error("[ViewerSession] resume failed, remaining paused:", err);
      throw err;
    }
  }

  /**
   * Send a viewer.paused message to the host over the group control channel.
   *
   * Includes the full transaction identity: groupId, logicalStreamId,
   * mediaSessionId, viewerSessionId, viewerDeviceId, operationId, and
   * the paused flag. The host responds with viewer.paused.result carrying
   * the same operationId for correlation.
   *
   * Fire-and-forget — errors are caught internally.
   *
   * @param paused true to pause, false to resume
   * @param operationId unique operation identifier for result correlation
   */
  private sendViewerPauseRequest(paused: boolean, operationId: string): void {
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return;
    if (!this.groupId || !this.hostDeviceId || !this.logicalStreamId) return;

    const conn = runtime.getConnectionManager().getConnection(this.groupId);
    if (!conn) return;

    const peerUuid = conn.peerForDevice(this.hostDeviceId);
    if (!peerUuid) return;

    void conn.sendToPeer(peerUuid, {
      type: "viewer.pause.request",
      groupId: this.groupId,
      logicalStreamId: this.logicalStreamId,
      mediaSessionId: this.mediaSessionId,
      viewerSessionId: this._viewerSessionId ?? "",
      viewerDeviceId: runtime.deviceId ?? "viewer",
      operationId,
      paused,
    }).catch(() => {});
  }

  private assertPauseResult(
    result: {
      groupId: string;
      logicalStreamId: string;
      mediaSessionId: string;
      viewerSessionId: string;
      viewerDeviceId: string;
      operationId: string;
      paused: boolean;
      success: boolean;
      failureReason?: string;
    },
    operationId: string,
    expectedPaused: boolean,
  ): void {
    const runtime = getRuntime();
    const expectedViewerDeviceId = runtime?.deviceId ?? "viewer";

    if (result.operationId !== operationId) {
      throw new Error("stale pause result");
    }

    if (
      result.groupId !== this.groupId ||
      result.logicalStreamId !== this.logicalStreamId ||
      result.mediaSessionId !== this.mediaSessionId ||
      result.viewerSessionId !== (this._viewerSessionId ?? "") ||
      result.viewerDeviceId !== expectedViewerDeviceId
    ) {
      throw new Error("pause result identity mismatch");
    }

    if (!result.success) {
      throw new Error(result.failureReason || "pause request rejected");
    }

    if (result.paused !== expectedPaused) {
      throw new Error("pause result state mismatch");
    }
  }

  /**
   * Capture the current video frame as a data: URL poster.
   * Draws the video element (which still holds the last frame) onto a
   * <canvas>, then stores the resulting data URL. If no video element is
   * bound, the poster remains null and the UI will show a dark overlay.
   */
  private capturePosterFrame(): void {
    const el = this.videoElement;
    if (!el || !el.videoWidth || !el.videoHeight) {
      this._pausePoster = null;
      this.onPosterFrameChange?.(null);
      return;
    }

    try {
      const canvas = document.createElement("canvas");
      canvas.width = el.videoWidth;
      canvas.height = el.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        this._pausePoster = null;
        this.onPosterFrameChange?.(null);
        return;
      }
      ctx.drawImage(el, 0, 0);
      this._pausePoster = canvas.toDataURL("image/jpeg", 0.85);
      this.onPosterFrameChange?.(this._pausePoster);
      // Clean up the temporary canvas
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      this._pausePoster = null;
      this.onPosterFrameChange?.(null);
    }
  }

  /** Clear the captured poster frame. */
  private clearPosterFrame(): void {
    if (this._pausePoster !== null) {
      this._pausePoster = null;
      this.onPosterFrameChange?.(null);
    }
  }

  /** Set pause state and emit event. */
  private setPauseState(state: ViewerPauseState): void {
    if (this._destructed) return;
    this._pauseState = state;
    this.onPauseStateChange?.(state);
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Start watching a remote stream. Runs the real join flow:
   *   1) Resolve connection + host peer
   *   2) Send stream.join.request (carries viewerSessionId)
   *   3) Wait for stream.join.response
   *   4) Create ViewerClient, connect, view
   *   5) Send media.bind (carries viewerSessionId)
   *   6) Receive media tracks
   *
   * If a previous teardown is still in flight, this method awaits it
   * first — so a Watch → Exit → Watch sequence always sees exactly one
   * ViewerClient alive at a time.
   */
  async start(options: ViewerSessionOptions): Promise<void> {
    if (this._destructed) return;

    // Wait for any in-progress teardown to finish before creating a
    // new ViewerClient. Without this, a fast Watch → Exit → Watch
    // cycle would start a new join flow while the old one is still
    // tearing the SDK down, leaving two SDK instances alive on the
    // same stream credentials and the host believing the old viewer
    // is still attached.
    if (this._teardownPromise) {
      try {
        await this._teardownPromise;
      } catch {
        // Teardown is best-effort; proceed regardless.
      }
    }

    this.groupId = options.groupId;
    this.hostDeviceId = options.hostDeviceId;
    this.logicalStreamId = options.logicalStreamId;
    this.mediaSessionId = options.mediaSessionId;
    this.hostName = options.hostName;
    this.leaveAnnounced = false;
    this._viewerReadySent = false;
    this._viewerSessionId = generateViewerSessionId();

    if (options.videoElement) {
      this.videoElement = options.videoElement;
    }

		// Bump generation to invalidate any prior in-flight flow on this instance
		this._nextGeneration++;
		this._generation = this._nextGeneration;

    // Reset auto-retry guard so a fresh Watch attempt gets a retry budget
    this._autoRetried = false;

    // Reset self-view retry counter on fresh start attempt
    this._selfViewRetryCount = 0;
    this.cancelSelfViewRetryTimer();

    await this.runJoinFlow();
  }

  /**
   * Check whether this session's generation is still current.
   * After every await in runJoinFlow(), this guard prevents abandoned
   * flows from continuing.
   */
	private isCurrent(): boolean {
		return !this._destructed && this._generation === this._nextGeneration;
	}

  /**
   * Check whether this pause/resume operation's generation is still current.
   * After every await in pause()/resume(), this guard prevents a stale
   * operation from continuing after a newer pause()/resume() call.
   */
	private isPauseGenerationCurrent(): boolean {
		return !this._destructed && this._pauseGeneration === this._nextPauseGeneration;
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
   * Idempotent: skips redundant srcObject assignments for the same stream.
   * Resilient: serializes play() calls and retries once on AbortError after
   * the same stream becomes playable.
   *
   * Applies current mute/volume state via the caller (video controls refs).
   */
  private attachStreamToElement(el: HTMLVideoElement, stream: MediaStream): void {
    const alreadyAttached = el.srcObject === stream;

    el.autoplay = true;
    el.playsInline = true;

    if (!alreadyAttached) {
      el.srcObject = stream;
    }

    // Preserve current mute/volume state — do NOT force el.muted = false.
    // The caller manages mute via volume/muted refs (e.g. media controls).

    const readyState = typeof el.readyState === "number" ? el.readyState : 0;
    const paused = typeof el.paused === "boolean" ? el.paused : true;
    if (alreadyAttached && !paused && readyState >= ViewerSession.HAVE_CURRENT_DATA) {
      return;
    }

    const attemptPlay = async (): Promise<void> => {
      if (el.srcObject !== stream) return;

      try {
        await el.play();
      } catch (reason) {
        const err = reason as DOMException;
        if (err?.name === "AbortError" && el.srcObject === stream) {
          await this.waitForCanPlay(el, stream);
          if (el.srcObject === stream) {
            await el.play();
          }
          return;
        }

        console.warn("[ViewerSession] video.play() failed (autoplay may be blocked):", reason);
      }
    };

    const queuedPlay = (this._playPromise ?? Promise.resolve())
      .catch(() => {})
      .then(attemptPlay)
      .catch((reason) => {
        console.warn("[ViewerSession] video.play() retry also failed:", reason);
      });

    this._playPromise = queuedPlay;
    queuedPlay.finally(() => {
      if (this._playPromise === queuedPlay) {
        this._playPromise = null;
      }
    });
  }

  private waitForCanPlay(el: HTMLVideoElement, stream: MediaStream): Promise<void> {
    const readyState = typeof el.readyState === "number" ? el.readyState : 0;
    if (el.srcObject !== stream || readyState >= ViewerSession.HAVE_CURRENT_DATA) {
      return Promise.resolve();
    }

    if (typeof el.addEventListener !== "function" || typeof el.removeEventListener !== "function") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const finish = (): void => {
        cleanup();
        resolve();
      };

      const cleanup = (): void => {
        if (timeout !== null) {
          clearTimeout(timeout);
          timeout = null;
        }
        el.removeEventListener("canplay", finish);
        el.removeEventListener("loadedmetadata", finish);
      };

      timeout = setTimeout(finish, ViewerSession.PLAY_RETRY_READY_TIMEOUT_MS);
      el.addEventListener("canplay", finish, { once: true });
      el.addEventListener("loadedmetadata", finish, { once: true });
    });
  }

  /**
   * Tell the host which media types to enable. When audioEnabled=false the
   * host stops sending audio; when videoEnabled=false the host stops sending
   * video. This saves bandwidth by disabling the RTCRtpSender encoding.
   *
   * Safe to call when not watching (no-op).
   */
  setMediaMode(audioEnabled: boolean, videoEnabled: boolean): void {
    if (this._destructed) return;
    if (!this.isCurrent()) return;
    if (!this.groupId || !this.hostDeviceId || !this.logicalStreamId) return;

    this._mediaMode = { audioEnabled, videoEnabled };

    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return;

    const conn = runtime.getConnectionManager().getConnection(this.groupId);
    if (!conn) return;

    const peerUuid = conn.peerForDevice(this.hostDeviceId);
    if (!peerUuid) return;

    void conn.sendToPeer(peerUuid, {
      type: "viewer.media.request",
      logicalStreamId: this.logicalStreamId,
      viewerDeviceId: runtime.deviceId ?? "viewer",
      ...(this._viewerSessionId ? { viewerSessionId: this._viewerSessionId } : {}),
      audioEnabled,
      videoEnabled,
    }).catch(() => {});
  }

  /**
   * Retry the full join flow. Resets state and runs start() again
   * with the same session parameters. The teardown runs asynchronously;
   * the new attempt awaits it before creating a new ViewerClient.
   */
  async retry(): Promise<void> {
    if (this._destructed) return;

    // Run the same non-final cleanup path that stop() uses, but in
    // the background — retry() itself is a public API the UI awaits,
    // so we await the teardown first and then start a fresh join flow.
    await this.beginTeardown({ final: false });

    this._receivedStream = null;
    this._trackIdsInStream.clear();
    this.leaveAnnounced = false;
    this._viewerReadySent = false;
    this._viewerSessionId = generateViewerSessionId();

    // Actively request a group sync before refreshing local state.
    // This pings all connected peers for the latest group and stream state,
    // ensuring the registry has up-to-date announcements before we decide
    // which logical/media session to target on retry.
    const runtime = getRuntime();
    if (runtime && !runtime.isDestroyed()) {
      try {
        const syncResult = runtime.requestGroupSync(this.groupId);
        // Best-effort: await if it returned a promise (in-flight or fresh)
        if (syncResult && typeof (syncResult as Promise<void>).then === "function") {
          await (syncResult as Promise<void>);
        }
      } catch {
        // Non-fatal — proceed with whatever state we have
      }
    }

    // Refresh active stream state from registry before sending a new join request.
    // The host may have restarted with a new logical/media session while the viewer
    // was disconnected — using stale IDs would cause the host to reject or the viewer
    // to join a defunct stream.
    this.refreshStreamStateFromRegistry();

    // Bump generation so in-flight flows from prior retry on this instance are abandoned
    this._nextGeneration++;
    this._generation = this._nextGeneration;

    await this.runJoinFlow();
  }

  /**
   * Refresh logicalStreamId and mediaSessionId from the latest stream announcement
   * in the active stream registry. This prevents retry from using stale stream IDs
   * after the host restarts with a new publication.
   *
   * Selection order:
   *   1. Filter to announcements from our target host
   *   2. Sort by streamRevision (desc), then startedAt (desc), then heartbeatSequence (desc)
   *   3. If the same logicalStreamId is found with a newer mediaSessionId, prefer that
   *   4. If the old logical stream is gone and the host has a newer active stream,
   *      update BOTH logicalStreamId and mediaSessionId
   */
  private refreshStreamStateFromRegistry(): void {
    try {
      const runtime = getRuntime();
      if (!runtime || runtime.isDestroyed()) return;
      const registry = runtime.getActiveStreamRegistry();
      const streams = registry.getStreamsByGroup(this.groupId);

      // Filter to announcements from our target host
      const hostStreams = streams.filter((s) => s.hostDeviceId === this.hostDeviceId);
      if (hostStreams.length === 0) return;

      // Sort by composite freshness: streamRevision (primary), startedAt (secondary),
      // heartbeatSequence (tertiary) — all descending so index 0 is the latest.
      const sorted = [...hostStreams].sort((a, b) => {
        const revDiff = (b.streamRevision ?? 0) - (a.streamRevision ?? 0);
        if (revDiff !== 0) return revDiff;
        const startDiff = (b.startedAt ?? 0) - (a.startedAt ?? 0);
        if (startDiff !== 0) return startDiff;
        return (b.heartbeatSequence ?? 0) - (a.heartbeatSequence ?? 0);
      });

      const latest = sorted[0];

      // Phase 1: Check if the same logicalStreamId still exists with a newer mediaSessionId
      const sameLogical = sorted.find((s) => s.logicalStreamId === this.logicalStreamId);
      if (sameLogical) {
        // If the mediaSessionId changed, pick the newer one
        if (sameLogical.mediaSessionId !== this.mediaSessionId) {
          this.mediaSessionId = sameLogical.mediaSessionId;
        }
        // logicalStreamId stays the same (it matched)
        return;
      }

      // Phase 2: The old logical stream is gone. Update both IDs to the latest
      // active stream from this host.
      this.logicalStreamId = latest.logicalStreamId;
      this.mediaSessionId = latest.mediaSessionId;
    } catch {
      // Registry refresh is best-effort; proceed with existing values
    }
  }

  /**
   * Stop watching and clean up. Idempotent and non-blocking — the
   * actual teardown runs asynchronously so concurrent calls (and
   * triggers from React effect cleanup) all see the same shared
   * teardown promise.
   */
  stop(): void {
    if (this._state === "ended") return;
    // Fire-and-forget — the state transition is synchronous, the SDK
    // teardown is async. Repeated calls collapse onto the same
    // _teardownPromise.
    this.clearPosterFrame(); // Clear any paused poster
    void this.beginTeardown({ final: false });
    this.setState("ended");
  }

  /**
   * Final cleanup. The session cannot be restarted after this.
   * Idempotent. Returns a promise that resolves when the full
   * teardown sequence (sendLeave, ViewerClient.shutdown, video
   * element cleanup) has completed.
   *
   * Callers MUST await this before starting a new session, or
   * the old session's async teardown can race the new session
   * and blank the shared <video> element's srcObject after the
   * new stream has been attached.
   */
  async destroy(): Promise<void> {
    if (this._destructed) {
      // Already destroyed — await any in-flight teardown so callers
      // that hold a stale reference (e.g. effect cleanup) can await
      // completion without re-entering.
      await (this._teardownPromise ?? Promise.resolve());
      return;
    }
    this.setState("ended");
    this._destructed = true;
    this.clearPosterFrame();
    await this.beginTeardown({ final: true });
  }

  /**
   * Begin a teardown, sharing the same promise across repeated calls.
   *
   * IMPORTANT: When a prior non-final teardown (from stop()/setError())
   * is still in flight and a subsequent call requests final=true, this
   * method does NOT restart the teardown — it awaits the existing
   * promise. The non-final path omits the final cleanup steps (clearing
   * callbacks, nulling videoElement). For the Exit → Watch race (the
   * primary caller of this fix), destroy() is always called first, so
   * _teardownPromise is null when final=true is requested. The existing-
   * promise edge case is handled via the _destructed guard in destroy().
   *
   * @param options.final  when true, marks the session as fully
   *   destroyed (no further start()) and clears event handlers. When
   *   false (retry/stop), the session remains restartable.
   */
  private beginTeardown(options: { final: boolean }): Promise<void> {
    if (this._teardownPromise) return this._teardownPromise;

    this._tearingDown = true;

    const promise = (async () => {
      try {
        if (options.final) this._destructed = true;

		// Invalidate any in-flight join flow on this instance BEFORE we touch the
		// ViewerClient — otherwise runJoinFlow() could resume after
		// teardown and try to use a destroyed client.
		this._nextGeneration++;

        // 1) Send the leave message FIRST, while the group-control
        //    channel is still healthy. Await delivery so the host
        //    receives a clean leave before the VDO connection drops.
        await this.sendLeave();

        // 2) Cancel waiters and timers so any pending operation bails.
        this.cancelReadinessTimer();
        this.clearStatusInterval();
        this.cancelPendingJoin();
        this.cancelPendingPauseResult();
        this.cancelRemoteTrackEndedTimer();
        this.cancelSelfViewRetryTimer();

        // 3) Remove self-view track-end listener before clearing stream
        if (this.selfViewEndedHandler) {
          if (this._receivedStream) {
            const track = this._receivedStream.getVideoTracks()[0];
            if (track) {
              try { track.removeEventListener("ended", this.selfViewEndedHandler); } catch { /* ignore */ }
            }
          }
          this.selfViewEndedHandler = null;
        }

        // 4) Shut down the ViewerClient SEQUENTIALLY. The single
        //    shutdown() method awaits stopViewing(streamId) before
        //    disconnect(), so the SDK's _intentionalDisconnect flag
        //    stays set across both calls and auto-reconnect cannot
        //    fire in the gap. The previous implementation fired both
        //    calls concurrently and never awaited them, which is the
        //    root cause of stale SDK connections blocking rejoin.
        if (this.viewerClient) {
          try {
            await this.viewerClient.shutdown();
          } catch {
            // Best effort — proceed to state cleanup.
          }
          this.viewerClient = null;
        }

        // 5) Clear video element after the underlying stream is gone.
        //    This is the critical point where the old session's teardown
        //    would blank the shared <video> DOM element. Because
        //    destroy() now awaits this method, the new Watch session
        //    cannot start until this completes.
        //    IMPORTANT: only clear the element if this session still
        //    owns its stream — a newer session may have attached a
        //    different stream to the same element.
        if (this.videoElement) {
          if (this.videoElement.srcObject === this._receivedStream) {
            try {
              this.videoElement.pause();
              this.videoElement.srcObject = null;
            } catch { /* ignore */ }
          }
          if (options.final) {
            this.videoElement = null;
          }
        }

        this._receivedStream = null;
        this._playPromise = null;
        this._trackIdsInStream.clear();

		// 6) Clear pause state so any in-flight pause/resume observers
		//    see a clean slate. Increment generation to cancel stale ops on this instance.
		this._nextPauseGeneration++;
        this._pauseState = "playing";
        this.clearPosterFrame();
        this._bindToken = null;
        this._bindMediaSessionId = null;
        this._mediaMode = { audioEnabled: true, videoEnabled: true };

        if (options.final) {
          this._state = "ended";
          this.onStateChange = null;
          this.onStreamReceived = null;
          this.onError = null;
          this.onPauseStateChange = null;
          this.onPosterFrameChange = null;
        }
      } finally {
        this._tearingDown = false;
        // Clear the promise so a future start() / retry() / destroy()
        // can begin a new teardown. The reference is dropped only
        // after the current teardown fully settles.
        this._teardownPromise = null;
      }
    })();

    this._teardownPromise = promise;
    return promise;
  }

  // ── Diagnostics access ───────────────────────────────────────────

  /**
   * Get the raw RTCPeerConnection for metrics registration. Returns null if no active media connection.
   */
  getPeerConnection(): RTCPeerConnection | null {
    if (!this.viewerClient || this._destructed) return null;
    const sdk = this.viewerClient.getSDK();
    if (!sdk) return null;
    const entries = Array.from(sdk.connections.entries());
    if (entries.length === 0) return null;
    const [, group] = entries[0];
    return group.viewer?.pc ?? group.publisher?.pc ?? null;
  }

  /**
   * Expose the underlying ViewerClient for low-level SDK access.
   * Returns null if no client is active or session is destroyed.
   */
  getViewerClient(): ViewerClient | null {
    return this.viewerClient;
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

      // 2) Register response waiter BEFORE sending the request to avoid a
      //    race where the response arrives before the waiter is registered.
      this.setState("requesting-join");
      const requestId = crypto.randomUUID();
      this._pendingRequestId = requestId;
      const joinResponsePromise = runtime.waitForJoinResponse(requestId, 30_000).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Join response cancelled") {
          return null;
        }
        throw error;
      });

      // 3) Send stream.join.request — carries the per-attempt session
      //    ID so the host can disambiguate attempts and ignore stale
      //    leaves from prior attempts. In compare mode, also carries
      //    the variant ID and exact media session ID so the host issues
      //    the correct credentials.
      //    IMPORTANT: never include undefined property values — the
      //    envelope HMAC is computed over canonical JSON which matches
      //    JSON.stringify by omitting undefined keys. An undefined value
      //    serialized in the HMAC but stripped by transport breaks signing.
      await conn.sendToPeer(peerUuid, {
        type: "stream.join.request",
        logicalStreamId: this.logicalStreamId,
        mediaSessionId: this.mediaSessionId,
        viewerDeviceId: runtime.deviceId ?? "viewer",
        viewerDisplayName: runtime.displayName ?? "Viewer",
        requestId,
        ...(this._viewerSessionId ? { viewerSessionId: this._viewerSessionId } : {}),
      });

      // GENERATION CHECK
      if (!this.isCurrent()) return;

      // 4) Wait for stream.join.response
      this.setState("waiting-for-host");
      const response = await joinResponsePromise;
      if (!response) return;

      // Clear pending request id since the waiter resolved
      this._pendingRequestId = null;

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

        this.onStreamReceived?.(this._receivedStream);

        // Only transition to watching when a live video track is received.
        // Also attach the stream to the video element only when a video
        // track arrives — audio-only tracks should not trigger attachment
        // (the grey-screen fix).
        if (isVideo) {
          if (this.videoElement && this._receivedStream) {
            this.attachStreamToElement(this.videoElement, this._receivedStream);
          }

          this.cancelReadinessTimer();
          this.setState("watching");
          this.startStatusInterval();

          // If we were resuming from pause, the poster frame is now stale —
          // clear it so the live video shows through.
          if (this._pausePoster !== null) {
            this.clearPosterFrame();
          }
        }
      };

      // Primary: SDK 1.3.18 trackAdded (real Alice/Bob watch path)
      events.on("trackAdded", handleTrackEvent);
      // Backward compat: older event shape
      events.on("track", handleTrackEvent);

      // Monitor remote track ended events (host stopped sharing)
      // Use 2s debounce to avoid mistaking brief interruptions for intentional stops
      // Uses instance field _remoteTrackEndedTimer for proper cleanup.
      // SKIP entirely when paused: the pause explicitly stops the media connection,
      // which will fire track-ended on the already-attached tracks. We do NOT want
      // to interpret that as the host ending the share.
      const handleRemoteTrackEnded = (): void => {
        if (!this.isCurrent()) return;
        // Do not trigger auto-stop while the user has intentionally paused
        if (this._pauseState === "paused" || this._pauseState === "pausing") return;

        if (this._remoteTrackEndedTimer) clearTimeout(this._remoteTrackEndedTimer);
        this._remoteTrackEndedTimer = setTimeout(() => {
          this._remoteTrackEndedTimer = null;
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
      // and bounded retry internally. The viewerSessionId is carried in
      // the payload so the host can correlate the bind with the join
      // request and store it in the viewer mapping.
      // Save bind parameters for potential re-send after resume.
      this._bindToken = joinToken;
      this._bindMediaSessionId = responseMediaSessionId;
      const sdk = viewerClient.getSDK();
      if (sdk && joinToken) {
        for (const [publisherUuid] of sdk.connections) {
          try {
            await viewerClient.sendMediaBind(
              publisherUuid,
              joinToken,
              responseMediaSessionId,
              this._viewerSessionId ?? undefined,
            );
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
      // Clear pending request id on any error so the promise is not leaked
      this._pendingRequestId = null;
      const message = err instanceof Error ? err.message : String(err);

      // One automatic retry on SDK connect failures.  The first attempt can
      // hit transient delays on slower connections (TLS handshake, WebSocket
      // setup, SDK reconnect backoff).  Rather than showing a fatal page, we
      // tear down cleanly and try once more.
      if (!this._autoRetried && this.isConnectFailure(err)) {
        this._autoRetried = true;
        console.log("[ViewerSession] Connect failed, auto-retrying once after full teardown...");

        // Fully await teardown before the retry so the old SDK instance is
        // completely gone and the new attempt starts from a clean slate.
        try {
          await this.beginTeardown({ final: false });
        } catch {
          // Teardown is best-effort; proceed with retry regardless.
        }

        this._receivedStream = null;
        this._playPromise = null;
        this._trackIdsInStream.clear();
        this.leaveAnnounced = false;
        this._viewerSessionId = generateViewerSessionId();

        // Refresh stream state from registry in case the host changed
        // anything while the failed attempt was in flight.
        this.refreshStreamStateFromRegistry();

        // Bump generation so any stale in-flight flow from the prior attempt
        // is abandoned.
        this._nextGeneration++;
        this._generation = this._nextGeneration;

        await this.runJoinFlow();
        return;
      }

      this.setError(message);
    }
  }

  /**
   * Detect whether an error represents a connect failure that warrants an
   * automatic retry.  Matches errors from ViewerClient.connectWithTimeout()
   * and any bare "Reconnect failed" from the SDK.
   */
  private isConnectFailure(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return (
      err.message.includes("SDK connect timed out") ||
      err.message.includes("WebSocket to the signaling server") ||
      err.message.includes("Reconnect failed")
    );
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

  private cancelSelfViewRetryTimer(): void {
    if (this._selfViewRetryTimer) {
      clearTimeout(this._selfViewRetryTimer);
      this._selfViewRetryTimer = null;
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
      console.warn("[ViewerSession] self-view: no capture stream available yet");
      // Stay in "connecting" — do NOT transition to error or begin teardown.
      // The publishing stream is unaffected; the preview will retry.
      if (this._selfViewRetryCount < ViewerSession.SELF_VIEW_MAX_RETRIES) {
        this._selfViewRetryCount++;
        this.onError?.(`No local capture stream. Retrying (${this._selfViewRetryCount}/${ViewerSession.SELF_VIEW_MAX_RETRIES})...`);
        this._selfViewRetryTimer = setTimeout(() => {
          this._selfViewRetryTimer = null;
          void this.startSelfView(runtime);
        }, ViewerSession.SELF_VIEW_RETRY_DELAY_MS);
      } else {
        this.onError?.("No local capture stream available. Click Preview to try again.");
        // Stay in "connecting" — the user can retry manually via the UI button
      }
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
    this.startStatusInterval();

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

  /**
   * Expose the active watch-target identifiers for use by the quality
   * request dispatcher. Returns null before start() has been called or
   * after destroy().
   *
   * This is the fallback path when the store's `watchingTarget` is
   * temporarily null (e.g. during stream-end transitions).
   */
  getTargetInfo(): {
    groupId: string;
    hostDeviceId: string;
    logicalStreamId: string;
    mediaSessionId: string;
    hostName: string;
  } | null {
    if (!this.groupId || !this.hostDeviceId || !this.logicalStreamId) return null;
    return {
      groupId: this.groupId,
      hostDeviceId: this.hostDeviceId,
      logicalStreamId: this.logicalStreamId,
      mediaSessionId: this.mediaSessionId,
      hostName: this.hostName,
    };
  }

  /** Guards one-shot viewer.ready send per watch attempt */
  private _viewerReadySent = false;

  /**
   * Send a `stream.viewer.ready` acknowledgement to the host exactly once
   * per watch attempt. The caller (readiness controller) is responsible for
   * calling this only after the first visible frame is presented.
   *
   * Guards:
   * - Stale session: checks the current generation so abandoned flows are ignored.
   * - One-shot: `_viewerReadySent` prevents duplicate sends.
   * - Identity: the payload carries the current watch-attempt identifiers
   *   (logicalStreamId, mediaSessionId, viewerSessionId) so the host can
   *   correlate and ignore messages from stale attempts.
   *
   * Returns true if the message was sent, false if it was suppressed.
   */
  sendViewerReady(presentation: "native-video" | "webgl" | "nvidia" | "fallback"): boolean {
    if (!this.isCurrent()) return false;
    if (this._viewerReadySent) return false;
    if (!this.groupId || !this.hostDeviceId || !this._viewerSessionId) return false;

    this._viewerReadySent = true;

    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return false;

    const conn = runtime.getConnectionManager().getConnection(this.groupId);
    if (!conn) return false;

    const peerUuid = conn.peerForDevice(this.hostDeviceId);
    if (!peerUuid) return false;

    void conn.sendToPeer(peerUuid, {
      type: "stream.viewer.ready",
      groupId: this.groupId,
      logicalStreamId: this.logicalStreamId,
      mediaSessionId: this.mediaSessionId,
      viewerSessionId: this._viewerSessionId,
      viewerNodeId: runtime.deviceId ?? "viewer",
      viewerDeviceId: runtime.deviceId ?? "viewer",
      readyAt: Date.now(),
      presentation,
    }).catch(() => {});

    return true;
  }

  /** Reset the viewer ready flag (called on retry/restart) */
  private resetViewerReady(): void {
    this._viewerReadySent = false;
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private setState(state: ViewerSessionState): void {
    if (this._destructed) return;
    this._state = state;
    this.onStateChange?.(state);
  }

  private setError(error: string): void {
    if (this._destructed) return;
    this.clearStatusInterval();
    this.cancelReadinessTimer();
    this._state = "error";
    this.onStateChange?.("error");
    this.onError?.(error);
    // Trigger the same shared teardown path as stop() — but final=true
    // is not appropriate here because the user may want to retry().
    void this.beginTeardown({ final: false });
  }

  /**
   * Build and send a viewer.status report over the group-control channel.
   * Reports current viewer state, received media stats, and the sampled timestamp.
   * When stateOverride is provided, skips diagnostics polling (used for pause/resume).
   * Fire-and-forget — the host uses this for the viewer diagnostics list.
   */
  private async buildAndSendViewerStatus(stateOverride?: "paused" | "reconnecting"): Promise<void> {
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return;
    if (!this.groupId || !this.hostDeviceId || !this.logicalStreamId) return;

    const conn = runtime.getConnectionManager().getConnection(this.groupId);
    if (!conn) return;

    const peerUuid = conn.peerForDevice(this.hostDeviceId);
    if (!peerUuid) return;

    const state = stateOverride ?? (
      this._pauseState === "paused" || this._pauseState === "pausing" ? "paused" :
      this._pauseState === "resuming" ? "reconnecting" :
      "playing"
    );

    let receivedBitrateKbps: number | null = null;
    let receivedWidth: number | null = null;
    let receivedHeight: number | null = null;
    let displayedFps: number | null = null;

    // Read from authoritative telemetry snapshot instead of a second getStats() pipeline.
    // StreamMetricsService polls getStats() every 1 second with proper baseline tracking,
    // bitrate computation, and codec resolution.  This avoids the bugs of the removed
    // getDiagnostics() method (bitrate always zero, raw codecId, multi-stream overwrite,
    // audio bytes always zero).
    if (state !== "paused") {
      try {
        const svc = StreamMetricsService.getInstance();
        const historyId = svc.findHistoryIdByMediaSessionId(this.mediaSessionId);
        if (historyId) {
          const snapshot = svc.getSnapshot(historyId);
          const connSnap = snapshot.connections[0];
          if (connSnap) {
            const latest = connSnap.rawSamples[connSnap.rawSamples.length - 1];
            if (latest) {
              const totalBps = (latest.videoBitsPerSecond ?? 0) + (latest.audioBitsPerSecond ?? 0);
              receivedBitrateKbps = totalBps > 0 ? Math.round(totalBps / 1000) : null;
              receivedWidth = latest.width;
              receivedHeight = latest.height;
              displayedFps = latest.framesPerSecond;
            }
          }
        }
      } catch { /* best effort — status still sends with null metrics */ }
    }

    void conn.sendToPeer(peerUuid, {
      type: "viewer.status",
      viewerDeviceId: runtime.deviceId ?? "viewer",
      streamId: this.logicalStreamId,
      state,
      ...(runtime.displayName ? { viewerDisplayName: runtime.displayName } : {}),
      receivedBitrateKbps,
      receivedWidth,
      receivedHeight,
      displayedFps,
      sampledAt: Date.now(),
    }).catch(() => {});
  }

  private startStatusInterval(): void {
    this.clearStatusInterval();
    this._statusInterval = setInterval(() => {
      if (!this.isCurrent()) {
        this.clearStatusInterval();
        return;
      }
      if (this._statusReportInFlight) return;
      this._statusReportInFlight = true;
      void this.buildAndSendViewerStatus().finally(() => {
        this._statusReportInFlight = false;
      });
    }, 2000);
    // Send an immediate first report
    void this.buildAndSendViewerStatus();
  }

  private clearStatusInterval(): void {
    if (this._statusInterval) {
      clearInterval(this._statusInterval);
      this._statusInterval = null;
    }
  }

  /**
   * Send a stream.leave message over the group-control channel and await
   * delivery.  The caller (beginTeardown) awaits this before proceeding
   * to ViewerClient.shutdown() so the host receives the leave before the
   * VDO connection drops.
   *
   * Includes the per-attempt session ID so the host can ignore a late
   * leave from a prior Watch attempt that no longer matches the active
   * mapping.
   */
  private async sendLeave(): Promise<void> {
    if (this.leaveAnnounced) return;
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return;
    if (!this.groupId || !this.hostDeviceId || !this.logicalStreamId) return;

    const conn = runtime.getConnectionManager().getConnection(this.groupId);
    if (!conn) return;

    const peerUuid = conn.peerForDevice(this.hostDeviceId);
    if (!peerUuid) return;

    this.leaveAnnounced = true;
    try {
      await conn.sendToPeer(peerUuid, {
        type: "stream.leave",
        logicalStreamId: this.logicalStreamId,
        mediaSessionId: this.mediaSessionId,
        viewerDeviceId: runtime.deviceId ?? "viewer",
        ...(this._viewerSessionId ? { viewerSessionId: this._viewerSessionId } : {}),
      });
    } catch {
      // Best-effort — the host also reacts to peerDisconnected on VDO.
    }
  }

  /**
   * Cancel any pending join response waiter so the abandoned promise is
   * rejected cleanly rather than left dangling until timeout.
   */
  private cancelPendingJoin(): void {
    if (this._pendingRequestId) {
      const runtime = getRuntime();
      if (runtime && !runtime.isDestroyed()) {
        runtime.cancelJoinResponse(this._pendingRequestId);
      }
      this._pendingRequestId = null;
    }
  }

  /**
   * Cancel any pending pause result waiter so the abandoned promise is
   * rejected cleanly rather than left dangling until timeout.
   */
  private cancelPendingPauseResult(): void {
    if (this._pendingPauseOperationId) {
      const runtime = getRuntime();
      if (runtime && !runtime.isDestroyed()) {
        runtime.cancelViewerPauseResult(this._pendingPauseOperationId);
      }
      this._pendingPauseOperationId = null;
    }
  }

  /**
   * Cancel the remote-track-ended debounce timer.
   */
  private cancelRemoteTrackEndedTimer(): void {
    if (this._remoteTrackEndedTimer) {
      clearTimeout(this._remoteTrackEndedTimer);
      this._remoteTrackEndedTimer = null;
    }
  }
}

/**
 * Generate a fresh per-attempt viewer session ID.
 *
 * Uses crypto.randomUUID() where available (Electron / modern browsers),
 * with a defensive fallback that combines the device ID, a high-resolution
 * timestamp, and a counter for older environments.
 */
function generateViewerSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  // Fallback: timestamp + device + random suffix. Not cryptographically
  // strong, but unique enough for the host's per-attempt matching.
  return `vsid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
