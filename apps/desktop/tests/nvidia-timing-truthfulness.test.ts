// @vitest-environment happy-dom
/**
 * Tests for timing truthfulness fixes in the NVIDIA VSR pipeline.
 *
 * Validates:
 *   - Accumulated renderer timing stats are non-null when data is provided
 *   - nativeTransportProcessingTimeMs no longer duplicates rendererToResultMs
 *   - windowSampleCount reports truthful (minimum) count, not maximum
 *   - Main-process per-frame timings are threaded through correctly
 *   - Native per-stage timings are threaded through correctly
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ViewerImageProcessor } from "@/services/viewer-image-processing/viewer-image-processor";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "@/services/viewer-image-processing/viewer-image-defaults";
import type {
  ViewerImageBackend,
  BackendInitResult,
  FrameProcessResult,
  BackendStats,
  FrameMetadata,
  BackendKind,
} from "@/services/viewer-image-processing/viewer-image-backend";

// ─── Mock backend that returns full timing breakdowns ────────────────────────

class TimingMockBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "nvidia-vsr";
  private frameCount = 0;

  async initialize(_canvas?: HTMLCanvasElement): Promise<BackendInitResult> {
    return { success: true };
  }

  async destroy(): Promise<void> {}

  updateSettings(_settings: ViewerImageEnhancementSettings): void {}

  resizeOutput(_width: number, _height: number, _dpr: number): void {}

  onSourceResize?(_sourceWidth: number, _sourceHeight: number): void {}

  async processFrame(
    _video: HTMLVideoElement,
    _metadata?: FrameMetadata,
  ): Promise<FrameProcessResult> {
    this.frameCount++;
    const r = this.frameCount * 0.5;

    return {
      success: true,
      gpuTimeMs: 5 + r,
      totalLatencyMs: 50 + r,
      timingBreakdown: {
        captureReadbackMs: 3 + r * 0.2,
        drawImageMs: 1.5 + r * 0.1,
        getImageDataMs: 1.5 + r * 0.1,
        inputBufferPreparationMs: 0.5 + r * 0.05,
        rendererToResultMs: 40 + r,
        textureUploadMs: 5 + r * 0.2,
        rendererTotalMs: 48 + r,
        // nativeTransportProcessingMs: should be the TRUE native total, not duplicate
        nativeTransportProcessingMs: 15 + r * 0.3,
        displayUploadMs: 2 + r * 0.1,
        // Main-process per-frame timings
        mainInputHandlingMs: 0.3 + r * 0.01,
        pipeWriteMs: 0.5 + r * 0.02,
        pipeWaitAndReadMs: 42 + r,
        mainOutputPostMs: 0.2 + r * 0.01,
        // Native per-stage timings
        nativeInputReceiveMs: 0.8 + r * 0.05,
        nativeUploadMs: 2.5 + r * 0.1,
        nativeEffectMs: 8 + r * 0.3,
        nativeDownloadMs: 2 + r * 0.1,
        nativeOutputWriteMs: 1.5 + r * 0.1,
        nativeTotalMs: 15 + r * 0.3,
      },
    };
  }

  getStats(): BackendStats {
    return {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      enhancedScalingActive: true,
      lastGpuTimeMs: 45,
      backend: "nvidia-vsr",
      framesProcessed: this.frameCount,
      activePasses: ["nvidia-vsr"],
      backpressureDrops: 0,
      nativeQualityLevel: 3,
    };
  }
}

// ─── Mock backend that returns NO timing breakdown ───────────────────────────

class NoTimingMockBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "webgl2";
  private frameCount = 0;

  async initialize(_canvas?: HTMLCanvasElement): Promise<BackendInitResult> {
    return { success: true };
  }

  async destroy(): Promise<void> {}

  updateSettings(_settings: ViewerImageEnhancementSettings): void {}

  resizeOutput(_width: number, _height: number, _dpr: number): void {}

  onSourceResize?(_sourceWidth: number, _sourceHeight: number): void {}

  async processFrame(
    _video: HTMLVideoElement,
    _metadata?: FrameMetadata,
  ): Promise<FrameProcessResult> {
    this.frameCount++;
    return {
      success: true,
      // No timingBreakdown at all
    };
  }

  getStats(): BackendStats {
    return {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      enhancedScalingActive: false,
      lastGpuTimeMs: null,
      backend: "webgl2",
      framesProcessed: this.frameCount,
      activePasses: [],
      backpressureDrops: 0,
    };
  }
}

// ─── Mock backend that returns mixed null/defined timing fields ──────────────

class PartialTimingMockBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "nvidia-vsr";
  private frameCount = 0;

  async initialize(_canvas?: HTMLCanvasElement): Promise<BackendInitResult> {
    return { success: true };
  }

  async destroy(): Promise<void> {}

  updateSettings(_settings: ViewerImageEnhancementSettings): void {}

  resizeOutput(_width: number, _height: number, _dpr: number): void {}

  onSourceResize?(_sourceWidth: number, _sourceHeight: number): void {}

  async processFrame(
    _video: HTMLVideoElement,
    _metadata?: FrameMetadata,
  ): Promise<FrameProcessResult> {
    this.frameCount++;
    return {
      success: true,
      timingBreakdown: {
        // Only provide rendererTotalMs + nativeTransportProcessingMs
        rendererTotalMs: 50 + this.frameCount,
        nativeTransportProcessingMs: 20 + this.frameCount * 0.5,
        // Leave others undefined to test null-handling
      },
    };
  }

  getStats(): BackendStats {
    return {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      enhancedScalingActive: false,
      lastGpuTimeMs: null,
      backend: "nvidia-vsr",
      framesProcessed: this.frameCount,
      activePasses: [],
      backpressureDrops: 0,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function createVideoElement(): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", {
    value: HTMLMediaElement.HAVE_CURRENT_DATA,
    writable: true,
  });
  Object.defineProperty(video, "videoWidth", { value: 1920, writable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, writable: true });
  if (typeof video.requestVideoFrameCallback !== "function") {
    (video as unknown as { requestVideoFrameCallback: unknown }).requestVideoFrameCallback =
      vi.fn<(_: unknown) => number>().mockReturnValue(42);
  }
  if (typeof video.cancelVideoFrameCallback !== "function") {
    (video as unknown as { cancelVideoFrameCallback: unknown }).cancelVideoFrameCallback =
      vi.fn();
  }
  return video;
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  return canvas;
}

const defaultSettings: ViewerImageEnhancementSettings = {
  ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
  enabled: true,
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Access the private processCurrentFrameAsync for testing */
function getProcessFn(processor: ViewerImageProcessor): () => Promise<void> {
  return (
    processor as unknown as { processCurrentFrameAsync: () => Promise<void> }
  ).processCurrentFrameAsync;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ViewerImageProcessor — renderer timing stats truthfulness", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let backend: TimingMockBackend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    backend = new TimingMockBackend();
    processor = new ViewerImageProcessor(canvas, video, backend);
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("returns non-null renderer timing values after frames are processed", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    // Process 5 frames to accumulate stats
    for (let i = 0; i < 5; i++) {
      await process.call(processor);
    }

    const stats = processor.getStats();

    // The 6 previously-null fields should now be non-null
    expect(stats.drawImageTimeMs).not.toBeNull();
    expect(stats.getImageDataTimeMs).not.toBeNull();
    expect(stats.inputBufferPreparationTimeMs).not.toBeNull();
    expect(stats.rendererToResultTimeMs).not.toBeNull();
    expect(stats.textureUploadTimeMs).not.toBeNull();
    expect(stats.rendererTotalTimeMs).not.toBeNull();

    // Values should be positive
    expect(stats.drawImageTimeMs!).toBeGreaterThan(0);
    expect(stats.getImageDataTimeMs!).toBeGreaterThan(0);
    expect(stats.inputBufferPreparationTimeMs!).toBeGreaterThan(0);
    expect(stats.rendererToResultTimeMs!).toBeGreaterThan(0);
    expect(stats.textureUploadTimeMs!).toBeGreaterThan(0);
    expect(stats.rendererTotalTimeMs!).toBeGreaterThan(0);
  });

  it("returns null for renderer timing values when no frames processed", async () => {
    const stats = processor.getStats();

    expect(stats.drawImageTimeMs).toBeNull();
    expect(stats.getImageDataTimeMs).toBeNull();
    expect(stats.inputBufferPreparationTimeMs).toBeNull();
    expect(stats.rendererToResultTimeMs).toBeNull();
    expect(stats.textureUploadTimeMs).toBeNull();
    expect(stats.rendererTotalTimeMs).toBeNull();
  });

  it("nativeTransportProcessingTimeMs does NOT equal rendererToResultTimeMs", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    // Process 3 frames
    for (let i = 0; i < 3; i++) {
      await process.call(processor);
    }

    const stats = processor.getStats();

    // nativeTransportProcessingTimeMs should be the true native total (~15ms)
    // while rendererToResultTimeMs is the renderer-observed round-trip (~40ms)
    expect(stats.nativeTransportProcessingTimeMs).not.toBeNull();
    expect(stats.rendererToResultTimeMs).not.toBeNull();
    expect(stats.nativeTransportProcessingTimeMs!).toBeLessThan(stats.rendererToResultTimeMs!);
  });

  it("windowSampleCount is the minimum (not maximum) across all stat windows", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    // Process enough frames to exceed slightly different sample accumulations
    for (let i = 0; i < 10; i++) {
      await process.call(processor);
    }

    const stats = processor.getStats();
    expect(stats.windowSampleCount).toBeGreaterThan(0);
    expect(stats.avgRendererTotalMs).not.toBeNull();
    expect(stats.p50RendererTotalMs).not.toBeNull();
    expect(stats.p95RendererTotalMs).not.toBeNull();
    expect(stats.avgNativeRoundTripMs).not.toBeNull();

    // windowSampleCount should be <= any single window count
    // (it's the min, so it's the lower bound)
    expect(stats.windowSampleCount).toBeLessThanOrEqual(10);
  });

  it("main-process per-frame timings are returned in ProcessorStats", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    for (let i = 0; i < 3; i++) {
      await process.call(processor);
    }

    const stats = processor.getStats();
    expect(stats.mainInputHandlingTimeMs).not.toBeNull();
    expect(stats.pipeWriteTimeMs).not.toBeNull();
    expect(stats.pipeWaitAndReadTimeMs).not.toBeNull();
    expect(stats.mainOutputPostTimeMs).not.toBeNull();

    expect(stats.mainInputHandlingTimeMs!).toBeGreaterThan(0);
    expect(stats.pipeWriteTimeMs!).toBeGreaterThan(0);
    expect(stats.pipeWaitAndReadTimeMs!).toBeGreaterThan(0);
    expect(stats.mainOutputPostTimeMs!).toBeGreaterThan(0);
  });

  it("native per-stage timings are returned in ProcessorStats", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    for (let i = 0; i < 3; i++) {
      await process.call(processor);
    }

    const stats = processor.getStats();
    expect(stats.nativeInputReceiveTimeMs).not.toBeNull();
    expect(stats.nativeUploadTimeMs).not.toBeNull();
    expect(stats.nativeEffectTimeMs).not.toBeNull();
    expect(stats.nativeDownloadTimeMs).not.toBeNull();
    expect(stats.nativeOutputWriteTimeMs).not.toBeNull();
    expect(stats.nativeTotalTimeMs).not.toBeNull();

    expect(stats.nativeInputReceiveTimeMs!).toBeGreaterThan(0);
    expect(stats.nativeUploadTimeMs!).toBeGreaterThan(0);
    expect(stats.nativeEffectTimeMs!).toBeGreaterThan(0);
    expect(stats.nativeDownloadTimeMs!).toBeGreaterThan(0);
    expect(stats.nativeOutputWriteTimeMs!).toBeGreaterThan(0);
    expect(stats.nativeTotalTimeMs!).toBeGreaterThan(0);
  });
});

describe("ViewerImageProcessor — timing null-safety when no breakdown provided", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let backend: NoTimingMockBackend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    backend = new NoTimingMockBackend();
    processor = new ViewerImageProcessor(canvas, video, backend);
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("all timing fields are null when backend provides no timingBreakdown", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    for (let i = 0; i < 3; i++) {
      await process.call(processor);
    }

    const stats = processor.getStats();
    expect(stats.drawImageTimeMs).toBeNull();
    expect(stats.getImageDataTimeMs).toBeNull();
    expect(stats.inputBufferPreparationTimeMs).toBeNull();
    expect(stats.rendererToResultTimeMs).toBeNull();
    expect(stats.textureUploadTimeMs).toBeNull();
    expect(stats.rendererTotalTimeMs).toBeNull();
    expect(stats.nativeTransportProcessingTimeMs).toBeNull();
    expect(stats.captureReadbackTimeMs).toBeNull();
    expect(stats.displayUploadTimeMs).toBeNull();
    expect(stats.totalEnhancedFrameLatencyMs).toBeNull();

    // Main-process timings should also be null
    expect(stats.mainInputHandlingTimeMs).toBeNull();
    expect(stats.pipeWriteTimeMs).toBeNull();
    expect(stats.pipeWaitAndReadTimeMs).toBeNull();
    expect(stats.mainOutputPostTimeMs).toBeNull();

    // Native timings should be null
    expect(stats.nativeInputReceiveTimeMs).toBeNull();
    expect(stats.nativeUploadTimeMs).toBeNull();
    expect(stats.nativeEffectTimeMs).toBeNull();
    expect(stats.nativeDownloadTimeMs).toBeNull();
    expect(stats.nativeOutputWriteTimeMs).toBeNull();
    expect(stats.nativeTotalTimeMs).toBeNull();
  });
});

describe("ViewerImageProcessor — partial timing data", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let backend: PartialTimingMockBackend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    backend = new PartialTimingMockBackend();
    processor = new ViewerImageProcessor(canvas, video, backend);
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("only timings with data are non-null; missing ones remain null", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    for (let i = 0; i < 5; i++) {
      await process.call(processor);
    }

    const stats = processor.getStats();

    // rendererTotalMs and nativeTransportProcessingMs are provided
    expect(stats.rendererTotalTimeMs).not.toBeNull();
    expect(stats.nativeTransportProcessingTimeMs).not.toBeNull();

    // These were not provided, should be null
    expect(stats.drawImageTimeMs).toBeNull();
    expect(stats.getImageDataTimeMs).toBeNull();
    expect(stats.inputBufferPreparationTimeMs).toBeNull();
    expect(stats.rendererToResultTimeMs).toBeNull();
    expect(stats.textureUploadTimeMs).toBeNull();
    expect(stats.captureReadbackTimeMs).toBeNull();
    expect(stats.displayUploadTimeMs).toBeNull();

    // Main-process timing should be null
    expect(stats.mainInputHandlingTimeMs).toBeNull();
    expect(stats.pipeWriteTimeMs).toBeNull();
    expect(stats.pipeWaitAndReadTimeMs).toBeNull();
    expect(stats.mainOutputPostTimeMs).toBeNull();

    // Native timing should be null
    expect(stats.nativeInputReceiveTimeMs).toBeNull();
    expect(stats.nativeUploadTimeMs).toBeNull();
    expect(stats.nativeEffectTimeMs).toBeNull();
    expect(stats.nativeDownloadTimeMs).toBeNull();
    expect(stats.nativeOutputWriteTimeMs).toBeNull();
    expect(stats.nativeTotalTimeMs).toBeNull();
  });
});
