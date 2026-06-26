// @vitest-environment node
/**
 * Mock VDO SDK used by group-control-signed-runtime.test.ts.
 *
 * Each new MockSDK instance is a stand-in for a real VDONinja SDK.
 * The full data-only mesh lifecycle is supported: connect → joinRoom →
 * announce → sendData. The mock delivers envelopes between two peers
 * via installRouting.
 */

export interface SentRecord {
  to: string;
  payload: Record<string, unknown>;
}

type DataHandler = (data: unknown, peerUuid: string) => void;
type PeerHandler = (uuid: string) => void;
type StateHandler = (state: string) => void;

export class MockSDK {
  private dataHandler: DataHandler | null = null;
  private peerJoinedHandler: PeerHandler | null = null;
  private peerLeftHandler: PeerHandler | null = null;
  private stateHandler: StateHandler | null = null;
  public sent: SentRecord[] = [];
  /** Routing hook set by installRouting. */
  public onSend?: (data: unknown, to: string) => void;
  public state: { connected: boolean; roomJoined: boolean; room: string | null } = {
    connected: false,
    roomJoined: false,
    room: null,
  };
  public announceId: string | null = null;

  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === "dataReceived") this.dataHandler = listener as DataHandler;
    if (event === "peerConnected") this.peerJoinedHandler = listener as PeerHandler;
    if (event === "peerDisconnected") this.peerLeftHandler = listener as PeerHandler;
    if (event === "disconnected" || event === "reconnected" || event === "reconnectFailed") {
      this.stateHandler = listener as StateHandler;
    }
  }

  off(_event: string, _listener: (...args: unknown[]) => void): void {
    // No-op: the mock keeps a single handler per event slot, replaced
    // by the latest listener installed via on(). This matches the
    // real SDK's behavior of allowing a single listener per slot via on().
  }

  removeAllListeners(): void {
    this.dataHandler = null;
    this.peerJoinedHandler = null;
    this.peerLeftHandler = null;
    this.stateHandler = null;
  }

  async connect(): Promise<void> {
    this.state.connected = true;
  }

  async disconnect(): Promise<void> {
    this.state.connected = false;
    this.state.roomJoined = false;
    this.state.room = null;
    this.stateHandler?.("disconnected");
  }

  async joinRoom(options: { room: string; password?: string }): Promise<void> {
    this.state.roomJoined = true;
    this.state.room = options.room;
  }

  async leaveRoom(): Promise<void> {
    this.state.roomJoined = false;
    this.state.room = null;
  }

  async announce(options: { streamID?: string }): Promise<string> {
    this.announceId = options.streamID ?? "announce";
    return this.announceId;
  }

  async sendData(data: unknown, options: { uuid?: string }): Promise<void> {
    this.sent.push({ to: options.uuid ?? "*", payload: data as Record<string, unknown> });
    if (options.uuid && this.onSend) {
      this.onSend(data, options.uuid);
    }
  }

  deliver(data: unknown, fromPeerUuid: string): void {
    this.dataHandler?.(data, fromPeerUuid);
  }

  peerJoined(uuid: string): void {
    this.peerJoinedHandler?.(uuid);
  }

  peerLeft(uuid: string): void {
    this.peerLeftHandler?.(uuid);
  }

  /** Drain the in-process microtask queue so routed deliveries land. */
  static async tick(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
  }
}

interface Room {
  alice: MockSDK;
  bob: MockSDK;
}

export function makeRoom(): Room {
  return { alice: new MockSDK(), bob: new MockSDK() };
}

/**
 * Wire Alice.sendData("bob") to Bob.deliver(_, "alice") and vice versa.
 */
export function installRouting(room: Room): void {
  room.alice.onSend = (data, to) => {
    if (to === "bob") {
      void Promise.resolve().then(() => room.bob.deliver(data, "alice"));
    }
  };
  room.bob.onSend = (data, to) => {
    if (to === "alice") {
      void Promise.resolve().then(() => room.alice.deliver(data, "bob"));
    }
  };
}
