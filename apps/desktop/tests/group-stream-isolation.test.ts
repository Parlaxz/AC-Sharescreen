// @vitest-environment node
/**
 * Cross-group isolation and stream discovery tests (Stage 7 — Fix 5 + 6).
 *
 * Wires two real `GroupMessageRouter` instances to two real
 * `ActiveStreamRegistry` instances to prove:
 *
 *  - A stream in group A never appears in group B's renderer.
 *  - A snapshot for group B excludes group A's streams.
 *  - Stream announcements with a mismatched groupId are rejected.
 *  - Bob joining after Alice receives Alice's stream via snapshot.
 *  - Heartbeat keeps the stream alive; stop removes it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GroupMessageRouter } from "../src/renderer/services/group-message-router.js";
import { ActiveStreamRegistry, type StreamAnnouncement } from "../src/renderer/services/active-stream-registry.js";
import type { GroupControlEnvelope, HybridTimestamp } from "@screenlink/shared";
import { buildEnvelope } from "@screenlink/shared";

const GROUP_A = "11111111-1111-4111-1111-111111111111";
const GROUP_B = "22222222-2222-4222-2222-222222222222";
const GROUP_SECRET = "test-secret-12345678";

function ts(wallTimeMs: number, counter: number, nodeId: string): HybridTimestamp {
  return { wallTimeMs, counter, nodeId };
}

function makeAnnouncement(overrides: Partial<StreamAnnouncement> = {}): StreamAnnouncement {
  return {
    logicalStreamId: "ls-1",
    mediaSessionId: "ms-1",
    groupId: GROUP_A,
    hostDeviceId: "alice",
    hostDisplayName: "Alice",
    sourceKind: "screen",
    sourceName: "Display",
    startedAt: Date.now(),
    appliedSettingsRevision: 0,
    heartbeatSequence: 1,
    streamRevision: 1,
    mediaJoinMetadata: "",
    replacesSessionId: null,
    ...overrides,
  };
}

interface MockConn {
  broadcast: ReturnType<typeof vi.fn>;
  getConnection: ReturnType<typeof vi.fn>;
}

function makeMockConn(): MockConn {
  return {
    broadcast: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue({
      peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
      sendToPeer: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

async function buildSignedAnnouncement(
  ann: StreamAnnouncement,
  type: "stream.started" | "stream.heartbeat" | "stream.stopped" = "stream.started",
): Promise<GroupControlEnvelope> {
  return await buildEnvelope(
    {
      version: 3,
      type,
      messageId: crypto.randomUUID(),
      sentAt: Date.now(),
      senderDeviceId: ann.hostDeviceId,
      groupId: ann.groupId,
      logicalStamp: ts(Date.now(), 0, ann.hostDeviceId),
      payload: ann as unknown as Record<string, unknown>,
    } as never,
    GROUP_SECRET,
  );
}

describe("GroupMessageRouter — cross-group stream isolation", () => {
  let aliceRegistry: ActiveStreamRegistry;
  let charlieRegistry: ActiveStreamRegistry;
  let aliceRouter: GroupMessageRouter;
  let charlieRouter: GroupMessageRouter;
  let aliceConn: MockConn;
  let charlieConn: MockConn;

  beforeEach(() => {
    aliceRegistry = new ActiveStreamRegistry(10_000, 60_000);
    charlieRegistry = new ActiveStreamRegistry(10_000, 60_000);
    aliceConn = makeMockConn();
    charlieConn = makeMockConn();
    aliceRouter = new GroupMessageRouter(
      { handleGroupMessage: vi.fn() } as never,
      aliceRegistry as never,
      aliceConn as never,
    );
    charlieRouter = new GroupMessageRouter(
      { handleGroupMessage: vi.fn() } as never,
      charlieRegistry as never,
      charlieConn as never,
    );
  });

  it("Alice's stream in group A never appears in Charlie's group B registry", async () => {
    // Alice starts a stream in group A
    const ann = makeAnnouncement({ groupId: GROUP_A });
    const env = await buildSignedAnnouncement(ann);
    aliceRouter.routeMessage(GROUP_A, env);
    expect(aliceRegistry.getStreamsByGroup(GROUP_A)).toHaveLength(1);

    // Charlie's group B router receives a snapshot for group B
    const snapshot = {
      version: 3,
      type: "stream.state.snapshot",
      messageId: crypto.randomUUID(),
      sentAt: Date.now(),
      senderDeviceId: "alice",
      groupId: GROUP_B,
      logicalStamp: ts(Date.now(), 0, "alice"),
      payload: { streams: [ann] }, // Alice's stream; should be filtered out
      mac: "0".repeat(64),
    } as never;
    charlieRouter.routeMessage(GROUP_B, snapshot);
    expect(charlieRegistry.getStreamsByGroup(GROUP_B)).toHaveLength(0);
  });

  it("Snapshot for group B excludes group A streams (cross-group filter)", async () => {
    // Alice has a stream in group A
    const aAnn = makeAnnouncement({ groupId: GROUP_A, hostDeviceId: "alice" });
    const aEnv = await buildSignedAnnouncement(aAnn);
    aliceRouter.routeMessage(GROUP_A, aEnv);

    // Charlie has a stream in group B
    const bAnn = makeAnnouncement({ groupId: GROUP_B, hostDeviceId: "charlie" });
    const bEnv = await buildSignedAnnouncement(bAnn);
    charlieRouter.routeMessage(GROUP_B, bEnv);

    // Snapshot Charlie receives includes only his own stream
    const snapshotPayload = {
      streams: aliceRegistry.getStreamsByGroup(GROUP_A).concat(
        charlieRegistry.getStreamsByGroup(GROUP_B),
      ),
    };
    const snapshot = {
      version: 3,
      type: "stream.state.snapshot",
      messageId: crypto.randomUUID(),
      sentAt: Date.now(),
      senderDeviceId: "someone",
      groupId: GROUP_B,
      logicalStamp: ts(Date.now(), 0, "someone"),
      payload: snapshotPayload,
      mac: "0".repeat(64),
    } as never;
    charlieRouter.routeMessage(GROUP_B, snapshot);
    // Charlie's view still has only the B stream (the A stream was filtered out)
    expect(charlieRegistry.getStreamsByGroup(GROUP_B)).toHaveLength(1);
    expect(charlieRegistry.getStreamsByGroup(GROUP_B)[0]?.hostDeviceId).toBe("charlie");
  });

  it("Stream announcement with mismatched groupId is rejected", async () => {
    // Build an announcement with groupId=B but route it to group A
    const ann = makeAnnouncement({ groupId: GROUP_B });
    const env = await buildSignedAnnouncement(ann);
    aliceRouter.routeMessage(GROUP_A, env);
    expect(aliceRegistry.getStreamsByGroup(GROUP_A)).toHaveLength(0);
  });

  it("Bob (group A) late-joining receives Alice's stream via state snapshot", async () => {
    // Alice starts a stream
    const ann = makeAnnouncement({ groupId: GROUP_A, hostDeviceId: "alice" });
    const aEnv = await buildSignedAnnouncement(ann);
    aliceRouter.routeMessage(GROUP_A, aEnv);

    // Bob joins AFTER Alice. He receives a snapshot.
    const bobRegistry = new ActiveStreamRegistry(10_000, 60_000);
    const bobConn = makeMockConn();
    const bobRouter = new GroupMessageRouter(
      { handleGroupMessage: vi.fn() } as never,
      bobRegistry as never,
      bobConn as never,
    );

    // The respondWithSnapshot handler is internal to the router;
    // simulate it by manually building the snapshot from Alice's
    // registry and routing it to Bob.
    const streams = aliceRegistry.getStreamsByGroup(GROUP_A);
    expect(streams).toHaveLength(1);
    const snapshot = {
      version: 3,
      type: "stream.state.snapshot",
      messageId: crypto.randomUUID(),
      sentAt: Date.now(),
      senderDeviceId: "alice",
      groupId: GROUP_A,
      logicalStamp: ts(Date.now(), 0, "alice"),
      payload: { streams },
      mac: "0".repeat(64),
    } as never;
    bobRouter.routeMessage(GROUP_A, snapshot);

    // Bob should now have Alice's stream
    const bobStreams = bobRegistry.getStreamsByGroup(GROUP_A);
    expect(bobStreams).toHaveLength(1);
    expect(bobStreams[0]?.hostDeviceId).toBe("alice");
    expect(bobStreams[0]?.logicalStreamId).toBe("ls-1");
  });

  it("Heartbeat keeps stream alive; stop removes it", async () => {
    const ann = makeAnnouncement({ groupId: GROUP_A, heartbeatSequence: 1 });
    const env = await buildSignedAnnouncement(ann);
    aliceRouter.routeMessage(GROUP_A, env);
    expect(aliceRegistry.getAllStreams()).toHaveLength(1);

    // Heartbeat
    const hb = makeAnnouncement({ groupId: GROUP_A, heartbeatSequence: 2 });
    const hbEnv = await buildSignedAnnouncement(hb, "stream.heartbeat");
    aliceRouter.routeMessage(GROUP_A, hbEnv);
    expect(aliceRegistry.getAllStreams()[0]?.heartbeatSequence).toBe(2);

    // Stop
    const stopPayload = {
      groupId: GROUP_A,
      hostDeviceId: "alice",
      logicalStreamId: "ls-1",
    };
    const stopEnv = await buildSignedAnnouncement(stopPayload as never, "stream.stopped");
    aliceRouter.routeMessage(GROUP_A, stopEnv);
    expect(aliceRegistry.getAllStreams()).toHaveLength(0);
  });
});
