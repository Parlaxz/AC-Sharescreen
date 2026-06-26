// @vitest-environment node
/**
 * Targeted tests for GroupConnectionManager stream lifecycle queue changes:
 *   - sendOrQueueStreamLifecycle returns "queued" when zero confirmed recipients
 *   - flushPendingLifecycle removes only delivered/expired entries, not whole queue
 *   - Stopping clears stale pending starts/restarts
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const createdSdks: any[] = [];
vi.mock("@screenlink/vdo-adapter", () => ({
  getSDKConstructor: () => {
    return function () {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const sdk = {
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
        handlers,
      };
      createdSdks.push(sdk);
      return sdk;
    };
  },
}));

import { GroupConnectionManager } from "../src/renderer/services/group-connection-manager.js";
import { GroupControlConnection } from "../src/renderer/services/group-control-connection.js";

const GROUP_ID = "11111111-1111-4111-1111-111111111111";

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

describe("GroupConnectionManager — stream lifecycle queue", () => {
  let mgr: GroupConnectionManager;

  beforeEach(() => {
    createdSdks.length = 0;
    mgr = new GroupConnectionManager();
  });

  it("sendOrQueueStreamLifecycle returns 'queued' when no group connection", async () => {
    const result = await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID,
      "stream-1",
      "stream.started",
      { logicalStreamId: "stream-1", type: "stream.started" },
    );
    expect(result).toBe("queued");
  });

  it("sendOrQueueStreamLifecycle returns 'queued' when broadcast has zero sent recipients", async () => {
    // Add group and wait for connection
    await mgr.addGroup({
      groupId: GROUP_ID,
      controlRoomId: "room-1",
      groupSecret: "test-secret",
      nodeId: "alice",
      displayName: "Alice",
    });
    await tick();
    await tick();

    // Make broadcast return zero sent
    const conn = mgr.getConnection(GROUP_ID);
    vi.spyOn(conn!, "broadcast").mockResolvedValue({ attempted: 0, sent: 0, failed: 0 });

    const result = await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID,
      "stream-1",
      "stream.started",
      { logicalStreamId: "stream-1" },
    );
    expect(result).toBe("queued");
  });

  it("sendOrQueueStreamLifecycle retains queued entries after broadcast failure", async () => {
    await mgr.addGroup({
      groupId: GROUP_ID,
      controlRoomId: "room-1",
      groupSecret: "test-secret",
      nodeId: "alice",
      displayName: "Alice",
    });
    await tick();
    await tick();

    const conn = mgr.getConnection(GROUP_ID);
    vi.spyOn(conn!, "broadcast").mockResolvedValue({ attempted: 1, sent: 0, failed: 1 });

    const result1 = await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID, "stream-1", "stream.started", { logicalStreamId: "stream-1" },
    );
    expect(result1).toBe("queued");

    // Queue another
    const result2 = await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID, "stream-2", "stream.started", { logicalStreamId: "stream-2" },
    );
    expect(result2).toBe("queued");

    // Verify queue has both entries
    const pendingMap = (mgr as any).pendingLifecycle.get(GROUP_ID);
    expect(pendingMap).toBeDefined();
    expect(pendingMap!.size).toBe(2);
  });

  it("flushPendingLifecycle removes only delivered entries, not whole queue", async () => {
    await mgr.addGroup({
      groupId: GROUP_ID,
      controlRoomId: "room-1",
      groupSecret: "test-secret",
      nodeId: "alice",
      displayName: "Alice",
    });
    await tick();
    await tick();

    const conn = mgr.getConnection(GROUP_ID);
    // Make broadcast return mixed results
    let callCount = 0;
    vi.spyOn(conn!, "broadcast").mockImplementation(async () => {
      callCount++;
      // First call succeeds (sent=1), second fails (sent=0)
      return callCount === 1
        ? { attempted: 1, sent: 1, failed: 0 }
        : { attempted: 1, sent: 0, failed: 1 };
    });

    // Queue two messages
    await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID, "stream-1", "stream.started", { logicalStreamId: "stream-1" },
    );
    await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID, "stream-2", "stream.started", { logicalStreamId: "stream-2" },
    );

    // Now flush (simulate reconnect)
    await mgr.flushPendingLifecycle(GROUP_ID);

    const pendingMap = (mgr as any).pendingLifecycle.get(GROUP_ID);
    // The first entry should be removed (delivered), the second should remain
    expect(pendingMap).toBeDefined();
    expect(pendingMap!.size).toBe(1);
    const remaining = Array.from(pendingMap!.values());
    expect(remaining[0].logicalStreamId).toBe("stream-2");
  });

  it("stopping a stream clears stale pending starts/restarts for that stream", async () => {
    // Directly enqueue a start
    const pendingMap = new Map();
    (mgr as any).pendingLifecycle.set(GROUP_ID, pendingMap);

    // Manually simulate enqueuing
    const enqueue = (mgr as any).enqueueLifecycle.bind(mgr);
    enqueue(GROUP_ID, "stream-1", "stream.started", { logicalStreamId: "stream-1" });

    // Verify it's queued
    expect(pendingMap.size).toBe(1);

    // Now enqueue a stop for same stream
    enqueue(GROUP_ID, "stream-1", "stream.stopped", { logicalStreamId: "stream-1" });

    // After stop, the pending start should also be removed
    expect(pendingMap.size).toBe(1); // only the stop remains
    expect(pendingMap.has("stream-1:stream.started")).toBe(false);
    expect(pendingMap.has("stream-1:stream.stopped")).toBe(true);
  });

  it("clearPendingForStream removes all entries for a specific stream", async () => {
    const pendingMap = new Map();
    (mgr as any).pendingLifecycle.set(GROUP_ID, pendingMap);

    const enqueue = (mgr as any).enqueueLifecycle.bind(mgr);
    enqueue(GROUP_ID, "stream-1", "stream.started", { logicalStreamId: "stream-1" });
    enqueue(GROUP_ID, "stream-2", "stream.started", { logicalStreamId: "stream-2" });

    expect(pendingMap.size).toBe(2);

    mgr.clearPendingForStream(GROUP_ID, "stream-1");
    expect(pendingMap.size).toBe(1);
    expect(pendingMap.has("stream-2:stream.started")).toBe(true);
  });

  it("flushPendingLifecycle does not delete the entire queue on partial failure", async () => {
    await mgr.addGroup({
      groupId: GROUP_ID,
      controlRoomId: "room-1",
      groupSecret: "test-secret",
      nodeId: "alice",
      displayName: "Alice",
    });
    await tick();
    await tick();

    const conn = mgr.getConnection(GROUP_ID);
    // Make broadcast always fail
    vi.spyOn(conn!, "broadcast").mockResolvedValue({ attempted: 1, sent: 0, failed: 1 });

    // Queue two messages
    await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID, "stream-1", "stream.started", { logicalStreamId: "stream-1" },
    );
    await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID, "stream-2", "stream.started", { logicalStreamId: "stream-2" },
    );

    const beforeFlush = (mgr as any).pendingLifecycle.get(GROUP_ID)!.size;
    expect(beforeFlush).toBe(2);

    // Flush — both will fail (sent=0), so neither should be removed
    await mgr.flushPendingLifecycle(GROUP_ID);

    const afterFlush = (mgr as any).pendingLifecycle.get(GROUP_ID)!.size;
    // Both entries should still be present
    expect(afterFlush).toBe(2);
  });
});
