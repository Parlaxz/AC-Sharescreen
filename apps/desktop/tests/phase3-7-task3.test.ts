// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mockIsPackaged = false;
const mockAppOn = vi.fn();
const mockMenuSetApplicationMenu = vi.fn();
let lastWindow: any = null;
let beforeInputHandler: ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void) | null = null;

function createBrowserWindowMock() {
  return vi.fn(() => {
    beforeInputHandler = null;
    lastWindow = {
      on: vi.fn(),
      loadURL: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      focus: vi.fn(),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      isMaximized: vi.fn(() => false),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn(),
      webContents: {
        on: vi.fn((event: string, handler: typeof beforeInputHandler) => {
          if (event === "before-input-event") {
            beforeInputHandler = handler;
          }
        }),
        isDevToolsOpened: vi.fn(() => false),
        openDevTools: vi.fn(),
        closeDevTools: vi.fn(),
      },
    };
    return lastWindow;
  });
}

const BrowserWindowMock = createBrowserWindowMock();

vi.mock("electron", () => ({
  app: {
    on: mockAppOn,
    get isPackaged() {
      return mockIsPackaged;
    },
    getPath: vi.fn(() => os.tmpdir()),
  },
  Menu: {
    setApplicationMenu: mockMenuSetApplicationMenu,
  },
  BrowserWindow: BrowserWindowMock,
}));

function readWorktreeFile(...segments: string[]): string {
  return fs.readFileSync(path.resolve(__dirname, "..", "src", ...segments), "utf-8");
}

describe("Task 3 identity state", () => {
  it("stores localDeviceId and localDisplayName in Zustand", async () => {
    const { useIdentityStore } = await import("../src/renderer/stores/identity-store.js");
    useIdentityStore.getState().setLocalIdentity({ deviceId: "device-1", displayName: "Alice" });
    expect(useIdentityStore.getState().localDeviceId).toBe("device-1");
    expect(useIdentityStore.getState().localDisplayName).toBe("Alice");
  });

  it("initializes runtime identity store population before runtime startup work", () => {
    const runtimeInitSource = readWorktreeFile("renderer", "services", "initialize-app-runtime.ts");
    expect(runtimeInitSource).toContain('useIdentityStore');
    expect(runtimeInitSource).toContain('setLocalIdentity');
    const setIdentityIndex = runtimeInitSource.indexOf("setLocalIdentity");
    const acquireIndex = runtimeInitSource.indexOf("const runtime = await acquirePhase3Runtime");
    expect(setIdentityIndex).toBeGreaterThan(0);
    expect(setIdentityIndex).toBeLessThan(acquireIndex);
  });
});

describe("Task 3 UserDock and settings entry point", () => {
  it("uses the identity store and navigates the gear to user-settings", () => {
    const source = readWorktreeFile("renderer", "components", "layout", "UserDock.tsx");
    expect(source).toContain('useIdentityStore');
    expect(source).toContain('localDisplayName');
    expect(source).toContain('navigate("user-settings")');
    expect(source).not.toContain("SettingsSheet");
  });

  it("removes fake quick-settings and TODO-only menu items from UserDock", () => {
    const source = readWorktreeFile("renderer", "components", "layout", "UserDock.tsx");
    expect(source).not.toContain("Launch at login");
    expect(source).not.toContain("Auto-resume last share");
    expect(source).not.toContain("TODO");
    expect(source).toContain("Diagnostics");
    expect(source).toContain("Start sharing");
  });

  it("deletes SettingsSheet from the worktree", () => {
    const settingsSheetPath = path.resolve(
      __dirname,
      "..",
      "src",
      "renderer",
      "components",
      "workspace",
      "SettingsSheet.tsx",
    );
    expect(fs.existsSync(settingsSheetPath)).toBe(false);
  });
});

describe("Task 3 SettingsPage source of truth", () => {
  it("contains exactly the required settings groups and codec options", () => {
    const source = readWorktreeFile("renderer", "components", "workspace", "SettingsPage.tsx");
    expect(source).toContain("Display Name");
    expect(source).toContain("Launch at login");
    expect(source).toContain("Auto-resume last monitor/source");
    expect(source).toContain("General notifications enabled");
    expect(source).toContain("Maximum bitrate");
    expect(source).toContain("Maximum width");
    expect(source).toContain("Maximum height");
    expect(source).toContain("Maximum FPS");
    expect(source).toContain("Allow viewer quality requests");
    expect(source).toContain("Default codec");
    expect(source).toContain("VP9");
    expect(source).toContain("AV1");
    expect(source).toContain("H.264");
    expect(source).toContain("VP8");
    expect(source).toContain("Quick Share");
  });

  it("loads and saves through the real settings actions and verifies display name persistence", () => {
    const source = readWorktreeFile("renderer", "components", "workspace", "SettingsPage.tsx");
    expect(source).toContain("loadSettings");
    expect(source).toContain("loadQuickShareConfig");
    expect(source).toContain("saveSettings");
    expect(source).toContain("saveQuickShareConfig");
    expect(source).toContain("updateDisplayName");
    expect(source).toContain("Display Name verification failed");
    expect(source).toContain("updateLocalDisplayName");
  });

  it("merges hostQualityLimits and globalQualityDefaults.video.codec without dropping siblings", () => {
    const source = readWorktreeFile("renderer", "components", "workspace", "SettingsPage.tsx");
    expect(source).toContain("...(settingsAfterNameSave.hostQualityLimits ??");
    expect(source).toContain("...(settingsAfterNameSave.globalQualityDefaults?.video ?? {})");
    expect(source).toContain("audio: settingsAfterNameSave.globalQualityDefaults?.audio ?? DEFAULT_AUDIO_SETTINGS");
  });

  it("excludes out-of-scope fake settings", () => {
    const source = readWorktreeFile("renderer", "components", "workspace", "SettingsPage.tsx");
    expect(source).not.toContain("Language");
    expect(source).not.toContain("Theme");
    expect(source).not.toContain("Start minimized");
    expect(source).not.toContain("Close to tray");
    expect(source).not.toContain("Hardware acceleration");
    expect(source).not.toContain("System Audio");
    expect(source).not.toContain("H264 default");
  });
});

describe("Task 3 SettingsStore persistence", () => {
  it("defaults the global codec to VP9", async () => {
    const { SettingsStore } = await import("../src/main/settings-store.js");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "screenlink-settings-"));
    try {
      const store = new SettingsStore(tempDir);
      expect(store.get().globalQualityDefaults.video.codec).toBe("vp9");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists display name across restart with a temporary user-data directory", async () => {
    const { SettingsStore } = await import("../src/main/settings-store.js");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "screenlink-settings-"));
    try {
      const first = new SettingsStore(tempDir);
      const current = first.get();
      first.update({
        hostDisplayName: "Alice",
        deviceIdentity: { ...current.deviceIdentity, displayName: "Alice" },
      });

      const second = new SettingsStore(tempDir);
      expect(second.get().hostDisplayName).toBe("Alice");
      expect(second.get().deviceIdentity.displayName).toBe("Alice");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Task 3 Phase3Runtime identity update", () => {
  it("includes updateLocalDisplayName and forwards to StreamSessionManager identity", () => {
    const source = readWorktreeFile("renderer", "services", "phase3-runtime.ts");
    expect(source).toContain("updateLocalDisplayName(displayName: string)");
    expect(source).toContain("setDeviceIdentity(this._deviceId, displayName)");
  });
});

describe("Task 3 WindowManager DevTools toggle", () => {
  beforeEach(() => {
    vi.resetModules();
    mockIsPackaged = false;
    mockAppOn.mockReset();
    mockMenuSetApplicationMenu.mockReset();
    BrowserWindowMock.mockImplementation(createBrowserWindowMock());
    beforeInputHandler = null;
    lastWindow = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a before-input-event handler and keeps DevTools closed at startup", async () => {
    const { WindowManager } = await import("../src/main/window-manager.js");
    const manager = new WindowManager("preload.js");
    manager.create();
    expect(beforeInputHandler).not.toBeNull();
    expect(lastWindow.webContents.openDevTools).not.toHaveBeenCalled();
    expect(mockMenuSetApplicationMenu).toHaveBeenCalledWith(null);
  });

  it("Ctrl+Shift+I opens DevTools in development", async () => {
    const { WindowManager } = await import("../src/main/window-manager.js");
    const manager = new WindowManager("preload.js");
    manager.create();
    const preventDefault = vi.fn();
    beforeInputHandler?.({ preventDefault }, { control: true, shift: true, key: "I" });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(lastWindow.webContents.openDevTools).toHaveBeenCalledTimes(1);
  });

  it("second Ctrl+Shift+I closes DevTools", async () => {
    const { WindowManager } = await import("../src/main/window-manager.js");
    const manager = new WindowManager("preload.js");
    manager.create();
    lastWindow.webContents.isDevToolsOpened.mockReturnValue(true);
    const preventDefault = vi.fn();
    beforeInputHandler?.({ preventDefault }, { control: true, shift: true, key: "i" });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(lastWindow.webContents.closeDevTools).toHaveBeenCalledTimes(1);
  });

  it("nonmatching shortcuts do nothing", async () => {
    const { WindowManager } = await import("../src/main/window-manager.js");
    const manager = new WindowManager("preload.js");
    manager.create();
    const preventDefault = vi.fn();
    beforeInputHandler?.({ preventDefault }, { control: true, shift: true, key: "x" });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(lastWindow.webContents.openDevTools).not.toHaveBeenCalled();
    expect(lastWindow.webContents.closeDevTools).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+I opens DevTools in a packaged build regardless of developer mode", async () => {
    // Stage 7 — Fix 1: DevTools shortcut must work in installed builds
    // without any environment variable, --devtools flag, or developer-mode
    // setting. Developer mode is irrelevant to the toggle.
    mockIsPackaged = true;
    const { WindowManager } = await import("../src/main/window-manager.js");
    const manager = new WindowManager("preload.js", () => false);
    manager.create();
    const preventDefault = vi.fn();
    beforeInputHandler?.({ preventDefault }, { control: true, shift: true, key: "i" });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(lastWindow.webContents.openDevTools).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Shift+I opens DevTools in a packaged build even without a developer-mode callback", async () => {
    // No callback means there is no developer-mode source at all. The
    // toggle must still work in a packaged build.
    mockIsPackaged = true;
    const { WindowManager } = await import("../src/main/window-manager.js");
    const manager = new WindowManager("preload.js");
    manager.create();
    const preventDefault = vi.fn();
    beforeInputHandler?.({ preventDefault }, { control: true, shift: true, key: "i" });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(lastWindow.webContents.openDevTools).toHaveBeenCalledTimes(1);
  });
});
