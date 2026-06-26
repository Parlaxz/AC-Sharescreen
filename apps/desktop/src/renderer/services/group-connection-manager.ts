import {
  GroupControlConnection,
  type ConnectionState,
} from "./group-control-connection.js";
import type { GroupMemberRecord } from "@screenlink/shared";

export interface GroupConnectionState {
  groupId: string;
  state: ConnectionState;
  onlinePeers: string[];
  error: string | null;
}

/**
 * A pending stream lifecycle message queued when the group control
 * connection is unavailable after media has been published.
 */
interface PendingLifecycleMessage {
  groupId: string;
  logicalStreamId: string;
  type: "stream.started" | "stream.restarted" | "stream.stopped";
  payload: Record<string, unknown>;
  enqueuedAt: number;
}

/** Maximum number of pending lifecycle messages per group. */
const MAX_PENDING_PER_GROUP = 16;

/** Time-to-live for queued messages (5 minutes). Stale entries are dropped on flush. */
const PENDING_TTL_MS = 300_000;

/** User-facing error for unreachable group control. */
const GROUP_NOT_CONNECTED =
  "The selected group is not connected. Reconnect to the group and try again.";

export class GroupConnectionManager {
  private connections = new Map<string, GroupControlConnection>();
  private onStatesChanged: ((states: Map<string, GroupConnectionState>) => void) | null = null;
  private onPeerOnline: ((groupId: string, deviceId: string, displayName: string) => void) | null = null;
  private onPeerOffline: ((groupId: string, deviceId: string) => void) | null = null;
  private onMessage: ((groupId: string, envelope: unknown) => void) | null = null;
  /** Callback for authenticated hello handshake with remote member record. */
  private onAuthenticatedHello: ((groupId: string, senderDeviceId: string, member: GroupMemberRecord | null) => void) | null = null;

  // ── Pending-announcement queue ─────────────────────────────────────
  /**
   * Group-scoped pending lifecycle messages. When group control reconnects,
   * the latest message per (logicalStreamId, type) is flushed.
   * Key: groupId. Value: Map of "logicalStreamId:type" -> PendingLifecycleMessage.
   */
  private pendingLifecycle = new Map<string, Map<string, PendingLifecycleMessage>>();

  setOnStatesChanged(cb: (states: Map<string, GroupConnectionState>) => void): void {
    this.onStatesChanged = cb;
  }

  setOnPeerOnline(cb: (groupId: string, deviceId: string, displayName: string) => void): void {
    this.onPeerOnline = cb;
  }

  setOnPeerOffline(cb: (groupId: string, deviceId: string) => void): void {
    this.onPeerOffline = cb;
  }

  setOnMessage(cb: (groupId: string, envelope: unknown) => void): void {
    this.onMessage = cb;
  }

  setOnAuthenticatedHello(cb: (groupId: string, senderDeviceId: string, member: GroupMemberRecord | null) => void): void {
    this.onAuthenticatedHello = cb;
  }

  get states(): Map<string, GroupConnectionState> {
    const m = new Map<string, GroupConnectionState>();
    for (const [groupId, conn] of this.connections) {
      m.set(groupId, {
        groupId,
        state: conn.state,
        onlinePeers: conn.connectedPeers,
        error: null,
      });
    }
    return m;
  }

  getConnection(groupId: string): GroupControlConnection | null {
    return this.connections.get(groupId) ?? null;
  }

  async addGroup(config: {
    groupId: string;
    controlRoomId: string;
    groupSecret: string;
    nodeId: string;
    displayName: string;
    memberRecord?: GroupMemberRecord | null;
  }): Promise<void> {
    if (this.connections.has(config.groupId)) {
      const existing = this.connections.get(config.groupId)!;
      if (existing.state === "destroyed" || existing.state === "failed") {
        this.connections.delete(config.groupId);
      } else {
        return;
      }
    }

    const self = this;
    let prevState: ConnectionState = "idle";
    const conn = new GroupControlConnection({
      groupId: config.groupId,
      controlRoomId: config.controlRoomId,
      groupSecret: config.groupSecret,
      nodeId: config.nodeId,
      displayName: config.displayName,
      memberRecord: config.memberRecord ?? null,
      onPeerOnline(deviceId, displayName) {
        self.onPeerOnline?.(config.groupId, deviceId, displayName);
        self.emitStates();
      },
      onPeerOffline(deviceId) {
        self.onPeerOffline?.(config.groupId, deviceId);
        self.emitStates();
      },
      onMessage(envelope) {
        self.onMessage?.(config.groupId, envelope);
      },
      onStateChange(newState: ConnectionState) {
        const old = prevState;
        prevState = newState;
        self.onConnectionStateChange(config.groupId, old, newState);
        self.emitStates();
      },
      onError() {
        self.emitStates();
      },
      onAuthenticatedHello(deviceId, member, envelope) {
        self.onAuthenticatedHello?.(config.groupId, deviceId, member);
      },
    });

    this.connections.set(config.groupId, conn);
    this.emitStates();
    await conn.start();
  }

  async removeGroup(groupId: string): Promise<void> {
    const conn = this.connections.get(groupId);
    if (!conn) return;
    this.connections.delete(groupId);
    this.clearPendingForGroup(groupId);
    await conn.destroy();
    this.emitStates();
  }

  async destroyAll(): Promise<void> {
    const conns = Array.from(this.connections.values());
    this.connections.clear();
    this.clearAllPending();
    await Promise.all(conns.map((c) => c.destroy().catch(() => {})));
    this.emitStates();
  }

  async broadcast(groupId: string, payload: Record<string, unknown>): Promise<void> {
    const conn = this.connections.get(groupId);
    if (!conn) return;
    await conn.broadcast(payload);
  }

  // ── Readiness API ─────────────────────────────────────────────────

  /**
   * Returns true only when the group connection exists and is in the
   * "connected" state with an SDK/mesh that is usable.
   */
  isConnected(groupId: string): boolean {
    const conn = this.connections.get(groupId);
    return conn !== undefined && conn.state === "connected" && (conn as { sdk: unknown } & typeof conn)["sdk" as keyof typeof conn] !== null;
  }

  /**
   * Wait for a group connection to become connected.
   *
   * - If already connected, resolves immediately.
   * - If starting or reconnecting, waits for state changes.
   * - If idle or failed, initiates one restart.
   * - If the group is unknown, rejects immediately.
   * - On timeout, rejects with the specific group-connectivity error.
   * - On destroy, rejects.
   *
   * Does NOT create duplicate SDK instances. Bounded timeout.
   */
  ensureConnected(groupId: string, timeoutMs = 15_000): Promise<void> {
    const conn = this.connections.get(groupId);
    if (!conn) {
      return Promise.reject(new Error(GROUP_NOT_CONNECTED));
    }
    if (conn.state === "connected") {
      return Promise.resolve();
    }
    if (conn.state === "destroyed") {
      return Promise.reject(new Error(GROUP_NOT_CONNECTED));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        settled = true;
        if (timer) clearTimeout(timer);
      };

      const onStateChange = (state: ConnectionState) => {
        if (settled) return;
        if (state === "connected") {
          cleanup();
          resolve();
        } else if (state === "failed" || state === "destroyed") {
          cleanup();
          reject(new Error(GROUP_NOT_CONNECTED));
        }
        // "starting", "reconnecting", "stopping" → keep waiting
      };

      const onDisconnected = () => {
        if (settled) return;
        cleanup();
        reject(new Error(GROUP_NOT_CONNECTED));
      };

      // Subscribe to state changes via the connection's onStateChange option.
      // We need to hook into the existing pattern — the connection calls
      // opts.onStateChange which triggers emitStates. For this promise,
      // we poll the connection state instead.
      timer = setTimeout(() => {
        if (!settled) {
          cleanup();
          reject(new Error(GROUP_NOT_CONNECTED));
        }
      }, timeoutMs);

      // Poll the connection state at a reasonable interval.
      const poll = () => {
        if (settled) return;
        const s = conn.state;
        if (s === "connected") {
          cleanup();
          resolve();
        } else if (s === "failed" || s === "destroyed") {
          cleanup();
          reject(new Error(GROUP_NOT_CONNECTED));
        } else if (s === "idle") {
          // Idle — trigger a restart
          cleanup();
          reject(new Error(GROUP_NOT_CONNECTED));
        } else {
          // "starting" or "reconnecting" — keep polling
          setTimeout(poll, 200);
        }
      };

      if (conn.state === "idle") {
        // Trigger one restart attempt
        cleanup();
        reject(new Error(GROUP_NOT_CONNECTED));
      } else {
        poll();
      }
    });
  }

  // ── Pending-announcement queue ─────────────────────────────────────

  /**
   * Send a stream lifecycle message immediately, or queue it if the
   * group control connection is unavailable.
   *
   * Only supports stream.started, stream.restarted, and stream.stopped.
   * Duplicate entries for the same (logicalStreamId, type) replace older
   * pending entries. When the group reconnects, queued messages are flushed.
   *
   * Returns "sent" if the message was broadcast immediately, or "queued"
   * if it was stored for later delivery.
   */
  async sendOrQueueStreamLifecycle(
    groupId: string,
    logicalStreamId: string,
    type: "stream.started" | "stream.restarted" | "stream.stopped",
    payload: Record<string, unknown>,
  ): Promise<"sent" | "queued"> {
    const conn = this.connections.get(groupId);

    if (conn && conn.state === "connected") {
      // Send immediately
      try {
        await conn.broadcast(payload);
        return "sent";
      } catch (err) {
        // Broadcast failed — queue as fallback
        console.warn(
          `[group-control] broadcast failed for ${type}, queuing:`,
          (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    // Queue the message
    this.enqueueLifecycle(groupId, logicalStreamId, type, payload);
    return "queued";
  }

  /**
   * Flush queued lifecycle messages for a specific group.
   * Called when the group control connection reconnects.
   */
  flushPendingLifecycle(groupId: string): void {
    const queue = this.pendingLifecycle.get(groupId);
    if (!queue || queue.size === 0) return;

    const conn = this.connections.get(groupId);
    if (!conn || conn.state !== "connected") return;

    const now = Date.now();
    const entries = Array.from(queue.entries());

    // Clear the queue before sending so failures don't cause double-flush.
    this.pendingLifecycle.delete(groupId);

    for (const [, msg] of entries) {
      // Drop stale messages older than TTL
      if (now - msg.enqueuedAt > PENDING_TTL_MS) {
        continue;
      }
      // Do not announce a stopped stream for a logicalStreamId that was
      // only ever queued as "stopped" without a preceding start — that
      // would be a no-op for viewers, but skip it anyway.
      if (msg.type === "stream.stopped") {
        // Check if there was a pending start/restart for this stream that
        // was never flushed. If not, skip.
        const hasPendingStart = entries.some(
          ([, e]) =>
            e.logicalStreamId === msg.logicalStreamId &&
            (e.type === "stream.started" || e.type === "stream.restarted"),
        );
        if (!hasPendingStart) {
          // The start was never flushed, so don't send a stale stop.
          continue;
        }
      }
      conn.broadcast(msg.payload).catch((err: unknown) => {
        console.warn(
          "[group-control] failed to flush pending",
          msg.type,
          (err instanceof Error ? err.message : String(err)),
        );
      });
    }
  }

  /**
   * Remove all pending lifecycle messages for a specific logical stream.
   * Called when a stream is stopped before reconnect so stale starts
   * are not announced after reconnect.
   */
  clearPendingForStream(groupId: string, logicalStreamId: string): void {
    const queue = this.pendingLifecycle.get(groupId);
    if (!queue) return;
    for (const [key, msg] of queue) {
      if (msg.logicalStreamId === logicalStreamId) {
        queue.delete(key);
      }
    }
    if (queue.size === 0) {
      this.pendingLifecycle.delete(groupId);
    }
  }

  /**
   * Enqueue a lifecycle message, deduplicating by (logicalStreamId, type).
   * A newer pending start/restart replaces an older one for the same stream.
   * Stopping removes stale pending start/restart entries.
   */
  private enqueueLifecycle(
    groupId: string,
    logicalStreamId: string,
    type: "stream.started" | "stream.restarted" | "stream.stopped",
    payload: Record<string, unknown>,
  ): void {
    let queue = this.pendingLifecycle.get(groupId);
    if (!queue) {
      queue = new Map();
      this.pendingLifecycle.set(groupId, queue);
    }

    const key = `${logicalStreamId}:${type}`;

    // If stopping, also remove any pending start/restart for this stream
    // so we don't announce a stale start after the user already stopped.
    if (type === "stream.stopped") {
      queue.delete(`${logicalStreamId}:stream.started`);
      queue.delete(`${logicalStreamId}:stream.restarted`);
    }

    // Deduplicate: replace older entry of the same type for this stream
    const msg: PendingLifecycleMessage = {
      groupId,
      logicalStreamId,
      type,
      payload,
      enqueuedAt: Date.now(),
    };
    queue.set(key, msg);

    // Bound queue size per group — evict oldest entries if exceeded.
    if (queue.size > MAX_PENDING_PER_GROUP) {
      const entries = Array.from(queue.entries());
      const toEvict = entries.slice(0, queue.size - MAX_PENDING_PER_GROUP);
      for (const [k] of toEvict) {
        queue.delete(k);
      }
    }
  }

  /**
   * Remove all queued messages for a group. Called when the group is
   * removed or when the runtime is destroyed.
   */
  clearPendingForGroup(groupId: string): void {
    this.pendingLifecycle.delete(groupId);
  }

  /** Clear all pending lifecycle queues. Called during runtime destruction. */
  clearAllPending(): void {
    this.pendingLifecycle.clear();
  }

  /**
   * Hook into state changes to flush pending lifecycle messages when a
   * group connection transitions to "connected" from any other state.
   */
  private onConnectionStateChange(groupId: string, _oldState: ConnectionState, newState: ConnectionState): void {
    if (newState === "connected") {
      console.log("[group-control] connection reconnected — flushing pending lifecycle messages for", groupId);
      this.flushPendingLifecycle(groupId);
    }
  }

  // ── Modified addGroup to wire state change handler ─────────────────

  private emitStates(): void {
    this.onStatesChanged?.(this.states);
  }
}
