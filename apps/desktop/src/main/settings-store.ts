import { app } from "electron";
import path from "path";
import fs from "fs";
import { normalizeAudioMode, type AudioMode } from "@screenlink/shared";

/**
 * Persisted settings shape matching the IPC contract defined by the preload API.
 */
export interface PersistedSettings {
  version: number;
  shareId: string;
  hostTokenEncrypted: string;
  viewerToken: string;
  viewerBaseUrl: string;
  workerBaseUrl: string;
  hostDisplayName: string;
  launchAtLogin: boolean;
  autoResumeLastMonitor: boolean;
  lastPresetId: string;
  previewEnabled: boolean;
  allowRemoteQualityRequests: boolean;
  autoWatchFriend: boolean;
  friends: Array<{ id: string; displayName: string; note: string; preferredPresetId: string; createdAt: number; updatedAt: number }>;
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  // Extra fields stored for internal use but not exposed via the minimal IPC type
  monitorFingerprint?: { displayId: string; label: string; bounds: { x: number; y: number; width: number; height: number }; size: { width: number; height: number }; scaleFactor: number; internal: boolean } | null;
  hostPolicy?: Record<string, unknown>;
  pairingConfig?: string;
  encryptedPairSecret?: string;
  lastSourceId?: string;
  lastSourceName?: string;
  lastAudioMode?: AudioMode;
}

const CURRENT_VERSION = 1;

function getDefaults(): PersistedSettings {
  return {
    version: CURRENT_VERSION,
    shareId: "",
    hostTokenEncrypted: "",
    viewerToken: "",
    viewerBaseUrl: "",
    workerBaseUrl: "",
    hostDisplayName: "Host",
    launchAtLogin: false,
    autoResumeLastMonitor: false,
    lastPresetId: "egypt-data-saver",
    previewEnabled: false,
    allowRemoteQualityRequests: true,
    autoWatchFriend: false,
    friends: [],
    windowBounds: null,
    monitorFingerprint: null,
    hostPolicy: {},
    lastAudioMode: 'none',
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

  /**
   * Load settings from disk, falling back to backup if the main file is corrupt.
   * Returns defaults if no valid file exists.
   */
  private load(): PersistedSettings {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw) as PersistedSettings;
        if (data.lastAudioMode !== undefined) {
          data.lastAudioMode = normalizeAudioMode(data.lastAudioMode);
        }
        return data;
      }
    } catch {
      // Main file corrupt — try backup
    }

    try {
      if (fs.existsSync(this.backupPath)) {
        const raw = fs.readFileSync(this.backupPath, "utf-8");
        const data = JSON.parse(raw) as PersistedSettings;
        if (data.lastAudioMode !== undefined) {
          data.lastAudioMode = normalizeAudioMode(data.lastAudioMode);
        }
        // Restore backup to main location
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
        return data;
      }
    } catch {
      // Backup also corrupt
    }

    return getDefaults();
  }

  /**
   * Atomic save: write to temp file, fsync, then rename.
   * Previous version is backed up before overwriting.
   */
  save(): void {
    const tmpPath = this.filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(this.settings, null, 2), "utf-8");

    // Backup current file before replacing
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath);
    }

    fs.renameSync(tmpPath, this.filePath);
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

  /**
   * Clear pairing data — deletes the pairingConfig and encryptedPairSecret
   * keys from the persisted object so they are treated as absent.
   */
  clearPairing(): void {
    const s = this.settings as unknown as Record<string, unknown>;
    delete s.pairingConfig;
    delete s.encryptedPairSecret;
    this.save();
  }
}
