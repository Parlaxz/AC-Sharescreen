/**
 * update-ipc.ts
 *
 * Registers IPC handlers for update operations. Keeps ipc-handlers.ts
 * from becoming monolithic. The renderer never imports electron-updater
 * directly — all update interactions flow through these typed IPC calls.
 */

import { ipcMain, BrowserWindow } from "electron";
import type { UpdateManager, UpdateStatus } from "./update-manager.js";

const IPC_CHANNELS = {
  GET_STATUS: "updates:get-status",
  CHECK: "updates:check",
  DOWNLOAD: "updates:download",
  INSTALL: "updates:install",
  STATUS_CHANGED: "updates:status-changed",
} as const;

export { IPC_CHANNELS };

export function registerUpdateIpcHandlers(
  _window: BrowserWindow,
  updateManager: UpdateManager,
): void {
  // ── Get current status ──────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.GET_STATUS, () => {
    return updateManager.getStatus();
  });

  // ── Manually check for updates ──────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CHECK, async () => {
    return await updateManager.checkForUpdates();
  });

  // ── Download the available update ───────────────────────────────────
  // Only allowed when phase is update-available (enforced by the manager)
  ipcMain.handle(IPC_CHANNELS.DOWNLOAD, async () => {
    return await updateManager.downloadUpdate();
  });

  // ── Install the downloaded update ───────────────────────────────────
  // Only allowed when phase is downloaded (enforced by the manager)
  ipcMain.handle(IPC_CHANNELS.INSTALL, () => {
    updateManager.restartAndInstallUpdate();
    return updateManager.getStatus();
  });

  // ── Broadcast status changes to the renderer ────────────────────────
  // This setup function also returns a broadcast callback that should be
  // called by the update manager on every state change.
}

/**
 * Create a safe broadcast callback that sends status updates to the
 * renderer process. Tolerates destroyed windows, reloaded renderers,
 * and temporarily unavailable webContents.
 */
export function createStatusBroadcast(window: BrowserWindow): (status: UpdateStatus) => void {
  return (status: UpdateStatus) => {
    try {
      if (window.isDestroyed()) return;
      if (window.webContents.isDestroyed()) return;
      window.webContents.send(IPC_CHANNELS.STATUS_CHANGED, status);
    } catch {
      // webContents.send can throw if the renderer was just destroyed
    }
  };
}

/**
 * Clean up all update-related IPC handlers.
 */
export function removeUpdateIpcHandlers(): void {
  for (const channel of Object.values(IPC_CHANNELS)) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      // Handler may not be registered
    }
  }
}
