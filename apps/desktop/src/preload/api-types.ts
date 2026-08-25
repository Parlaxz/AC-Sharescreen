import type { GroupSharedState, HybridTimestamp, NativePresenterDiagnostics, ShortcutBinding, PersistedSettings } from "@screenlink/shared";

export interface ScreenLinkAPI {
  /** E2E test flag — true only when the app runs with SCREENLINK_E2E=1. */
  readonly __e2eEnabled?: boolean;
  showStreamToast: (payload: StreamToastPayload) => Promise<{ shown: boolean; reason?: string }>;
  onStreamToastAction: (callback: (action: StreamToastActionEvent) => void) => () => void;
  // Sources
  getSources: () => Promise<CaptureSourceDTO[]>;
  setSource: (sourceId: string | null) => Promise<void>;
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
  listGroups: () => Promise<GroupRecordDTO[]>;
  getGroup: (groupId: string) => Promise<GroupRecordDTO | null>;
  createGroup: (input: { groupName: string }) => Promise<CreateGroupResponseDTO>;
  joinGroup: (input: { link: string }) => Promise<GroupRecordDTO>;
  getGroupInvite: (groupId: string) => Promise<{ link: string } | null>;
  updateGroupSharedState: (groupId: string, state: unknown) => Promise<unknown | null>;
  updateGroupClock: (groupId: string, stamp: unknown) => Promise<void>;
  setGroupNotifications: (groupId: string, enabled: boolean) => Promise<void>;
  leaveGroup: (groupId: string) => Promise<void>;
  getGroupConnectionConfig: (groupId: string) => Promise<GroupConnectionConfigDTO | null>;

  // Stream history
  getStreamHistory: () => Promise<unknown[]>;
  saveStreamHistory: (records: unknown[]) => Promise<void>;
  upsertStreamHistory: (record: unknown) => Promise<void>;
  deleteStreamHistory: (historyId: string) => Promise<void>;

  // Quality presets
  listQualityPresets: () => Promise<unknown[]>;
  getQualityPreset: (id: string) => Promise<unknown | null>;
  createQualityPreset: (input: { name: string; settings: unknown; showInViewerPanel?: boolean; viewerPanelSlot?: number | null }) => Promise<unknown>;
  updateQualityPreset: (id: string, input: { name?: string; settings?: unknown; showInViewerPanel?: boolean; viewerPanelSlot?: number | null }) => Promise<unknown | null>;
  duplicateQualityPreset: (id: string, newName: string) => Promise<unknown | null>;
  deleteQualityPreset: (id: string) => Promise<boolean>;
  exportQualityPreset: (id: string) => Promise<string | null>;
  importQualityPreset: (exportString: string) => Promise<unknown>;

  // Tray
  traySetSharing: (sharing: boolean) => void;
  traySetViewing: (viewing: boolean) => void;
  traySetViewerCount: (count: number) => void;

  // Fullscreen (native Electron)
  toggleFullscreen: () => Promise<boolean>;
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void;

  // Quit lifecycle: main asks the renderer to release runtime state before teardown
  onPrepareQuit: (callback: () => void) => () => void;

  // Deep links (screenlink://group?... invite URLs routed via main)
  getPendingDeepLinks: () => Promise<string[]>;
  onDeepLinkJoin: (callback: (url: string) => void) => () => void;

  // App info
  getAppInfo: () => Promise<{
    version: string;
    electronVersion: string;
    chromeVersion: string;
    nodeVersion?: string;
  }>;

  /**
   * Write text to the OS clipboard via the main process. Bypasses
   * the renderer's `navigator.clipboard.writeText` which is often
   * blocked in Electron with "Write permission denied".
   */
  clipboardWriteText: (text: string) => Promise<{ success: boolean; length: number }>;

  // Window controls (Stage 3.7B)
  windowControls: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
  };

  // NVIDIA RTX VSR capability detection
  probeNvidiaVsrCapability: () => Promise<{
    available: boolean;
    reason: string;
    adapterName?: string;
    driverVersion?: string;
  }>;

  // NVIDIA benchmark operations
  nvidiaOpenBenchmarkFolder: () => Promise<boolean>;
  nvidiaSaveBenchmarkResult: (record: NvidiaBenchmarkResultRecord) => Promise<{ success: boolean; id?: string; error?: string }>;
  nvidiaExportBenchmarkResult: (resultId: string) => Promise<string | null>;
  nvidiaGetBenchmarkResults: () => Promise<NvidiaBenchmarkResultRecord[]>;
  nvidiaRunBenchmark: (config: NvidiaBenchmarkConfig) => Promise<{ success: boolean; error?: string; targetFrames?: number }>;
  nvidiaGetBenchmarkStatus: () => Promise<NvidiaBenchmarkStatusResponse | null>;
  nvidiaCancelBenchmark: () => Promise<boolean>;
  nvidiaGetBenchmarkAggregateResults: () => Promise<NvidiaBenchmarkAggregateResult | null>;

  // Audio capabilities
  getAudioCapabilities: () => Promise<{
    success: boolean;
    data?: import("@screenlink/shared").AudioCapabilityResult;
    error?: { code: string; message: string };
  }>;

  // Audio pipeline
  requestAudioPort: () => Promise<{ success: boolean; error?: string }>;
  ensureAudioHelper: () => Promise<{ success: boolean; error?: string }>;
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

  // Quick Share
  getQuickShareConfig: () => Promise<QuickShareConfigDTO>;
  updateQuickShareConfig: (partial: Partial<QuickShareConfigDTO>) => Promise<void>;
  onQuickShareOpen: (callback: () => void) => () => void;

  // Tray-originated main→renderer events
  onOpenSourcePicker: (callback: () => void) => () => void;
  onStopSharing: (callback: () => void) => () => void;
  onStopWatching: (callback: () => void) => () => void;
  onOpenDiagnostics: (callback: () => void) => () => void;

  // Group shortcut config
  getGroupShortcutConfig: (groupId: string) => Promise<GroupShortcutConfigDTO>;
  updateGroupShortcutConfig: (groupId: string, config: Partial<GroupShortcutConfigDTO>) => Promise<GroupShortcutConfigDTO>;
  validateGroupShortcut: (shortcut: string, groupId: string, action: "quick-share" | "quick-join", excludeSelf?: boolean) => Promise<ShortcutValidationDTO>;

  // Group shortcut execution events
  onGroupShortcutExecute: (callback: (payload: { groupId: string; action: "quick-share" | "quick-join" }) => void) => () => void;

  // Discord shortcut simulation
  sendShortcut: (binding: ShortcutBinding) => Promise<{ success: boolean; error?: string }>;

  // Video helper
  videoHelperAcquireClient: () => Promise<{ clientId: string }>;
  videoHelperReleaseClient: (clientId: string) => Promise<{ success: boolean }>;
  videoHelperIsClientActive: (clientId: string) => Promise<boolean>;
  videoHelperStart: (config: VideoHelperConfig) => Promise<VideoHelperStartResult>;
  videoHelperStop: (shutdown?: boolean) => Promise<void>;
  videoHelperReconfigure: (config: VideoHelperConfig) => Promise<VideoHelperStartResult>;
  videoHelperSubmitFrame: (generation: number, frameSequence: number, frameData: Uint8Array, inputWidth: number, inputHeight: number) => Promise<{
    generation: number;
    sequence: number;
    pixels: Uint8Array;
    width: number;
    height: number;
    configurationId?: number;
    appliedQualityLevel?: number;
    mainInputHandlingMs?: number;
    requestWriteMs?: number;
    responseWaitMs?: number;
    mainHandlerTotalMs?: number;
    nativeInputReceiveMs?: number;
    nativeUploadMs?: number;
    nativeEffectMs?: number;
    nativeDownloadMs?: number;
    nativePreWriteTotalMs?: number;
  } | null>;
  videoHelperFlush: () => Promise<boolean>;
  videoHelperGetState: () => Promise<string>;
  videoHelperGetAppliedConfig: () => Promise<import("@screenlink/shared").AppliedNvidiaConfig | null>;
  videoHelperGetDiagnostics: () => Promise<Record<string, unknown> | null>;
  /** Phase 5: Request a dedicated MessagePort for zero-copy frame data transfer.
   *  The port arrives asynchronously via window `message` event with type `frame:port`. */
  requestFramePort: () => Promise<{ success: boolean }>;
  /** Phase 6: Request a frame port bound to a specific clientId lease. */
  requestFramePortForClient: (clientId: string) => Promise<{ success: boolean; error?: string }>;

  // Slice 5: Renderer-owned shared input slots for zero-copy frame transport
  rendererSlotsRegister: (slots: SharedArrayBuffer[]) => Promise<{ success: boolean }>;
  rendererSlotsRelease: () => Promise<{ success: boolean }>;

  // Native presenter operations
  nativePresenterAttach: (width: number, height: number) => Promise<{ success: boolean }>;
  nativePresenterDetach: () => Promise<{ success: boolean }>;
  nativePresenterUpdateBounds: (x: number, y: number, width: number, height: number) => Promise<{ success: boolean }>;
  nativePresenterSetVisible: (visible: boolean) => Promise<{ success: boolean }>;
  nativePresenterGetDiagnostics: () => Promise<{ success: boolean; diagnostics?: NativePresenterDiagnostics | null; error?: string }>;

  // NativePresenterDiagnostics is imported from @screenlink/shared above

  // External links
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

  // Log folder
  openLogFolder: () => Promise<{ success: boolean; error?: string }>;

  /**
   * Read recent application log files from the userData/logs directory.
   * Returns typed success/data/error with byte/line counts and truncation flag.
   * Never accepts an arbitrary path — always reads from the app's log directory.
   */
  readRecentLogs: () => Promise<ReadRecentLogsResult>;

  // Updates
  getUpdateStatus: () => Promise<UpdateStatusDTO>;
  checkForUpdates: () => Promise<UpdateStatusDTO>;
  downloadUpdate: () => Promise<UpdateStatusDTO>;
  restartAndInstallUpdate: () => Promise<UpdateStatusDTO>;
  checkDownloadAndInstall: () => Promise<UpdateStatusDTO>;
  setUpdateChannel: (channel: "stable" | "beta") => Promise<UpdateStatusDTO>;
  onUpdateStatusChanged: (callback: (status: UpdateStatusDTO) => void) => () => void;
}

export interface StreamToastPayload {
  groupId: string;
  hostDeviceId: string;
  logicalStreamId: string;
  hostName: string;
  groupName: string;
}

export interface StreamToastActionEvent {
  action: "join" | "dismiss";
  payload: StreamToastPayload;
}

// ─── Quick Share types ───────────────────────────────────────────────────────

// ─── Group IPC response DTOs ───────────────────────────────────────────

/**
 * Record returned from createGroup / joinGroup / listGroups / getGroup IPC
 * handlers. Mirrors the main-process `LocalGroupRecord` from `group-store.ts`.
 *
 * `encryptedGroupSecret` is the safe-to-serialize ciphertext form — the
 * decrypted group secret is never exposed through this DTO.
 */
export interface GroupRecordDTO {
  groupId: string;
  controlRoomId: string;
  encryptedGroupSecret: string;
  sharedState: GroupSharedState;
  lastClock: HybridTimestamp;
  joinedAt: number;
  notificationsEnabled: boolean;
  creatorDeviceId?: string;
}

/**
 * Shape returned by createGroup IPC handler:
 *   { record, invite, link }
 */
export interface CreateGroupResponseDTO {
  record: GroupRecordDTO;
  invite: string;
  link: string;
}

/**
 * Shape returned by getGroupConnectionConfig IPC handler.
 * Mirrors the main-process `GroupConnectionConfig` from `group-store.ts`.
 */
export interface GroupConnectionConfigDTO {
  groupId: string;
  controlRoomId: string;
  groupSecret: string;
  nodeId: string;
}

// ─── Quick Share types ─────────────────────────────────────────────────

export interface QuickShareConfigDTO {
  shortcutEnabled: boolean;
  shortcutAccelerator: string;
  lastGroupId: string | null;
  lastSourceKind: "screen" | "window" | null;
  lastPresetId: string | null;
}

// ── Video helper typed config and result (replaces Record<string, unknown>) ──

export type VideoHelperProcessingMode = "vsr" | "high-bitrate" | "denoise" | "deblur";
export type VideoHelperQualityLevel = "low" | "medium" | "high" | "ultra";
export type VideoHelperPixelFormat = "bgra8" | "rgba8";

export interface VideoHelperConfig {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  processingMode: VideoHelperProcessingMode;
  qualityLevel: VideoHelperQualityLevel;
  pixelFormat: VideoHelperPixelFormat;
}

export interface VideoHelperStartResult {
  success: boolean;
  error?: string;
  appliedConfig?: import("@screenlink/shared").AppliedNvidiaConfig;
}

// ── NVIDIA benchmark types ───────────────────────────────────────────────────

export type NvidiaBenchmarkStatus = "idle" | "running" | "completed" | "failed";

export interface NvidiaBenchmarkConfig {
  processingMode: VideoHelperProcessingMode;
  qualityLevel: VideoHelperQualityLevel;
  inputWidth: number;
  inputHeight: number;
  frames: number;
  /** Maximum time per frame in ms before the frame is considered dropped */
  frameTimeoutMs?: number;
}

export interface NvidiaBenchmarkResultRecord {
  id: string;
  config: NvidiaBenchmarkConfig;
  status: NvidiaBenchmarkStatus;
  startedAt: number;
  completedAt?: number;
  framesProcessed: number;
  framesDropped: number;
  framesFailed: number;
  avgProcessingTimeMs: number;
  minProcessingTimeMs: number;
  maxProcessingTimeMs: number;
  p50ProcessingTimeMs: number;
  p95ProcessingTimeMs: number;
  p99ProcessingTimeMs: number;
  avgFps: number;
  avgNativeInputReceiveMs?: number;
  avgNativeUploadMs?: number;
  avgNativeEffectMs?: number;
  avgNativeDownloadMs?: number;
  /** Path to the exported result file, if exported */
  exportedPath?: string;
  /** Error message if status is "failed" */
  error?: string;
}

/**
 * Response from the native benchmarkStatus command.
 */
export interface NvidiaBenchmarkStatusResponse {
  benchmarkActive: boolean;
  benchmarkTargetFrames: number;
  benchmarkFramesCompleted: number;
  benchmarkTotalTimeUs: number;
  benchmarkAvgTimeUs?: number;
  benchmarkComplete?: boolean;
}

/**
 * Aggregated benchmark result from the native helper (benchmarkGetResults).
 */
export interface NvidiaBenchmarkAggregateResult {
  success: boolean;
  error?: string;
  framesProcessed: number;
  framesDropped: number;
  framesFailed: number;
  totalTimeUs: number;
  avgTimeUs: number;
  minTimeUs: number;
  maxTimeUs: number;
  avgInputReceiveUs: number;
  avgUploadUs: number;
  avgEffectUs: number;
  avgDownloadUs: number;
  avgOutputWriteUs: number;
  avgFps: number;
}

// ── Per-group shortcut config types ──────────────────────────────────────────

export interface GroupShortcutConfigDTO {
  quickShareShortcut: string | null;
  quickJoinShortcut: string | null;
  quickShareSource: {
    id: string;
    name: string;
    kind: "screen" | "window";
    displayId: string | null;
  } | null;
  quickShareDefaultPresetId: string | null;
}

export interface ShortcutValidationDTO {
  valid: boolean;
  error?: string;
  normalized: string;
}

// ─── Update types ─────────────────────────────────────────────────────────

export type UpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface UpdateStatusDTO {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  downloadedVersion?: string;
  checkStartedAt?: number;
  lastCheckedAt?: number;
  downloadPercent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  userMessage: string;
  errorCode?: string;
  errorMessage?: string;
  isPackaged: boolean;
  isPortable: boolean;
  updaterSupported: boolean;
  /** Active update channel. Optional so older main processes stay compatible. */
  channel?: "stable" | "beta";
}

// ─── Existing types ────────────────────────────────────────────────────────

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

// StreamInfoCardConfig imported from @screenlink/shared (Phase 3).
// PersistedSettings is now imported from @screenlink/shared
// The local duplicate definition has been removed in Phase 3.

/** Result from readRecentLogs IPC call */
export interface ReadRecentLogsResult {
  success: boolean;
  data: string;
  byteCount: number;
  lineCount: number;
  truncated: boolean;
  error?: string;
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

