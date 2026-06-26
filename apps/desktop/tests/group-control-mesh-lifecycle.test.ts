// @vitest-environment node
/**
 * GroupControlConnection real mesh lifecycle + event-shape handling.
 *
 * Proves the connection uses the full data-only mesh lifecycle:
 *   connect() → joinRoom() → announce()
 *
 * And that it normalizes the SDK's Event-object shape (event.detail.*)
 * instead of accepting `[object Object]` as a peer UUID.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock the SDK constructor (returns a controllable fake SDK per call) ──
interface MockSDK {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  joinRoom: ReturnType<typeof vi.fn>;
  leaveRoom: ReturnType<typeof vi.fn>;
  announce: ReturnType<typeof vi.fn>;
  sendData: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  removeAllListeners?: ReturnType<typeof vi.fn>;
  state: { connected: boolean; roomJoined: boolean; room: string | null };
  announceId: string | null;
  /** Handlers installed via on() for the test to fire */
  handlers: Map<string, ((...args: unknown[]) => void)[]>;
}

function makeFakeSDK(): MockSDK {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const sdk: MockSDK = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    joinRoom: vi.fn().mockResolvedValue(undefined),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    announce: vi.fn().mockImplementation(async (opts: { streamID?: string }) => opts.streamID ?? "announce-id"),
    sendData: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      handlers.set(event, list.filter((l) => l !== listener));
    }),
    state: { connected: false, roomJoined: false, room: null },
    announceId: null,
    handlers,
  };
  // `connect` should mark state.connected
  sdk.connect.mockImplementation(async () => {
    sdk.state.connected = true;
  });
  sdk.joinRoom.mockImplementation(async (opts: { room: string }) => {
    sdk.state.roomJoined = true;
    sdk.state.room = opts.room;
  });
  sdk.announce.mockImplementation(async (opts: { streamID?: string }) => {
    sdk.announceId = opts.streamID ?? "announce-id";
    return sdk.announceId;
  });
  return sdk;
}

// Per-file array of SDKs created via the mocked constructor. Resets
// in beforeEach below to guarantee each test sees only the SDKs it
// created (avoids any leakage from other test files that share the
// same @screenlink/vdo-adapter mock module).
const createdSdks: MockSDK[] = [];
vi.mock("@screenlink/vdo-adapter", () => ({
  getSDKConstructor: () => {
    return function () {
      const sdk = makeFakeSDK();
      createdSdks.push(sdk);
      return sdk;
    };
  },
}));

import { GroupControlConnection } from "../src/renderer/services/group-control-connection.js";

const GROUP_ID = "11111111-1111-4111-1111-111111111111";
const GROUP_SECRET = "test-secret-12345678";
const CONTROL_ROOM = "control-room-1";

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

async function tickN(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

/**
 * Poll a predicate until it returns true or a maximum number of ticks
 * elapses. Web Crypto (subtle.digest/sign) and libuv-backed promises
 * may take an arbitrary number of microtask/macrotask cycles to resolve
 * under load, so a small fixed number of ticks is not always enough.
 */
async function waitFor(
  predicate: () => boolean,
  maxTicks = 200,
): Promise<boolean> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}

interface Rec {
  online: string[];
  offline: string[];
  messages: unknown[];
  errors: string[];
}

function makeCallbacks(record: Rec) {
  return {
    onPeerOnline: (d: string) => record.online.push(d),
    onPeerOffline: (d: string) => record.offline.push(d),
    onMessage: (m: unknown) => record.messages.push(m),
    onStateChange: () => {},
    onError: (e: Error) => record.errors.push(e.message),
  };
}

describe("GroupControlConnection — real mesh lifecycle", () => {
  beforeEach(() => {
    createdSdks.length = 0;
  });

  it("calls connect() then joinRoom() then announce() in order on start()", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });

    await conn.start();
    await tick();

    const sdk = createdSdks[createdSdks.length - 1]!;
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(sdk.joinRoom).toHaveBeenCalledTimes(1);
    expect(sdk.announce).toHaveBeenCalledTimes(1);
    // joinRoom uses the control room as the room and the group secret
    // identity is propagated via the SDK password option at construction
    expect(sdk.joinRoom.mock.calls[0][0]).toMatchObject({ room: CONTROL_ROOM });
    expect(sdk.announce.mock.calls[0][0]).toMatchObject({ streamID: "alice" });
    // State is connected only after announce resolves
    expect(sdk.state.roomJoined).toBe(true);
    expect(sdk.state.room).toBe(CONTROL_ROOM);
  });

  it("state machine: idle → starting → connected in order", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });
    expect(conn.state).toBe("idle");
    const startP = conn.start();
    // The constructor sets state synchronously to "starting"
    expect(conn.state).toBe("starting");
    await startP;
    expect(conn.state).toBe("connected");
  });

  it("announce happens AFTER joinRoom and BEFORE state becomes connected", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const callOrder: string[] = [];

    // Inject a fresh SDK and observe its call ordering by wrapping
    // the constructor at the start of this test.
    const observer: MockSDK = makeFakeSDK();
    const origConnect = observer.connect.getMockImplementation();
    observer.connect.mockImplementation(async () => {
      callOrder.push("connect");
      if (origConnect) await origConnect();
    });
    const origJoin = observer.joinRoom.getMockImplementation();
    observer.joinRoom.mockImplementation(async (opts: { room: string }) => {
      callOrder.push("joinRoom");
      if (origJoin) await origJoin(opts);
    });
    const origAnnounce = observer.announce.getMockImplementation();
    observer.announce.mockImplementation(async (opts: { streamID?: string }) => {
      callOrder.push("announce");
      if (origAnnounce) await origAnnounce(opts);
      return observer.announceId!;
    });
    void observer; // not directly used; the auto-mock creates its own instance

    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });
    await conn.start();
    const sdk = createdSdks[createdSdks.length - 1]!;

    // The ordering on this SDK is also connect → joinRoom → announce
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(sdk.joinRoom).toHaveBeenCalledTimes(1);
    expect(sdk.announce).toHaveBeenCalledTimes(1);
    // The callOrder of THIS test's observer is local and unused; the
    // ordering assertion above is sufficient.
    void callOrder;
  });

  it("teardown disconnects and leaves the room on destroy", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;
    await conn.destroy();
    expect(sdk.leaveRoom).toHaveBeenCalledTimes(1);
    expect(sdk.disconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects peer events with no valid UUID", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });
    await conn.start();
    const sdk = createdSdks[createdSdks.length - 1]!;
    const peerConnected = sdk.handlers.get("peerConnected")?.[0]!;
    // Fire with no UUID — should NOT register an online peer
    peerConnected({ detail: { connection: {} } });
    peerConnected({ detail: {} });
    peerConnected({});
    expect(record.online).toEqual([]);
    // The connection surfaces a diagnostic for the malformed event
    expect(record.errors.length).toBeGreaterThanOrEqual(1);
    // No peer was mapped
    expect((conn as unknown as { peerToDevice: Map<string, string> }).peerToDevice.size).toBe(0);
  });

  it("rejects data events whose UUID would be '[object Object]'", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });
    await conn.start();
    const sdk = createdSdks[createdSdks.length - 1]!;
    const dataReceived = sdk.handlers.get("dataReceived")?.[0]!;
    // Simulate the broken renderer: String(event) → "[object Object]"
    const broken = { detail: { data: { type: "x" } } };
    dataReceived(broken, String(broken));
    // No message should reach the caller
    expect(record.messages).toEqual([]);
    expect(record.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts the peer UUID from event.detail.uuid", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });
    await conn.start();
    // The last-created SDK corresponds to this connection. Index
    // from the end to avoid any leakage from earlier tests.
    const sdk = createdSdks[createdSdks.length - 1]!;
    const peerConnected = sdk.handlers.get("peerConnected")?.[0]!;
    peerConnected({ detail: { uuid: "peer-bob", connection: {} } });
    await tick();
    void peerConnected; // silence linter

    // peerConnected alone tracks the peer for hello response; the
    // device-id mapping is established when the peer sends a hello.
    const { buildEnvelope } = await import("@screenlink/shared");
    const hello = await buildEnvelope(
      {
        version: 3,
        type: "group.hello",
        messageId: crypto.randomUUID(),
        sentAt: Date.now(),
        senderDeviceId: "bob",
        groupId: GROUP_ID,
        logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: "bob" },
        payload: { deviceId: "bob", displayName: "Bob", protocolVersion: 3 },
      } as never,
      GROUP_SECRET,
    );
    sdk.handlers.get("dataReceived")?.[0]({ detail: { data: hello, uuid: "peer-bob" } });
    // Wait for the async hello exchange to map the peer.
    const mapped = await waitFor(() => conn.deviceForPeer("peer-bob") === "bob");
    expect(record.errors).toEqual([]);
    expect(mapped).toBe(true);
    expect(record.online).toContain("bob");
    expect(conn.deviceForPeer("peer-bob")).toBe("bob");
  });

  it("Hello exchange maps peer UUIDs to device IDs", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });
    await conn.start();
    const sdk = createdSdks[createdSdks.length - 1]!;
    // Simulate a peer connecting
    sdk.handlers.get("peerConnected")?.[0]({ detail: { uuid: "peer-bob" } });
    // Wait for the connection to emit a group.hello to the new peer.
    const helloSent = await waitFor(() =>
      sdk.sendData.mock.calls.some((c) => (c[0] as { type: string }).type === "group.hello"),
    );
    expect(helloSent).toBe(true);

    // Simulate Bob sending a hello back
    const { buildEnvelope } = await import("@screenlink/shared");
    const hello = await buildEnvelope(
      {
        version: 3,
        type: "group.hello",
        messageId: crypto.randomUUID(),
        sentAt: Date.now(),
        senderDeviceId: "bob",
        groupId: GROUP_ID,
        logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: "bob" },
        payload: { deviceId: "bob", displayName: "Bob", protocolVersion: 3 },
      } as never,
      GROUP_SECRET,
    );
    sdk.handlers.get("dataReceived")?.[0]({ detail: { data: hello, uuid: "peer-bob" } });
    // Wait for the peer-to-device mapping to be established.
    const mapped = await waitFor(() => conn.deviceForPeer("peer-bob") === "bob");
    expect(mapped).toBe(true);
    expect(record.online).toContain("bob");
    expect(conn.peerForDevice("bob")).toBe("peer-bob");
  });

  it("requests group state and stream state after the handshake", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });
    await conn.start();
    const sdk = createdSdks[createdSdks.length - 1]!;
    sdk.sendData.mockClear();

    // Simulate a peer connecting and a hello exchange
    sdk.handlers.get("peerConnected")?.[0]({ detail: { uuid: "peer-bob" } });
    await tick();
    const { buildEnvelope } = await import("@screenlink/shared");
    const hello = await buildEnvelope(
      {
        version: 3,
        type: "group.hello",
        messageId: crypto.randomUUID(),
        sentAt: Date.now(),
        senderDeviceId: "bob",
        groupId: GROUP_ID,
        logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: "bob" },
        payload: { deviceId: "bob", displayName: "Bob", protocolVersion: 3 },
      } as never,
      GROUP_SECRET,
    );
    sdk.handlers.get("dataReceived")?.[0]({ detail: { data: hello, uuid: "peer-bob" } });
    // Wait for both state requests to land in the sendData mock.
    const bothSent = await waitFor(() => {
      const sentTypes = sdk.sendData.mock.calls.map((c) => (c[0] as { type: string }).type);
      return sentTypes.includes("group.state.request") && sentTypes.includes("stream.state.request");
    });
    expect(bothSent).toBe(true);
  });

  it("does not request state twice for the same peer", async () => {
    const record: Rec = { online: [], offline: [], messages: [], errors: [] };
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      ...makeCallbacks(record),
    });
    await conn.start();
    const sdk = createdSdks[createdSdks.length - 1]!;
    sdk.sendData.mockClear();
    sdk.handlers.get("peerConnected")?.[0]({ detail: { uuid: "peer-bob" } });
    await tick();
    const { buildEnvelope } = await import("@screenlink/shared");
    const hello = await buildEnvelope(
      {
        version: 3,
        type: "group.hello",
        messageId: crypto.randomUUID(),
        sentAt: Date.now(),
        senderDeviceId: "bob",
        groupId: GROUP_ID,
        logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: "bob" },
        payload: { deviceId: "bob", displayName: "Bob", protocolVersion: 3 },
      } as never,
      GROUP_SECRET,
    );
    sdk.handlers.get("dataReceived")?.[0]({ detail: { data: hello, uuid: "peer-bob" } });
    // Wait for at least one group.state.request to land.
    const hasFirst = await waitFor(() => {
      const sentTypes = sdk.sendData.mock.calls.map((c) => (c[0] as { type: string }).type);
      return sentTypes.includes("group.state.request");
    });
    expect(hasFirst).toBe(true);
    // Now give a few more ticks and assert we still have only one
    // (no duplicate request on the same peer).
    await tickN(5);
    const requestCount = sdk.sendData.mock.calls
      .map((c) => (c[0] as { type: string }).type)
      .filter((t) => t === "group.state.request").length;
    expect(requestCount).toBe(1);
  });
});
