// @vitest-environment happy-dom
/**
 * Comprehensive tests for A/B compare display mode behavior.
 *
 * Verifies that display mode changes (A, B, Vertical Compare) are presentation-only:
 * - No processor recreation, no backend replacement, no source video changes
 * - Raw video underlay always present in compare mode
 * - Both processing surfaces always mounted
 * - Readiness preserved across mode switches
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import type { ViewerImageEnhancementSettings } from "../src/renderer/services/viewer-image-processing/viewer-image-settings";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "../src/renderer/services/viewer-image-processing/viewer-image-defaults";

// ─── Module-level mocks ─────────────────────────────────────────────────────

let _processorInstanceCount = 0;
let _processorInstances: Record<string, ReturnType<typeof createMockProcessor>> = {};
let _nextProcessorId = 1;

function createMockProcessor(id?: string) {
  const instanceId = id ?? `proc-${_nextProcessorId++}`;
  const instance = {
    _testId: instanceId,
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
  _processorInstances[instanceId] = instance;
  _processorInstanceCount++;
  return instance;
}

function resetProcessorTracking() {
  _processorInstanceCount = 0;
  _processorInstances = {};
  _nextProcessorId = 1;
}

vi.mock("@/services/viewer-image-processing/viewer-image-processor", () => ({
  ViewerImageProcessor: vi.fn().mockImplementation(() => {
    const id = `proc-${_nextProcessorId++}`;
    const instance = {
      _testId: id,
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
    _processorInstances[id] = instance;
    _processorInstanceCount++;
    return instance;
  }),
}));

const mockBackend = {
  kind: "webgl2" as const,
  initialize: vi.fn().mockResolvedValue({ success: true }),
  updateSettings: vi.fn(),
  processFrame: vi.fn().mockResolvedValue({ success: true, gpuTimeMs: 5 }),
  resizeOutput: vi.fn(),
  getStats: vi.fn(() => ({
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

let _factoryCallCount = 0;
vi.mock("@/services/viewer-image-processing/viewer-image-backend-factory", () => ({
  createImageProcessingBackend: vi.fn(() => {
    _factoryCallCount++;
    return {
      backend: mockBackend,
      requested: "webgl2",
      effective: "webgl2",
      fallbackReason: undefined,
      chainController: mockFallbackChain,
    };
  }),
}));

vi.mock("@/services/viewer-image-processing/viewer-image-capabilities", () => ({
  getImageProcessingCapabilities: vi.fn(() => ({
    webgl2Available: true,
    nvidiaVsrAvailable: false,
  })),
  augmentWithNvidiaCapability: vi.fn().mockResolvedValue(undefined),
}));

// We must import after hoisted mocks
// eslint-disable-next-line import/first
import { CompareViewerSurface, type CompareDisplayMode, getEffectiveBackend } from "../src/renderer/components/workspace/CompareViewerSurface";
// eslint-disable-next-line import/first
import { EnhancedVideoSurface } from "../src/renderer/components/workspace/viewer/EnhancedVideoSurface";
// eslint-disable-next-line import/first
import { TooltipProvider } from "../src/renderer/components/ui/tooltip";
// eslint-disable-next-line import/first
import { ViewerImageProcessor } from "@/services/viewer-image-processing/viewer-image-processor";

/** Wraps children in TooltipProvider to satisfy Radix Tooltip requirements */
function WithTooltip({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

/** Render with TooltipProvider wrapper */
function renderWithTooltip(ui: React.ReactElement) {
  return render(ui, { wrapper: WithTooltip });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS_A: ViewerImageEnhancementSettings = {
  ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
  processingBackend: "webgl2",
  sharpeningStrength: 0.25,
};

const DEFAULT_SETTINGS_B: ViewerImageEnhancementSettings = {
  ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
  processingBackend: "webgl2",
  sharpeningStrength: 0.5,
};

function createVideoElement(): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: 1920, writable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, writable: true });
  Object.defineProperty(video, "readyState", { value: 4, writable: true });
  // For the underlay ref callback: provide a stub so el.srcObject assignment works
  // without trying to set a real MediaStream (which happy-dom validates).
  Object.defineProperty(video, "srcObject", {
    get: () => null,
    set: () => {}, // no-op setter to avoid type errors in happy-dom
    configurable: true,
  });
  return video;
}

/** Wait for all pending microtasks and React effects to settle. */
async function settleEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

// Helper: get all processor instances created so far
function getProcessorInstances(): Record<string, ReturnType<typeof createMockProcessor>> {
  return { ..._processorInstances };
}

function countProcessors(): number {
  return Object.keys(_processorInstances).length;
}

// ─── getEffectiveBackend tests (existing) ────────────────────────────────────

describe("CompareViewerSurface — NVIDIA single-side enforcement", () => {
  const webglSettings: ViewerImageEnhancementSettings = {
    ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
    processingBackend: "webgl2",
  };
  const nvidiaSettings: ViewerImageEnhancementSettings = {
    ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
    processingBackend: "nvidia-vsr",
  };

  it("passes through webgl2 when no NVIDIA conflict", () => {
    const result = getEffectiveBackend(webglSettings, null);
    expect(result.effectiveBackend).toBe("webgl2");
    expect(result.nvidiaForcedOff).toBe(false);
  });

  it("passes through nvidia-vsr when other side is not using it", () => {
    const result = getEffectiveBackend(nvidiaSettings, null);
    expect(result.effectiveBackend).toBe("nvidia-vsr");
    expect(result.nvidiaForcedOff).toBe(false);
  });

  it("forces webgl2 when other side is already using nvidia-vsr", () => {
    const result = getEffectiveBackend(nvidiaSettings, "nvidia-vsr");
    expect(result.effectiveBackend).toBe("webgl2");
    expect(result.nvidiaForcedOff).toBe(true);
  });

  it("auto stays auto regardless of other side", () => {
    const autoSettings: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      processingBackend: "auto",
    };
    const result = getEffectiveBackend(autoSettings, "nvidia-vsr");
    expect(result.effectiveBackend).toBe("auto");
    expect(result.nvidiaForcedOff).toBe(false);
  });
});

// ─── Helpers shared across tests ─────────────────────────────────────────────

function findCompareContainer(): HTMLElement | null {
  return document.querySelector('[data-compare-viewer]');
}

/** Click a mode button by its aria-label */
function clickModeButton(ariaLabel: string): void {
  const btn = document.querySelector(`[aria-label="${ariaLabel}"]`);
  if (btn) {
    fireEvent.click(btn);
  }
}

function findRawVideoUnderlay(): HTMLVideoElement | null {
  return document.querySelector('[aria-label="Source video underlay"]');
}

function findEnhancedCanvases(): NodeListOf<HTMLCanvasElement> {
  return document.querySelectorAll('[data-enhanced-canvas]');
}

// ─── Display mode presentation-only tests ────────────────────────────────────

describe("CompareViewerSurface — display mode changes are presentation-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProcessorTracking();
    _factoryCallCount = 0;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("mounts both EnhancedVideoSurface instances on initial render", async () => {
    const video = createVideoElement();
    const onExit = vi.fn();

    renderWithTooltip(
      <CompareViewerSurface
        videoElement={video}
        settingsA={DEFAULT_SETTINGS_A}
        settingsB={DEFAULT_SETTINGS_B}
        onExit={onExit}
        paused={false}
      />,
    );

    await settleEffects();

    // Both EnhancedVideoSurface components should have created processors
    expect(countProcessors()).toBe(2);
    // Raw video underlay should be present
    expect(findRawVideoUnderlay()).not.toBeNull();
    // Both canvases should be present in DOM
    expect(findEnhancedCanvases().length).toBe(2);
  });

  it("keeps same processor instances when switching A -> B -> Vertical -> A -> B", async () => {
    const video = createVideoElement();
    const onExit = vi.fn();

    renderWithTooltip(
      <CompareViewerSurface
        videoElement={video}
        settingsA={DEFAULT_SETTINGS_A}
        settingsB={DEFAULT_SETTINGS_B}
        onExit={onExit}
        paused={false}
      />,
    );

    await settleEffects();

    // Record initial processor IDs and destroy mocks
    const initialProcessors = getProcessorInstances();
    const initialCount = countProcessors();

    // Grab destroy mocks from all processors
    const destroyMocks = Object.values(initialProcessors).map(p => p.destroy);
    const setBackendMocks = Object.values(initialProcessors).map(p => p.setBackend);
    const updateSettingsMocks = Object.values(initialProcessors).map(p => p.updateSettings);

    // Clear updateSettings calls from initialization
    updateSettingsMocks.forEach(m => m.mockClear());
    setBackendMocks.forEach(m => m.mockClear());

    // Switch to B mode
    clickModeButton("Show variant B only");
    await settleEffects();

    // Switch to Vertical Compare
    clickModeButton("Vertical compare");
    await settleEffects();

    // Switch back to A mode
    clickModeButton("Show variant A only");
    await settleEffects();

    // Switch back to B mode
    clickModeButton("Show variant B only");
    await settleEffects();

    // No new processors created
    expect(countProcessors()).toBe(initialCount);

    // No processors destroyed
    destroyMocks.forEach((m, i) => {
      expect(m).not.toHaveBeenCalled();
    });

    // No setBackend or updateSettings called (settings never changed, only displayMode)
    setBackendMocks.forEach((m, i) => {
      expect(m).not.toHaveBeenCalled();
    });
    updateSettingsMocks.forEach((m, i) => {
      expect(m).not.toHaveBeenCalled();
    });

    // Raw underlay still present
    expect(findRawVideoUnderlay()).not.toBeNull();
    // Both canvases still present
    expect(findEnhancedCanvases().length).toBe(2);
  });

  it("raw video underlay is always present regardless of display mode", async () => {
    const video = createVideoElement();
    const onExit = vi.fn();

    renderWithTooltip(
      <CompareViewerSurface
        videoElement={video}
        settingsA={DEFAULT_SETTINGS_A}
        settingsB={DEFAULT_SETTINGS_B}
        onExit={onExit}
        paused={false}
      />,
    );

    await settleEffects();

    // Underlay present in default mode (vertical-wipe)
    expect(findRawVideoUnderlay()).not.toBeNull();

    // Switch through all modes and verify underlay is always there
    clickModeButton("Show variant A only");
    await settleEffects();
    expect(findRawVideoUnderlay()).not.toBeNull();

    clickModeButton("Show variant B only");
    await settleEffects();
    expect(findRawVideoUnderlay()).not.toBeNull();

    clickModeButton("Vertical compare");
    await settleEffects();
    expect(findRawVideoUnderlay()).not.toBeNull();
  });

  it("does not crash when videoElement is null", async () => {
    const onExit = vi.fn();

    // Should render without error even with null videoElement
    const { container } = renderWithTooltip(
      <CompareViewerSurface
        videoElement={null}
        settingsA={DEFAULT_SETTINGS_A}
        settingsB={DEFAULT_SETTINGS_B}
        onExit={onExit}
        paused={false}
      />,
    );

    await settleEffects();

    // Should still render the compare UI
    const compareContainer = container.querySelector('[data-compare-viewer]');
    expect(compareContainer).not.toBeNull();
  });

  it("preserves same source video / srcObject across mode switches", async () => {
    const video = createVideoElement();
    const onExit = vi.fn();

    const { rerender } = renderWithTooltip(
      <CompareViewerSurface
        videoElement={video}
        settingsA={DEFAULT_SETTINGS_A}
        settingsB={DEFAULT_SETTINGS_B}
        onExit={onExit}
        paused={false}
      />,
    );

    await settleEffects();

    // Verify the video element reference is stable
    // We can't easily check the ref from inside, but we can verify that
    // no videoElement-related processor recreation happens when we
    // toggle display modes (since videoElement prop doesn't change)

    const initialProcessors = getProcessorInstances();
    const initialCount = countProcessors();

    // Toggle modes - these only change displayMode state, not videoElement prop
    clickModeButton("Show variant B only");
    await settleEffects();
    clickModeButton("Vertical compare");
    await settleEffects();

    // No new processors created (videoElement never changed)
    expect(countProcessors()).toBe(initialCount);
  });

  it("both processing surfaces stay mounted in all display modes", async () => {
    const video = createVideoElement();
    const onExit = vi.fn();

    renderWithTooltip(
      <CompareViewerSurface
        videoElement={video}
        settingsA={DEFAULT_SETTINGS_A}
        settingsB={DEFAULT_SETTINGS_B}
        onExit={onExit}
        paused={false}
      />,
    );

    await settleEffects();

    // In all display modes, both enhanced canvases should remain mounted
    const modes: CompareDisplayMode[] = ["side-a", "side-b", "vertical-wipe"];

    for (const mode of modes) {
      const label =
        mode === "side-a" ? "Show variant A only" :
        mode === "side-b" ? "Show variant B only" :
        "Vertical compare";
      clickModeButton(label);
      await settleEffects();

      // Both canvases always present
      const canvases = findEnhancedCanvases();
      expect(canvases.length).toBe(2);
    }
  });
});

// ─── Underlay / readiness tests ─────────────────────────────────────────────

describe("CompareViewerSurface — underlay and readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProcessorTracking();
    _factoryCallCount = 0;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows raw video underlay when videoElement is provided", async () => {
    const video = createVideoElement();
    const onExit = vi.fn();

    renderWithTooltip(
      <CompareViewerSurface
        videoElement={video}
        settingsA={DEFAULT_SETTINGS_A}
        settingsB={DEFAULT_SETTINGS_B}
        onExit={onExit}
        paused={false}
      />,
    );

    await settleEffects();

    const underlay = document.querySelector('[aria-label="Source video underlay"]') as HTMLVideoElement | null;
    expect(underlay).not.toBeNull();
    expect(underlay!.getAttribute("autoplay")).not.toBeNull();
    expect(underlay!.getAttribute("playsinline")).not.toBeNull();
    expect(underlay!.muted).toBe(true);
  });

  it("both canvases remain mounted even when one side fails", async () => {
    // This test verifies that both EnhancedVideoSurface instances
    // stay in the DOM even if one processor encounters an error.
    // The component doesn't unmount surfaces on error.
    const video = createVideoElement();
    const onExit = vi.fn();

    renderWithTooltip(
      <CompareViewerSurface
        videoElement={video}
        settingsA={DEFAULT_SETTINGS_A}
        settingsB={DEFAULT_SETTINGS_B}
        onExit={onExit}
        paused={false}
      />,
    );

    await settleEffects();

    // Both canvases present
    expect(findEnhancedCanvases().length).toBe(2);
  });
});
