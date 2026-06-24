import {
  GroupControlConnection,
  type ConnectionState,
} from "./group-control-connection.js";

export interface GroupConnectionState {
  groupId: string;
  state: ConnectionState;
  onlinePeers: string[];
  error: string | null;
}

export class GroupConnectionManager {
  private connections = new Map<string, GroupControlConnection>();
  private onStatesChanged: ((states: Map<string, GroupConnectionState>) => void) | null = null;
  private onPeerOnline: ((groupId: string, deviceId: string, displayName: string) => void) | null = null;
  private onPeerOffline: ((groupId: string, deviceId: string) => void) | null = null;
  private onMessage: ((groupId: string, envelope: unknown) => void) | null = null;

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
    const conn = new GroupControlConnection({
      groupId: config.groupId,
      controlRoomId: config.controlRoomId,
      groupSecret: config.groupSecret,
      nodeId: config.nodeId,
      displayName: config.displayName,
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
      onStateChange() {
        self.emitStates();
      },
      onError() {
        self.emitStates();
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
    await conn.destroy();
    this.emitStates();
  }

  async destroyAll(): Promise<void> {
    const conns = Array.from(this.connections.values());
    this.connections.clear();
    await Promise.all(conns.map((c) => c.destroy().catch(() => {})));
    this.emitStates();
  }

  async broadcast(groupId: string, payload: Record<string, unknown>): Promise<void> {
    const conn = this.connections.get(groupId);
    if (!conn) return;
    await conn.broadcast(payload);
  }

  private emitStates(): void {
    this.onStatesChanged?.(this.states);
  }
}
