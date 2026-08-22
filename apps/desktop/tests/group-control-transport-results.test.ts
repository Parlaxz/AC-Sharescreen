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

  // ── dataChannelClose handler ─────────────────────────────────────

  it("dataChannelClose removes a mapped peer and emits onPeerOffline", async () => {
    const onPeerOffline = vi.fn();
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline,
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;

    // Set up a mapped peer with both raw channel and authenticated mapping
    (conn as any).rawDataPeers.add("peer-bob");
    (conn as any).peersAwaitingHello.add("peer-bob");
    (conn as any).peerToDevice.set("peer-bob", "bob");
    (conn as any).deviceToPeer.set("bob", "peer-bob");

    // Fire dataChannelClose
    sdk.handlers.get("dataChannelClose")?.[0]({ detail: { uuid: "peer-bob" } });

    // rawDataPeers and peersAwaitingHello cleaned up
    expect((conn as any).rawDataPeers.has("peer-bob")).toBe(false);
    expect((conn as any).peersAwaitingHello.has("peer-bob")).toBe(false);
    // Peer-to-device maps cleaned up
    expect((conn as any).peerToDevice.has("peer-bob")).toBe(false);
    expect((conn as any).deviceToPeer.has("bob")).toBe(false);
    // onPeerOffline called exactly once with the device ID
    expect(onPeerOffline).toHaveBeenCalledTimes(1);
    expect(onPeerOffline).toHaveBeenCalledWith("bob");
  });

  it("dataChannelClose with malformed event fires onError", async () => {
    const onError = vi.fn();
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
      onError,
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;

    // Fire with empty detail object (no uuid) — malformed event surfaces onError
    sdk.handlers.get("dataChannelClose")?.[0]({ detail: {} });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe("dataChannelClose: SDK emitted event without a usable UUID");

    // Fire with no detail at all — still malformed
    sdk.handlers.get("dataChannelClose")?.[0]({});
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[1][0].message).toBe("dataChannelClose: SDK emitted event without a usable UUID");
  });

  // ── signaling disconnect / reconnect ─────────────────────────────

  it("disconnected sets reconnecting state but preserves peer routing and does not emit offline", async () => {
    const onPeerOffline = vi.fn();
    const onStateChange = vi.fn();
    const conn = new GroupControlConnection({
      groupId: GROUP_ID,
      controlRoomId: CONTROL_ROOM,
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: null,
      onPeerOnline: vi.fn(),
      onPeerOffline,
      onMessage: vi.fn(),
      onStateChange,
      onError: vi.fn(),
    });
    await conn.start();
    await tick();
    const sdk = createdSdks[createdSdks.length - 1]!;

    // Set up a mapped peer with both raw channel and authenticated mapping
    (conn as any).rawDataPeers.add("peer-bob");
    (conn as any).peerToDevice.set("peer-bob", "bob");
    (conn as any).deviceToPeer.set("bob", "peer-bob");

    onStateChange.mockClear();
    onPeerOffline.mockClear();

    // Fire signaling disconnected
    sdk.handlers.get("disconnected")?.[0]({});

    // State changed to reconnecting
    expect(conn.state).toBe("reconnecting");
    expect(onStateChange).toHaveBeenCalledWith("reconnecting");

    // Peer routing and mapping are preserved
    expect((conn as any).rawDataPeers.has("peer-bob")).toBe(true);
    expect((conn as any).peerToDevice.has("peer-bob")).toBe(true);
    expect((conn as any).deviceToPeer.has("bob")).toBe(true);

    // onPeerOffline was NOT called
    expect(onPeerOffline).not.toHaveBeenCalled();
  });

  it("reconnected retries hello for unmapped raw peer and requests state for mapped peer", async () => {
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

    // Set up two raw peers:
    //   - peer-bob: has data channel but no authenticated mapping (needs hello retry)
    //   - peer-charlie: has data channel AND authenticated mapping (needs state request)
    (conn as any).rawDataPeers.add("peer-bob");
    (conn as any).peersAwaitingHello.add("peer-bob");
    (conn as any).rawDataPeers.add("peer-charlie");
    (conn as any).peerToDevice.set("peer-charlie", "charlie");
    (conn as any).deviceToPeer.set("charlie", "peer-charlie");

    // Fire reconnected
    sdk.handlers.get("reconnected")?.[0]({});

    // State should be connected
    expect(conn.state).toBe("connected");

    // peer-bob should remain in peersAwaitingHello
    expect((conn as any).peersAwaitingHello.has("peer-bob")).toBe(true);

    // Wait for the async hello to peer-bob to land in sendData
    const helloWasSent = await waitFor(() =>
      sdk.sendData.mock.calls.some((c) => {
        const payload = c[0] as Record<string, unknown>;
        return payload?.type === "group.hello" && (c[1] as Record<string, unknown>)?.uuid === "peer-bob";
      }),
      300,
    );
    expect(helloWasSent).toBe(true);

    // Wait for the state request to peer-charlie
    const stateRequestSent = await waitFor(() =>
      sdk.sendData.mock.calls.some((c) => {
        const payload = c[0] as Record<string, unknown>;
        return payload?.type === "group.state.request" && (c[1] as Record<string, unknown>)?.uuid === "peer-charlie";
      }),
      300,
    );
    expect(stateRequestSent).toBe(true);
  });

  // ── bounded hello retry ──────────────────────────────────────────

  it("retries hello up to 3 times for a peer that never responds, then gives up", async () => {
    vi.useFakeTimers();
    try {
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
      const startPromise = conn.start();
      // Flush microtasks so autoConnect resolves and start() completes.
      await vi.advanceTimersByTimeAsync(0);
      await startPromise;
      const sdk = createdSdks[createdSdks.length - 1]!;
      sdk.sendData.mockClear();

      // Peer opens a data channel but NEVER responds to our hello.
      sdk.handlers.get("dataChannelOpen")?.[0]({ detail: { uuid: "peer-bob" } });

      const countHellos = () =>
        sdk.sendData.mock.calls.filter((c) => {
          const payload = c[0] as Record<string, unknown>;
          return payload?.type === "group.hello" && (c[1] as Record<string, unknown>)?.uuid === "peer-bob";
        }).length;

      // Pump fake timers in small steps so async envelope building
      // (crypto.subtle) settles without firing the 2s retry tick early.
      // Budget stays <=1000ms of fake time: enough event-loop turns for
      // native crypto under load, yet never crossing the next 2s tick.
      const waitHellos = async (n: number): Promise<void> => {
        for (let i = 0; i < 100 && countHellos() < n; i++) {
          await vi.advanceTimersByTimeAsync(10);
        }
      };

      // Initial hello from dataChannelOpen.
      await waitHellos(1);
      expect(countHellos()).toBe(1);
      expect((conn as any).peersAwaitingHello.has("peer-bob")).toBe(true);

      // Retry 1 at t=2s
      await vi.advanceTimersByTimeAsync(2_000);
      await waitHellos(2);
      expect(countHellos()).toBe(2);
      // Retry 2 at t=4s
      await vi.advanceTimersByTimeAsync(2_000);
      await waitHellos(3);
      expect(countHellos()).toBe(3);
      // Retry 3 at t=6s — max retries reached
      await vi.advanceTimersByTimeAsync(2_000);
      await waitHellos(4);
      expect(countHellos()).toBe(4);

      // After max retries the peer is given up on silently — no more sends.
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(countHellos()).toBe(4);
      expect((conn as any).peersAwaitingHello.has("peer-bob")).toBe(false);

      await conn.destroy();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
