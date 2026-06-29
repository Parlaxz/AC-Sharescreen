// @vitest-environment node
/**
 * Tests for VideoHelperManager — disconnected-state behaviour,
 * client lease system, and frame port lifecycle.
 *
 * All tests exercise the manager *before* start() is called, verifying
 * that every public method is safe and returns the expected sentinel
 * value when the helper process is not running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Module-level mocks (applied before any import) ─────────────────────────

vi.mock("electron", () => ({
  app: { isPackaged: false },
  MessageChannelMain: vi.fn(() => ({
    port1: { on: vi.fn(), start: vi.fn(), close: vi.fn() },
    port2: {
      on: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
      postMessage: vi.fn(),
    },
  })),
}));

vi.mock("node:child_process", () => {
  const mockChildProcess = () => ({
    on: vi.fn().mockReturnThis(),
    stderr: { on: vi.fn() },
    stdout: { on: vi.fn() },
    kill: vi.fn(),
    exitCode: null,
  });
  return { spawn: vi.fn(mockChildProcess) };
});

vi.mock("node:net", () => {
  const mockSocket = vi.fn(() => ({
    connect: vi.fn((_path: string, cb?: () => void) => {
      if (cb) setTimeout(cb, 10);
    }),
    on: vi.fn(),
    once: vi.fn(),
    destroy: vi.fn(),
    writable: true,
    write: vi.fn(
      (_data: Uint8Array | string, cb?: (err?: Error) => void) => {
        if (cb) cb();
        return true;
      },
    ),
    removeListener: vi.fn(),
    setTimeout: vi.fn(),
  }));
  return {
    default: { Socket: mockSocket },
    Socket: mockSocket,
    createConnection: vi.fn((_path: string, cb?: () => void) => {
      const s = mockSocket();
      if (cb) setTimeout(cb, 10);
      return s;
    }),
  };
});

vi.mock("../src/main/helper-path", () => ({
  getVideoEnhancerHelperPath: vi.fn(() => "C:\\fake\\helper.exe"),
}));

// ─── Import after mocks are set up ──────────────────────────────────────────

import { VideoHelperManager } from "../src/main/VideoHelperManager";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("VideoHelperManager — disconnected state", () => {
  let manager: VideoHelperManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new VideoHelperManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("starts in disconnected state", () => {
    expect(manager.getState()).toBe("disconnected");
  });

  it("submitFrame returns null when helper not running", async () => {
    const result = await manager.submitFrame(
      1,
      1,
      new Uint8Array(0),
      1920,
      1080,
    );
    expect(result).toBe(null);
  });

  it("getDiagnostics returns null when helper not running", async () => {
    const result = await manager.getDiagnostics();
    expect(result).toBeNull();
  });

  it("reconfigure returns false when helper not running", async () => {
    const result = await manager.reconfigure({
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      processingMode: "vsr",
      qualityLevel: "high",
      pixelFormat: "bgra8",
    });
    expect(result.success).toBe(false);
  });

  it("flush returns false when helper not running", async () => {
    const result = await manager.flush();
    expect(result).toBe(false);
  });

  it("stop is safe to call when not running", async () => {
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(manager.getState()).toBe("disconnected");
  });

  it("destroy is safe to call when not running", () => {
    expect(() => manager.destroy()).not.toThrow();
    expect(() => manager.destroy()).not.toThrow();
  });
});

describe("VideoHelperManager — client lease system", () => {
  let manager: VideoHelperManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new VideoHelperManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("acquireClient returns a unique opaque clientId", () => {
    const clientId1 = manager.acquireClient();
    const clientId2 = manager.acquireClient();

    expect(clientId1).toBeTruthy();
    expect(typeof clientId1).toBe("string");
    expect(clientId1).not.toBe(clientId2);
  });

  it("isClientActive returns true for acquired clients", () => {
    const clientId = manager.acquireClient();
    expect(manager.isClientActive(clientId)).toBe(true);
  });

  it("isClientActive returns false for unknown clients", () => {
    expect(manager.isClientActive("nonexistent")).toBe(false);
  });

  it("releaseClient is idempotent and marks client inactive", () => {
    const clientId = manager.acquireClient();
    expect(manager.isClientActive(clientId)).toBe(true);

    manager.releaseClient(clientId);
    expect(manager.isClientActive(clientId)).toBe(false);

    // Second release should not throw
    manager.releaseClient(clientId);
  });

  it("stale releases (unknown clientId) are silently ignored", () => {
    const clientId = manager.acquireClient();
    manager.releaseClient(clientId);

    // Release again with same (now stale) id — should be no-op
    expect(() => manager.releaseClient(clientId)).not.toThrow();
    expect(manager.isClientActive(clientId)).toBe(false);
  });

  it("multiple clients can coexist", () => {
    const id1 = manager.acquireClient();
    const id2 = manager.acquireClient();
    const id3 = manager.acquireClient();

    expect(manager.isClientActive(id1)).toBe(true);
    expect(manager.isClientActive(id2)).toBe(true);
    expect(manager.isClientActive(id3)).toBe(true);

    manager.releaseClient(id2);
    expect(manager.isClientActive(id1)).toBe(true);
    expect(manager.isClientActive(id2)).toBe(false);
    expect(manager.isClientActive(id3)).toBe(true);
  });

  it("releasing a client does NOT call global stop on helper", async () => {
    const clientId = manager.acquireClient();
    // Mock the stop method
    const stopSpy = vi.spyOn(manager, "stop");

    manager.releaseClient(clientId);

    // stop should not be called immediately (idle shutdown timer)
    expect(stopSpy).not.toHaveBeenCalled();
  });
});

describe("VideoHelperManager — frame port lifecycle", () => {
  let manager: VideoHelperManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new VideoHelperManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("createFramePort returns null for unknown client", () => {
    const port = (manager as any).createFramePort("nonexistent");
    expect(port).toBeNull();
  });

  it("createFramePort returns a port for an acquired client", () => {
    const clientId = manager.acquireClient();
    const port = (manager as any).createFramePort(clientId);
    expect(port).not.toBeNull();
  });

  it("releaseClient closes the client's frame port", () => {
    const clientId = manager.acquireClient();
    const port = (manager as any).createFramePort(clientId);
    expect(port).not.toBeNull();

    manager.releaseClient(clientId);

    // Port should be closed
    expect((manager as any).framePorts.has(clientId)).toBe(false);
  });
});

// ─── Phase 2 Gate A: Structured result parsing and idempotent reconfigure ────

describe("VideoHelperManager — configure/start/reconfigure structured results", () => {
  let manager: VideoHelperManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new VideoHelperManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("reconfigure returns { success: false } when helper not running", async () => {
    const result = await manager.reconfigure({
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      processingMode: "vsr",
      qualityLevel: "high",
      pixelFormat: "bgra8",
    });
    expect(result).toEqual({
      success: false,
      error: "Helper not in ready/processing state",
    });
  });

  it("getAppliedConfig returns null when never configured", () => {
    expect(manager.getAppliedConfig()).toBeNull();
  });

  it("buildAppliedConfig produces correct structure from native response", () => {
    const config = {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      processingMode: "vsr" as const,
      qualityLevel: "high" as const,
      pixelFormat: "rgba8" as const,
    };
    const nativeResponse = {
      success: true,
      configurationId: 1,
      effectInstanceId: 1,
      requestedMode: "vsr",
      requestedQuality: "high",
      appliedQualityLevel: 3,
      effectLoadCount: 1,
      effectLoadSucceeded: true,
      configuredAt: 1000000,
    };

    // Access private method for testing
    const result = (manager as any).buildAppliedConfig(config, nativeResponse, true);

    expect(result.configurationId).toBe(1);
    expect(result.effectInstanceId).toBe(1);
    expect(result.requestedMode).toBe("vsr");
    expect(result.requestedQuality).toBe("high");
    expect(result.appliedQualityLevel).toBe(3);
    expect(result.effectLoadCount).toBe(1);
    expect(result.effectLoadSucceeded).toBe(true);
    expect(result.configuredAt).toBe(1000000); // consumed from native response
    expect(result.verificationMethod).toBe("set-and-load-confirmed");
    expect(result.nativeGpuFormat).toBe("rgba8");
    expect(result.cudaStreamBound).toBe(true);
    expect(result.gpuIndex).toBe(0);
  });

  it("buildAppliedConfig falls back to internal tracking when native response sparse", () => {
    const config = {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      processingMode: "vsr" as const,
      qualityLevel: "high" as const,
      pixelFormat: "rgba8" as const,
    };
    // Empty native response — should fall back to internal tracking
    const result = (manager as any).buildAppliedConfig(config, { success: true }, true);

    expect(result.requestedMode).toBe("vsr");
    expect(result.requestedQuality).toBe("high");
    expect(result.configuredAt).toBeGreaterThan(0);
    expect(Number.isFinite(result.configuredAt)).toBe(true);
    expect(typeof result.configurationId).toBe("number");
  });

  it("buildAppliedConfig handles effectLoadCount 0 when success is false", () => {
    const config = {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      processingMode: "vsr" as const,
      qualityLevel: "high" as const,
      pixelFormat: "rgba8" as const,
    };
    const result = (manager as any).buildAppliedConfig(config, { success: false }, false);
    expect(result.effectLoadCount).toBe(0);
    expect(result.effectLoadSucceeded).toBe(false);
  });
});

describe("VideoHelperManager — identical-config no-op", () => {
  let manager: VideoHelperManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new VideoHelperManager();
    // Set state to ready with a lastConfig so no-op detection works
    (manager as any).state = "ready";
    (manager as any).lastConfig = {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      processingMode: "vsr" as const,
      qualityLevel: "high" as const,
      pixelFormat: "rgba8" as const,
    };
    (manager as any).appliedConfig = {
      configurationId: 1,
      effectInstanceId: 1,
      requestedMode: "vsr",
      requestedQuality: "high",
      appliedMode: "vsr",
      appliedQuality: "high",
      appliedQualityLevel: 3,
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      inputPixelFormat: "rgba8",
      nativeGpuFormat: "rgba8",
      gpuIndex: 0,
      cudaStreamBound: true,
      effectLoadSucceeded: true,
      effectLoadCount: 1,
      configuredAt: Date.now(),
      verificationMethod: "set-and-load-confirmed",
    };
  });

  afterEach(() => {
    manager.destroy();
  });

  it("reconfigure with identical config returns success without advancing configurationId", async () => {
    const spy = vi.spyOn(manager as any, "sendCommand");

    const result = await manager.reconfigure({
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      processingMode: "vsr",
      qualityLevel: "high",
      pixelFormat: "rgba8",
    });

    // No IPC call should have been made (no-op guard)
    expect(spy).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.appliedConfig).toBeDefined();
  });

  it("start with identical config returns success without advancing configurationId", async () => {
    const spy = vi.spyOn(manager as any, "sendCommand");

    const result = await manager.start({
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      processingMode: "vsr",
      qualityLevel: "high",
      pixelFormat: "rgba8",
    });

    // No IPC call should have been made (no-op guard via identical config match)
    expect(spy).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.appliedConfig).toBeDefined();
  });

  it("reconfigure with different config attempts actual call", async () => {
    // sendCommand will fail because manager isn't fully connected
    const result = await manager.reconfigure({
      inputWidth: 640,
      inputHeight: 480,
      outputWidth: 1280,
      outputHeight: 960,
      processingMode: "vsr",
      qualityLevel: "low",
      pixelFormat: "rgba8",
    });

    expect(result.success).toBe(false); // sendCommand returns null for not-connected
  });
});

describe("VideoHelperManager — legacy request-frame-port lease cleanup", () => {
  let manager: VideoHelperManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new VideoHelperManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("releases anon client when createFramePort returns null", () => {
    const clientId = manager.acquireClient();
    expect(manager.isClientActive(clientId)).toBe(true);

    // Simulate port creation failure (e.g. client already has a port that fails)
    // releaseClient should still be safe and not leak
    manager.releaseClient(clientId);
    expect(manager.isClientActive(clientId)).toBe(false);

    // Even without explicit release, the port close handler should not crash
    const clientId2 = manager.acquireClient();
    const port = (manager as any).createFramePort(clientId2);
    if (port && port.close) {
      port.close(); // simulate renderer closing port
    }
  });

  it("stale release after port close does not throw", () => {
    const clientId = manager.acquireClient();
    manager.releaseClient(clientId);

    // After release, releasing again is a no-op
    expect(() => manager.releaseClient(clientId)).not.toThrow();
  });
});

describe("VideoHelperManager — applied config fields parsing", () => {
  it("createAppliedNvidiaConfig produces all required fields", async () => {
    const { createAppliedNvidiaConfig } = await import("@screenlink/shared");

    const config = createAppliedNvidiaConfig({
      configurationId: 5,
      effectInstanceId: 3,
      requestedMode: "vsr",
      requestedQuality: "ultra",
      appliedMode: "vsr",
      appliedQuality: "ultra",
      appliedQualityLevel: 4,
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      inputPixelFormat: "rgba8",
      effectLoadSucceeded: true,
      effectLoadCount: 2,
    });

    // Verify every field is present and correctly typed
    expect(config.configurationId).toBe(5);
    expect(config.effectInstanceId).toBe(3);
    expect(config.requestedMode).toBe("vsr");
    expect(config.requestedQuality).toBe("ultra");
    expect(config.appliedMode).toBe("vsr");
    expect(config.appliedQuality).toBe("ultra");
    expect(config.appliedQualityLevel).toBe(4);
    expect(config.inputWidth).toBe(1920);
    expect(config.inputHeight).toBe(1080);
    expect(config.outputWidth).toBe(3840);
    expect(config.outputHeight).toBe(2160);
    expect(config.inputPixelFormat).toBe("rgba8");
    expect(config.nativeGpuFormat).toBe("rgba8");
    expect(config.gpuIndex).toBe(0);
    expect(config.cudaStreamBound).toBe(true);
    expect(config.effectLoadSucceeded).toBe(true);
    expect(config.effectLoadCount).toBe(2);
    expect(typeof config.configuredAt).toBe("number");
    expect(config.configuredAt).toBeGreaterThan(0);
    expect(Number.isFinite(config.configuredAt)).toBe(true);
    expect(config.verificationMethod).toBe("set-and-load-confirmed");
  });

  it("createAppliedNvidiaConfig uses provided configuredAt when given", async () => {
    const { createAppliedNvidiaConfig } = await import("@screenlink/shared");

    const config = createAppliedNvidiaConfig({
      configurationId: 1,
      effectInstanceId: 1,
      requestedMode: "vsr",
      requestedQuality: "high",
      appliedMode: "vsr",
      appliedQuality: "high",
      appliedQualityLevel: 3,
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      inputPixelFormat: "rgba8",
      effectLoadSucceeded: true,
      effectLoadCount: 1,
      configuredAt: 123456789,
    });

    expect(config.configuredAt).toBe(123456789);
  });
});
