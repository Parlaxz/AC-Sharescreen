import { describe, it, expect } from "vitest";
import {
  mergeGroupSharedState,
  canonicalJsonHash,
} from "@screenlink/shared";
import type {
  GroupSharedState,
  HybridTimestamp,
  GroupMemberRecord,
  GroupQualitySettings,
} from "@screenlink/shared";

// ─── Helpers ───────────────────────────────────────────────────────────────

const defaultSettings: GroupQualitySettings = {
  videoBitrateKbps: 1800,
  maxWidth: 1280,
  maxHeight: 720,
  maxFps: 30,
  degradationPreference: "balanced",
  contentHint: "detail",
  audioEnabled: true,
};

function ts(wallTimeMs: number, counter: number, nodeId: string): HybridTimestamp {
  return { wallTimeMs, counter, nodeId };
}

function makeState(
  groupId: string,
  name: string,
  nameStamp: HybridTimestamp,
  settings: GroupQualitySettings,
  settingsStamp: HybridTimestamp,
  members: Record<string, GroupMemberRecord> = {},
  nameHash?: string,
  settingsHash?: string,
): GroupSharedState {
  return {
    schemaVersion: 1,
    groupId,
    name: { value: name, stamp: nameStamp, valueHash: nameHash ?? "", updatedByDeviceId: "" },
    defaultQuality: { value: settings, stamp: settingsStamp, valueHash: settingsHash ?? "", updatedByDeviceId: "" },
    members,
  };
}

function makeMember(
  deviceId: string,
  displayName: string,
  stamp: HybridTimestamp,
): GroupMemberRecord {
  return {
    deviceId,
    displayName,
    firstSeenAt: stamp.wallTimeMs,
    profileStamp: stamp,
  };
}

describe("GroupSync", () => {
  it("name merge: remote newer name wins", () => {
    const local = makeState("g1", "Old Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"));
    const remote = makeState("g1", "New Name", ts(200, 0, "a"), defaultSettings, ts(100, 0, "a"));
    const result = mergeGroupSharedState(local, remote);
    expect(result.state.name.value).toBe("New Name");
    expect(result.changed).toBe(true);
  });

  it("name merge: local newer name stays", () => {
    const local = makeState("g1", "New Name", ts(200, 0, "a"), defaultSettings, ts(100, 0, "a"));
    const remote = makeState("g1", "Old Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"));
    const result = mergeGroupSharedState(local, remote);
    expect(result.state.name.value).toBe("New Name");
    expect(result.changed).toBe(false);
  });

  it("default quality merge: remote newer settings wins", () => {
    const oldSettings: GroupQualitySettings = { ...defaultSettings, videoBitrateKbps: 1000 };
    const newSettings: GroupQualitySettings = { ...defaultSettings, videoBitrateKbps: 3000 };
    const local = makeState("g1", "Name", ts(100, 0, "a"), oldSettings, ts(100, 0, "a"));
    const remote = makeState("g1", "Name", ts(100, 0, "a"), newSettings, ts(200, 0, "a"));
    const result = mergeGroupSharedState(local, remote);
    expect(result.state.defaultQuality.value.videoBitrateKbps).toBe(3000);
    expect(result.changed).toBe(true);
  });

  it("member merge: new member from remote is added", () => {
    const local = makeState("g1", "Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"));
    const remote = makeState("g1", "Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"), {
      "device-b": makeMember("device-b", "Bob", ts(150, 0, "b")),
    });
    const result = mergeGroupSharedState(local, remote);
    expect(result.state.members["device-b"]).toBeDefined();
    expect(result.state.members["device-b"]!.displayName).toBe("Bob");
    expect(result.changed).toBe(true);
  });

  it("member merge: member newer profileStamp wins", () => {
    const local = makeState("g1", "Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"), {
      "device-b": makeMember("device-b", "OldName", ts(100, 0, "b")),
    });
    const remote = makeState("g1", "Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"), {
      "device-b": makeMember("device-b", "NewName", ts(200, 0, "b")),
    });
    const result = mergeGroupSharedState(local, remote);
    expect(result.state.members["device-b"]!.displayName).toBe("NewName");
    expect(result.changed).toBe(true);
  });

  it("member merge: concurrent add with different device IDs keeps both", () => {
    const local = makeState("g1", "Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"), {
      "device-a": makeMember("device-a", "Alice", ts(100, 0, "a")),
    });
    const remote = makeState("g1", "Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"), {
      "device-b": makeMember("device-b", "Bob", ts(100, 0, "b")),
    });
    const result = mergeGroupSharedState(local, remote);
    expect(result.state.members["device-a"]).toBeDefined();
    expect(result.state.members["device-b"]).toBeDefined();
    expect(result.changed).toBe(true);
  });

  it("member merge: local members not erased by remote without those members", () => {
    const local = makeState("g1", "Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"), {
      "device-a": makeMember("device-a", "Alice", ts(100, 0, "a")),
      "device-b": makeMember("device-b", "Bob", ts(100, 0, "b")),
    });
    const remote = makeState("g1", "Name", ts(100, 0, "a"), defaultSettings, ts(100, 0, "a"), {
      "device-a": makeMember("device-a", "Alice", ts(100, 0, "a")),
      // device-b is NOT in remote
    });
    const result = mergeGroupSharedState(local, remote);
    // device-b must still be present — never erased
    expect(result.state.members["device-b"]).toBeDefined();
    expect(result.state.members["device-b"]!.displayName).toBe("Bob");
    // device-a has same stamp+value in both → no change
    expect(result.changed).toBe(false);
  });

  it("name merge: concurrent equal stamp with different values reports conflict", async () => {
    const aliceHash = await canonicalJsonHash("Alice");
    const bobHash = await canonicalJsonHash("Bob");
    const stampA = ts(100, 1, "node-a");
    const stampB = ts(100, 1, "node-b");
    const local = makeState("g1", "Alice", stampA, defaultSettings, stampA, {}, aliceHash);
    const remote = makeState("g1", "Bob", stampB, defaultSettings, stampA, {}, bobHash);
    const result = mergeGroupSharedState(local, remote);
    // Lower nodeId wins (node-a < node-b)
    expect(result.state.name.value).toBe("Alice");
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0]!.field).toBe("name");
  });

  it("propagation: A → B → C merges consistently", () => {
    // Scenario: Three nodes start with same state
    const baseStamp = ts(100, 0, "");

    const initialA = makeState("g1", "Room A", baseStamp, defaultSettings, baseStamp);
    const initialB = makeState("g1", "Room A", baseStamp, defaultSettings, baseStamp);
    const initialC = makeState("g1", "Room A", baseStamp, defaultSettings, baseStamp);

    // A renames to "Alice Room"
    const aNameStamp = ts(200, 0, "node-a");
    const stateA = makeState("g1", "Alice Room", aNameStamp, defaultSettings, baseStamp);

    // B adds a member
    const bMemberStamp = ts(150, 0, "node-b");
    const stateB: GroupSharedState = {
      ...initialB,
      members: {
        "device-b": makeMember("device-b", "Bob", bMemberStamp),
      },
    };

    // A and B merge into C
    const mergedA = mergeGroupSharedState(initialC, stateA);
    const mergedAB = mergeGroupSharedState(mergedA.state, stateB);

    // C should have Alice Room name AND Bob member
    expect(mergedAB.state.name.value).toBe("Alice Room");
    expect(mergedAB.state.members["device-b"]).toBeDefined();
    expect(mergedAB.state.members["device-b"]!.displayName).toBe("Bob");
    expect(mergedAB.changed).toBe(true);
  });
});
