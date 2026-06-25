import { app } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { registerPrivilegedSchemes, registerAppProtocol } from "./protocol.js";
import { setupSingleInstance, getDevProfile } from "./app-lifecycle.js";
import { WindowManager } from "./window-manager.js";
import { TrayManager } from "./tray-manager.js";
import type { TrayMenuActions } from "./tray-manager.js";
import { registerDisplayMediaHandler } from "./display-media-handler.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { registerPermissionHandler } from "./permissions.js";
import { SettingsStore } from "./settings-store.js";
import { SecureStore } from "./secure-store.js";
import { LogManager } from "./log-manager.js";
import { LoginItemManager } from "./login-item-manager.js";
import { GroupStore } from "./group-store.js";
import { QualityPresetStore } from "./quality-preset-store.js";
import {
  UpdateManager,
  type LoggerAdapter,
  type UpdaterAdapter,
} from "./update-manager.js";
import {
  createStatusBroadcast,
  registerUpdateIpcHandlers,
  removeUpdateIpcHandlers,
} from "./update-ipc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create require for CJS modules in ESM context
const require = createRequire(import.meta.url);

for (const stream of [process.stdout, process.stderr]) {
  stream?.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE") return;
    throw err;
  });
}

if (process.env.NODE_ENV === "development" || process.env.VITE_DEV_SERVER_URL) {
  app.commandLine.appendSwitch("disable-http-cache");
}

// ─── Must be called before app.ready ─────────────────────────────────────────
registerPrivilegedSchemes();

const isMultiInstance = process.argv.includes("--multi-instance");
const devProfile = getDevProfile();

// ─── Module-level state (assigned in whenReady) ──────────────────────────────
let windowManager: WindowManager;
let trayManager: TrayManager;
let settingsStore: SettingsStore;
let secureStore: SecureStore;
let logManager: LogManager;
let loginItemManager: LoginItemManager;
let groupStore: GroupStore;
let presetStore: QualityPresetStore;
let updateManager: UpdateManager | null = null;

app.whenReady().then(() => {
  if (isMultiInstance && !devProfile) {
    const basePath = app.getPath("userData");
    app.setPath("userData", basePath + "-viewer");
    console.log("[ScreenLink] Multi-instance: userData =", app.getPath("userData"));
  }

  if (devProfile) {
    const basePath = app.getPath("userData");
    app.setPath("userData", `${basePath}-${devProfile}`);
    console.log(`[ScreenLink] Dev profile "${devProfile}": userData =`, app.getPath("userData"));
  }

  // ── Protocol ───────────────────────────────────────────────────────────
  registerAppProtocol();

  // ── Services ───────────────────────────────────────────────────────────
  const preloadPath = path.join(__dirname, "../preload/index.js");

  windowManager = new WindowManager(preloadPath);
  settingsStore = new SettingsStore();
  secureStore = new SecureStore();
  logManager = new LogManager();
  loginItemManager = new LoginItemManager();
  groupStore = new GroupStore(secureStore);
  presetStore = new QualityPresetStore();

  // ── Dev profile default display name ──
  if (devProfile) {
    try {
      const existing = settingsStore.get();
      if (existing.hostDisplayName === "Host") {
        import("@screenlink/shared").then(({ getDefaultDevDisplayName }) => {
          const defaultName = getDefaultDevDisplayName(devProfile);
          if (defaultName) {
            const current = settingsStore.get();
            settingsStore.update({
              hostDisplayName: defaultName,
              deviceIdentity: { ...current.deviceIdentity, displayName: defaultName },
            });
            console.log(`[ScreenLink] Set default display name to "${defaultName}" for profile "${devProfile}"`);
          }
        }).catch((err: unknown) => {
          console.warn("[ScreenLink] Failed to set dev profile default name:", err);
        });
      }
    } catch (err) {
      console.warn("[ScreenLink] Failed to check dev profile display name:", err);
    }
  }

  // ── Window ─────────────────────────────────────────────────────────────
  const mainWindow = windowManager.create();

  registerDisplayMediaHandler(mainWindow);
  registerPermissionHandler(mainWindow);

  // ── Single instance ────────────────────────────────────────────────────
  setupSingleInstance(windowManager);

  // ── Tray ───────────────────────────────────────────────────────────────
  const trayActions: TrayMenuActions = {
    onOpen: () => windowManager.show(),
    onShareScreen: () => {
      mainWindow.webContents.send("open-source-picker");
    },
    onShareWindow: () => {
      mainWindow.webContents.send("open-source-picker");
    },
    onStopSharing: () => {
      mainWindow.webContents.send("stop-sharing");
    },
    onStopWatching: () => {
      mainWindow.webContents.send("stop-watching");
    },
    onToggleLaunchAtLogin: (checked: boolean) => {
      loginItemManager.setEnabled(checked);
      settingsStore.update({ launchAtLogin: checked });
    },
    onToggleAutoResume: (checked: boolean) => {
      settingsStore.update({ autoResumeLastMonitor: checked });
    },
    onShowDiagnostics: () => {
      mainWindow.webContents.send("open-diagnostics");
    },
    onQuit: () => {
      windowManager.setQuitting(true);
      trayManager.destroy();
      app.quit();
    },
  };

  trayManager = new TrayManager(trayActions);
  trayManager.create();

  // ── Update manager ───────────────────────────────────────────────────
  {
    // Create a logger adapter that wraps the existing LogManager
    const loggerAdapter: LoggerAdapter = {
      log(level, component, event, details) {
        logManager.log(level, component, event, details);
        // Also log to console for development visibility
        const prefix = `[${component}] ${event}`;
        switch (level) {
          case "error": console.error(prefix, details); break;
          case "warn": console.warn(prefix, details); break;
          default: console.log(prefix, details); break;
        }
      },
    };

    // Create the electron-updater adapter
    let autoUpdaterInstance: UpdaterAdapter | null = null;
    try {
      const electronUpdater = require("electron-updater");
      autoUpdaterInstance = electronUpdater.autoUpdater as UpdaterAdapter;

      // Configure electron-updater policies
      autoUpdaterInstance.autoDownload = false;
      autoUpdaterInstance.autoInstallOnAppQuit = false;
      autoUpdaterInstance.allowPrerelease = false;
      autoUpdaterInstance.allowDowngrade = false;
      autoUpdaterInstance.disableDifferentialDownload = false;

      // Attach electron-updater's logger for diagnostic visibility
      autoUpdaterInstance.logger = {
        info: (msg: string) => loggerAdapter.log("info", "electron-updater", msg),
        warn: (msg: string) => loggerAdapter.log("warn", "electron-updater", msg),
        error: (msg: string) => loggerAdapter.log("error", "electron-updater", msg),
        debug: (msg: string) => loggerAdapter.log("debug", "electron-updater", msg),
      };

      loggerAdapter.log("info", "updater", "electron_updater_loaded", {
        version: autoUpdaterInstance.currentVersion?.version,
      });
    } catch (err) {
      loggerAdapter.log("error", "updater", "electron_updater_load_failed", {
        errorDetail: String(err),
      });
    }

    // Create the broadcast callback that sends status to the renderer
    const broadcast = createStatusBroadcast(mainWindow);

    // Create the prepare-for-quit callback for orderly installation
    const prepareForQuit = (): void => {
      loggerAdapter.log("info", "updater", "preparing_for_quit", {});
      windowManager.setQuitting(true);
      // Destroy tray so it doesn't prevent quit
      trayManager.destroy();
    };

    if (autoUpdaterInstance) {
      updateManager = new UpdateManager(
        autoUpdaterInstance,
        broadcast,
        loggerAdapter,
        prepareForQuit,
      );

      // Register IPC handlers for updates
      registerUpdateIpcHandlers(mainWindow, updateManager);

      // Initialize (schedules first auto-check after ~15 seconds)
      updateManager.init();
    } else {
      loggerAdapter.log("error", "updater", "update_manager_not_created", {
        reason: "electron-updater failed to load",
      });
    }
  }

  // ── IPC handlers ──────────────────────────────────────────────────────
  registerIpcHandlers(mainWindow, settingsStore, secureStore, trayManager, groupStore, presetStore);

  // ── Startup visibility ─────────────────────────────────────────────────
  if (process.argv.includes("--hidden")) {
    mainWindow.hide();
  } else {
    mainWindow.show();
  }

  logManager.log("info", "app", "app_started", {
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    hidden: process.argv.includes("--hidden"),
  });
});

app.on("window-all-closed", () => {
  // Don't quit — tray keeps the app alive
});

// Clean up update manager on quit
app.on("before-quit", () => {
  if (updateManager) {
    updateManager.destroy();
    updateManager = null;
  }
  removeUpdateIpcHandlers();
});
