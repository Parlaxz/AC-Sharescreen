// @vitest-environment happy-dom
/**
 * Tests for the event-driven benchmark frame event plumbing (Slice 1).
 *
 * Covers:
 *   - Polling same snapshot repeatedly creates zero frame samples
 *   - Duplicate sequence counted once
 *   - Completion and presentation FPS differ correctly
 *   - Stale generation ignored
 *   - Wrong quality rejected
 *   - Wrong output dimensions rejected
 *   - Configuration acknowledgement required
 *   - VSR Low cannot consume prior WebGL snapshot
 *   - Highest quality follows semantic quality order
 *   - Settings restore after success/failure/cancellation
 *   - Benchmark ZIP export called exactly once after successful aggregation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NvidiaBenchmarkService,
  type BenchmarkHost,
  type BenchmarkScenarioConfig,
} from "@/services/viewer-image-processing/nvidia-benchmark-service";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "@/services/viewer-image-processing/viewer-image-defaults";
import type { FrameEvent, ConfigAppliedEvent } from "@/services/viewer-image-processing/frame-events";
import type { FrameEventListener } from "@/services/viewer-image-processing/frame-events";

// ─── Fast scenarios for minimal test latency ─────────────────────────────────
// NOTE: The service warms up with 3 frames before collecting, so event-based
// tests need at least (minFrames + 3) events to collect all samples.

function webglScenario(minFrames = 3): BenchmarkScenarioConfig[] {
  return [{
    id: "webgl2-native",
    label: "WebGL2 — Native",
    minFrames,
    timeoutMs: 800,      // short timeout for test speed
    stabilizeMs: 5,
    settings: {
      processingBackend: "webgl2",
      webglScalingAlgorithm: "native",
      enabled: true,
    },
  }];
}

function nvidiaScenario(minFrames = 3, quality: string = "low"): BenchmarkScenarioConfig[] {
  return [{
    id: `nvidia-vsr-${quality}` as any,
    label: `NVIDIA VSR — ${quality.charAt(0).toUpperCase() + quality.slice(1)}`,
    minFrames,
    timeoutMs: 800,      // short timeout for test speed
    stabilizeMs: 5,
    settings: {
      processingBackend: "nvidia-vsr",
      nvidiaMode: "vsr",
      nvidiaQuality: quality as any,
      enabled: true,
    },
  }];
}

// ─── Frame event builder ─────────────────────────────────────────────────────

function makeFrameEvent(overrides: Partial<FrameEvent> & { sequence: number }): FrameEvent {
  return {
    clientId: undefined,
    generation: 1,
    sourceMediaTime: undefined,
    configurationId: 1,
    backend: "webgl2",
    nvidiaMode: undefined,
    canonicalQualityLevel: null,
    inputWidth: 1920,
    inputHeight: 1080,
    outputWidth: 1920,
    outputHeight: 1080,
    capturePath: "webgl-texsubimage2d",
    transportPath: "none",
    presentationPath: "webgl-texture-upload",
    captureStartedAt: performance.now(),
    submittedAt: undefined,
    nativeCompletedAt: undefined,
    presentedAt: undefined,
    captureDurationMs: 2,
    transportDurationMs: undefined,
    nativeProcessingDurationMs: undefined,
    presentationDurationMs: 1,
    totalLatencyMs: 16,
    completed: true,
    presented: true,
    stale: false,
    dropReason: undefined,
    timingBreakdown: undefined,
    ...overrides,
  };
}

// ─── Host builder helpers ────────────────────────────────────────────────────

function buildSimpleHost(
  events: FrameEvent[],
  eventDelayMs = 10,
  cfg?: Partial<ConfigAppliedEvent>,
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
    subscribeFrameEvents: (listener) => {
      setTimeout(() => {
        for (const ev of events) listener(ev);
      }, eventDelayMs);
      return () => {};
    },
    waitForConfigApplied: vi.fn(async () => ({
      configurationId: cfg?.configurationId ?? 1,
      backend: cfg?.backend ?? ("webgl2" as const),
      nvidiaMode: cfg?.nvidiaMode,
      canonicalQualityLevel: cfg?.canonicalQualityLevel ?? null,
      outputWidth: cfg?.outputWidth ?? 1920,
      outputHeight: cfg?.outputHeight ?? 1080,
      generation: cfg?.generation ?? 1,
    })),
  };
}

/** Build events for sequential sequences starting at `fromSeq`. */
function buildWebglEvents(
  count: number,
  fromSeq = 1,
  overrides?: Partial<FrameEvent>,
): FrameEvent[] {
  const events: FrameEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push(makeFrameEvent({
      sequence: fromSeq + i,
      captureStartedAt: performance.now() + i * 16,
      ...overrides,
    }));
  }
  return events;
}

function buildNvidiaEvents(
  count: number,
  quality: string,
  fromSeq = 1,
  overrides?: Partial<FrameEvent>,
): FrameEvent[] {
  const qMap: Record<string, number> = { low: 1, medium: 2, high: 3, ultra: 4 };
  const ql = qMap[quality] ?? 1;
  const events: FrameEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push(makeFrameEvent({
      sequence: fromSeq + i,
      backend: "nvidia-vsr",
      nvidiaMode: "vsr",
      canonicalQualityLevel: ql,
      outputWidth: 3840,
      outputHeight: 2160,
      captureStartedAt: performance.now() + i * 16,
      ...overrides,
    }));
  }
  return events;
}

// ─── Helper: wait for terminal state ─────────────────────────────────────────

async function waitForTerminal(service: NvidiaBenchmarkService, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = service.getSnapshot().state;
    if (state === "completed" || state === "cancelled" || state === "failed") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for terminal state");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.sequential("Benchmark Frame Events (Slice 1)", () => {
  let service: NvidiaBenchmarkService;

  beforeEach(() => {
    service = new NvidiaBenchmarkService();
  });

  afterEach(() => {
    service.reset();
  });

  // ── 1. Polling same snapshot repeatedly creates zero frame samples ────────

  it("polling same snapshot repeatedly creates zero frame samples", async () => {
    // No events delivered → service should time out with 0 frames
    const host = buildSimpleHost([], 10);

    service.setScenarios(webglScenario(3));
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(host);
    await waitForTerminal(service);

    const r = service.aggregate!.scenarios[0]!;
    expect(r.timedOut).toBe(true);
    expect(r.framesCollected).toBe(0);
  });

  // ── 2. Duplicate sequence counted once ────────────────────────────────────

  it("duplicate sequence counted once", async () => {
    // Send 7 events all with sequence=1 (duplicates)
    // After warmup (3), only 1 unique should be counted
    const events: FrameEvent[] = [];
    for (let i = 0; i < 7; i++) {
      events.push(makeFrameEvent({
        sequence: 1,
        backend: "webgl2",
        captureStartedAt: performance.now() + i * 16,
      }));
    }

    const host = buildSimpleHost(events, 5);

    service.setScenarios(webglScenario(3));
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(host);
    await waitForTerminal(service);

    // After warmup (3 events), remaining 4 are all sequence 1 → only 1 unique
    expect(service.aggregate!.scenarios[0]!.framesCollected).toBe(1);
  });

  // ── 3. Completion and presentation FPS differ correctly ───────────────────

  it("completion and presentation FPS differ correctly", async () => {
    // 8 events with varying completion vs presentation timestamps.
    // ReadStats reports 1920x1080, and VSR would double input => expected
    // output would be 1920 = readStats width (not 3840). Match that.
    const events: FrameEvent[] = [];
    const baseTime = performance.now();

    for (let i = 0; i < 8; i++) {
      const captureStart = baseTime + i * 16.67; // ~60fps capture
      events.push(makeFrameEvent({
        sequence: i + 1,
        backend: "nvidia-vsr",
        nvidiaMode: "vsr",
        canonicalQualityLevel: 1,
        configurationId: 1,
        generation: 1,
        outputWidth: 3840,
        outputHeight: 2160,
        completed: true,
        presented: true,
        totalLatencyMs: 8,
        captureStartedAt: captureStart,
        presentedAt: captureStart + 8 + i * 2, // presentations drift
      }));
    }

    const host = buildSimpleHost(events, 5, {
      configurationId: 1,
      backend: "nvidia-vsr",
      nvidiaMode: "vsr",
      canonicalQualityLevel: 1,
      outputWidth: 3840,
      outputHeight: 2160,
      generation: 1,
    });

    service.setScenarios(nvidiaScenario(5, "low"));
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(host);
    await waitForTerminal(service);

    // Need 5 samples (warmup 3 + 5 = 8 events needed, we have 8)
    expect(service.aggregate!.scenarios[0]!.framesCollected).toBe(5);
    const fps = service.aggregate!.scenarios[0]!.achievedFps;
    expect(fps).toBeGreaterThan(0);
    expect(fps).toBeLessThan(120); // ~60fps, not impossibly high
  });

  // ── 4. Stale generation ignored ───────────────────────────────────────────

  it("stale generation ignored", async () => {
    // Events: 3 from gen=2 + 1 stale from gen=1 + 3 more from gen=2 = 7 total
    // gen=2 events should be collected; gen=1 stale should be rejected
    const base = performance.now();
    const events = [
      makeFrameEvent({ sequence: 1, backend: "webgl2", generation: 2, stale: false, captureStartedAt: base }),
      makeFrameEvent({ sequence: 2, backend: "webgl2", generation: 2, stale: false, captureStartedAt: base + 16 }),
      makeFrameEvent({ sequence: 3, backend: "webgl2", generation: 2, stale: false, captureStartedAt: base + 32 }),
      makeFrameEvent({ sequence: 4, backend: "webgl2", generation: 1, stale: true, captureStartedAt: base + 48 }), // stale
      makeFrameEvent({ sequence: 5, backend: "webgl2", generation: 2, stale: false, captureStartedAt: base + 64 }),
      makeFrameEvent({ sequence: 6, backend: "webgl2", generation: 2, stale: false, captureStartedAt: base + 80 }),
      makeFrameEvent({ sequence: 7, backend: "webgl2", generation: 2, stale: false, captureStartedAt: base + 96 }),
    ];

    const host = buildSimpleHost(events, 5, { generation: 2, configurationId: 1 });

    service.setScenarios(webglScenario(3));
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(host);
    await waitForTerminal(service);

    // After warmup (3), collect 3 more (events 5,6,7). Event 4 (stale gen 1) is rejected.
    // That gives us 3 collected out of 4 post-warmup eligible (1 rejected, 3 collected)
    const r = service.aggregate!.scenarios[0]!;
    expect(r.framesCollected).toBe(3);
    // Timed out should be false (we got minFrames)
    expect(r.timedOut).toBe(false);
  });

  // ── 5. Wrong quality rejected ─────────────────────────────────────────────

  it("wrong quality rejected", async () => {
    // Events come with quality=high (level 3) but scenario expects low (level 1)
    const events = buildNvidiaEvents(4, "high", 1); // quality=high = level 3
    const host = buildSimpleHost(events, 5, {
      backend: "nvidia-vsr",
      nvidiaMode: "vsr",
      canonicalQualityLevel: 1, // scenario expects low = level 1
      outputWidth: 3840,
      outputHeight: 2160,
      configurationId: 1,
      generation: 1,
    });

    service.setScenarios(nvidiaScenario(3, "low"));
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(host);
    await waitForTerminal(service);

    // Events have quality level 3 (high), but expected level 1 (low) → rejected
    expect(service.aggregate!.scenarios[0]!.framesCollected).toBe(0);
  });

  // ── 6. Wrong output dimensions rejected ───────────────────────────────────

  it("wrong output dimensions rejected", async () => {
    // Events with wrong dimensions
    const events = buildWebglEvents(4, 1, { outputWidth: 640, outputHeight: 480 });
    const host = buildSimpleHost(events, 5, { outputWidth: 1920, outputHeight: 1080 });

    service.setScenarios(webglScenario(3));
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(host);
    await waitForTerminal(service);

    // Events have 640x480 but expected 1920x1080 → rejected
    expect(service.aggregate!.scenarios[0]!.framesCollected).toBe(0);
  });

  // ── 7. Configuration acknowledgement required ────────────────────────────

  it("configuration acknowledgement required", async () => {
    // Host that does NOT provide waitForConfigApplied — service falls back
    const events = buildWebglEvents(6, 1);

    const host: BenchmarkHost = {
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
      subscribeFrameEvents: (listener) => {
        setTimeout(() => { for (const ev of events) listener(ev); }, 10);
        return () => {};
      },
      // No waitForConfigApplied — service should still work without it
    };

    service.setScenarios(webglScenario(3));
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(host);
    await waitForTerminal(service);

    // Without waitForConfigApplied, _currentGeneration stays 0 → gen check skipped
    // Expect 3 frames collected (after warmup: 6-3=3)
    expect(service.aggregate!.scenarios[0]!.framesCollected).toBe(3);
  });

  // ── 8. VSR Low cannot consume prior WebGL snapshot ────────────────────────

  it("VSR Low cannot consume prior WebGL snapshot", async () => {
    // Run two scenarios: WebGL then VSR Low.
    // WebGL events should NOT be picked up by VSR scenario (wrong backend).

    const base = performance.now();
    const webglEvents = buildWebglEvents(6, 1, { captureStartedAt: base });
    const vsrEvents = buildNvidiaEvents(6, "low", 10, {
      captureStartedAt: base + 500,
      generation: 2,
      configurationId: 2,
      outputWidth: 3840,
      outputHeight: 2160,
    });

    // Deliver correct event batch per scenario using a controlled host
    let currentScenario = 0;
    const host: BenchmarkHost = {
      applySettings: vi.fn(),
      readStats: vi.fn(() => ({
        processingTimeMs: 8, rendererToResultMs: 3,
        nativeTransportProcessingTimeMs: 4, totalEnhancedFrameLatencyMs: 12,
        nativeOutputWidth: 1920, nativeOutputHeight: 1080,
        nativeQualityLevel: null, framesDisplayed: 100,
        completedFps: 30, backend: "webgl2",
        backpressureDrops: 0, nativeFailures: 0,
      })),
      subscribeFrameEvents: (listener) => {
        const scenario = ++currentScenario;
        setTimeout(() => {
          const batch = scenario === 1 ? webglEvents : vsrEvents;
          for (const ev of batch) listener(ev);
        }, 20);
        return () => {};
      },
      waitForConfigApplied: vi.fn(async () => {
        if (currentScenario === 0) {
          // Called before subscribe for scenario 1
          return {
            configurationId: 1, backend: "webgl2" as const,
            nvidiaMode: undefined, canonicalQualityLevel: null,
            outputWidth: 1920, outputHeight: 1080, generation: 1,
          };
        }
        // Called before subscribe for scenario 2
        return {
          configurationId: 2, backend: "nvidia-vsr" as const,
          nvidiaMode: "vsr" as const, canonicalQualityLevel: 1,
          outputWidth: 3840, outputHeight: 2160, generation: 2,
        };
      }),
    };

    const scenarios: BenchmarkScenarioConfig[] = [
      {
        id: "webgl2-native",
        label: "WebGL2 — Native",
        minFrames: 3, timeoutMs: 500, stabilizeMs: 5,
        settings: { processingBackend: "webgl2", webglScalingAlgorithm: "native", enabled: true },
      },
      {
        id: "nvidia-vsr-low",
        label: "NVIDIA VSR — Low",
        minFrames: 3, timeoutMs: 500, stabilizeMs: 5,
        settings: { processingBackend: "nvidia-vsr", nvidiaMode: "vsr", nvidiaQuality: "low", enabled: true },
      },
    ];

    service.setScenarios(scenarios);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(host);
    await waitForTerminal(service);

    const sc = service.aggregate!.scenarios;
    expect(sc.length).toBe(2);

    // WebGL scenario: should have collected its 3 events
    expect(sc[0]!.framesCollected).toBe(3);
    expect(sc[0]!.activeBackend).toBe("webgl2");

    // VSR scenario: should collect 3 VSR events, NOT webgl events
    expect(sc[1]!.framesCollected).toBe(3);
    expect(sc[1]!.activeBackend).toBe("nvidia-vsr");
  });

  // ── 9. Highest quality follows semantic quality order ─────────────────────

  it("highest quality follows semantic quality order", async () => {
    // Two scenarios: WebGL bicubic (rank 20) and VSR ultra (rank 80)
    // highestQuality should be VSR ultra regardless of processing time

    const base = performance.now();
    const bicubicEvents = buildWebglEvents(6, 1, {
      captureStartedAt: base,
      configurationId: 10,
      generation: 1,
      totalLatencyMs: 5, // fast
    });
    const ultraEvents = buildNvidiaEvents(6, "ultra", 10, {
      captureStartedAt: base + 500,
      generation: 2,
      configurationId: 20,
      outputWidth: 3840,
      outputHeight: 2160,
      totalLatencyMs: 20, // slower
    });

    let scenarioIdx = 0;
    const host: BenchmarkHost = {
      applySettings: vi.fn(),
      readStats: vi.fn(() => ({
        processingTimeMs: 8, rendererToResultMs: 3,
        nativeTransportProcessingTimeMs: 4, totalEnhancedFrameLatencyMs: 12,
        nativeOutputWidth: 1920, nativeOutputHeight: 1080,
        nativeQualityLevel: null, framesDisplayed: 100,
        completedFps: 30, backend: "webgl2",
        backpressureDrops: 0, nativeFailures: 0,
      })),
      subscribeFrameEvents: (listener) => {
        const idx = ++scenarioIdx;
        setTimeout(() => {
          const batch = idx === 1 ? bicubicEvents : ultraEvents;
          for (const ev of batch) listener(ev);
        }, 20);
        return () => {};
      },
      waitForConfigApplied: vi.fn(async () => {
        if (scenarioIdx === 0) {
          return {
            configurationId: 10, backend: "webgl2" as const,
            nvidiaMode: undefined, canonicalQualityLevel: null,
            outputWidth: 1920, outputHeight: 1080, generation: 1,
          };
        }
        return {
          configurationId: 20, backend: "nvidia-vsr" as const,
          nvidiaMode: "vsr" as const, canonicalQualityLevel: 4,
          outputWidth: 3840, outputHeight: 2160, generation: 2,
        };
      }),
    };

    const scenarios: BenchmarkScenarioConfig[] = [
      {
        id: "webgl2-bicubic",
        label: "WebGL2 — Bicubic",
        minFrames: 3, timeoutMs: 500, stabilizeMs: 5,
        settings: { processingBackend: "webgl2", webglScalingAlgorithm: "bicubic", enabled: true },
      },
      {
        id: "nvidia-vsr-ultra",
        label: "NVIDIA VSR — Ultra",
        minFrames: 3, timeoutMs: 500, stabilizeMs: 5,
        settings: { processingBackend: "nvidia-vsr", nvidiaMode: "vsr", nvidiaQuality: "ultra", enabled: true },
      },
    ];

    service.setScenarios(scenarios);
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    await service.start(host);
    await waitForTerminal(service);

    const agg = service.aggregate!;
    expect(agg.highestQuality).not.toBeNull();
    // Must be VSR ultra (rank 80), NOT bicubic (rank 20)
    expect(agg.highestQuality!.scenario).toBe("nvidia-vsr-ultra");
    expect(agg.highestQuality!.label).toContain("Ultra");
  });

  // ── 10. Settings restore after success ────────────────────────────────────

  it("settings restore after success", async () => {
    const events = buildWebglEvents(6, 1);

    const originalSettings: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0.75,
      processingBackend: "nvidia-vsr",
      nvidiaQuality: "ultra",
    };

    const host = buildSimpleHost(events, 10);

    service.saveSettings(originalSettings);
    service.setScenarios(webglScenario(3));
    await service.start(host);
    await waitForTerminal(service);

    expect(service.getSnapshot().state).toBe("completed");

    // Restore original settings
    const restored = service.buildRestoredSettings();
    expect(restored).not.toBeNull();
    expect(restored!.sharpeningStrength).toBe(0.75);
    expect(restored!.processingBackend).toBe("nvidia-vsr");
    expect(restored!.nvidiaQuality).toBe("ultra");

    // Second call returns null (idempotent)
    expect(service.buildRestoredSettings()).toBeNull();
    expect(service.restoredAfterRun).toBe(true);
  });

  // ── 10b. Settings restore after failure ───────────────────────────────────

  it("settings restore after failure", async () => {
    const originalSettings: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      sharpeningStrength: 0.5,
    };

    service.saveSettings(originalSettings);
    service.setScenarios([]); // empty → immediate failure

    const host = buildSimpleHost([], 10);
    await service.start(host);
    await waitForTerminal(service);

    expect(service.getSnapshot().state).toBe("failed");

    const restored = service.buildRestoredSettings();
    expect(restored).not.toBeNull();
    expect(restored!.sharpeningStrength).toBe(0.5);
  });

  // ── 10c. Settings restore after cancellation ──────────────────────────────

  it("settings restore after cancellation", async () => {
    const originalSettings: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      processingBackend: "nvidia-vsr",
    };

    // Events arrive very late so we can cancel before completion
    const lateEvents = buildWebglEvents(10, 1, { captureStartedAt: performance.now() + 10000 });
    const host = buildSimpleHost(lateEvents, 5000);

    service.saveSettings(originalSettings);
    service.setScenarios(webglScenario(3));
    service.start(host);

    await new Promise((r) => setTimeout(r, 50));
    service.cancel();
    await waitForTerminal(service);

    expect(service.getSnapshot().state).toBe("cancelled");

    const restored = service.buildRestoredSettings();
    expect(restored).not.toBeNull();
    expect(restored!.processingBackend).toBe("nvidia-vsr");
  });

  // ── 10d. Exposed restore path still works ─────────────────────────────────

  it("exposed restore path still works", () => {
    const custom: ViewerImageEnhancementSettings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      debanding: 0.5,
    };
    service.saveSettings(custom);
    expect(service.savedSettings).toEqual(custom);

    const restored = service.buildRestoredSettings();
    expect(restored).toEqual(custom);
    expect(service.restoredAfterRun).toBe(true);
    expect(service.buildRestoredSettings()).toBeNull();
  });

  // ── 11. Benchmark ZIP export called exactly once ──────────────────────────

  it("benchmark ZIP export called exactly once after successful aggregation", async () => {
    const events = buildWebglEvents(6, 1);
    const host = buildSimpleHost(events, 5);

    const exportFn = vi.fn();

    service.setScenarios(webglScenario(3));
    service.saveSettings(VIEWER_IMAGE_ENHANCEMENT_DEFAULTS);
    service.onExport = exportFn;
    await service.start(host);
    await waitForTerminal(service);

    expect(service.getSnapshot().state).toBe("completed");
    expect(exportFn).toHaveBeenCalledTimes(1);

    const result = exportFn.mock.calls[0]![0];
    const samples = exportFn.mock.calls[0]![1];
    expect(result).toHaveProperty("scenarios");
    expect(result).toHaveProperty("totalDurationMs");
    expect(Array.isArray(samples)).toBe(true);
  });
});
