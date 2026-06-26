// @vitest-environment node
/**
 * Targeted tests for GroupControlConnection transport result changes:
 *   - sendToPeer returns boolean
 *   - broadcast returns BroadcastResult
 *   - Uses addEventListener/removeEventListener
 *   - Uses preference:"any" not type:"publisher"
 *   - dataChannelOpen handler sends hello
 *   - Hello identity validation
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock SDK ──────────────────────────────────────────────────────────────
interface MockSDK {
  sendData: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  autoConnect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  leaveRoom: ReturnType<typeof vi.fn>;
  state: { connected: boolean; roomJoined: boolean; room: string | null };
  announceId: string | null;
  handlers: Map<string, ((...args: unknown[]) => void)[]>;
}

function makeFakeSDK(): MockSDK {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const sdk: MockSDK = {
    sendData: vi.fn().mockReturnValue(true),
    addEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
    }),
    removeEventListener: vi.fn(),
    autoConnect: vi.fn().mockResolvedValue({ stop: vi.fn(), streamID: "test-id" }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    state: { connected: false, roomJoined: false, room: null },
    announceId: null,
    handlers,
  };
  return sdk;
}

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

import { GroupControlConnection, type BroadcastResult } from "../src/renderer/services/group-control-connection.js";

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

async function waitFor(predicate: () => boolean, maxTicks = 300): Promise<boolean> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}

const GROUP_ID = "11111111-1111-4111-1111-111111111111";
const GROUP_SECRET = "test-secret-12345678";
const CONTROL_ROOM = "control-room-transport";

describe("GroupControlConnection — transport result changes", () => {
  beforeEach(() => {
    createdSdks.length = 0;
  });

  // ── addEventListener/removeEventListener ────────────────────────────

  it("uses addEventListener (not .on) to register SDK listeners", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();

    const sdk = createdSdks[createdSdks.length - 1]!;
    // Must use addEventListener, not .on
    expect(sdk.addEventListener).toHaveBeenCalled();
    // Check for specific event names
    const events = sdk.addEventListener.mock.calls.map((c) => c[0]);
    expect(events).toContain("peerConnected");
    expect(events).toContain("peerDisconnected");
    expect(events).toContain("dataChannelOpen");
    expect(events).toContain("dataReceived");
    expect(events).toContain("disconnected");
    expect(events).toContain("reconnected");
  });

  it("uses removeEventListener (not .off) during teardown", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;
    await conn.destroy();

    // Must use removeEventListener during teardown
    const removeCalls = sdk.removeEventListener.mock.calls.map((c) => c[0]);
    expect(removeCalls).toContain("peerConnected");
    expect(removeCalls).toContain("dataChannelOpen");
    expect(removeCalls).toContain("dataReceived");
  });

  // ── sendToPeer returns boolean ─────────────────────────────────────

  /** Helper: populate rawDataPeers so sendToPeer passes the route check. */
  function addRawPeer(conn: GroupControlConnection, uuid: string): void {
    (conn as any).rawDataPeers.add(uuid);
  }

  it("sendToPeer returns true when SDK reports delivery accepted", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    addRawPeer(conn, "peer-bob");

    const result = await conn.sendToPeer("peer-bob", { type: "test", data: "hello" });
    expect(result).toBe(true);
  });

  it("sendToPeer returns false when SDK reports nothing sent", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    addRawPeer(conn, "peer-bob");

    const sdk = createdSdks[createdSdks.length - 1]!;
    sdk.sendData.mockReturnValue(false);

    const result = await conn.sendToPeer("peer-bob", { type: "test" });
    expect(result).toBe(false);
  });

  it("sendToPeer returns false for empty peer UUID", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();

    const result = await conn.sendToPeer("", { type: "test" });
    expect(result).toBe(false);
  });

  it("sendToPeer returns false when peer has no raw data-channel route", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    // Do NOT add peer-bob to rawDataPeers — trigger the no-route rejection.

    const result = await conn.sendToPeer("peer-bob", { type: "test" });
    expect(result).toBe(false);
    // SDK sendData should NOT have been called.
    const sdk = createdSdks[createdSdks.length - 1]!;
    expect(sdk.sendData).not.toHaveBeenCalled();
  });

  it("sendToPeer uses preference:'any' instead of type:'publisher'", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    addRawPeer(conn, "peer-bob");
    const sdk = createdSdks[createdSdks.length - 1]!;
    sdk.sendData.mockClear();

    await conn.sendToPeer("peer-bob", { type: "test" });

    const options = sdk.sendData.mock.calls[0][1];
    expect(options).toMatchObject({
      uuid: "peer-bob",
      preference: "any",
      allowFallback: false,
    });
    // Should NOT have `type: "publisher"`
    expect(options.type).toBeUndefined();
  });

  // ── broadcast returns BroadcastResult ──────────────────────────────

  it("broadcast returns BroadcastResult with peer counts", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();

    // Send a hello to establish a peer mapping so broadcast has a target.
    // Access private maps via bracket notation for testing.
    (conn as any).peerToDevice.set("peer-bob", "bob");
    (conn as any).deviceToPeer.set("bob", "peer-bob");

    const result: BroadcastResult = await conn.broadcast({ type: "test" });
    expect(result.attempted).toBeGreaterThan(0);
    expect(result.sent).toBeGreaterThan(0);
    expect(typeof result.failed).toBe("number");
  });

  it("broadcast returns zero attempted/sent/failed when SDK null", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    // Don't start — SDK is null
    const result: BroadcastResult = await conn.broadcast({ type: "test" });
    expect(result).toEqual({ attempted: 0, sent: 0, failed: 0 });
  });

  it("does NOT call broadcastHello immediately after autoConnect (driven by dataChannelOpen)", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;

    // No hello should have been broadcast (no peers with data channel yet).
    const helloBroadcasts = sdk.sendData.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "group.hello" &&
        (c[1] as Record<string, unknown>)?.uuid === undefined,
    );
    expect(helloBroadcasts.length).toBe(0);
  });

  it("broadcast uses preference:'any' on each sendData call", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;
    sdk.sendData.mockClear();

    (conn as any).peerToDevice.set("peer-bob", "bob");
    (conn as any).deviceToPeer.set("bob", "peer-bob");

    await conn.broadcast({ type: "test" });

    const options = sdk.sendData.mock.calls[0][1];
    expect(options).toMatchObject({
      uuid: "peer-bob",
      preference: "any",
      allowFallback: false,
    });
    expect(options.type).toBeUndefined();
  });

  // ── dataChannelOpen handler ────────────────────────────────────────

  it("dataChannelOpen sends hello to new peer", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;
    sdk.sendData.mockClear();

    // Fire dataChannelOpen
    const dcHandler = sdk.handlers.get("dataChannelOpen")?.[0]!;
    dcHandler({ detail: { uuid: "peer-bob" } });
    // The hello is sent async (via buildEnvelope -> sendToPeer -> sendData).
    // Wait for the async hello to complete (buildEnvelope involves crypto.subtle).
    const helloWasSent = await waitFor(() =>
      sdk.sendData.mock.calls.some((c) => {
        const payload = c[0] as Record<string, unknown>;
        return payload?.type === "group.hello" && c[1]?.uuid === "peer-bob";
      }),
      300,
    );

    // Should have sent a hello
    expect(helloWasSent).toBe(true);
    const sentPayload = sdk.sendData.mock.calls[0][0];
    expect(sentPayload.type).toBe("group.hello");

    // Check options use preference:"any"
    const options = sdk.sendData.mock.calls[0][1];
    expect(options).toMatchObject({ uuid: "peer-bob", preference: "any" });

    // Check hello payload includes all required fields
    expect(sentPayload.payload.deviceId).toBe("alice");
    expect(sentPayload.payload.protocolVersion).toBeGreaterThan(0);
  });

  it("dataChannelOpen tracks raw data peers separate from authenticated", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;

    // Fire dataChannelOpen for a peer
    const dcHandler2 = sdk.handlers.get("dataChannelOpen")?.[0]!;
    dcHandler2({ detail: { uuid: "peer-bob" } });
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }

    // rawDataPeers should contain bob, but peerToDevice should not
    const rawPeers = (conn as any).rawDataPeers;
    expect(rawPeers.has("peer-bob")).toBe(true);
    expect((conn as any).peerToDevice.has("peer-bob")).toBe(false);
  });

  // ── Hello identity validation ────────────────────────────────────

  it("rejects hello where envelope.senderDeviceId !== payload deviceId", async () => {
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;
    const onPeerOnline = vi.fn();
    const { buildEnvelope } = await import("@screenlink/shared");

    // Create a hello where senderDeviceId !== payload.deviceId
    const hello = await buildEnvelope(
      {
        version: 3,
        type: "group.hello",
        messageId: crypto.randomUUID(),
        sentAt: Date.now(),
        senderDeviceId: "attacker-device",
        groupId: GROUP_ID,
        logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: "attacker-device" },
        payload: { deviceId: "bob", displayName: "Bob", protocolVersion: 3 },
      } as never,
      GROUP_SECRET,
    );
    sdk.handlers.get("dataReceived")?.[0]({ detail: { data: hello, uuid: "peer-bob" } });
    await tick();

    // Peer should NOT be mapped due to identity mismatch
    expect((conn as any).deviceToPeer.has("bob")).toBe(false);
  });
});
