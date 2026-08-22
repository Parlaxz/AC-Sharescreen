import { describe, expect, it } from "vitest";
import { evaluateFullscreenSuppression } from "../fullscreen-detector.js";

const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

function baseInput(overrides: Partial<Parameters<typeof evaluateFullscreenSuppression>[0]> = {}) {
  return {
    notificationState: null,
    windowRect: rect(0, 0, 1920, 1080),
    monitorRect: rect(0, 0, 1920, 1080),
    windowClassName: "GameWindow",
    windowStyle: 0,
    ...overrides,
  };
}

describe("evaluateFullscreenSuppression", () => {
  it("suppresses on exclusive D3D fullscreen notification state", () => {
    expect(evaluateFullscreenSuppression(baseInput({ notificationState: 3 }))).toBe(true);
  });

  it("suppresses on BUSY notification state", () => {
    expect(evaluateFullscreenSuppression(baseInput({ notificationState: 2 }))).toBe(true);
  });

  it("suppresses on presentation mode notification state", () => {
    expect(evaluateFullscreenSuppression(baseInput({ notificationState: 4 }))).toBe(true);
  });

  it("does not suppress when notifications are accepted and no window covers a monitor", () => {
    expect(
      evaluateFullscreenSuppression(
        baseInput({
          notificationState: 5,
          windowRect: rect(100, 100, 800, 600),
          monitorRect: rect(0, 0, 1920, 1080),
        }),
      ),
    ).toBe(false);
  });

  it("suppresses borderless fullscreen covering the monitor exactly", () => {
    expect(evaluateFullscreenSuppression(baseInput())).toBe(true);
  });

  it("does not suppress a maximized window that keeps caption chrome", () => {
    expect(
      evaluateFullscreenSuppression(baseInput({ windowStyle: WS_CAPTION | WS_THICKFRAME })),
    ).toBe(false);
  });

  it("never suppresses for the desktop shell windows", () => {
    expect(evaluateFullscreenSuppression(baseInput({ windowClassName: "Progman" }))).toBe(false);
    expect(evaluateFullscreenSuppression(baseInput({ windowClassName: "WorkerW" }))).toBe(false);
  });

  it("does not suppress partial monitor coverage", () => {
    expect(
      evaluateFullscreenSuppression(baseInput({ windowRect: rect(0, 0, 1919, 1080) })),
    ).toBe(false);
  });

  it("handles negative-coordinate monitors", () => {
    expect(
      evaluateFullscreenSuppression(
        baseInput({ windowRect: rect(-1920, 0, 0, 1080), monitorRect: rect(-1920, 0, 0, 1080) }),
      ),
    ).toBe(true);
  });

  it("returns false when foreground window data is unavailable", () => {
    expect(
      evaluateFullscreenSuppression(
        baseInput({ windowRect: null, monitorRect: null, windowClassName: null, windowStyle: null }),
      ),
    ).toBe(false);
  });
});
