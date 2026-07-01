// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

describe("DiagnosticsPanel — At a glance column", () => {
  it("renders Resolution in rightmost column", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    // Resolution appears twice: in Detailed video and At a glance
    const res = screen.getAllByText("1920×1080");
    expect(res.length).toBeGreaterThanOrEqual(2);
  });

  it("renders FPS (prefers displayed from frameSamples)", () => {
    const snapshot = makeSnapshot();
    const frameSamples = [
      { timestamp: 1000, displayedFps: 59.5, decodedFps: 60, frameIntervalMs: 16.8, decodeTimeMs: 5, state: "playing" as const },
    ];
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} frameSamples={frameSamples} />);
    // Should show 59.5 (displayed FPS)
    expect(screen.getByText(/59\.5/)).toBeTruthy();
  });

  it("shows decoded FPS tooltip when displayed FPS available", () => {
    const snapshot = makeSnapshot();
    const frameSamples = [
      { timestamp: 1000, displayedFps: 59.5, decodedFps: 60, frameIntervalMs: 16.8, decodeTimeMs: 5, state: "playing" as const },
    ];
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} frameSamples={frameSamples} />);
    expect(screen.getByText(/decoded: 60/)).toBeTruthy();
  });

  it("falls back to decoded FPS when no displayed FPS", () => {
    const snapshot = makeSnapshot({
      aggregate: {
        ...makeSnapshot().aggregate,
        rawSamples: Object.freeze([makeSample({ framesPerSecond: 30 })]),
      },
    });
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} frameSamples={[]} />);
    expect(screen.getByText("30.0")).toBeTruthy();
  });

  it("renders Quality with requested bitrate", () => {
    const snapshot = makeSnapshot();
    render(
      <DiagnosticsPanel
        contentOnly
        snapshot={snapshot}
        requestedQuality={{ videoBitrateKbps: 10000, maxWidth: 1920, maxHeight: 1080, maxFps: 60 }}
      />,
    );
    expect(screen.getByText(/Request: 10\.0 Mbps/)).toBeTruthy();
  });

  it("renders Quality with effective bitrate", () => {
    const snapshot = makeSnapshot();
    render(
      <DiagnosticsPanel
        contentOnly
        snapshot={snapshot}
        effectiveBitrateKbps={8500}
      />,
    );
    expect(screen.getByText(/Effective: 8\.5 Mbps/)).toBeTruthy();
  });

  it("renders Bitrate as total with video and audio subline", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    // Subline with video and audio (appears in the sub text area)
    expect(screen.getByText(/Video 7\.5 Mbps/)).toBeTruthy();
    // Audio bitrate appears both in detailed audio and subline — use getAll
    const audioMatches = screen.getAllByText(/500\.0 kbps/);
    expect(audioMatches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("DiagnosticsPanel — Detailed audio section", () => {
  it("renders audio bitrate from snapshot", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("Detailed audio")).toBeTruthy();
    expect(screen.getByText("500.0 kbps")).toBeTruthy();
  });

  it("renders audio codec from snapshot", () => {
    const snapshot = makeSnapshot({
      aggregate: {
        ...makeSnapshot().aggregate,
        rawSamples: Object.freeze([makeSample({ codec: "audio/opus" })]),
      },
    });
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    // OPUS appears in both active codec (Detailed video) and Codec (Detailed audio)
    const opus = screen.getAllByText("OPUS");
    expect(opus.length).toBeGreaterThanOrEqual(2);
  });

  it("shows em-dash when audio data not available", () => {
    const snapshot = makeSnapshot({
      aggregate: {
        ...makeSnapshot().aggregate,
        rawSamples: Object.freeze([makeSample({ audioBitsPerSecond: null })]),
      },
    });
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("DiagnosticsPanel — Codec section", () => {
  it("renders requested codec separately from active codec", () => {
    const snapshot = makeSnapshot();
    render(
      <DiagnosticsPanel
        contentOnly
        snapshot={snapshot}
        requestedCodec="video/H265"
      />,
    );
    expect(screen.getByText("H265")).toBeTruthy(); // requested (unique)
    // H264 appears multiple times (active codec, audio codec, active receive)
    const h264 = screen.getAllByText("H264");
    expect(h264.length).toBeGreaterThanOrEqual(2);
  });

  it("shows codec Match: Yes when requested matches active", () => {
    const snapshot = makeSnapshot();
    render(
      <DiagnosticsPanel
        contentOnly
        snapshot={snapshot}
        requestedCodec="video/H264"
      />,
    );
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  it("shows codec Match: No when requested differs from active", () => {
    const snapshot = makeSnapshot();
    render(
      <DiagnosticsPanel
        contentOnly
        snapshot={snapshot}
        requestedCodec="video/H265"
      />,
    );
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("shows Unknown codec match when no requested codec", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("Unknown")).toBeTruthy();
  });
});

describe("DiagnosticsPanel — Unknown values", () => {
  it("renders em-dash for missing resolution", () => {
    const snapshot = makeSnapshot({
      aggregate: {
        ...makeSnapshot().aggregate,
        rawSamples: Object.freeze([makeSample({ width: null, height: null })]),
      },
    });
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    // Resolution should show em-dash
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it("renders null snapshot gracefully (no crash)", () => {
    const { container } = render(<DiagnosticsPanel contentOnly snapshot={null} />);
    const el = container.querySelector(".space-y-3");
    expect(el).toBeTruthy();
  });
});

describe("DiagnosticsPanel — Labels distinction", () => {
  it("renders distinct labels for Video, Audio, Connection, Network", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("Detailed video")).toBeTruthy();
    expect(screen.getByText("Detailed audio")).toBeTruthy();
    expect(screen.getByText("Connection")).toBeTruthy();
    expect(screen.getByText("Transport (wire)")).toBeTruthy();
  });
});

describe("DiagnosticsPanel — Connection health", () => {
  it("renders RTT from snapshot", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("15.0 ms")).toBeTruthy();
  });

  it("renders state with playing label", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("playing")).toBeTruthy();
  });
});

describe("DiagnosticsPanel — Copy button", () => {
  it("renders copy diagnostics button", () => {
    const snapshot = makeSnapshot();
    render(<DiagnosticsPanel contentOnly snapshot={snapshot} />);
    expect(screen.getByText("Copy diagnostics")).toBeTruthy();
  });
});
