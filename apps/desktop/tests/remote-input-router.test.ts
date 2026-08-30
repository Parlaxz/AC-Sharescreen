// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupMessageRouter } from "../src/renderer/services/group-message-router.js";
import { ActiveStreamRegistry } from "../src/renderer/services/active-stream-registry.js";
import type { GroupControlEnvelope } from "@screenlink/shared";

const GROUP_ID = "group-1";
const permissions = { arrowLeft: true, arrowRight: true, space: true, d: true, s: true };

function envelope(payload: Record<string, unknown>, senderDeviceId = "viewer-1"): GroupControlEnvelope {
  return {
    version: 3,
    type: "viewer.input.request",
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId,
    groupId: GROUP_ID,
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: senderDeviceId },
    payload,
    mac: "mac",
  };
}

describe("remote input host authorization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
  });

  it("maps an allowed request to sendShortcut without modifiers", async () => {
    const sendShortcut = vi.fn().mockResolvedValue({ success: true });
    (globalThis as { window?: unknown }).window = { screenlink: { sendShortcut } };
    const session = {
      state: "active",
      currentGroupId: GROUP_ID,
      currentLogicalStreamId: "stream-1",
      getInputPermissions: () => permissions,
    };
    const router = new GroupMessageRouter({} as any, {} as any, {} as any);
    router.setRuntime({
      getStreamSessionManager: () => session,
      isDestroyed: () => false,
    } as any);

    router.routeMessage(GROUP_ID, envelope({
      groupId: GROUP_ID,
      logicalStreamId: "stream-1",
      viewerDeviceId: "viewer-1",
      key: "Space",
    }));
    await Promise.resolve();

    expect(sendShortcut).toHaveBeenCalledWith({ modifiers: [], key: "SPACE" });
  });

  it("rejects sender mismatches and denied keys", async () => {
    const sendShortcut = vi.fn().mockResolvedValue({ success: true });
    (globalThis as { window?: unknown }).window = { screenlink: { sendShortcut } };
    const router = new GroupMessageRouter({} as any, {} as any, {} as any);
    router.setRuntime({
      getStreamSessionManager: () => ({
        state: "active",
        currentGroupId: GROUP_ID,
        currentLogicalStreamId: "stream-1",
        getInputPermissions: () => ({ ...permissions, d: false }),
      }),
      isDestroyed: () => false,
    } as any);

    router.routeMessage(GROUP_ID, envelope({
      groupId: GROUP_ID,
      logicalStreamId: "stream-1",
      viewerDeviceId: "other-viewer",
      key: "ArrowLeft",
    }));
    router.routeMessage(GROUP_ID, envelope({
      groupId: GROUP_ID,
      logicalStreamId: "stream-1",
      viewerDeviceId: "viewer-1",
      key: "d",
    }));
    await Promise.resolve();

    expect(sendShortcut).not.toHaveBeenCalled();
  });

  it("accepts a permission-only snapshot without advancing heartbeat state", () => {
    const registry = new ActiveStreamRegistry(10_000, 60_000);
    const updates: string[] = [];
    registry.onUpdate((update) => updates.push(update.type));
    const announcement = {
      logicalStreamId: "stream-1",
      mediaSessionId: "session-1",
      groupId: GROUP_ID,
      hostDeviceId: "host-1",
      hostDisplayName: "Host",
      sourceKind: "screen",
      sourceName: "Display",
      startedAt: 1,
      appliedSettingsRevision: 0,
      heartbeatSequence: 2,
      streamRevision: 1,
      mediaJoinMetadata: "",
      replacesSessionId: null,
    };
    registry.handleStarted(announcement);
    registry.handleSnapshot([{ ...announcement, inputPermissions: permissions }]);

    expect(registry.getAllStreams()[0].inputPermissions).toEqual(permissions);
    expect(updates).toEqual(["new", "updated"]);
    registry.destroy();
  });
});
