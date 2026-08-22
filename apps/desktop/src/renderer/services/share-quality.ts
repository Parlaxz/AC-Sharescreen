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

import {
  FALLBACK_VIDEO_BITRATE_KBPS as DEFAULT_VIDEO_BITRATE_KBPS,
  FALLBACK_SEND_WIDTH as DEFAULT_SEND_WIDTH,
  FALLBACK_SEND_HEIGHT as DEFAULT_SEND_HEIGHT,
  FALLBACK_SEND_FPS as DEFAULT_SEND_FPS,
  FALLBACK_CODEC as DEFAULT_CODEC,
  FALLBACK_CONTENT_HINT as DEFAULT_CONTENT_HINT,
  FALLBACK_DEGRADATION_PREFERENCE as DEFAULT_DEGRADATION_PREFERENCE,
  type ShareSource as SharedShareSource,
  type StartShareInput as SharedStartShareInput,
} from "@screenlink/shared";

export type AudioModeValue = "none" | "monitor" | "application";

// Re-export shared types under the same names for existing callers.
// The renderer-local ShareSource narrows displayId/fingerprint from
// optional to required-but-nullable, matching the pre-shared contract.
export type ShareSource = Omit<SharedShareSource, "displayId" | "fingerprint"> & {
  displayId: string | null;
  fingerprint: string | null;
};
export type { SharedStartShareInput as StartShareInput };

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
 * Width 256–3840 px, Height 144–2160 px, FPS 1–60, Bitrate 100–20_000 kbps.
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
    return "Bitrate must be between 100 and 20000 kbps";
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

// ─── Audio mode shared types and helpers ───────────────────────────────────
// Single source of truth consumed by ShareSetup and QuickShareDialog.

export type SourceTab = "screen" | "window";

export interface AudioModeOption {
  value: AudioModeValue;
  label: string;
  description: string;
  icon: React.ReactNode;
}

/**
 * Get audio mode options valid for the given source kind.
 * Screen: No Audio / Filtered Monitor Audio
 * Window: No Audio / Application Audio
 */
export function getAudioModes(sourceKind: SourceTab): AudioModeOption[] {
  const modes: AudioModeOption[] = [
    {
      value: "none",
      label: "No audio",
      description: "No system audio will be shared",
      icon: null as any, // caller assigns icon
    },
  ];
  if (sourceKind === "screen") {
    modes.push({
      value: "monitor",
      label: "Filtered monitor audio",
      description:
        "Audio from your speakers/headphones, filtered to remove echo",
      icon: null as any,
    });
  } else {
    modes.push({
      value: "application",
      label: "Application audio",
      description:
        "Captures audio from the selected source if available",
      icon: null as any,
    });
  }
  return modes;
}

/**
 * Resolve the audio mode for the given source kind, falling back to stored last mode.
 */
export function resolveAudioMode(
  sourceKind: SourceTab,
  currentAudio: AudioModeValue,
  lastScreen: "none" | "monitor",
  lastWindow: "none" | "application",
): AudioModeValue {
  const validModes: AudioModeValue[] =
    sourceKind === "screen" ? ["none", "monitor"] : ["none", "application"];
  if (validModes.includes(currentAudio)) return currentAudio;
  return sourceKind === "screen" ? lastScreen : lastWindow;
}

/**
 * Derive a user-facing error message from the raw fetch-sources error.
 * The returned text is actionable: it tells the user what went wrong
 * and how to fix it, instead of a one-size-fits-all static string.
 *
 * Shared by ShareSetup and QuickShareDialog so both flows produce
 * consistent, context-aware source-error text.
 */
export function deriveSourceErrorText(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message?.toLowerCase() ?? "";
    if (msg.includes("permission") || msg.includes("denied") || msg.includes("not allowed")) {
      return "Screen recording permission was denied. Please allow screen recording in System Settings > Privacy & Security > Screen Recording, then try again.";
    }
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return "Retrieving sources timed out. Check that no other screen-sharing app is running, then retry.";
    }
    if (msg.includes("not found") || msg.includes("cancelled") || msg.includes("cancel")) {
      return "Source selection was cancelled or the source is no longer available. Try again.";
    }
    if (msg.length > 0) {
      return `Failed to retrieve sources: ${err.message}. Make sure screen recording is permitted and try again.`;
    }
  }
  return "Could not retrieve sources. Make sure screen recording is permitted and no other screen-sharing app is blocking access.";
}
