import { contextBridge, ipcRenderer } from "electron";
import type { ScreenLinkAPI } from "./api-types.js";

const api: ScreenLinkAPI = {
  getSources: () => ipcRenderer.invoke("get-sources"),

  // ── Window controls ──────────────────────────────────────────────────────
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
  },
  setSource: (sourceId) => ipcRenderer.invoke("set-source", sourceId),
  getSourceFingerprint: (sourceId) => ipcRenderer.invoke("get-source-fingerprint", sourceId),

  getSettings: () => ipcRenderer.invoke("get-settings"),
  updateSettings: (partial) => ipcRenderer.invoke("update-settings", partial),

  encryptToken: (plaintext) => ipcRenderer.invoke("encrypt-token", plaintext),
  decryptToken: (encrypted) => ipcRenderer.invoke("decrypt-token", encrypted),

  getVdoCredentials: () => ipcRenderer.invoke("get-vdo-credentials"),
  startVdoSession: () => ipcRenderer.invoke("start-vdo-session"),
  stopVdoSession: () => ipcRenderer.invoke("stop-vdo-session"),

  minimizeToTray: () => ipcRenderer.invoke("minimize-to-tray"),

  safeStorageAvailable: () => ipcRenderer.invoke("safe-storage-available"),
  getDeviceIdentity: () => ipcRenderer.invoke("get-device-identity"),
  updateDisplayName: (displayName) => ipcRenderer.invoke("update-display-name", displayName),

  listGroups: () => ipcRenderer.invoke("list-groups"),
  getGroup: (groupId) => ipcRenderer.invoke("get-group", groupId),
  createGroup: (input) => ipcRenderer.invoke("create-group", input),
  joinGroup: (input) => ipcRenderer.invoke("join-group", input),
  getGroupInvite: (groupId) => ipcRenderer.invoke("get-group-invite", groupId),
  updateGroupSharedState: (groupId, state) => ipcRenderer.invoke("update-group-shared-state", groupId, state),
  updateGroupClock: (groupId, stamp) => ipcRenderer.invoke("update-group-clock", groupId, stamp),
  setGroupNotifications: (groupId, enabled) => ipcRenderer.invoke("set-group-notifications", groupId, enabled),
  leaveGroup: (groupId) => ipcRenderer.invoke("leave-group", groupId),
  getGroupConnectionConfig: (groupId) => ipcRenderer.invoke("get-group-connection-config", groupId),

  getStreamHistory: () => ipcRenderer.invoke("get-stream-history"),
  saveStreamHistory: (records) => ipcRenderer.invoke("save-stream-history", records),
  upsertStreamHistory: (record) => ipcRenderer.invoke("upsert-stream-history", record),
  deleteStreamHistory: (historyId) => ipcRenderer.invoke("delete-stream-history", historyId),

  listQualityPresets: () => ipcRenderer.invoke("list-quality-presets"),
  getQualityPreset: (id) => ipcRenderer.invoke("get-quality-preset", id),
  createQualityPreset: (input) => ipcRenderer.invoke("create-quality-preset", input),
  updateQualityPreset: (id, input) => ipcRenderer.invoke("update-quality-preset", id, input),
  duplicateQualityPreset: (id, newName) => ipcRenderer.invoke("duplicate-quality-preset", id, newName),
  deleteQualityPreset: (id) => ipcRenderer.invoke("delete-quality-preset", id),
  exportQualityPreset: (id) => ipcRenderer.invoke("export-quality-preset", id),
  importQualityPreset: (exportString) => ipcRenderer.invoke("import-quality-preset", exportString),

  toggleFullscreen: () => ipcRenderer.invoke("toggle-fullscreen"),
  onFullscreenChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on("fullscreen-state-changed", handler);
    return () => { ipcRenderer.removeListener("fullscreen-state-changed", handler); };
  },

  traySetSharing: (sharing) => ipcRenderer.send("tray-set-sharing", sharing),
  traySetViewing: (viewing) => ipcRenderer.send("tray-set-viewing", viewing),

  getAppInfo: () => ipcRenderer.invoke("get-app-info"),

  probeNvidiaVsrCapability: () => ipcRenderer.invoke("nvidia:probe-capability"),

  getAudioCapabilities: () => ipcRenderer.invoke("get-audio-capabilities"),

  clipboardWriteText: (text: string) => ipcRenderer.invoke("clipboard-write-text", text),

  requestAudioPort: () => ipcRenderer.invoke("request-audio-port"),
  ensureAudioHelper: () => ipcRenderer.invoke("ensure-audio-helper"),
  getAudioState: () => ipcRenderer.invoke("get-audio-state"),
  startSyntheticAudio: (mode) => ipcRenderer.invoke("start-synthetic-audio", mode),
  stopAudio: () => ipcRenderer.invoke("stop-audio"),

  enumerateAudioSessions: () => ipcRenderer.invoke("enumerate-audio-sessions"),
  startApplicationAudio: (options) => ipcRenderer.invoke("start-application-audio", options),
  startFilteredMonitorAudio: (options) => ipcRenderer.invoke("start-filtered-monitor-audio", options),
  startSystemAudio: () => ipcRenderer.invoke("start-system-audio"),
  getMixerState: () => ipcRenderer.invoke("get-mixer-state"),
  getMixerDiagnostics: () => ipcRenderer.invoke("get-mixer-diagnostics"),
  getPipelineSnapshot: () => ipcRenderer.invoke("get-pipeline-snapshot"),

  // ── Updates ──────────────────────────────────────────────────────────────
  getUpdateStatus: () => ipcRenderer.invoke("updates:get-status"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  restartAndInstallUpdate: () => ipcRenderer.invoke("updates:install"),
  checkDownloadAndInstall: () => ipcRenderer.invoke("updates:full-update"),

  // ── Quick Share ──────────────────────────────────────────────────────────
  getQuickShareConfig: () => ipcRenderer.invoke("get-quick-share-config"),
  updateQuickShareConfig: (partial) => ipcRenderer.invoke("update-quick-share-config", partial),
  onQuickShareOpen: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("quick-share:open", handler);
    return () => { ipcRenderer.removeListener("quick-share:open", handler); };
  },

  // Group shortcut config
  getGroupShortcutConfig: (groupId) => ipcRenderer.invoke("get-group-shortcut-config", groupId),
  updateGroupShortcutConfig: (groupId, config) => ipcRenderer.invoke("update-group-shortcut-config", groupId, config),
  validateGroupShortcut: (shortcut, groupId, action, excludeSelf) =>
    ipcRenderer.invoke("validate-group-shortcut", shortcut, groupId, action, excludeSelf),

  // Group shortcut execution events
  onGroupShortcutExecute: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { groupId: string; action: "quick-share" | "quick-join" }) => callback(payload);
    ipcRenderer.on("group-shortcut:execute", handler);
    return () => { ipcRenderer.removeListener("group-shortcut:execute", handler); };
  },

  // ── Tray-originated main-to-renderer events ──────────────────────────────
  onOpenSourcePicker: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("open-source-picker", handler);
    return () => { ipcRenderer.removeListener("open-source-picker", handler); };
  },

  onStopSharing: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("stop-sharing", handler);
    return () => { ipcRenderer.removeListener("stop-sharing", handler); };
  },

  onOpenDiagnostics: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("open-diagnostics", handler);
    return () => { ipcRenderer.removeListener("open-diagnostics", handler); };
  },

  // Video helper
  videoHelperAcquireClient: () => ipcRenderer.invoke("video-helper:acquire-client"),
  videoHelperReleaseClient: (clientId) => ipcRenderer.invoke("video-helper:release-client", clientId),
  videoHelperIsClientActive: (clientId) => ipcRenderer.invoke("video-helper:is-client-active", clientId),
  videoHelperStart: (config) => ipcRenderer.invoke("video-helper:start", config),
  videoHelperStop: (shutdown) => ipcRenderer.invoke("video-helper:stop", shutdown),
  videoHelperReconfigure: (config) => ipcRenderer.invoke("video-helper:reconfigure", config),
  videoHelperSubmitFrame: (generation, frameSequence, frameData, inputWidth, inputHeight) =>
    ipcRenderer.invoke("video-helper:submit-frame", generation, frameSequence, frameData, inputWidth, inputHeight),
  videoHelperFlush: () => ipcRenderer.invoke("video-helper:flush"),
  videoHelperGetState: () => ipcRenderer.invoke("video-helper:get-state"),
  videoHelperGetAppliedConfig: () => ipcRenderer.invoke("video-helper:get-applied-config"),
  requestFramePort: () => ipcRenderer.invoke("request-frame-port"),
  requestFramePortForClient: (clientId) => ipcRenderer.invoke("video-helper:request-frame-port", clientId),

  // Native presenter operations
  nativePresenterAttach: (width, height) => ipcRenderer.invoke("video-helper:attach-presenter", width, height),
  nativePresenterDetach: () => ipcRenderer.invoke("video-helper:detach-presenter"),
  nativePresenterUpdateBounds: (x, y, width, height) => ipcRenderer.invoke("video-helper:update-presenter-bounds", x, y, width, height),
  nativePresenterSetVisible: (visible) => ipcRenderer.invoke("video-helper:set-presenter-visible", visible),
  nativePresenterGetDiagnostics: () => ipcRenderer.invoke("video-helper:get-presenter-diagnostics"),

  // NVIDIA benchmark operations
  nvidiaOpenBenchmarkFolder: () => ipcRenderer.invoke("nvidia:open-benchmark-folder"),
  nvidiaExportBenchmarkResult: (resultId) => ipcRenderer.invoke("nvidia:export-benchmark-result", resultId),
  nvidiaGetBenchmarkResults: () => ipcRenderer.invoke("nvidia:get-benchmark-results"),

  // Discord shortcut simulation
  sendShortcut: (binding) => ipcRenderer.invoke("send-shortcut", binding),

  onUpdateStatusChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, status: any) => callback(status);
    ipcRenderer.on("updates:status-changed", handler);
    return () => { ipcRenderer.removeListener("updates:status-changed", handler); };
  },
};

contextBridge.exposeInMainWorld("screenlink", api);

ipcRenderer.on('pcm:port', (_event: Electron.IpcRendererEvent) => {
  const evt = _event as unknown as { ports?: MessagePort[] };
  const port = evt.ports?.[0];
  if (port) {
    window.postMessage({ type: 'pcm:port' }, '*', [port]);
  }
});

ipcRenderer.on('frame:port', (_event: Electron.IpcRendererEvent) => {
  const evt = _event as unknown as { ports?: MessagePort[] };
  const port = evt.ports?.[0];
  if (port) {
    window.postMessage({ type: 'frame:port' }, '*', [port]);
  }
});
