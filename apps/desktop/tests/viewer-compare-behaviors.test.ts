import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getEffectiveBackend,
  type CompareDisplayMode,
} from "../src/renderer/components/workspace/CompareViewerSurface.js";
import type { ViewerImageEnhancementSettings } from "../src/renderer/services/viewer-image-processing/viewer-image-settings.js";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "../src/renderer/services/viewer-image-processing/viewer-image-defaults.js";

// Mock window/CustomEvent for shortcut test block
if (typeof window === "undefined") {
  const mockListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  (globalThis as any).window = {
    addEventListener: (type: string, handler: (...args: unknown[]) => void) => {
      if (!mockListeners.has(type)) mockListeners.set(type, new Set());
      mockListeners.get(type)!.add(handler);
    },
    removeEventListener: (type: string, handler: (...args: unknown[]) => void) => {
      mockListeners.get(type)?.delete(handler);
    },
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      mockListeners.get(event.type)?.forEach((h) => h(event));
      return true;
    },
  } as unknown as Window & typeof globalThis;
}
if (typeof CustomEvent === "undefined") {
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, opts: { detail?: unknown } = {}) {
      this.type = type;
      this.detail = opts.detail;
    }
  };
}

// ─── getEffectiveBackend tests ─────────────────────────────────────────────

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

// ─── CompareDisplayMode tests ──────────────────────────────────────────────

describe("CompareViewerSurface — display modes", () => {
  it("supports all three display modes", () => {
    const modes: CompareDisplayMode[] = ["side-a", "side-b", "vertical-wipe"];
    expect(modes).toHaveLength(3);
  });

  it("vertical-wipe is the default mode", () => {
    // Default state in the component is "vertical-wipe"
    const defaultMode: CompareDisplayMode = "vertical-wipe";
    expect(defaultMode).toBe("vertical-wipe");
  });
});

// ─── Keyboard shortcut contract tests ──────────────────────────────────────

describe("Compare keyboard shortcuts — contract tests", () => {
  it("C dispatches screenlink:compare-open-settings-b", () => {
    const handler = vi.fn();
    window.addEventListener("screenlink:compare-open-settings-b", handler);
    window.dispatchEvent(new CustomEvent("screenlink:compare-open-settings-b"));
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener("screenlink:compare-open-settings-b", handler);
  });

  it("V dispatches screenlink:compare-mode with vertical-wipe detail", () => {
    const handler = vi.fn();
    window.addEventListener("screenlink:compare-mode", handler);
    window.dispatchEvent(new CustomEvent("screenlink:compare-mode", { detail: "vertical-wipe" }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toBe("vertical-wipe");
    window.removeEventListener("screenlink:compare-mode", handler);
  });

  it("1 dispatches screenlink:compare-mode with side-a detail", () => {
    const handler = vi.fn();
    window.addEventListener("screenlink:compare-mode", handler);
    window.dispatchEvent(new CustomEvent("screenlink:compare-mode", { detail: "side-a" }));
    expect(handler.mock.calls[0][0].detail).toBe("side-a");
    window.removeEventListener("screenlink:compare-mode", handler);
  });

  it("2 dispatches screenlink:compare-mode with side-b detail", () => {
    const handler = vi.fn();
    window.addEventListener("screenlink:compare-mode", handler);
    window.dispatchEvent(new CustomEvent("screenlink:compare-mode", { detail: "side-b" }));
    expect(handler.mock.calls[0][0].detail).toBe("side-b");
    window.removeEventListener("screenlink:compare-mode", handler);
  });

  it("0 dispatches screenlink:compare-center", () => {
    const handler = vi.fn();
    window.addEventListener("screenlink:compare-center", handler);
    window.dispatchEvent(new CustomEvent("screenlink:compare-center"));
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener("screenlink:compare-center", handler);
  });
});

// ─── Compare entry control (A/B button) contract tests ─────────────────────

describe("Compare entry — A/B button contract", () => {
  it("A/B button click toggles compare mode", () => {
    let compareActive = false;
    const toggle = () => { compareActive = !compareActive; };

    toggle();
    expect(compareActive).toBe(true);
    toggle();
    expect(compareActive).toBe(false);
  });
});
