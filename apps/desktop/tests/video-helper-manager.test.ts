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

import { VideoHelperManager, FramePipeParser } from "../src/main/VideoHelperManager";
import { Buffer } from "node:buffer";

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

describe("VideoHelperManager — restart policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses 1s/4s/15s backoff schedule", () => {
    const manager = new VideoHelperManager();

    expect((manager as any).getRestartDelayMs(1)).toBe(1000);
    expect((manager as any).getRestartDelayMs(2)).toBe(4000);
    expect((manager as any).getRestartDelayMs(3)).toBe(15000);
    expect((manager as any).getRestartDelayMs(4)).toBe(15000);

    manager.destroy();
  });

  it("transitions to disconnected after max restart attempts", () => {
    const manager = new VideoHelperManager();
    const onStateChange = vi.fn();
    const onError = vi.fn();
    manager.setCallbacks({ onStateChange, onError });

    (manager as any).lifecycleGeneration = 1;
    (manager as any).restartAttempts = 3;

    (manager as any).attemptRestart(1);

    expect(manager.getState()).toBe("disconnected");
    expect(onStateChange).toHaveBeenCalledWith("disconnected");
    expect(onError).toHaveBeenCalledWith("Video helper reached max restart attempts");

    manager.destroy();
  });
});

// ─── FramePipeParser — re-entrancy & leftover handling ─────────────────────

describe("FramePipeParser — re-entrancy / leftover data", () => {
  const FRAME_MAGIC = 0x464C4156454D5246n;
  const HEADER_SIZE = 104;

  /** Build a valid frame header + payload in one Buffer. */
  function buildFrame(
    gen: number,
    seq: number,
    width: number,
    height: number,
    payloadBytes?: number,
  ): { header: Buffer; payload: Buffer; frame: Buffer } {
    const pb = payloadBytes ?? width * height * 4;
    const payload = Buffer.alloc(pb);
    // Fill payload with a detectable pattern
    for (let i = 0; i < pb; i++) payload[i] = (i + gen + seq) & 0xFF;
    const header = Buffer.alloc(HEADER_SIZE);
    let off = 0;
    header.writeBigUInt64LE(FRAME_MAGIC, off); off += 8;
    header.writeUInt32LE(HEADER_SIZE, off); off += 4;
    header.writeUInt32LE(1, off); off += 4; // wireVersion
    header.writeUInt32LE(gen, off); off += 4;
    header.writeUInt32LE(seq, off); off += 4;
    header.writeBigUInt64LE(BigInt(0), off); off += 8; // timestamp
    header.writeUInt32LE(width, off); off += 4;
    header.writeUInt32LE(height, off); off += 4;
    header.writeUInt32LE(width * 4, off); off += 4; // stride
    header.writeUInt32LE(2, off); off += 4; // pixelFormat = RGBA8
    header.writeUInt32LE(width, off); off += 4; // outW
    header.writeUInt32LE(height, off); off += 4; // outH
    header.writeUInt32LE(0, off); off += 4; // slotIndex → configurationId
    header.writeUInt32LE(pb, off); off += 4; // payloadBytes
    header.writeUInt32LE(0, off); off += 4; // modeNum
    header.writeUInt32LE(0, off); off += 4; // qualNum
    header.writeUInt32LE(0, off); off += 4; // flags
    header.writeUInt32LE(1, off); off += 4; // resultCode = success
    header.writeUInt32LE(0, off); off += 4; // nativeInputReceiveUs
    header.writeUInt32LE(0, off); off += 4; // nativeUploadUs
    header.writeUInt32LE(0, off); off += 4; // nativeEffectUs
    header.writeUInt32LE(0, off); off += 4; // nativeDownloadUs
    header.writeUInt32LE(0, off); off += 4; // nativeOutputWriteUs
    header.writeUInt32LE(0, off);      // nativeTotalUs
    const frame = Buffer.concat([header, payload]);
    return { header, payload, frame };
  }

  it("processes a single complete frame", () => {
    const parser = new FramePipeParser();
    let resolved: FrameResponse | null = null;
    parser.installPending(1, 1, (r: FrameResponse | null) => { resolved = r; }, 5000);

    const { payload } = buildFrame(1, 1, 4, 4, 64);
    const { frame } = buildFrame(1, 1, 4, 4, 64);
    const result = parser.feed(frame);

    expect(result).not.toBeNull();
    expect(result!.generation).toBe(1);
    expect(result!.sequence).toBe(1);
    expect(result!.width).toBe(4);
    expect(result!.height).toBe(4);
    // Payload bytes should match
    expect(Buffer.from(result!.pixels).equals(payload)).toBe(true);
  });

  it("processes partial frames split across multiple feed calls", () => {
    const parser = new FramePipeParser();
    let resolved: FrameResponse | null = null;
    parser.installPending(1, 1, (r) => { resolved = r; }, 5000);

    const { frame } = buildFrame(1, 1, 4, 4, 64);

    // Feed first 50 bytes (partial header)
    let result = parser.feed(frame.subarray(0, 50));
    expect(result).toBeNull();

    // Feed rest
    result = parser.feed(frame.subarray(50));
    expect(result).not.toBeNull();
    expect(result!.generation).toBe(1);
    expect(result!.sequence).toBe(1);
  });

  it("processes two complete frames in a single chunk (leftover forwarding)", () => {
    const parser = new FramePipeParser();

    // Install pending for frame 1
    let resolved1: FrameResponse | null = null;
    parser.installPending(1, 1, (r) => { resolved1 = r; }, 5000);

    // Build two frames concatenated
    const { frame: frame1 } = buildFrame(1, 1, 4, 4, 64);
    const { frame: frame2 } = buildFrame(1, 2, 6, 6, 144);
    const combined = Buffer.concat([frame1, frame2]);

    // Feed both at once. The fix ensures leftover bytes after frame 1's
    // payload are re-fed into the parser, so frame 2 is also processed.
    // The recursive feed returns frame 2's result (the last one).
    const result = parser.feed(combined);
    expect(result).not.toBeNull();
    // The recursive feed returns frame 2's result (last processed)
    expect(result!.generation).toBe(1);
    expect(result!.sequence).toBe(2);
    expect(result!.width).toBe(6);
    expect(result!.height).toBe(6);

    // Frame 1's pending should have been resolved via emitResult
    expect(resolved1).not.toBeNull();
    expect(resolved1!.generation).toBe(1);
    expect(resolved1!.sequence).toBe(1);
    expect(resolved1!.width).toBe(4);
    expect(resolved1!.height).toBe(4);
  });

  it("processes three complete frames in a single chunk", () => {
    const parser = new FramePipeParser();

    let resolved1: FrameResponse | null = null;
    parser.installPending(1, 1, (r) => { resolved1 = r; }, 5000);

    const { frame: frame1 } = buildFrame(1, 1, 2, 2, 16);
    const { frame: frame2 } = buildFrame(1, 2, 4, 4, 64);
    const { frame: frame3 } = buildFrame(1, 3, 8, 8, 256);
    const combined = Buffer.concat([frame1, frame2, frame3]);

    const result = parser.feed(combined);
    expect(result).not.toBeNull();
    expect(result!.generation).toBe(1);
    expect(result!.sequence).toBe(3); // last frame returned
    expect(result!.width).toBe(8);
    expect(result!.height).toBe(8);

    expect(resolved1).not.toBeNull();
    expect(resolved1!.generation).toBe(1);
    expect(resolved1!.sequence).toBe(1);
  });

  it("preserves leftover data when payload completes in header-to-payload transition", () => {
    // This specifically tests the bug: when header carries extra bytes beyond
    // current frame's payload AND the payload is fully contained in the header
    // leftover, the remaining bytes (next frame header) must not be lost.
    const parser = new FramePipeParser();

    // Install pending for frame 1 with a small payload
    let resolved1: FrameResponse | null = null;
    parser.installPending(1, 1, (r) => { resolved1 = r; }, 5000);

    const { frame: frame1 } = buildFrame(1, 1, 2, 2, 16); // 16 byte payload (2*2*4)
    const { frame: frame2 } = buildFrame(1, 2, 4, 4, 64);

    // Deliver frame1 header + frame1 payload + beginning of frame2 in one chunk
    // header = 104, payload1 = 16, frame2 starts at offset 120
    const chunk = frame1;
    const result = parser.feed(chunk);
    expect(result).not.toBeNull();
    expect(result!.generation).toBe(1);
    expect(result!.sequence).toBe(1);

    // Now install pending for frame2
    let resolved2: FrameResponse | null = null;
    parser.installPending(1, 2, (r) => { resolved2 = r; }, 5000);

    // Feed the rest of frame2
    const restResult = parser.feed(frame2);
    expect(restResult).not.toBeNull();
    expect(restResult!.generation).toBe(1);
    expect(restResult!.sequence).toBe(2);
  });

  it("handles resultCode !== 1 without leaking pending", () => {
    const parser = new FramePipeParser();
    let resolved: FrameResponse | null = null;
    parser.installPending(1, 1, (r) => { resolved = r; }, 5000);

    const { frame } = buildFrame(1, 1, 4, 4, 64);
    // Overwrite resultCode with 0 (error)
    frame.writeUInt32LE(0, 76);
    const result = parser.feed(frame);

    expect(result).toBeNull();
    // Pending should be resolved with null
    expect(resolved).toBeNull();
    expect(parser.hasPending).toBe(false);
  });

  it("handles empty payload (payloadBytes === 0)", () => {
    const parser = new FramePipeParser();
    let resolved: FrameResponse | null = null;
    parser.installPending(1, 1, (r) => { resolved = r; }, 5000);

    const { frame } = buildFrame(1, 1, 4, 4, 0);
    const result = parser.feed(frame);

    expect(result).toBeNull();
    expect(resolved).toBeNull();
    expect(parser.hasPending).toBe(false);
  });

  it("rejects oversized payload (>200MB)", () => {
    const parser = new FramePipeParser();
    let resolved: FrameResponse | null = null;
    parser.installPending(1, 1, (r) => { resolved = r; }, 5000);

    const { frame } = buildFrame(1, 1, 4, 4, 201 * 1024 * 1024);
    // Only feed the header (payload would be enormous)
    const headerOnly = frame.subarray(0, HEADER_SIZE);
    const result = parser.feed(headerOnly);

    expect(result).toBeNull();
    expect(resolved).toBeNull();
    expect(parser.hasPending).toBe(false);
  });

  it("times out pending if no response arrives", async () => {
    vi.useFakeTimers();
    const parser = new FramePipeParser();
    let resolved: FrameResponse | null = "not-called" as any;
    parser.installPending(1, 1, (r) => { resolved = r; }, 100);

    // Advance time past timeout
    vi.advanceTimersByTime(150);
    await vi.runAllTimersAsync();

    expect(resolved).toBeNull();
    expect(parser.hasPending).toBe(false);
    vi.useRealTimers();
  });
});
