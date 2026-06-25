// @vitest-environment node
/**
 * Mock VDO SDK used by group-control-signed-runtime.test.ts.
 *
 * Each new MockSDK instance is a stand-in for a real VDONinja SDK.
 * sendData and dataReceived are wired so the test room can route
 * envelopes between two peers.
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

  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === "dataReceived") this.dataHandler = listener as DataHandler;
    if (event === "peerConnected") this.peerJoinedHandler = listener as PeerHandler;
    if (event === "peerDisconnected") this.peerLeftHandler = listener as PeerHandler;
    if (event === "disconnected" || event === "reconnected" || event === "reconnectFailed") {
      this.stateHandler = listener as StateHandler;
    }
  }

  removeAllListeners(): void {
    this.dataHandler = null;
    this.peerJoinedHandler = null;
    this.peerLeftHandler = null;
    this.stateHandler = null;
  }

  async connect(): Promise<void> {
    this.stateHandler?.("connected");
  }

  async disconnect(): Promise<void> {
    this.stateHandler?.("disconnected");
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
