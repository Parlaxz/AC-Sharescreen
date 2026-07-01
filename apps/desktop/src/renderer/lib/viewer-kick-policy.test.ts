import { describe, expect, it } from "vitest";
import { shouldAutoKickViewer, shouldShowViewerAfterKick, VIEWER_AUTO_KICK_MS } from "./viewer-kick-policy";

describe("viewer kick policy", () => {
  it("auto-kicks stale viewers after 15 seconds when not paused", () => {
    expect(
      shouldAutoKickViewer(
        { state: "unknown", lastStatusAt: 5_000 },
        5_000 + VIEWER_AUTO_KICK_MS,
      ),
    ).toBe(true);
  });

  it("does not auto-kick paused viewers", () => {
    expect(
      shouldAutoKickViewer(
        { state: "paused", lastStatusAt: 5_000 },
        5_000 + VIEWER_AUTO_KICK_MS + 5_000,
      ),
    ).toBe(false);
  });

  it("does not auto-kick viewers that have never reported status", () => {
    expect(
      shouldAutoKickViewer(
        { state: "unknown", lastStatusAt: null },
        100_000,
      ),
    ).toBe(false);
  });

  it("keeps kicked viewers hidden until a newer status arrives", () => {
    expect(shouldShowViewerAfterKick(5_000, 6_000)).toBe(false);
    expect(shouldShowViewerAfterKick(7_000, 6_000)).toBe(true);
    expect(shouldShowViewerAfterKick(null, 6_000)).toBe(false);
    expect(shouldShowViewerAfterKick(5_000, undefined)).toBe(true);
  });
});
