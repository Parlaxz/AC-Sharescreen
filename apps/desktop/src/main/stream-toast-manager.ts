import { BrowserWindow, screen, type WebContents } from "electron";
import type { FullscreenDetector } from "./fullscreen-detector.js";

export interface StreamToastPayload {
  groupId: string;
  hostDeviceId: string;
  logicalStreamId: string;
  hostName: string;
  groupName: string;
}

const TOAST_DEDUPE_MS = 30_000;
const TOAST_DURATION_MS = 12_000;

export function isStreamToastPayload(value: unknown): value is StreamToastPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return ["groupId", "hostDeviceId", "logicalStreamId", "hostName", "groupName"]
    .every((key) => typeof payload[key] === "string" && payload[key] !== "");
}

export class StreamToastManager {
  private window: BrowserWindow | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private lastShown = new Map<string, number>();

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly fullscreenDetector: FullscreenDetector,
    private readonly preloadPath: string,
  ) {}

  show(payload: StreamToastPayload): { shown: boolean; reason?: "fullscreen" | "deduped" } {
    const dedupeKey = `${payload.hostDeviceId}|${payload.groupId}`;
    const lastShownAt = this.lastShown.get(dedupeKey);
    if (lastShownAt !== undefined && Date.now() - lastShownAt < TOAST_DEDUPE_MS) {
      console.log("[stream-toast] suppressed (deduped):", dedupeKey);
      return { shown: false, reason: "deduped" };
    }

    const fullscreen = this.fullscreenDetector.checkFullscreen();
    if (fullscreen.fullscreen) {
      console.log("[stream-toast] suppressed (a fullscreen application is active)");
      return { shown: false, reason: "fullscreen" };
    }

    this.lastShown.set(dedupeKey, Date.now());
    this.pruneDedupe();
    this.destroyToast();

    const toastWindow = new BrowserWindow({
      width: 360,
      height: 120,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: this.preloadPath },
    });
    this.window = toastWindow;
    toastWindow.on("closed", () => {
      if (this.window === toastWindow) this.window = null;
    });
    toastWindow.setAlwaysOnTop(true, "screen-saver");

    const display = fullscreen.foregroundMonitorBounds
      ? screen.getDisplayMatching(fullscreen.foregroundMonitorBounds)
      : screen.getPrimaryDisplay();
    const margin = 16;
    toastWindow.setPosition(
      display.workArea.x + display.workArea.width - 360 - margin,
      display.workArea.y + display.workArea.height - 120 - margin,
    );
    toastWindow.webContents.on("did-finish-load", () => {
      console.log("[stream-toast] toast content rendered");
    });
    toastWindow.webContents.on("did-fail-load", (_event, code, desc) => {
      console.error("[stream-toast] did-fail-load:", code, desc);
    });
    toastWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error("[stream-toast] render-process-gone:", JSON.stringify(details));
    });
    toastWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderToastHtml(payload))}`).catch((err: unknown) => {
      console.error("[stream-toast] failed to load toast content:", err);
    });
    toastWindow.showInactive();
    setTimeout(() => {
      if (toastWindow.isDestroyed()) return;
      if (toastWindow.isVisible()) {
        const bounds = toastWindow.getBounds();
        console.log("[stream-toast] visibility check ok:", JSON.stringify(bounds));
      } else {
        console.error("[stream-toast] visibility check FAILED: window not visible after show");
      }
    }, 1000);
    this.dismissTimer = setTimeout(() => this.fadeAndDestroy(), TOAST_DURATION_MS);
    console.log("[stream-toast] shown for", payload.hostName, "in", payload.groupName);
    return { shown: true };
  }

  handleAction(sender: WebContents, value: unknown): void {
    if (!this.window || sender !== this.window.webContents || !value || typeof value !== "object") return;
    const actionValue = value as Record<string, unknown>;
    const action = actionValue.action;
    const payload = actionValue.payload;
    if ((action !== "join" && action !== "dismiss") || !isStreamToastPayload(payload)) return;
    this.destroyToast();
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stream-toast:action", { action, payload });
    }
  }

  dispose(): void {
    this.destroyToast();
    this.lastShown.clear();
  }

  private fadeAndDestroy(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.executeJavaScript("document.body.classList.add('leaving')").catch(() => {});
    this.dismissTimer = setTimeout(() => this.destroyToast(), 250);
  }

  private destroyToast(): void {
    if (this.dismissTimer !== null) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private pruneDedupe(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.lastShown) {
      if (now - timestamp >= TOAST_DEDUPE_MS) this.lastShown.delete(key);
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  })[character] ?? character);
}

function renderToastHtml(payload: StreamToastPayload): string {
  const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:Segoe UI,system-ui,sans-serif;color:#f5f7fb}body{padding:8px;animation:slide .22s ease-out}.card{height:104px;padding:14px 14px 12px;background:#17181c;border:1px solid #343740;border-radius:12px;box-shadow:0 10px 28px #0009;position:relative}.close{position:absolute;right:9px;top:7px;border:0;background:transparent;color:#8f96a3;font-size:18px;line-height:18px;cursor:pointer}.title{font-size:15px;font-weight:700;padding-right:22px}.group{font-size:12px;color:#9da3b0;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;gap:8px;margin-top:10px}.button{border-radius:6px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer}.join{border:1px solid #5b8cff;background:#3e6fe8;color:white}.dismiss{border:1px solid #414650;background:transparent;color:#c0c5cf}.leaving{animation:fade .25s ease-in forwards}@keyframes slide{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)}}@keyframes fade{to{opacity:0;transform:translateX(24px)}}
</style></head><body><div class="card"><button class="close" aria-label="Dismiss" onclick="dismiss()">×</button><div class="title">${escapeHtml(payload.hostName)} is streaming</div><div class="group">${escapeHtml(payload.groupName)}</div><div class="actions"><button class="button join" onclick="join()">Join</button><button class="button dismiss" onclick="dismiss()">Dismiss</button></div></div><script>const payload=${safePayload};function join(){window.toastAction('join',payload)}function dismiss(){window.toastAction('dismiss',payload)}</script></body></html>`;
}
