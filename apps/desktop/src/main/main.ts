import { app } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { registerPrivilegedSchemes, registerAppProtocol } from "./protocol.js";
import { setupSingleInstance, getDevProfile } from "./app-lifecycle.js";
import { WindowManager } from "./window-manager.js";
import { TrayManager } from "./tray-manager.js";
import type { TrayMenuActions } from "./tray-manager.js";
import { QuickShareShortcutManager } from "./quick-share-shortcut-manager.js";
import { GroupShortcutManager } from "./group-shortcut-manager.js";
import { registerDisplayMediaHandler } from "./display-media-handler.js";
import {
  registerIpcHandlers,
  stopCurrentAudioHelper,
  stopVideoHelperForQuit,
} from "./ipc-handlers.js";
import { FullscreenDetector } from "./fullscreen-detector.js";
import { StreamToastManager } from "./stream-toast-manager.js";
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

// Guard against stdout/stderr failures (e.g. EPIPE when the terminal closes).
// Never throw from these callbacks — a throw here becomes an uncaught exception
// in the main process. Log once per stream, then stop logging for that stream.
const brokenStreams = new WeakSet<NodeJS.WriteStream>();
for (const stream of [process.stdout, process.stderr]) {
  stream?.on("error", (err: NodeJS.ErrnoException) => {
    if (brokenStreams.has(stream)) return;
    brokenStreams.add(stream);
    const name = stream === process.stderr ? "stderr" : "stdout";
    // If stderr itself is broken this re-enters, but the WeakSet gate stops it.
    console.error(`[ScreenLink] ${name} stream error (further ${name} errors suppressed):`, err);
  });
}

if (process.env.NODE_ENV === "development" || process.env.VITE_DEV_SERVER_URL) {
  app.commandLine.appendSwitch("disable-http-cache");
}

// ─── Must be called before app.ready ─────────────────────────────────────────
registerPrivilegedSchemes();

// Dev-only flags are ignored in packaged builds so they always enforce
// single-instance and the default userData profile.
const isMultiInstance = !app.isPackaged && process.argv.includes("--multi-instance");
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
let quickShareShortcutManager: QuickShareShortcutManager | null = null;
let groupShortcutManager: GroupShortcutManager | null = null;
let streamToastManager: StreamToastManager | null = null;

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

  settingsStore = new SettingsStore();
  windowManager = new WindowManager(preloadPath);
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

  // Safe renderer send for tray/menu paths: the window may be destroyed when
  // these callbacks race quit/reload ("Object has been destroyed").
  const safeSend = (channel: string, ...args: unknown[]): void => {
    try {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send(channel, ...args);
    } catch (err) {
      console.warn(`[ScreenLink] safeSend("${channel}") failed:`, err);
    }
  };

  const fullscreenDetector = new FullscreenDetector();
  streamToastManager = new StreamToastManager(
    mainWindow,
    fullscreenDetector,
    path.join(__dirname, "../preload/stream-toast-preload.js"),
  );

  // Dev-only self-test hook: never honor in packaged builds.
  if (!app.isPackaged && process.argv.includes("--test-toast")) {
    setTimeout(() => {
      const result = streamToastManager?.show({
        groupId: "self-test",
        hostDeviceId: "self-test",
        logicalStreamId: "self-test",
        hostName: "ScreenLink",
        groupName: "Toast self-test",
      });
      console.log("[self-test] stream toast result:", JSON.stringify(result));
    }, 5000);
  }

  registerDisplayMediaHandler(mainWindow);
  registerPermissionHandler(mainWindow);

  // ── Quick Share shortcut manager ─────────────────────────────────────
  quickShareShortcutManager = new QuickShareShortcutManager(
    () => mainWindow,
    {
      getQuickShareEnabled: () => settingsStore.get().quickShareShortcutEnabled ?? false,
      getQuickShareAccelerator: () => settingsStore.get().quickShareShortcutAccelerator ?? "Super+Alt+S",
    },
  );
  quickShareShortcutManager.register();

  // ── Group shortcut manager (per-group Quick Share / Quick Join) ─────
  groupShortcutManager = new GroupShortcutManager(() => mainWindow);
  // Register saved shortcuts for all existing groups
  const allGroups = groupStore.list();
  for (const g of allGroups) {
    if (g.quickShareShortcut) {
      groupShortcutManager.register(g.groupId, "quick-share", g.quickShareShortcut);
    }
    if (g.quickJoinShortcut) {
      groupShortcutManager.register(g.groupId, "quick-join", g.quickJoinShortcut);
    }
  }

  // ── Single instance ────────────────────────────────────────────────────
  setupSingleInstance(windowManager);

  // ── Tray ───────────────────────────────────────────────────────────────
  const trayActions: TrayMenuActions = {
    onOpen: () => windowManager.show(),
    onShareScreen: () => {
      safeSend("open-source-picker");
    },
    onShareWindow: () => {
      safeSend("open-source-picker");
    },
    onStopSharing: () => {
      safeSend("stop-sharing");
    },
    onStopWatching: () => {
      safeSend("stop-watching");
    },
    onQuickShare: () => {
      windowManager.showRestoreOrFocus();
      safeSend("quick-share:open");
    },
    onToggleLaunchAtLogin: (checked: boolean) => {
      loginItemManager.setEnabled(checked);
      settingsStore.update({ launchAtLogin: checked });
    },
    onToggleAutoResume: (checked: boolean) => {
      settingsStore.update({ autoResumeLastMonitor: checked });
    },
    onShowDiagnostics: () => {
      safeSend("open-diagnostics");
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
  registerIpcHandlers(
    mainWindow,
    settingsStore,
    secureStore,
    trayManager,
    groupStore,
    presetStore,
    (enabled, accelerator) => {
      quickShareShortcutManager?.updateConfig(enabled, accelerator);
    },
    groupShortcutManager ?? undefined,
    streamToastManager,
  );

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
}).catch((err: unknown) => {
  // Startup failure safety net: without this, any constructor/store/tray/IPC
  // error above becomes an unhandled rejection with a half-initialized app.
  console.error("[ScreenLink] Fatal error during startup:", err);

  // Best-effort cleanup of whatever module-level services were assigned.
  try {
    if (quickShareShortcutManager) {
      quickShareShortcutManager.destroy();
      quickShareShortcutManager = null;
    }
  } catch (cleanupErr) {
    console.warn("[ScreenLink] Startup cleanup: quickShareShortcutManager failed:", cleanupErr);
  }
  try {
    if (groupShortcutManager) {
      groupShortcutManager.destroy();
      groupShortcutManager = null;
    }
  } catch (cleanupErr) {
    console.warn("[ScreenLink] Startup cleanup: groupShortcutManager failed:", cleanupErr);
  }
  try {
    if (streamToastManager) {
      streamToastManager.dispose();
      streamToastManager = null;
    }
  } catch (cleanupErr) {
    console.warn("[ScreenLink] Startup cleanup: streamToastManager failed:", cleanupErr);
  }
  try {
    if (updateManager) {
      updateManager.destroy();
      updateManager = null;
    }
    removeUpdateIpcHandlers();
  } catch (cleanupErr) {
    console.warn("[ScreenLink] Startup cleanup: update manager failed:", cleanupErr);
  }
  try {
    if (trayManager) {
      trayManager.destroy();
    }
  } catch (cleanupErr) {
    console.warn("[ScreenLink] Startup cleanup: trayManager failed:", cleanupErr);
  }

  app.quit();
});

app.on("window-all-closed", () => {
  // Don't quit — tray keeps the app alive
});

// Clean up on quit
app.on("before-quit", () => {
  if (quickShareShortcutManager) {
    quickShareShortcutManager.destroy();
    quickShareShortcutManager = null;
  }
  if (groupShortcutManager) {
    groupShortcutManager.destroy();
    groupShortcutManager = null;
  }
  if (streamToastManager) {
    streamToastManager.dispose();
    streamToastManager = null;
  }
  if (updateManager) {
    updateManager.destroy();
    updateManager = null;
  }
  removeUpdateIpcHandlers();
});

// ── Native helper shutdown on quit ───────────────────────────────────────────
// The audio helper (AudioHelperManager) is shut down via the exported
// stopCurrentAudioHelper() from ipc-handlers. Bounded by a 3s timeout so quit
// can never hang: whichever finishes first (allSettled or the timer) releases
// the quit exactly once.
let helperShutdownComplete = false;

app.on("will-quit", (event) => {
  // Pass through the re-entrant app.quit() issued after shutdown completes.
  if (helperShutdownComplete) return;
  event.preventDefault();

  const finishQuit = (): void => {
    if (helperShutdownComplete) return;
    helperShutdownComplete = true;
    clearTimeout(quitTimeout);
    app.quit();
  };
  const quitTimeout = setTimeout(finishQuit, 3000);

  const shutdowns: Array<Promise<unknown>> = [
    stopCurrentAudioHelper().catch((err: unknown) => {
      console.warn("[ScreenLink] Audio helper shutdown failed during quit:", err);
    }),
    stopVideoHelperForQuit().catch((err: unknown) => {
      console.warn("[ScreenLink] Video helper shutdown failed during quit:", err);
    }),
  ];

  Promise.allSettled(shutdowns).then(finishQuit, finishQuit);
});
