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
// Audio helper lifecycle is managed by IPC handlers via ensureAudioHelper()
// in ipc-handlers.ts — no direct imports needed here
import { registerPermissionHandler } from "./permissions.js";
import { SettingsStore } from "./settings-store.js";
import { SecureStore } from "./secure-store.js";
import { LogManager } from "./log-manager.js";
import { LoginItemManager } from "./login-item-manager.js";
import { UpdateManager } from "./update-manager.js";
import type { LoggerAdapter, UpdaterAdapter } from "./update-manager.js";
import { registerUpdateIpcHandlers, createStatusBroadcast, removeUpdateIpcHandlers } from "./update-ipc.js";

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
let updateManager: UpdateManager | null = null;

app.whenReady().then(() => {
  // When --dev-profile is set, it handles userData separation — skip the generic
  // multi-instance suffix so paths stay clean (e.g. {base}-bob not {base}-viewer-bob)
  if (isMultiInstance && !devProfile) {
    const basePath = app.getPath("userData");
    app.setPath("userData", basePath + "-viewer");
    console.log("[ScreenLink] Multi-instance: userData =", app.getPath("userData"));
  }

  // Handle dev profiles — must happen BEFORE services are created so they
  // write to the correct userData directory
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

  // ── Dev profile default display name (runs AFTER settingsStore is ready) ──
  if (devProfile) {
    try {
      const existingSettings = settingsStore.get();
      if (existingSettings && existingSettings.hostDisplayName === "Host") {
        import("@screenlink/shared").then(({ getDefaultDevDisplayName }) => {
          const defaultName = getDefaultDevDisplayName(devProfile);
          if (defaultName) {
            settingsStore.update({ hostDisplayName: defaultName });
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
      mainWindow.webContents.send("share-screen");
    },
    onShareWindow: () => {
      mainWindow.webContents.send("open-source-picker");
    },
    onStopSharing: () => {
      mainWindow.webContents.send("stop-sharing");
    },
    onWatchFriend: () => {
      mainWindow.webContents.send("watch-friend");
    },
    onStopWatching: () => {
      mainWindow.webContents.send("stop-watching");
    },
    onSelectPreset: (presetId: string) => {
      mainWindow.webContents.send("select-preset", presetId);
    },
    onToggleLaunchAtLogin: (checked: boolean) => {
      loginItemManager.setEnabled(checked);
      settingsStore.update({ launchAtLogin: checked });
    },
    onToggleAutoResume: (checked: boolean) => {
      settingsStore.update({ autoResumeLastMonitor: checked });
    },
    onToggleAllowRemoteQuality: (checked: boolean) => {
      settingsStore.update({ allowRemoteQualityRequests: checked });
    },
    onToggleAutoWatch: (checked: boolean) => {
      settingsStore.update({ autoWatchFriend: checked });
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
  registerIpcHandlers(mainWindow, settingsStore, secureStore, trayManager);

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
  // User must explicitly use "Quit completely" from tray
});

// Clean up update manager on quit
app.on("before-quit", () => {
  if (updateManager) {
    updateManager.destroy();
    updateManager = null;
  }
  removeUpdateIpcHandlers();
});
