import { BrowserWindow, app } from "electron";
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
   * Create the main BrowserWindow with secure defaults and close-to-tray behavior.
   */
  create(): BrowserWindow {
    this.window = new BrowserWindow({
      width: 960,
      height: 700,
      minWidth: 720,
      minHeight: 500,
      show: false,
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

    // Open DevTools in development
    if (process.env.NODE_ENV === "development" || devServerUrl) {
      this.window.webContents.openDevTools({ mode: "bottom" });
    }

    return this.window;
  }

  show(): void {
    this.window?.show();
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
