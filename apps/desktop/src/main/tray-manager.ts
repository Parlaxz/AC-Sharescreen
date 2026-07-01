import { Tray, Menu, nativeImage, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type TrayState = "idle" | "sharing" | "viewing" | "sharing-and-viewing" | "degraded" | "error";

const STATE_ICON_MAP: Record<TrayState, string> = {
  idle: "tray-icon-blue.png",
  viewing: "tray-icon-green.png",
  sharing: "tray-icon-orange.png",
  "sharing-and-viewing": "tray-icon-red.png",
  degraded: "tray-icon-orange.png",
  error: "tray-icon-red.png",
};

/**
 * Resolve the tray icon path based on the current state and whether the app
 * is packaged.
 *
 * In development (unpackaged), the icon lives relative to `__dirname`
 * inside the source tree. In packaged builds, it is copied to
 * `process.resourcesPath` via electron-builder `extraResources`.
 */
export function getTrayIconPath(state: TrayState, isPackaged: boolean): string {
  const filename = STATE_ICON_MAP[state];
  if (isPackaged) {
    return path.join(process.resourcesPath, filename);
  }
  return path.join(__dirname, `../../assets/${filename}`);
}

export interface TrayMenuActions {
  onOpen: () => void;
  onQuit: () => void;
  onShareScreen: () => void;
  onShareWindow: () => void;
  onStopSharing: () => void;
  onStopWatching: () => void;
  onQuickShare: () => void;
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
    const iconPath = getTrayIconPath(this.state, app.isPackaged);
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
    this.updateIcon();
  }

  setState(state: TrayState): void {
    this.state = state;
    this.updateMenu();
    this.updateIcon();
  }

  setSharing(sharing: boolean): void {
    this.isSharing = sharing;
    this.updateMenu();
    this.updateIcon();
  }

  setViewing(viewing: boolean): void {
    this.isViewing = viewing;
    this.updateMenu();
    this.updateIcon();
  }

  setViewerCount(count: number): void {
    this._viewerCount = count;
    this.updateMenu();
    this.updateIcon();
  }

  setRemoteStreamCount(count: number): void {
    this._remoteStreamCount = count;
    this.updateMenu();
    this.updateIcon();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private updateIcon(): void {
    if (!this.tray) return;

    let effectiveState: TrayState;
    if (this.isSharing && this._viewerCount > 0) {
      effectiveState = "sharing-and-viewing";
    } else if (this.isSharing) {
      effectiveState = "sharing";
    } else if (this.isViewing) {
      effectiveState = "viewing";
    } else {
      effectiveState = "idle";
    }

    const iconPath = getTrayIconPath(effectiveState, app.isPackaged);
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      this.tray.setImage(icon);
    }
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
      template.push({ label: "Quick Share…", click: () => this.actions.onQuickShare() });
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
