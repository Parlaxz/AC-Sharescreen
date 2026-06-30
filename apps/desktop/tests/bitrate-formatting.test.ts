import { describe, expect, it } from "vitest";
import {
  formatBitrateBps,
  formatBitrateKbps,
} from "../src/renderer/lib/utils.js";

describe("bitrate formatting", () => {
  it("formats bps values as bitrate units", () => {
    expect(formatBitrateBps(2_000_000)).toBe("2.0 Mbps");
    expect(formatBitrateBps(64_000)).toBe("64.0 kbps");
  });

  it("formats kbps values as bitrate units", () => {
    expect(formatBitrateKbps(2_500)).toBe("2.5 Mbps");
    expect(formatBitrateKbps(300)).toBe("300 kbps");
  });

  it("returns em dash for missing or zero values", () => {
    expect(formatBitrateBps(null)).toBe("—");
    expect(formatBitrateBps(0)).toBe("—");
    expect(formatBitrateKbps(null)).toBe("—");
    expect(formatBitrateKbps(0)).toBe("—");
  });
});
