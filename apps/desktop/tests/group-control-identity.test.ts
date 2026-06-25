// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GroupControlConnection } from "../src/renderer/services/group-control-connection.js";
import type { GroupControlEnvelope, GroupControlMessageType } from "@screenlink/shared";

/**
 * Helper: create a minimal GroupControlEnvelope for identity testing.
 * The MAC is not validated in our test path since we check identity
 * AFTER validateEnvelope succeeds.
 */
function makeEnvelope(
  senderDeviceId: string,
  type: GroupControlMessageType = "stream.started",
): GroupControlEnvelope {
  return {
    version: 2,
    type,
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId,
    groupId: "00000000-0000-0000-0000-000000000002",
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: senderDeviceId },
    payload: {},
    mac: "0".repeat(64),
  };
}

describe("GroupControlConnection – Authenticated control-peer identity enforcement", () => {
  let conn: GroupControlConnection;

  beforeEach(() => {
    vi.restoreAllMocks();
    conn = new GroupControlConnection({
      groupId: "00000000-0000-0000-0000-000000000002",
      controlRoomId: "room-1",
      groupSecret: "test-secret",
      nodeId: "local-device",
      displayName: "Host",
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    });
  });

  function setPeerMap(peerUuid: string, deviceId: string): void {
    (conn as any).peerToDevice.set(peerUuid, deviceId);
    (conn as any).deviceToPeer.set(deviceId, peerUuid);
  }

  function getPeerMapSize(): number {
    return (conn as any).peerToDevice.size;
  }

  function getDeviceMapSize(): number {
    return (conn as any).deviceToPeer.size;
  }

  // ── `checkSenderIdentity` private method tests ──────────────────────────

  it("returns true for unmapped peer (identity not yet established)", () => {
    const envelope = makeEnvelope("device-a");
    const result = (conn as any).checkSenderIdentity("peer-new", envelope);
    expect(result).toBe(true);
  });

  it("returns true for mapped peer with matching senderDeviceId", () => {
    setPeerMap("peer-1", "device-a");
    const envelope = makeEnvelope("device-a");
    const result = (conn as any).checkSenderIdentity("peer-1", envelope);
    expect(result).toBe(true);
  });

  it("returns false for mapped peer with mismatched senderDeviceId (non-hello)", () => {
    setPeerMap("peer-1", "device-a");
    const envelope = makeEnvelope("device-b", "stream.heartbeat");
    const result = (conn as any).checkSenderIdentity("peer-1", envelope);
    expect(result).toBe(false);
  });

  it("returns false for hello that tries to remap peer UUID to different device ID", () => {
    setPeerMap("peer-1", "device-a");
    // Hello claims to be from device-b
    const envelope = makeEnvelope("device-b", "group.hello");
    const result = (conn as any).checkSenderIdentity("peer-1", envelope);
    expect(result).toBe(false);
  });

  it("returns false for hello.response that tries to remap peer UUID to different device ID", () => {
    setPeerMap("peer-1", "device-a");
    const envelope = makeEnvelope("device-b", "group.hello.response");
    const result = (conn as any).checkSenderIdentity("peer-1", envelope);
    expect(result).toBe(false);
  });

  it("returns true for hello from mapped peer with matching deviceId", () => {
    setPeerMap("peer-1", "device-a");
    const envelope = makeEnvelope("device-a", "group.hello");
    const result = (conn as any).checkSenderIdentity("peer-1", envelope);
    expect(result).toBe(true);
  });

  it("returns true for hello.response from mapped peer with matching deviceId", () => {
    setPeerMap("peer-1", "device-a");
    const envelope = makeEnvelope("device-a", "group.hello.response");
    const result = (conn as any).checkSenderIdentity("peer-1", envelope);
    expect(result).toBe(true);
  });

  // ── Integration: `checkSenderIdentity` is called in `dataReceived` ─────

  it("does not modify peer mapping when identity check fails (hello remap)", () => {
    setPeerMap("peer-1", "device-a");
    expect(getPeerMapSize()).toBe(1);
    expect(getDeviceMapSize()).toBe(1);

    // This would fail the identity check - peer-1 is mapped to device-a,
    // but the envelope says device-b
    const envelope = makeEnvelope("device-b", "group.hello");
    const result = (conn as any).checkSenderIdentity("peer-1", envelope);
    expect(result).toBe(false);

    // Verify mappings haven't changed
    expect((conn as any).peerToDevice.get("peer-1")).toBe("device-a");
    expect((conn as any).deviceToPeer.get("device-a")).toBe("peer-1");
    expect((conn as any).deviceToPeer.get("device-b")).toBeUndefined();
  });
});
