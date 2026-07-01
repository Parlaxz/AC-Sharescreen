// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  FramePerformanceGraph,
  prepareFrameRateData,
  prepareFrameTimeData,
  type FramePerformanceSample,
} from "./FramePerformanceGraph.js";

afterEach(cleanup);

// ─── Sample factories ──────────────────────────────────────────────────────

function makeSample(
  overrides: Partial<FramePerformanceSample> & { timestamp: number },
): FramePerformanceSample {
  // Default values first, then overrides — so null overrides work
  const defaults: FramePerformanceSample = {
    timestamp: overrides.timestamp,
    displayedFps: 60,
    decodedFps: 60,
    frameIntervalMs: 16.67,
    decodeTimeMs: 5,
    state: "playing",
  };
  return { ...defaults, ...overrides };
}

// ─── prepareFrameRateData ──────────────────────────────────────────────────

describe("prepareFrameRateData", () => {
  it("maps displayed and decoded FPS when playing", () => {
    const samples = [
      makeSample({ timestamp: 1000, displayedFps: 60, decodedFps: 59 }),
      makeSample({ timestamp: 2000, displayedFps: 30, decodedFps: 30 }),
    ];
    const data = prepareFrameRateData(samples, 120);
    expect(data).toHaveLength(2);
    expect(data[0].displayedFps).toBe(60);
    expect(data[0].decodedFps).toBe(59);
    expect(data[1].displayedFps).toBe(30);
    expect(data[1].decodedFps).toBe(30);
  });

  it("produces null values when not playing (graph gaps)", () => {
    const samples = [
      makeSample({ timestamp: 1000, state: "paused" }),
      makeSample({ timestamp: 2000, state: "playing" }),
      makeSample({ timestamp: 3000, state: "reconnecting" }),
    ];
    const data = prepareFrameRateData(samples, 120);
    expect(data[0].displayedFps).toBeNull();
    expect(data[0].decodedFps).toBeNull();
    expect(data[1].displayedFps).toBe(60);
    expect(data[1].decodedFps).toBe(60);
    expect(data[2].displayedFps).toBeNull();
    expect(data[2].decodedFps).toBeNull();
  });

  it("truncates to maxSamples from the end", () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      makeSample({ timestamp: i * 1000 }),
    );
    const data = prepareFrameRateData(samples, 3);
    expect(data).toHaveLength(3);
    expect(data[0]!.time).toBe(7000);
    expect(data[2]!.time).toBe(9000);
  });

  it("returns empty array for empty input", () => {
    expect(prepareFrameRateData([], 120)).toEqual([]);
  });

  it("handles null FPS values", () => {
    const samples = [
      makeSample({ timestamp: 1000, displayedFps: null, decodedFps: null }),
    ];
    const data = prepareFrameRateData(samples, 120);
    expect(data[0].displayedFps).toBeNull();
    expect(data[0].decodedFps).toBeNull();
  });
});

// ─── prepareFrameTimeData ──────────────────────────────────────────────────

describe("prepareFrameTimeData", () => {
  it("maps frame interval and decode time when playing", () => {
    const samples = [
      makeSample({ timestamp: 1000, frameIntervalMs: 16.67, decodeTimeMs: 5 }),
    ];
    const data = prepareFrameTimeData(samples, 120);
    expect(data[0].frameIntervalMs).toBe(16.67);
    expect(data[0].decodeTimeMs).toBe(5);
  });

  it("produces null values when paused (graph gaps)", () => {
    const samples = [
      makeSample({ timestamp: 1000, state: "paused" }),
      makeSample({ timestamp: 2000, state: "playing" }),
    ];
    const data = prepareFrameTimeData(samples, 120);
    expect(data[0].frameIntervalMs).toBeNull();
    expect(data[0].decodeTimeMs).toBeNull();
    expect(data[1].frameIntervalMs).toBe(16.67);
  });

  it("truncates to maxSamples", () => {
    const samples = Array.from({ length: 150 }, (_, i) =>
      makeSample({ timestamp: i * 1000 }),
    );
    const data = prepareFrameTimeData(samples, 120);
    expect(data).toHaveLength(120);
    expect(data[0]!.time).toBe(30000);
  });
});

// ─── Rendered component tests ──────────────────────────────────────────────

describe("FramePerformanceGraph rendered", () => {
  it("shows empty state when no samples", () => {
    render(<FramePerformanceGraph samples={[]} />);
    expect(screen.getByText("No frame rate data yet.")).toBeTruthy();
  });

  it("shows empty state when all non-playing samples", () => {
    const samples = [
      makeSample({ timestamp: 1000, state: "paused" }),
      makeSample({ timestamp: 2000, state: "reconnecting" }),
    ];
    render(<FramePerformanceGraph samples={samples} />);
    expect(screen.getByText("No frame rate data yet.")).toBeTruthy();
    expect(screen.getByText("No frame time data yet.")).toBeTruthy();
  });

  it("renders both frame rate and frame time sections side-by-side", () => {
    const samples = [makeSample({ timestamp: 1000, displayedFps: 60, frameIntervalMs: 16.67 })];
    render(<FramePerformanceGraph samples={samples} />);
    expect(screen.getByText("Frame rate")).toBeTruthy();
    expect(screen.getByText("Frame time")).toBeTruthy();
  });
});
