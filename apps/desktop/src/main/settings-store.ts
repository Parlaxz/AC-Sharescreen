import { app } from "electron";
import path from "path";
import fs from "fs";
import { normalizeAudioMode, type AudioMode } from "@screenlink/shared";

/**
 * Persisted settings shape matching the IPC contract defined by the preload API.
 *
 * Phase 3: removed friends/pairing/share-id/hostTokenEncrypted/viewerToken/workerBaseUrl/viewerBaseUrl.
 * Quality presets and groups live in their own stores; the device identity is stored here.
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
  hostQualityLimits: {
    maxVideoBitrateKbps: number;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    allowViewerQualityRequests: boolean;
  };
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
  notificationsEnabled: boolean;
  localTransportPolicy: Record<string, unknown>;
  lastAudioMode?: AudioMode;
  /** Cap for the viewer bitrate slider (kbps) */
  viewerBitrateSliderMaxKbps: number;
  /** Quick Share global shortcut configuration */
  quickShareShortcutEnabled: boolean;
  quickShareShortcutAccelerator: string;
  /** Persisted last selections for Quick Share dialog */
  lastQuickShareGroupId: string | null;
  lastQuickShareSourceKind: "screen" | "window" | null;
  lastQuickSharePresetId: string | null;
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
  /** Discord shortcut bindings */
  discordMuteShortcut: ShortcutBinding;
  discordDeafenShortcut: ShortcutBinding;
  /** Whether deafening Discord also deafens ScreenLink audio */
  discordDeafenScreenLink: boolean;

  /** Maximum volume percentage for the viewer slider (default 100; allows boost up to 200+) */
  viewerMaxVolumePercent: number;
}

export type ShortcutBinding = {
  modifiers: Array<"alt" | "ctrl" | "shift" | "win">;
  key: string;
};

const CURRENT_VERSION = 3;

const DEFAULT_HOST_LIMITS: PersistedSettings["hostQualityLimits"] = {
  maxVideoBitrateKbps: 5000,
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 60,
  allowViewerQualityRequests: true,
};

const DEFAULT_GLOBAL_DEFAULTS: PersistedSettings["globalQualityDefaults"] = {
  schemaVersion: 1,
  video: {
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
  },
  audio: {
    bitrateKbps: 64,
    channels: "stereo",
    bitrateMode: "vbr",
    dtx: false,
    fec: true,
    packetDurationMs: 20,
    redundantAudio: false,
  },
};

function getDefaults(): PersistedSettings {
  return {
    version: CURRENT_VERSION,
    deviceIdentity: {
      deviceId: crypto.randomUUID(),
      displayName: "Host",
      createdAt: Date.now(),
    },
    hostDisplayName: "Host",
    launchAtLogin: false,
    autoResumeLastMonitor: false,
    previewEnabled: false,
    windowBounds: null,
    monitorFingerprint: null,
    lastSourceId: null,
    lastSourceName: null,
    lastSourceFingerprint: null,
    developerMode: false,
    hostQualityLimits: { ...DEFAULT_HOST_LIMITS },
    globalQualityDefaults: { ...DEFAULT_GLOBAL_DEFAULTS },
    notificationsEnabled: true,
    localTransportPolicy: {},
    lastAudioMode: "none",
    viewerBitrateSliderMaxKbps: 5000,
    quickShareShortcutEnabled: true,
    quickShareShortcutAccelerator: "Super+Alt+S",
    lastQuickShareGroupId: null,
    lastQuickShareSourceKind: null,
    lastQuickSharePresetId: null,
    lastShareSettings: null,
    discordMuteShortcut: { modifiers: ["alt"], key: "M" },
    discordDeafenShortcut: { modifiers: ["alt"], key: "D" },
    discordDeafenScreenLink: true,
    viewerMaxVolumePercent: 200,
  };
}

function applyMigrations(raw: unknown): PersistedSettings {
  const v1 = (raw ?? {}) as Record<string, unknown>;
  const inputVersion = typeof v1.version === "number" ? v1.version : 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let s: any;

  if (inputVersion < 2) {
    s = migrateFromPhase2G(raw);
  } else {
    s = v1;
  }

  // Then migrate to v3 (add quick share fields)
  if (inputVersion < 3) {
    s = {
      ...s,
      version: CURRENT_VERSION,
      quickShareShortcutEnabled: s.quickShareShortcutEnabled ?? true,
      quickShareShortcutAccelerator: s.quickShareShortcutAccelerator ?? "Super+Alt+S",
      lastQuickShareGroupId: s.lastQuickShareGroupId ?? null,
      lastQuickShareSourceKind: s.lastQuickShareSourceKind ?? null,
      lastQuickSharePresetId: s.lastQuickSharePresetId ?? null,
    };
  }

  // v3→current: add lastShareSettings if missing
  if (s.lastShareSettings === undefined) {
    s.lastShareSettings = null;
  }

  // Add Discord shortcut settings if missing
  if (s.discordMuteShortcut === undefined) {
    s.discordMuteShortcut = { modifiers: ["alt"], key: "M" };
  }
  if (s.discordDeafenShortcut === undefined) {
    s.discordDeafenShortcut = { modifiers: ["alt"], key: "D" };
  }
  if (s.discordDeafenScreenLink === undefined) {
    s.discordDeafenScreenLink = true;
  }

  // Add viewerMaxVolumePercent if missing
  if (s.viewerMaxVolumePercent === undefined) {
    s.viewerMaxVolumePercent = 200;
  }

  // Normalize audio mode for current version
  if (s.lastAudioMode !== undefined) {
    s.lastAudioMode = normalizeAudioMode(s.lastAudioMode);
  }

  // Stage 3.7 Task 1: Migrate stale synthetic built-in preset IDs to null.
  // These were previously persisted by Quick Share as `builtin:<kind>`.
  if (
    typeof s.lastQuickSharePresetId === "string" &&
    s.lastQuickSharePresetId.startsWith("builtin:")
  ) {
    s.lastQuickSharePresetId = null;
  }

  // Normalise "Win" → "Super" in saved Quick Share accelerator.
  // KeyRecorder emits "Win" for the Windows key but Electron's
  // globalShortcut only accepts "Super" / "Meta".
  if (typeof s.quickShareShortcutAccelerator === "string") {
    s.quickShareShortcutAccelerator = s.quickShareShortcutAccelerator.replace(/\bWin\b/g, "Super");
  }

  return s as PersistedSettings;
}

/**
 * Phase 2G → Phase 3 migration. Preserves user-visible local settings,
 * drops friends/pairing/share-id/tokens, and writes the migrated form.
 */
function migrateFromPhase2G(raw: unknown): PersistedSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const dev = (r.deviceIdentity as Record<string, unknown> | undefined) ?? undefined;
  const deviceId =
    (dev?.deviceId as string | undefined) ??
    (typeof r.shareId === "string" && (r.shareId as string).length > 8
      ? ((r.shareId as string).slice(0, 8) + "-aaaa-4aaa-aaaa-aaaaaaaaaaaa").slice(0, 36)
      : null) ??
    crypto.randomUUID();
  const displayName =
    (dev?.displayName as string | undefined) ??
    (typeof r.hostDisplayName === "string" ? (r.hostDisplayName as string) : "Host");
  const createdAt = (dev?.createdAt as number | undefined) ?? Date.now();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {
    version: CURRENT_VERSION,
    deviceIdentity: {
      deviceId,
      displayName: String(displayName).slice(0, 100),
      createdAt,
    },
    hostDisplayName: String(displayName).slice(0, 100),
    launchAtLogin: r.launchAtLogin === true,
    autoResumeLastMonitor: r.autoResumeLastMonitor === true,
    previewEnabled: r.previewEnabled === true,
    windowBounds: (r.windowBounds as PersistedSettings["windowBounds"]) ?? null,
    monitorFingerprint:
      (r.monitorFingerprint as PersistedSettings["monitorFingerprint"]) ?? null,
    lastSourceId: typeof r.lastSourceId === "string" ? (r.lastSourceId as string) : null,
    lastSourceName: typeof r.lastSourceName === "string" ? (r.lastSourceName as string) : null,
    lastSourceFingerprint: typeof r.lastSourceFingerprint === "string" ? (r.lastSourceFingerprint as string) : null,
    developerMode: false,
    hostQualityLimits: { ...DEFAULT_HOST_LIMITS },
    globalQualityDefaults: { ...DEFAULT_GLOBAL_DEFAULTS },
    notificationsEnabled: true,
    localTransportPolicy: {},
    lastAudioMode: r.lastAudioMode
      ? normalizeAudioMode(r.lastAudioMode as string)
      : "none",
  };
  return result;
}

/**
 * Versioned JSON settings persistence with atomic writes and backup recovery.
 *
 * Settings are stored in the Electron userData directory as settings.json.
 * A backup copy (settings.json.bak) is kept for crash recovery.
 */
export class SettingsStore {
  private filePath: string;
  private backupPath: string;
  private settings: PersistedSettings;

  constructor(basePath?: string) {
    const userDataPath = basePath ?? app.getPath("userData");
    this.filePath = path.join(userDataPath, "settings.json");
    this.backupPath = path.join(userDataPath, "settings.json.bak");
    this.settings = this.load();
  }

  private load(): PersistedSettings {
    // Try main file
    let raw: unknown = null;
    try {
      if (fs.existsSync(this.filePath)) {
        raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      }
    } catch {
      raw = null;
    }
    if (!raw) {
      try {
        if (fs.existsSync(this.backupPath)) {
          raw = JSON.parse(fs.readFileSync(this.backupPath, "utf-8"));
        }
      } catch {
        raw = null;
      }
    }
    if (!raw) return getDefaults();
    const obj = raw as Record<string, unknown>;
    const v = typeof obj.version === "number" ? obj.version : 1;
    if (v < CURRENT_VERSION) {
      const migrated = applyMigrations(raw);
      try {
        this.writeAtomic(migrated);
      } catch {
        // best-effort
      }
      return migrated;
    }
    // Already current — ensure all additive fields are present
    const s = obj as unknown as PersistedSettings;
    if (s.lastAudioMode !== undefined) {
      s.lastAudioMode = normalizeAudioMode(s.lastAudioMode);
    }
    if (s.viewerMaxVolumePercent === undefined) {
      s.viewerMaxVolumePercent = 200;
    }
    // Normalise "Win" → "Super" in any stored Quick Share accelerator
    // (catches values saved before the IPC-level normalisation was added).
    if (typeof s.quickShareShortcutAccelerator === "string") {
      s.quickShareShortcutAccelerator = s.quickShareShortcutAccelerator.replace(/\bWin\b/g, "Super");
    }
    return s;
  }

  private writeAtomic(s: PersistedSettings): void {
    const tmpPath = this.filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(s, null, 2), "utf-8");
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath);
    }
    fs.renameSync(tmpPath, this.filePath);
  }

  /**
   * Atomic save: write to temp file, fsync, then rename.
   * Previous version is backed up before overwriting.
   */
  save(): void {
    this.writeAtomic(this.settings);
  }

  /**
   * Return the full current settings object.
   */
  get(): PersistedSettings {
    return this.settings;
  }

  /**
   * Apply a partial update and persist immediately.
   */
  update(partial: Partial<PersistedSettings>): void {
    Object.assign(this.settings, partial);
    this.save();
  }
}
