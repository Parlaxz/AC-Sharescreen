import { describe, it, expect } from "vitest";
import {
  computeKbps,
  estimateBytesPerHour,
  formatDataAmount,
} from "@screenlink/shared";

describe("computeKbps", () => {
  it("computes correct kbps for valid inputs", () => {
    // 500 bytes in 1s = 500*8/1/1000 = 4 Kbps
    expect(computeKbps(1000, 500, 1000)).toBe(4);
  });

  it("returns null for negative delta (counter reset)", () => {
    expect(computeKbps(500, 1000, 1000)).toBeNull();
  });

  it("returns null for zero elapsed time", () => {
    expect(computeKbps(1000, 500, 0)).toBeNull();
  });

  it("returns null for negative elapsed time", () => {
    expect(computeKbps(1000, 500, -100)).toBeNull();
  });

  it("returns 0 when bytes did not change", () => {
    expect(computeKbps(500, 500, 1000)).toBe(0);
  });

  it("computes large values correctly", () => {
    // 1MB in 1s = 1048576*8/1/1000 = 8388.608 Kbps
    const result = computeKbps(1_048_576, 0, 1000);
    expect(result).toBeCloseTo(8388.608, 3);
  });
});

describe("estimateBytesPerHour", () => {
  it("computes correct bytes for 650 kbps", () => {
    // (650 * 1000) / 8 * 3600 = 292,500,000
    expect(estimateBytesPerHour(650)).toBe(292_500_000);
  });

  it("computes correct bytes for 0 kbps", () => {
    expect(estimateBytesPerHour(0)).toBe(0);
  });

  it("computes correct bytes for 5000 kbps", () => {
    // (5000 * 1000) / 8 * 3600 = 2,250,000,000
    expect(estimateBytesPerHour(5000)).toBe(2_250_000_000);
  });
});

describe("formatDataAmount", () => {
  it("formats bytes correctly", () => {
    const result = formatDataAmount(1_000_000_000);
    expect(result).toBe("1.00 GB / 0.93 GiB");
  });

  it("formats zero bytes", () => {
    const result = formatDataAmount(0);
    expect(result).toBe("0.00 GB / 0.00 GiB");
  });
});
