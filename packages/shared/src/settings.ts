import type { AudioMode } from "./audio-capabilities.js";
import type { ShortcutBinding } from "./shortcuts.js";
import { createDefaultHostQualityLimits, createDefaultGroupQualitySettings } from "./quality-settings.js";

/** Update channel preference. Beta opts into prerelease builds. */
export type UpdateChannel = "stable" | "beta";

/**
 * Persisted settings schema for the ScreenLink desktop application.
 * Stored locally (e.g., electron-store). This is the canonical shared
 * contract between main, preload, and renderer. Migration logic lives
 * in main; this type represents the latest schema version's shape.
 */
export interface PersistedSettings {
  version: number;
  deviceIdentity: {
    deviceId: string;
    displayName: string;
    createdAt: number;
  };
  hostDisplayName: string;
  launchAtLogin: boolean;
  autoResumeLastMonitor: boolean;
  previewEnabled: boolean;
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  monitorFingerprint: {
    displayId: string;
    label: string;
    bounds: { x: number; y: number; width: number; height: number };
    size: { width: number; height: number };
    scaleFactor: number;
    internal: boolean;
  } | null;
  lastSourceId: string | null;
  lastSourceName: string | null;
  lastSourceFingerprint: string | null;
  developerMode: boolean;
  notificationsEnabled: boolean;
  localTransportPolicy: Record<string, unknown>;
  lastAudioMode?: AudioMode;
  /** Cap for the viewer bitrate slider (kbps) */
  viewerBitrateSliderMaxKbps: number;
  /** Maximum volume percentage for the viewer slider */
  viewerMaxVolumePercent: number;
  /** Quick Share shortcut enabled state */
  quickShareShortcutEnabled: boolean;
  /** Quick Share shortcut accelerator string */
  quickShareShortcutAccelerator: string;
  /** Persisted last selections for Quick Share dialog */
  lastQuickShareGroupId: string | null;
  lastQuickShareSourceKind: "screen" | "window" | null;
  lastQuickSharePresetId: string | null;
  /** Shortcut bindings */
  discordMuteShortcut: ShortcutBinding;
  discordDeafenShortcut: ShortcutBinding;
  discordDeafenScreenLink: boolean;
  /** Host quality limits */
  hostQualityLimits: {
    maxVideoBitrateKbps: number;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    allowViewerQualityRequests: boolean;
  };
  /** Global quality defaults */
  globalQualityDefaults: {
    schemaVersion: 1;
    video: {
      videoBitrateKbps: number;
      sendWidth: number;
      sendHeight: number;
      sendFps: number;
      captureWidth: number;
      captureHeight: number;
      captureFps: number;
      preserveAspectRatio: boolean;
      preventUpscale: boolean;
      resolutionMode: "target-dimensions" | "scale-factor";
      scaleResolutionDownBy: number;
      codec: "auto" | "vp9" | "av1" | "h264" | "vp8";
      h264Profile: "auto" | "baseline" | "main" | "high";
      contentHint: "auto" | "text" | "detail" | "motion";
      degradationPreference: "balanced" | "maintain-resolution" | "maintain-framerate";
      scalabilityMode: string | null;
      cursorMode: "always" | "motion" | "never";
      rtpPriority: "very-low" | "low" | "medium" | "high";
    };
    audio: {
      bitrateKbps: number;
      channels: "mono" | "stereo";
      bitrateMode: "vbr" | "cbr";
      dtx: boolean;
      fec: boolean;
      packetDurationMs: 10 | 20 | 40 | 60;
      redundantAudio: boolean;
    };
  };
  /** Last successful share settings for "Use last settings" restoration */
  lastShareSettings: {
    groupId: string;
    sourceKind: "screen" | "window";
    sourceId: string;
    sourceName: string;
    audioMode: "none" | "monitor" | "application";
    selectedPresetId: string | null;
    customQuality: {
      resolutionValue: string;
      customWidth: number;
      customHeight: number;
      fps: number;
      bitrate: number;
      codec: string;
      contentHint: string;
      degradationPreference: string;
    };
  } | null;
  /** NVIDIA enhancement settings */
  viewerImageEnhancementSettings: Record<string, unknown> | null;
  lastNvidiaProcessingMode: string;
  lastNvidiaQuality: string;
  /** Bandwidth graph estimation window (ms) */
  hourlyEstimateDurationMs: number;
  /** Stream info card overlay configuration */
  streamInfoCard: StreamInfoCardConfig;
  /** Show compare controls in the viewer */
  showCompareControls: boolean;
  /** Update channel preference ("stable" | "beta"); absent = stable */
  updateChannel?: UpdateChannel;
}

/**
 * Configuration for the stream info card overlay on the viewer.
 */
export interface StreamInfoCardConfig {
  visible: boolean;
  showResolution: boolean;
  showFps: boolean;
  showBitrate: boolean;
  showDroppedFrames: boolean;
  showNetworkUsage: boolean;
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  fontSize: number;
  textColor: string;
  boxOpacity: number;
  boxWidth: number;
}

// ─── Default factories (Phase 3: single shared authority) ─────────────────

/** Create default host quality limits. Delegates to createDefaultHostQualityLimits(). */
export function defaultHostQualityLimits(): PersistedSettings["hostQualityLimits"] {
  return { ...createDefaultHostQualityLimits() };
}

/** Create default global quality defaults. Delegates to createDefaultGroupQualitySettings(). */
export function defaultGlobalQualityDefaults(): PersistedSettings["globalQualityDefaults"] {
  return { ...createDefaultGroupQualitySettings() };
}

/** Default StreamInfoCard config. */
export function defaultStreamInfoCard(): StreamInfoCardConfig {
  return {
    visible: false,
    showResolution: true,
    showFps: true,
    showBitrate: true,
    showDroppedFrames: true,
    showNetworkUsage: true,
    position: "top-right",
    fontSize: 12,
    textColor: "#ffffff",
    boxOpacity: 60,
    boxWidth: 200,
  };
}

/** Default Quick Share shortcut accelerator string. */
export function defaultQuickShareAccelerator(): string {
  return "Super+Alt+S";
}

/** Default Discord mute shortcut binding. */
export function defaultDiscordMuteShortcut(): import("./shortcuts.js").ShortcutBinding {
  return { modifiers: ["alt"], key: "M" };
}

/** Default Discord deafen shortcut binding. */
export function defaultDiscordDeafenShortcut(): import("./shortcuts.js").ShortcutBinding {
  return { modifiers: ["alt"], key: "D" };
}

/** Default viewer bitrate slider max (kbps). */
export function defaultViewerBitrateSliderMaxKbps(): number {
  return 5000;
}

/** Default viewer max volume percent. */
export function defaultViewerMaxVolumePercent(): number {
  return 200;
}

/** Default NVIDIA processing mode. */
export function defaultNvidiaProcessingMode(): string {
  return "vsr";
}

/** Default NVIDIA quality level. */
export function defaultNvidiaQuality(): string {
  return "high";
}

/** Default hourly estimate window (ms). */
export function defaultHourlyEstimateDurationMs(): number {
  return 10_000;
}

/** Default showCompareControls value. */
export function defaultShowCompareControls(): boolean {
  return false;
}

/** Default update channel. */
export function defaultUpdateChannel(): UpdateChannel {
  return "stable";
}
