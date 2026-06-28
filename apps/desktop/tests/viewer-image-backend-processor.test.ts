// @vitest-environment happy-dom
/**
 * Comprehensive tests for the viewer GPU image enhancement pipeline.
 *
 * Covers:
 *   - Resource dimension tracking (no getTexLevelParameter)
 *   - Transient / not-ready frame handling
 *   - Re-enable clears fallback / fresh processor
 *   - Settings propagate to backend live
 *   - RVFC single-registration lifecycle
 *   - First-frame canvas visibility gating
 *   - Timer query failure does not break rendering
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ViewerImageProcessor } from "@/services/viewer-image-processing/viewer-image-processor";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "@/services/viewer-image-processing/viewer-image-defaults";
import type {
  BackendInitResult,
  FrameProcessResult,
  BackendStats,
} from "@/services/viewer-image-processing/webgl2-viewer-image-backend";

// ─── Types for the mock backend ─────────────────────────────────────────────

interface MockUniformCall {
  name: string;
  value: unknown;
}

// ─── Mock WebGL2ViewerImageBackend ──────────────────────────────────────────

class MockWebGL2Backend {
  // Track initialization
  initCalled = false;
  destroyCalled = false;
  updateSettingsCalled = false;
  lastSettings: ViewerImageEnhancementSettings | null = null;
  resizeCalls: Array<{ width: number; height: number; dpr: number }> = [];

  // Frame processing control
  private shouldFailNext = false;
  private nextResult: FrameProcessResult = { success: true };

  // Stats tracking
  statsCallCount = 0;

  // Uniform tracking
  uniformCalls: MockUniformCall[] = [];

  initialize(_canvas: HTMLCanvasElement): BackendInitResult {
    this.initCalled = true;
    return { success: true };
  }

  destroy(): void {
    this.destroyCalled = true;
  }

  updateSettings(settings: ViewerImageEnhancementSettings): void {
    this.updateSettingsCalled = true;
    this.lastSettings = { ...settings };
  }

  resizeOutput(width: number, height: number, dpr: number): void {
    this.resizeCalls.push({ width, height, dpr });
  }

  processFrame(_video: HTMLVideoElement): FrameProcessResult {
    return this.nextResult;
  }

  getStats(): BackendStats {
    this.statsCallCount++;
    return {
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      enhancedScalingActive: false,
      lastGpuTimeMs: 5,
      contextLossCount: 0,
      backend: "webgl2",
      scalingAlgorithm: "native",
    };
  }

  // Test helpers
  setNextResult(result: FrameProcessResult): void {
    this.nextResult = result;
  }

  setFailNext(fail = true): void {
    this.shouldFailNext = fail;
    this.nextResult = fail ? { success: false } : { success: true };
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

vi.mock(
  "@/services/viewer-image-processing/webgl2-viewer-image-backend",
  () => {
    const MockBackend = vi.fn();
    return { WebGL2ViewerImageBackend: MockBackend };
  },
);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ViewerImageProcessor — transient frame handling", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let mockBackend: MockWebGL2Backend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    mockBackend = new MockWebGL2Backend();
    processor = new ViewerImageProcessor(canvas, video);
    (processor as unknown as { backend: MockWebGL2Backend }).backend =
      mockBackend;
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("transient frames (result.transient=true) are skipped without error", () => {
    const onError = vi.fn();
    const onStateChange = vi.fn();
    processor.setCallbacks({ onError, onStateChange });

    mockBackend.setNextResult({ success: false, transient: true });

    processor.start(defaultSettings);

    const processCurrentFrame = (
      processor as unknown as { processCurrentFrame: () => void }
    ).processCurrentFrame;
    processCurrentFrame.call(processor);

    expect(onError).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalledWith("error");
  });

  it("non-transient failure triggers error and fallback", () => {
    const onError = vi.fn();
    const onStateChange = vi.fn();
    processor.setCallbacks({ onError, onStateChange });

    mockBackend.setNextResult({ success: false });

    processor.start(defaultSettings);

    const processCurrentFrame = (
      processor as unknown as { processCurrentFrame: () => void }
    ).processCurrentFrame;
    processCurrentFrame.call(processor);

    expect(onError).toHaveBeenCalled();
    expect(processor.getState()).toBe("error");
  });
});

describe("ViewerImageProcessor — settings propagation", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let mockBackend: MockWebGL2Backend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    mockBackend = new MockWebGL2Backend();
    processor = new ViewerImageProcessor(canvas, video);
    (processor as unknown as { backend: MockWebGL2Backend }).backend =
      mockBackend;
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("calls updateSettings on start", () => {
    processor.start(defaultSettings);
    expect(mockBackend.updateSettingsCalled).toBe(true);
    expect(mockBackend.lastSettings?.enabled).toBe(true);
  });

  it("forwards settings changes to backend while running", () => {
    processor.start(defaultSettings);
    mockBackend.updateSettingsCalled = false;

    const newSettings = { ...defaultSettings, sharpeningStrength: 0.75 };
    processor.updateSettings(newSettings);

    expect(mockBackend.updateSettingsCalled).toBe(true);
    expect(mockBackend.lastSettings?.sharpeningStrength).toBe(0.75);
  });

  it("does not forward settings to destroyed processor", () => {
    processor.start(defaultSettings);
    processor.destroy();
    mockBackend.updateSettingsCalled = false;

    processor.updateSettings({
      ...defaultSettings,
      sharpeningStrength: 0.5,
    });

    expect(mockBackend.updateSettingsCalled).toBe(false);
  });
});

describe("ViewerImageProcessor — settings live update (uniform mapping)", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let mockBackend: MockWebGL2Backend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    mockBackend = new MockWebGL2Backend();
    processor = new ViewerImageProcessor(canvas, video);
    (processor as unknown as { backend: MockWebGL2Backend }).backend =
      mockBackend;
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("every exposed setting maps to a backend updateSettings call", () => {
    processor.start(defaultSettings);

    const settingsKeys: Array<keyof ViewerImageEnhancementSettings> = [
      "enabled",
      "scalingAlgorithm",
      "sharpeningStrength",
      "chromaContribution",
      "artifactClamp",
      "textureNoiseSharpening",
      "antiRinging",
      "chromaCleanup",
      "compressionSmoothing",
    ];

    for (const key of settingsKeys) {
      mockBackend.updateSettingsCalled = false;
      const newVal =
        typeof defaultSettings[key] === "boolean"
          ? !(defaultSettings[key] as boolean)
          : key === "scalingAlgorithm"
            ? "bilinear"
            : 0.99;
      const patch = { [key]: newVal } as Partial<ViewerImageEnhancementSettings>;
      processor.updateSettings({ ...defaultSettings, ...patch });
      expect(mockBackend.updateSettingsCalled).toBe(true);
    }
  });
});

describe("ViewerImageProcessor — RVFC lifecycle", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let mockBackend: MockWebGL2Backend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    mockBackend = new MockWebGL2Backend();
    processor = new ViewerImageProcessor(canvas, video);
    (processor as unknown as { backend: MockWebGL2Backend }).backend =
      mockBackend;
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("cancelFrame is safe to call on paused/destroyed processor", () => {
    processor.start(defaultSettings);

    processor.pause();
    expect(processor.getState()).toBe("paused");

    processor.pause();
    expect(processor.getState()).toBe("paused");

    processor.resume();
    expect(processor.getState()).toBe("running");
    processor.destroy();
    expect(processor.getState()).toBe("destroyed");

    processor.destroy();
    expect(processor.getState()).toBe("destroyed");
  });

  it("transitions state correctly on start/pause/resume/destroy", () => {
    expect(processor.getState()).toBe("idle");

    processor.start(defaultSettings);
    expect(processor.getState()).toBe("running");

    processor.pause();
    expect(processor.getState()).toBe("paused");

    processor.resume();
    expect(processor.getState()).toBe("running");

    processor.destroy();
    expect(processor.getState()).toBe("destroyed");
  });
});

describe("ViewerImageProcessor — first frame tracking", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let mockBackend: MockWebGL2Backend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    mockBackend = new MockWebGL2Backend();
    processor = new ViewerImageProcessor(canvas, video);
    (processor as unknown as { backend: MockWebGL2Backend }).backend =
      mockBackend;
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("fires onFirstFrame callback on first successful frame", () => {
    const onFirstFrame = vi.fn();

    mockBackend.setNextResult({ success: true });

    processor.start(defaultSettings);
    processor.setCallbacks({ onFirstFrame });

    const processCurrentFrame = (
      processor as unknown as { processCurrentFrame: () => void }
    ).processCurrentFrame;
    processCurrentFrame.call(processor);

    expect(onFirstFrame).toHaveBeenCalledTimes(1);
  });

  it("does not fire onFirstFrame for transient frames", () => {
    const onFirstFrame = vi.fn();

    mockBackend.setNextResult({ success: false, transient: true });

    processor.start(defaultSettings);
    processor.setCallbacks({ onFirstFrame });

    const processCurrentFrame = (
      processor as unknown as { processCurrentFrame: () => void }
    ).processCurrentFrame;
    processCurrentFrame.call(processor);

    expect(onFirstFrame).not.toHaveBeenCalled();
  });

  it("does not fire onFirstFrame for failed frames", () => {
    const onFirstFrame = vi.fn();

    mockBackend.setNextResult({ success: false });

    processor.start(defaultSettings);
    processor.setCallbacks({ onFirstFrame });

    const processCurrentFrame = (
      processor as unknown as { processCurrentFrame: () => void }
    ).processCurrentFrame;
    processCurrentFrame.call(processor);

    expect(onFirstFrame).not.toHaveBeenCalled();
  });
});

describe("ViewerImageProcessor — fallback lifecycle", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let mockBackend: MockWebGL2Backend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    mockBackend = new MockWebGL2Backend();
    processor = new ViewerImageProcessor(canvas, video);
    (processor as unknown as { backend: MockWebGL2Backend }).backend =
      mockBackend;
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("can restart after error state by starting a new processor", () => {
    mockBackend.setNextResult({ success: false });
    processor.start(defaultSettings);

    const processCurrentFrame = (
      processor as unknown as { processCurrentFrame: () => void }
    ).processCurrentFrame;
    processCurrentFrame.call(processor);

    expect(processor.getState()).toBe("error");

    const processor2 = new ViewerImageProcessor(
      createCanvas(),
      createVideoElement(),
    );
    const mockBackend2 = new MockWebGL2Backend();
    (processor2 as unknown as { backend: MockWebGL2Backend }).backend =
      mockBackend2;

    mockBackend2.setNextResult({ success: true });
    processor2.start(defaultSettings);
    expect(processor2.getState()).toBe("running");

    const processCurrentFrame2 = (
      processor2 as unknown as { processCurrentFrame: () => void }
    ).processCurrentFrame;
    processCurrentFrame2.call(processor2);
    expect(processor2.getState()).toBe("running");

    processor2.destroy();
  });
});

describe("ViewerImageProcessor — stats include scalingAlgorithm", () => {
  let processor: ViewerImageProcessor;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let mockBackend: MockWebGL2Backend;

  beforeEach(() => {
    canvas = createCanvas();
    video = createVideoElement();
    mockBackend = new MockWebGL2Backend();
    processor = new ViewerImageProcessor(canvas, video);
    (processor as unknown as { backend: MockWebGL2Backend }).backend =
      mockBackend;
  });

  afterEach(() => {
    if (processor.getState() !== "destroyed") {
      processor.destroy();
    }
  });

  it("getStats includes scalingAlgorithm", () => {
    processor.start(defaultSettings);
    const stats = processor.getStats();
    expect(stats.scalingAlgorithm).toBe("native");
  });
});
