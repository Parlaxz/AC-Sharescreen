// @vitest-environment node
/**
 * Tests for VideoHelperManager — disconnected-state behaviour.
 *
 * All tests exercise the manager *before* start() is called, verifying
 * that every public method is safe and returns the expected sentinel
 * value when the helper process is not running.
 *
 * Mocks:
 *   - `electron` (app.isPackaged) — required because helper-path imports it
 *   - `node:child_process` / `node:net` / helper-path — provided for
 *     completeness so that start()-oriented tests can be added later
 *     without touching the mock setup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Module-level mocks (applied before any import) ─────────────────────────

vi.mock("electron", () => ({
  app: { isPackaged: false },
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
    destroy: vi.fn(),
    writable: true,
    write: vi.fn(
      (_data: Uint8Array | string, cb?: (err?: Error) => void) => {
        if (cb) cb();
      },
    ),
    removeListener: vi.fn(),
  }));
  return {
    default: { Socket: mockSocket },
    Socket: mockSocket,
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

  it("submitFrame returns false when helper not running", async () => {
    const result = await manager.submitFrame(
      1,
      1,
      new Uint8Array(0),
      1920,
      1080,
    );
    expect(result).toBe(false);
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
    // State should still be "disconnected" after stop on idle manager
    expect(manager.getState()).toBe("disconnected");
  });

  it("destroy is safe to call when not running", () => {
    expect(() => manager.destroy()).not.toThrow();
    // Calling destroy again should also be safe (no-op after first)
    expect(() => manager.destroy()).not.toThrow();
  });
});
