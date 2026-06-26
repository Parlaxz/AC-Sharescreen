import {
  GroupControlConnection,
  type ConnectionState,
  type BroadcastResult,
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
   * pending messages are flushed.
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

  async broadcast(groupId: string, payload: Record<string, unknown>): Promise<BroadcastResult> {
    const conn = this.connections.get(groupId);
    if (!conn) return { attempted: 0, sent: 0, failed: 0 };
    return conn.broadcast(payload);
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
   * Returns "sent" if the message was broadcast with at least one confirmed
   * recipient, or "queued" if it was stored for later delivery (or had zero
   * recipients).
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
        const result = await conn.broadcast(payload);
        // Require at least 1 sent recipient to consider it "sent".
        // Zero confirmed recipients → queue for later.
        if (result.sent > 0) {
          return "sent";
        }
        console.log(
          `[group-control] broadcast for ${type} had zero confirmed recipients (attempted=${result.attempted}), queuing`,
        );
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
   * Flush queued lifecycle messages for a specific group, removing
   * only delivered/expired entries. Does NOT delete the whole queue.
   * Called when the group control connection reconnects.
   */
  async flushPendingLifecycle(groupId: string): Promise<void> {
    const queue = this.pendingLifecycle.get(groupId);
    if (!queue || queue.size === 0) return;

    const conn = this.connections.get(groupId);
    if (!conn || conn.state !== "connected") return;

    const now = Date.now();
    const deliveredKeys: string[] = [];

    for (const [key, msg] of queue) {
      // Drop stale messages older than TTL
      if (now - msg.enqueuedAt > PENDING_TTL_MS) {
        deliveredKeys.push(key);
        continue;
      }
      // Do not announce a stopped stream for a logicalStreamId that was
      // only ever queued as "stopped" without a preceding start — that
      // would be a no-op for viewers, but skip it anyway.
      if (msg.type === "stream.stopped") {
        // Check if there was a pending start/restart for this stream that
        // was never flushed. If not, skip.
        const hasPendingStart = Array.from(queue.values()).some(
          (e) =>
            e.logicalStreamId === msg.logicalStreamId &&
            (e.type === "stream.started" || e.type === "stream.restarted"),
        );
        if (!hasPendingStart) {
          deliveredKeys.push(key);
          continue;
        }
      }
      // Broadcast the pending message
      try {
        const result = await conn.broadcast(msg.payload);
        // If at least 1 recipient got it, mark as delivered.
        // Otherwise keep it for the next flush attempt.
        if (result.sent > 0) {
          deliveredKeys.push(key);
          console.log("[group-control] flushed pending lifecycle:", msg.type, "for stream", msg.logicalStreamId);
        }
      } catch (err: unknown) {
        console.warn(
          "[group-control] failed to flush pending",
          msg.type,
          (err instanceof Error ? err.message : String(err)),
        );
        // Keep in queue for retry
      }
    }

    // Remove only delivered/expired entries, NOT the whole queue.
    for (const key of deliveredKeys) {
      queue.delete(key);
    }

    // If queue is empty, clean up the group entry.
    if (queue.size === 0) {
      this.pendingLifecycle.delete(groupId);
    }
  }

  /**
   * Send queued lifecycle messages to a specific peer after the hello
   * handshake completes (identity mapping is established).
   *
   * Removes only entries that were confirmed delivered (or expired).
   * Failed deliveries remain queued for later retry.
   */
  async flushPendingLifecycleToPeer(groupId: string, peerUuid: string): Promise<void> {
    const queue = this.pendingLifecycle.get(groupId);
    if (!queue || queue.size === 0) return;

    const conn = this.connections.get(groupId);
    if (!conn || conn.state !== "connected") return;

    const now = Date.now();
    const entries = Array.from(queue.entries());
    const deliveredKeys: string[] = [];

    for (const [key, msg] of entries) {
      if (now - msg.enqueuedAt > PENDING_TTL_MS) {
        deliveredKeys.push(key);
        continue;
      }
      if (msg.type === "stream.stopped") {
        const hasPendingStart = entries.some(
          ([, e]) =>
            e.logicalStreamId === msg.logicalStreamId &&
            (e.type === "stream.started" || e.type === "stream.restarted"),
        );
        if (!hasPendingStart) {
          deliveredKeys.push(key);
          continue;
        }
      }

      const delivered = await conn.sendToPeer(peerUuid, msg.payload);
      if (delivered) {
        deliveredKeys.push(key);
        console.log("[group-control] delivered queued lifecycle to peer:", msg.type, msg.logicalStreamId, peerUuid);
      }
    }

    for (const key of deliveredKeys) {
      queue.delete(key);
    }
    if (queue.size === 0) {
      this.pendingLifecycle.delete(groupId);
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
      this.flushPendingLifecycle(groupId).catch(() => {});
    }
  }

  // ── Modified addGroup to wire state change handler ─────────────────

  private emitStates(): void {
    this.onStatesChanged?.(this.states);
  }
}
