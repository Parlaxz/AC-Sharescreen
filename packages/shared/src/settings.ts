import type { Friend, DisplayFingerprint } from "./schemas.js";
import type { AudioMode } from "./audio-capabilities.js";

/**
 * Persisted settings schema for the ScreenLink desktop application.
 * Stored locally (e.g., electron-store or similar).
 */
export interface PersistedSettings {
  /** Schema version for migrations */
  version: number;

  /** The user's permanent share ID */
  shareId: string;

  /** Encrypted host token for authentication */
  hostToken: string;

  /** Viewer token for share link construction */
  viewerToken: string;

  /** Base URL for viewer web app */
  viewerBaseUrl: string;

  /** Base URL for the control worker API */
  workerBaseUrl: string;

  /** Display name shown to viewers */
  hostDisplayName: string;

  /** Whether to auto-launch the app at login */
  launchAtLogin: boolean;

  /** Whether to auto-resume the last monitor on startup */
  autoResumeLastMonitor: boolean;

  /** Fingerprint of the last used monitor, or null if none */
  monitorFingerprint: DisplayFingerprint | null;

  /** ID of the last used quality preset */
  lastPresetId: string;

  /** List of known friends/viewers */
  friends: Friend[];

  /** Host-side policy configuration */
  hostPolicy: Record<string, unknown>;

  /** Last window position and size, or null if not yet set */
  windowBounds: { x: number; y: number; width: number; height: number } | null;

  /** Whether the preview window is enabled */
  previewEnabled: boolean;

  /** Last selected audio mode (persisted across sessions) */
  lastAudioMode?: AudioMode;

  /** Maximum volume percentage for the viewer slider (default 100; can exceed 100 for boost) */
  viewerMaxVolumePercent: number;
}
