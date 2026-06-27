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

  /** Track IDs already in the received stream (deduplication). */
  private _trackIdsInStream = new Set<string>();

  /** Current pending join request ID, for cancellation on stop/destroy/retry. */
  private _pendingRequestId: string | null = null;

  /** Remote-track-ended debounce timer — instance state for proper cleanup. */
  private _remoteTrackEndedTimer: ReturnType<typeof setTimeout> | null = null;

  // Self-viewing support — when the host is the local device,
  // we pipe the capture stream directly instead of VDO relay.
  private selfViewEndedHandler: (() => void) | null = null;

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

  /**
   * The per-attempt viewer session ID. Null until start() is called.
   * Stays stable for the lifetime of one Watch attempt and is replaced
   * on every new start() (or retry()).
   */
  get viewerSessionId(): string | null {
    return this._viewerSessionId;
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
    void this.beginTeardown({ final: false });
    this.setState("ended");
  }

  /**
   * Final cleanup. The session cannot be restarted after this.
   * Idempotent. Like stop(), the actual teardown is async — the
   * _destructed flag is set immediately so any concurrent start()
   * bails before creating a new ViewerClient.
   */
  destroy(): void {
    if (this._destructed) return;
    this._destructed = true;
    void this.beginTeardown({ final: true });
  }

  /**
   * Begin a teardown, sharing the same promise across repeated calls.
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
        this.cancelPendingJoin();
        this.cancelRemoteTrackEndedTimer();

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

        // 5) Clear video element after the underlying stream is gone
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

        if (options.final) {
          this._state = "ended";
          this.onStateChange = null;
          this.onStreamReceived = null;
          this.onError = null;
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
        }
      };

      // Primary: SDK 1.3.18 trackAdded (real Alice/Bob watch path)
      events.on("trackAdded", handleTrackEvent);
      // Backward compat: older event shape
      events.on("track", handleTrackEvent);

      // Monitor remote track ended events (host stopped sharing)
      // Use 2s debounce to avoid mistaking brief interruptions for intentional stops
      // Uses instance field _remoteTrackEndedTimer for proper cleanup.
      const handleRemoteTrackEnded = (): void => {
        if (!this.isCurrent()) return;
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
    // Trigger the same shared teardown path as stop() — but final=true
    // is not appropriate here because the user may want to retry().
    void this.beginTeardown({ final: false });
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
