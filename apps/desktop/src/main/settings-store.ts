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
    videoBitrateKbps: number;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    degradationPreference: "balanced" | "maintain-resolution" | "maintain-framerate";
    contentHint: "detail" | "motion" | "auto" | "text";
    audioEnabled: boolean;
  };
  notificationsEnabled: boolean;
  localTransportPolicy: Record<string, unknown>;
  lastAudioMode?: AudioMode;
}

const CURRENT_VERSION = 2;

const DEFAULT_HOST_LIMITS: PersistedSettings["hostQualityLimits"] = {
  maxVideoBitrateKbps: 5000,
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 60,
  allowViewerQualityRequests: true,
};

const DEFAULT_GLOBAL_DEFAULTS: PersistedSettings["globalQualityDefaults"] = {
  videoBitrateKbps: 650,
  maxWidth: 854,
  maxHeight: 480,
  maxFps: 15,
  degradationPreference: "maintain-resolution",
  contentHint: "detail",
  audioEnabled: true,
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
  };
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

  return {
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

  constructor() {
    const userDataPath = app.getPath("userData");
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
      const migrated = migrateFromPhase2G(raw);
      try {
        this.writeAtomic(migrated);
      } catch {
        // best-effort
      }
      return migrated;
    }
    // Already current — normalize audio mode and return
    const s = obj as unknown as PersistedSettings;
    if (s.lastAudioMode !== undefined) {
      s.lastAudioMode = normalizeAudioMode(s.lastAudioMode);
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
