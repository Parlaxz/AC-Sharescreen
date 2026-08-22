// @vitest-environment happy-dom
/**
 * RTL behavior tests for BandwidthGraphModal.
 *
 * Tests focus on the audited defects:
 *  1. Identical contentOnly branches (both paths return the same wrapper)
 *  2. Fixed 950px width overflows on smaller viewports
 *  3. Accessible modal semantics
 *  4. Empty/loading states
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

// ─── NOTE on vi.mock ordering ──────────────────────────────────────────────
// vi.mock factory callbacks are HOISTED to the top of the file by vitest.
// They CANNOT reference any variable, import, or function defined below them
// in the same file. All data used by mock factories must be inlined.

// Mock recharts to avoid SVG rendering issues in happy-dom
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  AreaChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="area-chart">{children}</div>
  ),
  Area: () => <div data-testid="area" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  Tooltip: () => <div data-testid="tooltip" />,
  ReferenceLine: () => <div data-testid="ref-line" />,
  Label: () => <div data-testid="label" />,
}));

// Mock ScrollArea to avoid Radix infinite loop in happy-dom
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>{children}</div>
  ),
}));

// Mock StreamMetricsService — must return stable snapshot refs to avoid
// useSyncExternalStore infinite re-render. Factory is hoisted, so data is inlined.
vi.mock("@/services/stream-metrics-service", () => {
  // Stable frozen object — same reference every call
  const stableSnapshot = Object.freeze({
    historyId: "test-history",
    role: "host",
    aggregate: Object.freeze({
      rawSamples: Object.freeze([]),
      mediumBuckets: Object.freeze([]),
      longBuckets: Object.freeze([]),
      markers: Object.freeze([]),
      currentBitsPerSecond: 0,
      averageBitsPerSecond: 0,
      peakBitsPerSecond: 0,
      totalBytes: 0,
      durationMs: 0,
      activeDurationMs: 0,
      configuredBitsPerSecond: null,
      effectiveBitsPerSecond: null,
      currentVideoBitsPerSecond: null,
      currentAudioBitsPerSecond: null,
      currentTransportBitsPerSecond: null,
      state: "paused",
    }),
    connections: Object.freeze([]),
  });
  return {
    StreamMetricsService: {
      getInstance: () => ({
        findHistoryIdByMediaSessionId: () => "test-history",
        getSnapshot: () => stableSnapshot,
        subscribe: () => () => {},
      }),
    },
  };
});

// Mock bandwidth telemetry services
vi.mock("@/services/bandwidth-telemetry-types", () => ({
  fmtBitRate: (v: number) => v > 0 ? `${(v / 1_000_000).toFixed(1)} Mbps` : "0 bps",
  fmtCumulativeBytes: (v: number) => `${(v / 1_000_000).toFixed(1)} MB`,
  fmtDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
  fmtHourlyUsage: (v: number) => `${(v / 1_000_000_000).toFixed(1)} GB/h`,
  computeWindowedEstimate: () => ({ bytesPerHour: 0 }),
}));

// Mock settings actions
vi.mock("@/services/settings-actions", () => ({
  loadSettings: () => Promise.resolve({ hourlyEstimateDurationMs: 10_000 }),
}));

// ─── Import AFTER mocks (vitest hoists mocks to top) ──────────────────────

import { BandwidthGraphModal } from "../src/renderer/components/workspace/BandwidthGraphModal";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── contentOnly branch fix ──────────────────────────────────────────────────

describe("BandwidthGraphModal contentOnly branches", () => {
  it("does not render controlled modal content while closed", () => {
    render(
      <BandwidthGraphModal
        open={false}
        mediaSessionId="test-session"
      />,
    );

    expect(screen.queryByText("Bandwidth")).not.toBeInTheDocument();
  });

  it("renders content directly when contentOnly=true", () => {
    render(
      <BandwidthGraphModal
        open={true}
        mediaSessionId="test-session"
        contentOnly={true}
      />,
    );

    // Should show bandwidth heading
    expect(screen.getByText("Bandwidth")).toBeInTheDocument();
  });

  it("does NOT use fixed w-[950px] wrapper in contentOnly mode (prevents overflow)", () => {
    const { container } = render(
      <BandwidthGraphModal
        open={true}
        mediaSessionId="test-session"
        contentOnly={true}
      />,
    );

    // Scan for the exact standalone `w-[950px]` class (NOT `max-w-[950px]`).
    // `max-w-[950px]` is a responsive constraint; `w-[950px]` is a fixed width that overflows.
    const allElements = container.querySelectorAll("*");
    const hasFixed950px = Array.from(allElements).some((el) => {
      if (!el.className || typeof el.className !== "string") return false;
      const classes = el.className.split(/\s+/);
      return classes.includes("w-[950px]");
    });

    // Should NOT have the exact fixed 950px width (prevents overflow on small viewports)
    expect(hasFixed950px).toBe(false);
  });

  it("contentOnly=true does not render extra popover triggers", () => {
    render(
      <BandwidthGraphModal
        open={true}
        mediaSessionId="test-session"
        contentOnly={true}
      />,
    );

    // The time-range buttons are intentional controls, not popover triggers
    // There should be no hidden-trigger elements
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(4); // time range buttons
    expect(buttons.length).toBeLessThanOrEqual(6); // no hidden extras
  });
});

// ─── Empty/loading states ────────────────────────────────────────────────────

describe("BandwidthGraphModal empty state", () => {
  it('shows "No bandwidth data available yet" when no data present', () => {
    render(
      <BandwidthGraphModal
        open={true}
        mediaSessionId="test-session"
        contentOnly={true}
      />,
    );

    expect(
      screen.getByText("No bandwidth data available yet."),
    ).toBeInTheDocument();
  });
});

// ─── Summary metrics ─────────────────────────────────────────────────────────

describe("BandwidthGraphModal summary metrics", () => {
  it("renders all summary metric labels", () => {
    render(
      <BandwidthGraphModal
        open={true}
        mediaSessionId="test-session"
        contentOnly={true}
      />,
    );

    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("Peak")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
  });

  it("renders technical metric values with font-mono tabular-nums", () => {
    const { container } = render(
      <BandwidthGraphModal
        open={true}
        mediaSessionId="test-session"
        contentOnly={true}
      />,
    );

    // Multiple elements should have font-mono and tabular-nums
    const monoElements = container.querySelectorAll(".font-mono.tabular-nums");
    expect(monoElements.length).toBeGreaterThanOrEqual(4);
  });
});
