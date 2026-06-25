import { describe, it, expect } from "vitest";
import {
  createGroupInvite,
  formatGroupInviteLink,
  parseGroupInviteCode,
  parseGroupInviteLink,
  GroupInviteV1Schema,
} from "@screenlink/shared";

describe("GroupLink", () => {
  const nodeId = "test-node";
  const displayName = "Alice";
  const groupName = "Test Group";

  it("createGroupInvite produces a valid invite", () => {
    const invite = createGroupInvite({ groupName, displayName, nodeId });
    expect(invite.version).toBe(1);
    expect(invite.groupId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(invite.controlRoomId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(invite.groupSecret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(invite.bootstrapName).toBe(groupName);
    expect(invite.bootstrapCreator.deviceId).toBe(nodeId);
    expect(invite.bootstrapCreator.displayName).toBe(displayName);
    expect(invite.bootstrapCreator.firstSeenAt).toBeGreaterThan(0);
    expect(GroupInviteV1Schema.safeParse(invite).success).toBe(true);
  });

  it("createGroupInvite accepts optional groupId override", () => {
    const fixedId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const invite = createGroupInvite({
      groupName,
      displayName,
      nodeId,
      groupId: fixedId,
    });
    expect(invite.groupId).toBe(fixedId);
  });

  it("createGroupInvite uses nowMs override", () => {
    const invite = createGroupInvite({
      groupName,
      displayName,
      nodeId,
      nowMs: 12345,
    });
    expect(invite.bootstrapNameStamp.wallTimeMs).toBe(12345);
    expect(invite.bootstrapSettingsStamp.wallTimeMs).toBe(12345);
  });

  it("formatGroupInviteLink round-trips through parseGroupInviteLink", () => {
    const invite = createGroupInvite({ groupName, displayName, nodeId });
    const link = formatGroupInviteLink(invite);
    expect(link).toMatch(/^screenlink:\/\/group\?v=1&data=/);

    const parsed = parseGroupInviteLink(link);
    expect(parsed).not.toBeNull();
    expect(parsed!.groupId).toBe(invite.groupId);
    expect(parsed!.bootstrapName).toBe(invite.bootstrapName);
    expect(parsed!.groupSecret).toBe(invite.groupSecret);
  });

  it("parseGroupInviteCode handles malformed input", () => {
    expect(parseGroupInviteCode("")).toBeNull();
    expect(parseGroupInviteCode("not-base64url!!")).toBeNull();
    expect(parseGroupInviteCode("YWJj")).toBeNull(); // abc - not valid invite JSON
  });

  it("parseGroupInviteLink rejects wrong prefix", () => {
    expect(parseGroupInviteLink("https://evil.com")).toBeNull();
    expect(parseGroupInviteLink("screenlink://group?v=2&data=x")).toBeNull();
  });

  it("parseGroupInviteCode round-trips through formatGroupInviteLink code portion", () => {
    const invite = createGroupInvite({ groupName, displayName, nodeId });
    const link = formatGroupInviteLink(invite);
    const code = link.slice(link.indexOf("data=") + 5);
    const parsed = parseGroupInviteCode(decodeURIComponent(code));
    expect(parsed).not.toBeNull();
    expect(parsed!.groupId).toBe(invite.groupId);
  });

  it("generates unique controlRoomId and groupSecret each call", () => {
    const ids = new Set<string>();
    const secrets = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const invite = createGroupInvite({ groupName: `g${i}`, displayName, nodeId });
      ids.add(invite.controlRoomId);
      secrets.add(invite.groupSecret);
    }
    expect(ids.size).toBe(20);
    expect(secrets.size).toBe(20);
  });

  it("invite payload is within size bounds", () => {
    const invite = createGroupInvite({
      groupName: "x".repeat(1000),
      displayName: "y".repeat(100),
      nodeId: "z".repeat(100),
    });
    const serialized = JSON.stringify(invite);
    expect(serialized.length).toBeLessThan(64 * 1024);
  });

  it("does not log secrets in invite data", () => {
    // Verify that groupSecret and controlRoomId are NOT in the URL path
    // in an unencoded way (they should be base64url encoded as part of JSON)
    const invite = createGroupInvite({ groupName, displayName, nodeId });
    const link = formatGroupInviteLink(invite);
    // The secret should not appear as-is in the URL
    expect(link).not.toContain(invite.groupSecret);
    expect(link).not.toContain(invite.controlRoomId);
  });
});
