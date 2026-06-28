import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "./viewer-image-defaults.js";

// ─── Scaling algorithm enum ──────────────────────────────────────────────────

export type ScalingAlgorithm =
  | "native"
  | "nearest"
  | "bilinear"
  | "bicubic"
  | "lanczos"
  | "fsr1-easu";

export const SCALING_ALGORITHMS: readonly ScalingAlgorithm[] = [
  "native",
  "bilinear",
  "nearest",
  "bicubic",
  "lanczos",
  "fsr1-easu",
] as const;

export const SCALING_ALGORITHM_LABELS: Record<ScalingAlgorithm, string> = {
  native: "Native",
  bilinear: "Bilinear",
  nearest: "Nearest",
  bicubic: "Bicubic",
  lanczos: "Lanczos",
  "fsr1-easu": "FSR 1 EASU",
};

/** Algorithms that can produce overshoot/ringing artifacts */
export const OVERSHOOTING_ALGORITHMS: ReadonlySet<ScalingAlgorithm> = new Set([
  "bicubic",
  "lanczos",
  "fsr1-easu",
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ViewerImageEnhancementSettings {
  /** Master toggle — when false the enhancement pipeline is entirely disabled */
  enabled: boolean;
  /** GPU scaling algorithm selector */
  scalingAlgorithm: ScalingAlgorithm;
  /** Sharpening filter strength (0–1) */
  sharpeningStrength: number;
  /** Chroma/luma separation contribution (0–1) */
  chromaContribution: number;
  /** Artifact clamping aggressiveness (0–1) */
  artifactClamp: number;
  /** Texture / noise-aware sharpening blend (0–1) */
  textureNoiseSharpening: number;
  /** Anti-ringing filter strength (0–1) */
  antiRinging: number;
  /** Chroma subpixel cleanup pass (0–1) */
  chromaCleanup: number;
  /** Compression smoothing (conservative deblocking/debanding, 0–1) */
  compressionSmoothing: number;
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

// ─── Validation ──────────────────────────────────────────────────────────────

const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  "sharpeningStrength",
  "chromaContribution",
  "artifactClamp",
  "textureNoiseSharpening",
  "antiRinging",
  "chromaCleanup",
  "compressionSmoothing",
]);

const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  "enabled",
]);

/**
 * Migrate legacy `enhancedScaling` boolean to `scalingAlgorithm`.
 * Returns an updated partial object with the old key removed.
 */
function migrateLegacyEnhancedScaling(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if ("enhancedScaling" in obj && !("scalingAlgorithm" in obj)) {
    const legacy = obj.enhancedScaling;
    const migrated = { ...obj };
    delete migrated.enhancedScaling;
    migrated.scalingAlgorithm = legacy === true ? "fsr1-easu" : "native";
    return migrated;
  }
  return obj;
}

/**
 * Validate and sanitise an unknown value into a clean
 * `ViewerImageEnhancementSettings` object.
 *
 * - Missing keys → filled from defaults
 * - NaN / ±Infinity → filled from defaults
 * - Out-of-range numeric → clamped to [0, 1]
 * - Non-numeric for numeric keys → defaults
 * - Non-boolean for boolean keys → defaults
 * - Legacy `enhancedScaling` boolean → migrated to `scalingAlgorithm`
 */
export function validateSettings(
  raw: unknown,
): ViewerImageEnhancementSettings {
  let obj =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  obj = migrateLegacyEnhancedScaling(obj);

  const out: ViewerImageEnhancementSettings = { ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS };

  // Validate scalingAlgorithm
  if (typeof obj.scalingAlgorithm === "string" && SCALING_ALGORITHMS.includes(obj.scalingAlgorithm as ScalingAlgorithm)) {
    out.scalingAlgorithm = obj.scalingAlgorithm as ScalingAlgorithm;
  }

  for (const key of NUMERIC_KEYS) {
    const v = obj[key];
    if (typeof v === "number") {
      out[key as keyof ViewerImageEnhancementSettings] = clampValue(
        v,
        0,
        1,
        VIEWER_IMAGE_ENHANCEMENT_DEFAULTS[
          key as keyof ViewerImageEnhancementSettings
        ] as number,
      ) as never;
    }
    // else: keep default
  }

  for (const key of BOOLEAN_KEYS) {
    const v = obj[key];
    if (typeof v === "boolean") {
      (out as unknown as Record<string, unknown>)[key] = v;
    }
    // else: keep default
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
