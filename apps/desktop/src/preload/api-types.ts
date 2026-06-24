import type { Friend, AudioMode } from "@screenlink/shared";

export interface ScreenLinkAPI {
  // Sources
  getSources: () => Promise<CaptureSourceDTO[]>;
  setSource: (sourceId: string) => Promise<void>;
  getSourceFingerprint: (sourceId: string) => Promise<Record<string, unknown> | null>;
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
  requestAudioPort: () => Promise<{ success: boolean; error?: string }>;
  getAudioState: () => Promise<AudioStateDTO>;
  startSyntheticAudio: (mode?: number) => Promise<{ success: boolean; error?: string }>;
  stopAudio: () => Promise<void>;

  // Phase 2E: Audio sessions
  enumerateAudioSessions: () => Promise<any>;
  startApplicationAudio: (options: { sourceId: string }) => Promise<any>;
  startFilteredMonitorAudio: (options?: { excludeDiscord?: boolean; excludeScreenLink?: boolean }) => Promise<any>;
  startSystemAudio: () => Promise<{ success: boolean; streamGeneration?: number; error?: string }>;
  getMixerState: () => Promise<any>;
  getMixerDiagnostics: () => Promise<HelperResponse<FilteredMonitorDiagnostics>>;
  /** Diagnostic pipeline snapshot — collects counters from helper + Electron + bridge */
  getPipelineSnapshot: () => Promise<PipelineSnapshotWithDiagnostics>;
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
  lastAudioMode?: AudioMode;
}

/** Protocol response envelope for helper IPC calls */
export interface HelperResponse<T> {
  protocolVersion: string;
  requestId: number;
  sessionId: string;
  success: boolean;
  state: string;
  result?: T;
  error?: string | null;
}

/** Diagnostics for one active capture source in filtered monitor mode */
export interface ActiveSourceDiagnostics {
  sessionPid: number;
  logicalRootPid: number;
  physicalCaptureTargetPid: number;
  executableName: string;
  inputPackets: number;
  inputNonZeroPackets: number;
  maximumInputPeak: number;
}

/** Filtered Monitor diagnostics returned by getMixerDiagnostics */
export interface FilteredMonitorDiagnostics {
  sourceType: string;
  pipeline: string;
  running: boolean;
  mixerRunning: boolean;
  totalReconciliations: number;
  activeCaptureSources: number;
  sourcesAdded: number;
  sourcesRemoved: number;
  totalSessionsLastScan: number;
  activeSessionsLastScan: number;
  inactiveSessionsLastScan: number;
  desiredSourcesLastScan: number;
  invalidSessionsLastScan: number;
  expiredSessionsLastScan: number;
  systemSoundsSkippedLastScan: number;
  discordExcludedLastScan: number;
  screenLinkExcludedLastScan: number;
  duplicateRootsLastScan: number;
  sourceStartAttempts: number;
  sourceStartFailures: number;
  sourceRetries: number;
  sourceUnexpectedStops: number;
  mixerInputPackets: number;
  mixerInputNonZeroPackets: number;
  mixerInputZeroPackets: number;
  lastInputPeak: number;
  maximumInputPeak: number;
  lastInputRms: number;
  maximumInputRms: number;
  mixerOutputPackets: number;
  mixerOutputNonZeroPackets: number;
  mixerOutputZeroPackets: number;
  lastOutputPeak: number;
  maximumOutputPeak: number;
  lastOutputRms: number;
  maximumOutputRms: number;
  lastErrorCode: string;
  lastErrorMessage: string;
  /** Per-active-source diagnostics */
  activeSources?: ActiveSourceDiagnostics[];
}

/** Pipeline snapshot with inline filtered monitor diagnostics */
export interface PipelineSnapshotWithDiagnostics {
  mixerFeedPackets?: number;
  mixerOutputPackets?: number;
  mixerNonZeroOutputPackets?: number;
  filteredMonitorDiagnostics?: FilteredMonitorDiagnostics;
  endpointDiagnostics?: Record<string, unknown>;
  bridge: Record<string, unknown>;
  helperState: string;
  helperUptimeMs: number;
  streamGeneration: number;
  /** Helper binary provenance (populated by AudioHelperManager) */
  helperBinaryPath?: string;
  helperBinarySize?: number;
  helperBinaryMtime?: string;
}
