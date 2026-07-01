import { describe, expect, it } from "vitest";
import type { TelemetrySample } from "@/services/bandwidth-telemetry-types";
import { computeKindTotals } from "../BandwidthGraphModal";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSample(overrides: Partial<TelemetrySample> & { mediaBitsPerSecond: number }): TelemetrySample {
  return {
    timestampMs: Date.now(),
    monotonicTimestampMs: performance.now(),
    intervalMs: 1000,
    videoBitsPerSecond: null,
    audioBitsPerSecond: null,
    transportBitsPerSecond: null,
    cumulativeMediaBytes: 0,
    cumulativeTransportBytes: null,
    configuredVideoBitsPerSecond: null,
    effectiveVideoBitsPerSecond: null,
    width: null,
    height: null,
    framesPerSecond: null,
    packetLossPercent: null,
    rttMs: null,
    jitterMs: null,
    codec: null,
    connectionType: null,
    state: "playing" as const,
    ...overrides,
  };
}

describe("computeKindTotals", () => {
  it("returns zeroes for empty samples", () => {
    const result = computeKindTotals([]);
    expect(result.videoBytes).toBe(0);
    expect(result.audioBytes).toBe(0);
    expect(result.transportBytes).toBe(0);
    expect(result.sampleCount).toBe(0);
    expect(result.videoRateSum).toBe(0);
    expect(result.audioRateSum).toBe(0);
  });

  it("apportions bytes proportionally when video+audio split is present", () => {
    // 8 Mbps total = 6 Mbps video + 2 Mbps audio, 1s interval
    // delta = (8_000_000 * 1000) / 8000 = 1_000_000 bytes
    // video fraction = 0.75 → 750_000 bytes
    // audio fraction = 0.25 → 250_000 bytes
    const samples = [
      makeSample({
        mediaBitsPerSecond: 8_000_000,
        videoBitsPerSecond: 6_000_000,
        audioBitsPerSecond: 2_000_000,
        intervalMs: 1000,
      }),
    ];
    const result = computeKindTotals(samples);
    expect(result.videoBytes).toBe(750_000);
    expect(result.audioBytes).toBe(250_000);
    expect(result.sampleCount).toBe(1);
  });

  it("handles video-only samples (no audio)", () => {
    // 4 Mbps total = 4 Mbps video, 0 audio
    // delta = (4_000_000 * 1000) / 8000 = 500_000 bytes
    // video fraction = 1.0 → 500_000 bytes
    const samples = [
      makeSample({
        mediaBitsPerSecond: 4_000_000,
        videoBitsPerSecond: 4_000_000,
        audioBitsPerSecond: 0,
        intervalMs: 1000,
      }),
    ];
    const result = computeKindTotals(samples);
    expect(result.videoBytes).toBe(500_000);
    expect(result.audioBytes).toBe(0);
    expect(result.sampleCount).toBe(1);
  });

  it("handles audio-only samples (no video)", () => {
    const samples = [
      makeSample({
        mediaBitsPerSecond: 128_000,
        videoBitsPerSecond: 0,
        audioBitsPerSecond: 128_000,
        intervalMs: 1000,
      }),
    ];
    const result = computeKindTotals(samples);
    expect(result.audioBytes).toBeGreaterThan(0);
    expect(result.videoBytes).toBe(0);
  });

  it("accumulates transport bytes separately", () => {
    const samples = [
      makeSample({
        mediaBitsPerSecond: 5_000_000,
        videoBitsPerSecond: 4_000_000,
        audioBitsPerSecond: 1_000_000,
        transportBitsPerSecond: 5_200_000,
        intervalMs: 1000,
      }),
    ];
    const result = computeKindTotals(samples);
    // transport delta = (5_200_000 * 1000) / 8000 = 650_000
    expect(result.transportBytes).toBe(650_000);
    // media delta = (5_000_000 * 1000) / 8000 = 625_000
    // video fraction = 0.8 → 500_000
    expect(result.videoBytes).toBe(500_000);
    expect(result.audioBytes).toBe(125_000);
    expect(result.transportRateSum).toBe(5_200_000);
  });

  it("accumulates rate sums across multiple samples", () => {
    const samples = [
      makeSample({ mediaBitsPerSecond: 5_000_000, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 1_000_000, intervalMs: 1000 }),
      makeSample({ mediaBitsPerSecond: 6_000_000, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 1_000_000, intervalMs: 1000 }),
    ];
    const result = computeKindTotals(samples);
    expect(result.videoRateSum).toBe(9_000_000);  // 4M + 5M
    expect(result.audioRateSum).toBe(2_000_000);  // 1M + 1M
    expect(result.sampleCount).toBe(2);
  });

  it("skips null video/audio when apportioning", () => {
    // When videoBitsPerSecond or audioBitsPerSecond is null, skip byte apportionment
    const samples = [
      makeSample({
        mediaBitsPerSecond: 1_000_000,
        videoBitsPerSecond: null,
        audioBitsPerSecond: null,
        intervalMs: 1000,
      }),
    ];
    const result = computeKindTotals(samples);
    expect(result.videoBytes).toBe(0);
    expect(result.audioBytes).toBe(0);
    expect(result.sampleCount).toBe(1);
    expect(result.videoRateSum).toBe(0);
    expect(result.audioRateSum).toBe(0);
  });

  it("establishes total = video + audio semantics in labels", () => {
    // Verify that the total bytes equals sum of video + audio estimates
    const samples = [
      makeSample({ mediaBitsPerSecond: 10_000_000, videoBitsPerSecond: 7_000_000, audioBitsPerSecond: 3_000_000, intervalMs: 1000 }),
      makeSample({ mediaBitsPerSecond: 8_000_000, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 2_000_000, intervalMs: 1000 }),
    ];
    const result = computeKindTotals(samples);
    // The media total is not exact since we apportion per-sample, but the
    // video+audio bytes sum should match the total delta bytes
    const totalDeltaBytes = samples.reduce((sum, s) => sum + Math.round((s.mediaBitsPerSecond * s.intervalMs) / 8000), 0);
    expect(result.videoBytes + result.audioBytes).toBe(totalDeltaBytes);
  });
});
