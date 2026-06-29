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
    expect(result).toBe(false);
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
