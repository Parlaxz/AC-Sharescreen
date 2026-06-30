// @vitest-environment happy-dom
/**
 * Component-level integration tests for EnhancedVideoSurface lifecycle.
 *
 * Verifies that the component correctly manages processor lifecycle across
 * same-videoElement rerenders and videoElement replacement, and that
 * semantically unchanged settings do not trigger updateSettings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, cleanup, act } from "@testing-library/react";
import type { ViewerImageEnhancementSettings } from "../src/renderer/services/viewer-image-processing/viewer-image-settings";
import type {
  BackendKind,
  BackendStats,
} from "../src/renderer/services/viewer-image-processing/viewer-image-backend";

// ─── Module-level mocks ─────────────────────────────────────────────────────

/**
 * Fresh mock processor instance for each test.
 * Exported so test bodies can reset/assert on the latest instance.
 */
let _currentMockProcessor: ReturnType<typeof createMockProcessor> | null = null;

function createMockProcessor() {
  const instance = {
    instanceId: Math.floor(Math.random() * 100000) + 1,
    destroy: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn(),
    resizeOutput: vi.fn(),
    setBackend: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(() => "running"),
    setCallbacks: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  _currentMockProcessor = instance;
  return instance;
}

/** Get the most recently created mock processor instance */
function currentMockProcessor() {
  return _currentMockProcessor;
}

vi.mock("@/services/viewer-image-processing/viewer-image-processor", () => ({
  ViewerImageProcessor: vi.fn().mockImplementation(() => createMockProcessor()),
}));

const mockBackend = {
  kind: "webgl2" as BackendKind,
  initialize: vi.fn().mockResolvedValue({ success: true }),
  updateSettings: vi.fn(),
  processFrame: vi.fn().mockResolvedValue({ success: true, gpuTimeMs: 5 }),
  resizeOutput: vi.fn(),
  getStats: vi.fn((): BackendStats => ({
    inputWidth: 0, inputHeight: 0, outputWidth: 0, outputHeight: 0,
    enhancedScalingActive: false, lastGpuTimeMs: null, backend: "webgl2",
    framesProcessed: 0, activePasses: [], backpressureDrops: 0,
  })),
  destroy: vi.fn().mockResolvedValue(undefined),
  onSourceResize: vi.fn(),
};

const mockFallbackChain = {
  activeStage: "webgl2",
  activeBackend: mockBackend,
  reason: undefined,
  advance: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@/services/viewer-image-processing/viewer-image-backend-factory", () => ({
  createImageProcessingBackend: vi.fn(() => ({
    backend: mockBackend,
    requested: "webgl2",
    effective: "webgl2",
    fallbackReason: undefined,
    chainController: mockFallbackChain,
  })),
}));

vi.mock("@/services/viewer-image-processing/viewer-image-capabilities", () => ({
  getImageProcessingCapabilities: vi.fn(() => ({
    webgl2Available: true,
    nvidiaVsrAvailable: false,
  })),
  augmentWithNvidiaCapability: vi.fn().mockResolvedValue(undefined),
}));

// We must import after the hoisted mocks
// eslint-disable-next-line import/first
import { EnhancedVideoSurface } from "../src/renderer/components/workspace/viewer/EnhancedVideoSurface";
// eslint-disable-next-line import/first
import type { Mock } from "vitest";
import { ViewerImageProcessor } from "@/services/viewer-image-processing/viewer-image-processor";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ViewerImageEnhancementSettings = {
  enabled: true,
  processingBackend: "webgl2",
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

function createVideoElement(): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: 1920, writable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, writable: true });
  Object.defineProperty(video, "readyState", { value: 4, writable: true });
  return video;
}

/** Wait for all pending microtasks and React effects to settle. */
async function settleEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("EnhancedVideoSurface — processor lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("creates a processor when videoElement and enabled props are provided", async () => {
    const video = createVideoElement();
    render(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await settleEffects();

    expect(ViewerImageProcessor).toHaveBeenCalledTimes(1);
    expect(currentMockProcessor()!.start).toHaveBeenCalledWith(DEFAULT_SETTINGS);
  });

  it("does not create a second processor when the same videoElement is kept (stable rerender)", async () => {
    const video = createVideoElement();
    const { rerender } = render(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await settleEffects();
    expect(ViewerImageProcessor).toHaveBeenCalledTimes(1);

    // Clear the create-call count and simulate a React rerender with same video element
    const prevDestroy = currentMockProcessor()!.destroy;
    vi.mocked(ViewerImageProcessor).mockClear();

    rerender(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await settleEffects();

    // Rerender with same video element should NOT create a new processor
    expect(ViewerImageProcessor).not.toHaveBeenCalled();
    // Nor destroy the existing one
    expect(prevDestroy).not.toHaveBeenCalled();
  });

  it("destroys old processor and creates new one when videoElement changes", async () => {
    const video1 = createVideoElement();
    const video2 = createVideoElement();

    const { rerender } = render(
      <EnhancedVideoSurface
        videoElement={video1}
        enabled={true}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await settleEffects();
    expect(ViewerImageProcessor).toHaveBeenCalledTimes(1);

    // Reset counters - grab the current destroy mock before rerender
    const prevDestroy = currentMockProcessor()!.destroy;
    vi.mocked(ViewerImageProcessor).mockClear();

    // Change to a different videoElement
    rerender(
      <EnhancedVideoSurface
        videoElement={video2}
        enabled={true}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await settleEffects();

    // Should have created a new processor
    expect(ViewerImageProcessor).toHaveBeenCalledTimes(1);
    // The old effect cleanup should have called destroy with the exact reason
    expect(prevDestroy).toHaveBeenCalledWith("video-element-changed");
  });

  it("reports component-unmount reason on unmount", async () => {
    const video = createVideoElement();
    const { unmount } = render(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await settleEffects();

    const prevDestroy = currentMockProcessor()!.destroy;
    unmount();

    // On unmount, the cleanup must report "component-unmount" (not a conflated
    // "deps changed" or hardcoded value) because the closure had truthy
    // enabled/videoElement but the component is leaving the tree.
    expect(prevDestroy).toHaveBeenCalledWith("component-unmount");
  });

  it("does not call updateSettings when settings are semantically unchanged", async () => {
    const video = createVideoElement();
    const { rerender } = render(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await settleEffects();

    // Clear all mock calls from initialization
    const proc = currentMockProcessor()!;
    proc.updateSettings.mockClear();

    // Rerender with a fresh object that has identical values
    rerender(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={{ ...DEFAULT_SETTINGS }}
      />,
    );

    await settleEffects();

    // updateSettings should NOT be called when values are identical
    expect(proc.updateSettings).not.toHaveBeenCalled();
    // setBackend should NOT be called when backend hasn't changed
    expect(proc.setBackend).not.toHaveBeenCalled();
    // destroy should NOT be called
    expect(proc.destroy).not.toHaveBeenCalled();
  });

  it("calls updateSettings when a numeric setting changes", async () => {
    const video = createVideoElement();
    const { rerender } = render(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await settleEffects();

    const proc = currentMockProcessor()!;
    proc.updateSettings.mockClear();

    // Change sharpening strength
    const changedSettings: ViewerImageEnhancementSettings = {
      ...DEFAULT_SETTINGS,
      sharpeningStrength: 0.75,
    };

    rerender(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={changedSettings}
      />,
    );

    await settleEffects();

    // updateSettings should be called with the new settings
    expect(proc.updateSettings).toHaveBeenCalledTimes(1);
    expect(proc.updateSettings).toHaveBeenCalledWith(changedSettings);
    // setBackend should NOT be called when only a numeric field changed
    expect(proc.setBackend).not.toHaveBeenCalled();
    // destroy should NOT be called
    expect(proc.destroy).not.toHaveBeenCalled();
  });

  it("calls setBackend when processingBackend changes", async () => {
    const video = createVideoElement();
    const { rerender } = render(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await settleEffects();

    const proc = currentMockProcessor()!;
    proc.setBackend.mockClear();
    proc.updateSettings.mockClear();

    // Change backend
    const changedSettings: ViewerImageEnhancementSettings = {
      ...DEFAULT_SETTINGS,
      processingBackend: "nvidia-vsr",
    };

    rerender(
      <EnhancedVideoSurface
        videoElement={video}
        enabled={true}
        settings={changedSettings}
      />,
    );

    await settleEffects();

    // setBackend should be called when backend changes
    expect(proc.setBackend).toHaveBeenCalledTimes(1);
    // updateSettings should also be called after backend switch
    expect(proc.updateSettings).toHaveBeenCalledTimes(1);
    // destroy should NOT be called
    expect(proc.destroy).not.toHaveBeenCalled();
  });
});
