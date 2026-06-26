import { BrowserWindow, Menu, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WindowManager {
  private window: BrowserWindow | null = null;
  private isQuitting = false;
  private developerMode = false;
  private devToolsFlag = process.argv.includes("--devtools");

  constructor(
    private preloadPath: string,
    private getDeveloperMode?: () => boolean,
  ) {
    app.on("before-quit", () => {
      this.isQuitting = true;
    });
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
        this.window?.hide();
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

  setDeveloperMode(enabled: boolean): void {
    this.developerMode = enabled;
  }

  private isDevToolsAllowed(): boolean {
    if (!app.isPackaged) {
      return true;
    }

    if (this.devToolsFlag || this.developerMode) {
      return true;
    }

    return this.getDeveloperMode?.() === true;
  }

  toggleDevTools(): void {
    if (!this.window || !this.isDevToolsAllowed()) {
      return;
    }

    if (this.window.webContents.isDevToolsOpened()) {
      this.window.webContents.closeDevTools();
      return;
    }

    // Gated by isDevToolsAllowed(): unpackaged/dev builds, developerMode,
    // or an explicit --devtools launch flag in packaged builds.
    this.window.webContents.openDevTools({ mode: "bottom" });
  }

  show(): void {
    this.window?.show();
  }

  /** Show, restore if minimized, and focus the window. */
  showRestoreOrFocus(): void {
    if (!this.window) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  hide(): void {
    this.window?.hide();
  }

  focus(): void {
    this.window?.focus();
  }

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  setQuitting(value: boolean): void {
    this.isQuitting = value;
  }
}
