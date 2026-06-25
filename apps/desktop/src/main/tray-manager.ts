import { Tray, Menu, nativeImage, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type TrayState = "idle" | "sharing" | "viewing" | "sharing-and-viewing" | "degraded" | "error";

/**
 * Resolve the tray icon path based on whether the app is packaged.
 *
 * In development (unpackaged), the icon lives relative to `__dirname`
 * inside the source tree. In packaged builds, it is copied to
 * `process.resourcesPath` via electron-builder `extraResources`.
 */
export function getTrayIconPath(isPackaged: boolean): string {
  if (isPackaged) {
    return path.join(process.resourcesPath, "tray-icon.png");
  }
  return path.join(__dirname, "../../assets/tray-icon.png");
}

export interface TrayMenuActions {
  onOpen: () => void;
  onQuit: () => void;
  onShareScreen: () => void;
  onShareWindow: () => void;
  onStopSharing: () => void;
  onStopWatching: () => void;
  onToggleLaunchAtLogin: (checked: boolean) => void;
  onToggleAutoResume: (checked: boolean) => void;
  onShowDiagnostics: () => void;
}

export class TrayManager {
  private tray: Tray | null = null;
  private state: TrayState = "idle";
  private _viewerCount = 0;
  private _remoteStreamCount = 0;
  private isSharing = false;
  private isViewing = false;
  private actions: TrayMenuActions;

  constructor(actions: TrayMenuActions) {
    this.actions = actions;
  }

  create(): void {
    const iconPath = getTrayIconPath(app.isPackaged);
    let icon: Electron.NativeImage;
    try {
      icon = nativeImage.createFromPath(iconPath);
    } catch (err) {
      console.error(`[tray-manager] Failed to load icon from ${iconPath}`, err);
      icon = nativeImage.createEmpty();
    }

    if (icon.isEmpty()) {
      console.error(`[tray-manager] Tray icon is empty — path resolved to: ${iconPath}`);
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip("ScreenLink");

    this.tray.on("double-click", () => {
      this.actions.onOpen();
    });

    this.updateMenu();
  }

  setState(state: TrayState): void {
    this.state = state;
    this.updateMenu();
  }

  setSharing(sharing: boolean): void {
    this.isSharing = sharing;
    this.updateMenu();
  }

  setViewing(viewing: boolean): void {
    this.isViewing = viewing;
    this.updateMenu();
  }

  setViewerCount(count: number): void {
    this._viewerCount = count;
    this.updateMenu();
  }

  setRemoteStreamCount(count: number): void {
    this._remoteStreamCount = count;
    this.updateMenu();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private updateMenu(): void {
    const statusText = this.getStatusText();

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: "Open ScreenLink", click: () => this.actions.onOpen() },
      { label: `Status: ${statusText}`, enabled: false },
      ...(this._viewerCount > 0
        ? [{ label: `Connected viewers: ${this._viewerCount}`, enabled: false } as Electron.MenuItemConstructorOptions]
        : []),
      ...(this._remoteStreamCount > 0
        ? [{ label: `Available remote streams: ${this._remoteStreamCount}`, enabled: false } as Electron.MenuItemConstructorOptions]
        : []),
      { type: "separator" as const },
    ];

    if (this.isSharing) {
      template.push({ label: "Stop Streaming", click: () => this.actions.onStopSharing() });
    } else {
      // Phase 3: idle should open the app, not directly start a stream,
      // because the user must choose a source and a group from Dashboard.
      template.push({ label: "Open ScreenLink to share", enabled: false });
    }

    if (this.isViewing) {
      template.push({ label: "Stop Watching", click: () => this.actions.onStopWatching() });
    }

    template.push(
      { type: "separator" as const },
      { label: "Diagnostics", click: () => this.actions.onShowDiagnostics() },
      { type: "separator" as const },
      { label: "Quit Completely", click: () => this.actions.onQuit() },
    );

    this.tray?.setContextMenu(Menu.buildFromTemplate(template));
  }

  private getStatusText(): string {
    switch (this.state) {
      case "sharing": return "Sharing";
      case "viewing": return "Viewing";
      case "sharing-and-viewing": return "Sharing & Viewing";
      case "degraded": return "Sharing (degraded)";
      case "error": return "Error";
      default: return "Idle";
    }
  }
}
