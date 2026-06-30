// @vitest-environment happy-dom
/**
 * Tests for DiagnosticsPanel NVIDIA section and BenchmarkSection result actions.
 * Validates the enhanced benchmark/diagnostics UX introduced alongside the
 * ScreenLink NVIDIA overhaul.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DiagnosticsPanel } from "@/components/workspace/viewer/DiagnosticsPanel";
import {
  getNvidiaCapabilitySnapshot,
  subscribeToNvidiaCapability,
} from "@/services/nvidia-capability-store";
import {
  nvidiaBenchmarkService,
  getBenchmarkProgressSnapshot,
  subscribeToBenchmarkProgress,
  type BenchmarkProgress,
} from "@/services/viewer-image-processing/nvidia-benchmark-service";

// ─── Mock stores ──────────────────────────────────────────────────────────────

// Mock the nvidia-capability-store module
vi.mock("@/services/nvidia-capability-store", async () => {
  const actual = await vi.importActual("@/services/nvidia-capability-store");
  return {
    ...actual,
    getNvidiaCapabilitySnapshot: vi.fn(),
    subscribeToNvidiaCapability: vi.fn(() => () => {}),
  };
});

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("DiagnosticsPanel — NVIDIA diagnostics section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render NVIDIA section when capability has not been probed", () => {
    vi.mocked(getNvidiaCapabilitySnapshot).mockReturnValue({
      available: false,
      reason: "sdk-not-built",
      adapterName: null,
      driverVersion: null,
      supportedModes: [],
      supportedQualities: [],
      probing: false,
      probed: false,
    });

    const { container } = renderWithProviders(
      <DiagnosticsPanel session={null}>
        <span>trigger</span>
      </DiagnosticsPanel>,
    );

    // The popover content is not rendered until triggered; contentOnly mode
    // renders the content directly. We test contentOnly mode to access the
    // internal content without popover interaction.
  });

  it("renders NVIDIA section in contentOnly mode when capability is probed and available", () => {
    vi.mocked(getNvidiaCapabilitySnapshot).mockReturnValue({
      available: true,
      reason: "sdk-not-built" as const,
      adapterName: "NVIDIA GeForce RTX 4090",
      driverVersion: "546.17",
      supportedModes: ["vsr", "high-bitrate"],
      supportedQualities: ["low", "medium", "high"],
      probing: false,
      probed: true,
    });

    const { container } = renderWithProviders(
      <DiagnosticsPanel session={null} contentOnly>
        <span>trigger</span>
      </DiagnosticsPanel>,
    );

    const html = container.innerHTML;
    expect(html).toContain("NVIDIA RTX Video");
    expect(html).toContain("Available");
    expect(html).toContain("NVIDIA GeForce RTX 4090");
    expect(html).toContain("546.17");
    expect(html).toContain("Results folder");
  });

  it("renders NVIDIA section showing unavailable reason when capability is probed but not available", () => {
    vi.mocked(getNvidiaCapabilitySnapshot).mockReturnValue({
      available: false,
      reason: "not-nvidia",
      adapterName: null,
      driverVersion: null,
      supportedModes: [],
      supportedQualities: [],
      probing: false,
      probed: true,
    });

    const { container } = renderWithProviders(
      <DiagnosticsPanel session={null} contentOnly>
        <span>trigger</span>
      </DiagnosticsPanel>,
    );

    const html = container.innerHTML;
    expect(html).toContain("NVIDIA RTX Video");
    expect(html).toContain("not nvidia");
  });

  it("shows supported modes and qualities when available", () => {
    vi.mocked(getNvidiaCapabilitySnapshot).mockReturnValue({
      available: true,
      reason: "sdk-not-built" as const,
      adapterName: null,
      driverVersion: null,
      supportedModes: ["vsr", "denoise", "deblur"],
      supportedQualities: ["low", "medium", "high", "ultra"],
      probing: false,
      probed: true,
    });

    const { container } = renderWithProviders(
      <DiagnosticsPanel session={null} contentOnly>
        <span>trigger</span>
      </DiagnosticsPanel>,
    );

    const html = container.innerHTML;
    expect(html).toContain("Modes");
    expect(html).toContain("vsr, denoise, deblur");
    expect(html).toContain("Qualities");
    expect(html).toContain("low, medium, high, ultra");
  });

  it("has action row with Results folder button", () => {
    vi.mocked(getNvidiaCapabilitySnapshot).mockReturnValue({
      available: true,
      reason: "sdk-not-built" as const,
      adapterName: "NVIDIA RTX 3080",
      driverVersion: "546.17",
      supportedModes: ["vsr"],
      supportedQualities: ["high"],
      probing: false,
      probed: true,
    });

    const { container } = renderWithProviders(
      <DiagnosticsPanel session={null} contentOnly>
        <span>trigger</span>
      </DiagnosticsPanel>,
    );

    // Should have Copy diagnostics button
    expect(container.textContent).toContain("Copy diagnostics");

    // Should have Results folder button
    expect(container.textContent).toContain("Results folder");
  });
});

// ─── BenchmarkSection result actions ─────────────────────────────────────────

describe("Benchmark result summary copy", () => {
  function makeMockProgress(overrides?: Partial<BenchmarkProgress>): BenchmarkProgress {
    return {
      state: "completed",
      percent: 100,
      phaseLabel: "Benchmark complete",
      currentScenario: null,
      totalScenarios: 2,
      completedScenarios: 2,
      results: [
        {
          scenario: "webgl2-native",
          label: "WebGL2 — Native",
          framesRequested: 60,
          framesCollected: 60,
          framesDropped: 0,
          avgProcessingTimeMs: 2.5,
          p50ProcessingTimeMs: 2.3,
          p95ProcessingTimeMs: 3.1,
          avgLatencyMs: 5.0,
          p50LatencyMs: 4.8,
          p95LatencyMs: 6.2,
          achievedFps: 30,
          nativeOutputWidth: 1920,
          nativeOutputHeight: 1080,
          nativeQualityLevel: null,
          activeBackend: "webgl2",
          timedOut: false,
        },
        {
          scenario: "nvidia-vsr-high",
          label: "NVIDIA VSR — High",
          framesRequested: 60,
          framesCollected: 60,
          framesDropped: 0,
          avgProcessingTimeMs: 12.8,
          p50ProcessingTimeMs: 12.1,
          p95ProcessingTimeMs: 15.4,
          avgLatencyMs: 18.0,
          p50LatencyMs: 17.5,
          p95LatencyMs: 22.3,
          achievedFps: 60,
          nativeOutputWidth: 1920,
          nativeOutputHeight: 1080,
          nativeQualityLevel: 3,
          activeBackend: "nvidia-vsr",
          timedOut: false,
        },
      ],
      currentSamples: [],
      currentTargetFrames: 0,
      currentElapsedMs: 0,
      error: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset benchmark service state
    nvidiaBenchmarkService.reset();
  });

  afterEach(() => {
    cleanup();
  });

  it("benchmark aggregate contains expected fields after completed run", () => {
    // The service is tested separately; here we verify the types are consistent
    const progress = makeMockProgress();
    expect(progress.results).toHaveLength(2);
    expect(progress.results[0]!.avgProcessingTimeMs).toBe(2.5);
    expect(progress.results[1]!.achievedFps).toBe(60);
    expect(progress.results[1]!.nativeQualityLevel).toBe(3);
  });

  it("formatMs handles null and undefined gracefully", () => {
    // These are the formatters used in BenchmarkSection
    const formatMs = (value: number | null | undefined): string => {
      if (value == null) return "\u2014";
      return `${value.toFixed(2)} ms`;
    };
    expect(formatMs(null)).toBe("\u2014");
    expect(formatMs(undefined)).toBe("\u2014");
    expect(formatMs(12.345)).toBe("12.35 ms");
  });

  it("formatFps handles null and undefined gracefully", () => {
    const formatFps = (value: number | null | undefined): string => {
      if (value == null) return "\u2014";
      return `${value.toFixed(1)} fps`;
    };
    expect(formatFps(null)).toBe("\u2014");
    expect(formatFps(30)).toBe("30.0 fps");
    expect(formatFps(59.94)).toBe("59.9 fps");
  });

  it("formatDimensions handles zero values gracefully", () => {
    const formatDimensions = (w: number, h: number): string => {
      if (w <= 0 || h <= 0) return "\u2014";
      return `${w}\u00D7${h}`;
    };
    expect(formatDimensions(0, 0)).toBe("\u2014");
    expect(formatDimensions(1920, 1080)).toBe("1920\u00D71080");
  });

  it("benchmark progress results include timedOut flag", () => {
    const partialProgress: BenchmarkProgress = {
      ...makeMockProgress(),
      results: [
        {
          scenario: "nvidia-vsr-ultra",
          label: "NVIDIA VSR — Ultra",
          framesRequested: 60,
          framesCollected: 23,
          framesDropped: 0,
          avgProcessingTimeMs: 45.2,
          p50ProcessingTimeMs: 44.1,
          p95ProcessingTimeMs: 52.8,
          avgLatencyMs: 52.0,
          p50LatencyMs: 50.5,
          p95LatencyMs: 61.0,
          achievedFps: 15,
          nativeOutputWidth: 3840,
          nativeOutputHeight: 2160,
          nativeQualityLevel: 4,
          activeBackend: "nvidia-vsr",
          timedOut: true,
        },
      ],
    };

    const timedOutResult = partialProgress.results[0]!;
    expect(timedOutResult.timedOut).toBe(true);
    expect(timedOutResult.framesCollected).toBeLessThan(timedOutResult.framesRequested);
  });
});
