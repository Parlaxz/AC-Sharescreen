import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "./viewer-image-defaults.js";

// ─── Scaling algorithm enum ──────────────────────────────────────────────────

export type ScalingAlgorithm =
  | "native"
  | "bicubic"
  | "fsr1-easu";

export const SCALING_ALGORITHMS: readonly ScalingAlgorithm[] = [
  "native",
  "bicubic",
  "fsr1-easu",
] as const;

export const SCALING_ALGORITHM_LABELS: Record<ScalingAlgorithm, string> = {
  native: "Native",
  bicubic: "Bicubic",
  "fsr1-easu": "FSR 1 EASU",
};

/** Algorithms that can produce overshoot/ringing artifacts */
export const OVERSHOOTING_ALGORITHMS: ReadonlySet<ScalingAlgorithm> = new Set([
  "bicubic",
  "fsr1-easu",
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ViewerImageEnhancementSettings {
  /** Master toggle — when false the enhancement pipeline is entirely disabled */
  enabled: boolean;
  /** GPU scaling algorithm: native | bicubic | fsr1-easu */
  scalingAlgorithm: ScalingAlgorithm;
  /** Sharpening filter strength (0–1). 0 = bypass */
  sharpeningStrength: number;
  /** Noise-aware sharpening mask (0–1). 0 = sharpen all detail, 1 = protect noise */
  noiseProtection: number;
  /** Edge-aware cleanup of compression artifacts (0–1). 0 = bypass */
  compressionCleanup: number;
  /** Spatial gradient debanding (0–1). 0 = bypass */
  debanding: number;
  /** Blend between bicubic and FSR EASU when FSR selected (0–1). Only used when scalingAlgorithm === "fsr1-easu" */
  fsrBicubicBlend: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Clamp a numeric value between min and max (inclusive).
 * Returns `fallback` when value is NaN, Infinity, or -Infinity.
 */
export function clampValue(
  value: number,
  min: number,
  max: number,
  fallback = min,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

// ─── Legacy migration ─────────────────────────────────────────────────────────

const OLD_NUMERIC_KEYS: ReadonlySet<string> = new Set([
  "chromaContribution",
  "artifactClamp",
  "textureNoiseSharpening",
  "antiRinging",
  "chromaCleanup",
  "compressionSmoothing",
]);

/**
 * Migrate legacy settings to the new simplified schema.
 * Handles:
 *   - enhancedScaling boolean → scalingAlgorithm
 *   - textureNoiseSharpening → noiseProtection (inverted)
 *   - chromaCleanup + compressionSmoothing → compressionCleanup
 *   - Removes old fields (chromaContribution, artifactClamp, antiRinging)
 */
function migrateLegacySettings(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const migrated = { ...obj };

  // Enhanced scaling boolean → scalingAlgorithm
  if ("enhancedScaling" in migrated && !("scalingAlgorithm" in migrated)) {
    const legacy = migrated.enhancedScaling;
    delete migrated.enhancedScaling;
    migrated.scalingAlgorithm = legacy === true ? "fsr1-easu" : "native";
  }

  // textureNoiseSharpening → noiseProtection (invert: old 0 = edges only, new 1 = noise protection)
  const oldTns = migrated.textureNoiseSharpening;
  if (typeof oldTns === "number" && !("noiseProtection" in migrated)) {
    const inverted = clampValue(1 - oldTns, 0, 1);
    migrated.noiseProtection = Math.round(inverted * 100) / 100;
  }

  // chromaCleanup + compressionSmoothing → compressionCleanup
  if (!("compressionCleanup" in migrated)) {
    const hasChromaCleanup = "chromaCleanup" in migrated;
    const hasCompressionSmoothing = "compressionSmoothing" in migrated;
    if (hasChromaCleanup || hasCompressionSmoothing) {
      const cc = typeof migrated.chromaCleanup === "number" ? migrated.chromaCleanup : 0;
      const cs = typeof migrated.compressionSmoothing === "number" ? migrated.compressionSmoothing : 0;
      migrated.compressionCleanup = clampValue(Math.max(cc, cs), 0, 1);
    }
  }

  // Remove old fields that are no longer user-facing
  for (const key of OLD_NUMERIC_KEYS) {
    delete migrated[key];
  }
  delete migrated.enhancedScaling;
  delete migrated.deblocking;

  return migrated;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  "sharpeningStrength",
  "noiseProtection",
  "compressionCleanup",
  "debanding",
  "fsrBicubicBlend",
]);

const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  "enabled",
]);

/**
 * Validate and sanitise an unknown value into a clean
 * `ViewerImageEnhancementSettings` object.
 *
 * - Missing keys → filled from defaults
 * - NaN / ±Infinity → filled from defaults
 * - Out-of-range numeric → clamped to [0, 1]
 * - Non-numeric for numeric keys → defaults
 * - Non-boolean for boolean keys → defaults
 * - Legacy fields auto-migrated
 */
export function validateSettings(
  raw: unknown,
): ViewerImageEnhancementSettings {
  let obj =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  obj = migrateLegacySettings(obj);

  const out: ViewerImageEnhancementSettings = { ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS };

  // Validate scalingAlgorithm
  if (typeof obj.scalingAlgorithm === "string" && SCALING_ALGORITHMS.includes(obj.scalingAlgorithm as ScalingAlgorithm)) {
    out.scalingAlgorithm = obj.scalingAlgorithm as ScalingAlgorithm;
  }

  for (const key of NUMERIC_KEYS) {
    const v = obj[key];
    if (typeof v === "number") {
      (out as unknown as Record<string, unknown>)[key] = clampValue(
        v,
        0,
        1,
        (VIEWER_IMAGE_ENHANCEMENT_DEFAULTS as unknown as Record<string, unknown>)[key] as number,
      );
    }
  }

  for (const key of BOOLEAN_KEYS) {
    const v = obj[key];
    if (typeof v === "boolean") {
      (out as unknown as Record<string, unknown>)[key] = v;
    }
  }

  return out;
}

// ─── localStorage persistence ────────────────────────────────────────────────

const STORAGE_KEY = "screenlink:viewer-image-enhancement";

/**
 * Load image enhancement settings from localStorage.
 * Returns defaults when no stored value exists or the stored value is corrupt.
 */
export function loadImageEnhancementSettings(): ViewerImageEnhancementSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS };
    const parsed = JSON.parse(raw) as unknown;
    return validateSettings(parsed);
  } catch {
    return { ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS };
  }
}

/**
 * Persist image enhancement settings to localStorage.
 */
export function saveImageEnhancementSettings(
  settings: ViewerImageEnhancementSettings,
): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage may be full or unavailable — silently ignore
  }
}

/**
 * Reset image enhancement settings to defaults.
 * Persists and returns the default values.
 */
export function resetImageEnhancementSettings(): ViewerImageEnhancementSettings {
  const defaults = { ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS };
  saveImageEnhancementSettings(defaults);
  return defaults;
}
