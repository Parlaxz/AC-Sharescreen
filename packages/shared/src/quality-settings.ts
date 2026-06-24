import { z } from "zod";

// ─── Enums ─────────────────────────────────────────────────────────────────

export const DegradationPreference = {
  MAINTAIN_RESOLUTION: "maintain-resolution",
  MAINTAIN_FRAMERATE: "maintain-framerate",
  BALANCED: "balanced",
} as const;

export type DegradationPreference =
  (typeof DegradationPreference)[keyof typeof DegradationPreference];

export const DEGRADATION_PREFERENCES: readonly DegradationPreference[] = [
  "maintain-resolution",
  "maintain-framerate",
  "balanced",
] as const;

export const ContentHint = {
  DETAIL: "detail",
  MOTION: "motion",
} as const;

export type ContentHint = (typeof ContentHint)[keyof typeof ContentHint];

export const CONTENT_HINTS: readonly ContentHint[] = ["detail", "motion"] as const;

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface GroupQualitySettings {
  videoBitrateKbps: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  degradationPreference: DegradationPreference;
  contentHint: ContentHint;
  audioEnabled: boolean;
}

export interface HostQualityLimits {
  maxBitrateKbpsAbsolute: number;
  maxWidthAbsolute: number;
  maxHeightAbsolute: number;
  maxFpsAbsolute: number;
  allowedDegradationPreferences: DegradationPreference[];
  allowedContentHints: ContentHint[];
  audioAllowed: boolean;
}

export interface ViewerQualityRequest {
  videoBitrateKbps: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  degradationPreference: DegradationPreference;
  streamSessionId: string;
  requestId: string;
  revision: number;
  requestedAt: number;
}

export interface DeviceCapabilities {
  maxBitrateKbps: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  supportedDegradationPreferences: DegradationPreference[];
  supportedContentHints: ContentHint[];
  supportsAudio: boolean;
}

// ─── Range Constants ───────────────────────────────────────────────────────

export const QUALITY_RANGES = {
  videoBitrateKbps: { min: 50, max: 50_000 },
  width: { min: 160, max: 7680 },
  height: { min: 90, max: 4320 },
  fps: { min: 1, max: 120 },
} as const;

// ─── Schemas ───────────────────────────────────────────────────────────────

export const GroupQualitySettingsSchema = z.object({
  videoBitrateKbps: z
    .number()
    .int()
    .min(QUALITY_RANGES.videoBitrateKbps.min)
    .max(QUALITY_RANGES.videoBitrateKbps.max),
  maxWidth: z
    .number()
    .int()
    .min(QUALITY_RANGES.width.min)
    .max(QUALITY_RANGES.width.max),
  maxHeight: z
    .number()
    .int()
    .min(QUALITY_RANGES.height.min)
    .max(QUALITY_RANGES.height.max),
  maxFps: z
    .number()
    .int()
    .min(QUALITY_RANGES.fps.min)
    .max(QUALITY_RANGES.fps.max),
  degradationPreference: z.enum(["maintain-resolution", "maintain-framerate", "balanced"]),
  contentHint: z.enum(["detail", "motion"]),
  audioEnabled: z.boolean(),
});

export type GroupQualitySettingsParsed = z.infer<typeof GroupQualitySettingsSchema>;

export const HostQualityLimitsSchema = z.object({
  maxBitrateKbpsAbsolute: z
    .number()
    .int()
    .min(QUALITY_RANGES.videoBitrateKbps.min)
    .max(QUALITY_RANGES.videoBitrateKbps.max),
  maxWidthAbsolute: z
    .number()
    .int()
    .min(QUALITY_RANGES.width.min)
    .max(QUALITY_RANGES.width.max),
  maxHeightAbsolute: z
    .number()
    .int()
    .min(QUALITY_RANGES.height.min)
    .max(QUALITY_RANGES.height.max),
  maxFpsAbsolute: z
    .number()
    .int()
    .min(QUALITY_RANGES.fps.min)
    .max(QUALITY_RANGES.fps.max),
  allowedDegradationPreferences: z.array(z.enum(["maintain-resolution", "maintain-framerate", "balanced"])),
  allowedContentHints: z.array(z.enum(["detail", "motion"])),
  audioAllowed: z.boolean(),
});

export type HostQualityLimitsParsed = z.infer<typeof HostQualityLimitsSchema>;

export const ViewerQualityRequestSchema = z.object({
  videoBitrateKbps: z
    .number()
    .int()
    .min(QUALITY_RANGES.videoBitrateKbps.min)
    .max(QUALITY_RANGES.videoBitrateKbps.max),
  maxWidth: z
    .number()
    .int()
    .min(QUALITY_RANGES.width.min)
    .max(QUALITY_RANGES.width.max),
  maxHeight: z
    .number()
    .int()
    .min(QUALITY_RANGES.height.min)
    .max(QUALITY_RANGES.height.max),
  maxFps: z
    .number()
    .int()
    .min(QUALITY_RANGES.fps.min)
    .max(QUALITY_RANGES.fps.max),
  degradationPreference: z.enum(["maintain-resolution", "maintain-framerate", "balanced"]),
  streamSessionId: z.string(),
  requestId: z.string(),
  revision: z.number().int().nonnegative(),
  requestedAt: z.number().int().positive(),
});

export type ViewerQualityRequestParsed = z.infer<typeof ViewerQualityRequestSchema>;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function createDefaultGroupQualitySettings(): GroupQualitySettings {
  return {
    videoBitrateKbps: 1800,
    maxWidth: 1280,
    maxHeight: 720,
    maxFps: 30,
    degradationPreference: "balanced",
    contentHint: "detail",
    audioEnabled: true,
  };
}

export function createDefaultHostQualityLimits(): HostQualityLimits {
  return {
    maxBitrateKbpsAbsolute: 20_000,
    maxWidthAbsolute: 3840,
    maxHeightAbsolute: 2160,
    maxFpsAbsolute: 60,
    allowedDegradationPreferences: [...DEGRADATION_PREFERENCES],
    allowedContentHints: [...CONTENT_HINTS],
    audioAllowed: true,
  };
}

/**
 * Extract a ViewerQualityRequest from a GroupQualitySettings preset.
 * Only the allowed fields are carried over (videoBitrateKbps, maxWidth, maxHeight,
 * maxFps, degradationPreference).
 */
export function extractViewerRequestFromPreset(
  preset: GroupQualitySettings,
  streamSessionId: string,
  revision: number,
): ViewerQualityRequest {
  return {
    videoBitrateKbps: preset.videoBitrateKbps,
    maxWidth: preset.maxWidth,
    maxHeight: preset.maxHeight,
    maxFps: preset.maxFps,
    degradationPreference: preset.degradationPreference,
    streamSessionId,
    requestId: crypto.randomUUID(),
    revision,
    requestedAt: Date.now(),
  };
}

// ─── Validation ────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  clampReasons: string[];
}

/**
 * Validate GroupQualitySettings against host limits and device capabilities.
 * Values are clamped to limits; clampReasons describe each clamping.
 */
export function validateGroupSettings(
  settings: GroupQualitySettings,
  hostLimits: HostQualityLimits,
  capabilities: DeviceCapabilities,
): ValidationResult {
  const errors: string[] = [];
  const clampReasons: string[] = [];

  let videoBitrateKbps = settings.videoBitrateKbps;
  let maxWidth = settings.maxWidth;
  let maxHeight = settings.maxHeight;
  let maxFps = settings.maxFps;
  let degradationPreference = settings.degradationPreference;
  let audioEnabled = settings.audioEnabled;

  // Clamp to host limits
  if (videoBitrateKbps > hostLimits.maxBitrateKbpsAbsolute) {
    videoBitrateKbps = hostLimits.maxBitrateKbpsAbsolute;
    clampReasons.push(
      `videoBitrateKbps clamped from ${settings.videoBitrateKbps} to host limit ${hostLimits.maxBitrateKbpsAbsolute}`,
    );
  }
  if (maxWidth > hostLimits.maxWidthAbsolute) {
    maxWidth = hostLimits.maxWidthAbsolute;
    clampReasons.push(
      `maxWidth clamped from ${settings.maxWidth} to host limit ${hostLimits.maxWidthAbsolute}`,
    );
  }
  if (maxHeight > hostLimits.maxHeightAbsolute) {
    maxHeight = hostLimits.maxHeightAbsolute;
    clampReasons.push(
      `maxHeight clamped from ${settings.maxHeight} to host limit ${hostLimits.maxHeightAbsolute}`,
    );
  }
  if (maxFps > hostLimits.maxFpsAbsolute) {
    maxFps = hostLimits.maxFpsAbsolute;
    clampReasons.push(
      `maxFps clamped from ${settings.maxFps} to host limit ${hostLimits.maxFpsAbsolute}`,
    );
  }
  if (!hostLimits.allowedDegradationPreferences.includes(degradationPreference)) {
    const fallback = hostLimits.allowedDegradationPreferences[0] ?? "balanced";
    degradationPreference = fallback;
    clampReasons.push(
      `degradationPreference changed from "${settings.degradationPreference}" to allowed "${fallback}"`,
    );
  }
  if (audioEnabled && !hostLimits.audioAllowed) {
    audioEnabled = false;
    clampReasons.push("audio disabled by host limits");
  }

  // Clamp to device capabilities
  if (videoBitrateKbps > capabilities.maxBitrateKbps) {
    videoBitrateKbps = capabilities.maxBitrateKbps;
    clampReasons.push(
      `videoBitrateKbps clamped from ${settings.videoBitrateKbps} to device cap ${capabilities.maxBitrateKbps}`,
    );
  }
  if (maxWidth > capabilities.maxWidth) {
    maxWidth = capabilities.maxWidth;
    clampReasons.push(
      `maxWidth clamped from ${settings.maxWidth} to device cap ${capabilities.maxWidth}`,
    );
  }
  if (maxHeight > capabilities.maxHeight) {
    maxHeight = capabilities.maxHeight;
    clampReasons.push(
      `maxHeight clamped from ${settings.maxHeight} to device cap ${capabilities.maxHeight}`,
    );
  }
  if (maxFps > capabilities.maxFps) {
    maxFps = capabilities.maxFps;
    clampReasons.push(
      `maxFps clamped from ${settings.maxFps} to device cap ${capabilities.maxFps}`,
    );
  }
  if (!capabilities.supportedDegradationPreferences.includes(degradationPreference)) {
    const fallback = capabilities.supportedDegradationPreferences[0] ?? "balanced";
    degradationPreference = fallback;
    clampReasons.push(
      `degradationPreference changed from "${settings.degradationPreference}" to device-supported "${fallback}"`,
    );
  }
  if (audioEnabled && !capabilities.supportsAudio) {
    audioEnabled = false;
    clampReasons.push("audio disabled by device capabilities");
  }

  return {
    ok: errors.length === 0 && clampReasons.length === 0,
    errors,
    clampReasons,
  };
}
