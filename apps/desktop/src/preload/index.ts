import { contextBridge, ipcRenderer } from "electron";
import type { ScreenLinkAPI } from "./api-types.js";

const api: ScreenLinkAPI = {
  getSources: () => ipcRenderer.invoke("get-sources"),
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
  createPairing: (displayName) => ipcRenderer.invoke("create-pairing", displayName),
  getPairingLink: () => ipcRenderer.invoke("get-pairing-link"),
  importPairing: (pairingCode) => ipcRenderer.invoke("import-pairing", pairingCode),
  getPairingConfig: () => ipcRenderer.invoke("get-pairing-config"),
  getPairSecret: () => ipcRenderer.invoke("get-pair-secret"),
  updatePairingConfig: (partial) => ipcRenderer.invoke("update-pairing-config", partial),
  updateRemoteIdentity: (deviceId, displayName) => ipcRenderer.invoke("update-remote-identity", deviceId, displayName),
  setPairingLifecycle: (lifecycle) => ipcRenderer.invoke("set-pairing-lifecycle", lifecycle),
  clearPairing: () => ipcRenderer.invoke("clear-pairing"),
  exportCurrentPairing: () => ipcRenderer.invoke("export-current-pairing"),

  // Fullscreen
  toggleFullscreen: () => ipcRenderer.invoke("toggle-fullscreen"),
  onFullscreenChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) =>
      callback(isFullscreen);
    ipcRenderer.on("fullscreen-state-changed", handler);
    return () => {
      ipcRenderer.removeListener("fullscreen-state-changed", handler);
    };
  },

  // Tray
  traySetSharing: (sharing) => ipcRenderer.send("tray-set-sharing", sharing),
  traySetViewing: (viewing) => ipcRenderer.send("tray-set-viewing", viewing),
  traySetFriendName: (name) => ipcRenderer.send("tray-set-friend-name", name),
  traySetFriendSharing: (sharing) => ipcRenderer.send("tray-set-friend-sharing", sharing),

  getAppInfo: () => ipcRenderer.invoke("get-app-info"),

  getAudioCapabilities: () => ipcRenderer.invoke("get-audio-capabilities"),
};

contextBridge.exposeInMainWorld("screenlink", api);
