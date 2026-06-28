import { contextBridge, ipcRenderer } from "electron";
import type { ScreenLinkAPI } from "./api-types.js";

const api: ScreenLinkAPI = {
  getSources: () => ipcRenderer.invoke("get-sources"),

  // â”€â”€ Window controls (Stage 3.7B) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  getAudioCapabilities: () => ipcRenderer.invoke("get-audio-capabilities"),

  /**
   * Write text to the OS clipboard via the main process. Bypasses
   * the renderer's `navigator.clipboard.writeText` which is often
   * blocked in Electron with "Write permission denied".
   */
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

  // â”€â”€ Updates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  getUpdateStatus: () => ipcRenderer.invoke("updates:get-status"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  restartAndInstallUpdate: () => ipcRenderer.invoke("updates:install"),
  checkDownloadAndInstall: () => ipcRenderer.invoke("updates:full-update"),

  // â”€â”€ Quick Share â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  getQuickShareConfig: () => ipcRenderer.invoke("get-quick-share-config"),
  updateQuickShareConfig: (partial) => ipcRenderer.invoke("update-quick-share-config", partial),
  onQuickShareOpen: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("quick-share:open", handler);
    return () => { ipcRenderer.removeListener("quick-share:open", handler); };
  },

  // â”€â”€ Tray-originated mainâ†’renderer events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

