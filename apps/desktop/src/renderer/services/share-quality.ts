/**
 * Shared session-start quality override type and built-in preset
 * definitions. Consumed by ShareSetup, QuickShareDialog, the share
 * coordinator, StreamSessionManager, and PublisherManager.
 *
 * A quality override is a per-session input that resolves to a
 * publication/capture configuration without inventing a separate
 * settings schema. Optional fields fall back to group defaults or
 * existing runtime defaults when omitted.
 */

export type AudioModeValue = "none" | "monitor" | "application";

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

export type BuiltInPresetKind = "data-saver" | "balanced" | "clear";

/**
 * Built-in quality presets. The slot list is the source of truth for
 * the values displayed in the ShareSetup / QuickShareDialog cards
 * and for resolving a built-in slot into a SessionQualityOverride.
 */
export interface BuiltInPresetDefinition {
  kind: BuiltInPresetKind;
  name: string;
  summary: string;
  videoBitrateKbps: number;
  sendWidth: number;
  sendHeight: number;
  sendFps: number;
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
}

export const BUILT_IN_PRESETS: readonly BuiltInPresetDefinition[] = [
  {
    kind: "data-saver",
    name: "Data saver",
    summary: "640×360 @ 10 fps · 400 kbps",
    videoBitrateKbps: 400,
    sendWidth: 640,
    sendHeight: 360,
    sendFps: 10,
    captureWidth: 640,
    captureHeight: 360,
    captureFps: 10,
  },
  {
    kind: "balanced",
    name: "Balanced",
    summary: "854×480 @ 15 fps · 650 kbps",
    videoBitrateKbps: 650,
    sendWidth: 854,
    sendHeight: 480,
    sendFps: 15,
    captureWidth: 854,
    captureHeight: 480,
    captureFps: 15,
  },
  {
    kind: "clear",
    name: "Clear",
    summary: "1280×720 @ 24 fps · 1500 kbps",
    videoBitrateKbps: 1500,
    sendWidth: 1280,
    sendHeight: 720,
    sendFps: 24,
    captureWidth: 1280,
    captureHeight: 720,
    captureFps: 24,
  },
] as const;

/**
 * Convert a built-in slot into a SessionQualityOverride. Codec,
 * content hint, and degradation preference are intentionally omitted
 * for built-ins so that group defaults or runtime defaults supply
 * them.
 */
export function builtInPresetToOverride(
  kind: BuiltInPresetKind,
): SessionQualityOverride {
  const preset = BUILT_IN_PRESETS.find((p) => p.kind === kind);
  if (!preset) {
    throw new Error(`Unknown built-in preset: ${kind}`);
  }
  return {
    videoBitrateKbps: preset.videoBitrateKbps,
    sendWidth: preset.sendWidth,
    sendHeight: preset.sendHeight,
    sendFps: preset.sendFps,
    captureWidth: preset.captureWidth,
    captureHeight: preset.captureHeight,
    captureFps: preset.captureFps,
  };
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
 * Missing fields are filled from a fallback (typically the Balanced
 * built-in) so the override is always complete.
 */
export function presetSettingsToOverride(
  settings: PresetSettingsLike | undefined,
  fallback: BuiltInPresetKind = "balanced",
): SessionQualityOverride {
  const balanced = builtInPresetToOverride(fallback);
  const video = settings?.video ?? {};
  return {
    videoBitrateKbps:
      typeof video.videoBitrateKbps === "number"
        ? video.videoBitrateKbps
        : balanced.videoBitrateKbps,
    sendWidth:
      typeof video.sendWidth === "number" ? video.sendWidth : balanced.sendWidth,
    sendHeight:
      typeof video.sendHeight === "number"
        ? video.sendHeight
        : balanced.sendHeight,
    sendFps:
      typeof video.sendFps === "number" ? video.sendFps : balanced.sendFps,
    captureWidth:
      typeof video.captureWidth === "number"
        ? video.captureWidth
        : balanced.captureWidth,
    captureHeight:
      typeof video.captureHeight === "number"
        ? video.captureHeight
        : balanced.captureHeight,
    captureFps:
      typeof video.captureFps === "number" ? video.captureFps : balanced.sendFps,
    codec: typeof video.codec === "string" ? video.codec : undefined,
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
 */
export function customPresetToOverride(input: {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}): SessionQualityOverride {
  return {
    videoBitrateKbps: input.bitrate,
    sendWidth: input.width,
    sendHeight: input.height,
    sendFps: input.fps,
    captureWidth: input.width,
    captureHeight: input.height,
    captureFps: input.fps,
  };
}

/**
 * Validate that an override falls inside the accepted ranges.
 * Returns an error message when invalid, or null when valid.
 */
export function validateSessionQualityOverride(
  q: SessionQualityOverride,
): string | null {
  if (
    !Number.isFinite(q.videoBitrateKbps) ||
    q.videoBitrateKbps < 100 ||
    q.videoBitrateKbps > 20000
  ) {
    return "Bitrate must be between 100 and 20000 kbps";
  }
  if (
    !Number.isFinite(q.sendWidth) ||
    q.sendWidth < 320 ||
    q.sendWidth > 3840
  ) {
    return "Send width must be between 320 and 3840";
  }
  if (
    !Number.isFinite(q.sendHeight) ||
    q.sendHeight < 180 ||
    q.sendHeight > 2160
  ) {
    return "Send height must be between 180 and 2160";
  }
  if (!Number.isFinite(q.sendFps) || q.sendFps < 1 || q.sendFps > 60) {
    return "Send FPS must be between 1 and 60";
  }
  if (
    !Number.isFinite(q.captureWidth) ||
    q.captureWidth < 320 ||
    q.captureWidth > 3840
  ) {
    return "Capture width must be between 320 and 3840";
  }
  if (
    !Number.isFinite(q.captureHeight) ||
    q.captureHeight < 180 ||
    q.captureHeight > 2160
  ) {
    return "Capture height must be between 180 and 2160";
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
