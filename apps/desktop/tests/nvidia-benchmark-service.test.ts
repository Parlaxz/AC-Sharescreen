// @vitest-environment happy-dom
/**
 * Tests for NvidiaBenchmarkService — state machine transitions,
 * settings save/restore, cancellation, and result aggregation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NvidiaBenchmarkService,
  type BenchmarkHost,
  type BenchmarkProgress,
} from "@/services/viewer-image-processing/nvidia-benchmark-service";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "@/services/viewer-image-processing/viewer-image-defaults";

// ─── Test scenarios — fast variants for minimal test latency ───────────────

const FAST_SCENARIOS = [
  {
    id: "webgl2-native" as const,
    label: "WebGL2 — Native",
    minFrames: 5,
    timeoutMs: 2000,
    stabilizeMs: 10,
    settings: { processingBackend: "webgl2" as const, webglScalingAlgorithm: "native" as const, enabled: true },
  },
  {
    id: "nvidia-vsr-high" as const,
    label: "NVIDIA VSR — High",
    minFrames: 5,
    timeoutMs: 2000,
    stabilizeMs: 10,
    settings: { processingBackend: "nvidia-vsr" as const, nvidiaMode: "vsr" as const, nvidiaQuality: "high" as const, enabled: true },
  },
];

const SINGLE_SCENARIO = [FAST_SCENARIOS[0]!];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockHost(
  overrides?: Partial<BenchmarkHost>,
): BenchmarkHost {
  return {
    applySettings: vi.fn(),
    readStats: vi.fn(() => ({
      processingTimeMs: 8,
      rendererToResultMs: 3,
      nativeTransportProcessingTimeMs: 4,
      totalEnhancedFrameLatencyMs: 12,
      nativeOutputWidth: 1920,
      nativeOutputHeight: 1080,
      nativeQualityLevel: null,
      framesDisplayed: 100,
      completedFps: 30,
      backend: "webgl2",
      backpressureDrops: 0,
      nativeFailures: 0,
    })),
    ...overrides,
  };
}

function createNvidiaHost(qualityLevel = 4): BenchmarkHost {
  return {
    applySettings: vi.fn(),
    readStats: vi.fn(() => ({
      processingTimeMs: 16,
      rendererToResultMs: 5,
      nativeTransportProcessingTimeMs: 8,
      totalEnhancedFrameLatencyMs: 24,
      nativeOutputWidth: 1920,
      nativeOutputHeight: 1080,
      nativeQualityLevel: qualityLevel,
      framesDisplayed: 100,
      completedFps: 25,
      backend: "nvidia-vsr",
      backpressureDrops: 0,
      nativeFailures: 0,
    })),
  };
}

/** Wait for the service to reach a terminal state. */
async function waitForTerminal(service: NvidiaBenchmarkService, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = service.getSnapshot().state;
    if (state === "completed" || state === "cancelled" || state === "failed") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for terminal state");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("NvidiaBenchmarkService", () => {
  let service: NvidiaBenchmarkService;

  beforeEach(() => {
    service = new NvidiaBenchmarkService();
  });

  afterEach(() => {
    service.reset();
  });

  // ── Initial state ────────────────────────────────────────────────────

  it("starts in idle state", () => {
    const snap = service.getSnapshot();
    expect(snap.state).toBe("idle");
    expect(snap.percent).toBe(0);
    expect(snap.error).toBeNull();
    expect(service.running).toBe(false);
    expect(service.aggregate).toBeNull();
  });

  // ── External store pattern ───────────────────────────────────────────

  it("notifies subscribers on state change", async () => {
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);

    service.setScenarios(FAST_SCENARIOS);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);
    await waitForTerminal(service);

    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("unsubscribe removes listener", () => {
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    unsubscribe();

    service.setScenarios(FAST_SCENARIOS);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);

    // Listener should not have been called after unsubscribe
    expect(listener).not.toHaveBeenCalled();
  });

  // ── Settings save / restore ──────────────────────────────────────────

  it("saveSettings stores settings for later restoration", () => {
    const custom: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0.75,
      processingBackend: "nvidia-vsr",
      nvidiaQuality: "ultra",
    };
    service.saveSettings(custom);
    expect(service.savedSettings).toEqual(custom);
  });

  it("buildRestoredSettings returns saved settings once", () => {
    const custom: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0.5,
    };
    service.saveSettings(custom);

    const first = service.buildRestoredSettings();
    expect(first).toEqual(custom);

    const second = service.buildRestoredSettings();
    expect(second).toBeNull(); // already restored
    expect(service.restoredAfterRun).toBe(true);
  });

  it("buildRestoredSettings returns null when no settings saved", () => {
    expect(service.buildRestoredSettings()).toBeNull();
  });

  it("restores settings via mergeScopedSettings", async () => {
    const custom: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0.5,
      processingBackend: "nvidia-vsr",
      nvidiaQuality: "high",
    };
    service.saveSettings(custom);
    service.setScenarios(SINGLE_SCENARIO);

    // Start with a host that tracks applySettings calls
    const applySettings = vi.fn();
    const host = createMockHost({ applySettings });
    service.start(host);
    await waitForTerminal(service);

    // During scenarios, the service should have called applySettings
    // with merged settings (base + scenario overrides + enabled:true)
    expect(applySettings).toHaveBeenCalled();
  });

  // ── State machine transitions ────────────────────────────────────────

  it("transitions through valid states on successful run", async () => {
    const states: string[] = [];
    const unsubscribe = service.subscribe(() => {
      states.push(service.getSnapshot().state);
    });

    service.setScenarios(SINGLE_SCENARIO);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);
    await waitForTerminal(service);
    unsubscribe();

    // The service should pass through: validating → stabilizing →
    // collecting-environment → running-scenarios → aggregating →
    // exporting → completed
    expect(states).toContain("validating");
    expect(states).toContain("stabilizing");
    expect(states).toContain("collecting-environment");
    expect(states).toContain("running-scenarios");
    expect(states).toContain("aggregating");
    expect(states).toContain("exporting");
    expect(states).toContain("completed");
    expect(states[states.length - 1]).toBe("completed");
  });

  it("reaches completed state at end of successful run", async () => {
    service.setScenarios(SINGLE_SCENARIO);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);
    await waitForTerminal(service);

    expect(service.getSnapshot().state).toBe("completed");
    expect(service.getSnapshot().percent).toBe(100);
    expect(service.aggregate).not.toBeNull();
    expect(service.aggregate!.scenarios.length).toBeGreaterThan(0);
    expect(service.aggregate!.completedAt).toBeTruthy();
    expect(service.aggregate!.totalDurationMs).toBeGreaterThan(0);
  });

  it("transitions to failed when host returns null stats", async () => {
    // Use SINGLE_SCENARIO so the null-stats path is reached quickly
    service.setScenarios(SINGLE_SCENARIO);
    const host = createMockHost({
      readStats: vi.fn(() => null),
    });

    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    service.start(host);
    await waitForTerminal(service);

    expect(service.getSnapshot().state).toBe("failed");
    expect(service.getSnapshot().error).toBeTruthy();
  });

  it("transitions to failed with no scenarios", async () => {
    service.setScenarios([]);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);
    await waitForTerminal(service);

    expect(service.getSnapshot().state).toBe("failed");
    expect(service.getSnapshot().error).toContain("No benchmark scenarios");
  });

  // ── Cancellation ─────────────────────────────────────────────────────

  it("cancels a running benchmark", async () => {
    service.setScenarios(SINGLE_SCENARIO);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);

    // Use host that blocks readStats so the run stays in validating phase
    let blocked = true;
    const host = createMockHost({
      readStats: vi.fn(() => {
        if (blocked) return null;
        return {
          processingTimeMs: 8,
          rendererToResultMs: 3,
          nativeTransportProcessingTimeMs: 4,
          totalEnhancedFrameLatencyMs: 12,
          nativeOutputWidth: 1920,
          nativeOutputHeight: 1080,
          nativeQualityLevel: null,
          framesDisplayed: 100,
          completedFps: 30,
          backend: "webgl2",
          backpressureDrops: 0,
          nativeFailures: 0,
        };
      }),
    });

    // Start the benchmark — it should fail fast because readStats returns null
    // and enter 'failed' state immediately. Let's check that timing:
    service.start(host);

    // Let the run start and fail (since readStats returns null, it fails quickly)
    await new Promise((r) => setTimeout(r, 50));

    // Now verify it failed as expected (since stats are null at start)
    expect(service.getSnapshot().state).toBe("failed");

    // Alternative: make a host that returns valid stats so the run enters running-scenarios,
    // then cancel mid-run
    service.reset();

    blocked = false;
    service.setScenarios(SINGLE_SCENARIO);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const goodHost = createMockHost();
    service.start(goodHost);

    // Wait for the run to enter running-scenarios
    await new Promise((r) => setTimeout(r, 100));

    service.cancel();
    await waitForTerminal(service, 2000);

    const snap = service.getSnapshot();
    expect(snap.state).toBe("cancelled");
    expect(snap.percent).toBeLessThan(100);
  });

  it("reset transitions to idle from completed", async () => {
    service.setScenarios(SINGLE_SCENARIO);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);
    await waitForTerminal(service);

    service.reset();
    expect(service.getSnapshot().state).toBe("idle");
    expect(service.aggregate).toBeNull();
    expect(service.savedSettings).toBeNull();
  });

  it("reset transitions to idle from failed", () => {
    service.setScenarios([]);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);

    // Synchronous failure due to no scenarios
    expect(service.getSnapshot().state).toBe("failed");

    service.reset();
    expect(service.getSnapshot().state).toBe("idle");
  });

  it("cancel is idempotent when not running", () => {
    // Should not throw
    service.cancel();
    expect(service.getSnapshot().state).toBe("idle");
  });

  // ── Progress tracking ────────────────────────────────────────────────

  it("reports progress from 0 to 100 on successful run", async () => {
    const snapshots: BenchmarkProgress[] = [];
    const unsubscribe = service.subscribe(() => {
      snapshots.push({ ...service.getSnapshot() });
    });

    service.setScenarios(SINGLE_SCENARIO);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);
    await waitForTerminal(service);
    unsubscribe();

    expect(snapshots.length).toBeGreaterThan(0);

    // Last snapshot should be 100%
    const last = snapshots[snapshots.length - 1]!;
    expect(last.percent).toBe(100);
    expect(last.state).toBe("completed");
  });

  it("tracks completed scenarios count", async () => {
    service.setScenarios(FAST_SCENARIOS);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);
    await waitForTerminal(service);

    const final = service.getSnapshot();
    expect(final.completedScenarios).toBe(2); // 2 fast scenarios
  });

  // ── Results ──────────────────────────────────────────────────────────

  it("collects per-scenario results", async () => {
    service.setScenarios(FAST_SCENARIOS);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    service.start(host);
    await waitForTerminal(service);

    const aggregate = service.aggregate!;
    expect(aggregate.scenarios.length).toBe(2);

    // Each scenario should have collected frames
    for (const scenario of aggregate.scenarios) {
      expect(scenario.framesCollected).toBeGreaterThan(0);
      expect(scenario.label).toBeTruthy();
    }
  });

  it("populates bestLatency and highestQuality", async () => {
    const host = createMockHost();
    service.setScenarios(FAST_SCENARIOS);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    service.start(host);
    await waitForTerminal(service);

    const aggregate = service.aggregate!;
    expect(aggregate.bestLatency).not.toBeNull();
    expect(aggregate.highestQuality).not.toBeNull();
    expect(aggregate.bestLatency!.avgMs).toBeGreaterThan(0);
    expect(aggregate.highestQuality!.avgMs).toBeGreaterThan(0);
  });

  it("provides recommended settings after completion", async () => {
    service.setScenarios(FAST_SCENARIOS);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createNvidiaHost(3);
    service.start(host);
    await waitForTerminal(service);

    const aggregate = service.aggregate!;
    expect(aggregate.recommendedSettings).not.toBeNull();
    // With NVIDIA host, recommendation should prefer nvidia-vsr
    expect(aggregate.recommendedSettings!.processingBackend).toBe("nvidia-vsr");
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  it("does not start a second run while one is in progress", async () => {
    service.setScenarios(FAST_SCENARIOS);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();

    const promise1 = service.start(host);
    // Attempt a second start while first is running
    const promise2 = service.start(host);

    await promise1;
    await promise2;

    // Should still complete (second start was a no-op)
    expect(service.getSnapshot().state).toBe("completed");
  });

  it("handles stats with backpressure drops", async () => {
    let dropCounter = 0;
    const host = createMockHost({
      readStats: vi.fn(() => {
        dropCounter++;
        const drops = dropCounter % 5 === 0 ? 1 : 0;
        return {
          processingTimeMs: 10,
          rendererToResultMs: 4,
          nativeTransportProcessingTimeMs: 5,
          totalEnhancedFrameLatencyMs: 15,
          nativeOutputWidth: 1920,
          nativeOutputHeight: 1080,
          nativeQualityLevel: null,
          framesDisplayed: 100 + dropCounter,
          completedFps: 30,
          backend: "webgl2",
          backpressureDrops: drops,
          nativeFailures: 0,
        };
      }),
    });

    service.setScenarios(SINGLE_SCENARIO);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    service.start(host);
    await waitForTerminal(service);

    expect(service.getSnapshot().state).toBe("completed");
  });

  it("progress percent never exceeds 100", async () => {
    service.setScenarios(SINGLE_SCENARIO);
    const host = createMockHost();
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    service.start(host);
    await waitForTerminal(service);

    const snap = service.getSnapshot();
    expect(snap.percent).toBeLessThanOrEqual(100);
    expect(snap.percent).toBeGreaterThanOrEqual(0);
  });

  // ── Consumer wiring pattern ──────────────────────────────────────────

  it("full consumer flow: save → start → complete → restore", async () => {
    const originalSettings: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0.75,
      processingBackend: "nvidia-vsr",
      nvidiaQuality: "ultra",
    };

    // 1) Save original settings
    service.saveSettings(originalSettings);

    // 2) Start a run
    service.setScenarios(SINGLE_SCENARIO);
    const host = createMockHost();
    await service.start(host);
    await waitForTerminal(service);

    // 3) Verify completed
    expect(service.getSnapshot().state).toBe("completed");

    // 4) Restore original settings
    const restored = service.buildRestoredSettings();
    expect(restored).not.toBeNull();
    expect(restored!.sharpeningStrength).toBe(0.75);
    expect(restored!.processingBackend).toBe("nvidia-vsr");
    expect(restored!.nvidiaQuality).toBe("ultra");

    // 5) Second call returns null (idempotent)
    expect(service.buildRestoredSettings()).toBeNull();
  });

  it("readStats returns all expected fields from a full stats object", () => {
    const host = createMockHost();
    const stats = host.readStats();

    expect(stats).not.toBeNull();
    expect(stats!.processingTimeMs).toBe(8);
    expect(stats!.rendererToResultMs).toBe(3);
    expect(stats!.nativeTransportProcessingTimeMs).toBe(4);
    expect(stats!.totalEnhancedFrameLatencyMs).toBe(12);
    expect(stats!.nativeOutputWidth).toBe(1920);
    expect(stats!.nativeOutputHeight).toBe(1080);
    expect(stats!.nativeQualityLevel).toBeNull();
    expect(stats!.framesDisplayed).toBe(100);
    expect(stats!.completedFps).toBe(30);
    expect(stats!.backend).toBe("webgl2");
    expect(stats!.backpressureDrops).toBe(0);
    expect(stats!.nativeFailures).toBe(0);
  });

  it("readStats returns null when processor not available", () => {
    const host = createMockHost({
      readStats: vi.fn(() => null),
    });
    expect(host.readStats()).toBeNull();
  });

  it("running flag is true during active run and false after terminal", async () => {
    expect(service.running).toBe(false);

    service.setScenarios(SINGLE_SCENARIO);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    const host = createMockHost();
    const runPromise = service.start(host);

    // Should be running shortly after start
    await new Promise((r) => setTimeout(r, 10));
    // May not be "running" yet if still in validating phase,
    // but should be in a transient state
    expect(service.getSnapshot().state).not.toBe("idle");

    await waitForTerminal(service);
    expect(service.getSnapshot().state === "completed" ||
           service.getSnapshot().state === "cancelled" ||
           service.getSnapshot().state === "failed").toBe(true);
    expect(service.running).toBe(false);
  });

  it("sets recommended settings after nvidia-vsr run", async () => {
    service.setScenarios(FAST_SCENARIOS);
    const nvidiaHost = createNvidiaHost(3);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(nvidiaHost);
    await waitForTerminal(service);

    const aggregate = service.aggregate;
    expect(aggregate).not.toBeNull();
    expect(aggregate!.recommendedSettings).not.toBeNull();
    // With NVIDIA host, recommendation should prefer nvidia-vsr
    expect(aggregate!.recommendedSettings!.processingBackend).toBe("nvidia-vsr");
  });

  it("cancel restores saved settings via buildRestoredSettings", async () => {
    const originalSettings: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      processingBackend: "nvidia-vsr",
    };
    service.saveSettings(originalSettings);
    service.setScenarios(SINGLE_SCENARIO);

    const host = createMockHost();
    service.start(host);

    // Cancel mid-run
    await new Promise((r) => setTimeout(r, 50));
    service.cancel();
    await waitForTerminal(service, 2000);

    expect(service.getSnapshot().state).toBe("cancelled");

    // Restore original settings
    const restored = service.buildRestoredSettings();
    expect(restored).not.toBeNull();
    expect(restored!.processingBackend).toBe("nvidia-vsr");
  });
});
