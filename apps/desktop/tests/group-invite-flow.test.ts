// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GroupStore } from "../src/main/group-store.js";
import type { SecureStore } from "../src/main/secure-store.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createGroupInvite,
  formatGroupInviteLink,
  parseGroupInviteLink,
  type GroupInviteV1,
  type GroupMemberRecord,
} from "@screenlink/shared";

class MockSecureStore implements SecureStore {
  private store = new Map<string, string>();
  encrypt(plaintext: string): Buffer | null {
    const encoded = Buffer.from(plaintext, "utf-8");
    this.store.set(encoded.toString("base64"), plaintext);
    return encoded;
  }
  decrypt(encrypted: Buffer): string | null {
    const key = encrypted.toString("base64");
    return this.store.get(key) ?? null;
  }
  isEncryptionAvailable(): boolean {
    return true;
  }
}

const DEVICE_ID = "device-creator-1";
const DISPLAY_NAME = "Alice";
const GROUP_NAME = "Test Group";
const GROUP_ID = "00000000-0000-4000-8000-000000000001";

describe("GroupStore — invite flow fixes", () => {
  let dir: string;
  let store: GroupStore;
  let secure: MockSecureStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "screenlink-groups-test-"));
    secure = new MockSecureStore();
    store = new GroupStore(secure as unknown as SecureStore, dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Fix 1: create-group returns immediately usable link ───────────────

  it("create() adds creator as a member and stores creatorDeviceId", async () => {
    const record = await store.create({
      groupId: GROUP_ID,
      controlRoomId: "ctrl-room-1",
      groupSecret: "secret-1",
      nodeId: DEVICE_ID,
      groupName: GROUP_NAME,
      displayName: DISPLAY_NAME,
    });

    // Creator should be in members
    expect(record.sharedState.members[DEVICE_ID]).toBeDefined();
    expect(record.sharedState.members[DEVICE_ID]!.displayName).toBe(DISPLAY_NAME);
    expect(record.sharedState.members[DEVICE_ID]!.deviceId).toBe(DEVICE_ID);
    expect(record.sharedState.members[DEVICE_ID]!.firstSeenAt).toBeGreaterThan(0);
    expect(record.sharedState.members[DEVICE_ID]!.profileStamp).toBeDefined();
    expect(record.sharedState.members[DEVICE_ID]!.profileStamp.nodeId).toBe(DEVICE_ID);

    // Should have creatorDeviceId
    expect(record).toHaveProperty("creatorDeviceId");
    expect((record as any).creatorDeviceId).toBe(DEVICE_ID);
  });

  it("getInviteLink returns immediately usable link matching createGroupInvite", async () => {
    // Create a group with a creator
    const record = await store.create({
      groupId: GROUP_ID,
      controlRoomId: "ctrl-room-2",
      groupSecret: "secret-2",
      nodeId: DEVICE_ID,
      groupName: GROUP_NAME,
      displayName: DISPLAY_NAME,
    });

    const link = store.getInviteLink(GROUP_ID);
    expect(link).toBeTruthy();
    expect(link).toContain("screenlink://group?");
    expect(link).toContain("v=1");

    // Parse the link to verify bootstrapCreator data
    const parsed = parseGroupInviteLink(link!);
    expect(parsed).toBeTruthy();
    expect(parsed!.bootstrapCreator).toBeDefined();
    expect(parsed!.bootstrapCreator.deviceId).toBe(DEVICE_ID);
    expect(parsed!.bootstrapCreator.displayName).toBe(DISPLAY_NAME);
    expect(parsed!.bootstrapCreator.firstSeenAt).toBeGreaterThan(0);
    expect(parsed!.bootstrapCreator.profileStamp.nodeId).toBe(DEVICE_ID);
  });

  // ── Fix 2: getGroupInvite includes real bootstrapCreator data ──────────

  it("getInviteLink bootstrapCreator matches the group's creator member", async () => {
    const record = await store.create({
      groupId: GROUP_ID,
      controlRoomId: "ctrl-room-3",
      groupSecret: "secret-3",
      nodeId: DEVICE_ID,
      groupName: GROUP_NAME,
      displayName: DISPLAY_NAME,
    });

    const link = store.getInviteLink(GROUP_ID);
    const parsed = parseGroupInviteLink(link!);
    expect(parsed).toBeTruthy();

    const creatorMember = record.sharedState.members[DEVICE_ID]!;
    expect(parsed!.bootstrapCreator.deviceId).toBe(creatorMember.deviceId);
    expect(parsed!.bootstrapCreator.displayName).toBe(creatorMember.displayName);
    expect(parsed!.bootstrapCreator.firstSeenAt).toBe(creatorMember.firstSeenAt);
    expect(parsed!.bootstrapCreator.profileStamp.wallTimeMs).toBe(creatorMember.profileStamp.wallTimeMs);
    expect(parsed!.bootstrapCreator.profileStamp.nodeId).toBe(creatorMember.profileStamp.nodeId);
  });

  // ── Fix 3: importing an invite seeds member directory with bootstrapCreator ──

  it("import() adds bootstrapCreator from invite to members", async () => {
    // First, create an invite with bootstrapCreator data
    const invite = createGroupInvite({
      groupName: "Shared Group",
      displayName: "Bob",
      nodeId: "device-bob",
      groupId: "00000000-0000-4000-8000-000000000002",
    });

    // Now import it as a different user
    const joiningNodeId = "device-importing-user";
    const joiningDisplayName = "Charlie";

    const record = await store.import({
      invite,
      nodeId: joiningNodeId,
      displayName: joiningDisplayName,
    });

    // Bootstrap creator should be in members
    expect(record.sharedState.members["device-bob"]).toBeDefined();
    expect(record.sharedState.members["device-bob"]!.displayName).toBe("Bob");
    expect(record.sharedState.members["device-bob"]!.deviceId).toBe("device-bob");

    // Joining user should also be in members
    expect(record.sharedState.members[joiningNodeId]).toBeDefined();
    expect(record.sharedState.members[joiningNodeId]!.displayName).toBe(joiningDisplayName);
    expect(record.sharedState.members[joiningNodeId]!.deviceId).toBe(joiningNodeId);
  });

  it("import() bootstrapCreator member has correct profileStamp", async () => {
    const invite = createGroupInvite({
      groupName: "Another Group",
      displayName: "CreatorName",
      nodeId: "device-creator",
      groupId: "00000000-0000-4000-8000-000000000003",
    });

    const record = await store.import({
      invite,
      nodeId: "device-joiner",
      displayName: "JoinerName",
    });

    const creatorMember = record.sharedState.members["device-creator"]!;
    expect(creatorMember.firstSeenAt).toBe(invite.bootstrapCreator.firstSeenAt);
    expect(creatorMember.profileStamp.wallTimeMs).toBe(invite.bootstrapCreator.profileStamp.wallTimeMs);
    expect(creatorMember.profileStamp.counter).toBe(invite.bootstrapCreator.profileStamp.counter);
    expect(creatorMember.profileStamp.nodeId).toBe(invite.bootstrapCreator.profileStamp.nodeId);
  });

  // ── Round-trip: create → export → import preserves creator ──────────────

  it("round-trip: create group, getInviteLink, import preserves creator member", async () => {
    // Step 1: Creator creates a group
    const record = await store.create({
      groupId: GROUP_ID,
      controlRoomId: "ctrl-room-4",
      groupSecret: "secret-4",
      nodeId: DEVICE_ID,
      groupName: GROUP_NAME,
      displayName: DISPLAY_NAME,
    });

    // Step 2: Get invite link (which now has bootstrapCreator data)
    const link = store.getInviteLink(GROUP_ID);

    // Simulate another instance: new store, import the link
    const dir2 = mkdtempSync(path.join(tmpdir(), "screenlink-groups-test-2-"));
    const store2 = new GroupStore(secure as unknown as SecureStore, dir2);

    const parsed = parseGroupInviteLink(link!);
    expect(parsed).toBeTruthy();

    const importedRecord = await store2.import({
      invite: parsed!,
      nodeId: "device-joiner-2",
      displayName: "Dave",
    });

    // The imported group should have the original creator as a member
    expect(importedRecord.sharedState.members[DEVICE_ID]).toBeDefined();
    expect(importedRecord.sharedState.members[DEVICE_ID]!.displayName).toBe(DISPLAY_NAME);

    // And the joining user
    expect(importedRecord.sharedState.members["device-joiner-2"]).toBeDefined();
    expect(importedRecord.sharedState.members["device-joiner-2"]!.displayName).toBe("Dave");

    // Clean up second store
    rmSync(dir2, { recursive: true, force: true });
  });

  it("create-group via IPC returns link field", async () => {
    // Simulate what the IPC handler does
    const identity = { deviceId: "ipc-device", displayName: "IPC User", createdAt: 0 };
    const input = { groupName: "IPC Group" };

    const invite = createGroupInvite({
      groupName: input.groupName,
      displayName: identity.displayName,
      nodeId: identity.deviceId,
    });

    const link = formatGroupInviteLink(invite);

    const record = await store.create({
      groupId: invite.groupId,
      controlRoomId: invite.controlRoomId,
      groupSecret: invite.groupSecret,
      nodeId: identity.deviceId,
      groupName: input.groupName,
      displayName: identity.displayName,
    });

    const result = { record, invite, link };

    // Assert: link is present and usable
    expect(result.link).toBeTruthy();
    expect(result.link).toContain("screenlink://group?");

    // The link should be parseable and contain correct bootstrapCreator
    const parsed = parseGroupInviteLink(result.link);
    expect(parsed).toBeTruthy();
    expect(parsed!.bootstrapCreator.deviceId).toBe(identity.deviceId);
    expect(parsed!.bootstrapCreator.displayName).toBe("IPC User");
  });
});
