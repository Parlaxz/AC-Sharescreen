import { z } from "zod";

// ─── Enums (as const objects + type unions) ───────────────────────────────

export const VideoCodec = {
  AUTO: "auto",
  VP9: "vp9",
  AV1: "av1",
  H264: "h264",
  VP8: "vp8",
} as const;
export type VideoCodec = (typeof VideoCodec)[keyof typeof VideoCodec];

export const ContentHint = {
  AUTO: "auto",
  TEXT: "text",
  DETAIL: "detail",
  MOTION: "motion",
} as const;
export type ContentHint = (typeof ContentHint)[keyof typeof ContentHint];

export const DegradationPreference = {
  BALANCED: "balanced",
  MAINTAIN_RESOLUTION: "maintain-resolution",
  MAINTAIN_FRAMERATE: "maintain-framerate",
} as const;
export type DegradationPreference =
  (typeof DegradationPreference)[keyof typeof DegradationPreference];

export const ResolutionMode = {
  TARGET_DIMENSIONS: "target-dimensions",
  SCALE_FACTOR: "scale-factor",
} as const;
export type ResolutionMode =
  (typeof ResolutionMode)[keyof typeof ResolutionMode];

export const H264Profile = {
  AUTO: "auto",
  BASELINE: "baseline",
  MAIN: "main",
  HIGH: "high",
} as const;
export type H264Profile = (typeof H264Profile)[keyof typeof H264Profile];

export const CursorMode = {
  ALWAYS: "always",
  MOTION: "motion",
  NEVER: "never",
} as const;
export type CursorMode = (typeof CursorMode)[keyof typeof CursorMode];

export const RtpPriority = {
  VERY_LOW: "very-low",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;
export type RtpPriority = (typeof RtpPriority)[keyof typeof RtpPriority];

export const AudioChannels = {
  MONO: "mono",
  STEREO: "stereo",
} as const;
export type AudioChannels = (typeof AudioChannels)[keyof typeof AudioChannels];

export const AudioBitrateMode = {
  VBR: "vbr",
  CBR: "cbr",
} as const;
export type AudioBitrateMode =
  (typeof AudioBitrateMode)[keyof typeof AudioBitrateMode];

export type AudioPacketDurationMs = 10 | 20 | 40 | 60;

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface VideoQualitySettings {
  videoBitrateKbps: number;
  sendWidth: number;
  sendHeight: number;
  sendFps: number;
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  preserveAspectRatio: boolean;
  preventUpscale: boolean;
  resolutionMode: ResolutionMode;
  scaleResolutionDownBy: number;
  codec: VideoCodec;
  h264Profile: H264Profile;
  contentHint: ContentHint;
  degradationPreference: DegradationPreference;
  scalabilityMode: string | null;
  cursorMode: CursorMode;
  rtpPriority: RtpPriority;
}

export interface AudioEncodingSettings {
  bitrateKbps: number;
  channels: AudioChannels;
  bitrateMode: AudioBitrateMode;
  dtx: boolean;
  fec: boolean;
  packetDurationMs: AudioPacketDurationMs;
  redundantAudio: boolean;
}

export interface GroupQualitySettings {
  schemaVersion: 1;
  video: VideoQualitySettings;
  audio: AudioEncodingSettings;
}

export interface HostQualityLimits {
  maxVideoBitrateKbps: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  allowViewerQualityRequests: boolean;
}

export interface ViewerQualityRequest {
  streamSessionId: string;
  requestId: string;
  revision: number;
  videoBitrateKbps: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  degradationPreference: DegradationPreference;
  requestedAt: number;
}

// ─── Range Constants ───────────────────────────────────────────────────────

export const RANGES = {
  videoBitrateKbps: { min: 100, max: 20_000 },
  sendWidth: { min: 320, max: 3840 },
  sendHeight: { min: 180, max: 2160 },
  sendFps: { min: 1, max: 60 },
  captureWidth: { min: 320, max: 3840 },
  captureHeight: { min: 180, max: 2160 },
  captureFps: { min: 1, max: 60 },
  scaleResolutionDownBy: { min: 1, max: 8 },
  audioBitrateKbps: { min: 16, max: 256 },
} as const;

// ─── Zod Schemas ───────────────────────────────────────────────────────────

const videoCodecSchema = z.enum(["auto", "vp9", "av1", "h264", "vp8"]);
const contentHintSchema = z.enum(["auto", "text", "detail", "motion"]);
const degradationPreferenceSchema = z.enum([
  "balanced",
  "maintain-resolution",
  "maintain-framerate",
]);
const resolutionModeSchema = z.enum(["target-dimensions", "scale-factor"]);
const h264ProfileSchema = z.enum(["auto", "baseline", "main", "high"]);
const cursorModeSchema = z.enum(["always", "motion", "never"]);
const rtpPrioritySchema = z.enum(["very-low", "low", "medium", "high"]);
const audioChannelsSchema = z.enum(["mono", "stereo"]);
const audioBitrateModeSchema = z.enum(["vbr", "cbr"]);
const audioPacketDurationMsSchema = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(40),
  z.literal(60),
]);

export const VideoQualitySettingsSchema: z.ZodType<VideoQualitySettings> =
  z.object({
    videoBitrateKbps: z
      .number()
      .int()
      .min(RANGES.videoBitrateKbps.min)
      .max(RANGES.videoBitrateKbps.max),
    sendWidth: z
      .number()
      .int()
      .min(RANGES.sendWidth.min)
      .max(RANGES.sendWidth.max),
    sendHeight: z
      .number()
      .int()
      .min(RANGES.sendHeight.min)
      .max(RANGES.sendHeight.max),
    sendFps: z
      .number()
      .int()
      .min(RANGES.sendFps.min)
      .max(RANGES.sendFps.max),
    captureWidth: z
      .number()
      .int()
      .min(RANGES.captureWidth.min)
      .max(RANGES.captureWidth.max),
    captureHeight: z
      .number()
      .int()
      .min(RANGES.captureHeight.min)
      .max(RANGES.captureHeight.max),
    captureFps: z
      .number()
      .int()
      .min(RANGES.captureFps.min)
      .max(RANGES.captureFps.max),
    preserveAspectRatio: z.boolean(),
    preventUpscale: z.boolean(),
    resolutionMode: resolutionModeSchema,
    scaleResolutionDownBy: z
      .number()
      .min(RANGES.scaleResolutionDownBy.min)
      .max(RANGES.scaleResolutionDownBy.max),
    codec: videoCodecSchema,
    h264Profile: h264ProfileSchema,
    contentHint: contentHintSchema,
    degradationPreference: degradationPreferenceSchema,
    scalabilityMode: z.string().nullable(),
    cursorMode: cursorModeSchema,
    rtpPriority: rtpPrioritySchema,
  });

export type VideoQualitySettingsParsed = z.infer<
  typeof VideoQualitySettingsSchema
>;

export const AudioEncodingSettingsSchema: z.ZodType<AudioEncodingSettings> =
  z.object({
    bitrateKbps: z
      .number()
      .int()
      .min(RANGES.audioBitrateKbps.min)
      .max(RANGES.audioBitrateKbps.max),
    channels: audioChannelsSchema,
    bitrateMode: audioBitrateModeSchema,
    dtx: z.boolean(),
    fec: z.boolean(),
    packetDurationMs: audioPacketDurationMsSchema,
    redundantAudio: z.boolean(),
  });

export type AudioEncodingSettingsParsed = z.infer<
  typeof AudioEncodingSettingsSchema
>;

export const GroupQualitySettingsSchema: z.ZodType<GroupQualitySettings> =
  z.object({
    schemaVersion: z.literal(1),
    video: VideoQualitySettingsSchema,
    audio: AudioEncodingSettingsSchema,
  });

export type GroupQualitySettingsParsed = z.infer<
  typeof GroupQualitySettingsSchema
>;

export const HostQualityLimitsSchema: z.ZodType<HostQualityLimits> = z.object({
  maxVideoBitrateKbps: z.number().int().min(0),
  maxWidth: z.number().int().min(0),
  maxHeight: z.number().int().min(0),
  maxFps: z.number().int().min(0),
  allowViewerQualityRequests: z.boolean(),
});

export type HostQualityLimitsParsed = z.infer<typeof HostQualityLimitsSchema>;

export const ViewerQualityRequestSchema: z.ZodType<ViewerQualityRequest> =
  z.object({
    streamSessionId: z.string(),
    requestId: z.string(),
    revision: z.number().int().nonnegative(),
    videoBitrateKbps: z
      .number()
      .int()
      .min(RANGES.videoBitrateKbps.min)
      .max(RANGES.videoBitrateKbps.max),
    maxWidth: z
      .number()
      .int()
      .min(RANGES.sendWidth.min)
      .max(RANGES.sendWidth.max),
    maxHeight: z
      .number()
      .int()
      .min(RANGES.sendHeight.min)
      .max(RANGES.sendHeight.max),
    maxFps: z
      .number()
      .int()
      .min(RANGES.sendFps.min)
      .max(RANGES.sendFps.max),
    degradationPreference: degradationPreferenceSchema,
    requestedAt: z.number().int().positive(),
  });

export type ViewerQualityRequestParsed = z.infer<
  typeof ViewerQualityRequestSchema
>;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function createDefaultVideoQualitySettings(): VideoQualitySettings {
  return {
    videoBitrateKbps: 650,
    sendWidth: 854,
    sendHeight: 480,
    sendFps: 15,
    captureWidth: 854,
    captureHeight: 480,
    captureFps: 15,
    preserveAspectRatio: true,
    preventUpscale: true,
    resolutionMode: "target-dimensions",
    scaleResolutionDownBy: 1,
    codec: "vp9",
    h264Profile: "auto",
    contentHint: "detail",
    degradationPreference: "maintain-resolution",
    scalabilityMode: null,
    cursorMode: "always",
    rtpPriority: "medium",
  };
}

export function createDefaultAudioEncodingSettings(): AudioEncodingSettings {
  return {
    bitrateKbps: 64,
    channels: "stereo",
    bitrateMode: "vbr",
    dtx: false,
    fec: true,
    packetDurationMs: 20,
    redundantAudio: false,
  };
}

export function createDefaultGroupQualitySettings(): GroupQualitySettings {
  return {
    schemaVersion: 1,
    video: createDefaultVideoQualitySettings(),
    audio: createDefaultAudioEncodingSettings(),
  };
}

export function createDefaultHostQualityLimits(): HostQualityLimits {
  return {
    maxVideoBitrateKbps: 5000,
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 60,
    allowViewerQualityRequests: true,
  };
}

/**
 * Whitelist of field names that may appear in a ViewerQualityRequest.
 * These are the ONLY fields allowed in the output — any other fields
 * trigger a runtime assertion to catch accidental inclusion.
 */
const VIEWER_REQUEST_WHITELIST: ReadonlySet<string> = new Set([
  "videoBitrateKbps",
  "maxWidth",
  "maxHeight",
  "maxFps",
  "degradationPreference",
]);

/**
 * Set of ALL allowed keys in a ViewerQualityRequest (whitelist + metadata).
 */
const ALLOWED_OUTPUT_KEYS: ReadonlySet<string> = new Set([
  ...VIEWER_REQUEST_WHITELIST,
  "streamSessionId",
  "requestId",
  "revision",
  "requestedAt",
]);

/**
 * Extract a ViewerQualityRequest from a GroupQualitySettings preset.
 * Only the whitelist fields are carried over. A runtime assertion verifies
 * that the output contains no fields outside the whitelist + metadata,
 * catching accidental future additions.
 *
 * Whitelist fields:
 *   videoBitrateKbps, maxWidth ← sendWidth,
 *   maxHeight ← sendHeight, maxFps ← sendFps,
 *   degradationPreference
 */
export function extractViewerRequestFromPreset(
  preset: GroupQualitySettings,
  streamSessionId: string,
  revision: number,
): ViewerQualityRequest {
  const video = preset.video;

  // Runtime assertion: each whitelisted field must be present on the input
  const INPUT_EXTRACTABLE: ReadonlySet<string> = new Set([
    "videoBitrateKbps",
    "sendWidth",
    "sendHeight",
    "sendFps",
    "degradationPreference",
  ]);
  for (const key of INPUT_EXTRACTABLE) {
    if (!(key in video)) {
      throw new Error(
        `Missing extractable field "${key}" in GroupQualitySettings.video`,
      );
    }
  }

  const result: ViewerQualityRequest = {
    videoBitrateKbps: video.videoBitrateKbps,
    maxWidth: video.sendWidth,
    maxHeight: video.sendHeight,
    maxFps: video.sendFps,
    degradationPreference: video.degradationPreference,
    streamSessionId,
    requestId: crypto.randomUUID(),
    revision,
    requestedAt: Date.now(),
  };

  // Runtime assertion: verify output contains only allowed keys
  for (const key of Object.keys(result)) {
    if (!ALLOWED_OUTPUT_KEYS.has(key)) {
      throw new Error(
        `Unexpected field "${key}" in extracted ViewerQualityRequest — ` +
          `only whitelist fields are allowed`,
      );
    }
  }

  return result;
}

// ─── Validation ────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  clampReasons: string[];
}

/**
 * Validate GroupQualitySettings against host limits.
 * Values are clamped to ranges and host limits; clampReasons describe each
 * clamping.
 */
export function validateGroupSettings(
  settings: GroupQualitySettings,
  hostLimits: HostQualityLimits,
): ValidationResult {
  const errors: string[] = [];
  const clampReasons: string[] = [];

  let videoBitrateKbps = settings.video.videoBitrateKbps;
  let maxWidth = settings.video.sendWidth;
  let maxHeight = settings.video.sendHeight;
  let maxFps = settings.video.sendFps;
  let sendWidth = settings.video.sendWidth;
  let sendHeight = settings.video.sendHeight;
  let sendFps = settings.video.sendFps;

  // Clamp to ranges
  if (videoBitrateKbps < RANGES.videoBitrateKbps.min) {
    videoBitrateKbps = RANGES.videoBitrateKbps.min;
    clampReasons.push(
      `videoBitrateKbps clamped from ${settings.video.videoBitrateKbps} to range min ${RANGES.videoBitrateKbps.min}`,
    );
  }
  if (videoBitrateKbps > RANGES.videoBitrateKbps.max) {
    videoBitrateKbps = RANGES.videoBitrateKbps.max;
    clampReasons.push(
      `videoBitrateKbps clamped from ${settings.video.videoBitrateKbps} to range max ${RANGES.videoBitrateKbps.max}`,
    );
  }

  // Clamp send dimensions to ranges
  if (sendWidth < RANGES.sendWidth.min) {
    sendWidth = RANGES.sendWidth.min;
    clampReasons.push(
      `sendWidth clamped from ${settings.video.sendWidth} to range min ${RANGES.sendWidth.min}`,
    );
  }
  if (sendWidth > RANGES.sendWidth.max) {
    sendWidth = RANGES.sendWidth.max;
    clampReasons.push(
      `sendWidth clamped from ${settings.video.sendWidth} to range max ${RANGES.sendWidth.max}`,
    );
  }
  if (sendHeight < RANGES.sendHeight.min) {
    sendHeight = RANGES.sendHeight.min;
    clampReasons.push(
      `sendHeight clamped from ${settings.video.sendHeight} to range min ${RANGES.sendHeight.min}`,
    );
  }
  if (sendHeight > RANGES.sendHeight.max) {
    sendHeight = RANGES.sendHeight.max;
    clampReasons.push(
      `sendHeight clamped from ${settings.video.sendHeight} to range max ${RANGES.sendHeight.max}`,
    );
  }
  if (sendFps < RANGES.sendFps.min) {
    sendFps = RANGES.sendFps.min;
    clampReasons.push(
      `sendFps clamped from ${settings.video.sendFps} to range min ${RANGES.sendFps.min}`,
    );
  }
  if (sendFps > RANGES.sendFps.max) {
    sendFps = RANGES.sendFps.max;
    clampReasons.push(
      `sendFps clamped from ${settings.video.sendFps} to range max ${RANGES.sendFps.max}`,
    );
  }

  // Clamp to host limits
  if (videoBitrateKbps > hostLimits.maxVideoBitrateKbps) {
    videoBitrateKbps = hostLimits.maxVideoBitrateKbps;
    clampReasons.push(
      `videoBitrateKbps clamped from ${settings.video.videoBitrateKbps} to host limit ${hostLimits.maxVideoBitrateKbps}`,
    );
  }
  if (maxWidth > hostLimits.maxWidth) {
    maxWidth = hostLimits.maxWidth;
    clampReasons.push(
      `maxWidth clamped from ${settings.video.sendWidth} to host limit ${hostLimits.maxWidth}`,
    );
  }
  if (maxHeight > hostLimits.maxHeight) {
    maxHeight = hostLimits.maxHeight;
    clampReasons.push(
      `maxHeight clamped from ${settings.video.sendHeight} to host limit ${hostLimits.maxHeight}`,
    );
  }
  if (maxFps > hostLimits.maxFps) {
    maxFps = hostLimits.maxFps;
    clampReasons.push(
      `maxFps clamped from ${settings.video.sendFps} to host limit ${hostLimits.maxFps}`,
    );
  }

  return {
    ok: errors.length === 0 && clampReasons.length === 0,
    errors,
    clampReasons,
  };
}

// ─── Settings revision identity (Gate 2.4) ─────────────────────────────────

/**
 * Synchronized identity for a group's quality settings.
 *
 * `stamp` is the HLC timestamp the settings were published under.
 * `hash` is a deterministic hex-encoded SHA-256 of the canonicalized
 * settings, used to detect equal-but-different revisions.
 */
export interface GroupSettingsRevision {
  stamp: string;
  hash: string;
}

export interface GroupRevisionMetadata {
  stamp: string;
  hash: string;
  lastEditor: string;
  lastModified: number;
}

export const EMPTY_GROUP_SETTINGS_REVISION: GroupSettingsRevision = {
  stamp: "0-0-0",
  hash: "",
};

/**
 * Compute a deterministic SHA-256 hash of the canonicalized settings.
 * Uses WebCrypto so the same algorithm runs in both main and renderer.
 */
export async function hashGroupSettings(
  settings: GroupQualitySettings,
): Promise<string> {
  const canonical = canonicalSettingsStringify(settings);
  const buf = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", buf.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalSettingsStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSettingsStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalSettingsStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

// ─── Restart-required classification (Gate 9.6) ────────────────────────────

/**
 * Compare two settings and return the list of fields whose value
 * changed. The caller is responsible for mapping fields to
 * "live-safe" or "restart-required" categories; the constants below
 * are the canonical lists used by ScreenLink.
 */
export function diffGroupSettings(
  before: GroupQualitySettings,
  after: GroupQualitySettings,
): string[] {
  const diffs: string[] = [];
  const fields: Array<keyof VideoQualitySettings | keyof AudioEncodingSettings> = [
    "videoBitrateKbps",
    "sendWidth",
    "sendHeight",
    "sendFps",
    "captureWidth",
    "captureHeight",
    "captureFps",
    "preserveAspectRatio",
    "preventUpscale",
    "resolutionMode",
    "scaleResolutionDownBy",
    "codec",
    "h264Profile",
    "contentHint",
    "degradationPreference",
    "scalabilityMode",
    "cursorMode",
    "rtpPriority",
  ];
  for (const f of fields) {
    if ((before.video as unknown as Record<string, unknown>)[f] !==
        (after.video as unknown as Record<string, unknown>)[f]) {
      diffs.push(`video.${f}`);
    }
  }
  const audioFields: Array<keyof AudioEncodingSettings> = [
    "bitrateKbps",
    "channels",
    "bitrateMode",
    "dtx",
    "fec",
    "packetDurationMs",
    "redundantAudio",
  ];
  for (const f of audioFields) {
    if ((before.audio as unknown as Record<string, unknown>)[f] !==
        (after.audio as unknown as Record<string, unknown>)[f]) {
      diffs.push(`audio.${f}`);
    }
  }
  return diffs;
}

/**
 * Subset of group quality fields that can be live-applied to a
 * running publication without restarting the stream.
 */
export const LIVE_SAFE_VIDEO_FIELDS = new Set<string>([
  "videoBitrateKbps",
  "sendWidth",
  "sendHeight",
  "sendFps",
  "scaleResolutionDownBy",
  "contentHint",
  "degradationPreference",
  "rtpPriority",
]);

/**
 * Subset of group quality fields whose change requires a stream
 * restart. These touch capture-side or codec-negotiation state that
 * cannot be live-applied through `setParameters`.
 */
export const RESTART_REQUIRED_VIDEO_FIELDS = new Set<string>([
  "codec",
  "h264Profile",
  "captureWidth",
  "captureHeight",
  "captureFps",
  "cursorMode",
]);

/**
 * Audio fields are always restart-required — re-negotiating audio
 * encoding on a live publication is not safely possible.
 */
export const RESTART_REQUIRED_AUDIO_PREFIX = "audio";

/**
 * Classify a list of changed field paths into `liveSafe` (can be
 * applied without restart) and `restartRequired` (force a restart).
 */
export function classifySettingsDiff(fieldPaths: string[]): {
  liveSafe: string[];
  restartRequired: string[];
} {
  const liveSafe: string[] = [];
  const restartRequired: string[] = [];
  for (const path of fieldPaths) {
    if (path.startsWith(RESTART_REQUIRED_AUDIO_PREFIX + ".")) {
      restartRequired.push(path);
      continue;
    }
    const fieldName = path.startsWith("video.") ? path.slice("video.".length) : path;
    if (RESTART_REQUIRED_VIDEO_FIELDS.has(fieldName)) {
      restartRequired.push(path);
    } else if (LIVE_SAFE_VIDEO_FIELDS.has(fieldName)) {
      liveSafe.push(path);
    } else {
      // Unknown change: be conservative and require restart.
      restartRequired.push(path);
    }
  }
  return { liveSafe, restartRequired };
}

export function isRestartRequired(
  before: GroupQualitySettings,
  after: GroupQualitySettings,
): boolean {
  const { restartRequired } = classifySettingsDiff(diffGroupSettings(before, after));
  return restartRequired.length > 0;
}
