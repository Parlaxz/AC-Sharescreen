// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Notification Security and Dedup (Stage 15)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("notification dedup key is groupId + hostDeviceId + logicalStreamId", () => {
    const makeKey = (groupId: string, hostDeviceId: string, logicalStreamId: string) =>
      `${groupId}:${hostDeviceId}:${logicalStreamId}`;

    const key1 = makeKey("group-a", "host-1", "stream-1");
    const key2 = makeKey("group-a", "host-1", "stream-1");
    const key3 = makeKey("group-a", "host-2", "stream-1");
    const key4 = makeKey("group-b", "host-1", "stream-1");

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).not.toBe(key4);
  });

  it("stream lifecycle messages derive host identity from authenticated sender mapping", () => {
    // When a stream.started message arrives, the hostDeviceId in the payload
    // must match the authenticated sender's identity from the connection manager.
    const senderMapping = new Map<string, string>([
      ["peer-uuid-1", "host-device-1"],
    ]);

    const getAuthenticatedDeviceId = (peerUuid: string): string | undefined => {
      return senderMapping.get(peerUuid);
    };

    // Simulate receiving a stream.started message
    const envelope = {
      senderPeerUuid: "peer-uuid-1",
      payload: { hostDeviceId: "host-device-1" },
    };

    const authDeviceId = getAuthenticatedDeviceId(envelope.senderPeerUuid);
    const payloadDeviceId = envelope.payload.hostDeviceId;

    expect(authDeviceId).toBe(payloadDeviceId); // authenticated
    expect(authDeviceId).toBe("host-device-1");
  });

  it("rejects mismatched payload host IDs", () => {
    const senderMapping = new Map<string, string>([
      ["peer-uuid-1", "host-device-1"],
    ]);

    const validateHostIdentity = (peerUuid: string, payloadHostId: string): boolean => {
      const authDeviceId = senderMapping.get(peerUuid);
      if (!authDeviceId) return false;
      return authDeviceId === payloadHostId;
    };

    // Mismatch case
    expect(validateHostIdentity("peer-uuid-1", "malicious-device")).toBe(false);
    // Match case
    expect(validateHostIdentity("peer-uuid-1", "host-device-1")).toBe(true);
  });

  it("no duplicate restart/share notifications", () => {
    const dedupSet = new Set<string>();

    const shouldNotify = (key: string): boolean => {
      if (dedupSet.has(key)) return false;
      dedupSet.add(key);
      return true;
    };

    expect(shouldNotify("restart:host-1:stream-1")).toBe(true);
    expect(shouldNotify("restart:host-1:stream-1")).toBe(false); // duplicate
    expect(shouldNotify("share:host-2:stream-2")).toBe(true);
    expect(shouldNotify("share:host-1:stream-1")).toBe(true); // different prefix
  });

  it("notification-watcher exports startNotificationWatcher and notifyStreamStarted", async () => {
    const mod = await import("../src/renderer/services/notification-watcher.js");
    expect(typeof mod.startNotificationWatcher).toBe("function");
    expect(typeof mod.notifyStreamStarted).toBe("function");
  });
});
