/**
 * Shared session-start quality override type. Consumed by ShareSetup,
 * QuickShareDialog, the share coordinator, StreamSessionManager, and
 * PublisherManager.
 *
 * A quality override is a per-session input that resolves to a
 * publication/capture configuration without inventing a separate
 * settings schema. Optional fields fall back to group defaults or
 * existing runtime defaults when omitted.
 */

export type AudioModeValue = "none" | "monitor" | "application";

// ─── Default video fallback values ─────────────────────────────────────────
// Single source of truth shared by SessionQualityOverride builders and
// StreamSessionManager. Any change here affects all fallback paths.
export const DEFAULT_VIDEO_BITRATE_KBPS = 650;
export const DEFAULT_SEND_WIDTH = 854;
export const DEFAULT_SEND_HEIGHT = 480;
export const DEFAULT_SEND_FPS = 15;
export const DEFAULT_CODEC = "vp9";
export const DEFAULT_CONTENT_HINT = "detail";
export const DEFAULT_DEGRADATION_PREFERENCE = "maintain-resolution";

/**
 * Per-session quality override. Only fields that affect capture or
 * publication are accepted here. Audio mode is selected separately
 * by the caller.
 */
export interface SessionQualityOverride {
  videoBitrateKbps: number;
  sendWidth: number;
  sendHeight: number;
  sendFps: number;
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  codec?: string;
  contentHint?: string;
  degradationPreference?: string;
}

/**
 * Minimal shape of a personal preset's `settings.video` block. Only
 * the fields consumed by the session-start override are required.
 */
export interface PresetVideoSettings {
  videoBitrateKbps?: number;
  sendWidth?: number;
  sendHeight?: number;
  sendFps?: number;
  captureWidth?: number;
  captureHeight?: number;
  captureFps?: number;
  codec?: string;
  contentHint?: string;
  degradationPreference?: string;
}

export interface PresetSettingsLike {
  video?: PresetVideoSettings;
  [key: string]: unknown;
}

/**
 * Convert a personal preset's settings into a SessionQualityOverride.
 * Missing fields are filled from VP9 defaults so the override is
 * always complete.
 */
export function presetSettingsToOverride(
  settings: PresetSettingsLike | undefined,
): SessionQualityOverride {
  const video = settings?.video ?? {};
  return {
    videoBitrateKbps:
      typeof video.videoBitrateKbps === "number"
        ? video.videoBitrateKbps
        : DEFAULT_VIDEO_BITRATE_KBPS,
    sendWidth:
      typeof video.sendWidth === "number" ? video.sendWidth : DEFAULT_SEND_WIDTH,
    sendHeight:
      typeof video.sendHeight === "number"
        ? video.sendHeight
        : DEFAULT_SEND_HEIGHT,
    sendFps:
      typeof video.sendFps === "number" ? video.sendFps : DEFAULT_SEND_FPS,
    captureWidth:
      typeof video.captureWidth === "number"
        ? video.captureWidth
        : DEFAULT_SEND_WIDTH,
    captureHeight:
      typeof video.captureHeight === "number"
        ? video.captureHeight
        : DEFAULT_SEND_HEIGHT,
    captureFps:
      typeof video.captureFps === "number" ? video.captureFps : DEFAULT_SEND_FPS,
    codec: typeof video.codec === "string" ? video.codec : DEFAULT_CODEC,
    contentHint:
      typeof video.contentHint === "string" ? video.contentHint : undefined,
    degradationPreference:
      typeof video.degradationPreference === "string"
        ? video.degradationPreference
        : undefined,
  };
}

/**
 * Build a SessionQualityOverride from raw custom slider values.
 * Default codec is VP9 for new Custom flows and runtime fallback.
 *
 * Accepts an optional content hint and degradation preference so the
 * Custom flow surfaces every quality knob exposed by the user-facing
 * preset editor.
 */
export function customPresetToOverride(input: {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  codec?: string;
  contentHint?: string;
  degradationPreference?: string;
}): SessionQualityOverride {
  return {
    videoBitrateKbps: input.bitrate,
    sendWidth: input.width,
    sendHeight: input.height,
    sendFps: input.fps,
    captureWidth: input.width,
    captureHeight: input.height,
    captureFps: input.fps,
    codec: input.codec ?? DEFAULT_CODEC,
    contentHint: input.contentHint,
    degradationPreference: input.degradationPreference,
  };
}

/**
 * Validate that an override falls inside the accepted ranges.
 * Returns an error message when invalid, or null when valid.
 *
 * Width 256–3840 px, Height 144–2160 px, FPS 1–60, Bitrate 100–20_000 kbps (≈12.5 kB/s–2.5 MB/s).
 * The lower height bound is 144 (not 180) so that real 144p
 * (`256×144`) is accepted.
 */
export function validateSessionQualityOverride(
  q: SessionQualityOverride,
): string | null {
  if (
    !Number.isFinite(q.videoBitrateKbps) ||
    q.videoBitrateKbps < 100 ||
    q.videoBitrateKbps > 20000
  ) {
    return "Bitrate must be between 100 and 20000 kbps (≈12.5 kB/s–2.5 MB/s)";
  }
  if (
    !Number.isFinite(q.sendWidth) ||
    q.sendWidth < 256 ||
    q.sendWidth > 3840
  ) {
    return "Send width must be between 256 and 3840";
  }
  if (
    !Number.isFinite(q.sendHeight) ||
    q.sendHeight < 144 ||
    q.sendHeight > 2160
  ) {
    return "Send height must be between 144 and 2160";
  }
  if (!Number.isFinite(q.sendFps) || q.sendFps < 1 || q.sendFps > 60) {
    return "Send FPS must be between 1 and 60";
  }
  if (
    !Number.isFinite(q.captureWidth) ||
    q.captureWidth < 256 ||
    q.captureWidth > 3840
  ) {
    return "Capture width must be between 256 and 3840";
  }
  if (
    !Number.isFinite(q.captureHeight) ||
    q.captureHeight < 144 ||
    q.captureHeight > 2160
  ) {
    return "Capture height must be between 144 and 2160";
  }
  if (
    !Number.isFinite(q.captureFps) ||
    q.captureFps < 1 ||
    q.captureFps > 60
  ) {
    return "Capture FPS must be between 1 and 60";
  }
  return null;
}

/**
 * Source descriptor for starting a share. Aligned with the
 * StartStreamInput.source shape consumed by StreamSessionManager.
 */
export interface ShareSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  displayId: string | null;
  fingerprint: string | null;
  audioMode?: AudioModeValue;
}

/**
 * Typed input for the shared start transaction. Every share flow
 * (normal Share Setup, Quick Share) passes the same shape so the
 * coordinator does not have to discover values indirectly.
 */
export interface StartShareInput {
  /** Explicit group ID; the coordinator no longer reads selectedGroupId. */
  groupId: string;
  source: ShareSource;
  /** Optional session-start quality override. */
  qualityOverride?: SessionQualityOverride;
}
