import { BrowserWindow, Menu, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WindowManager {
  private window: BrowserWindow | null = null;
  private isQuitting = false;

  constructor(private preloadPath: string) {
    app.on("before-quit", () => {
      this.isQuitting = true;
    });
  }

  /**
   * True when `window` is a live, usable BrowserWindow.
   * Clears the stale reference when the underlying native window
   * has already been destroyed (prevents "Object has been destroyed").
   */
  private getAliveWindow(): BrowserWindow | null {
    if (!this.window) {
      return null;
    }
    if (this.window.isDestroyed()) {
      this.window = null;
      return null;
    }
    return this.window;
  }

  /**
   * True only for Electron's native-teardown race: the object passed the
   * `isDestroyed()` check but was destroyed before the native call ran.
   */
  private static isDestroyedRace(err: unknown): boolean {
    return (
      err instanceof Error && err.message.includes("Object has been destroyed")
    );
  }

  /**
   * Run `fn` against a live window. Returns false when there was no usable
   * live window (already destroyed, or destroyed between the aliveness
   * check and the native call). Only the destroyed-object race is caught;
   * any other error propagates.
   */
  private useAliveWindow(fn: (win: BrowserWindow) => void): boolean {
    const win = this.getAliveWindow();
    if (!win) {
      return false;
    }
    try {
      fn(win);
      return true;
    } catch (err) {
      if (!WindowManager.isDestroyedRace(err)) {
        throw err;
      }
      // Native teardown won the race: drop the stale reference.
      this.window = null;
      return false;
    }
  }

  /**
   * Create the main BrowserWindow with secure defaults and close-to-tray behavior.
   */
  create(): BrowserWindow {
    this.window = new BrowserWindow({
      width: 960,
      height: 700,
      minWidth: 720,
      minHeight: 500,
      show: false,
      frame: false,
      autoHideMenuBar: true,
      icon: path.join(__dirname, "../../assets/icon.png"),
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });

    // Hide native menu (frameless with custom title bar)
    Menu.setApplicationMenu(null);

    // Close-to-tray: hide instead of quit
    this.window.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.getAliveWindow()?.hide();
      }
    });

    // Load the renderer
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (process.env.NODE_ENV === "development" || devServerUrl) {
      this.window.loadURL(devServerUrl ?? "http://localhost:5173");
    } else {
      this.window.loadURL("screenlink://app/index.html");
    }

    this.window.webContents.on("before-input-event", (event, input) => {
      const key = String(input.key ?? "").toLowerCase();
      const isCtrlShiftI =
        input.control === true && input.shift === true && key === "i";
      const isMacDevTools =
        process.platform === "darwin" &&
        input.meta === true &&
        input.alt === true &&
        key === "i";

      if (!isCtrlShiftI && !isMacDevTools) {
        return;
      }

      event.preventDefault();
      this.toggleDevTools();
    });

    return this.window;
  }

  toggleDevTools(): void {
    this.useAliveWindow((win) => {
      const wc = win.webContents;
      if (wc.isDestroyed()) {
        return;
      }

      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
        return;
      }

      // Ctrl+Shift+I always toggles DevTools in development and packaged builds.
      wc.openDevTools({ mode: "bottom" });
    });
  }

  show(): void {
    if (this.useAliveWindow((win) => win.show())) {
      return;
    }
    // Window was destroyed (e.g. closed to tray path raced with teardown,
    // possibly between the aliveness check and show()): recreate and show
    // when it is safe to do so.
    this.recreateAndShow();
  }

  /** Show, restore if minimized, and focus the window. */
  showRestoreOrFocus(): void {
    if (
      this.useAliveWindow((win) => {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      })
    ) {
      return;
    }
    this.recreateAndShow();
  }

  hide(): void {
    this.useAliveWindow((win) => win.hide());
  }

  focus(): void {
    this.useAliveWindow((win) => win.focus());
  }

  /**
   * Recreate the BrowserWindow after it has been destroyed and show it.
   * Only safe while the app is not quitting; a no-op otherwise.
   */
  private recreateAndShow(): void {
    if (this.isQuitting || this.window) {
      return;
    }
    const win = this.create();
    win.show();
  }

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  setQuitting(value: boolean): void {
    this.isQuitting = value;
  }
}
