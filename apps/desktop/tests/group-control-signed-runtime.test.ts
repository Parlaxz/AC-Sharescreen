// @vitest-environment node
/**
 * End-to-end signed-envelope exchange proof (HMAC-only).
 *
 * Wires two production GroupControlConnection instances to two
 * mock VDO SDKs and proves:
 *
 *   - Alice and Bob can exchange group.hello.
 *   - Each side establishes the peer mapping (peerUuid → deviceId).
 *   - A state update from Bob reaches Alice.
 *   - A tampered MAC is rejected.
 *   - A wrong-group envelope is rejected.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// We mock the @screenlink/vdo-adapter module so the connection never
// attempts a real network call. The mock returns a fresh MockSDK per
// call. We track all created instances in a shared registry so the
// test can drive them.
const createdSdks: import("./__mocks__/mock-vdo-sdk.js").MockSDK[] = [];

vi.mock("@screenlink/vdo-adapter", () => {
  class MockSDK {
    private dataHandler: ((d: unknown, p: string) => void) | null = null;
    private peerJoinedHandler: ((u: string) => void) | null = null;
    private dataChannelOpenHandler: ((u: string) => void) | null = null;
    private peerLeftHandler: ((u: string) => void) | null = null;
    private stateHandler: ((s: string) => void) | null = null;
    public sent: { to: string; payload: Record<string, unknown> }[] = [];
    public onSend?: (data: unknown, to: string) => void;
    public state: { connected: boolean; roomJoined: boolean; room: string | null } = {
      connected: false,
      roomJoined: false,
      room: null,
    };
    public announceId: string | null = null;
    public _stopFn = vi.fn();

    on(_event: string, _listener: (...args: unknown[]) => void) {
      // No-op — using addEventListener instead
    }
    off(_event: string, _listener: (...args: unknown[]) => void) {
      // No-op
    }
    /** Map of event listeners registered via addEventListener */
    private eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();

    addEventListener(event: string, listener: (...args: unknown[]) => void) {
      if (!this.eventListeners.has(event)) {
        this.eventListeners.set(event, new Set());
      }
      this.eventListeners.get(event)!.add(listener);
      if (event === "dataReceived") this.dataHandler = listener as (d: unknown, p: string) => void;
      if (event === "peerConnected") this.peerJoinedHandler = listener as (u: string) => void;
      if (event === "dataChannelOpen") this.dataChannelOpenHandler = listener as (u: string) => void;
      if (event === "peerDisconnected") this.peerLeftHandler = listener as (u: string) => void;
      if (event === "disconnected" || event === "reconnected" || event === "reconnectFailed") {
        this.stateHandler = listener as (s: string) => void;
      }
    }
    removeEventListener(event: string, listener: (...args: unknown[]) => void) {
      const set = this.eventListeners.get(event);
      if (set) set.delete(listener);
      if (event === "dataReceived") this.dataHandler = null;
      if (event === "peerConnected") this.peerJoinedHandler = null;
      if (event === "dataChannelOpen") this.dataChannelOpenHandler = null;
      if (event === "peerDisconnected") this.peerLeftHandler = null;
      if (event === "disconnected" || event === "reconnected" || event === "reconnectFailed") {
        this.stateHandler = null;
      }
    }
    removeAllListeners() {
      this.eventListeners.clear();
      this.dataHandler = null;
      this.peerJoinedHandler = null;
      this.dataChannelOpenHandler = null;
      this.peerLeftHandler = null;
      this.stateHandler = null;
    }
    async connect() { this.state.connected = true; }
    async disconnect() {
      this.state.connected = false;
      this.state.roomJoined = false;
      this.state.room = null;
      this.stateHandler?.("disconnected");
    }
    async joinRoom(options: { room: string; password?: string }) {
      this.state.roomJoined = true;
      this.state.room = options.room;
    }
    async leaveRoom() {
      this.state.roomJoined = false;
      this.state.room = null;
    }
    async announce(options: { streamID?: string }) {
      this.announceId = options.streamID ?? "announce";
      return this.announceId;
    }
    async autoConnect(options: { room: string; streamID?: string; password?: string }) {
      this.state.connected = true;
      this.state.roomJoined = true;
      this.state.room = options.room;
      this.announceId = options.streamID ?? "announce";
      return { stop: this._stopFn, streamID: this.announceId! };
    }
    sendData(data: unknown, options: { uuid?: string }): boolean {
      this.sent.push({ to: options.uuid ?? "*", payload: data as Record<string, unknown> });
      if (options.uuid && this.onSend) this.onSend(data, options.uuid);
      return true;
    }
    deliver(data: unknown, from: string) { this.dataHandler?.(data, from); }
    peerJoined(u: string) { this.peerJoinedHandler?.(u); }
    dataChannelOpened(u: string) { this.dataChannelOpenHandler?.(u); }
    peerLeft(u: string) { this.peerLeftHandler?.(u); }
  }
  return {
    getSDKConstructor: () => {
      return function () {
        const sdk = new MockSDK();
        createdSdks.push(sdk as unknown as import("./__mocks__/mock-vdo-sdk.js").MockSDK);
        return sdk;
      };
    },
  };
});

import { GroupControlConnection } from "../src/renderer/services/group-control-connection.js";
import type { GroupControlEnvelope } from "@screenlink/shared";

const GROUP_ID = "11111111-1111-4111-1111-111111111111";
const GROUP_SECRET = "test-secret-12345678";
const CONTROL_ROOM = "control-room-1";

interface Rec {
  online: string[];
  offline: string[];
  messages: GroupControlEnvelope[];
}

function makeCallbacks(record: Rec) {
  return {
    onPeerOnline: (d: string) => record.online.push(d),
    onPeerOffline: (d: string) => record.offline.push(d),
    onMessage: (m: GroupControlEnvelope) => record.messages.push(m),
    onStateChange: () => {},
    onError: (e: Error) => { throw e; },
  };
}

interface MockSDKInstance {
  sent: { to: string; payload: Record<string, unknown> }[];
  onSend?: (data: unknown, to: string) => void;
  deliver: (data: unknown, from: string) => void;
  peerJoined: (uuid: string) => void;
  dataChannelOpened: (uuid: string) => void;
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

async function waitFor<T>(getter: () => T | null, maxTicks = 30): Promise<T> {
  for (let i = 0; i < maxTicks; i++) {
    const result = getter();
    if (result !== null && result !== undefined) return result;
    await tick();
  }
  throw new Error("waitFor timed out");
}

/**
 * Wait until `getter()` has reported the same value as `expected` for
 * at least 3 consecutive ticks. This proves the count is stable and
 * no further asynchronous messages are in flight.
 */
async function waitForStableCount(
  getter: () => number,
  expected: number,
  stableTicks = 3,
  maxTicks = 30,
): Promise<number> {
  let stable = 0;
  for (let i = 0; i < maxTicks; i++) {
    if (getter() === expected) {
      stable++;
      if (stable >= stableTicks) return expected;
    } else {
      stable = 0;
    }
    await tick();
  }
  // Return whatever the current count is rather than throwing — the
  // assertion below will surface the discrepancy.
  return getter();
}

function installRouting(alice: MockSDKInstance, bob: MockSDKInstance) {
  alice.onSend = (data, to) => {
    if (to === "bob") void Promise.resolve().then(() => bob.deliver(data, "alice"));
  };
  bob.onSend = (data, to) => {
    if (to === "alice") void Promise.resolve().then(() => alice.deliver(data, "bob"));
  };
}

describe("GroupControlConnection signed exchange (HMAC-only)", () => {
  beforeEach(() => {
    createdSdks.length = 0;
  });

  it("Alice and Bob exchange group.hello and establish peer mappings", async () => {
    const aliceRecord: Rec = { online: [], offline: [], messages: [] };
    const bobRecord: Rec = { online: [], offline: [], messages: [] };

    const alice = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(aliceRecord),
    });
    const bob = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "bob",
      displayName: "Bob",
      ...makeCallbacks(bobRecord),
    });

    await alice.start();
    await bob.start();

    const aliceSdk = createdSdks[0]!;
    const bobSdk = createdSdks[1]!;
    installRouting(aliceSdk, bobSdk);

    aliceSdk.peerJoined("bob");
    bobSdk.peerJoined("alice");
    aliceSdk.dataChannelOpened("bob");
    bobSdk.dataChannelOpened("alice");
    for (let i = 0; i < 5; i++) await tick();

    expect(aliceRecord.online).toContain("bob");
    expect(bobRecord.online).toContain("alice");
    expect(alice.deviceForPeer("bob")).toBe("bob");
    expect(bob.deviceForPeer("alice")).toBe("alice");

    await alice.destroy();
    await bob.destroy();
  });

  it("rejects an envelope with a tampered MAC", async () => {
    const aliceRecord: Rec = { online: [], offline: [], messages: [] };
    const bobRecord: Rec = { online: [], offline: [], messages: [] };

    const alice = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(aliceRecord),
    });
    const bob = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "bob",
      displayName: "Bob",
      ...makeCallbacks(bobRecord),
    });

    await alice.start();
    await bob.start();

    const aliceSdk = createdSdks[0]!;
    const bobSdk = createdSdks[1]!;
    installRouting(aliceSdk, bobSdk);

    // Establish mappings so group.state.update can be routed.
    aliceSdk.peerJoined("bob");
    bobSdk.peerJoined("alice");
    aliceSdk.dataChannelOpened("bob");
    bobSdk.dataChannelOpened("alice");
    await tick();
    await tick();

    // Send a valid state update from Bob to Alice.
    await bob.sendToPeer("alice", {
      type: "group.state.update",
      state: { foo: "bar" },
    });
    // Wait for at least one group.state.update from Bob to reach Alice.
    const validUpdateCount = await waitFor(() => {
      const updates = aliceRecord.messages.filter(
        (m) => m.type === "group.state.update",
      );
      return updates.length > 0 ? updates.length : null;
    });
    expect(validUpdateCount).toBeGreaterThanOrEqual(1);

    // Deliver a tampered envelope directly to Alice's SDK.
    const tampered = {
      version: 3,
      type: "group.state.update",
      messageId: crypto.randomUUID(),
      sentAt: Date.now(),
      senderDeviceId: "bob",
      groupId: GROUP_ID,
      logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: "bob" },
      payload: { foo: "evil" },
      mac: "0".repeat(64),
    };
    aliceSdk.deliver(tampered, "bob");
    for (let i = 0; i < 10; i++) await tick();
    // Tampered must be rejected, so the count of valid
    // group.state.update messages must remain unchanged.
    const updatesAfter = aliceRecord.messages.filter(
      (m) => m.type === "group.state.update",
    ).length;
    expect(updatesAfter).toBe(validUpdateCount);

    await alice.destroy();
    await bob.destroy();
  });

  it("rejects an envelope addressed to a different group", async () => {
    const aliceRecord: Rec = { online: [], offline: [], messages: [] };
    const alice = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(aliceRecord),
    });
    await alice.start();
    const aliceSdk = createdSdks[0]!;

    const { buildEnvelope } = await import("@screenlink/shared");
    const wrongGroup = "99999999-9999-4999-9999-999999999999";
    const envelope = await buildEnvelope(
      {
        version: 3,
        type: "group.state.update",
        messageId: crypto.randomUUID(),
        sentAt: Date.now(),
        senderDeviceId: "bob",
        groupId: wrongGroup,
        logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: "bob" },
        payload: {},
      } as never,
      GROUP_SECRET,
    );
    const before = aliceRecord.messages.length;
    aliceSdk.deliver(envelope, "bob");
    await tick();
    expect(aliceRecord.messages.length).toBe(before);

    await alice.destroy();
  });
});
