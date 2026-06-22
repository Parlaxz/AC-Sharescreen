import type { Friend } from "@screenlink/shared";

export interface ScreenLinkAPI {
  // Sources
  getSources: () => Promise<CaptureSourceDTO[]>;
  setSource: (sourceId: string) => Promise<void>;
  getSourceFingerprint: (sourceId: string) => Promise<Record<string, unknown> | null>;
  /** Resolve a window source ID to its process PID. */
  resolveSourcePid: (sourceId: string) => Promise<{ success: boolean; pid?: number; hwnd?: number; error?: string }>;

  // Settings
  getSettings: () => Promise<PersistedSettings>;
  updateSettings: (partial: Record<string, unknown>) => Promise<void>;

  // Secure storage
  encryptToken: (plaintext: string) => Promise<string | null>;
  decryptToken: (encrypted: string) => Promise<string | null>;

  // VDO session (LAN testing)
  getVdoCredentials: () => Promise<{ streamId: string; password: string }>;
  startVdoSession: () => Promise<{ streamId: string; password: string }>;
  stopVdoSession: () => Promise<void>;

  // Window
  minimizeToTray: () => Promise<void>;

  // Pairing
  safeStorageAvailable: () => Promise<boolean>;
  createPairing: (displayName: string) => Promise<{
    pairingCode: string;
    pairingLink: string;
    pairId: string;
    deviceId: string;
    displayName: string;
    exportData: Record<string, unknown>;
  }>;
  /** Get the pending pairing link while in PAIR_CREATED_WAITING_FOR_IMPORT state */
  getPairingLink: () => Promise<string | null>;
  importPairing: (pairingCode: string) => Promise<{ deviceId: string; remoteName: string }>;
  getPairingConfig: () => Promise<Record<string, unknown> | null>;
  getPairSecret: () => Promise<string | null>;
  updatePairingConfig: (partial: Record<string, unknown>) => Promise<void>;
  /**
   * Persist the remote identity (device ID + display name) after a peer.hello
   * handshake and transition lifecycle accordingly.
   * Returns the authoritative acceptance result with current lifecycle state.
   */
  updateRemoteIdentity: (remoteDeviceId: string, remoteDisplayName: string) => Promise<{
    accepted: boolean;
    pairingLifecycle?: string;
    remoteDeviceId?: string;
    remoteDisplayName?: string;
    reason?: string;
  }>;
  /** Set the pairing lifecycle in persisted config (e.g. "PAIRED_OFFLINE"). */
  setPairingLifecycle: (lifecycle: string) => Promise<void>;
  clearPairing: () => Promise<void>;
  /** Export the current pairing as a PairingExport object, or null if not available */
  exportCurrentPairing: () => Promise<Record<string, unknown> | null>;

  // Tray
  traySetSharing: (sharing: boolean) => void;
  traySetViewing: (viewing: boolean) => void;
  traySetFriendName: (name: string) => void;
  traySetFriendSharing: (sharing: boolean) => void;

  // Fullscreen (native Electron)
  toggleFullscreen: () => Promise<boolean>;
  /**
   * Register a callback for native fullscreen state changes.
   * Returns a cleanup function to remove the listener.
   */
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void;

  // App info
  getAppInfo: () => Promise<{
    version: string;
    electronVersion: string;
    chromeVersion: string;
    nodeVersion: string;
  }>;

  // Audio capabilities
  getAudioCapabilities: () => Promise<{
    success: boolean;
    data?: import("@screenlink/shared").AudioCapabilityResult;
    error?: { code: string; message: string };
  }>;

  // Audio pipeline
  requestAudioPort: () => Promise<void>;
  getAudioState: () => Promise<AudioStateDTO>;
  startSyntheticAudio: (mode?: number) => Promise<void>;
  stopAudio: () => Promise<void>;

  // Phase 2E: Audio sessions
  enumerateAudioSessions: () => Promise<any>;
  startApplicationAudio: (options: { targetPid: number; expectedCreationTimeUtc100ns: number }) => Promise<any>;
  startFilteredMonitorAudio: (options?: { excludeDiscord?: boolean; excludeScreenLink?: boolean }) => Promise<any>;
  getMixerState: () => Promise<any>;
  getMixerDiagnostics: () => Promise<any>;
}

export type AudioStateDTO =
  | "disabled"
  | "starting-helper"
  | "connecting-transport"
  | "loading-worklet"
  | "buffering"
  | "primed"
  | "track-ready"
  | "publishing"
  | "active"
  | "stopping"
  | "error";

export interface CaptureSourceDTO {
  id: string;
  name: string;
  displayId: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

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
  lastSourceFingerprint: string;
  previewEnabled: boolean;
  allowRemoteQualityRequests: boolean;
  autoWatchFriend: boolean;
  friends: Friend[];
  windowBounds: { x: number; y: number; width: number; height: number } | null;
}
