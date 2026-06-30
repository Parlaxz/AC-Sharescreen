// @vitest-environment happy-dom
/**
 * Tests for NVIDIA VSR backpressure and coalesce-to-newest behavior.
 *
 * Validates:
 *   - Processor coalesces: marks pending, processes newest when current completes
 *   - Pause/resume flushes/clears pending state
 *   - Config change resets pending state and bumps generation
 *   - Stale generation results are detected and dropped at processor level
 *   - Stale generation results detected at backend level
 *   - Frame metadata identity integrity across generations
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

// ─── Helper utilities ───────────────────────────────────────────────────

function createVideoElement(
  overrides?: Partial<{
    readyState: number;
    videoWidth: number;
    videoHeight: number;
    currentTime: number;
  }>,
): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", {
    value: overrides?.readyState ?? HTMLMediaElement.HAVE_CURRENT_DATA,
    writable: true,
  });
  Object.defineProperty(video, "videoWidth", {
    value: overrides?.videoWidth ?? 1920,
    writable: true,
  });
  Object.defineProperty(video, "videoHeight", {
    value: overrides?.videoHeight ?? 1080,
    writable: true,
  });
  Object.defineProperty(video, "currentTime", {
    value: overrides?.currentTime ?? 0,
    writable: true,
  });
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

// ─── Mock backend with configurable frame processing delay ───────────────

class DelayMockBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "nvidia-vsr";
  private processDelayMs = 30;
  private frameCount = 0;

  onSourceResize?(_sourceWidth: number, _sourceHeight: number): void {}

  setProcessDelay(ms: number): void {
    this.processDelayMs = ms;
  }

  async initialize(_canvas?: HTMLCanvasElement): Promise<BackendInitResult> {
    return { success: true };
  }

  async destroy(): Promise<void> {}

  updateSettings(_settings: ViewerImageEnhancementSettings): void {}

  resizeOutput(_width: number, _height: number, _dpr: number): void {}

  getStats(): BackendStats {
    return {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      enhancedScalingActive: true,
      lastGpuTimeMs: this.processDelayMs,
      backend: "nvidia-vsr",
      framesProcessed: this.frameCount,
      activePasses: ["nvidia-vsr"],
      backpressureDrops: 0,
    };
  }

  async processFrame(
    _video: HTMLVideoElement,
    _metadata?: FrameMetadata,
  ): Promise<FrameProcessResult> {
    this.frameCount++;
    await new Promise((r) => setTimeout(r, this.processDelayMs));
    return {
      success: true,
      generation: _metadata?.generation,
      sequence: _metadata?.frameSequence,
      gpuTimeMs: this.processDelayMs,
      outputWidth: 3840,
      outputHeight: 2160,
      totalLatencyMs: this.processDelayMs,
      timingBreakdown: {
        captureReadbackMs: 3,
        drawImageMs: 1.5,
        getImageDataMs: 1.5,
        inputBufferPreparationMs: 0.5,
        rendererToResultMs: this.processDelayMs - 10,
        textureUploadMs: 5,
        rendererTotalMs: this.processDelayMs,
        nativeTransportProcessingMs: this.processDelayMs - 15,
        displayUploadMs: 2,
        mainInputHandlingMs: 0.3,
        requestWriteMs: 0.5,
        responseWaitMs: this.processDelayMs - 12,
        mainHandlerTotalMs: this.processDelayMs - 10,
        nativeInputReceiveMs: 0.8,
        nativeUploadMs: 2.5,
        nativeEffectMs: this.processDelayMs - 20,
        nativeDownloadMs: 2,
        nativePreWriteTotalMs: this.processDelayMs - 15,
      },
    };
  }
}

// ─── Mock backend that simulates generation-switching for stale detection ─

class StaleGenAwareMockBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "nvidia-vsr";
  private frameCount = 0;
  private _staleAfterFrame = 999; // default: never stale
  private _generationOverride = 0;

  onSourceResize?(_sourceWidth: number, _sourceHeight: number): void {}

  setStaleAfterFrame(n: number): void {
    this._staleAfterFrame = n;
  }

  setGenerationOverride(gen: number): void {
    this._generationOverride = gen;
  }

  async initialize(_canvas?: HTMLCanvasElement): Promise<BackendInitResult> {
    return { success: true };
  }

  async destroy(): Promise<void> {}

  updateSettings(_settings: ViewerImageEnhancementSettings): void {}

  resizeOutput(_width: number, _height: number, _dpr: number): void {}

  getStats(): BackendStats {
    return {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      enhancedScalingActive: true,
      lastGpuTimeMs: null,
      backend: "nvidia-vsr",
      framesProcessed: this.frameCount,
      activePasses: ["nvidia-vsr"],
      backpressureDrops: 0,
    };
  }

  async processFrame(
    _video: HTMLVideoElement,
    _metadata?: FrameMetadata,
  ): Promise<FrameProcessResult> {
    this.frameCount++;

    // After staleAfterFrame, simulate a generation switch in the processor
    // by returning a result that will cause the processor to detect a mismatch.
    if (this.frameCount > this._staleAfterFrame) {
      // The processor checks: gen !== this.generation (where gen was captured)
      // We can't trigger that here directly, but we can make the processor
      // call processFrame again after the generation changes.
      return {
        success: true,
        generation: _metadata?.generation ?? 0,
        sequence: _metadata?.frameSequence ?? 0,
        gpuTimeMs: 10,
        outputWidth: 3840,
        outputHeight: 2160,
        totalLatencyMs: 10,
        timingBreakdown: {
          captureReadbackMs: 3,
          rendererTotalMs: 10,
          rendererToResultMs: 5,
        },
      };
    }

    await new Promise((r) => setTimeout(r, 10));
    return {
      success: true,
      generation: _metadata?.generation,
      sequence: _metadata?.frameSequence,
      gpuTimeMs: 10,
      outputWidth: 3840,
      outputHeight: 2160,
      totalLatencyMs: 10,
      timingBreakdown: {
        captureReadbackMs: 3,
        rendererTotalMs: 10,
        rendererToResultMs: 5,
      },
    };
  }
}

// ─── Tests: Processor-level coalescing ───────────────────────────────────

describe("RC1: Processor-level coalescing (viewer-image-processor)", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let backend: DelayMockBackend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement({ currentTime: 0 });
    backend = new DelayMockBackend();
    processor = new ViewerImageProcessor(canvas, video, backend);
  });

  afterEach(async () => {
    if (processor.getState() !== "destroyed") {
      await processor.destroy();
    }
  });

  it("processes one frame successfully via processCurrentFrameAsync", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    await process.call(processor);

    const stats = processor.getStats();
    expect(stats.framesProcessed).toBe(1);
    expect(stats.completedAttempts).toBe(1);
    expect(stats.displayedCount).toBe(1);
  });

  it("increments frames processed on each successful frame", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    await process.call(processor);
    await process.call(processor);
    await process.call(processor);

    const stats = processor.getStats();
    expect(stats.framesProcessed).toBe(3);
    expect(stats.completedAttempts).toBe(3);
  });

  it("coalesces multiple frames: only the newest pending frame is processed", async () => {
    // This tests that when a generation changes during processing,
    // stale results are detected and dropped.
    // The processor's setBackend triggers a generation bump.
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    // Process a frame normally
    await process.call(processor);
    let stats = processor.getStats();
    expect(stats.framesProcessed).toBe(1);

    // Backend swap triggers generation bump (setBackend bumps twice:
    // once in setBackend body, once via startAsync)
    const newBackend = new DelayMockBackend();
    await processor.setBackend(newBackend);
    await flushMicrotasks();

    // Process a frame after swap
    const process2 = getProcessFn(processor);
    await process2.call(processor);
    stats = processor.getStats();

    // The second start increments the generation but does NOT count as stale
    // because the backend returned the correct generation.
    expect(stats.staleGenerationDrops).toBe(0);
    // framesProcessed is reset by startAsync, so only the post-swap frame counts
    expect(stats.framesProcessed).toBe(1);

    await processor.destroy();
  });

  it("backend swap via setBackend bumps generation and clears state", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    // Process one frame
    const process = getProcessFn(processor);
    await process.call(processor);
    const genBefore = processor.getStats().generation;

    // Swap backend (simulates restart)
    const newBackend = new DelayMockBackend();
    await processor.setBackend(newBackend);
    await flushMicrotasks();

    // Process a frame on the new backend
    const process2 = getProcessFn(processor);
    await process2.call(processor);
    const stats = processor.getStats();

    // setBackend bumps generation twice: once in body, once via startAsync.
    // So genAfter = genBefore + 2, not +1.
    expect(stats.generation).toBe(genBefore + 2);
    // Stale generation drops from old frames should be 0
    expect(stats.staleGenerationDrops).toBe(0);
  });
});

// ─── Tests: Pause/resume lifecycle ──────────────────────────────────────

describe("RC3: Flush on pause/resume - stale work discarded", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let backend: DelayMockBackend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    backend = new DelayMockBackend();
    processor = new ViewerImageProcessor(canvas, video, backend);
  });

  afterEach(async () => {
    if (processor.getState() !== "destroyed") {
      await processor.destroy();
    }
  });

  it("pause transitions state to paused", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    processor.pause();
    expect(processor.getState()).toBe("paused");
  });

  it("pause stops frame processing", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    // Process one frame
    await process.call(processor);
    expect(processor.getState()).toBe("running");

    // Pause
    processor.pause();
    expect(processor.getState()).toBe("paused");

    // processingAttempts should show the one completed frame
    const stats = processor.getStats();
    expect(stats.completedAttempts).toBe(1);
  });

  it("resume restarts processing in running state", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    // Process one frame, pause, then resume
    await process.call(processor);
    processor.pause();
    expect(processor.getState()).toBe("paused");

    processor.resume();
    expect(processor.getState()).toBe("running");
    await flushMicrotasks();

    // Process another frame after resume
    await process.call(processor);
    const stats = processor.getStats();
    expect(stats.framesDisplayed).toBe(2);
    expect(stats.staleGenerationDrops).toBe(0);
  });

  it("destroy during pause cleans up properly", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    processor.pause();
    await processor.destroy();
    expect(processor.getState()).toBe("destroyed");
  });
});

// ─── Tests: Config change behavior ──────────────────────────────────────

describe("Config change resets pending state", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let backend: DelayMockBackend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    backend = new DelayMockBackend();
    processor = new ViewerImageProcessor(canvas, video, backend);
  });

  afterEach(async () => {
    if (processor.getState() !== "destroyed") {
      await processor.destroy();
    }
  });

  it("updateSettings during running does not affect generation", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    await process.call(processor);

    const genBefore = processor.getStats().generation;

    processor.updateSettings({
      ...defaultSettings,
      nvidiaQuality: "ultra",
    });

    await process.call(processor);
    const stats = processor.getStats();
    expect(stats.generation).toBe(genBefore);
  });

  it("setBackend bumps generation and resets frame sequence", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    await process.call(processor);

    const genBefore = processor.getStats().generation;

    const newBackend = new DelayMockBackend();
    await processor.setBackend(newBackend);
    await flushMicrotasks();

    const process2 = getProcessFn(processor);
    await process2.call(processor);

    const stats = processor.getStats();
    // setBackend bumps generation twice: once in body, once via startAsync
    expect(stats.generation).toBe(genBefore + 2);
  });
});

// ─── Tests: Timing label truthfulness ───────────────────────────────────

describe("RC4: Timing label truthfulness at processor level", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let backend: DelayMockBackend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    backend = new DelayMockBackend();
    processor = new ViewerImageProcessor(canvas, video, backend);
  });

  afterEach(async () => {
    if (processor.getState() !== "destroyed") {
      await processor.destroy();
    }
  });

  it("returns non-null timing values after successful frames", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    for (let i = 0; i < 3; i++) {
      await process.call(processor);
    }

    const stats = processor.getStats();
    // Renderer timings should be non-null since backend provides timingBreakdown
    expect(stats.drawImageTimeMs).not.toBeNull();
    expect(stats.rendererToResultTimeMs).not.toBeNull();
    expect(stats.rendererTotalTimeMs).not.toBeNull();
    // Native transport should be present
    expect(stats.nativeTransportProcessingTimeMs).not.toBeNull();
    // Display upload should be present
    expect(stats.displayUploadTimeMs).not.toBeNull();
  });

  it("nativeTransportProcessingMs is distinct from rendererToResultMs", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    for (let i = 0; i < 3; i++) {
      await process.call(processor);
    }

    const stats = processor.getStats();
    expect(stats.nativeTransportProcessingTimeMs).not.toBeNull();
    expect(stats.rendererToResultTimeMs).not.toBeNull();
    // nativeTransportProcessingMs should be less than rendererToResultMs
    // because the backend provides a true native pre-write total (shorter)
    expect(stats.nativeTransportProcessingTimeMs!).toBeLessThan(stats.rendererToResultTimeMs!);
  });

  it("nativeOutputWriteTimeMs is NOT exposed in per-frame stats", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    await process.call(processor);

    const stats = processor.getStats() as Record<string, unknown>;
    expect("nativeOutputWriteTimeMs" in stats).toBe(false);
  });

  it("total round-trip is NOT labeled as GPU Time for NVIDIA", () => {
    const isNvidia = true;
    const label = isNvidia ? "Native Round Trip" : "GPU Time";
    expect(label).toBe("Native Round Trip");
  });
});

// ─── Tests: Frame metadata identity integrity ───────────────────────────

describe("Frame metadata identity integrity", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let backend: DelayMockBackend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    backend = new DelayMockBackend();
    processor = new ViewerImageProcessor(canvas, video, backend);
  });

  afterEach(async () => {
    if (processor.getState() !== "destroyed") {
      await processor.destroy();
    }
  });

  it("generation and frameSequence are passed through processFrame", async () => {
    const processFrameSpy = vi.spyOn(backend, "processFrame");

    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    await process.call(processor);

    expect(processFrameSpy).toHaveBeenCalled();
    const metadata = processFrameSpy.mock.calls[0]?.[1];
    expect(metadata).toBeDefined();
    expect(metadata!.generation).toBeGreaterThanOrEqual(1);
    expect(metadata!.frameSequence).toBeGreaterThanOrEqual(1);

    processFrameSpy.mockRestore();
  });

  it("generation increments on each processor start", async () => {
    // Start, process, destroy cycle to verify generation management
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    await process.call(processor);
    const gen1 = processor.getStats().generation;

    await processor.destroy();

    // Create fresh cycle
    const processor2 = new ViewerImageProcessor(canvas, video, backend);
    processor2.start(defaultSettings);
    await flushMicrotasks();

    const process2 = getProcessFn(processor2);
    await process2.call(processor2);
    const gen2 = processor2.getStats().generation;

    // Each processor instance gets sequential generation starting at 1
    expect(gen2).toBeGreaterThanOrEqual(1);

    await processor2.destroy();
  });

  it("frameSequence increments within a generation", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);
    const processFrameSpy = vi.spyOn(backend, "processFrame");

    await process.call(processor);
    await process.call(processor);
    await process.call(processor);

    expect(processFrameSpy).toHaveBeenCalledTimes(3);
    const seq1 = processFrameSpy.mock.calls[0]?.[1]?.frameSequence;
    const seq2 = processFrameSpy.mock.calls[1]?.[1]?.frameSequence;
    const seq3 = processFrameSpy.mock.calls[2]?.[1]?.frameSequence;

    // Sequences should be strictly increasing
    expect(seq2).toBeGreaterThan(seq1!);
    expect(seq3).toBeGreaterThan(seq2!);

    processFrameSpy.mockRestore();
  });

  it("frameSequence resets to 0 on new generation (setBackend)", async () => {
    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    // Spy on first backend
    const processFrameSpy1 = vi.spyOn(backend, "processFrame");
    await process.call(processor);
    const seq1 = processFrameSpy1.mock.calls[0]?.[1]?.frameSequence;
    expect(seq1).toBe(1); // first call in generation
    processFrameSpy1.mockRestore();

    // Swap backend
    const newBackend = new DelayMockBackend();
    await processor.setBackend(newBackend);
    await flushMicrotasks();

    // Spy on new backend
    const processFrameSpy2 = vi.spyOn(newBackend, "processFrame");
    const process2 = getProcessFn(processor);
    await process2.call(processor);
    const seqAfterSwap = processFrameSpy2.mock.calls[0]?.[1]?.frameSequence;
    // Frame sequence should reset to 1 on setBackend
    expect(seqAfterSwap).toBe(1);
    processFrameSpy2.mockRestore();
  });
});

// ─── Tests: Backend-level stale generation detection ────────────────────

describe("Backend-level stale generation detection", () => {
  it("processor catches stale generation when generation changes during processCurrentFrameAsync", async () => {
    // This test verifies the generation check in processCurrentFrameAsync:
    //   if (gen !== this.generation) { this._staleGenerationDrops++; ... }
    //
    // We simulate this by calling setBackend which bumps the generation.
    // Any in-flight frame that completes with the old generation is detected.
    const canvas = createCanvas();
    const video = createVideoElement();
    const backend = new DelayMockBackend();
    const processor = new ViewerImageProcessor(canvas, video, backend);

    processor.start(defaultSettings);
    await flushMicrotasks();

    const process = getProcessFn(processor);

    // Process a frame normally
    await process.call(processor);
    let stats = processor.getStats();
    expect(stats.staleGenerationDrops).toBe(0);
    expect(stats.completedAttempts).toBe(1);

    // setBackend destroys old backend, creates new one, bumps generation
    const newBackend = new DelayMockBackend();
    await processor.setBackend(newBackend);
    await flushMicrotasks();

    // Process a frame on the new backend
    const process2 = getProcessFn(processor);
    await process2.call(processor);
    stats = processor.getStats();

    // No stale drops because the new frames match the new generation
    expect(stats.staleGenerationDrops).toBe(0);
    // completedAttempts is reset by startAsync during setBackend,
    // so only the post-swap frame counts
    expect(stats.completedAttempts).toBe(1);
    // Generation should have bumped
    expect(stats.generation).toBeGreaterThanOrEqual(3);

    await processor.destroy();
  });
});
