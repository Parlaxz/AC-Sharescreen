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

  // Phase 2: restartHostStreams and hasRestartTarget/clearRestartTarget removed.
  // The restartAllStreams method (distributed flow) and handleIncomingRestartRequest
  // (local host) remain and are tested in restart-coordinator-distributed.test.ts.
});
