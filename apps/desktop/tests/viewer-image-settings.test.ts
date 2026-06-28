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
  FSR_TARGET_SCALES,
  FSR_TARGET_SCALE_LABELS,
  FSR_FINAL_SCALERS,
  FSR_FINAL_SCALER_LABELS,
  parseFsrTargetScale,
  computeEasuTarget,
  type ScalingAlgorithm,
  type FsrFinalScaler,
} from "@/services/viewer-image-processing/viewer-image-settings";

describe("scaling algorithm enums", () => {
  it("includes all expected algorithms", () => {
    expect(SCALING_ALGORITHMS).toEqual([
      "native",
      "bicubic",
      "lanczos",
      "fsr1-easu",
    ]);
  });

  it("every algorithm has a label", () => {
    expect(SCALING_ALGORITHM_LABELS["native"]).toBe("Native / Bilinear");
    expect(SCALING_ALGORITHM_LABELS["bicubic"]).toBe("Bicubic");
    expect(SCALING_ALGORITHM_LABELS["lanczos"]).toBe("Lanczos 3");
    expect(SCALING_ALGORITHM_LABELS["fsr1-easu"]).toBe("FSR 1");
  });

  it("overshooting algorithms include bicubic, lanczos, and fsr1-easu", () => {
    expect(OVERSHOOTING_ALGORITHMS.has("bicubic")).toBe(true);
    expect(OVERSHOOTING_ALGORITHMS.has("lanczos")).toBe(true);
    expect(OVERSHOOTING_ALGORITHMS.has("fsr1-easu")).toBe(true);
    expect(OVERSHOOTING_ALGORITHMS.has("native")).toBe(false);
  });
});

describe("FSR target scale enums", () => {
  it("includes all expected scales", () => {
    expect(FSR_TARGET_SCALES).toEqual([
      "auto",
      1.25,
      1.5,
      1.75,
      2,
      "display",
    ]);
  });

  it("every scale has a label", () => {
    expect(FSR_TARGET_SCALE_LABELS["auto"]).toBe("Auto");
    expect(FSR_TARGET_SCALE_LABELS["1.25"]).toBe("1.25×");
    expect(FSR_TARGET_SCALE_LABELS["1.5"]).toBe("1.5×");
    expect(FSR_TARGET_SCALE_LABELS["1.75"]).toBe("1.75×");
    expect(FSR_TARGET_SCALE_LABELS["2"]).toBe("2.00×");
    expect(FSR_TARGET_SCALE_LABELS["display"]).toBe("Display Resolution");
  });
});

describe("FSR final scaler enums", () => {
  it("includes all expected scalers", () => {
    expect(FSR_FINAL_SCALERS).toEqual([
      "bicubic",
      "lanczos",
    ]);
  });

  it("every final scaler has a label", () => {
    expect(FSR_FINAL_SCALER_LABELS["bicubic"]).toBe("Bicubic");
    expect(FSR_FINAL_SCALER_LABELS["lanczos"]).toBe("Lanczos 3");
  });
});

describe("parseFsrTargetScale", () => {
  it("parses 'auto' and 'display' as-is", () => {
    expect(parseFsrTargetScale("auto")).toBe("auto");
    expect(parseFsrTargetScale("display")).toBe("display");
  });

  it("parses numeric string values to numbers", () => {
    expect(parseFsrTargetScale("1.25")).toBe(1.25);
    expect(parseFsrTargetScale("1.5")).toBe(1.5);
    expect(parseFsrTargetScale("1.75")).toBe(1.75);
    expect(parseFsrTargetScale("2")).toBe(2);
  });

  it("returns 'auto' for invalid string values", () => {
    expect(parseFsrTargetScale("3.0")).toBe("auto");
    expect(parseFsrTargetScale("0.5")).toBe("auto");
    expect(parseFsrTargetScale("abc")).toBe("auto");
    expect(parseFsrTargetScale("")).toBe("auto");
  });
});

describe("viewer-image-defaults", () => {
  it("all default values are within valid range", () => {
    const d = VIEWER_IMAGE_ENHANCEMENT_DEFAULTS;
    expect(d.enabled).toBe(false);
    expect(d.scalingAlgorithm).toBe("native");
    for (const key of ["sharpeningStrength", "noiseProtection", "compressionCleanup", "debanding"]) {
      const v = d[key as keyof ViewerImageEnhancementSettings] as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("defaults match specification values (schema v3)", () => {
    const d = VIEWER_IMAGE_ENHANCEMENT_DEFAULTS;
    expect(d.sharpeningStrength).toBeCloseTo(0.25);
    expect(d.noiseProtection).toBeCloseTo(0.00);
    expect(d.compressionCleanup).toBeCloseTo(0.00);
    expect(d.debanding).toBeCloseTo(0.00);
    expect(d.fsrTargetScale).toBe("auto");
    expect(d.fsrFinalScaler).toBe("bicubic");
    expect(d._schemaVersion).toBe(3);
  });

  it("does not include fsrBicubicBlend", () => {
    const d = VIEWER_IMAGE_ENHANCEMENT_DEFAULTS as Record<string, unknown>;
    expect(d.fsrBicubicBlend).toBeUndefined();
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

  it("accepts valid complete settings with new fields (no fsrBicubicBlend)", () => {
    const valid: ViewerImageEnhancementSettings = {
      enabled: true,
      scalingAlgorithm: "bicubic",
      fsrTargetScale: "auto",
      fsrFinalScaler: "bicubic",
      sharpeningStrength: 0.5,
      noiseProtection: 0.3,
      compressionCleanup: 0.6,
      debanding: 0.1,
      _schemaVersion: 3,
    };
    expect(validateSettings(valid)).toEqual(valid);
  });

  it("does not auto-migrate old deblocking field", () => {
    const result = validateSettings({ deblocking: 0.5, scalingAlgorithm: "native" });
    expect(result.compressionCleanup).toBe(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS.compressionCleanup);
  });

  it("migrates old textureNoiseSharpening to noiseProtection with inversion (but v2 migration zeros optional effects)", () => {
    const result = validateSettings({ textureNoiseSharpening: 0.3 });
    // 1 - 0.3 = 0.7, but then v2 migration forces optional effects to 0
    expect(result.noiseProtection).toBeCloseTo(0.0);
    expect(result._schemaVersion).toBe(3);
  });

  it("migrates old chromaCleanup/compressionSmoothing to compressionCleanup (but v2 migration zeros optional effects)", () => {
    const result = validateSettings({ chromaCleanup: 0.5, compressionSmoothing: 0.3 });
    // Max of 0.5 and 0.3 = 0.5, but v2 migration forces to 0
    expect(result.compressionCleanup).toBeCloseTo(0.0);
    expect(result._schemaVersion).toBe(3);
  });

  it("handles both old fields migrated together (but v2 migration zeros optional effects)", () => {
    const result = validateSettings({
      textureNoiseSharpening: 0.2,
      chromaCleanup: 0.4,
      compressionSmoothing: 0.6,
    });
    expect(result.noiseProtection).toBeCloseTo(0.0);
    expect(result.compressionCleanup).toBeCloseTo(0.0);
    expect(result._schemaVersion).toBe(3);
  });

  // ─── fsrTargetScale validation ─────────────────────────────────────────

  it("accepts all valid fsrTargetScale values", () => {
    for (const scale of FSR_TARGET_SCALES) {
      // Use _schemaVersion: 2 to avoid v1 migration overwriting fsrTargetScale
      const result = validateSettings({ fsrTargetScale: scale, _schemaVersion: 2 });
      expect(result.fsrTargetScale).toBe(scale);
    }
  });

  it("rejects invalid fsrTargetScale, defaults to auto", () => {
    const result = validateSettings({ fsrTargetScale: "magic" });
    expect(result.fsrTargetScale).toBe("auto");
  });

  // ─── Old schema migration (v1 → v2) ───────────────────────────────────

  it("old schema (no _schemaVersion) forces optional effects to zero", () => {
    const result = validateSettings({
      sharpeningStrength: 0.20,
      noiseProtection: 0.85,
      compressionCleanup: 0.20,
      debanding: 0.10,
      scalingAlgorithm: "fsr1-easu",
    });
    expect(result.noiseProtection).toBeCloseTo(0.00);
    expect(result.compressionCleanup).toBeCloseTo(0.00);
    expect(result.debanding).toBeCloseTo(0.00);
    expect(result.scalingAlgorithm).toBe("fsr1-easu");
    expect(result.sharpeningStrength).toBeCloseTo(0.20);
    expect(result.fsrTargetScale).toBe("auto");
    expect(result.fsrFinalScaler).toBe("bicubic");
    expect(result._schemaVersion).toBe(3);
  });

  it("_schemaVersion=1 forces optional effects to zero", () => {
    const result = validateSettings({
      _schemaVersion: 1,
      sharpeningStrength: 0.20,
      noiseProtection: 0.85,
      compressionCleanup: 0.20,
      debanding: 0.10,
      scalingAlgorithm: "bicubic",
    });
    expect(result.noiseProtection).toBeCloseTo(0.00);
    expect(result.compressionCleanup).toBeCloseTo(0.00);
    expect(result.debanding).toBeCloseTo(0.00);
    expect(result.scalingAlgorithm).toBe("bicubic");
    expect(result.sharpeningStrength).toBeCloseTo(0.20);
    expect(result._schemaVersion).toBe(3);
  });

  it("new schema (v2) preserves user values, migrates to v3", () => {
    const result = validateSettings({
      _schemaVersion: 2,
      noiseProtection: 0.85,
      compressionCleanup: 0.20,
      debanding: 0.10,
      sharpeningStrength: 0.20,
      scalingAlgorithm: "fsr1-easu",
      fsrTargetScale: "auto",
    });
    expect(result.noiseProtection).toBeCloseTo(0.85);
    expect(result.compressionCleanup).toBeCloseTo(0.20);
    expect(result.debanding).toBeCloseTo(0.10);
    expect(result.sharpeningStrength).toBeCloseTo(0.20);
    expect(result.scalingAlgorithm).toBe("fsr1-easu");
    expect(result.fsrTargetScale).toBe("auto");
    expect(result.fsrFinalScaler).toBe("bicubic");
    expect(result._schemaVersion).toBe(3);
  });

  it("fsrBicubicBlend is deleted on input", () => {
    const result = validateSettings({
      fsrBicubicBlend: 0.70,
      scalingAlgorithm: "fsr1-easu",
    });
    expect((result as Record<string, unknown>).fsrBicubicBlend).toBeUndefined();
  });

  it("fsrBicubicBlend is not in validated output for new schema", () => {
    const result = validateSettings({
      _schemaVersion: 2,
      fsrBicubicBlend: 0.70,
      scalingAlgorithm: "native",
    });
    expect((result as Record<string, unknown>).fsrBicubicBlend).toBeUndefined();
  });

  // ─── fsrFinalScaler validation ─────────────────────────────────────

  it("accepts valid fsrFinalScaler values", () => {
    for (const scaler of FSR_FINAL_SCALERS) {
      const result = validateSettings({ fsrFinalScaler: scaler, _schemaVersion: 3 });
      expect(result.fsrFinalScaler).toBe(scaler);
    }
  });

  it("rejects invalid fsrFinalScaler, defaults to bicubic", () => {
    const result = validateSettings({ fsrFinalScaler: "magic" });
    expect(result.fsrFinalScaler).toBe("bicubic");
  });

  it("defaults fsrFinalScaler to bicubic when missing", () => {
    const result = validateSettings({ scalingAlgorithm: "fsr1-easu" });
    expect(result.fsrFinalScaler).toBe("bicubic");
  });

  // ─── Schema v3 migration ───────────────────────────────────────────

  it("schema v2 → v3 adds fsrFinalScaler default", () => {
    const result = validateSettings({ _schemaVersion: 2, scalingAlgorithm: "fsr1-easu" });
    expect(result.fsrFinalScaler).toBe("bicubic");
    expect(result._schemaVersion).toBe(3);
  });

  it("schema v2 → v3 preserves explicit fsrFinalScaler", () => {
    const result = validateSettings({ _schemaVersion: 2, fsrFinalScaler: "lanczos" });
    expect(result.fsrFinalScaler).toBe("lanczos");
    expect(result._schemaVersion).toBe(3);
  });

  // ─── Numeric target scale persistence ──────────────────────────────

  it("numeric target values persist and reload correctly", () => {
    // Simulate saving with a numeric string from HTML select
    const saved: Record<string, unknown> = {
      enabled: true,
      scalingAlgorithm: "fsr1-easu",
      fsrTargetScale: "1.5",  // stringified by JSON, or from localStorage
      sharpeningStrength: 0.5,
      noiseProtection: 0,
      compressionCleanup: 0,
      debanding: 0,
      _schemaVersion: 3,
    };
    // When loaded and validated, the string "1.5" should become number 1.5
    const result = validateSettings(saved);
    expect(result.fsrTargetScale).toBe(1.5);
  });

  it("auto resolves to display directly when scale <= 2×", () => {
    const result = computeEasuTarget(960, 540, 1920, 1080, "auto");
    expect(result.easuW).toBe(1920);
    expect(result.easuH).toBe(1080);
    expect(result.needsFinalScaler).toBe(false);
  });

  it("auto resolves to 2× source when scale > 2×", () => {
    const result = computeEasuTarget(640, 360, 2560, 1440, "auto");
    // 640*2=1280, 360*2=720 — display is 2560×1440 so final scaler needed
    expect(result.easuW).toBe(1280);
    expect(result.easuH).toBe(720);
    expect(result.needsFinalScaler).toBe(true);
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

describe("computeEasuTarget", () => {
  // 720p (1280×720) → 1080p (1920×1080)
  it("720p → 1080p with auto: fits in display, no final scaler needed", () => {
    const result = computeEasuTarget(1280, 720, 1920, 1080, "auto");
    // 1280*2=2560 > 1920 → cap to 1920; 720*2=1440 > 1080 → cap to 1080
    // So EASU goes all the way to 1920x1080
    // Display scale: max(1920/1280, 1080/720) = max(1.5, 1.5) = 1.5
    expect(result.easuW).toBe(1920);
    expect(result.easuH).toBe(1080);
    expect(result.needsFinalScaler).toBe(false);
    expect(result.targetScale).toBe("auto");
    expect(result.scaleValue).toBe(1.5);
  });

  // 540p (960×540) → 1080p (1920×1080)
  it("540p → 1080p with auto: 2× fits exactly on height", () => {
    const result = computeEasuTarget(960, 540, 1920, 1080, "auto");
    // 960*2=1920 <= 1920; 540*2=1080 <= 1080
    expect(result.easuW).toBe(1920);
    expect(result.easuH).toBe(1080);
    expect(result.needsFinalScaler).toBe(false);
  });

  // 360p (640×360) → 1080p (1920×1080)
  it("360p → 1080p with auto: 2× does not reach display, final scaler needed", () => {
    const result = computeEasuTarget(640, 360, 1920, 1080, "auto");
    // 640*2=1280, 360*2=720
    expect(result.easuW).toBe(1280);
    expect(result.easuH).toBe(720);
    expect(result.needsFinalScaler).toBe(true);
    expect(result.scaleValue).toBe(2);
  });

  // 240p (426×240) → 1080p (1920×1080)
  it("240p → 1080p with auto: 2× still small, final scaler needed", () => {
    const result = computeEasuTarget(426, 240, 1920, 1080, "auto");
    // 426*2=852, 240*2=480
    expect(result.easuW).toBe(852);
    expect(result.easuH).toBe(480);
    expect(result.needsFinalScaler).toBe(true);
  });

  // 1080p → 1080p (no upscale needed)
  it("1080p → 1080p with auto: no upscale needed", () => {
    const result = computeEasuTarget(1920, 1080, 1920, 1080, "auto");
    // 1920*2=3840 > 1920 → cap; 1080*2=2160 > 1080 → cap
    expect(result.easuW).toBe(1920);
    expect(result.easuH).toBe(1080);
    expect(result.needsFinalScaler).toBe(false);
  });

  // 360p → 1080p with 2.00×
  it("360p → 1080p with 2.00×: same as auto max", () => {
    const result = computeEasuTarget(640, 360, 1920, 1080, 2);
    expect(result.easuW).toBe(1280);
    expect(result.easuH).toBe(720);
    expect(result.needsFinalScaler).toBe(true);
    expect(result.targetScale).toBe(2);
  });

  // 360p → 1080p with 1.5×
  it("360p → 1080p with 1.5×: smaller intermediate", () => {
    const result = computeEasuTarget(640, 360, 1920, 1080, 1.5);
    // 640*1.5=960, 360*1.5=540
    expect(result.easuW).toBe(960);
    expect(result.easuH).toBe(540);
    expect(result.needsFinalScaler).toBe(true);
    expect(result.targetScale).toBe(1.5);
    expect(result.scaleValue).toBe(1.5);
  });

  // 360p → 1080p with "display": EASU goes to display dimensions
  it("360p → 1080p with display: EASU targets display, no final scaler", () => {
    const result = computeEasuTarget(640, 360, 1920, 1080, "display");
    expect(result.easuW).toBe(1920);
    expect(result.easuH).toBe(1080);
    expect(result.needsFinalScaler).toBe(false);
    expect(result.targetScale).toBe("display");
    expect(result.scaleValue).toBeCloseTo(3);
  });

  // 480p (854×480) → 2160p (3840×2160) — auto caps at 2×
  it("480p → 2160p with auto: caps at 2× source, final scaler needed", () => {
    const result = computeEasuTarget(854, 480, 3840, 2160, "auto");
    expect(result.easuW).toBe(1708);
    expect(result.easuH).toBe(960);
    expect(result.needsFinalScaler).toBe(true);
    expect(result.scaleValue).toBe(2);
  });

  // 2.00× never exceeds 2× source
  it("2.00× cap: never exceeds 2× source", () => {
    const result = computeEasuTarget(640, 360, 3840, 2160, 2);
    expect(result.easuW).toBe(1280);
    expect(result.easuH).toBe(720);
    expect(result.scaleValue).toBe(2);
  });

  // Aspect ratio preserved
  it("aspect ratio is preserved (proportional scaling)", () => {
    const result = computeEasuTarget(640, 360, 1920, 1080, "auto");
    expect(result.easuW / result.easuH).toBeCloseTo(640 / 360, 5);
  });

  // Source larger than display: EASU targets display dims
  it("source larger than display: EASU targets display dims", () => {
    const result = computeEasuTarget(3840, 2160, 1920, 1080, "auto");
    // sourceW > finalW, so proposedW would be capped at fw
    expect(result.easuW).toBe(1920);
    expect(result.easuH).toBe(1080);
    expect(result.needsFinalScaler).toBe(false);
  });

  // Edge: source × 2 === display exactly
  it("source × 2 equals display exactly", () => {
    const result = computeEasuTarget(960, 540, 1920, 1080, "auto");
    expect(result.easuW).toBe(1920);
    expect(result.easuH).toBe(1080);
    expect(result.needsFinalScaler).toBe(false);
  });
});
