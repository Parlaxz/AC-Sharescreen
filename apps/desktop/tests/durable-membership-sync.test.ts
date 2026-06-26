// @vitest-environment node
/**
 * Durable known-member synchronization and online presence propagation tests.
 *
 * Covers:
 *  - initializeGroup return type (localMemberWasInserted)
 *  - mergeRemoteMember for hello/hello.response member exchange
 *  - Two-peer convergence through state exchange
 *  - Three-peer offline relay through CRDT full-state sync
 *  - New user responding to online user's hello
 *  - Summary-triggered bidirectional convergence
 *  - Display name updates preserve firstSeenAt
 *  - Persistent membership survives offline
 */
import { describe, it, expect, vi } from "vitest";
import {
  GroupSyncService,
  type SyncPersistenceAdapter,
} from "../src/renderer/services/group-sync-service.js";
import type {
  GroupSharedState,
  HybridTimestamp,
  GroupMemberRecord,
  GroupQualitySettings,
} from "@screenlink/shared";
import {
  createHybridClock,
  tickLocal,
  createDefaultGroupQualitySettings,
} from "@screenlink/shared";

const GROUP_ID = "a1a2a3a4-b1b2-4111-c1c2-111111111111";

function makeState(
  name: string,
  nameStamp: HybridTimestamp,
  members: Record<string, GroupMemberRecord> = {},
): GroupSharedState {
  const defaultQuality: GroupQualitySettings = createDefaultGroupQualitySettings();
  return {
    schemaVersion: 1,
    groupId: GROUP_ID,
    name: { value: name, stamp: nameStamp, valueHash: "", updatedByDeviceId: "" },
    defaultQuality: { value: defaultQuality, stamp: nameStamp, valueHash: "", updatedByDeviceId: "" },
    members,
  };
}

function makeMember(
  deviceId: string,
  displayName: string,
  stamp: HybridTimestamp,
): GroupMemberRecord {
  return { deviceId, displayName, firstSeenAt: stamp.wallTimeMs, profileStamp: stamp };
}

function makeEnvelope(
  type: string,
  payload: Record<string, unknown>,
  stamp: HybridTimestamp,
  senderDeviceId?: string,
) {
  return {
    version: 3,
    type: type as any,
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId: senderDeviceId ?? "remote-device",
    groupId: GROUP_ID,
    logicalStamp: stamp,
    payload,
    mac: "0".repeat(64),
  };
}

function createMockConnManager() {
  const broadcast = vi.fn().mockResolvedValue(undefined);
  const getConnection = vi.fn().mockReturnValue({
    broadcast,
    peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
    sendToPeer: vi.fn(),
  });
  return { broadcast, getConnection };
}

async function tickN(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
  }
}

function ts(wallTimeMs: number, counter: number, nodeId: string): HybridTimestamp {
  return { wallTimeMs, counter, nodeId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Join semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("Join semantics", () => {
  it("first-ever local join inserts one member record and returns localMemberWasInserted: true", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, persistence);

    const stamp = ts(1000, 0, "alice");
    const result = await sync.initializeGroup(
      GROUP_ID, makeState("Test", stamp), undefined, "alice", "Alice",
    );

    expect(result.localMemberWasInserted).toBe(true);
    expect(result.localMember.deviceId).toBe("alice");
    expect(result.localMember.displayName).toBe("Alice");
    expect(result.localMember.firstSeenAt).toBeGreaterThan(0);
    expect(Object.keys(result.state.members)).toEqual(["alice"]);

    // Persistence called because new member was inserted
    expect(persistence.persistState).toHaveBeenCalled();
    sync.destroy();
  });

  it("relaunch of existing group does not create a new join", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, persistence);

    const stamp = ts(1000, 0, "alice");
    const existingMember = makeMember("alice", "Alice", stamp);
    const initialState = makeState("Test", stamp, { alice: existingMember });

    const result = await sync.initializeGroup(
      GROUP_ID, initialState, stamp, "alice", "Alice",
    );

    // The local member was already present — should NOT indicate a new join
    expect(result.localMemberWasInserted).toBe(false);
    expect(Object.keys(result.state.members)).toEqual(["alice"]);

    // Persistence should NOT have been called (no new member insertion)
    expect(persistence.persistState).not.toHaveBeenCalled();
    sync.destroy();
  });

  it("local member firstSeenAt is stable across initializeGroup calls", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, persistence);

    const stamp = ts(1000, 0, "alice");
    const firstSeen = 50000;
    const existingMember: GroupMemberRecord = {
      deviceId: "alice",
      displayName: "Alice",
      firstSeenAt: firstSeen,
      profileStamp: stamp,
    };
    const initialState = makeState("Test", stamp, { alice: existingMember });

    const result = await sync.initializeGroup(
      GROUP_ID, initialState, stamp, "alice", "Alice",
    );

    // firstSeenAt should NOT change on relaunch
    expect(result.localMember.firstSeenAt).toBe(firstSeen);
    // localMemberWasInserted should be false since member already exists
    expect(result.localMemberWasInserted).toBe(false);
    sync.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeRemoteMember
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeRemoteMember", () => {
  it("inserts a new remote member", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, persistence);

    const stamp = ts(1000, 0, "alice");
    await sync.initializeGroup(GROUP_ID, makeState("Test", stamp), undefined, "alice", "Alice");
    persistence.persistState.mockClear();
    persistence.persistClock.mockClear();

    const bobStamp = ts(2000, 0, "bob");
    const bobMember = makeMember("bob", "Bob", bobStamp);
    const result = await sync.mergeRemoteMember(GROUP_ID, bobMember, "bob");

    expect(result.inserted).toBe(true);
    expect(result.updated).toBe(false);
    expect(sync.getSyncState(GROUP_ID)!.state.members["bob"]).toBeDefined();
    expect(sync.getSyncState(GROUP_ID)!.state.members["bob"]!.displayName).toBe("Bob");
    expect(persistence.persistState).toHaveBeenCalled();
    sync.destroy();
  });

  it("does not duplicate an existing equal member", async () => {
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, undefined); // no persistence

    const stamp = ts(1000, 0, "alice");
    await sync.initializeGroup(GROUP_ID, makeState("Test", stamp), undefined, "alice", "Alice");

    // Insert Alice again through mergeRemoteMember
    const aliceMember = makeMember("alice", "Alice", stamp);
    const result = await sync.mergeRemoteMember(GROUP_ID, aliceMember, "alice");

    expect(result.inserted).toBe(false);
    expect(result.updated).toBe(false);

    // Still only one member
    expect(Object.keys(sync.getSyncState(GROUP_ID)!.state.members)).toEqual(["alice"]);
    sync.destroy();
  });

  it("updates display name when incoming profile stamp is newer", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, persistence);

    const aliceStamp = ts(1000, 0, "alice");
    await sync.initializeGroup(GROUP_ID, makeState("Test", aliceStamp), undefined, "alice", "Alice");

    // Add bob with original name
    const bobStamp1 = ts(2000, 0, "bob");
    const bobOriginal = makeMember("bob", "Bob", bobStamp1);
    await sync.mergeRemoteMember(GROUP_ID, bobOriginal, "bob");
    persistence.persistState.mockClear();

    // Update bob's name with a newer stamp
    const bobStamp2 = ts(3000, 0, "bob");
    const bobUpdated = makeMember("bob", "Bob v2", bobStamp2);
    const result = await sync.mergeRemoteMember(GROUP_ID, bobUpdated, "bob");

    expect(result.inserted).toBe(false);
    expect(result.updated).toBe(true);
    expect(sync.getSyncState(GROUP_ID)!.state.members["bob"]!.displayName).toBe("Bob v2");
    expect(persistence.persistState).toHaveBeenCalled();
    sync.destroy();
  });

  it("older record cannot overwrite newer state", async () => {
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, undefined);

    const stamp = ts(1000, 0, "alice");
    await sync.initializeGroup(GROUP_ID, makeState("Test", stamp), undefined, "alice", "Alice");

    // Add bob with newer stamp
    const bobStamp2 = ts(3000, 0, "bob");
    const bobNewer = makeMember("bob", "Bob v2", bobStamp2);
    await sync.mergeRemoteMember(GROUP_ID, bobNewer, "bob");

    // Try to overwrite with older stamp
    const bobStamp1 = ts(2000, 0, "bob");
    const bobOlder = makeMember("bob", "Bob v1", bobStamp1);
    const result = await sync.mergeRemoteMember(GROUP_ID, bobOlder, "bob");

    expect(result.inserted).toBe(false);
    expect(result.updated).toBe(false);
    expect(sync.getSyncState(GROUP_ID)!.state.members["bob"]!.displayName).toBe("Bob v2");
    sync.destroy();
  });

  it("rejects sender identity mismatch", async () => {
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, undefined);

    const stamp = ts(1000, 0, "alice");
    await sync.initializeGroup(GROUP_ID, makeState("Test", stamp), undefined, "alice", "Alice");

    // Try to insert bob with mismatched senderDeviceId
    const bobStamp = ts(2000, 0, "bob");
    const bobMember = makeMember("bob", "Bob", bobStamp);
    const result = await sync.mergeRemoteMember(GROUP_ID, bobMember, "attacker");

    expect(result.inserted).toBe(false);
    expect(result.updated).toBe(false);
    expect(sync.getSyncState(GROUP_ID)!.state.members["bob"]).toBeUndefined();
    sync.destroy();
  });

  it("equal timestamp with different display name uses node-id tiebreaker", async () => {
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, undefined);

    const stamp = ts(1000, 0, "alice");
    await sync.initializeGroup(GROUP_ID, makeState("Test", stamp), undefined, "alice", "Alice");

    // Add member "dev-x" with node-a stamp
    const sameStamp = ts(2000, 0, "node-a");
    const memberA = makeMember("dev-x", "FromNodeA", sameStamp);
    await sync.mergeRemoteMember(GROUP_ID, memberA, "dev-x");

    // Try to overwrite with same logical time but higher node ID
    const sameStampB = ts(2000, 0, "node-b");
    const memberB = makeMember("dev-x", "FromNodeB", sameStampB);
    const result = await sync.mergeRemoteMember(GROUP_ID, memberB, "dev-x");

    // Lower nodeId wins (node-a < node-b), so "FromNodeA" should remain
    expect(result.inserted).toBe(false);
    expect(result.updated).toBe(false);
    expect(sync.getSyncState(GROUP_ID)!.state.members["dev-x"]!.displayName).toBe("FromNodeA");
    sync.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Two-peer convergence
// ─────────────────────────────────────────────────────────────────────────────

describe("Two-peer convergence", () => {
  it("Alice starts with one member, Bob starts with one member", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };

    const cmAlice = createMockConnManager() as any;
    const cmBob = createMockConnManager() as any;
    const alice = new GroupSyncService(cmAlice, persistence);
    const bob = new GroupSyncService(cmBob, persistence);

    const aliceStates: { state: GroupSharedState | null } = { state: null };
    const bobStates: { state: GroupSharedState | null } = { state: null };
    alice.setOnStateUpdated((_, state) => { aliceStates.state = state; });
    bob.setOnStateUpdated((_, state) => { bobStates.state = state; });

    const aliceStamp = ts(1000, 0, "alice");
    const bobStamp = ts(1100, 0, "bob");

    await alice.initializeGroup(GROUP_ID, makeState("Test", aliceStamp), undefined, "alice", "Alice");
    await bob.initializeGroup(GROUP_ID, makeState("Test", bobStamp), undefined, "bob", "Bob");

    expect(Object.keys(aliceStates.state!.members)).toEqual(["alice"]);
    expect(Object.keys(bobStates.state!.members)).toEqual(["bob"]);

    alice.destroy();
    bob.destroy();
  });

  it("state exchange converges both peers to two members", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };

    const cmAlice = createMockConnManager() as any;
    const cmBob = createMockConnManager() as any;
    const alice = new GroupSyncService(cmAlice, persistence);
    const bob = new GroupSyncService(cmBob, persistence);

    const aliceStates: { state: GroupSharedState | null } = { state: null };
    const bobStates: { state: GroupSharedState | null } = { state: null };
    alice.setOnStateUpdated((_, state) => { aliceStates.state = state; });
    bob.setOnStateUpdated((_, state) => { bobStates.state = state; });

    const aliceStamp = ts(1000, 0, "alice");
    const bobStamp = ts(1100, 0, "bob");

    await alice.initializeGroup(GROUP_ID, makeState("Test", aliceStamp), undefined, "alice", "Alice");
    await bob.initializeGroup(GROUP_ID, makeState("Test", bobStamp), undefined, "bob", "Bob");

    // Alice sends state to Bob
    const aliceFull = aliceStates.state!;
    await bob.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: aliceFull,
    }, aliceStamp, "alice") as any);
    await tickN();

    expect(Object.keys(bobStates.state!.members).sort()).toEqual(["alice", "bob"]);

    // Bob sends state to Alice
    const bobFull = bobStates.state!;
    await alice.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: bobFull,
    }, bobStamp, "bob") as any);
    await tickN();

    expect(Object.keys(aliceStates.state!.members).sort()).toEqual(["alice", "bob"]);

    alice.destroy();
    bob.destroy();
  });

  it("duplicate state updates remain at two members", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };

    const cmAlice = createMockConnManager() as any;
    const cmBob = createMockConnManager() as any;
    const alice = new GroupSyncService(cmAlice, persistence);
    const bob = new GroupSyncService(cmBob, persistence);

    const aliceStates: { state: GroupSharedState | null } = { state: null };
    const bobStates: { state: GroupSharedState | null } = { state: null };
    alice.setOnStateUpdated((_, state) => { aliceStates.state = state; });
    bob.setOnStateUpdated((_, state) => { bobStates.state = state; });

    const aliceStamp = ts(1000, 0, "alice");
    const bobStamp = ts(1100, 0, "bob");

    await alice.initializeGroup(GROUP_ID, makeState("Test", aliceStamp), undefined, "alice", "Alice");
    await bob.initializeGroup(GROUP_ID, makeState("Test", bobStamp), undefined, "bob", "Bob");

    // Send Alice's state to Bob three times
    const aliceFull = aliceStates.state!;
    for (let i = 0; i < 3; i++) {
      await bob.handleGroupMessage(GROUP_ID, makeEnvelope(
        "group.state.update", { state: aliceFull }, aliceStamp, "alice",
      ) as any);
    }
    await tickN();

    expect(Object.keys(bobStates.state!.members).length).toBe(2);
    expect(Object.keys(bobStates.state!.members).sort()).toEqual(["alice", "bob"]);

    alice.destroy();
    bob.destroy();
  });

  it("both Alice and Bob converge through hello exchange (mergeRemoteMember)", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };

    const cmAlice = createMockConnManager() as any;
    const cmBob = createMockConnManager() as any;
    const alice = new GroupSyncService(cmAlice, persistence);
    const bob = new GroupSyncService(cmBob, persistence);

    const aliceStates: { state: GroupSharedState | null } = { state: null };
    const bobStates: { state: GroupSharedState | null } = { state: null };
    alice.setOnStateUpdated((_, state) => { aliceStates.state = state; });
    bob.setOnStateUpdated((_, state) => { bobStates.state = state; });

    const aliceStamp = ts(1000, 0, "alice");
    const bobStamp = ts(1100, 0, "bob");

    await alice.initializeGroup(GROUP_ID, makeState("Test", aliceStamp), undefined, "alice", "Alice");
    await bob.initializeGroup(GROUP_ID, makeState("Test", bobStamp), undefined, "bob", "Bob");

    // Simulate hello exchange via mergeRemoteMember (as happens in authenticated hello)
    const aliceMember = aliceStates.state!.members["alice"]!;
    const bobMember = bobStates.state!.members["bob"]!;

    // Alice receives Bob's hello — merges Bob's member
    await alice.mergeRemoteMember(GROUP_ID, bobMember, "bob");
    // Bob receives Alice's hello — merges Alice's member
    await bob.mergeRemoteMember(GROUP_ID, aliceMember, "alice");

    // Both should converge
    expect(Object.keys(aliceStates.state!.members).sort()).toEqual(["alice", "bob"]);
    expect(Object.keys(bobStates.state!.members).sort()).toEqual(["alice", "bob"]);

    // Duplicate hellos don't add duplicates
    await alice.mergeRemoteMember(GROUP_ID, bobMember, "bob");
    await bob.mergeRemoteMember(GROUP_ID, aliceMember, "alice");
    expect(Object.keys(aliceStates.state!.members).length).toBe(2);
    expect(Object.keys(bobStates.state!.members).length).toBe(2);

    alice.destroy();
    bob.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Online presence
// ─────────────────────────────────────────────────────────────────────────────

describe("Online presence", () => {
  it("persistent membership survives without any peers online", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, persistence);
    const stamp = ts(1000, 0, "alice");

    await sync.initializeGroup(GROUP_ID, makeState("Test", stamp), undefined, "alice", "Alice");
    // Alice's persistent state always contains Alice, even when no peers are online
    expect(Object.keys(sync.getSyncState(GROUP_ID)!.state.members)).toContain("alice");
    sync.destroy();
  });

  it("display name update preserves firstSeenAt and doesn't insert a new member", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };
    const connManager = createMockConnManager() as any;
    const sync = new GroupSyncService(connManager, persistence);

    const stamp = ts(1000, 0, "alice");
    const result = await sync.initializeGroup(GROUP_ID, makeState("Test", stamp), undefined, "alice", "Alice");

    const originalFirstSeen = result.localMember.firstSeenAt;

    await sync.updateDisplayName(GROUP_ID, "Alice v2");

    const state = sync.getSyncState(GROUP_ID)!;
    expect(state.state.members["alice"]!.displayName).toBe("Alice v2");
    expect(state.state.members["alice"]!.firstSeenAt).toBe(originalFirstSeen);
    // No new member record — still just Alice
    expect(Object.keys(state.state.members)).toEqual(["alice"]);
    sync.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Three-peer offline relay
// ─────────────────────────────────────────────────────────────────────────────

describe("Three-peer offline relay", () => {
  it("Charlie learns Bob while Alice is offline, then Alice learns Bob through Charlie's full state", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };

    // Simulate three peers: Alice, Bob, Charlie
    const cmA = createMockConnManager() as any;
    const cmB = createMockConnManager() as any;
    const cmC = createMockConnManager() as any;

    const alice = new GroupSyncService(cmA, persistence);
    const bob = new GroupSyncService(cmB, persistence);
    const charlie = new GroupSyncService(cmC, persistence);

    const stateA: { state: GroupSharedState | null } = { state: null };
    const stateB: { state: GroupSharedState | null } = { state: null };
    const stateC: { state: GroupSharedState | null } = { state: null };

    alice.setOnStateUpdated((_, s) => { stateA.state = s; });
    bob.setOnStateUpdated((_, s) => { stateB.state = s; });
    charlie.setOnStateUpdated((_, s) => { stateC.state = s; });

    const stampA = ts(1000, 0, "alice");
    const stampB = ts(1100, 0, "bob");
    const stampC = ts(1200, 0, "charlie");

    // 1. Alice and Charlie know each other
    await alice.initializeGroup(GROUP_ID, makeState("Test", stampA), undefined, "alice", "Alice");
    await charlie.initializeGroup(GROUP_ID, makeState("Test", stampC), undefined, "charlie", "Charlie");

    // Alice and Charlie exchange state
    await charlie.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: stateA.state,
    }, stampA, "alice") as any);
    await alice.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: stateC.state,
    }, stampC, "charlie") as any);
    await tickN();

    expect(Object.keys(stateA.state!.members).sort()).toEqual(["alice", "charlie"]);
    expect(Object.keys(stateC.state!.members).sort()).toEqual(["alice", "charlie"]);

    // 2. Bob joins while Alice is "offline" but Charlie is "online"
    await bob.initializeGroup(GROUP_ID, makeState("Test", stampB), undefined, "bob", "Bob");

    // Bob and Charlie exchange state (Alice is "offline" and doesn't participate)
    await charlie.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: stateB.state,
    }, stampB, "bob") as any);
    await bob.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: stateC.state,
    }, stampC, "charlie") as any);
    await tickN();

    // Charlie learns Bob
    expect(Object.keys(stateC.state!.members).sort()).toEqual(["alice", "bob", "charlie"]);
    // Bob learns both Alice and Charlie
    expect(Object.keys(stateB.state!.members).sort()).toEqual(["alice", "bob", "charlie"]);

    // 3. Alice reconnects only to Charlie (Bob stays offline)
    // Alice receives Charlie's full state — which includes Bob
    await alice.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: stateC.state,
    }, stampC, "charlie") as any);
    await tickN();

    // Alice learns Bob even though Bob was offline during the exchange
    expect(Object.keys(stateA.state!.members).sort()).toEqual(["alice", "bob", "charlie"]);

    alice.destroy();
    bob.destroy();
    charlie.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// New user responding to online user
// ─────────────────────────────────────────────────────────────────────────────

describe("New user responding to online user", () => {
  it("new Bob receives Alice's hello, sends his member record, both converge", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };

    const cmA = createMockConnManager() as any;
    const cmB = createMockConnManager() as any;

    const alice = new GroupSyncService(cmA, persistence);
    const bob = new GroupSyncService(cmB, persistence);

    const stateA: { state: GroupSharedState | null } = { state: null };
    const stateB: { state: GroupSharedState | null } = { state: null };

    alice.setOnStateUpdated((_, s) => { stateA.state = s; });
    bob.setOnStateUpdated((_, s) => { stateB.state = s; });

    const stampA = ts(1000, 0, "alice");
    const stampB = ts(1100, 0, "bob");

    // Alice is already in the group
    await alice.initializeGroup(GROUP_ID, makeState("Test", stampA), undefined, "alice", "Alice");

    // Bob receives Alice's hello (simulated via mergeRemoteMember as in authenticated hello handler)
    const aliceMember = stateA.state!.members["alice"]!;

    // Bob initializes his group state and receives Alice's hello
    await bob.initializeGroup(GROUP_ID, makeState("Test", stampB), undefined, "bob", "Bob");

    // Bob processes Alice's hello — merges Alice's member
    const bobBefore = Object.keys(stateB.state!.members);
    const bobResult = await bob.mergeRemoteMember(GROUP_ID, aliceMember, "alice");
    expect(bobResult.inserted).toBe(true);
    expect(Object.keys(stateB.state!.members).sort()).toEqual(["alice", "bob"]);

    // Bob sends his own member record in response (simulating hello response)
    const bobMember = stateB.state!.members["bob"]!;
    const aliceResult = await alice.mergeRemoteMember(GROUP_ID, bobMember, "bob");
    expect(aliceResult.inserted).toBe(true);
    expect(Object.keys(stateA.state!.members).sort()).toEqual(["alice", "bob"]);

    // Both converge
    expect(Object.keys(stateA.state!.members).sort()).toEqual(Object.keys(stateB.state!.members).sort());
    void bobBefore; // used

    alice.destroy();
    bob.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary convergence (bidirectional)
// ─────────────────────────────────────────────────────────────────────────────

describe("Summary convergence", () => {
  it("remote summary containing unknown member triggers state request via handleGroupMessage", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };

    const sendToPeer = vi.fn().mockResolvedValue(undefined);
    const cmAlice = createMockConnManager() as any;
    cmAlice.getConnection.mockReturnValue({
      broadcast: vi.fn(),
      peerForDevice: vi.fn().mockReturnValue("peer-bob"),
      sendToPeer,
    });

    const alice = new GroupSyncService(cmAlice, persistence);
    const stateA: { state: GroupSharedState | null } = { state: null };
    alice.setOnStateUpdated((_, s) => { stateA.state = s; });

    const stamp = ts(1000, 0, "alice");
    await alice.initializeGroup(GROUP_ID, makeState("Test", stamp), undefined, "alice", "Alice");

    // Alice receives a summary from Bob that mentions "bob" as a member Alice doesn't know
    const bobStamp = ts(2000, 0, "bob");
    const summaryPayload = {
      summary: {
        groupId: GROUP_ID,
        nameStamp: stamp,
        nameHash: "",
        qualityStamp: stamp,
        qualityHash: "",
        memberVersions: {
          bob: {
            profileStamp: bobStamp,
            displayName: "Bob",
          },
        },
        stateHash: "abc",
      },
    };

    await alice.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.summary", summaryPayload, stamp, "bob") as any);
    await tickN();

    // Alice should have requested full state from Bob
    expect(sendToPeer).toHaveBeenCalled();
    const requestPayload = sendToPeer.mock.calls[0]?.[1];
    expect(requestPayload?.type).toBe("group.state.request");

    alice.destroy();
  });

  it("state update can relay members for offline peers", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };

    const cmA = createMockConnManager() as any;
    const cmB = createMockConnManager() as any;

    const alice = new GroupSyncService(cmA, persistence);
    const bob = new GroupSyncService(cmB, persistence);

    const stateA: { state: GroupSharedState | null } = { state: null };
    const stateB: { state: GroupSharedState | null } = { state: null };

    alice.setOnStateUpdated((_, s) => { stateA.state = s; });
    bob.setOnStateUpdated((_, s) => { stateB.state = s; });

    const stampA = ts(1000, 0, "alice");
    const stampB = ts(1100, 0, "bob");
    const stampC = ts(1200, 0, "charlie");

    await alice.initializeGroup(GROUP_ID, makeState("Test", stampA), undefined, "alice", "Alice");

    // Alice already knows Alice, Bob, and Charlie
    // (e.g., she synced with them earlier)
    const fullStateWithThree = makeState("Test", stampA, {
      alice: makeMember("alice", "Alice", stampA),
      bob: makeMember("bob", "Bob", stampB),
      charlie: makeMember("charlie", "Charlie", stampC),
    });

    // Bob initializes knowing only himself
    await bob.initializeGroup(GROUP_ID, makeState("Test", stampB), undefined, "bob", "Bob");

    // Alice sends full state to Bob — Bob should merge all three members
    await bob.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: fullStateWithThree,
    }, stampA, "alice") as any);
    await tickN();

    // Bob now knows Alice, Bob, Charlie — even though Charlie is offline
    expect(Object.keys(stateB.state!.members).sort()).toEqual(["alice", "bob", "charlie"]);
    expect(stateB.state!.members["charlie"]!.displayName).toBe("Charlie");
    // Charlie's firstSeenAt was relayed from Alice's state
    expect(stateB.state!.members["charlie"]!.firstSeenAt).toBe(stampC.wallTimeMs);

    alice.destroy();
    bob.destroy();
  });

  it("mergeRemoteMember for a member that was relayed from offline state doesn't duplicate", async () => {
    const persistence: SyncPersistenceAdapter = {
      persistState: vi.fn().mockResolvedValue(undefined),
      persistClock: vi.fn().mockResolvedValue(undefined),
    };

    const cmA = createMockConnManager() as any;
    const cmB = createMockConnManager() as any;

    const alice = new GroupSyncService(cmA, persistence);
    const bob = new GroupSyncService(cmB, persistence);

    const stateA: { state: GroupSharedState | null } = { state: null };
    const stateB: { state: GroupSharedState | null } = { state: null };

    alice.setOnStateUpdated((_, s) => { stateA.state = s; });
    bob.setOnStateUpdated((_, s) => { stateB.state = s; });

    const stampA = ts(1000, 0, "alice");
    const stampB = ts(1100, 0, "bob");
    const stampC = ts(1200, 0, "charlie");

    await alice.initializeGroup(GROUP_ID, makeState("Test", stampA), undefined, "alice", "Alice");

    // Alice knows Bob, Bob, and Charlie
    const fullState = makeState("Test", stampA, {
      alice: makeMember("alice", "Alice", stampA),
      bob: makeMember("bob", "Bob", stampB),
      charlie: makeMember("charlie", "Charlie", stampC),
    });

    await bob.initializeGroup(GROUP_ID, makeState("Test", stampB), undefined, "bob", "Bob");

    // Bob receives full state — learns Charlie
    await bob.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: fullState,
    }, stampA, "alice") as any);
    await tickN();
    expect(Object.keys(stateB.state!.members).length).toBe(3);

    // Bob receives the same state update again — should not duplicate
    await bob.handleGroupMessage(GROUP_ID, makeEnvelope("group.state.update", {
      state: fullState,
    }, stampA, "alice") as any);
    await tickN();
    expect(Object.keys(stateB.state!.members).length).toBe(3);

    // Charlie's display name is preserved
    expect(stateB.state!.members["charlie"]!.displayName).toBe("Charlie");

    alice.destroy();
    bob.destroy();
  });
});
