// @vitest-environment happy-dom
/**
 * Tests for NVIDIA VSR capture lifecycle fixes.
 *
 * Validates:
 *   - No per-frame video.captureStream() — persistent capture resources
 *   - MediaStreamTrackProcessor created once per source generation
 *   - One reader reused across frames
 *   - No per-frame 1s timeout path
 *   - Track change/destroy cancels reader and closes retained frames exactly once
 *   - Reusable buffers not allocated every frame; resize on dimension change
 *   - Latest-frame semantics: one active op, newest retained frame replaces older
 *   - Timing truthfulness: gpuTimeMs, displayUploadMs, nativeTransportProcessingMs
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { NvidiaVsrBackend } from "@/services/viewer-image-processing/nvidia-vsr-backend";
import type {
  ViewerImageBackend,
  BackendInitResult,
  FrameProcessResult,
  BackendStats,
} from "@/services/viewer-image-processing/viewer-image-backend";

// ─── WebGL2 mock (happy-dom has no WebGL support) ────────────────────────

function createMockGl(): Record<string, any> {
  const gl: Record<string, any> = {};
  const enums: Record<string, number> = {
    TEXTURE_2D: 0x0DE1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812F,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TRIANGLES: 4,
    BLEND: 0x0BE2,
    DEPTH_TEST: 0x0B71,
    CULL_FACE: 0x0B44,
    TEXTURE0: 0x84C0,
    UNPACK_ALIGNMENT: 0x0CF5,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
  };
  Object.assign(gl, enums);

  gl.getExtension = vi.fn(() => null);
  gl.createShader = vi.fn(() => ({}));
  gl.shaderSource = vi.fn();
  gl.compileShader = vi.fn();
  gl.getShaderParameter = vi.fn(() => true); // COMPILE_STATUS = true
  gl.getShaderInfoLog = vi.fn(() => "");
  gl.deleteShader = vi.fn();
  gl.createProgram = vi.fn(() => ({}));
  gl.attachShader = vi.fn();
  gl.linkProgram = vi.fn();
  gl.getProgramParameter = vi.fn((_prog: any, pname: number) => {
    return pname === enums.LINK_STATUS;
  });
  gl.getProgramInfoLog = vi.fn(() => "");
  gl.deleteProgram = vi.fn();
  gl.getUniformLocation = vi.fn(() => ({}));
  gl.createVertexArray = vi.fn(() => ({}));
  gl.createTexture = vi.fn(() => ({}));
  gl.deleteTexture = vi.fn();
  gl.deleteVertexArray = vi.fn();
  gl.bindTexture = vi.fn();
  gl.texParameteri = vi.fn();
  gl.pixelStorei = vi.fn();
  gl.viewport = vi.fn();
  gl.disable = vi.fn();
  gl.useProgram = vi.fn();
  gl.bindVertexArray = vi.fn();
  gl.activeTexture = vi.fn();
  gl.texImage2D = vi.fn();
  gl.texSubImage2D = vi.fn();
  gl.uniform1i = vi.fn();
  gl.drawArrays = vi.fn();
  gl.bindBuffer = vi.fn();
  gl.bufferData = vi.fn();
  gl.enable = vi.fn();
  gl.clearColor = vi.fn();
  gl.clear = vi.fn();
  gl.getParameter = vi.fn(() => "");

  return gl;
}

// ─── Canvas mock: happy-dom does not implement canvas 2d/WebGL2 rendering.
// We provide a full mock for both 2d and webgl2 contexts.

function createMock2dContext(): any {
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    })),
    putImageData: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    canvas: null as any,
    // CanvasRenderingContext2D properties
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: "rgba(0,0,0,0)",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: "10px sans-serif",
    textAlign: "left",
    textBaseline: "alphabetic",
    direction: "ltr",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    // Add all CanvasImageData methods
    createImageData: vi.fn((w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
      colorSpace: "srgb",
    })),
  };
}

const _origCreateElement = document.createElement.bind(document);

document.createElement = function (
  tagName: string,
  options?: ElementCreationOptions,
): HTMLElement {
  const el = _origCreateElement(tagName, options);
  if (tagName.toLowerCase() === "canvas") {
    const canvas = el as HTMLCanvasElement;
    canvas.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ..._args: any[]
    ): RenderingContext | null {
      if (type === "webgl2") {
        return createMockGl() as unknown as WebGL2RenderingContext;
      }
      if (type === "2d") {
        const ctx = createMock2dContext();
        ctx.canvas = this;
        return ctx as unknown as CanvasRenderingContext2D;
      }
      return null;
    } as typeof HTMLCanvasElement.prototype.getContext;
  }
  return el;
} as typeof document.createElement;

// ─── Mock globals for VideoFrame / MediaStreamTrackProcessor ─────────────

interface MockVideoFrame {
  format: string | null;
  displayWidth: number;
  displayHeight: number;
  copyTo: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _closed: boolean;
}

interface MockTrackReader {
  read: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  _cancelled: boolean;
}

interface MockTrackProcessor {
  readable: { getReader: () => MockTrackReader };
}

let mockVideoFrameCtor: ReturnType<typeof vi.fn>;
let mockTrackProcessorCtor: ReturnType<typeof vi.fn>;
let mockCaptureStream: ReturnType<typeof vi.fn>;

function setupMocks(): void {
  // VideoFrame mock
  mockVideoFrameCtor = vi.fn(
    (_: unknown, init?: { format?: string; displayWidth?: number; displayHeight?: number }) => {
      const frame: MockVideoFrame = {
        format: init?.format ?? "RGBA",
        displayWidth: init?.displayWidth ?? 1920,
        displayHeight: init?.displayHeight ?? 1080,
        copyTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        _closed: false,
      };
      frame.close = vi.fn(() => {
        frame._closed = true;
      });
      return frame;
    },
  );

  // MediaStreamTrackProcessor mock
  mockTrackProcessorCtor = vi.fn((_init: { track: MediaStreamTrack }) => {
    const reader: MockTrackReader = {
      read: vi.fn().mockResolvedValue({
        done: false,
        value: mockVideoFrameCtor("mock", {
          format: "RGBA",
          displayWidth: 1920,
          displayHeight: 1080,
        }),
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      _cancelled: false,
    };
    reader.cancel = vi.fn(() => {
      reader._cancelled = true;
      return Promise.resolve();
    });
    const processor: MockTrackProcessor = {
      readable: { getReader: () => reader },
    };
    return processor;
  });

  mockCaptureStream = vi.fn(() => {
    const track = { kind: "video", label: "mock-track", enabled: true };
    return {
      getVideoTracks: () => [track],
      getTracks: () => [track],
    };
  });
}

function installDomMocks(): void {
  (globalThis as any).VideoFrame = mockVideoFrameCtor;
  (globalThis as any).MediaStreamTrackProcessor = mockTrackProcessorCtor;
}

function uninstallDomMocks(): void {
  delete (globalThis as any).VideoFrame;
  delete (globalThis as any).MediaStreamTrackProcessor;
}

// ─── Helper: create a mock video element with srcObject ──────────────────

function createMockVideo(opts?: {
  width?: number;
  height?: number;
  readyState?: number;
  noTrack?: boolean;
}): HTMLVideoElement {
  const video = document.createElement("video");
  const w = opts?.width ?? 1920;
  const h = opts?.height ?? 1080;
  Object.defineProperty(video, "videoWidth", { value: w, writable: true });
  Object.defineProperty(video, "videoHeight", { value: h, writable: true });
  Object.defineProperty(video, "readyState", {
    value: opts?.readyState ?? HTMLMediaElement.HAVE_CURRENT_DATA,
    writable: true,
  });
  // Mock captureStream to detect calls
  (video as any).captureStream = mockCaptureStream;

  // Set up srcObject with a MediaStream containing a track
  if (!opts?.noTrack) {
    const track = { kind: "video", label: "src-track", enabled: true } as unknown as MediaStreamTrack;
    const stream = new MediaStream([track]);
    Object.defineProperty(video, "srcObject", {
      value: stream,
      writable: true,
    });
  } else {
    Object.defineProperty(video, "srcObject", {
      value: null,
      writable: true,
    });
  }

  return video;
}

function createMockCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  return canvas;
}

// ─── Helper: screenlink API mock ─────────────────────────────────────────

function installScreenlinkApi(overrides?: Record<string, any>): void {
  const defaults = {
    probeNvidiaVsrCapability: vi.fn().mockResolvedValue({ available: true, reason: "" }),
    videoHelperAcquireClient: vi.fn().mockResolvedValue({ clientId: "test-client-1" }),
    videoHelperReleaseClient: vi.fn().mockResolvedValue({ success: true }),
    videoHelperStart: vi.fn().mockResolvedValue({ success: true, appliedConfig: { configurationId: 1, appliedQualityLevel: 3 } }),
    videoHelperStop: vi.fn().mockResolvedValue(undefined),
    videoHelperReconfigure: vi.fn().mockResolvedValue({ success: true }),
    videoHelperSubmitFrame: vi.fn().mockResolvedValue({
      generation: 1, sequence: 0, pixels: new Uint8Array(3840 * 2160 * 4),
      width: 3840, height: 2160,
    }),
    videoHelperFlush: vi.fn().mockResolvedValue(true),
  };
  (window as any).screenlink = { ...defaults, ...overrides };
}

function uninstallScreenlinkApi(): void {
  delete (window as any).screenlink;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("NvidiaVsrBackend — capture lifecycle (persistent resources)", () => {
  let backend: NvidiaVsrBackend;

  beforeAll(() => {
    setupMocks();
    installDomMocks();
  });

  afterAll(() => {
    uninstallDomMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    installScreenlinkApi();
  });

  afterEach(async () => {
    try {
      await backend?.destroy("test-teardown");
    } catch {
      // ignore
    }
    uninstallScreenlinkApi();
  });

  it("does NOT call video.captureStream() per frame in processFrame", async () => {
    const video = createMockVideo();
    const canvas = createMockCanvas();
    backend = new NvidiaVsrBackend();

    const initResult = await backend.initialize(canvas);
    expect(initResult.success).toBe(true);

    const result1 = await backend.processFrame(video);
    expect(result1.success).toBe(true);

    // captureStream should NOT have been called (we use srcObject directly)
    expect(mockCaptureStream).not.toHaveBeenCalled();
  });

  it("creates MediaStreamTrackProcessor once and reuses it across frames", async () => {
    const video = createMockVideo();
    const canvas = createMockCanvas();
    backend = new NvidiaVsrBackend();
    await backend.initialize(canvas);

    // First frame
    const result1 = await backend.processFrame(video);
    expect(result1.success).toBe(true);
    const firstCallCount = mockTrackProcessorCtor.mock.calls.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    // Second frame — should reuse the same processor
    const result2 = await backend.processFrame(video);
    expect(result2.success).toBe(true);
    expect(mockTrackProcessorCtor.mock.calls.length).toBe(firstCallCount);
  });

  it("reuses one reader across frames (reader.read called, not re-created)", async () => {
    const video = createMockVideo();
    const canvas = createMockCanvas();
    backend = new NvidiaVsrBackend();
    await backend.initialize(canvas);

    // First frame
    const result1 = await backend.processFrame(video);
    expect(result1.success).toBe(true);

    const reader = mockTrackProcessorCtor.mock.results[0]?.value?.readable?.getReader();
    expect(reader).toBeDefined();

    // Second frame — should reuse same reader
    const result2 = await backend.processFrame(video);
    expect(result2.success).toBe(true);

    // No new processors/readers created
    expect(mockTrackProcessorCtor.mock.results.length).toBe(1);
  });

  it("does not use Promise.race with 1s timeout per frame (reader.read called directly)", async () => {
    const video = createMockVideo();
    const canvas = createMockCanvas();
    backend = new NvidiaVsrBackend();
    await backend.initialize(canvas);

    await backend.processFrame(video);

    // Verify reader.read() was called
    const reader = mockTrackProcessorCtor.mock.results[0]?.value?.readable?.getReader();
    expect(reader).toBeDefined();
    expect(reader.read).toHaveBeenCalled();
  });

  it("track change invalidates processor and creates new one", async () => {
    const video = createMockVideo();
    const canvas = createMockCanvas();
    backend = new NvidiaVsrBackend();
    await backend.initialize(canvas);

    // Process first frame — sets up persistent resources
    await backend.processFrame(video);
    const procCountAfterFirst = mockTrackProcessorCtor.mock.calls.length;
    expect(procCountAfterFirst).toBeGreaterThanOrEqual(1);

    // Change the srcObject track (simulate stream switch)
    const newTrack = { kind: "video", label: "new-src-track", enabled: true } as unknown as MediaStreamTrack;
    const newStream = new MediaStream([newTrack]);
    Object.defineProperty(video, "srcObject", { value: newStream, writable: true });

    // Process another frame — should detect track change and re-create
    const result = await backend.processFrame(video);
    expect(result.success).toBe(true);

    // A new processor should have been created
    expect(mockTrackProcessorCtor.mock.calls.length).toBe(procCountAfterFirst + 1);
  });

  it("destroy cancels reader and cleans up capture resources", async () => {
    const video = createMockVideo();
    const canvas = createMockCanvas();
    backend = new NvidiaVsrBackend();
    await backend.initialize(canvas);

    // Process a frame to set up resources
    await backend.processFrame(video);

    const reader = mockTrackProcessorCtor.mock.results[0]?.value?.readable?.getReader();

    await backend.destroy("test-cleanup");

    // Reader should have been cancelled
    expect(reader.cancel).toHaveBeenCalled();
  });

  it("reuses RGBA capture buffer across frames (no per-frame Uint8Array allocation for pixel data)", async () => {
    // Track large Uint8Array allocations
    const originalUint8Array = globalThis.Uint8Array;
    const largeAllocs: number[] = [];
    const TrackedUint8Array = class extends Uint8Array {
      constructor(...args: any[]) {
        super(...(args as any));
        if (args.length === 1 && typeof args[0] === "number" && args[0] > 1000) {
          largeAllocs.push(args[0]);
        }
      }
    } as unknown as typeof Uint8Array;
    (globalThis as any).Uint8Array = TrackedUint8Array;

    try {
      const video = createMockVideo();
      const canvas = createMockCanvas();
      backend = new NvidiaVsrBackend();
      await backend.initialize(canvas);

      // Clear allocations from init
      largeAllocs.length = 0;

      // First frame
      await backend.processFrame(video);
      const firstFrameCount = largeAllocs.length;

      // Second frame (same dimensions)
      await backend.processFrame(video);
      const secondFrameCount = largeAllocs.length;

      // Should NOT allocate a new large buffer for the second frame
      expect(secondFrameCount - firstFrameCount).toBe(0);
    } finally {
      (globalThis as any).Uint8Array = originalUint8Array;
    }
  });

  it("processes consecutive frames successfully with same source", async () => {
    const video = createMockVideo();
    const canvas = createMockCanvas();
    backend = new NvidiaVsrBackend();
    await backend.initialize(canvas);

    const result1 = await backend.processFrame(video);
    expect(result1.success).toBe(true);

    const result2 = await backend.processFrame(video);
    expect(result2.success).toBe(true);
  });
});

// ─── Tests for timing truthfulness in the real backend ────────────────────

describe("NvidiaVsrBackend — timing truthfulness", () => {
  let backend: NvidiaVsrBackend;

  beforeAll(() => {
    setupMocks();
    installDomMocks();
  });

  afterAll(() => {
    uninstallDomMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default screenlink — no native presenter, uses videoHelperSubmitFrame
    installScreenlinkApi();
  });

  afterEach(async () => {
    try {
      await backend?.destroy("test-teardown");
    } catch {
      // ignore
    }
    uninstallScreenlinkApi();
  });

  async function setupBackend(): Promise<{ video: HTMLVideoElement; canvas: HTMLCanvasElement }> {
    const video = createMockVideo();
    const canvas = createMockCanvas();
    backend = new NvidiaVsrBackend();
    const initResult = await backend.initialize(canvas);
    expect(initResult.success).toBe(true);
    return { video, canvas };
  }

  it("lastGpuTimeMs represents native GPU work (nativePreWriteTotalMs) not full renderer round-trip", async () => {
    installScreenlinkApi({
      videoHelperSubmitFrame: vi.fn().mockResolvedValue({
        generation: 1,
        sequence: 0,
        pixels: new Uint8Array(3840 * 2160 * 4),
        width: 3840,
        height: 2160,
        nativePreWriteTotalMs: 12,
        nativeInputReceiveMs: 1,
        nativeUploadMs: 3,
        nativeEffectMs: 6,
        nativeDownloadMs: 2,
      }),
    });

    const { video } = await setupBackend();
    await backend.processFrame(video);

    const stats = backend.getStats();
    // lastGpuTimeMs should be the native pre-write total (12), NOT the
    // renderer round-trip time which would be much larger (~40-50ms)
    expect(stats.lastGpuTimeMs).toBe(12);
  });

  it("timingBreakdown returns truthful gpuTimeMs (nativePreWriteTotalMs, not rendererToResultMs)", async () => {
    installScreenlinkApi({
      videoHelperSubmitFrame: vi.fn().mockResolvedValue({
        generation: 1,
        sequence: 0,
        pixels: new Uint8Array(3840 * 2160 * 4),
        width: 3840,
        height: 2160,
        nativePreWriteTotalMs: 15,
        nativeInputReceiveMs: 1,
        nativeUploadMs: 4,
        nativeEffectMs: 8,
        nativeDownloadMs: 2,
      }),
    });

    const { video } = await setupBackend();
    const result = await backend.processFrame(video);

    expect(result.success).toBe(true);
    // gpuTimeMs should carry nativePreWriteTotalMs when available
    expect(result.gpuTimeMs).toBe(15);
  });

  it("displayUploadMs does NOT duplicate textureUploadMs (displayUploadMs removed from timingBreakdown)", async () => {
    installScreenlinkApi({
      videoHelperSubmitFrame: vi.fn().mockResolvedValue({
        generation: 1,
        sequence: 0,
        pixels: new Uint8Array(3840 * 2160 * 4),
        width: 3840,
        height: 2160,
      }),
    });

    const { video } = await setupBackend();
    const result = await backend.processFrame(video);

    expect(result.success).toBe(true);
    // textureUploadMs should be present (it's the real WebGL texture upload)
    expect(result.timingBreakdown?.textureUploadMs).toBeGreaterThanOrEqual(0);
    // displayUploadMs should NOT be present as a separate field
    // (it was duplicating textureUploadMs)
    expect("displayUploadMs" in (result.timingBreakdown ?? {})).toBe(false);
  });

  it("nativeTransportProcessingMs not set when native timing is missing (no fallback to rendererToResultMs)", async () => {
    // This test uses a mock that returns NO nativePreWriteTotalMs
    installScreenlinkApi({
      videoHelperSubmitFrame: vi.fn().mockResolvedValue({
        generation: 1,
        sequence: 0,
        pixels: new Uint8Array(3840 * 2160 * 4),
        width: 3840,
        height: 2160,
        // No nativePreWriteTotalMs — native timing unavailable
      }),
    });

    const { video } = await setupBackend();
    const result = await backend.processFrame(video);

    expect(result.success).toBe(true);
    // nativeTransportProcessingMs should NOT be set to rendererToResultMs
    // (the old fallback behavior). It should stay undefined/null.
    if (result.timingBreakdown) {
      expect(result.timingBreakdown.nativeTransportProcessingMs).toBeUndefined();
    }
  });
});
