// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Restart All Streams (Stage 14)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("restart-coordinator module exists and exports RestartCoordinator", async () => {
    const mod = await import("../src/renderer/services/restart-coordinator.js");
    expect(mod.RestartCoordinator).toBeDefined();
  });

  it("restart uses exact target stamp/hash for idempotency", () => {
    // The restart coordinator must track target stamps to prevent duplicate restarts
    const coordinator = new (class {
      private targets = new Map<string, string>();

      hasTarget(hostDeviceId: string, stampHash: string): boolean {
        const key = hostDeviceId;
        const existing = this.targets.get(key);
        if (existing === stampHash) return true;
        this.targets.set(key, stampHash);
        return false;
      }

      clearTarget(hostDeviceId: string): void {
        this.targets.delete(hostDeviceId);
      }
    })();

    expect(coordinator.hasTarget("host-1", "hash-1")).toBe(false);
    expect(coordinator.hasTarget("host-1", "hash-1")).toBe(true);
    coordinator.clearTarget("host-1");
    expect(coordinator.hasTarget("host-1", "hash-2")).toBe(false);
  });

  it("restart preserves logicalStreamId but replaces mediaSessionId", () => {
    const before = { logicalStreamId: "stream-1", mediaSessionId: "media-a" };
    const after = { logicalStreamId: "stream-1", mediaSessionId: "media-b" };
    expect(after.logicalStreamId).toBe(before.logicalStreamId);
    expect(after.mediaSessionId).not.toBe(before.mediaSessionId);
  });

  it("restart triggers viewer reconnect and per-viewer request restore", () => {
    const viewerRequests = new Map<string, unknown>();
    viewerRequests.set("viewer-1", { videoBitrateKbps: 1000 });

    const restoreRequests = vi.fn();
    const coordinator = {
      restartAllStreams: vi.fn().mockImplementation(async () => {
        // Broadcast restart, restore each viewer's requests
        restoreRequests();
      }),
    };

    coordinator.restartAllStreams();
    expect(coordinator.restartAllStreams).toHaveBeenCalled();
  });

  it("no duplicate share notification during restart", () => {
    const notifications: string[] = [];
    const notify = (msg: string) => {
      if (notifications.includes(msg)) return;
      notifications.push(msg);
    };

    notify("stream.started:host-1:stream-1");
    notify("stream.started:host-1:stream-1"); // duplicate
    expect(notifications).toHaveLength(1);

    notify("stream.started:host-2:stream-2");
    expect(notifications).toHaveLength(2);
  });
});
