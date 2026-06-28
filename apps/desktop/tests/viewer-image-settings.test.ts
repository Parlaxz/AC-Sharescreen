// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
  IMAGE_ENHANCEMENT_CONTROL_RANGE,
} from "@/services/viewer-image-processing/viewer-image-defaults";
import {
  ViewerImageEnhancementSettings,
  clampValue,
  validateSettings,
  loadImageEnhancementSettings,
  saveImageEnhancementSettings,
  resetImageEnhancementSettings,
  SCALING_ALGORITHMS,
  SCALING_ALGORITHM_LABELS,
  OVERSHOOTING_ALGORITHMS,
  type ScalingAlgorithm,
} from "@/services/viewer-image-processing/viewer-image-settings";

describe("scaling algorithm enums", () => {
  it("includes all expected algorithms", () => {
    expect(SCALING_ALGORITHMS).toEqual([
      "native",
      "bicubic",
      "fsr1-easu",
    ]);
  });

  it("every algorithm has a label", () => {
    expect(SCALING_ALGORITHM_LABELS["native"]).toBe("Native");
    expect(SCALING_ALGORITHM_LABELS["bicubic"]).toBe("Bicubic");
    expect(SCALING_ALGORITHM_LABELS["fsr1-easu"]).toBe("FSR 1 EASU");
  });

  it("overshooting algorithms include bicubic and fsr1-easu", () => {
    expect(OVERSHOOTING_ALGORITHMS.has("bicubic")).toBe(true);
    expect(OVERSHOOTING_ALGORITHMS.has("fsr1-easu")).toBe(true);
    expect(OVERSHOOTING_ALGORITHMS.has("native")).toBe(false);
  });
});

describe("viewer-image-defaults", () => {
  it("all default values are within valid range", () => {
    const d = VIEWER_IMAGE_ENHANCEMENT_DEFAULTS;
    expect(d.enabled).toBe(false);
    expect(d.scalingAlgorithm).toBe("native");
    for (const key of ["sharpeningStrength", "noiseProtection", "compressionCleanup", "debanding", "fsrBicubicBlend"]) {
      const v = d[key as keyof ViewerImageEnhancementSettings] as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("defaults match specification values", () => {
    const d = VIEWER_IMAGE_ENHANCEMENT_DEFAULTS;
    expect(d.sharpeningStrength).toBeCloseTo(0.14);
    expect(d.noiseProtection).toBeCloseTo(0.85);
    expect(d.compressionCleanup).toBeCloseTo(0.20);
    expect(d.debanding).toBeCloseTo(0.10);
    expect(d.fsrBicubicBlend).toBeCloseTo(0.70);
  });

  it("control range has correct bounds", () => {
    expect(IMAGE_ENHANCEMENT_CONTROL_RANGE.min).toBe(0);
    expect(IMAGE_ENHANCEMENT_CONTROL_RANGE.max).toBe(1);
    expect(IMAGE_ENHANCEMENT_CONTROL_RANGE.step).toBe(0.01);
  });
});

describe("clampValue", () => {
  it("passes values within range unchanged", () => {
    expect(clampValue(0.5, 0, 1)).toBe(0.5);
    expect(clampValue(0, 0, 1)).toBe(0);
    expect(clampValue(1, 0, 1)).toBe(1);
  });

  it("clamps values outside range", () => {
    expect(clampValue(1.5, 0, 1)).toBe(1);
    expect(clampValue(-0.5, 0, 1)).toBe(0);
    expect(clampValue(100, 0, 1)).toBe(1);
  });

  it("handles NaN and Infinity by returning fallback", () => {
    expect(clampValue(NaN, 0, 1, 0.5)).toBe(0.5);
    expect(clampValue(Infinity, 0, 1, 0)).toBe(0);
    expect(clampValue(-Infinity, 0, 1, 0)).toBe(0);
  });

  it("defaults fallback to min when not provided", () => {
    expect(clampValue(NaN, 0, 1)).toBe(0);
    expect(clampValue(Infinity, 10, 20)).toBe(10);
  });
});

describe("validateSettings", () => {
  it("returns defaults when input is null or non-object", () => {
    expect(validateSettings(null)).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    expect(validateSettings(undefined)).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    expect(validateSettings("string")).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    expect(validateSettings(42)).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    expect(validateSettings([])).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
  });

  it("fills missing keys from defaults", () => {
    const result = validateSettings({ enabled: true });
    expect(result.enabled).toBe(true);
    expect(result.scalingAlgorithm).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.scalingAlgorithm);
    expect(result.sharpeningStrength).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.sharpeningStrength);
  });

  it("clamps out-of-range numeric values", () => {
    const result = validateSettings({ sharpeningStrength: 1.5, noiseProtection: -0.5 });
    expect(result.sharpeningStrength).toBe(1);
    expect(result.noiseProtection).toBe(0);
  });

  it("replaces NaN/Infinity numeric values with defaults", () => {
    const result = validateSettings({ sharpeningStrength: NaN, noiseProtection: Infinity });
    expect(result.sharpeningStrength).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.sharpeningStrength);
    expect(result.noiseProtection).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.noiseProtection);
  });

  it("replaces non-numeric values with defaults", () => {
    const result = validateSettings({ sharpeningStrength: "0.5", noiseProtection: true });
    expect(result.sharpeningStrength).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.sharpeningStrength);
    expect(result.noiseProtection).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.noiseProtection);
  });

  it("replaces non-boolean boolean keys with defaults", () => {
    const result = validateSettings({ enabled: "yes" });
    expect(result.enabled).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.enabled);
  });

  it("accepts valid scalingAlgorithm values", () => {
    for (const algo of SCALING_ALGORITHMS) {
      const result = validateSettings({ scalingAlgorithm: algo });
      expect(result.scalingAlgorithm).toBe(algo);
    }
  });

  it("rejects invalid scalingAlgorithm, defaults to native", () => {
    const result = validateSettings({ scalingAlgorithm: "magic" });
    expect(result.scalingAlgorithm).toBe("native");
  });

  it("migrates legacy enhancedScaling=true to fsr1-easu", () => {
    const result = validateSettings({ enhancedScaling: true });
    expect(result.scalingAlgorithm).toBe("fsr1-easu");
  });

  it("migrates legacy enhancedScaling=false to native", () => {
    const result = validateSettings({ enhancedScaling: false });
    expect(result.scalingAlgorithm).toBe("native");
  });

  it("scalingAlgorithm takes priority over legacy enhancedScaling", () => {
    const result = validateSettings({ enhancedScaling: true, scalingAlgorithm: "bicubic" });
    expect(result.scalingAlgorithm).toBe("bicubic");
  });

  it("accepts valid complete settings with new fields", () => {
    const valid: ViewerImageEnhancementSettings = {
      enabled: true,
      scalingAlgorithm: "bicubic",
      sharpeningStrength: 0.5,
      noiseProtection: 0.3,
      compressionCleanup: 0.6,
      debanding: 0.1,
      fsrBicubicBlend: 0.4,
    };
    expect(validateSettings(valid)).toEqual(valid);
  });

  it("does not auto-migrate old deblocking field", () => {
    const result = validateSettings({ deblocking: 0.5, scalingAlgorithm: "native" });
    expect(result.compressionCleanup).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.compressionCleanup);
  });

  it("migrates old textureNoiseSharpening to noiseProtection with inversion", () => {
    const result = validateSettings({ textureNoiseSharpening: 0.3 });
    // 1 - 0.3 = 0.7
    expect(result.noiseProtection).toBeCloseTo(0.7);
  });

  it("migrates old chromaCleanup/compressionSmoothing to compressionCleanup", () => {
    const result = validateSettings({ chromaCleanup: 0.5, compressionSmoothing: 0.3 });
    // Max of 0.5 and 0.3 = 0.5
    expect(result.compressionCleanup).toBeCloseTo(0.5);
  });

  it("handles both old fields migrated together", () => {
    const result = validateSettings({
      textureNoiseSharpening: 0.2,
      chromaCleanup: 0.4,
      compressionSmoothing: 0.6,
    });
    expect(result.noiseProtection).toBeCloseTo(0.8); // 1 - 0.2
    expect(result.compressionCleanup).toBeCloseTo(0.6); // max(0.4, 0.6)
  });
});

describe("localStorage persistence", () => {
  // Mock store backing
  const store: Record<string, string> = {};

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (index: number) => Object.keys(store)[index] ?? null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loadImageEnhancementSettings returns defaults when nothing stored", () => {
    const result = loadImageEnhancementSettings();
    expect(result).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
  });

  it("loadImageEnhancementSettings returns stored valid settings", () => {
    const settings: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      enabled: true,
      scalingAlgorithm: "bicubic",
      sharpeningStrength: 0.42,
    };
    saveImageEnhancementSettings(settings);
    const loaded = loadImageEnhancementSettings();
    expect(loaded.enabled).toBe(true);
    expect(loaded.sharpeningStrength).toBe(0.42);
    expect(loaded.scalingAlgorithm).toBe("bicubic");
  });

  it("loadImageEnhancementSettings returns defaults when stored data is corrupt", () => {
    store["screenlink:viewer-image-enhancement"] = "not-json";
    const result = loadImageEnhancementSettings();
    expect(result).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
  });

  it("loadImageEnhancementSettings clamps out-of-range stored values", () => {
    store["screenlink:viewer-image-enhancement"] = JSON.stringify({ sharpeningStrength: 99 });
    const result = loadImageEnhancementSettings();
    expect(result.sharpeningStrength).toBe(1);
  });

  it("resetImageEnhancementSettings restores defaults and persists them", () => {
    store["screenlink:viewer-image-enhancement"] = JSON.stringify({
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      enabled: true,
    });
    const reset = resetImageEnhancementSettings();
    expect(reset).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const loaded = loadImageEnhancementSettings();
    expect(loaded).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
  });

  it("saveImageEnhancementSettings handles malformed values safely", () => {
    store["screenlink:viewer-image-enhancement"] = "{invalid";
    const result = loadImageEnhancementSettings();
    expect(result).toEqual(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
  });

  it("load handles NaN in stored JSON", () => {
    store["screenlink:viewer-image-enhancement"] = JSON.stringify({ sharpeningStrength: "NaN" });
    const result = loadImageEnhancementSettings();
    expect(result.sharpeningStrength).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.sharpeningStrength);
  });

  it("load migrates stored legacy enhancedScaling=true", () => {
    store["screenlink:viewer-image-enhancement"] = JSON.stringify({
      enabled: true,
      enhancedScaling: true,
      sharpeningStrength: 0.5,
    });
    const result = loadImageEnhancementSettings();
    expect(result.scalingAlgorithm).toBe("fsr1-easu");
    expect(result.enabled).toBe(true);
    expect(result.sharpeningStrength).toBe(0.5);
  });
});
