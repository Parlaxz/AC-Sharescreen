import type {
  GroupControlEnvelope,
  GroupControlEnvelopeInput,
  HybridTimestamp,
} from "@screenlink/shared";
import {
  GROUP_PROTOCOL_VERSION,
  buildEnvelope,
  verifyEnvelope,
  DedupSet,
} from "@screenlink/shared";
import { getSDKConstructor } from "@screenlink/vdo-adapter";

export type ConnectionState = "idle" | "starting" | "connected" | "reconnecting" | "stopping" | "destroyed" | "failed";

export interface GroupControlConnectionOptions {
  groupId: string;
  controlRoomId: string;
  groupSecret: string;
  nodeId: string;
  displayName: string;
  onPeerOnline: (deviceId: string, displayName: string) => void;
  onPeerOffline: (deviceId: string) => void;
  onMessage: (envelope: GroupControlEnvelope) => void;
  onStateChange: (state: ConnectionState) => void;
  onError: (error: Error) => void;
}

function makeClock(nodeId: string, now?: number): HybridTimestamp {
  return { wallTimeMs: now ?? Date.now(), counter: 0, nodeId };
}

function makeInput(
  type: string,
  senderDeviceId: string,
  groupId: string,
  payload: Record<string, unknown>,
  stamp: HybridTimestamp,
): GroupControlEnvelopeInput {
  return {
    version: GROUP_PROTOCOL_VERSION,
    type: type as GroupControlEnvelopeInput["type"],
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId,
    groupId,
    logicalStamp: stamp,
    payload,
  };
}

export class GroupControlConnection {
  private sdk: ReturnType<ReturnType<typeof getSDKConstructor>> | null = null;
  private peerToDevice = new Map<string, string>();
  private deviceToPeer = new Map<string, string>();
  private _state: ConnectionState = "idle";
  private opts: GroupControlConnectionOptions;
  private destroyed = false;
  private startGeneration = 0;
  private dedupSet = new DedupSet();
  private clock: HybridTimestamp;

  constructor(opts: GroupControlConnectionOptions) {
    this.opts = opts;
    this.clock = makeClock(opts.nodeId);
  }

  get state(): ConnectionState {
    return this._state;
  }

  get groupId(): string {
    return this.opts.groupId;
  }

  get connectedPeers(): string[] {
    return Array.from(this.peerToDevice.keys());
  }

  get knownDevices(): Map<string, string> {
    return new Map(this.deviceToPeer);
  }

  peerForDevice(deviceId: string): string | null {
    return this.deviceToPeer.get(deviceId) ?? null;
  }

  deviceForPeer(peerUuid: string): string | null {
    return this.peerToDevice.get(peerUuid) ?? null;
  }

  async start(): Promise<void> {
    if (this.destroyed) return;
    if (this._state === "starting" || this._state === "connected") return;
    this.startGeneration++;
    const gen = this.startGeneration;
    this.setState("starting");

    try {
      const ctor = getSDKConstructor();
      const sdk = new ctor({
        host: "https://api.vdo.ninja",
        password: this.opts.controlRoomId,
        salt: this.opts.groupSecret.slice(0, 16),
        debug: false,
        maxReconnectAttempts: 5,
        reconnectDelay: 2000,
      }) as ReturnType<ReturnType<typeof getSDKConstructor>>;

      this.sdk = sdk;
      this.setupEventHandlers(gen);

      await sdk.connect();
      if (gen !== this.startGeneration || this.destroyed) {
        await sdk.disconnect().catch(() => {});
        return;
      }
      this.setState("connected");
      // Send hello to any already-connected peers
      this.broadcastHello().catch(() => {});
    } catch (err) {
      if (this.destroyed || gen !== this.startGeneration) return;
      this.setState("failed");
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.startGeneration++;
    this.setState("destroyed");
    const sdk = this.sdk;
    this.sdk = null;
    this.peerToDevice.clear();
    this.deviceToPeer.clear();
    if (sdk) {
      try { await sdk.disconnect(); } catch { /* ignore */ }
    }
  }

  async sendToPeer(peerUuid: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.sdk) throw new Error("Not connected");
    const input = makeInput(payload.type as string, this.opts.nodeId, this.opts.groupId, payload, this.clock);
    const envelope = await buildEnvelope(input, this.opts.groupSecret);
    await this.sdk.sendData(envelope as unknown as Record<string, unknown>, {
      uuid: peerUuid,
      type: "publisher",
      allowFallback: false,
    });
  }

  async broadcast(payload: Record<string, unknown>): Promise<void> {
    if (!this.sdk) throw new Error("Not connected");
    const input = makeInput(payload.type as string, this.opts.nodeId, this.opts.groupId, payload, this.clock);
    const envelope = await buildEnvelope(input, this.opts.groupSecret);
    const peers = this.connectedPeers;
    for (const peerUuid of peers) {
      try {
        await this.sdk.sendData(envelope as unknown as Record<string, unknown>, {
          uuid: peerUuid,
          type: "publisher",
          allowFallback: false,
        });
      } catch {
        // best effort
      }
    }
  }

  async broadcastHello(): Promise<void> {
    await this.broadcast({
      type: "group.hello",
      deviceId: this.opts.nodeId,
      displayName: this.opts.displayName,
      protocolVersion: GROUP_PROTOCOL_VERSION,
    });
  }

  private setState(s: ConnectionState): void {
    if (this._state !== s) {
      this._state = s;
      this.opts.onStateChange(s);
    }
  }

  private setupEventHandlers(gen: number): void {
    const sdk = this.sdk;
    if (!sdk) return;

    sdk.on("peerConnected", (peerUuid: string) => {
      if (gen !== this.startGeneration || this.destroyed) return;
      this.sendToPeer(peerUuid, {
        type: "group.hello",
        deviceId: this.opts.nodeId,
        displayName: this.opts.displayName,
        protocolVersion: GROUP_PROTOCOL_VERSION,
      }).catch(() => {});
    });

    sdk.on("peerDisconnected", (peerUuid: string) => {
      if (gen !== this.startGeneration || this.destroyed) return;
      const deviceId = this.peerToDevice.get(peerUuid);
      if (deviceId) {
        this.peerToDevice.delete(peerUuid);
        this.deviceToPeer.delete(deviceId);
        this.opts.onPeerOffline(deviceId);
      }
    });

    sdk.on("dataReceived", async (data: unknown, peerUuid: string) => {
      if (gen !== this.startGeneration || this.destroyed) return;
      try {
        const envelope = data as GroupControlEnvelope;
        const valid = await verifyEnvelope(envelope, this.opts.groupSecret);
        if (!valid) return;

        // Dedup
        if (this.dedupSet.has(envelope.messageId)) return;
        this.dedupSet.add(envelope.messageId);

        // Auto-map hello messages to device IDs
        if (envelope.type === "group.hello") {
          const deviceId = envelope.senderDeviceId || (envelope.payload?.deviceId as string);
          const displayName = envelope.payload?.displayName as string;
          if (deviceId) {
            const oldPeer = this.deviceToPeer.get(deviceId);
            if (oldPeer && oldPeer !== peerUuid) {
              this.peerToDevice.delete(oldPeer);
            }
            this.peerToDevice.set(peerUuid, deviceId);
            this.deviceToPeer.set(deviceId, peerUuid);
            this.opts.onPeerOnline(deviceId, displayName);
          }
          // Respond with our hello if we haven't mapped them yet
          if (!this.deviceToPeer.has(this.opts.nodeId)) {
            this.broadcastHello().catch(() => {});
          }
        }

        this.opts.onMessage(envelope);
      } catch {
        // Invalid message
      }
    });

    sdk.on("disconnected", () => {
      if (gen !== this.startGeneration || this.destroyed) return;
      this.setState("reconnecting");
      this.peerToDevice.clear();
      this.deviceToPeer.clear();
    });

    sdk.on("reconnected", () => {
      if (gen !== this.startGeneration || this.destroyed) return;
      this.setState("connected");
      this.broadcastHello().catch(() => {});
    });

    sdk.on("reconnectFailed", () => {
      if (gen !== this.startGeneration || this.destroyed) return;
      this.setState("failed");
    });
  }
}
