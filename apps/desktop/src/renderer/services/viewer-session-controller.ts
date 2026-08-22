/**
 * ViewerSessionController — Phases 4 + 5B
 *
 * Owns one viewer lifecycle attempt, one immutable ViewerSessionSnapshot,
 * serialized start/stop/retry/pause/resume commands, target identity refresh,
 * stream-end detection, typed subscriptions, typed quality feedback, AND
 * connection-health monitoring with automatic bounded-backoff recovery.
 *
 * ## Health integration (Phase 5B)
 *
 * - Creates one {@link ConnectionSupervisor} per controller instance.
 * - Runs a periodic health monitor that observes the runtime control
 *   connection state and the viewer's canonical StreamMetricsService snapshot.
 * - Projects supervisor `controlHealth` / `mediaHealth` into the snapshot.
 * - Schedules bounded-exponential-backoff recovery when a recoverable
 *   condition is detected (control or media down/stalled).
 * - Never auto-recovers when the supervisor is marked intentional-stop.
 * - Stream-end detection classifies confirmed host stop as `ended`.
 *
 * ## Design rules
 *
 * - The supervisor is created once and reset via `cancel()` on each
 *   start cycle — no stale state leaks across attempts.
 * - Health polling and recovery scheduling are generation-gated so
 *   stale callbacks from a prior attempt are silently dropped.
 * - Recovery uses `_retryImpl` (non-queued start) inside `_enqueue`,
 *   never calling public `start()` from inside the queue.
 * - Backoff is reset after a successful recovery.
 */
import type { ViewerSessionSnapshot, StreamTarget } from "@screenlink/shared";
import {
  createConnectionSupervisor,
  type ConnectionSupervisor,
  type ConnectionSupervisorOptions,
  type ControlHealth,
  type MediaHealth,
} from "./connection-supervisor.js";
import { ViewerSession, type ViewerSessionState, type ViewerPauseState } from "./viewer-session.js";
import { StreamMetricsService } from "./stream-metrics-service.js";
import { getRuntime } from "./phase3-runtime.js";

export type { ViewerSessionSnapshot };

// ─── Types ─────────────────────────────────────────────────────────────────

/** Listener callback for snapshot changes. */
export type SnapshotListener = (snapshot: ViewerSessionSnapshot) => void;

/** Quality feedback published by the host via the controller. */
export interface QualityFeedback {
  type: "effective" | "configured" | "observed";
  data: Record<string, unknown>;
}

export type QualityFeedbackListener = (feedback: QualityFeedback) => void;

/**
 * Optional constructor options for testability.
 * All timers default to the global runtime when omitted.
 */
export interface ViewerSessionControllerOptions {
  /** Factory for the connection supervisor (default: createConnectionSupervisor). */
  createSupervisor?: (opts?: ConnectionSupervisorOptions) => ConnectionSupervisor;
  /** Options forwarded to the supervisor factory. */
  supervisorOptions?: ConnectionSupervisorOptions;
  /** Health monitor polling interval in ms (default: 2000). */
  healthPollIntervalMs?: number;
  /** Injected timer factories for deterministic testing. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  /** Injected clock for the supervisor (default: Date.now). */
  now?: () => number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function pauseStateToSnapshot(s: ViewerPauseState): ViewerSessionSnapshot["pause"] {
  switch (s) {
    case "playing": return "playing";
    case "pausing": return "pausing";
    case "paused": return "paused";
    case "resuming": return "resuming";
  }
}

function sessionStateToPhase(s: ViewerSessionState): ViewerSessionSnapshot["phase"] {
  switch (s) {
    case "idle": return "idle";
    case "connecting":
    case "requesting-join":
    case "waiting-for-host":
    case "accepted":
    case "connecting-media":
      return "connecting";
    case "watching": return "watching";
    case "paused": return "paused";
    case "reconnecting": return "reconnecting";
    case "ended": return "ended";
    case "error": return "error";
  }
}

// ─── Active controller registration ───────────────────────────────────────
// Set by useViewerSession hook; read by GroupMessageRouter for quality feedback.
let _activeController: ViewerSessionController | null = null;

export function setActiveController(c: ViewerSessionController | null): void {
  _activeController = c;
}

export function getActiveController(): ViewerSessionController | null {
  return _activeController;
}

// ─── Controller ────────────────────────────────────────────────────────────

export class ViewerSessionController {
  // ── Phase 4 state (unchanged shape) ────────────────────────────────────
  private _session: ViewerSession | null = null;
  private _target: StreamTarget | null = null;
  private _error: string | null = null;
  private _controlHealth: ControlHealth = "up";
  private _mediaHealth: MediaHealth = "up";
  private _phase: ViewerSessionSnapshot["phase"] = "idle";
  private _pause: ViewerSessionSnapshot["pause"] = "playing";

  /** Generation counter for stale callback rejection. */
  private _gen = 0;

  private _snapshotListeners = new Set<SnapshotListener>();
  private _qualityListeners = new Set<QualityFeedbackListener>();

  /** Serialized operation queue — prevents overlapping commands. */
  private _opQueue = Promise.resolve<void>(undefined);

  /** Store subscription for stream-end detection. */
  private _unsubscribeStore: (() => void) | null = null;

  // ── Phase 5B health / recovery state ───────────────────────────────────

  private _opts: ViewerSessionControllerOptions;
  /** Supervisor instance (created once, reset via cancel()). */
  private _supervisor: ConnectionSupervisor;
  /** Unsubscribe from supervisor snapshot changes. */
  private _healthUnsub: (() => void) | null = null;
  /** Health monitor interval handle. */
  private _healthTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending recovery timer handle. */
  private _recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against concurrent recovery scheduling. */
  private _recoveryInFlight = false;
  /** Generation at which the health monitor was started (extra safety). */
  private _monitorGen = -1;

  /**
   * Cached snapshot. Replaced on every _publish() call so
   * useSyncExternalStore getSnapshot returns the same reference
   * between changes.
   */
  private _cachedSnapshot: ViewerSessionSnapshot = {
    phase: "idle",
    target: null,
    controlHealth: "up",
    mediaHealth: "up",
    pause: "playing",
    error: null,
  };

  constructor(opts?: ViewerSessionControllerOptions) {
    this._opts = opts ?? {};
    const createSup = this._opts.createSupervisor ?? createConnectionSupervisor;
    const supOpts: ConnectionSupervisorOptions = {
      ...this._opts.supervisorOptions,
      now: this._opts.now,
    };
    this._supervisor = createSup(supOpts);
  }

  // ── Snapshot accessor ───────────────────────────────────────────────

  /** Get the current immutable snapshot (stable reference until change). */
  get snapshot(): ViewerSessionSnapshot {
    return this._cachedSnapshot;
  }

  /** The underlying ViewerSession, if active. */
  get session(): ViewerSession | null {
    return this._session;
  }

  /** The current stream target. */
  get target(): StreamTarget | null {
    return this._target;
  }

  /** Expose the supervisor for Phase 5C wiring / test inspection. */
  get supervisor(): ConnectionSupervisor {
    return this._supervisor;
  }

  // ── Subscriptions ──────────────────────────────────────────────────

  subscribe(listener: SnapshotListener): () => void {
    this._snapshotListeners.add(listener);
    listener(this._cachedSnapshot);
    return () => { this._snapshotListeners.delete(listener); };
  }

  /** Subscribe to typed quality feedback from the host. */
  subscribeQuality(listener: QualityFeedbackListener): () => void {
    this._qualityListeners.add(listener);
    return () => { this._qualityListeners.delete(listener); };
  }

  /** Publish quality feedback to subscribers. Called by GroupMessageRouter. */
  publishQuality(feedback: QualityFeedback): void {
    for (const cb of this._qualityListeners) {
      try { cb(feedback); } catch { /* guard */ }
    }
  }

  /**
   * Build and replace the cached snapshot, then notify subscribers.
   * Only called when a field actually changes.
   */
  private _publish(): void {
    this._cachedSnapshot = {
      phase: this._phase,
      target: this._target,
      controlHealth: this._controlHealth,
      mediaHealth: this._mediaHealth,
      pause: this._pause,
      error: this._error,
    };
    for (const cb of this._snapshotListeners) {
      try { cb(this._cachedSnapshot); } catch { /* guard */ }
    }
  }

  private _setPhase(p: ViewerSessionSnapshot["phase"]): void {
    if (this._phase === p) return;
    this._phase = p;
    this._publish();
  }

  private _setPause(p: ViewerSessionSnapshot["pause"]): void {
    if (this._pause === p) return;
    this._pause = p;
    this._publish();
  }

  private _setError(e: string | null): void {
    if (this._error === e) return;
    this._error = e;
    this._publish();
  }

  private _setControlHealth(h: ControlHealth): void {
    if (this._controlHealth === h) return;
    this._controlHealth = h;
    this._publish();
  }

  private _setMediaHealth(h: MediaHealth): void {
    if (this._mediaHealth === h) return;
    this._mediaHealth = h;
    this._publish();
  }

  // ── Serialized commands ────────────────────────────────────────────

  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._opQueue;
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    this._opQueue = prev.then(
      () => fn().then(resolve, reject),
      () => fn().then(resolve, reject),
    );
    return result;
  }

  /**
   * Start a viewer session. Serialized via _enqueue.
   */
  async start(target: StreamTarget, videoElement: HTMLVideoElement | null): Promise<void> {
    return this._enqueue(() => this._startImpl(target, videoElement));
  }

  /** Non-queued start implementation. */
  private async _startImpl(target: StreamTarget, videoElement: HTMLVideoElement | null): Promise<void> {
    // Cancel any outstanding health monitoring from a prior session
    this._stopHealthMonitor();
    this._supervisor.cancel();
    this._recoveryInFlight = false;

    await this._destroySession();
    this._gen++;

    this._target = target;
    this._error = null;
    this._pause = "playing";
    this._setPhase("connecting");

    const gen = this._gen;
    const runtime = getRuntime();

    const session = new ViewerSession();
    this._session = session;

    session.onPauseStateChange = (ps: ViewerPauseState) => {
      if (this._gen !== gen) return;
      this._setPause(pauseStateToSnapshot(ps));
      // When paused, tell supervisor so it suppresses stall detection
      this._supervisor.setPaused(ps === "paused" || ps === "pausing");
    };

    session.onError = (err: string) => {
      if (this._gen !== gen) return;
      this._setError(err);
      this._setPhase("error");
    };

    session.onStateChange = (state: ViewerSessionState) => {
      if (this._gen !== gen) return;
      this._setPhase(sessionStateToPhase(state));
    };

    session.onPosterFrameChange = (_poster: string | null) => {
      // Poster frame handled by presentation layer
    };

    try {
      await session.start({
        groupId: target.groupId,
        hostDeviceId: target.hostDeviceId,
        logicalStreamId: target.logicalStreamId,
        mediaSessionId: target.mediaSessionId,
        hostName: target.hostName,
        videoElement,
      });

      if (this._gen !== gen) return;

      await this._startStreamEndDetection(target);

      const metricsId = StreamMetricsService.getInstance().startViewerSession(
        target.mediaSessionId,
        target.logicalStreamId,
        target.groupId,
        target.hostName,
      );
      (session as unknown as { _historyId: string | null })._historyId = metricsId;

      // Start health monitor AFTER session is established
      this._startHealthMonitor();
    } catch (err) {
      if (this._gen !== gen) return;
      const msg = err instanceof Error ? err.message : String(err);
      this._setError(msg);
      this._setPhase("error");
      this._session = null;
      this._stopHealthMonitor();
      this._supervisor.cancel();
      throw err;
    }
  }

  /**
   * Recover: teardown current session, refresh target, start fresh.
   * Uses the same implementation as retry.  Manual and automatic recovery
   * both go through this single serialized path.
   */
  async recover(): Promise<void> {
    return this._enqueue(() => this._retryImpl());
  }

  /**
   * Retry — backward-compatible alias for `recover()`.
   */
  async retry(): Promise<void> {
    return this.recover();
  }

  /** Non-queued recovery implementation (shared by retry and auto-recovery). */
  private async _retryImpl(): Promise<void> {
    this._error = null;
    this._setPhase("reconnecting");

    const runtime = getRuntime();
    if (runtime && !runtime.isDestroyed()) {
      try {
        const syncResult = runtime.requestGroupSync(
          this._target?.groupId ?? "",
          // Viewer recovery must not clear still-valid remote streams
          // from the registry while reconnecting.
          { preserveActiveStreams: true },
        );
        if (syncResult && typeof (syncResult as Promise<unknown>).then === "function") {
          await (syncResult as Promise<unknown>);
        }
      } catch { /* non-fatal */ }
    }

    this._refreshTarget();

    const videoElement = this._session === null
      ? null
      : (this._session as unknown as { videoElement: HTMLVideoElement | null }).videoElement;

    await this._destroySession();

    if (this._target) {
      await this._startImpl(this._target, videoElement);
      // Backoff resets on successful start
      this._supervisor.resetBackoff();
    } else {
      this._setError("No stream target available");
      this._setPhase("error");
    }
  }

  /**
   * Pause the current stream. Serialized through the queue.
   */
  async pause(): Promise<void> {
    return this._enqueue(async () => {
      const session = this._session;
      if (!session) return;
      if (session.pauseState !== "playing") return;
      try {
        await session.pause();
      } catch {
        // Error reflected via onError callback
      }
    });
  }

  /**
   * Resume the current stream. Serialized through the queue.
   */
  async resume(): Promise<void> {
    return this._enqueue(async () => {
      const session = this._session;
      if (!session) return;
      if (session.pauseState !== "paused") return;
      try {
        await session.resume();
      } catch {
        // Error reflected via onError callback
      }
    });
  }

  /**
   * Toggle pause state. Convenience for keyboard shortcuts.
   */
  async togglePause(): Promise<void> {
    const s = this._session;
    if (!s) return;
    if (s.pauseState === "playing" || s.pauseState === "resuming") {
      await this.pause();
    } else if (s.pauseState === "paused" || s.pauseState === "pausing") {
      await this.resume();
    }
  }

  /**
   * Stop the viewer session and return to idle.
   */
  async stop(): Promise<void> {
    // Invalidate health/recovery callbacks before teardown is queued.
    this._gen++;
    return this._enqueue(async () => {
      this._stopHealthMonitor();
      this._supervisor.cancel();
      this._recoveryInFlight = false;
      await this._destroySession();
      this._target = null;
      this._error = null;
      this._setPhase("idle");
    });
  }

  /**
   * Refresh the stream target from the active stream registry.
   */
  refreshTarget(): void {
    this._refreshTarget();
  }

  private _refreshTarget(): void {
    if (!this._target) return;
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return;
    const registry = runtime.getActiveStreamRegistry();
    const streams = registry.getStreamsByGroup(this._target.groupId);
    const hostStreams = streams.filter((s) => s.hostDeviceId === this._target!.hostDeviceId);
    if (hostStreams.length === 0) return;

    const sorted = [...hostStreams].sort((a, b) => {
      const revDiff = (b.streamRevision ?? 0) - (a.streamRevision ?? 0);
      if (revDiff !== 0) return revDiff;
      return (b.startedAt ?? 0) - (a.startedAt ?? 0);
    });

    const latest = sorted[0];
    if (!latest) return;

    const sameLogical = sorted.find((s) => s.logicalStreamId === this._target!.logicalStreamId);
    if (sameLogical) {
      this._target = { ...this._target, mediaSessionId: sameLogical.mediaSessionId };
    } else {
      this._target = {
        ...this._target,
        logicalStreamId: latest.logicalStreamId,
        mediaSessionId: latest.mediaSessionId,
      };
    }
  }

  // ── Stream-end detection ───────────────────────────────────────────

  private async _startStreamEndDetection(target: StreamTarget): Promise<void> {
    this._stopStreamEndDetection();

    const exactLogicalStreamId = target.logicalStreamId;
    const exactMediaSessionId = target.mediaSessionId;

    const { useStore } = await import("../stores/main-store.js");
    this._unsubscribeStore = useStore.subscribe(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (state: any, _prevState: any) => {
        const session = this._session;
        if (!session) return;
        if (session.state !== "watching") return;
        if (session.pauseState === "paused") return;

        const activeStreamsByGroup = state.activeStreamsByGroup as Record<string, Array<{ logicalStreamId: string; mediaSessionId: string }>>;
        const groupStreams = activeStreamsByGroup[target.groupId] ?? [];
        const stillExists = groupStreams.some(
          (s) => s.logicalStreamId === exactLogicalStreamId && s.mediaSessionId === exactMediaSessionId,
        );

        if (!stillExists) {
          // Mark intentional stop so the health monitor does NOT schedule recovery
          this._supervisor.markIntentionalStop();
          void this._enqueue(async () => {
            await this._destroySession();
            this._setPhase("ended");
            this._setError(null);
          });
        }
      },
    );
  }

  private _stopStreamEndDetection(): void {
    if (this._unsubscribeStore) {
      this._unsubscribeStore();
      this._unsubscribeStore = null;
    }
  }

  // ── Health monitor (Phase 5B) ─────────────────────────────────────

  /**
   * Start the periodic health monitor and supervisor projection.
   * Safe to call multiple times (stops previous instance).
   */
  private _startHealthMonitor(): void {
    this._stopHealthMonitor();

    const gen = this._gen;

    // Subscribe to supervisor for health projection into snapshot
    this._healthUnsub = this._supervisor.subscribe((snap) => {
      if (this._gen !== gen) return;
      this._setControlHealth(snap.controlHealth);
      this._setMediaHealth(snap.mediaHealth);
    });

    const intervalMs = this._opts.healthPollIntervalMs ?? 2_000;
    const setInt = this._opts.setInterval ?? setInterval;
    this._monitorGen = gen;

    this._healthTimer = setInt(() => {
      if (this._gen !== gen) {
        this._stopHealthMonitor();
        return;
      }
      this._healthTick();
    }, intervalMs);
  }

  /**
   * Stop the health monitor and cancel any pending recovery timer.
   */
  private _stopHealthMonitor(): void {
    const clearInt = this._opts.clearInterval ?? clearInterval;
    if (this._healthTimer !== null) {
      clearInt(this._healthTimer);
      this._healthTimer = null;
    }
    this._cancelRecoveryTimer();
    this._monitorGen = -1;
    if (this._healthUnsub) {
      this._healthUnsub();
      this._healthUnsub = null;
    }
  }

  /**
   * Single health-monitor tick.
   *
   * 1. Observe control connection state from the runtime.
   * 2. Observe media byte progress from the peer connection.
   * 3. Check for media stalls.
   * 4. Schedule recovery if a recoverable condition is detected.
   */
  private _healthTick(): void {
    // 1. Control plane
    this._pollControlState();

    // 2. Media plane — read the canonical StreamMetricsService snapshot
    this._pollMediaBytes();

    // 3. Stall check
    this._supervisor.checkMediaStall();

    // 4. Recovery decision
    this._checkRecovery();
  }

  /** Poll the runtime control connection state and feed the supervisor. */
  private _pollControlState(): void {
    const target = this._target;
    if (!target) { this._supervisor.reportControlDisconnected(); return; }
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) { this._supervisor.reportControlDisconnected(); return; }
    const connMgr = runtime.getConnectionManager();
    if (!connMgr) { this._supervisor.reportControlDisconnected(); return; }
    const conn = connMgr.getConnection(target.groupId);
    if (!conn) { this._supervisor.reportControlDisconnected(); return; }

    switch (conn.state) {
      case "connected":
        this._supervisor.reportControlConnected();
        break;
      case "reconnecting":
        this._supervisor.reportControlReconnecting();
        break;
      case "starting":
        // Transitional — keep current state
        break;
      default:
        // idle, stopping, destroyed, failed → disconnected
        this._supervisor.reportControlDisconnected();
        break;
    }
  }

  /** Read the active session's canonical StreamMetricsService snapshot and feed cumulative inbound video bytes. */
  private _pollMediaBytes(): void {
    const session = this._session;
    if (!session) { this._supervisor.reportMediaDisconnected(); return; }

    const historyId = (session as unknown as { _historyId: string | null })._historyId;
    if (!historyId) { this._supervisor.reportMediaDisconnected(); return; }

    const metricsSnapshot = StreamMetricsService.getInstance().getSnapshot(historyId);
    if (!metricsSnapshot || !metricsSnapshot.aggregate) {
      this._supervisor.reportMediaDisconnected();
      return;
    }

    const inboundBytes = metricsSnapshot.aggregate.cumulativeInboundVideoBytes;
    if (inboundBytes > 0) {
      this._supervisor.reportMediaProgress(inboundBytes);
    }
    // inboundBytes === 0 is valid — keep current state (no-media-yet or progressing)
  }

  /**
   * Decide whether the current health state warrants recovery.
   *
   * Rules:
   * - Never recover if `isIntentionalStop` is set (confirmed host stop).
   * - Never enqueue concurrent recovery (`_recoveryInFlight` guard).
   * - Recoverable states: control down, media down, media stalled.
   */
  private _checkRecovery(): void {
    if (this._recoveryInFlight) return;
    const snap = this._supervisor.getSnapshot();
    if (snap.isIntentionalStop) return;
    if (snap.controlHealth === "recovering") return; // already recovering

    const needsRecovery =
      snap.controlHealth === "down" ||
      snap.mediaHealth === "down" ||
      snap.mediaHealth === "stalled";

    if (!needsRecovery) return;

    // Defer scheduling to prevent the recovery setTimeout from being
    // consumed by the same timer dispatch (synchronous health tick
    // + advanceTimersByTime in tests).  The actual delay is unaffected.
    Promise.resolve().then(() => this._scheduleRecovery());
  }

  /**
   * Schedule recovery with bounded exponential backoff.
   */
  private _scheduleRecovery(): void {
    if (this._recoveryInFlight) return;
    this._recoveryInFlight = true;

    const delay = this._supervisor.nextBackoff();
    this._setPhase("reconnecting");

    const setT = this._opts.setTimeout ?? setTimeout;
    const gen = this._gen;

    this._recoveryTimer = setT(() => {
      if (this._gen !== gen) { this._recoveryInFlight = false; return; }
      this._recoveryTimer = null;

      void this._enqueue(async () => {
        if (this._gen !== gen) { this._recoveryInFlight = false; return; }
        try {
          await this._retryImpl();
          // Backoff reset on success is handled inside _retryImpl via _startImpl
        } catch {
          // _retryImpl sets phase=error on failure; health monitor is stopped.
          // The error is intentionally swallowed — the snapshot already reflects
          // the failure state and a manual retry() may follow.
        } finally {
          this._recoveryInFlight = false;
        }
      });
    }, delay);
  }

  /** Cancel a pending recovery timer without resetting the backoff. */
  private _cancelRecoveryTimer(): void {
    const clearT = this._opts.clearTimeout ?? clearTimeout;
    if (this._recoveryTimer !== null) {
      clearT(this._recoveryTimer);
      this._recoveryTimer = null;
    }
  }

  // ── Internal teardown ──────────────────────────────────────────────

  private async _destroySession(): Promise<void> {
    this._stopStreamEndDetection();
    const session = this._session;
    if (!session) return;

    const historyId = (session as unknown as { _historyId: string | null })._historyId;
    if (historyId) {
      StreamMetricsService.getInstance().finalizeSession(historyId).catch(() => {});
    }

    this._session = null;
    await session.destroy().catch(() => {});
  }

  async destroy(): Promise<void> {
    this._gen++;
    this._snapshotListeners.clear();
    this._qualityListeners.clear();
    this._stopHealthMonitor();
    this._supervisor.cancel();
    this._recoveryInFlight = false;
    await this._destroySession();
    this._target = null;
    this._error = null;
    this._setPhase("idle");
  }
}
