import { app } from "electron";
import path from "path";
import { fileURLToPath } from "url";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
