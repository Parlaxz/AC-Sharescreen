import { createRequire } from "node:module";

export interface FullscreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FullscreenEvaluationInput {
  notificationState: number | null;
  windowRect: FullscreenRect | null;
  monitorRect: FullscreenRect | null;
  windowClassName: string | null;
  windowStyle: number | null;
}

export function evaluateFullscreenSuppression(input: FullscreenEvaluationInput): boolean {
  if (input.notificationState !== null && [2, 3, 4].includes(input.notificationState)) {
    return true;
  }

  if (
    !input.windowRect ||
    !input.monitorRect ||
    !input.windowClassName ||
    input.windowStyle === null ||
    input.windowClassName === "Progman" ||
    input.windowClassName === "WorkerW"
  ) {
    return false;
  }

  const coversMonitor =
    input.windowRect.left === input.monitorRect.left &&
    input.windowRect.top === input.monitorRect.top &&
    input.windowRect.right === input.monitorRect.right &&
    input.windowRect.bottom === input.monitorRect.bottom;
  const hasWindowChrome = (input.windowStyle & (0x00c00000 | 0x00040000)) !== 0;
  return coversMonitor && !hasWindowChrome;
}

interface KoffiModule {
  struct: (name: string, definition: Record<string, unknown>) => unknown;
  load: (name: string) => { func: (name: string, returnType: string, argTypes: string[]) => (...args: never[]) => unknown };
}

interface NativeBindings {
  getForegroundWindow: () => unknown;
  getWindowRect: (window: unknown, rect: FullscreenRect) => boolean;
  monitorFromWindow: (window: unknown, flags: number) => unknown;
  getMonitorInfo: (monitor: unknown, info: NativeMonitorInfo) => boolean;
  getWindowLong: (window: unknown, index: number) => number;
  getClassName: (window: unknown, buffer: Buffer, length: number) => number;
  queryNotificationState: (state: Buffer) => number;
}

interface NativeMonitorInfo {
  cbSize: number;
  rcMonitor: FullscreenRect;
  rcWork: FullscreenRect;
  dwFlags: number;
}

const require = createRequire(import.meta.url);

export class FullscreenDetector {
  private bindings: NativeBindings | null = null;
  private nativeTypes: unknown[] = [];
  private unavailable = false;
  private warned = false;

  constructor() {
    this.initialize();
  }

  checkFullscreen(): {
    fullscreen: boolean;
    foregroundMonitorBounds?: { x: number; y: number; width: number; height: number };
  } {
    if (process.platform !== "win32" || !this.initialize() || !this.bindings) {
      return { fullscreen: false };
    }

    try {
      const bindings = this.bindings;
      const notificationBuffer = Buffer.alloc(4);
      const notificationResult = bindings.queryNotificationState(notificationBuffer);
      const notificationState = notificationResult === 0 ? notificationBuffer.readUInt32LE(0) : null;
      const foregroundWindow = bindings.getForegroundWindow();
      if (!foregroundWindow) {
        return { fullscreen: evaluateFullscreenSuppression({ notificationState, windowRect: null, monitorRect: null, windowClassName: null, windowStyle: null }) };
      }

      const windowRect: FullscreenRect = { left: 0, top: 0, right: 0, bottom: 0 };
      const monitor = bindings.monitorFromWindow(foregroundWindow, 2);
      const monitorInfo: NativeMonitorInfo = {
        cbSize: 40,
        rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
        rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
        dwFlags: 0,
      };
      const hasWindowRect = bindings.getWindowRect(foregroundWindow, windowRect);
      const hasMonitorInfo = Boolean(monitor) && bindings.getMonitorInfo(monitor, monitorInfo);
      const classBuffer = Buffer.alloc(512);
      const classLength = bindings.getClassName(foregroundWindow, classBuffer, 256);
      const windowClassName = classLength > 0 ? classBuffer.toString("utf16le", 0, classLength * 2) : null;
      const windowStyle = bindings.getWindowLong(foregroundWindow, -16);
      const monitorRect = hasMonitorInfo ? monitorInfo.rcMonitor : null;

      return {
        fullscreen: evaluateFullscreenSuppression({
          notificationState,
          windowRect: hasWindowRect ? windowRect : null,
          monitorRect,
          windowClassName,
          windowStyle: hasWindowRect ? windowStyle : null,
        }),
        ...(monitorRect ? { foregroundMonitorBounds: { x: monitorRect.left, y: monitorRect.top, width: monitorRect.right - monitorRect.left, height: monitorRect.bottom - monitorRect.top } } : {}),
      };
    } catch (error) {
      this.warnFailure(error);
      return { fullscreen: false };
    }
  }

  private initialize(): boolean {
    if (process.platform !== "win32") return false;
    if (this.bindings && this.nativeTypes.length > 0) return true;
    if (this.unavailable) return false;

    try {
      const koffi = require("koffi") as KoffiModule;
      const rect = koffi.struct("RECT", { left: "long", top: "long", right: "long", bottom: "long" });
      const monitorInfo = koffi.struct("MONITORINFO", { cbSize: "uint", rcMonitor: rect, rcWork: rect, dwFlags: "uint" });
      this.nativeTypes = [rect, monitorInfo];
      const user32 = koffi.load("user32.dll");
      const shell32 = koffi.load("shell32.dll");
      this.bindings = {
        getForegroundWindow: user32.func("__stdcall GetForegroundWindow", "void *", []),
        getWindowRect: user32.func("__stdcall GetWindowRect", "bool", ["void *", "_Out_ RECT *"]) as NativeBindings["getWindowRect"],
        monitorFromWindow: user32.func("__stdcall MonitorFromWindow", "void *", ["void *", "uint"]) as NativeBindings["monitorFromWindow"],
        getMonitorInfo: user32.func("__stdcall GetMonitorInfoW", "bool", ["void *", "_Inout_ MONITORINFO *"]) as NativeBindings["getMonitorInfo"],
        getWindowLong: user32.func("__stdcall GetWindowLongW", "long", ["void *", "int"]) as NativeBindings["getWindowLong"],
        getClassName: user32.func("__stdcall GetClassNameW", "int", ["void *", "_Out_ uint16_t *", "int"]) as NativeBindings["getClassName"],
        queryNotificationState: shell32.func("__stdcall SHQueryUserNotificationState", "int", ["_Out_ uint *"]) as NativeBindings["queryNotificationState"],
      };
      return true;
    } catch (error) {
      this.unavailable = true;
      this.warnFailure(error);
      return false;
    }
  }

  private warnFailure(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn("[fullscreen-detector] Fullscreen detection unavailable; failing open", error);
  }
}
