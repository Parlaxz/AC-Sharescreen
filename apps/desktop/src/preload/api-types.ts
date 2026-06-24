import type { AudioMode } from "@screenlink/shared";

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

  // Device identity
  getDeviceIdentity: () => Promise<{ deviceId: string; displayName: string; createdAt: number }>;
  updateDisplayName: (displayName: string) => Promise<{ deviceId: string; displayName: string; createdAt: number }>;
  safeStorageAvailable: () => Promise<boolean>;

  // Groups
  listGroups: () => Promise<unknown[]>;
  getGroup: (groupId: string) => Promise<unknown | null>;
  createGroup: (input: { groupName: string }) => Promise<unknown>;
  joinGroup: (input: { link: string }) => Promise<unknown>;
  getGroupInvite: (groupId: string) => Promise<{ invite: unknown; link: string } | null>;
  updateGroupSharedState: (groupId: string, state: unknown) => Promise<unknown | null>;
  updateGroupClock: (groupId: string, stamp: unknown) => Promise<void>;
  setGroupNotifications: (groupId: string, enabled: boolean) => Promise<void>;
  leaveGroup: (groupId: string) => Promise<void>;
  getGroupConnectionConfig: (groupId: string) => Promise<unknown | null>;

  // Quality presets
  listQualityPresets: () => Promise<unknown[]>;
  getQualityPreset: (id: string) => Promise<unknown | null>;
  createQualityPreset: (input: { name: string; settings: unknown }) => Promise<unknown>;
  updateQualityPreset: (id: string, input: { name?: string; settings?: unknown }) => Promise<unknown | null>;
  duplicateQualityPreset: (id: string, newName: string) => Promise<unknown | null>;
  deleteQualityPreset: (id: string) => Promise<boolean>;
  exportQualityPreset: (id: string) => Promise<string | null>;
  importQualityPreset: (exportString: string) => Promise<unknown>;

  // Tray
  traySetSharing: (sharing: boolean) => void;
  traySetViewing: (viewing: boolean) => void;

  // Fullscreen (native Electron)
  toggleFullscreen: () => Promise<boolean>;
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void;

  // App info
  getAppInfo: () => Promise<{
    version: string;
    electronVersion: string;
    chromeVersion: string;
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
  deviceIdentity: { deviceId: string; displayName: string; createdAt: number };
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
  validatedLiveSessionsLastScan: number;
  inconsistentIdentitySessionsLastScan: number;
  identityLookupFailuresLastScan: number;
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
  activeSources?: ActiveSourceDiagnostics[];
}

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
  helperBinaryPath?: string;
  helperBinarySize?: number;
  helperBinaryMtime?: string;
}
