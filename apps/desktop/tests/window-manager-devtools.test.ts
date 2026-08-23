// @vitest-environment node
/**
 * DevTools toggle tests (Stage 7 — Ctrl+Shift+I in packaged builds).
 *
 * Verifies the `before-input-event` handler on `webContents` opens and
 * closes DevTools in response to Ctrl+Shift+I without requiring the
 * `--devtools` launch flag, the developer-mode setting, or any
 * environment variable. The native menu must remain hidden.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";

// ── Hoisted electron mock ────────────────────────────────────────────────
const mockApp = { on: vi.fn(), isPackaged: true };

class MockBrowserWindow extends EventEmitter {
  public webContents = new MockWebContents();
  public static instance: MockBrowserWindow | null = null;
  public isDevToolsOpened = vi.fn().mockReturnValue(false);
  public isDestroyed = vi.fn().mockReturnValue(false);
  public isMinimized = vi.fn().mockReturnValue(false);
  public show = vi.fn();
  public hide = vi.fn();
  public focus = vi.fn();
  public restore = vi.fn();
  constructor(_opts?: unknown) {
    super();
    MockBrowserWindow.instance = this;
  }
  loadURL(_url: string): void {}
}

class MockWebContents extends EventEmitter {
  public isDevToolsOpened = vi.fn().mockReturnValue(false);
  public openDevTools = vi.fn();
  public closeDevTools = vi.fn();
  public isDestroyed = vi.fn().mockReturnValue(false);
  public send = vi.fn();
}

const MenuMock = { setApplicationMenu: vi.fn() };

vi.mock("electron", () => ({
  BrowserWindow: MockBrowserWindow,
  Menu: MenuMock,
  app: mockApp,
}));

// Mock path so import does not require __dirname resolution at module load
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  return { ...actual, join: (...parts: string[]) => parts.join("/") };
});

// ── Imports (after mock hoisting) ────────────────────────────────────────

const { WindowManager } = await import("../src/main/window-manager.js");

interface TriggerInputOptions {
  type?: string;
  key?: string;
  code?: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function triggerInput(
  win: MockBrowserWindow,
  input: TriggerInputOptions,
  event: { preventDefault: () => void } = { preventDefault: vi.fn() },
): void {
  win.webContents.emit(
    "before-input-event",
    event,
    {
      type: input.type ?? "keyDown",
      key: input.key ?? "",
      code: input.code ?? "",
      control: input.control ?? false,
      shift: input.shift ?? false,
      alt: input.alt ?? false,
      meta: input.meta ?? false,
    },
  );
}

describe("WindowManager — Ctrl+Shift+I DevTools toggle", () => {
  let manager: InstanceType<typeof WindowManager>;

  beforeEach(() => {
    MockBrowserWindow.instance = null;
    MenuMock.setApplicationMenu.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps DevTools closed at startup in a packaged build", () => {
    // isPackaged is true; no --devtools flag; no developer-mode
    const oldArgv = process.argv;
    process.argv = ["node", "app.js"];
    try {
      manager = new WindowManager("/preload.js");
      const win = manager.create();
      const wc = win.webContents as unknown as MockWebContents;
      // No DevTools calls have happened during create()
      expect(wc.openDevTools).not.toHaveBeenCalled();
      expect(wc.closeDevTools).not.toHaveBeenCalled();
      expect(MenuMock.setApplicationMenu).toHaveBeenCalledWith(null);
    } finally {
      process.argv = oldArgv;
    }
  });

  it("opens DevTools on first Ctrl+Shift+I press in a packaged build", () => {
    const oldArgv = process.argv;
    process.argv = ["node", "app.js"];
    try {
      manager = new WindowManager("/preload.js");
      const win = manager.create();
      const wc = win.webContents as unknown as MockWebContents;
      const event = { preventDefault: vi.fn() };

      triggerInput(
        MockBrowserWindow.instance!,
        { type: "keyDown", key: "I", code: "KeyI", control: true, shift: true },
        event,
      );

      expect(event.preventDefault).toHaveBeenCalled();
      expect(wc.openDevTools).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = oldArgv;
    }
  });

  it("closes DevTools on a second Ctrl+Shift+I press when already open", () => {
    const oldArgv = process.argv;
    process.argv = ["node", "app.js"];
    try {
      manager = new WindowManager("/preload.js");
      const win = manager.create();
      const wc = win.webContents as unknown as MockWebContents;
      wc.isDevToolsOpened.mockReturnValue(true);

      const event = { preventDefault: vi.fn() };
      triggerInput(
        MockBrowserWindow.instance!,
        { type: "keyDown", key: "I", code: "KeyI", control: true, shift: true },
        event,
      );

      expect(event.preventDefault).toHaveBeenCalled();
      expect(wc.closeDevTools).toHaveBeenCalledTimes(1);
      expect(wc.openDevTools).not.toHaveBeenCalled();
    } finally {
      process.argv = oldArgv;
    }
  });

  it("does not toggle DevTools for unrelated shortcuts", () => {
    const oldArgv = process.argv;
    process.argv = ["node", "app.js"];
    try {
      manager = new WindowManager("/preload.js");
      const win = manager.create();
      const wc = win.webContents as unknown as MockWebContents;
      const event = { preventDefault: vi.fn() };

      triggerInput(
        MockBrowserWindow.instance!,
        { type: "keyDown", key: "J", code: "KeyJ", control: true, shift: true },
        event,
      );
      triggerInput(
        MockBrowserWindow.instance!,
        { type: "keyDown", key: "I", code: "KeyI", control: true, shift: false },
        event,
      );
      triggerInput(
        MockBrowserWindow.instance!,
        { type: "keyDown", key: "I", code: "KeyI" },
        event,
      );

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(wc.openDevTools).not.toHaveBeenCalled();
      expect(wc.closeDevTools).not.toHaveBeenCalled();
    } finally {
      process.argv = oldArgv;
    }
  });

  it("does not require the --devtools flag, environment variable, or developer-mode", () => {
    delete process.env.SCREENLINK_DEVTOOLS;
    delete process.env.SCREENLINK_DEVELOPER_MODE;
    const oldArgv = process.argv;
    process.argv = ["node", "app.js"];
    try {
      // Pass a developerMode getter that returns false to confirm the
      // toggle does not consult it.
      manager = new WindowManager("/preload.js", () => false);
      const win = manager.create();
      const wc = win.webContents as unknown as MockWebContents;
      const event = { preventDefault: vi.fn() };

      triggerInput(
        MockBrowserWindow.instance!,
        { type: "keyDown", key: "I", code: "KeyI", control: true, shift: true },
        event,
      );

      expect(wc.openDevTools).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = oldArgv;
    }
  });

  it("hides the native application menu (frameless UI)", () => {
    manager = new WindowManager("/preload.js");
    manager.create();
    expect(MenuMock.setApplicationMenu).toHaveBeenCalledWith(null);
  });
});

describe("WindowManager — destroyed window safety", () => {
  let manager: InstanceType<typeof WindowManager>;

  beforeEach(() => {
    MockBrowserWindow.instance = null;
    MenuMock.setApplicationMenu.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createManager(): MockBrowserWindow {
    manager = new WindowManager("/preload.js");
    manager.create();
    return MockBrowserWindow.instance!;
  }

  function destroyWindow(win: MockBrowserWindow): void {
    win.isDestroyed.mockReturnValue(true);
  }

  it("show() does not throw on a destroyed window and recreates + shows a new one", () => {
    const win = createManager();
    destroyWindow(win);

    expect(() => manager.show()).not.toThrow();

    // Stale reference was replaced by a fresh, live window that is shown.
    const fresh = MockBrowserWindow.instance!;
    expect(fresh).not.toBe(win);
    expect(fresh.show).toHaveBeenCalled();
    expect(manager.getWindow()).toBe(
      (fresh as unknown) as BrowserWindow,
    );
  });

  it("showRestoreOrFocus() does not throw on a destroyed window and recreates", () => {
    const win = createManager();
    destroyWindow(win);

    expect(() => manager.showRestoreOrFocus()).not.toThrow();

    const fresh = MockBrowserWindow.instance!;
    expect(fresh).not.toBe(win);
    // Recreation path shows the new window (focus is only applied to an
    // existing live window, matching the pre-fix behavior for recreation).
    expect(fresh.show).toHaveBeenCalled();
  });

  it("hide() and focus() are safe no-ops on a destroyed window", () => {
    const win = createManager();
    destroyWindow(win);

    expect(() => manager.hide()).not.toThrow();
    expect(() => manager.focus()).not.toThrow();
    // No recreation triggered by passive hide/focus.
    expect(MockBrowserWindow.instance).toBe(win);
    expect(manager.getWindow()).toBeNull();
  });

  it("toggleDevTools() does not touch webContents of a destroyed window", () => {
    const win = createManager();
    destroyWindow(win);
    const wc = win.webContents as unknown as MockWebContents;

    expect(() => manager.toggleDevTools()).not.toThrow();
    expect(wc.openDevTools).not.toHaveBeenCalled();
    expect(wc.closeDevTools).not.toHaveBeenCalled();
  });

  it("does not recreate during quit after the window was destroyed", () => {
    const win = createManager();
    destroyWindow(win);
    manager.setQuitting(true);

    manager.show();

    // Still the same (destroyed) instance reference-wise: no new window made.
    expect(MockBrowserWindow.instance).toBe(win);
    expect(manager.getWindow()).toBeNull();
  });

  it("normal path: showRestoreOrFocus restores minimized window and focuses it", () => {
    const win = createManager();
    win.isMinimized.mockReturnValue(true);

    manager.showRestoreOrFocus();

    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.isDestroyed.mock.calls.length).toBeGreaterThan(0);
  });

  it("normal path: close-to-tray still hides instead of destroying", () => {
    const win = createManager();
    const wc = win.webContents as unknown as MockWebContents;
    void wc;

    // Simulate the user clicking the window close button while not quitting.
    const event = { preventDefault: vi.fn() };
    win.emit("close", event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  // ── Native teardown race: destroyed between alive check and call ────────

  it("show() recovers when the window is destroyed between the alive check and show()", () => {
    const win = createManager();
    // Passes isDestroyed(), then native teardown wins before show() runs.
    win.show.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });

    expect(() => manager.show()).not.toThrow();

    // Stale reference cleared and replaced by a fresh, shown window.
    const fresh = MockBrowserWindow.instance!;
    expect(fresh).not.toBe(win);
    expect(fresh.show).toHaveBeenCalledTimes(1);
    expect(manager.getWindow()).toBe((fresh as unknown) as BrowserWindow);
  });

  it("showRestoreOrFocus() recreates when restore/show races destruction", () => {
    const win = createManager();
    win.isMinimized.mockReturnValue(true);
    win.restore.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });

    expect(() => manager.showRestoreOrFocus()).not.toThrow();

    const fresh = MockBrowserWindow.instance!;
    expect(fresh).not.toBe(win);
    expect(fresh.show).toHaveBeenCalledTimes(1);
  });

  it("hide() and focus() swallow the destroyed-object race without recreating", () => {
    const win = createManager();
    win.hide.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    win.focus.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });

    expect(() => manager.hide()).not.toThrow();
    expect(() => manager.focus()).not.toThrow();

    // Passive methods must not recreate; stale reference was cleared.
    expect(MockBrowserWindow.instance).toBe(win);
    expect(manager.getWindow()).toBeNull();
  });

  it("toggleDevTools() swallows the destroyed-object race on openDevTools", () => {
    const win = createManager();
    const wc = win.webContents as unknown as MockWebContents;
    wc.openDevTools.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });

    expect(() => manager.toggleDevTools()).not.toThrow();
    expect(manager.getWindow()).toBeNull();
  });

  it("does not recreate during quit when show() races destruction", () => {
    const win = createManager();
    manager.setQuitting(true);
    win.show.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });

    expect(() => manager.show()).not.toThrow();

    expect(MockBrowserWindow.instance).toBe(win);
    expect(manager.getWindow()).toBeNull();
  });

  it("unrelated errors from window methods are not swallowed", () => {
    const win = createManager();
    win.show.mockImplementation(() => {
      throw new Error("some other failure");
    });

    expect(() => manager.show()).toThrow("some other failure");
    // Non-destroyed failures keep the reference intact.
    expect(manager.getWindow()).toBe(win);
  });
});
