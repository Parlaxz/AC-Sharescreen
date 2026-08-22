/**
 * ConnectionSupervisor — Phase 5A
 *
 * Deterministic, subscription-based health model that combines control-plane
 * and media-plane state into one decision surface for viewer recovery.
 *
 * This is a pure model with **no SDK, DOM, or store dependencies**.
 * Phase 5B will wire adapters that drive its methods.
 *
 * ---
 *
 * ## Snapshot compatibility
 *
 * The {@link ConnectionHealthSnapshot.controlHealth} and
 * {@link ConnectionHealthSnapshot.mediaHealth} fields use the same literal
 * union values as {@link ViewerSessionSnapshot.controlHealth} and
 * `.mediaHealth`, so Phase 5B can trivially project them.
 *
 * ## Policy rules
 *
 * | Control state        | → controlHealth |
 * |----------------------|----------------|
 * | `connected`          | `up`           |
 * | `reconnecting`       | `recovering`   |
 * | `disconnected`       | `down`         |
 * | `failed`             | `down`         |
 *
 * | Media state            | → mediaHealth |
 * |------------------------|---------------|
 * | `connected`            | `up`          |
 * | `progressing`          | `up`          |
 * | `stalled`              | `stalled`     |
 * | `recovering`           | `recovering`  |
 * | `disconnected`         | `down`        |
 * | `no-media-yet`         | `up`          |
 *
 * Additional rules:
 * - **Paused sessions** must not be declared stalled (pause intentionally
 *   halts bytes).
 * - **Intentional host stop** sets an internal flag so recovery logic can
 *   distinguish "should not attempt recovery" from transient loss.
 * - **Stale byte progress**: when `checkMediaStall(now)` is called and the
 *   time since the last `reportMediaProgress` exceeds `stallThresholdMs`,
 *   the media state transitions to `stalled` — *unless* paused or
 *   no-media-yet.
 *
 * @example
 * ```ts
 * const sup = createConnectionSupervisor({
 *   stallThresholdMs: 5_000,
 * });
 *
 * sup.subscribe((snap) => console.log(snap.mediaHealth));
 * sup.reportControlConnected();
 * sup.reportMediaConnected();
 * sup.reportMediaProgress(1000, Date.now());
 * ```
 */

import { createBackoff, type Backoff, type BackoffOptions } from "@screenlink/shared";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Mirror of the ViewerSessionSnapshot health fields, kept as identical unions
 * so Phase 5B can assign them without mapping. */
export type ControlHealth = "up" | "down" | "recovering";
export type MediaHealth = "up" | "stalled" | "down" | "recovering";

/** Raw control-plane connection state. */
export type ControlState = "connected" | "reconnecting" | "disconnected" | "failed";

/** Raw media-plane state at the supervisor level. */
export type MediaState =
  /** Track received; initial connection */
  | "connected"
  /** Bytes are actively increasing */
  | "progressing"
  /** Bytes have stopped advancing past the stall threshold */
  | "stalled"
  /** Track or stream disconnected */
  | "disconnected"
  /** No media has arrived yet (avoids false stall) */
  | "no-media-yet"
  /** Media is recovering (e.g. re-establishing after a loss). */
  | "recovering";

// ─── Snapshot ───────────────────────────────────────────────────────────────

/**
 * Immutable snapshot of connection health.
 *
 * The `controlHealth` / `mediaHealth` fields are drop-in compatible with
 * {@link ViewerSessionSnapshot}, so Phase 5B can do:
 * ```ts
 * supervisor.subscribe(snap => {
 *   controller.reportHealth(snap.controlHealth, snap.mediaHealth);
 * });
 * ```
 *
 * Additional metadata (`controlState`, `mediaState`, `isPaused`,
 * `isIntentionalStop`, `backoffAttempt`, `backoffDelayMs`) gives recovery
 * logic enough context to decide whether and how to reconnect.
 */
export interface ConnectionHealthSnapshot {
  /** Canonical health for the control plane. */
  readonly controlHealth: ControlHealth;
  /** Canonical health for the media plane. */
  readonly mediaHealth: MediaHealth;

  /** Raw control state (more granular than the health projection). */
  readonly controlState: ControlState;
  /** Raw media state (more granular than the health projection). */
  readonly mediaState: MediaState;

  /** Whether the viewer session is paused (suppresses stall detection). */
  readonly isPaused: boolean;

  /**
   * Whether the host has signalled an intentional stop.
   * Recovery logic should NOT auto-recover when this is true.
   */
  readonly isIntentionalStop: boolean;

  /**
   * Wall-clock timestamp of the most recent `reportMediaProgress` call,
   * or `null` if never called.
   */
  readonly lastByteProgressMs: number | null;

  /** Current backoff attempt count (0 = no backoff in progress). */
  readonly backoffAttempt: number;
  /** Current backoff delay in ms (0 = no delay pending). */
  readonly backoffDelayMs: number;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface ConnectionSupervisorOptions {
  /**
   * How many milliseconds without media byte progress before the media
   * is considered stalled (unless paused or no-media-yet).
   *
   * @default 5_000
   */
  stallThresholdMs?: number;

  /**
   * Backoff configuration passed to the internal `createBackoff`.
   * Omitting uses the default backoff (100 ms min, 30 s max, factor 2).
   */
  backoff?: BackoffOptions;

  /**
   * Injected clock for deterministic testing.
   * Defaults to `Date.now`.
   */
  now?: () => number;
}

// ─── Listener ───────────────────────────────────────────────────────────────

export type ConnectionHealthListener = (snapshot: ConnectionHealthSnapshot) => void;

// ─── Interface ──────────────────────────────────────────────────────────────

export interface ConnectionSupervisor {
  // ── Subscriptions ──────────────────────────────────────────────────────

  /** Subscribe to snapshot changes. Returns an unsubscribe function.
   *  The listener is called immediately with the current snapshot. */
  subscribe(listener: ConnectionHealthListener): () => void;

  /** Get the current immutable snapshot (stable reference until change). */
  getSnapshot(): ConnectionHealthSnapshot;

  // ── Updates (called by adapters in Phase 5B) ─────────────────────────

  /** Report that the control plane has connected. */
  reportControlConnected(): void;

  /** Report that the control plane is reconnecting. */
  reportControlReconnecting(): void;

  /** Report that the control plane has disconnected (not failed). */
  reportControlDisconnected(): void;

  /** Report that the control plane has failed (permanent until reset). */
  reportControlFailed(): void;

  /** Report that media track has been received and connected. */
  reportMediaConnected(): void;

  /** Report that media has disconnected (track ended / stream removed). */
  reportMediaDisconnected(): void;

  /**
   * Report that media is recovering (e.g. a new track is expected after
   * a rejoin or rebind).  Maps to `mediaHealth = "recovering"`.
   */
  reportMediaRecovering(): void;

  /**
   * Report received media bytes (e.g. from `getStats()` or RTP
   * `bytesReceived` deltas).
   *
   * @param bytes  Cumulative byte count (monotonic).
   * @param now    Timestamp for the measurement.  Uses injected clock
   *               or `Date.now()` when omitted.
   */
  reportMediaProgress(bytes: number, now?: number): void;

  /**
   * Check whether media has stalled given the current time.
   *
   * Transitions media state to `stalled` (and thus mediaHealth to
   * `stalled`) when `now - lastByteProgressMs > stallThresholdMs`,
   * **unless** the session is paused or no-media-yet.
   *
   * Safe to call on every tick/sample — it is idempotent when
   * already stalled or when the condition is not met.
   */
  checkMediaStall(now?: number): void;

  /**
   * Set the pause state.  While paused the supervisor will never
   * declare a stall, even if bytes stop arriving.
   */
  setPaused(paused: boolean): void;

  /**
   * Mark that the host has intentionally stopped the stream.
   * Recovery logic should check `isIntentionalStop` and refrain
   * from auto-reconnecting.
   */
  markIntentionalStop(): void;

  // ── Lifecycle / backoff ───────────────────────────────────────────────

  /**
   * Cancel/reinitialise the supervisor to its default state.
   * Equivalent to a hard reset — clears pause, intentional-stop,
   * control/media state, and resets backoff.
   */
  cancel(): void;

  /**
   * Advance the backoff by one step.
   * Returns the delay in ms (same as `Backoff.next()`).
   */
  nextBackoff(): number;

  /**
   * Return the current backoff delay without advancing.
   * Returns 0 before the first call to `nextBackoff()`.
   */
  getBackoffDelay(): number;

  /**
   * Reset the backoff to its initial state (attempt=0, delay=min).
   */
  resetBackoff(): void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Derive the canonical control health from raw control state. */
function deriveControlHealth(state: ControlState): ControlHealth {
  switch (state) {
    case "connected":
      return "up";
    case "reconnecting":
      return "recovering";
    case "disconnected":
    case "failed":
      return "down";
  }
}

/** Derive the canonical media health from raw media state. */
function deriveMediaHealth(state: MediaState): MediaHealth {
  switch (state) {
    case "connected":
    case "progressing":
    case "no-media-yet":
      return "up";
    case "stalled":
      return "stalled";
    case "recovering":
      return "recovering";
    case "disconnected":
      return "down";
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

const DEFAULT_STALL_THRESHOLD_MS = 5_000;

export function createConnectionSupervisor(
  opts?: ConnectionSupervisorOptions,
): ConnectionSupervisor {
  const stallThresholdMs = opts?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const nowFn = opts?.now ?? (() => Date.now());
  const backoff: Backoff = createBackoff(opts?.backoff);

  // ── Internal state ────────────────────────────────────────────────────

  let _controlState: ControlState = "disconnected";
  let _mediaState: MediaState = "no-media-yet";
  let _isPaused = false;
  let _isIntentionalStop = false;
  let _lastByteProgressMs: number | null = null;
  let _lastReportedBytes = -1;

  // Cached snapshot — replaced on every _publish()
  let _cachedSnapshot: ConnectionHealthSnapshot = {
    controlHealth: "down",
    mediaHealth: "up",
    controlState: "disconnected",
    mediaState: "no-media-yet",
    isPaused: false,
    isIntentionalStop: false,
    lastByteProgressMs: null,
    backoffAttempt: 0,
    backoffDelayMs: 0,
  };

  const _listeners = new Set<ConnectionHealthListener>();

  // ── Publish ───────────────────────────────────────────────────────────

  function _buildSnapshot(): ConnectionHealthSnapshot {
    return {
      controlHealth: deriveControlHealth(_controlState),
      mediaHealth: deriveMediaHealth(_mediaState),
      controlState: _controlState,
      mediaState: _mediaState,
      isPaused: _isPaused,
      isIntentionalStop: _isIntentionalStop,
      lastByteProgressMs: _lastByteProgressMs,
      backoffAttempt: backoff.attempt,
      backoffDelayMs: _currentBackoffDelay(),
    };
  }

  /**
   * Returns the most recently computed backoff delay without advancing.
   *
   * `backoff.next()` advances the internal state and returns the delay,
   * but there is no `backoff.current()` accessor.  We snapshot the
   * returned value into `_lastDelay` inside `nextBackoff()` so the
   * snapshot can report it without mutating the backoff state.
   */
  function _currentBackoffDelay(): number {
    return _lastDelay;
  }

  let _lastDelay = 0;

  function _publish(): void {
    _cachedSnapshot = _buildSnapshot();
    for (const cb of _listeners) {
      try { cb(_cachedSnapshot); } catch { /* guard */ }
    }
  }

  // ── Interface ─────────────────────────────────────────────────────────

  const supervisor: ConnectionSupervisor = {
    subscribe(listener: ConnectionHealthListener): () => void {
      _listeners.add(listener);
      try { listener(_cachedSnapshot); } catch { /* guard — initial callback may throw */ }
      return () => { _listeners.delete(listener); };
    },

    getSnapshot(): ConnectionHealthSnapshot {
      return _cachedSnapshot;
    },

    // ── Control-plane updates ──────────────────────────────────────────

    reportControlConnected(): void {
      _isIntentionalStop = false; // a real connection clears the stop flag
      if (_controlState === "connected") return;
      _controlState = "connected";
      _publish();
    },

    reportControlReconnecting(): void {
      if (_controlState === "reconnecting") return;
      _controlState = "reconnecting";
      _publish();
    },

    reportControlDisconnected(): void {
      if (_controlState === "disconnected") return;
      _controlState = "disconnected";
      _publish();
    },

    reportControlFailed(): void {
      if (_controlState === "failed") return;
      _controlState = "failed";
      _publish();
    },

    // ── Media-plane updates ────────────────────────────────────────────

    reportMediaConnected(): void {
      if (_mediaState === "connected") return;
      _mediaState = "connected";
      // Reset byte tracker so the first progress report on the new
      // connection always advances, even if the cumulative counter
      // appears lower than a value from a prior session.
      _lastReportedBytes = -1;
      _publish();
    },

    reportMediaDisconnected(): void {
      if (_mediaState === "disconnected") return;
      _mediaState = "disconnected";
      _lastByteProgressMs = null;
      _lastReportedBytes = -1;
      _publish();
    },

    reportMediaRecovering(): void {
      if (_mediaState === "recovering") return;
      _mediaState = "recovering";
      _publish();
    },

    reportMediaProgress(bytes: number, now?: number): void {
      // Only advancing bytes confirm real media progress.  Stale or
      // reset/rebaselined byte counts do NOT refresh the stall timer.
      if (bytes <= _lastReportedBytes) return;
      _lastReportedBytes = bytes;

      const ts = now ?? nowFn();
      _lastByteProgressMs = ts;

      // Promoting from any non-progressing state to "progressing"
      if (_mediaState !== "progressing") {
        _mediaState = "progressing";
      }
      _publish();
    },

    checkMediaStall(now?: number): void {
      const ts = now ?? nowFn();

      // Never declare stall when paused or no-media-yet
      if (_isPaused) return;
      if (_mediaState === "no-media-yet") return;

      // If we have no progress data yet, cannot stall
      if (_lastByteProgressMs === null) return;

      // If we're already disconnected, don't override
      if (_mediaState === "disconnected") return;

      const elapsed = ts - _lastByteProgressMs;
      if (elapsed > stallThresholdMs) {
        if (_mediaState !== "stalled") {
          _mediaState = "stalled";
          _publish();
        }
      } else {
        // If we were stalled but now the threshold is no longer exceeded,
        // revert to progressing (bytes may have arrived via a different path)
        if (_mediaState === "stalled") {
          _mediaState = "progressing";
          _publish();
        }
      }
    },

    // ── Pause ───────────────────────────────────────────────────────────

    setPaused(paused: boolean): void {
      if (_isPaused === paused) return;
      _isPaused = paused;
      _publish();
    },

    // ── Intentional stop ────────────────────────────────────────────────

    markIntentionalStop(): void {
      if (_isIntentionalStop) return;
      _isIntentionalStop = true;
      _publish();
    },

    // ── Lifecycle / backoff ─────────────────────────────────────────────

    cancel(): void {
      _controlState = "disconnected";
      _mediaState = "no-media-yet";
      _isPaused = false;
      _isIntentionalStop = false;
      _lastByteProgressMs = null;
      _lastReportedBytes = -1;
      _lastDelay = 0;
      backoff.reset();
      _publish();
    },

    getBackoffDelay(): number {
      return _lastDelay;
    },

    nextBackoff(): number {
      _lastDelay = backoff.next();
      _publish();
      return _lastDelay;
    },

    resetBackoff(): void {
      backoff.reset();
      _lastDelay = 0;
      _publish();
    },
  };

  return supervisor;
}
