// @vitest-environment happy-dom
/**
 * Phase 4 - Lifecycle observability: stable IDs, destroy reasons,
 * timing/counter scaffolding, and component stability under rerender.
 *
 * Requirements:
 * 1. Stable monotonically increasing IDs for instances
 * 2. Destroy/cleanup includes a reason string
 * 3. Same videoElement rerender does not destroy/recreate processor
 * 4. videoElement replacement destroys old and creates new processor
 * 5. Settings changes that don't affect videoElement/enabled/fallback do not recreate
 * 6. Timing starts before drawImage and after getImageData in backend
 * 7. Processor coalescing increments counter
 * 8. Destroy reason plumbed through at least one relevant path
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ViewerImageBackend,
  BackendKind,
  BackendInitResult,
  FrameProcessResult,
  BackendStats,
  FrameMetadata,
} from "../src/renderer/services/viewer-image-processing/viewer-image-backend";
import type { ViewerImageEnhancementSettings } from "../src/renderer/services/viewer-image-processing/viewer-image-settings";
import { ViewerImageProcessor } from "../src/renderer/services/viewer-image-processing/viewer-image-processor";
import { NvidiaVsrBackend } from "../src/renderer/services/viewer-image-processing/nvidia-vsr-backend";
import {
  nextMonotonicId,
  enableLifecycleLogging,
  disableLifecycleLogging,
} from "../src/renderer/services/viewer-image-processing/lifecycle-id";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ViewerImageEnhancementSettings = {
  enabled: true,
  processingBackend: "nvidia-vsr",
  webglScalingAlgorithm: "native",
  fsrTargetScale: "auto",
  fsrFinalScaler: "bicubic",
  nvidiaMode: "vsr",
  nvidiaQuality: "high",
  nvidiaOutput: "display",
  customOutputWidth: null,
  customOutputHeight: null,
  maintainAspectRatio: true,
  sharpeningStrength: 0.25,
  noiseProtection: 0.0,
  compressionCleanup: 0.0,
  debanding: 0.0,
  _schemaVersion: 4,
};

function createMockBackend(name = "mock"): {
  backend: ViewerImageBackend;
  calls: {
    initialize: number;
    destroy: number;
    processFrame: number;
    updateSettings: number;
    resizeOutput: number;
    getStats: number;
    lastDestroyReason?: string;
  };
  kind: BackendKind;
} {
  let destroyed = false;
  let initialized = false;
  const calls = {
    initialize: 0,
    destroy: 0,
    processFrame: 0,
    updateSettings: 0,
    resizeOutput: 0,
    getStats: 0,
    lastDestroyReason: undefined as string | undefined,
  };

  const backend: ViewerImageBackend = {
    kind: "nvidia-vsr" as BackendKind,
    initialize: vi.fn(
      async (_canvas?: HTMLCanvasElement): Promise<BackendInitResult> => {
        calls.initialize++;
        if (destroyed)
          return { success: false, reason: "already destroyed" };
        initialized = true;
        return { success: true };
      },
    ),
    updateSettings: vi.fn(
      (_settings: ViewerImageEnhancementSettings): void => {
        calls.updateSettings++;
      },
    ),
    processFrame: vi.fn(
      async (
        _video: HTMLVideoElement,
        _metadata?: FrameMetadata,
      ): Promise<FrameProcessResult> => {
        calls.processFrame++;
        if (!initialized || destroyed) return { success: false };
        return { success: true, gpuTimeMs: 5 };
      },
    ),
    resizeOutput: vi.fn((_w: number, _h: number, _dpr: number): void => {
      calls.resizeOutput++;
    }),
    getStats: vi.fn((): BackendStats => {
      calls.getStats++;
      return {
        inputWidth: 1920,
        inputHeight: 1080,
        outputWidth: 3840,
        outputHeight: 2160,
        enhancedScalingActive: true,
        lastGpuTimeMs: 5,
        backend: "nvidia-vsr",
        framesProcessed: calls.processFrame,
        activePasses: ["nvidia-vsr"],
        backpressureDrops: 0,
      };
    }),
    destroy: vi.fn(
      async (reason?: string): Promise<void> => {
        calls.destroy++;
        calls.lastDestroyReason = reason;
        destroyed = true;
        initialized = false;
      },
    ),
  };

  return { backend, calls, kind: "nvidia-vsr" as BackendKind };
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  return canvas;
}

function createVideoElement(): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: 1920, writable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, writable: true });
  Object.defineProperty(video, "readyState", {
    value: 4,
    writable: true,
  }); // HAVE_ENOUGH_DATA
  Object.defineProperty(video, "currentTime", { value: 0, writable: true });
  return video;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A mock backend whose processFrame resolves only after an external trigger.
 * Allows testing coalescing by keeping frameInFlight = true.
 */
class DelayedMockBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "webgl2";

  initCalled = false;
  destroyCalled = false;
  private frameResolver: (() => void) | null = null;
  private frameRejecter: ((err: Error) => void) | null = null;
  private _destroyed = false;

  async initialize(_canvas?: HTMLCanvasElement): Promise<BackendInitResult> {
    this.initCalled = true;
    return { success: true };
  }

  async destroy(reason?: string): Promise<void> {
    this._destroyed = true;
    this.destroyCalled = true;
    // Resolve pending frame with failure rather than rejecting
    if (this.frameResolver) {
      this.frameResolver();
    }
    this.frameResolver = null;
    this.frameRejecter = null;
  }

  updateSettings(_settings: ViewerImageEnhancementSettings): void {
    // no-op
  }

  resizeOutput(_w: number, _h: number, _dpr: number): void {
    // no-op
  }

  async processFrame(
    _video: HTMLVideoElement,
    _metadata?: FrameMetadata,
  ): Promise<FrameProcessResult> {
    if (this._destroyed) return { success: false };
    // Return pending promise — won't resolve until releaseFrame() is called
    return new Promise<FrameProcessResult>((resolve) => {
      this.frameResolver = () => resolve(
        this._destroyed ? { success: false } : { success: true, gpuTimeMs: 5 }
      );
    });
  }

  getStats(): BackendStats {
    return {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      enhancedScalingActive: true,
      lastGpuTimeMs: 5,
      backend: "webgl2",
      framesProcessed: 0,
      activePasses: [],
      backpressureDrops: 0,
    };
  }

  /** Allow the current in-flight frame to complete. */
  releaseFrame(): void {
    this.frameResolver?.();
    this.frameResolver = null;
    this.frameRejecter = null;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 4a — Stable monotonic IDs", () => {
  it("nextMonotonicId returns increasing values", () => {
    const a = nextMonotonicId();
    const b = nextMonotonicId();
    const c = nextMonotonicId();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("ViewerImageProcessor exposes a stable instanceId", () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend } = createMockBackend();
    const processor = new ViewerImageProcessor(canvas, video, backend);

    expect(processor.instanceId).toBeGreaterThan(0);
    // instanceId must be stable across repeated reads
    const id = processor.instanceId;
    expect(processor.instanceId).toBe(id);

    processor.destroy("cleanup");
  });

  it("two processors have distinct instanceIds", () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend: b1 } = createMockBackend();
    const { backend: b2 } = createMockBackend();

    const p1 = new ViewerImageProcessor(canvas, video, b1);
    const p2 = new ViewerImageProcessor(canvas, video, b2);

    expect(p2.instanceId).not.toBe(p1.instanceId);
    expect(p2.instanceId).toBeGreaterThan(p1.instanceId);

    p1.destroy();
    p2.destroy();
  });

  it("NvidiaVsrBackend exposes a stable instanceId", () => {
    const backend = new NvidiaVsrBackend();
    expect(backend.instanceId).toBeGreaterThan(0);
    const id = backend.instanceId;
    expect(backend.instanceId).toBe(id);
  });
});

describe("Phase 4b — Destroy reasons", () => {
  it("ViewerImageProcessor.destroy accepts an optional reason string", async () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend, calls } = createMockBackend();

    const processor = new ViewerImageProcessor(canvas, video, backend);
    await processor.destroy("intentional cleanup");
    expect(processor.getState()).toBe("destroyed");
  });

  it("destroy with reason calls backend.destroy with reason", async () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend, calls } = createMockBackend();

    const processor = new ViewerImageProcessor(canvas, video, backend);
    await processor.destroy("test cleanup reason");
    expect(calls.destroy).toBe(1);
    expect(calls.lastDestroyReason).toBe("test cleanup reason");
  });

  it("processor setBackend includes destroy reason when swapping", async () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend: oldBackend, calls: oldCalls } = createMockBackend("old");
    const { backend: newBackend } = createMockBackend("new");

    const processor = new ViewerImageProcessor(canvas, video, oldBackend);
    await processor.setBackend(newBackend);

    // Old backend should have been destroyed with the specific reason "Backend swap"
    expect(oldCalls.destroy).toBe(1);
    expect(oldCalls.lastDestroyReason).toBe("Backend swap");

    await processor.destroy();
  });
});

describe("Phase 4c — Same videoElement does not recreate processor", () => {
  it("start-then-updateSettings on same video element keeps initialize count at 1", async () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend, calls } = createMockBackend();

    const processor = new ViewerImageProcessor(canvas, video, backend);
    processor.start(DEFAULT_SETTINGS);
    await flushMicrotasks();
    expect(processor.getState()).toBe("running");
    expect(calls.initialize).toBe(1);

    // Simulate effects of a React rerender with the same video element:
    // updateSettings is called, but no destroy/recreate
    processor.updateSettings(DEFAULT_SETTINGS);
    expect(calls.initialize).toBe(1);
    expect(calls.destroy).toBe(0);

    await processor.destroy();
  });

  it("updateSettings with non-backend changes does not reinitialize", async () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend, calls } = createMockBackend();

    const processor = new ViewerImageProcessor(canvas, video, backend);
    processor.start(DEFAULT_SETTINGS);
    await flushMicrotasks();

    const updated = { ...DEFAULT_SETTINGS, sharpeningStrength: 0.75 };
    processor.updateSettings(updated);
    expect(calls.initialize).toBe(1);
    expect(calls.destroy).toBe(0);

    await processor.destroy();
  });
});

describe("Phase 4d — videoElement replacement destroys old, creates new", () => {
  it("video element change causes exactly one controlled replacement", async () => {
    const canvas = createCanvas();
    const video1 = createVideoElement();
    const video2 = createVideoElement();
    const { backend: b1, calls: calls1 } = createMockBackend("first");
    const { backend: b2, calls: calls2 } = createMockBackend("second");

    // Create processor for first video element
    const p1 = new ViewerImageProcessor(canvas, video1, b1);
    p1.start(DEFAULT_SETTINGS);
    await flushMicrotasks();
    expect(calls1.initialize).toBe(1);

    // Destroy old (as component would on videoElement change)
    await p1.destroy("video element changed");
    expect(calls1.destroy).toBe(1);

    // Create processor for second video element
    const p2 = new ViewerImageProcessor(canvas, video2, b2);
    p2.start(DEFAULT_SETTINGS);
    await flushMicrotasks();
    expect(calls2.initialize).toBe(1);

    // Verify exactly one destroy and one create in sequence
    expect(calls1.destroy).toBe(1);
    expect(calls2.initialize).toBe(1);

    await p2.destroy();
  });
});

describe("Phase 4e — Settings-only change does not recreate processor", () => {
  it("sharpness-only change does not trigger destroy or reinitialize", async () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend, calls } = createMockBackend();

    const processor = new ViewerImageProcessor(canvas, video, backend);
    processor.start(DEFAULT_SETTINGS);
    await flushMicrotasks();
    expect(calls.initialize).toBe(1);

    // Change only sharpening strength — not a backend switch
    const updated = { ...DEFAULT_SETTINGS, sharpeningStrength: 0.75 };
    processor.updateSettings(updated);
    expect(calls.updateSettings).toBeGreaterThanOrEqual(1);
    expect(calls.initialize).toBe(1);
    expect(calls.destroy).toBe(0);

    await processor.destroy();
  });

  it("nvidiaQuality change alone does not recreate processor", async () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend, calls } = createMockBackend();

    const processor = new ViewerImageProcessor(canvas, video, backend);
    processor.start(DEFAULT_SETTINGS);
    await flushMicrotasks();

    const updated = { ...DEFAULT_SETTINGS, nvidiaQuality: "ultra" as const };
    processor.updateSettings(updated);
    expect(calls.updateSettings).toBeGreaterThanOrEqual(1);
    expect(calls.initialize).toBe(1);
    expect(calls.destroy).toBe(0);

    await processor.destroy();
  });
});

describe("Phase 4f — Processor counters", () => {
  it("getStats includes all new observable counters", () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend } = createMockBackend();

    const processor = new ViewerImageProcessor(canvas, video, backend);
    const stats = processor.getStats();

    expect(stats).toHaveProperty("sourceCallbacksReceived");
    expect(stats).toHaveProperty("processingAttempts");
    expect(stats).toHaveProperty("coalescedFrames");
    expect(stats).toHaveProperty("staleGenerationDrops");

    // All counters should start at 0
    expect(stats.sourceCallbacksReceived).toBe(0);
    expect(stats.processingAttempts).toBe(0);
    expect(stats.coalescedFrames).toBe(0);
    expect(stats.staleGenerationDrops).toBe(0);

    processor.destroy();
  });

  it("coalescing increments the coalescedFrames counter", async () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const delayedBackend = new DelayedMockBackend();

    const processor = new ViewerImageProcessor(canvas, video, delayedBackend);
    processor.start(DEFAULT_SETTINGS);
    await flushMicrotasks();

    // Access onVideoFrame handler via type assertion (same pattern as existing tests)
    const proc = processor as unknown as {
      onVideoFrame: (_now: number, metadata: { mediaTime: number }) => void;
    };

    // First frame: starts processing, frameInFlight becomes true
    proc.onVideoFrame(0, { mediaTime: 1 });

    // Second frame while in-flight: should coalesce (pendingFrame set)
    proc.onVideoFrame(0, { mediaTime: 2 });
    expect(processor.getStats().coalescedFrames).toBe(1);

    // Release the delayed frame
    delayedBackend.releaseFrame();
    await flushMicrotasks();

    await processor.destroy();
  });

  it("staleGenerationDrops increments when generation changes mid-flight", async () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const delayedBackend = new DelayedMockBackend();

    const processor = new ViewerImageProcessor(canvas, video, delayedBackend);
    processor.start(DEFAULT_SETTINGS);
    await flushMicrotasks();

    // Access private members for testing
    const proc = processor as unknown as {
      beginFrameProcessing: () => void;
      generation: number;
    };

    // Start a frame that will be in-flight
    proc.beginFrameProcessing();
    await flushMicrotasks();

    // Bump generation (simulating a backend swap during frame processing)
    proc.generation += 10;

    // Release the delayed frame — result should be stale
    delayedBackend.releaseFrame();
    await flushMicrotasks();

    expect(processor.getStats().staleGenerationDrops).toBeGreaterThanOrEqual(1);

    await processor.destroy();
  });
});

describe("Phase 4g — Lifecycle logging scaffolding", () => {
  beforeEach(() => {
    enableLifecycleLogging();
  });

  afterEach(() => {
    disableLifecycleLogging();
  });

  it("enableLifecycleLogging / disableLifecycleLogging are safe to call", () => {
    expect(() => enableLifecycleLogging()).not.toThrow();
    expect(() => disableLifecycleLogging()).not.toThrow();
  });

  it("processor creation and destroy produce lifecycle log calls (by enabling)", () => {
    const canvas = createCanvas();
    const video = createVideoElement();
    const { backend } = createMockBackend();

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const processor = new ViewerImageProcessor(canvas, video, backend);
      // Constructor emits lifecycleLog("Processor", "create", ...)
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lc][Processor]"),
        expect.objectContaining({
          instanceId: processor.instanceId,
          backendKind: backend.kind,
        }),
      );

      debugSpy.mockClear();

      processor.destroy("test");
      // Destroy emits lifecycleLog("Processor", "destroy", ...)
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lc][Processor]"),
        expect.objectContaining({
          reason: "test",
        }),
      );
    } finally {
      debugSpy.mockRestore();
    }
  });
});

// ─── Phase 4h — NvidiaVsrBackend capture timing boundaries ──────────────

describe("Phase 4h — NvidiaVsrBackend capture timing boundaries", () => {
  /**
   * Build a minimal WebGL2 context mock sufficient for NvidiaVsrBackend
   * initialization (createProgram with shader compilation + linking).
   */
  function createNvidiaGlMock(): WebGL2RenderingContext {
    let shaderId = 0;
    let programId = 0;
    const ctx = {
      VERTEX_SHADER: 0x8b31,
      FRAGMENT_SHADER: 0x8b30,
      COMPILE_STATUS: 0x8b81,
      LINK_STATUS: 0x8b82,
      TEXTURE_2D: 0x0de1,
      TEXTURE0: 0x84c0,
      TEXTURE_MIN_FILTER: 0x2801,
      TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802,
      TEXTURE_WRAP_T: 0x2803,
      LINEAR: 0x2601,
      NEAREST: 0x2600,
      CLAMP_TO_EDGE: 0x812f,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      TRIANGLES: 0x0004,
      UNPACK_ALIGNMENT: 0x0cf5,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      COLOR_BUFFER_BIT: 0x4000,
      STREAM_DRAW: 0x88e0,
      FRAMEBUFFER: 0x8d40,
      BLEND: 0x0be2,
      DEPTH_TEST: 0x0b71,
      CULL_FACE: 0x0b44,
      createShader: vi.fn(() => ({ id: ++shaderId })),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      getShaderInfoLog: vi.fn(() => null),
      createProgram: vi.fn(() => ({ id: ++programId })),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      getProgramInfoLog: vi.fn(() => null),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
      createVertexArray: vi.fn(() => ({ id: ++shaderId })),
      bindVertexArray: vi.fn(),
      deleteVertexArray: vi.fn(),
      createTexture: vi.fn(() => ({ id: ++shaderId })),
      bindTexture: vi.fn(),
      texParameteri: vi.fn(),
      deleteTexture: vi.fn(),
      getUniformLocation: vi.fn(() => "uTexture"),
      uniform1i: vi.fn(),
      viewport: vi.fn(),
      useProgram: vi.fn(),
      drawArrays: vi.fn(),
      pixelStorei: vi.fn(),
      texImage2D: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      bindFramebuffer: vi.fn(),
      getExtension: vi.fn(() => null),
      getParameter: vi.fn(() => false),
    } as unknown as WebGL2RenderingContext;
    return ctx;
  }

  /**
   * Shared mock 2D canvas context for the Nvidia capture path.
   */
  function createMock2dContext(): CanvasRenderingContext2D {
    return {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(640 * 480 * 4),
        width: 640,
        height: 480,
      })),
      canvas: document.createElement("canvas"),
      width: 640,
      height: 480,
    } as unknown as CanvasRenderingContext2D;
  }

  beforeEach(() => {
    const gl = createNvidiaGlMock();

    // Mock HTMLCanvasElement.prototype.getContext so that ALL canvases
    // (including the internally created capture canvas) return the right mock.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement, type: string) {
        if (type === "webgl2") return gl;
        if (type === "2d") return createMock2dContext();
        return null;
      } as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );

    // Set up window.screenlink with a working mock API
    (window as unknown as Record<string, unknown>).screenlink = {
      probeNvidiaVsrCapability: vi.fn().mockResolvedValue({ available: true, reason: "" }),
      videoHelperStart: vi.fn().mockResolvedValue(true),
      videoHelperStop: vi.fn().mockResolvedValue(undefined),
      videoHelperFlush: vi.fn().mockResolvedValue(true),
      videoHelperReconfigure: vi.fn().mockResolvedValue(true),
      videoHelperSubmitFrame: vi.fn().mockResolvedValue({
        generation: 1,
        frameSequence: 1,
        pixels: new Uint8Array(640 * 480 * 4),
        width: 640,
        height: 480,
      }),
    };
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).screenlink;
    vi.restoreAllMocks();
  });

  it("timingBreakdown fields are present and non-negative after successful processFrame", async () => {
    const outputCanvas = document.createElement("canvas");

    const backend = new NvidiaVsrBackend();
    const initResult = await backend.initialize(outputCanvas);
    expect(initResult.success).toBe(true);

    // Spy on renderOutput to make it a no-op (avoids needing full GL pipeline in processFrame)
    const renderSpy = vi.spyOn(backend as unknown as { renderOutput: (...args: unknown[]) => void }, "renderOutput")
      .mockImplementation(() => {});

    const video = createVideoElement();
    const result = await backend.processFrame(video, { generation: 1, frameSequence: 1 });

    expect(result.success).toBe(true);
    expect(result.timingBreakdown).toBeDefined();
    expect(result.timingBreakdown!.captureReadbackMs).toBeGreaterThanOrEqual(0);
    expect(result.timingBreakdown!.nativeTransportProcessingMs).toBeGreaterThanOrEqual(0);
    expect(result.timingBreakdown!.displayUploadMs).toBeGreaterThanOrEqual(0);
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);

    // Sanity: timing segments sum approximately to total latency
    const sum = result.timingBreakdown!.captureReadbackMs +
      result.timingBreakdown!.nativeTransportProcessingMs +
      result.timingBreakdown!.displayUploadMs;
    expect(sum).toBeLessThanOrEqual((result.totalLatencyMs ?? 0) + 1); // allow 1ms rounding

    renderSpy.mockRestore();
    await backend.destroy();
  });

  it("timing breakdown includes all three phases", async () => {
    const outputCanvas = document.createElement("canvas");

    const backend = new NvidiaVsrBackend();
    const initResult = await backend.initialize(outputCanvas);
    expect(initResult.success).toBe(true);

    const renderSpy = vi.spyOn(backend as unknown as { renderOutput: (...args: unknown[]) => void }, "renderOutput")
      .mockImplementation(() => {});

    const video = createVideoElement();
    const result = await backend.processFrame(video, { generation: 1, frameSequence: 1 });

    expect(result.success).toBe(true);
    expect(result.timingBreakdown).toHaveProperty("captureReadbackMs");
    expect(result.timingBreakdown).toHaveProperty("nativeTransportProcessingMs");
    expect(result.timingBreakdown).toHaveProperty("displayUploadMs");
    expect(result).toHaveProperty("totalLatencyMs");

    renderSpy.mockRestore();
    await backend.destroy();
  });
});
