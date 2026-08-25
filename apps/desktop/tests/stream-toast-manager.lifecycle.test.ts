// @vitest-environment node
//
// Lifecycle suite for StreamToastManager against a scripted Electron mock.
// Validates window construction options, bottom-right anchoring, dedupe and
// fullscreen gates, auto-dismiss, action routing, and HTML escaping.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const createdWindows: any[] = [];
  const displays: Record<string, any> = {};
  let activeDisplay: string;
  return {
    createdWindows,
    displays,
    setActiveDisplay(name: string) {
      activeDisplay = name;
    },
    getActiveDisplay: () => activeDisplay,
  };
});

vi.mock("electron", () => {
  class FakeWebContents {
    send = vi.fn();
    executeJavaScript = vi.fn().mockResolvedValue(undefined);
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    on(event: string, cb: (...args: unknown[]) => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    emitLocal(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
  }

  class FakeBrowserWindow {
    opts: any;
    webContents = new FakeWebContents();
    destroyed = false;
    visible = false;
    bounds: any = null;
    alwaysOnTopLevel: string | null = null;
    loadedUrls: string[] = [];

    constructor(opts: any) {
      this.opts = opts;
      h.createdWindows.push(this);
    }

    on(_event: string, _cb: (...args: unknown[]) => void): void {
      /* recorded implicitly via tests when needed */
    }
    setAlwaysOnTop(_v: boolean, level?: string): void {
      this.alwaysOnTopLevel = level ?? null;
    }
    setPosition(x: number, y: number): void {
      this.bounds = { ...(this.bounds ?? {}), x, y };
    }
    loadURL(url: string): Promise<void> {
      this.loadedUrls.push(url);
      return Promise.resolve();
    }
    showInactive(): void {
      this.visible = true;
    }
    isVisible(): boolean {
      return this.visible && !this.destroyed;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.visible = false;
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return (
        this.bounds ?? { x: 0, y: 0, width: this.opts.width, height: this.opts.height }
      );
    }
  }

  const screen = {
    getPrimaryDisplay: () => h.displays[h.getActiveDisplay()] ?? h.displays.primary,
    getDisplayMatching: (bounds: { x: number; y: number; width: number; height: number }) => {
      // Pick the display whose bounds contain the given rect's center.
      for (const d of Object.values(h.displays) as any[]) {
        const b = d.bounds;
        if (
          bounds.x >= b.x &&
          bounds.y >= b.y &&
          bounds.x + bounds.width <= b.x + b.width &&
          bounds.y + bounds.height <= b.y + b.height
        ) {
          return d;
        }
      }
      return h.displays[h.getActiveDisplay()] ?? h.displays.primary;
    },
  };

  return { BrowserWindow: FakeBrowserWindow, screen };
});

import { BrowserWindow, screen } from "electron";
import { StreamToastManager, isStreamToastPayload } from "../src/renderer/../main/stream-toast-manager.js";

function makeDetector(result: { fullscreen: boolean; foregroundMonitorBounds?: any }) {
  return { checkFullscreen: () => result };
}

function makeMainWindow() {
  return { webContents: { send: vi.fn() }, isDestroyed: () => false } as any;
}

const PAYLOAD = {
  groupId: "g1",
  hostDeviceId: "host-1",
  logicalStreamId: "ls-1",
  hostName: "Alice",
  groupName: "Weekly Games",
};

describe("StreamToastManager lifecycle", () => {
  let gcmless: StreamToastManager;
  let mainWindow: any;

  beforeEach(() => {
    vi.clearAllMocks();
    h.createdWindows.length = 0;
    h.displays.primary = {
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    };
    h.displays.secondary = {
      id: 2,
      bounds: { x: -1920, y: 0, width: 2560, height: 1440 },
      workArea: { x: -1920, y: 0, width: 2560, height: 1392 },
    };
    h.setActiveDisplay("primary");
    mainWindow = makeMainWindow();
    gcmless = new StreamToastManager(
      mainWindow as any,
      makeDetector({ fullscreen: false }) as any,
      "\\\\fake\\preload.js",
    );
  });

  afterEach(() => {
    gcmless.dispose();
    vi.useRealTimers();
  });

  function lastWindow(): any {
    return h.createdWindows[h.createdWindows.length - 1];
  }

  it("creates a frameless, non-focusable, always-on-top toast window", () => {
    const r = gcmless.show(PAYLOAD);
    expect(r.shown).toBe(true);

    const w = lastWindow();
    expect(w.opts.frame).toBe(false);
    expect(w.opts.transparent).toBe(true);
    expect(w.opts.focusable).toBe(false);
    expect(w.opts.skipTaskbar).toBe(true);
    expect(w.opts.resizable).toBe(false);
    expect(w.alwaysOnTopLevel).toBe("screen-saver");
  });

  it("anchors the toast to the bottom-right of the work area with margins", () => {
    gcmless.show(PAYLOAD);
    const w = lastWindow();
    // 1920x1040 workArea, 360x120 toast, 16px margins
    expect(w.bounds.x).toBe(1920 - 360 - 16);
    expect(w.bounds.y).toBe(1040 - 120 - 16);
  });

  it("anchors to the display where the foreground window lives (multi-monitor)", () => {
    const mgr = new StreamToastManager(
      mainWindow as any,
      makeDetector({
        fullscreen: false,
        foregroundMonitorBounds: { x: -1920, y: 100, width: 800, height: 600 },
      }) as any,
      "\\\\fake\\preload.js",
    );
    mgr.show(PAYLOAD);
    const w = lastWindow();
    // Secondary workArea: x=-1920 w=2560, y=0 h=1392
    expect(w.bounds.x).toBe(-1920 + 2560 - 360 - 16);
    expect(w.bounds.y).toBe(1392 - 120 - 16);
    mgr.dispose();
  });

  it("dedupes repeated shows for the same host+group within the cooldown", () => {
    expect(gcmless.show(PAYLOAD).shown).toBe(true);
    const second = gcmless.show(PAYLOAD);
    expect(second).toEqual({ shown: false, reason: "deduped" });
    expect(h.createdWindows.length).toBe(1);
  });

  it("does not show when the fullscreen detector reports an active fullscreen app", () => {
    const blocked = new StreamToastManager(
      mainWindow as any,
      makeDetector({ fullscreen: true }) as any,
      "\\\\fake\\preload.js",
    );
    const r = blocked.show(PAYLOAD);
    expect(r).toEqual({ shown: false, reason: "fullscreen" });
    expect(h.createdWindows.length).toBe(0);
    blocked.dispose();
  });

  it("auto-dismisses: destroys the toast after duration plus fade", async () => {
    vi.useFakeTimers();
    gcmless.show(PAYLOAD);
    const w = lastWindow();

    await vi.advanceTimersByTimeAsync(12_000); // duration elapsed -> fade starts
    await vi.advanceTimersByTimeAsync(300); // fade completes -> destroy
    expect(w.destroyed).toBe(true);
  });

  it("routes join actions from the real toast sender to the main window", () => {
    gcmless.show(PAYLOAD);
    const w = lastWindow();

    gcmless.handleAction(w.webContents as any, { action: "join", payload: PAYLOAD });

    expect(mainWindow.webContents.send).toHaveBeenCalledWith("stream-toast:action", {
      action: "join",
      payload: PAYLOAD,
    });
    expect(w.destroyed).toBe(true);
  });

  it("ignores actions from unknown senders (spoofing guard)", () => {
    gcmless.show(PAYLOAD);
    const w = lastWindow();

    const impostor = { webContents: {} } as any;
    gcmless.handleAction(impostor as any, { action: "join", payload: PAYLOAD });

    expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    expect(w.destroyed).toBe(false);
  });

  it("escapes HTML in host and group names (XSS safety)", () => {
    gcmless.show({
      groupId: "g-xss",
      hostDeviceId: "evil",
      logicalStreamId: "ls-xss",
      hostName: '<img src=x onerror=alert(1)>',
      groupName: "<script>alert(2)</script>",
    });

    const url = decodeURIComponent(lastWindow().loadedUrls[0]);
    expect(url).not.toContain("<img src=x");
    expect(url).toContain("&lt;img src=x");
    expect(url).not.toContain("<script>alert(2)");
  });

  it("validates payloads strictly", () => {
    expect(isStreamToastPayload({})).toBe(false);
    expect(isStreamToastPayload({ ...PAYLOAD, hostName: "" })).toBe(false);
    expect(isStreamToastPayload({ ...PAYLOAD, extra: true })).toBe(true);
    expect(isStreamToastPayload(null)).toBe(false);
  });
});
