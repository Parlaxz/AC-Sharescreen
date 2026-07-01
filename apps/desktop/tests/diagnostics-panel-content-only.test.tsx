// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { DiagnosticsPanel } from "../src/renderer/components/workspace/viewer/DiagnosticsPanel.js";

describe("DiagnosticsPanel contentOnly", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders at-a-glance values from snapshot in contentOnly mode", () => {
    const mockSnapshot = {
      historyId: "test-history-1",
      role: "viewer" as const,
      aggregate: {
        rawSamples: [{
          timestampMs: Date.now(),
          monotonicTimestampMs: performance.now(),
          intervalMs: 1000,
          mediaBitsPerSecond: 2_064_000,
          videoBitsPerSecond: 2_000_000,
          audioBitsPerSecond: 64_000,
          transportBitsPerSecond: 2_100_000,
          cumulativeMediaBytes: 250_000,
          cumulativeTransportBytes: 260_000,
          configuredVideoBitsPerSecond: null,
          effectiveVideoBitsPerSecond: null,
          width: 1280,
          height: 720,
          framesPerSecond: 30,
          packetLossPercent: 0,
          rttMs: 10,
          jitterMs: 2,
          codec: "video/VP9",
          connectionType: "direct" as const,
          state: "playing" as const,
        }],
        mediumBuckets: [], longBuckets: [], markers: [],
        currentBitsPerSecond: 2_064_000, averageBitsPerSecond: 2_000_000,
        peakBitsPerSecond: 2_064_000, totalBytes: 250_000,
        durationMs: 5000, activeDurationMs: 5000,
        configuredBitsPerSecond: null, effectiveBitsPerSecond: null,
        state: "playing" as const,
      },
      connections: [],
    };

    const { container } = render(
      <DiagnosticsPanel snapshot={mockSnapshot as any} contentOnly>
        <span />
      </DiagnosticsPanel>,
    );

    expect(container.textContent).toContain("VP9");
    expect(container.textContent).toContain("1280");
    expect(container.textContent).toContain("720");
    expect(container.textContent).toContain("30");
    expect(container.textContent).toContain("playing");
  });

  it("renders empty state when no snapshot and no frames", () => {
    const { container } = render(
      <DiagnosticsPanel snapshot={null} contentOnly>
        <span />
      </DiagnosticsPanel>,
    );
    expect(container.textContent).toContain("No diagnostics data yet.");
  });
});
