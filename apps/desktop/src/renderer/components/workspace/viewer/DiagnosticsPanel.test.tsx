// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DiagnosticsPanel } from "./DiagnosticsPanel.js";
import type { BandwidthSnapshot, TelemetrySample, ConnectionTelemetrySnapshot, ViewerReportedStatus } from "@/services/bandwidth-telemetry-types";

afterEach(cleanup);

// ─── Factory helpers ────────────────────────────────────────────────────────

function makeSample(overrides?: Partial<TelemetrySample>): TelemetrySample {
  return {
    timestampMs: 1000000,
    monotonicTimestampMs: 1000000,
    intervalMs: 1000,
    mediaBitsPerSecond: 8_000_000,
    videoBitsPerSecond: 7_500_000,
    audioBitsPerSecond: 500_000,
    transportBitsPerSecond: 8_200_000,
    cumulativeMediaBytes: 1_000_000,
    cumulativeTransportBytes: 1_050_000,
    configuredVideoBitsPerSecond: null,
    effectiveVideoBitsPerSecond: null,
    width: 1920,
    height: 1080,
    framesPerSecond: 60,
    packetLossPercent: 0.1,
    rttMs: 15,
    jitterMs: 2.5,
    codec: "video/H264",
    connectionType: "direct",
    state: "playing",
    ...overrides,
  };
}

function makeStatus(overrides?: Partial<ViewerReportedStatus>): ViewerReportedStatus {
  return {
    videoBitsPerSecond: 7_000_000,
    audioBitsPerSecond: 400_000,
    width: 1920,
    height: 1080,
    framesPerSecond: 60,
    decodedFramesPerSecond: 59,
    droppedFrames: 2,
    packetsReceived: 15000,
    packetsLost: 15,
    packetLossPercent: 0.1,
    rttMs: 15,
    jitterMs: 2.5,
    codec: "video/H264",
    connectionType: "direct",
    state: "playing",
    ...overrides,
  };
}

function makeConnection(overrides?: Partial<ConnectionTelemetrySnapshot>): ConnectionTelemetrySnapshot {
  return {
    connectionId: "conn-1",
    viewerDeviceId: "device-1",
    displayName: "Viewer 1",
    receivedStatus: makeStatus(),
    rawSamples: Object.freeze([]),
    mediumBuckets: Object.freeze([]),
    longBuckets: Object.freeze([]),
    markers: Object.freeze([]),
    currentBitsPerSecond: 8_000_000,
    averageBitsPerSecond: 7_500_000,
    peakBitsPerSecond: 10_000_000,
    totalBytes: 1_000_000,
    durationMs: 60000,
    activeDurationMs: 58000,
    configuredBitsPerSecond: 10_000_000,
    effectiveBitsPerSecond: 8_000_000,
    state: "playing",
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<BandwidthSnapshot>): BandwidthSnapshot {
  return {
    historyId: "history-1",
    role: "viewer",
    aggregate: {
      rawSamples: Object.freeze([makeSample()]),
      mediumBuckets: Object.freeze([]),
      longBuckets: Object.freeze([]),
      markers: Object.freeze([]),
      currentBitsPerSecond: 8_000_000,
      averageBitsPerSecond: 7_500_000,
      peakBitsPerSecond: 10_000_000,
      totalBytes: 1_000_000,
      durationMs: 60000,
      activeDurationMs: 58000,
      configuredBitsPerSecond: 10_000_000,
      effectiveBitsPerSecond: 8_000_000,
      state: "playing",
    },
    connections: Object.freeze([makeConnection()]),
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("DiagnosticsPanel — Header", () => {
  it("renders panel title", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("ScreenLink Viewer Diagnostics")).toBeTruthy();
  });

  it("renders copy button", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("Copy")).toBeTruthy();
  });
});

describe("DiagnosticsPanel — At a glance", () => {
  it("renders resolution from snapshot", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("1920×1080")).toBeTruthy();
  });

  it("renders FPS preferring displayed from frameSamples", () => {
    const snapshot = makeSnapshot();
    const frameSamples = [
      { timestamp: 1000, displayedFps: 59.5, decodedFps: 60, frameIntervalMs: 16.8, decodeTimeMs: 5, state: "playing" as const },
    ];
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} frameSamples={frameSamples} />);
    expect(screen.getByText(/59\.5/)).toBeTruthy();
  });

  it("shows decoded FPS sublabel when displayed FPS available", () => {
    const snapshot = makeSnapshot();
    const frameSamples = [
      { timestamp: 1000, displayedFps: 59.5, decodedFps: 60, frameIntervalMs: 16.8, decodeTimeMs: 5, state: "playing" as const },
    ];
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} frameSamples={frameSamples} />);
    expect(screen.getByText(/decoded: 60/)).toBeTruthy();
  });

  it("shows Collecting… when no FPS data yet", () => {
    const frameSamples = [
      { timestamp: 1000, displayedFps: null, decodedFps: null, frameIntervalMs: null, decodeTimeMs: null, state: "playing" as const },
    ];
    render(<DiagnosticsPanel contentOnly snapshot={null} frameSamples={frameSamples} />);
    // Multiple fields show Collecting… when data is absent
    expect(screen.getAllByText("Collecting…").length).toBeGreaterThan(0);
  });

  it("renders codec with match indicator", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("H264")).toBeTruthy();
  });

  it("renders state badge", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("playing")).toBeTruthy();
  });

  it("renders video/audio bitrate summary line", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText(/Video/)).toBeTruthy();
    expect(screen.getByText(/Audio/)).toBeTruthy();
  });
});

describe("DiagnosticsPanel — Advanced collapsible", () => {
  it("renders advanced diagnostics trigger collapsed by default", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("Advanced diagnostics")).toBeTruthy();
  });

  it("shows detailed sections when expanded", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    // Click to expand
    const trigger = screen.getByText("Advanced diagnostics");
    fireEvent.click(trigger);
    expect(screen.getByText("Detailed video")).toBeTruthy();
    expect(screen.getByText("Detailed audio")).toBeTruthy();
    expect(screen.getByText("Connection")).toBeTruthy();
    // "Codec" appears multiple times: as a at-a-glance label, section title, and row label
    expect(screen.getAllByText("Codec").length).toBeGreaterThan(0);
  });
});

describe("DiagnosticsPanel — Empty state", () => {
  it("shows empty state when no snapshot and no frames", () => {
    render(<DiagnosticsPanel contentOnly snapshot={null} />);
    expect(screen.getByText("No diagnostics data yet.")).toBeTruthy();
  });

  it("renders with frames but no snapshot", () => {
    const frameSamples = [
      { timestamp: 1000, displayedFps: 60, decodedFps: 60, frameIntervalMs: 16.67, decodeTimeMs: 5, state: "playing" as const },
    ];
    render(<DiagnosticsPanel contentOnly snapshot={null} frameSamples={frameSamples} />);
    // Should show Collecting… for values rather than empty state
    expect(screen.getAllByText("Collecting…").length).toBeGreaterThan(0);
    // Should not show "No diagnostics data yet"
    expect(screen.queryByText("No diagnostics data yet.")).toBeNull();
  });
});

describe("DiagnosticsPanel — Codec match", () => {
  it("shows codec Match: Yes when requested matches active", () => {
    const snapshot = makeSnapshot();
    render(
      <DiagnosticsPanel contentOnly snapshot={snapshot} requestedCodec="video/H264">
        <span />
      </DiagnosticsPanel>,
    );
    const trigger = screen.getByText("Advanced diagnostics");
    fireEvent.click(trigger);
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  it("shows codec Match: No when requested differs from active", () => {
    const snapshot = makeSnapshot();
    render(
      <DiagnosticsPanel contentOnly snapshot={snapshot} requestedCodec="video/H265">
        <span />
      </DiagnosticsPanel>,
    );
    const trigger = screen.getByText("Advanced diagnostics");
    fireEvent.click(trigger);
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("shows Unknown codec match when no requested codec", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    const trigger = screen.getByText("Advanced diagnostics");
    fireEvent.click(trigger);
    expect(screen.getByText("Unknown")).toBeTruthy();
  });
});
