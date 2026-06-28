// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  createBandwidthTracker,
  updateBandwidthTracker,
} from "../src/renderer/services/viewer-bandwidth.js";

describe("viewer bandwidth tracker", () => {
  it("establishes baseline on first call without counting bytes or computing rate", () => {
    const initial = createBandwidthTracker();

    const next = updateBandwidthTracker(initial, 12_500, 1_000, null);

    expect(next.hasBaseline).toBe(true);
    expect(next.totalBytes).toBe(0);
    expect(next.currentBitsPerSecond).toBe(0);
    expect(next.lastCumulativeBytes).toBe(12_500);
    expect(next.lastSampleAtMs).toBe(1_000);
    expect(next.lastSsrc).toBeNull();
  });

  it("computes bitrate from delta and accumulates totalBytes on subsequent calls", () => {
    const first = updateBandwidthTracker(
      createBandwidthTracker(), 10_000, 1_000, null,
    );

    const next = updateBandwidthTracker(first, 22_000, 2_500, null);

    // delta = 22_000 - 10_000 = 12_000 bytes over 1.5s
    expect(next.totalBytes).toBe(12_000);
    expect(next.currentBitsPerSecond).toBe(64_000); // 12_000 * 8 / 1.5
  });

  it("resets baseline when cumulative bytes decrease (counter reset), no delta counted", () => {
    const first = updateBandwidthTracker(
      createBandwidthTracker(), 50_000, 1_000, null,
    );
    const second = updateBandwidthTracker(first, 62_000, 2_000, null);

    const next = updateBandwidthTracker(second, 3_000, 3_000, null);

    // 12_000 bytes accumulated before reset, then counter dropped to 3_000
    expect(next.totalBytes).toBe(12_000);
    expect(next.currentBitsPerSecond).toBe(0);
    expect(next.lastCumulativeBytes).toBe(3_000);
  });

  it("resets baseline when SSRC changes, drops bytes from old stream", () => {
    const first = updateBandwidthTracker(
      createBandwidthTracker(), 10_000, 1_000, 0xabc,
    );

    const next = updateBandwidthTracker(first, 20_000, 2_000, 0xdef);

    expect(next.totalBytes).toBe(0);
    expect(next.currentBitsPerSecond).toBe(0);
    expect(next.lastCumulativeBytes).toBe(20_000);
    expect(next.lastSsrc).toBe(0xdef);
  });

  it("does not accumulate bytes when paused, but keeps baseline current", () => {
    const initial = createBandwidthTracker();
    const first = updateBandwidthTracker(initial, 10_000, 1_000, null);

    const paused = { ...first, paused: true };
    const next = updateBandwidthTracker(paused, 22_000, 2_500, null);

    expect(next.totalBytes).toBe(0);
    expect(next.currentBitsPerSecond).toBe(0);
    expect(next.lastCumulativeBytes).toBe(22_000);
  });
});
