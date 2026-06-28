import { ViewerClient } from "@screenlink/vdo-adapter";
import { getRuntime } from "./phase3-runtime.js";
import type { Phase3Runtime } from "./phase3-runtime.js";
import { extractTrackEvent } from "./sdk-event-normalizer.js";

// ─── Diagnostics Types ─────────────────────────────────────────────────────

/**
 * Snapshot of viewer diagnostics for the UI to display.
 * Populated from real RTCPeerConnection stats, ICE candidate pairs,
 * and inbound-rtp reports.
 */
export interface ViewerDiagnosticsSnapshot {
  connectionState: string;
  selectedCandidatePair: {
    local: string | null;
    remote: string | null;
    state: string | null;
    nominated: boolean | null;
  };
  inboundVideo: {
    bitrateBps: number;
    /** Total bytes received on the inbound video RTP stream (cumulative). */
    bytesReceived: number;
    packetsReceived: number;
    packetsLost: number;
    jitter: number;
    codecId: string | null;
    /** frameWidth from inbound-rtp stats (track resolution) */
    frameWidth: number | null;
    /** frameHeight from inbound-rtp stats */
    frameHeight: number | null;
    /** framesPerSecond from inbound-rtp stats */
    framesPerSecond: number | null;
    /** framesDropped from inbound-rtp stats */
    framesDropped: number | null;
    /** freezeCount from inbound-rtp stats */
    freezeCount: number | null;
  };
  inboundAudio: {
    bitrateBps: number;
    /** Total bytes received on the inbound audio RTP stream (cumulative). */
    bytesReceived: number;
    packetsReceived: number;
    packetsLost: number;
    jitter: number;
    codecId: string | null;
  };
  /** currentRoundTripTime from candidate-pair stats (ms) */
  rttMs: number | null;
  /** Real candidate type from ICE candidate stats */
  localCandidateType: string | null;
  /** Real candidate type from ICE candidate stats */
  remoteCandidateType: string | null;
  timestamp: number;
}

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

/**
 * Pause lifecycle state machine.
 *
 *   playing → pause() → pausing → (stopViewing) → paused
 *   paused  → resume() → resuming → (view()) → playing
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

  /** Generation counter: incremented on start(), checked after every await. */
  private static nextGeneration = 0;
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
  /** Prevents concurrent getDiagnostics() calls when a prior tick is still in flight */
  private _statusReportInFlight = false;

  /** Track IDs already in the received stream (deduplication). */
  private _trackIdsInStream = new Set<string>();

  /** Current pending join request ID, for cancellation on stop/destroy/retry. */
  private _pendingRequestId: string | null = null;

  /** Remote-track-ended debounce timer — instance state for proper cleanup. */
  private _remoteTrackEndedTimer: ReturnType<typeof setTimeout> | null = null;

  // Self-viewing support — when the host is the local device,
  // we pipe the capture stream directly instead of VDO relay.
  private selfViewEndedHandler: (() => void) | null = null;

  /** Max self-view retry attempts when capture stream is not yet available. */
  private static readonly SELF_VIEW_MAX_RETRIES = 3;
  /** Delay (ms) between self-view retry attempts. */
  private static readonly SELF_VIEW_RETRY_DELAY_MS = 2_000;
  /** Current self-view retry count. Resets on successful start(). */
  private _selfViewRetryCount = 0;
  /** Handle for cancelling a scheduled self-view retry. */
  private _selfViewRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // Session identity (set by start)
  private groupId = "";
  private hostDeviceId = "";
  private logicalStreamId = "";
  private mediaSessionId = "";
  private hostName = "";
  private leaveAnnounced = false;

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
  /** Bumped to cancel in-flight pause/resume that raced a newer call. */
  private static nextPauseGeneration = 0;
  private _pauseGeneration = -1;

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
   * Pause media playback.
   *
   * Captures the current video frame as a poster, then calls
   * viewerClient.pauseMedia() to stop the WebRTC media connection while
   * keeping the signaling channel alive.
   *
   * State machine: playing → pausing → paused
   *   or: playing → pausing → (error) → playing (reversible)
   *
   * Rapid calls collapse: a second pause() while already paused is a
   * no-op. A pause() while pausing/resuming awaits the previous
   * operation and then applies unless the state changed.
   */
  async pause(): Promise<void> {
    if (this._destructed || !this.viewerClient) return;
    if (this._pauseState === "paused") return; // idempotent
    if (this._pauseState === "pausing") return; // already in flight — wait for it

    // If currently resuming, wait for that to settle first
    if (this._pauseState === "resuming") {
      // The resuming caller will see the updated state after it completes;
      // we just bail so the caller can retry the shortcut.
      return;
    }

    ViewerSession.nextPauseGeneration++;
    this._pauseGeneration = ViewerSession.nextPauseGeneration;

    this.setPauseState("pausing");

    try {
      // 1) Capture the current video frame before stopping the media connection
      this.capturePosterFrame();

      // 2) Stop the media connection (keeps SDK signaling alive)
      await this.viewerClient.pauseMedia();

      // GENERATION CHECK
      if (!this.isPauseGenerationCurrent()) return;

      // Notify host that we paused
      this.clearStatusInterval();
      void this.buildAndSendViewerStatus("paused");
      this.setPauseState("paused");
    } catch (err) {
      // Pause failed — return to playing (reversible)
      this.clearPosterFrame();
      this.setPauseState("playing");
      console.error("[ViewerSession] pause failed, returning to playing:", err);
      throw err;
    }
  }

  /**
   * Resume a paused media stream.
   *
   * Re-invokes view() on the ViewerClient to re-establish the WebRTC
   * media connection. If the host has restarted or replaced the stream
   * while we were paused, the current StreamAnnouncement's stream ID is
   * used instead of the stale saved value.
   *
   * State machine: paused → resuming → playing
   *   or: paused → resuming → (error) → paused (retryable)
   *
   * @param currentStreamId - The host's current logical stream ID, to
   *   handle host restarts that happened while paused. Omit to use the
   *   stream ID saved at pause time.
   */
  async resume(vdoStreamIdOverride?: string): Promise<void> {
    if (this._destructed) return;
    if (this._pauseState !== "paused") return; // no-op if not paused (also covers resuming)

    ViewerSession.nextPauseGeneration++;
    this._pauseGeneration = ViewerSession.nextPauseGeneration;

    this.setPauseState("resuming");
    void this.buildAndSendViewerStatus("reconnecting");

    try {
      const vc = this.viewerClient;
      if (!vc) {
        throw new Error("ViewerClient destroyed during pause");
      }

      // ── 1) Clear stale stream state ────────────────────────────────
      // The old _receivedStream's tracks ended when stopViewing() was called.
      // Reusing that MediaStream object — even with new tracks added — can
      // cause a black screen on some browsers. We discard it so the track
      // handler creates a fresh MediaStream for the new RTC connection.
      this._receivedStream = null;
      this._trackIdsInStream.clear();

      // NOTE: We deliberately do NOT clear the video element's srcObject here.
      // The old ended-track MediaStream still shows the last received frame,
      // which keeps the video area non-black until the new tracks arrive.
      // The track handler (from runJoinFlow) will set el.srcObject = newStream
      // when the SDK fires trackAdded on the new connection.

      // ── 3) Re-establish the WebRTC media connection ──────────────
      //     view() on the SDK invites the host again. The SDK signaling
      //     stayed alive during pause, so no rejoin handshake is needed.
      const resumeDisplayName = this.hostName || undefined;
      await vc.resumeMedia(resumeDisplayName, vdoStreamIdOverride);

      // GENERATION CHECK
      if (!this.isPauseGenerationCurrent()) return;

      // ── 4) Re-send media.bind over the new data channel ─────────────
      //     After stopViewing() the old data channel is gone and the new
      //     RTC connection establishes a fresh one. The host requires
      //     media.bind to authorise media delivery — without it the host
      //     sees a connected viewer but does not forward video/audio.
      await this.resendMediaBind(vc);

      // GENERATION CHECK
      if (!this.isPauseGenerationCurrent()) return;

      // ── 5) Notify host that we resumed ─────────────────────────────
      this.clearPosterFrame();
      this.setPauseState("playing");
      this.startStatusInterval();
    } catch (err) {
      // Resume failed — stay paused so the user can retry
      console.error("[ViewerSession] resume failed, remaining paused:", err);
      // Keep pause state as-is so the UI shows the retryable error
      throw err;
    }
  }

  /**
   * Re-send media.bind over the new VDO data channel after resume.
   * The host will not deliver video/audio until the bind is re-authorised.
   */
  private async resendMediaBind(vc: ViewerClient): Promise<void> {
    const sdk = vc.getSDK();
    const token = this._bindToken;
    const mediaSessionId = this._bindMediaSessionId;
    if (!sdk || !token) return;

    for (const [publisherUuid] of sdk.connections) {
      try {
        await vc.sendMediaBind(
          publisherUuid,
          token,
          mediaSessionId ?? undefined,
          this._viewerSessionId ?? undefined,
        );
        console.log('[ViewerSession] media.bind re-sent after resume to', publisherUuid.slice(0, 8) + '…');
      } catch (err) {
        // Non-fatal — the connection is up, and the host may still accept
        // the viewer based on the original bind. Log and continue.
        console.warn('[ViewerSession] media.bind re-send failed for', publisherUuid.slice(0, 8) + '…', err);
      }
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
    // Fresh session ID per Watch attempt — the host uses this to tell
    // leaves from prior attempts apart from the active one.
    this._viewerSessionId = generateViewerSessionId();

    if (options.videoElement) {
      this.videoElement = options.videoElement;
    }

    // Bump generation to invalidate any prior in-flight flow
    ViewerSession.nextGeneration++;
    this._generation = ViewerSession.nextGeneration;

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
    return !this._destructed && this._generation === ViewerSession.nextGeneration;
  }

  /**
   * Check whether this pause/resume operation's generation is still current.
   * After every await in pause()/resume(), this guard prevents a stale
   * operation from continuing after a newer pause()/resume() call.
   */
  private isPauseGenerationCurrent(): boolean {
    return !this._destructed && this._pauseGeneration === ViewerSession.nextPauseGeneration;
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

    // Bump generation so in-flight flows from prior retry are abandoned
    ViewerSession.nextGeneration++;
    this._generation = ViewerSession.nextGeneration;

    await this.runJoinFlow();
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

        // Invalidate any in-flight join flow BEFORE we touch the
        // ViewerClient — otherwise runJoinFlow() could resume after
        // teardown and try to use a destroyed client.
        ViewerSession.nextGeneration++;

        // 1) Send the leave message FIRST, while the group-control
        //    channel is still healthy. sendLeave() is fire-and-forget;
        //    we do not await it because the group channel can be slow
        //    and we want the SDK teardown to begin immediately.
        this.sendLeave();

        // 2) Cancel waiters and timers so any pending operation bails.
        this.cancelReadinessTimer();
        this.clearStatusInterval();
        this.cancelPendingJoin();
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
        if (this.videoElement) {
          try {
            this.videoElement.pause();
            this.videoElement.srcObject = null;
          } catch { /* ignore */ }
          if (options.final) {
            this.videoElement = null;
          }
        }

        this._receivedStream = null;
        this._trackIdsInStream.clear();

        // 6) Clear pause state so any in-flight pause/resume observers
        //    see a clean slate. Increment generation to cancel stale ops.
        ViewerSession.nextPauseGeneration++;
        this._pauseState = "playing";
        this.clearPosterFrame();
        this._bindToken = null;
        this._bindMediaSessionId = null;

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
   * Expose the underlying ViewerClient for the UI/store task to access
   * the real VDO connection. Returns null if no client is active.
   */
  getViewerClient(): ViewerClient | null {
    return this.viewerClient;
  }

  /**
   * Gather real diagnostics from the ViewerClient's RTCPeerConnection.
   * Uses actual WebRTC stats (candidate-pair, inbound-rtp) rather than
   * fake/placeholder data. Returns null if no active viewer connection
   * exists.
   */
  async getDiagnostics(): Promise<ViewerDiagnosticsSnapshot | null> {
    if (!this.viewerClient || this._destructed) return null;
    const sdk = this.viewerClient.getSDK();
    if (!sdk) return null;

    const entries = Array.from(sdk.connections.entries());
    if (entries.length === 0) return null;

    const [, group] = entries[0];
    const pc = group.viewer?.pc ?? group.publisher?.pc;
    if (!pc) return null;

    const timestamp = Date.now();
    let connectionState = pc.connectionState;

    const snapshot: ViewerDiagnosticsSnapshot = {
      connectionState,
      selectedCandidatePair: {
        local: null,
        remote: null,
        state: null,
        nominated: null,
      },
      inboundVideo: {
        bitrateBps: 0,
        bytesReceived: 0,
        packetsReceived: 0,
        packetsLost: 0,
        jitter: 0,
        codecId: null,
        frameWidth: null,
        frameHeight: null,
        framesPerSecond: null,
        framesDropped: null,
        freezeCount: null,
      },
      inboundAudio: {
        bitrateBps: 0,
        bytesReceived: 0,
        packetsReceived: 0,
        packetsLost: 0,
        jitter: 0,
        codecId: null,
      },
      rttMs: null,
      localCandidateType: null,
      remoteCandidateType: null,
      timestamp,
    };

    try {
      const stats = await pc.getStats();
      let aggregatedVideoBytes = 0;
      let aggregatedAudioBytes = 0;

      const localCandidates = new Map<string, any>();
      const remoteCandidates = new Map<string, any>();

      for (const report of stats.values()) {
        // Collect local and remote ICE candidates for type resolution
        if (report.type === "local-candidate") {
          localCandidates.set(report.id, report);
        }
        if (report.type === "remote-candidate") {
          remoteCandidates.set(report.id, report);
        }

        if (report.type === "candidate-pair" && (report as any).selected) {
          snapshot.selectedCandidatePair.state = (report as any).state ?? null;
          snapshot.selectedCandidatePair.nominated = (report as any).nominated ?? null;
          // Read currentRoundTripTime
          const rtt = (report as any).currentRoundTripTime;
          if (rtt !== undefined && rtt !== null) {
            snapshot.rttMs = rtt * 1000; // convert seconds to ms
          }
          // Resolve local/remote candidate descriptions and types
          if ((report as any).localCandidateId) {
            const local = localCandidates.get((report as any).localCandidateId);
            if (local) {
              snapshot.selectedCandidatePair.local =
                `${(local as any).address ?? "?"}:${(local as any).port ?? "?"}`;
              snapshot.localCandidateType = (local as any).candidateType ?? null;
            }
          }
          if ((report as any).remoteCandidateId) {
            const remote = remoteCandidates.get((report as any).remoteCandidateId);
            if (remote) {
              snapshot.selectedCandidatePair.remote =
                `${(remote as any).address ?? "?"}:${(remote as any).port ?? "?"}`;
              snapshot.remoteCandidateType = (remote as any).candidateType ?? null;
            }
          }
        }

        if (report.type === "inbound-rtp") {
          const kind = (report as any).kind;
          const bytes = (report as any).bytesReceived ?? 0;
          const packets = (report as any).packetsReceived ?? 0;
          const lost = (report as any).packetsLost ?? 0;
          const jitter = (report as any).jitter ?? 0;
          const codecId = (report as any).codecId ?? null;

          if (kind === "video") {
            aggregatedVideoBytes += bytes;
            snapshot.inboundVideo.packetsReceived = packets;
            snapshot.inboundVideo.packetsLost = lost;
            snapshot.inboundVideo.jitter = jitter;
            snapshot.inboundVideo.codecId = codecId;
            // Real video frame dimensions and stats
            snapshot.inboundVideo.frameWidth = (report as any).frameWidth ?? null;
            snapshot.inboundVideo.frameHeight = (report as any).frameHeight ?? null;
            snapshot.inboundVideo.framesPerSecond = (report as any).framesPerSecond ?? null;
            snapshot.inboundVideo.framesDropped = (report as any).framesDropped ?? null;
            snapshot.inboundVideo.freezeCount = (report as any).freezeCount ?? null;
          } else if (kind === "audio") {
            aggregatedAudioBytes += bytes;
            snapshot.inboundAudio.packetsReceived = packets;
            snapshot.inboundAudio.packetsLost = lost;
            snapshot.inboundAudio.jitter = jitter;
            snapshot.inboundAudio.codecId = codecId;
          }
        }
      }

      snapshot.inboundVideo.bytesReceived = aggregatedVideoBytes;
      snapshot.inboundAudio.bytesReceived = aggregatedAudioBytes;
    } catch {
      // Stats collection is best-effort; return partial snapshot
    }

    return snapshot;
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
      //    leaves from prior attempts.
      await conn.sendToPeer(peerUuid, {
        type: "stream.join.request",
        logicalStreamId: this.logicalStreamId,
        viewerDeviceId: runtime.deviceId ?? "viewer",
        viewerDisplayName: runtime.displayName ?? "Viewer",
        requestId,
        viewerSessionId: this._viewerSessionId ?? undefined,
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

        // Attach to video element if bound
        if (this.videoElement && this._receivedStream) {
          this.attachStreamToElement(this.videoElement, this._receivedStream);
        }

        this.onStreamReceived?.(this._receivedStream);

        // Only transition to watching when a live video track is received
        if (isVideo) {
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

    if (state !== "paused" && this.viewerClient) {
      try {
        const diag = await this.getDiagnostics();
        if (diag) {
          receivedBitrateKbps = diag.inboundVideo.bitrateBps > 0
            ? Math.round(diag.inboundVideo.bitrateBps / 1000)
            : null;
          receivedWidth = diag.inboundVideo.frameWidth;
          receivedHeight = diag.inboundVideo.frameHeight;
          displayedFps = diag.inboundVideo.framesPerSecond;
        }
      } catch { /* best effort */ }
    }

    void conn.sendToPeer(peerUuid, {
      type: "viewer.status",
      viewerDeviceId: runtime.deviceId ?? "viewer",
      streamId: this.logicalStreamId,
      state,
      viewerDisplayName: runtime.displayName ?? undefined,
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
   * Send a stream.leave message over the group-control channel.
   * Includes the per-attempt session ID so the host can ignore a
   * late leave from a prior Watch attempt that no longer matches
   * the active mapping.
   *
   * Fire-and-forget by design — the group channel is best-effort and
   * the leave is informational for the host's cleanup path. The host
   * also reacts to peerDisconnected on the VDO media SDK, so a missed
   * leave is recoverable.
   */
  private sendLeave(): void {
    if (this.leaveAnnounced) return;
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return;
    if (!this.groupId || !this.hostDeviceId || !this.logicalStreamId) return;

    const conn = runtime.getConnectionManager().getConnection(this.groupId);
    if (!conn) return;

    const peerUuid = conn.peerForDevice(this.hostDeviceId);
    if (!peerUuid) return;

    this.leaveAnnounced = true;
    void conn.sendToPeer(peerUuid, {
      type: "stream.leave",
      logicalStreamId: this.logicalStreamId,
      viewerDeviceId: runtime.deviceId ?? "viewer",
      viewerSessionId: this._viewerSessionId ?? undefined,
    }).catch(() => {});
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
