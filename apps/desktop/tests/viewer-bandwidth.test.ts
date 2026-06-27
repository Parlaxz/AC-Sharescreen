// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  createBandwidthTracker,
  updateBandwidthTracker,
} from "../src/renderer/services/viewer-bandwidth.js";

describe("viewer bandwidth tracker", () => {
  it("initializes from the first observed sample without a rate spike", () => {
    const initial = createBandwidthTracker();

    const next = updateBandwidthTracker(initial, 12_500, 1_000);

    expect(next.totalBytesReceived).toBe(12_500);
    expect(next.currentBytesPerSecond).toBe(0);
    expect(next.lastObservedBytes).toBe(12_500);
    expect(next.lastSampleAtMs).toBe(1_000);
  });

  it("computes current rate using actual elapsed time and accumulates deltas", () => {
    const first = updateBandwidthTracker(createBandwidthTracker(), 10_000, 1_000);

    const next = updateBandwidthTracker(first, 22_000, 2_500);

    expect(next.totalBytesReceived).toBe(22_000);
    expect(next.currentBytesPerSecond).toBe(8_000);
  });

  it("keeps total monotonic when observed counters reset", () => {
    const first = updateBandwidthTracker(createBandwidthTracker(), 50_000, 1_000);
    const second = updateBandwidthTracker(first, 62_000, 2_000);

    const next = updateBandwidthTracker(second, 3_000, 3_000);

    expect(next.totalBytesReceived).toBe(65_000);
    expect(next.currentBytesPerSecond).toBe(3_000);
    expect(next.lastObservedBytes).toBe(3_000);
  });
});
