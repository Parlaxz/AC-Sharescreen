import { describe, expect, it } from "vitest";
import { formatHudFps, formatViewingDuration } from "./StreamInfoCard.js";

describe("StreamInfoCard HUD formatting", () => {
  it("floors FPS and pads single digits", () => {
    expect(formatHudFps(7.9)).toBe("07 FPS");
    expect(formatHudFps(30.9)).toBe("30 FPS");
  });

  it("formats viewing duration as HH:MM:SS", () => {
    expect(formatViewingDuration(3_723_456)).toBe("01:02:03");
    expect(formatViewingDuration(9_999)).toBe("00:00:09");
  });
});
