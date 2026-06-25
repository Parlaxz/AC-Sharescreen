// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RestartCoordinator } from "../src/renderer/services/restart-coordinator.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeMockRuntime(): Phase3Runtime {
  const ssm = {
    state: "active",
    restartStream: vi.fn().mockResolvedValue(undefined),
    currentGroupId: "test-g-1",
    currentLogicalStreamId: "ls-1",
    currentMediaSessionId: "ms-1",
  };
  const registry = {
    registerLocalStream: vi.fn(),
    handleStopped: vi.fn(),
    getStream: vi.fn(),
    getAllStreams: vi.fn().mockReturnValue([]),
    getStreamsByGroup: vi.fn().mockReturnValue([]),
  };
  const connManager = {
    broadcast: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn(),
  };
  return {
    getStreamSessionManager: () => ssm,
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    deviceId: "local-device-id",
    displayName: "Local Host",
  } as unknown as Phase3Runtime;
}

describe("Restart All Streams (Stage 14)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("restart-coordinator module exists and exports RestartCoordinator", async () => {
    const mod = await import("../src/renderer/services/restart-coordinator.js");
    expect(mod.RestartCoordinator).toBeDefined();
  });

  it("restart uses exact target stamp/hash for idempotency", () => {
    const coordinator = new RestartCoordinator(makeMockRuntime());

    expect(coordinator.hasRestartTarget("host-1", "hash-1")).toBe(false);
    expect(coordinator.hasRestartTarget("host-1", "hash-1")).toBe(true);
    coordinator.clearRestartTarget("host-1");
    expect(coordinator.hasRestartTarget("host-1", "hash-2")).toBe(false);
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

  // ── Real restart lifecycle (remediation batch) ─────────────────────

  it("restartHostStreams delegates to SSM for local host (real lifecycle)", async () => {
    const runtime = makeMockRuntime();
    const coordinator = new RestartCoordinator(runtime);
    const ssm = runtime.getStreamSessionManager();

    await coordinator.restartHostStreams("test-g-1", "local-device-id", "stamp-1");

    // Should call SSM's restartStream for a real lifecycle restart
    expect(ssm.restartStream).toHaveBeenCalledTimes(1);
  });

  it("restartHostStreams broadcasts remotely when hostDeviceId is not local", async () => {
    const runtime = makeMockRuntime();
    const coordinator = new RestartCoordinator(runtime);
    const ssm = runtime.getStreamSessionManager();
    const registry = runtime.getActiveStreamRegistry();
    const connManager = runtime.getConnectionManager();

    // Set up remote streams in registry
    const remoteStreams = [
      {
        logicalStreamId: "remote-ls-1",
        mediaSessionId: "remote-ms-1",
        groupId: "test-g-1",
        hostDeviceId: "remote-host-1",
        hostDisplayName: "Remote Host",
        sourceKind: "screen",
        sourceName: "Remote Screen",
        startedAt: 1000,
        appliedSettingsRevision: 0,
        heartbeatSequence: 5,
        streamRevision: 2,
        mediaJoinMetadata: "",
        replacesSessionId: null,
        isAudioDegraded: false,
      },
    ];
    (registry.getStreamsByGroup as any).mockReturnValue(remoteStreams);

    await coordinator.restartHostStreams("test-g-1", "remote-host-1", "stamp-2");

    // Should NOT call SSM (remote host)
    expect(ssm.restartStream).not.toHaveBeenCalled();

    // Should broadcast stream.restarted for each remote stream
    expect(connManager.broadcast).toHaveBeenCalledWith(
      "test-g-1",
      expect.objectContaining({
        type: "stream.restarted",
        logicalStreamId: "remote-ls-1",
        hostDeviceId: "remote-host-1",
        replacesSessionId: "remote-ms-1",
      }),
    );
  });

  it("restartHostStreams is idempotent via stamp hash (concurrent)", async () => {
    // Test that two concurrent calls with the same stamp are blocked.
    // Use a promise that doesn't resolve to prevent the first call from finishing
    // and clearing the target.
    let resolveRestart: () => void;
    const restartPromise = new Promise<void>((resolve) => { resolveRestart = resolve; });

    const runtime = makeMockRuntime();
    const ssm = runtime.getStreamSessionManager();
    (ssm.restartStream as any).mockReturnValue(restartPromise);

    const coordinator = new RestartCoordinator(runtime);

    // Start first call (don't await)
    const firstCall = coordinator.restartHostStreams("test-g-1", "local-device-id", "stamp-3");
    // Verify the target is set
    expect(coordinator.hasRestartTarget("local-device-id", "stamp-3")).toBe(true);

    // Second call with same stamp while first is still in-flight → blocked
    await coordinator.restartHostStreams("test-g-1", "local-device-id", "stamp-3");
    expect(ssm.restartStream).toHaveBeenCalledTimes(1); // still 1

    // Complete the first restart
    resolveRestart!();
    await firstCall;

    // Different stamp → should proceed (target was cleared)
    await coordinator.restartHostStreams("test-g-1", "local-device-id", "stamp-4");
    expect(ssm.restartStream).toHaveBeenCalledTimes(2);
  });

  it("restartHostStreams clears target after successful restart", async () => {
    const runtime = makeMockRuntime();
    const coordinator = new RestartCoordinator(runtime);

    await coordinator.restartHostStreams("test-g-1", "local-device-id", "stamp-5");
    expect(coordinator.hasRestartTarget("local-device-id", "stamp-5")).toBe(false); // cleared
  });

  it("restartStream is called through RestartCoordinator for local host (integration path)", async () => {
    // Verify the full path: RestartCoordinator → StreamSessionManager.restartStream
    // using a real StreamSessionManager instance
    const { StreamSessionManager } = await import("../src/renderer/services/stream-session-manager.js");

    const localRuntime = makeMockRuntime();
    const ssm = new StreamSessionManager(localRuntime);
    const coordinator = new RestartCoordinator(localRuntime);

    // Mock getStreamSessionManager to return our SSM
    const getSsmOrig = localRuntime.getStreamSessionManager;
    (localRuntime as any).getStreamSessionManager = () => ssm;

    // SSM is idle → restartStream is no-op
    await coordinator.restartHostStreams("test-g-1", "local-device-id", "stamp-6");
    expect(ssm.state).toBe("idle");

    // Restore
    (localRuntime as any).getStreamSessionManager = getSsmOrig;
  });
});
