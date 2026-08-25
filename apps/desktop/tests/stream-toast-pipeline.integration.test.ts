// @vitest-environment node
//
// Integration suite: real main-store + real notification-watcher, driven the
// same way production drives them (setActiveStreams transitions when stream
// messages arrive). Captures every showStreamToast IPC call and asserts the
// full contract: firing, dedupe, restarts, security gate, local-stream skip,
// and burst/stress behavior.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => {
  return {
    showStreamToast: vi.fn(),
    peerForDevice: vi.fn((): string | null => "peer-uuid-valid"),
    deviceId: "viewer-dev",
  };
});

vi.mock("../src/renderer/services/get-api.js", () => ({
  getApi: () => ({
    showStreamToast: (...args: unknown[]) => h.showStreamToast(...args),
  }),
}));

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: () => ({
    deviceId: h.deviceId,
    getConnectionManager: () => ({
      getConnection: () => ({
        peerForDevice: (device: string) => h.peerForDevice(device),
      }),
    }),
  }),
}));

import { useStore } from "../src/renderer/stores/main-store.js";
import type { StreamAnnouncement } from "@screenlink/shared";
import { startNotificationWatcher } from "../src/renderer/services/notification-watcher.js";

function makeAnnouncement(
  overrides: Partial<StreamAnnouncement> & { groupId: string; hostDeviceId: string },
): StreamAnnouncement {
  return {
    logicalStreamId: overrides.logicalStreamId ?? "ls-1",
    mediaSessionId: overrides.mediaSessionId ?? `ms-${Math.random().toString(36).slice(2)}`,
    groupId: overrides.groupId,
    hostDeviceId: overrides.hostDeviceId,
    hostDisplayName: overrides.hostDisplayName ?? `Host-${overrides.hostDeviceId}`,
    sourceKind: "screen",
    sourceName: "Screen 1",
    startedAt: Date.now(),
    appliedSettingsRevision: 0,
    heartbeatSequence: overrides.heartbeatSequence ?? 1,
    streamRevision: 0,
    mediaJoinMetadata: "",
    replacesSessionId: null,
    ...overrides,
  };
}

function setStreams(byGroup: Record<string, StreamAnnouncement[]>): void {
  useStore.setState({ activeStreamsByGroup: byGroup });
}

describe("stream toast pipeline (integration)", () => {
  let stopWatcher: (() => void) | null = null;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    h.showStreamToast.mockReset();
    h.showStreamToast.mockResolvedValue({ shown: true });
    h.peerForDevice.mockReset();
    h.peerForDevice.mockReturnValue("peer-uuid-valid");
    setStreams({});
    const stop = startNotificationWatcher();
    stopWatcher = stop;
    cleanups.push(stop);
  });

  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) c();
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
    setStreams({});
  });

  it("fires one toast with correct payload when a remote host starts streaming", async () => {
    setStreams({
      "g-weekly": [
        makeAnnouncement({ groupId: "g-weekly", hostDeviceId: "host-a", hostDisplayName: "Alice" }),
      ],
    });

    await vi.waitFor(() => {
      expect(h.showStreamToast).toHaveBeenCalledTimes(1);
    });

    const call = h.showStreamToast.mock.calls[0][0];
    expect(call).toMatchObject({
      groupId: "g-weekly",
      hostDeviceId: "host-a",
      logicalStreamId: "ls-1",
      hostName: "Alice",
      groupName: "g-weekly",
    });
  });

  it("does not re-fire for heartbeat updates of the same media session", async () => {
    const ann = makeAnnouncement({ groupId: "g1", hostDeviceId: "h1", heartbeatSequence: 1 });
    setStreams({ g1: [ann] });
    await vi.waitFor(() => expect(h.showStreamToast).toHaveBeenCalledTimes(1));

    // Heartbeat: same identity, higher sequence, same mediaSessionId.
    setStreams({
      g1: [{ ...ann, heartbeatSequence: 2, startedAt: ann.startedAt + 1000 }],
    });
    setStreams({
      g1: [{ ...ann, heartbeatSequence: 3 }],
    });
    expect(h.showStreamToast).toHaveBeenCalledTimes(1);
  });

  it("fires again when a stream restarts with a new media session", async () => {
    setStreams({
      g1: [makeAnnouncement({ groupId: "g1", hostDeviceId: "h1", mediaSessionId: "ms-A" })],
    });
    await vi.waitFor(() => expect(h.showStreamToast).toHaveBeenCalledTimes(1));

    setStreams({
      g1: [makeAnnouncement({ groupId: "g1", hostDeviceId: "h1", mediaSessionId: "ms-B" })],
    });
    await vi.waitFor(() => expect(h.showStreamToast).toHaveBeenCalledTimes(2));
  });

  it("never fires for the local device's own stream", async () => {
    h.deviceId = "viewer-dev";
    setStreams({
      g1: [makeAnnouncement({ groupId: "g1", hostDeviceId: "viewer-dev" })],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.showStreamToast).not.toHaveBeenCalled();
  });

  it("rejects events whose host is not an authenticated peer", async () => {
    h.peerForDevice.mockReturnValue(null);
    setStreams({
      g1: [makeAnnouncement({ groupId: "g1", hostDeviceId: "stranger" })],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.showStreamToast).not.toHaveBeenCalled();
  });

  it("stops firing after the watcher is unsubscribed", async () => {
    stopWatcher?.();
    stopWatcher = null;

    setStreams({
      g1: [makeAnnouncement({ groupId: "g1", hostDeviceId: "h1" })],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.showStreamToast).not.toHaveBeenCalled();
  });

  it("stress: 50 rapid starts across groups produce exactly 50 toasts with no duplicates", async () => {
    const byGroup: Record<string, StreamAnnouncement[]> = {};
    const expectedKeys: string[] = [];

    for (let g = 0; g < 5; g++) {
      byGroup[`group-${g}`] = [];
      for (let n = 0; n < 10; n++) {
        const ann = makeAnnouncement({
          groupId: `group-${g}`,
          hostDeviceId: `host-${g}-${n}`,
          logicalStreamId: `ls-${g}-${n}`,
        });
        byGroup[`group-${g}`].push(ann);
        expectedKeys.push(`${ann.groupId}:${ann.hostDeviceId}:${ann.logicalStreamId}`);
      }
    }

    setStreams(byGroup);

    await vi.waitFor(() => {
      expect(h.showStreamToast).toHaveBeenCalledTimes(expectedKeys.length);
    });

    const seenKeys = new Set(
      h.showStreamToast.mock.calls.map(
        (c: any[]) => `${c[0].groupId}:${c[0].hostDeviceId}:${c[0].logicalStreamId}`,
      ),
    );
    expect(seenKeys.size).toBe(expectedKeys.length);
  });

  it("stress: identical repeated transitions do not multiply toasts", async () => {
    const ann = makeAnnouncement({ groupId: "g1", hostDeviceId: "h1" });
    const snapshot = { g1: [ann] };

    for (let i = 0; i < 10; i++) {
      setStreams(snapshot); // identical contents, fresh reference each time
    }

    await vi.waitFor(() => expect(h.showStreamToast).toHaveBeenCalledTimes(1));
    expect(h.showStreamToast).toHaveBeenCalledTimes(1);
  });

  it("surfaces the not-shown reason from the main process (fullscreen)", async () => {
    h.showStreamToast.mockResolvedValue({ shown: false, reason: "fullscreen" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      setStreams({
        g1: [makeAnnouncement({ groupId: "g1", hostDeviceId: "h1" })],
      });
      await vi.waitFor(() => expect(h.showStreamToast).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => {
        expect(logSpy).toHaveBeenCalledWith(
          "[notification-watcher] toast not shown:",
          "fullscreen",
        );
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});
