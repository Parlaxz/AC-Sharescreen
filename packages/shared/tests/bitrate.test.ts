import { describe, it, expect } from "vitest";
import {
  computeEffectiveVideoCeiling,
  computeScale,
} from "@screenlink/shared";

describe("computeEffectiveVideoCeiling", () => {
  it("returns requested bitrate when under all constraints", () => {
    expect(computeEffectiveVideoCeiling(500, 800, 2400, [])).toBe(500);
  });

  it("caps by maxPerViewer when requested exceeds it", () => {
    expect(computeEffectiveVideoCeiling(1000, 800, 2400, [])).toBe(800);
  });

  it("caps by remaining budget when other peers consume most of it", () => {
    expect(computeEffectiveVideoCeiling(1000, 800, 1200, [600, 400])).toBe(
      200,
    );
  });

  it("returns 0 when budget is exhausted", () => {
    expect(computeEffectiveVideoCeiling(500, 800, 1000, [600, 400])).toBe(0);
  });
});

describe("computeScale", () => {
  it("computes correct downscale factor for wide source", () => {
    // 1920/854 ≈ 2.248, 1080/480 = 2.25 → max(1, 2.248, 2.25) = 2.25
    const scale = computeScale(1920, 1080, 854, 480);
    expect(scale).toBeCloseTo(2.25, 10);
  });

  it("returns 1.0 when source matches target (no scaling)", () => {
    expect(computeScale(1920, 1080, 1920, 1080)).toBe(1);
  });

  it("returns 1.0 when source is smaller than target (no upscale)", () => {
    expect(computeScale(640, 360, 854, 480)).toBe(1);
  });

  it("handles portrait orientation", () => {
    const scale = computeScale(1080, 1920, 480, 854);
    // widthScale = 1080/480 = 2.25, heightScale = 1920/854 ≈ 2.248
    expect(scale).toBeCloseTo(2.25, 10);
  });
});
