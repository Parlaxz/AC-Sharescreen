import { Tray, Menu, nativeImage, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type TrayState = "idle" | "friend-online" | "sharing" | "viewing" | "sharing-and-viewing" | "degraded" | "error";

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
  onWatchFriend: () => void;
  onStopWatching: () => void;
  onSelectPreset: (presetId: string) => void;
  onToggleLaunchAtLogin: (checked: boolean) => void;
  onToggleAutoResume: (checked: boolean) => void;
  onToggleAllowRemoteQuality: (checked: boolean) => void;
  onToggleAutoWatch: (checked: boolean) => void;
  onShowDiagnostics: () => void;
}

export class TrayManager {
  private tray: Tray | null = null;
  private state: TrayState = "idle";
  private _viewerCount = 0;
  private friendName = "";
  private isSharing = false;
  private isViewing = false;
  private friendIsSharing = false;
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

  setFriendSharing(sharing: boolean): void {
    this.friendIsSharing = sharing;
    this.updateMenu();
  }

  setFriendName(name: string): void {
    this.friendName = name;
    this.updateMenu();
  }

  setViewerCount(count: number): void {
    this._viewerCount = count;
    this.updateMenu();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private updateMenu(): void {
    const statusText = this.getStatusText();
    const friendStatusText = this.friendName
      ? `Friend: ${this.friendName}${this.friendIsSharing ? " (sharing)" : ""}`
      : "Friend: Not connected";

    const presets = [
      { id: "egypt-ultra-saver", label: "Egypt Ultra Saver (640×360, 300kbps)" },
      { id: "egypt-data-saver", label: "Egypt Data Saver (854×480, 650kbps)" },
      { id: "text-and-coding", label: "Text & Coding (854×480, 450kbps)" },
      { id: "balanced", label: "Balanced (1280×720, 1.8Mbps)" },
      { id: "smooth-motion", label: "Smooth Motion (1280×720, 5Mbps)" },
    ];

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: "Open ScreenLink", click: () => this.actions.onOpen() },
      { label: `Status: ${statusText}`, enabled: false },
      { label: friendStatusText, enabled: false },
      ...(this._viewerCount > 0
        ? [{ label: `Viewers: ${this._viewerCount}`, enabled: false } as Electron.MenuItemConstructorOptions]
        : []),
      { type: "separator" as const },
    ];

    // Dynamic action buttons
    template.push(
      ...(this.isSharing
        ? [{ label: "Stop Sharing", click: () => this.actions.onStopSharing() } as Electron.MenuItemConstructorOptions]
        : [
            { label: "Share Screen", click: () => this.actions.onShareScreen() } as Electron.MenuItemConstructorOptions,
            { label: "Share Window", click: () => this.actions.onShareWindow() } as Electron.MenuItemConstructorOptions,
          ])
    );

    template.push(
      ...(this.isViewing
        ? [{ label: "Stop Watching", click: () => this.actions.onStopWatching() } as Electron.MenuItemConstructorOptions]
        : this.friendIsSharing
        ? [{ label: "Watch Friend", click: () => this.actions.onWatchFriend() } as Electron.MenuItemConstructorOptions]
        : [{ label: "Watch Friend", enabled: false } as Electron.MenuItemConstructorOptions])
    );

    template.push(
      { type: "separator" as const },
      { label: "Quality Presets", submenu: presets.map(p => ({
        label: p.label,
        click: () => this.actions.onSelectPreset(p.id),
      }))} as Electron.MenuItemConstructorOptions,
      { type: "separator" as const },
    );

    template.push(
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
      case "friend-online": return "Friend online";
      default: return "Idle";
    }
  }
}
