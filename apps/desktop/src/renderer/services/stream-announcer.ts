import type { StreamAnnouncement } from "@screenlink/shared";

/**
 * Snapshot of session identity read by StreamAnnouncer on each tick.
 * Returned by the getState() dependency callback.
 */
export interface AnnouncerSessionSnapshot {
  groupId: string | null;
  logicalStreamId: string | null;
  mediaSessionId: string | null;
  hostDeviceId: string;
  hostDisplayName: string;
}

/**
 * Narrow dependency interface for StreamAnnouncer.
 * The announcer owns the heartbeat/reannounce timer lifecycle and message
 * construction. It accepts callbacks rather than importing StreamSessionManager
 * internals, avoiding circular dependencies.
 */
export interface AnnouncerDependencies {
  /** Snapshot of current session identity (called each tick). */
  getState: () => AnnouncerSessionSnapshot;
  /** Guard: true when the session is in the "active" state. */
  isActive: () => boolean;
  /** Guard: true when the session has been destroyed. */
  isDestroyed: () => boolean;
  /** Build the current StreamAnnouncement for reannounce snapshots. */
  buildAnnouncement: () => StreamAnnouncement;
  /** Broadcast a message to the current group. */
  broadcast: (groupId: string, message: Record<string, unknown>) => Promise<unknown>;
}

/**
 * StreamAnnouncer — owns heartbeat and reannounce interval timers
 * for a single local host stream session.
 *
 * Lifecycle:
 *   - Created with narrow callbacks into the owning StreamSessionManager.
 *   - startHeartbeat() / stopHeartbeat() manage a 10s heartbeat interval.
 *   - startReannounce() / stopReannounce() manage a 3.5s reannounce interval.
 *   - stopAll() stops both timers and resets the heartbeat sequence counter.
 *
 * Payloads, intervals, guard conditions, error handling, and cleanup order
 * exactly match the previous inline implementation in StreamSessionManager.
 */
export class StreamAnnouncer {
  private _heartbeatSeq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reannounceTimer: ReturnType<typeof setInterval> | null = null;
  private deps: AnnouncerDependencies;

  constructor(deps: AnnouncerDependencies) {
    this.deps = deps;
  }

  // ── Read-only access for buildAnnouncement ───────────────────────────

  /** Current heartbeat sequence number — read by buildAnnouncement. */
  get heartbeatSeq(): number {
    return this._heartbeatSeq;
  }

  // ── Heartbeat timer ──────────────────────────────────────────────────

  /** Start the heartbeat interval (10s). No-op if already running. */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, 10_000);
  }

  /** Stop the heartbeat interval. Idempotent. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send a single heartbeat broadcast.
   * Exposed as public for testing — called internally by the interval timer.
   * Guard conditions match the original StreamSessionManager.sendHeartbeat.
   */
  sendHeartbeat(): Promise<void> {
    if (!this.deps.isActive() || this.deps.isDestroyed()) return Promise.resolve();
    const state = this.deps.getState();
    if (!state.groupId || !state.logicalStreamId) return Promise.resolve();

    this._heartbeatSeq++;
    this.deps.broadcast(state.groupId, {
      type: "stream.heartbeat",
      groupId: state.groupId,
      hostDeviceId: state.hostDeviceId,
      hostDisplayName: state.hostDisplayName,
      logicalStreamId: state.logicalStreamId,
      mediaSessionId: state.mediaSessionId,
      heartbeatSequence: this._heartbeatSeq,
      appliedSettingsRevision: 0,
    }).catch(() => {
      // Heartbeat failures are non-fatal — the stream remains active
      // and the next heartbeat will retry.
    });
    return Promise.resolve();
  }

  // ── Reannounce timer ─────────────────────────────────────────────────

  /** Start the reannounce interval (3.5s). No-op if already running. */
  startReannounce(): void {
    if (this.reannounceTimer) return;
    this.reannounceTimer = setInterval(() => {
      void this.sendReannounce();
    }, 3_500);
  }

  /** Stop the reannounce interval. Idempotent. */
  stopReannounce(): void {
    if (this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = null;
    }
  }

  /**
   * Send a single reannounce (stream.state.snapshot) broadcast.
   * Exposed as public for testing — called internally by the interval timer.
   * Guard conditions match the original StreamSessionManager.sendReannounce.
   */
  sendReannounce(): Promise<void> {
    if (!this.deps.isActive() || this.deps.isDestroyed()) return Promise.resolve();
    const state = this.deps.getState();
    if (!state.groupId || !state.logicalStreamId) return Promise.resolve();

    const announcement = this.deps.buildAnnouncement();
    this.deps.broadcast(state.groupId, {
      type: "stream.state.snapshot",
      streams: [announcement],
    }).catch(() => {
      // Re-announce failures are non-fatal.
    });
    return Promise.resolve();
  }

  // ── Bulk lifecycle ───────────────────────────────────────────────────

  /** Stop all timers. Does NOT reset the heartbeat sequence. */
  stopAll(): void {
    this.stopHeartbeat();
    this.stopReannounce();
  }

  /**
   * Reset the heartbeat sequence counter to zero.
   * Called at the start of a fresh stream or restart.
   */
  resetHeartbeatSeq(): void {
    this._heartbeatSeq = 0;
  }
}
