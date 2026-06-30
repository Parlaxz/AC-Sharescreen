// SPDX-License-Identifier: MIT
/**
 * nvidia-benchmark-service.ts
 *
 * Deterministic state machine for orchestrating a full image-enhancement
 * benchmark across backends (WebGL2 variants + NVIDIA VSR quality levels).
 *
 * Architecture
 * ────────────
 * Singleton + external store pattern (matching nvidia-capability-store):
 *   - getSnapshot() / subscribe() for React via useSyncExternalStore
 *   - start() runs scenarios asynchronously via callbacks
 *   - cancel() sets AbortController to halt mid-run
 *
 * The service does NOT own the processor.  The component passes
 * callbacks for settings changes and stats observation.  The service
 * is a pure orchestrator — it drives scenarios and collects results,
 * then restores the original settings on completion / cancel / fail.
 *
 * State machine (deterministic, no skipped transitions):
 *   idle → validating → stabilizing → collecting-environment →
 *   running-scenarios → aggregating → exporting → completed
 *   Any state → cancelled | failed
 */

import { canonicalQualityLevel } from "@screenlink/shared";
import type { ViewerImageEnhancementSettings, ProcessingBackend, NvidiaQuality } from "./viewer-image-settings";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "./viewer-image-defaults";
import type { FrameEvent, FrameEventListener, ConfigAppliedEvent } from "./frame-events";

// ─── State machine ───────────────────────────────────────────────────────────

export type BenchmarkState =
  | "idle"
  | "validating"
  | "stabilizing"
  | "collecting-environment"
  | "running-scenarios"
  | "aggregating"
  | "exporting"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Valid transitions.  Each entry lists the states the key state can
 * transition TO.  Used for runtime assertion in development builds.
 */
const VALID_TRANSITIONS: Record<BenchmarkState, readonly BenchmarkState[]> = {
  idle:                    ["validating"],
  validating:              ["stabilizing", "cancelled", "failed"],
  stabilizing:             ["collecting-environment", "cancelled", "failed"],
  "collecting-environment": ["running-scenarios", "cancelled", "failed"],
  "running-scenarios":     ["aggregating", "cancelled", "failed"],
  aggregating:             ["exporting", "cancelled", "failed"],
  exporting:               ["completed", "cancelled", "failed"],
  completed:               ["idle"],
  cancelled:               ["idle"],
  failed:                  ["idle"],
};

// ─── Scenario definitions ────────────────────────────────────────────────────

export type BenchmarkScenarioId =
  | "webgl2-native"
  | "webgl2-bicubic"
  | "webgl2-lanczos"
  | "webgl2-fsr1-easu"
  | "nvidia-vsr-low"
  | "nvidia-vsr-medium"
  | "nvidia-vsr-high"
  | "nvidia-vsr-ultra";

export interface BenchmarkScenarioConfig {
  id: BenchmarkScenarioId;
  label: string;
  /** Minimum number of frames to collect for a statistically valid sample. */
  minFrames: number;
  /** Maximum time (ms) to wait for the minimum frame count. */
  timeoutMs: number;
  /** How long (ms) to wait after applying settings before collecting. */
  stabilizeMs: number;
  /** Settings to apply for this scenario.  Omitted keys keep current value. */
  settings: Partial<ViewerImageEnhancementSettings>;
}

const DEFAULT_SCENARIOS: BenchmarkScenarioConfig[] = [
  {
    id: "webgl2-native",
    label: "WebGL2 — Native",
    minFrames: 60,
    timeoutMs: 15_000,
    stabilizeMs: 1000,
    settings: {
      processingBackend: "webgl2",
      webglScalingAlgorithm: "native",
      enabled: true,
    },
  },
  {
    id: "webgl2-bicubic",
    label: "WebGL2 — Bicubic",
    minFrames: 60,
    timeoutMs: 15_000,
    stabilizeMs: 1000,
    settings: {
      processingBackend: "webgl2",
      webglScalingAlgorithm: "bicubic",
      enabled: true,
    },
  },
  {
    id: "webgl2-lanczos",
    label: "WebGL2 — Lanczos 3",
    minFrames: 60,
    timeoutMs: 15_000,
    stabilizeMs: 1000,
    settings: {
      processingBackend: "webgl2",
      webglScalingAlgorithm: "lanczos",
      enabled: true,
    },
  },
  {
    id: "webgl2-fsr1-easu",
    label: "WebGL2 — FSR 1 EASU",
    minFrames: 60,
    timeoutMs: 15_000,
    stabilizeMs: 1000,
    settings: {
      processingBackend: "webgl2",
      webglScalingAlgorithm: "fsr1-easu",
      enabled: true,
    },
  },
  {
    id: "nvidia-vsr-low",
    label: "NVIDIA VSR — Low",
    minFrames: 60,
    timeoutMs: 20_000,
    stabilizeMs: 2000,
    settings: {
      processingBackend: "nvidia-vsr",
      nvidiaMode: "vsr",
      nvidiaQuality: "low",
      enabled: true,
    },
  },
  {
    id: "nvidia-vsr-medium",
    label: "NVIDIA VSR — Medium",
    minFrames: 60,
    timeoutMs: 20_000,
    stabilizeMs: 2000,
    settings: {
      processingBackend: "nvidia-vsr",
      nvidiaMode: "vsr",
      nvidiaQuality: "medium",
      enabled: true,
    },
  },
  {
    id: "nvidia-vsr-high",
    label: "NVIDIA VSR — High",
    minFrames: 60,
    timeoutMs: 25_000,
    stabilizeMs: 2000,
    settings: {
      processingBackend: "nvidia-vsr",
      nvidiaMode: "vsr",
      nvidiaQuality: "high",
      enabled: true,
    },
  },
  {
    id: "nvidia-vsr-ultra",
    label: "NVIDIA VSR — Ultra",
    minFrames: 60,
    timeoutMs: 30_000,
    stabilizeMs: 3000,
    settings: {
      processingBackend: "nvidia-vsr",
      nvidiaMode: "vsr",
      nvidiaQuality: "ultra",
      enabled: true,
    },
  },
];

/**
 * Semantic quality ordering — highest quality first.
 * Used for the highestQuality aggregate label and scenario ranking.
 * The order reflects actual visual quality, NOT processing time.
 */
export const BENCHMARK_QUALITY_RANKING: Record<BenchmarkScenarioId, number> = {
  "nvidia-vsr-ultra": 80,
  "nvidia-vsr-high": 70,
  "nvidia-vsr-medium": 60,
  "nvidia-vsr-low": 50,
  "webgl2-fsr1-easu": 40,
  "webgl2-lanczos": 30,
  "webgl2-bicubic": 20,
  "webgl2-native": 10,
};

function compareQuality(a: BenchmarkScenarioId, b: BenchmarkScenarioId): number {
  return (BENCHMARK_QUALITY_RANKING[b] ?? 0) - (BENCHMARK_QUALITY_RANKING[a] ?? 0);
}

// ─── Result types ────────────────────────────────────────────────────────────

export interface PerFrameSample {
  processingTimeMs: number | null;
  rendererToResultMs: number | null;
  nativeTransportProcessingTimeMs: number | null;
  totalLatencyMs: number | null;
  nativeOutputWidth: number;
  nativeOutputHeight: number;
  nativeQualityLevel: number | null;
  backpressureDrop: boolean;
  /** Raw frame event that produced this sample (for export). */
  rawFrameEvent?: FrameEvent;
}

export interface BenchmarkScenarioResult {
  scenario: BenchmarkScenarioId;
  label: string;
  framesRequested: number;
  framesCollected: number;
  framesDropped: number;
  /** Average total processing time per frame (ms); null if no samples. */
  avgProcessingTimeMs: number | null;
  /** Median (p50) processing time (ms). */
  p50ProcessingTimeMs: number | null;
  /** 95th percentile processing time (ms). */
  p95ProcessingTimeMs: number | null;
  /** Average end-to-end latency (ms). */
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /** Achieved frames-per-second during collection window. */
  achievedFps: number | null;
  /** Native output width (or 0 if unavailable). */
  nativeOutputWidth: number;
  nativeOutputHeight: number;
  /** Quality level reported by native backend (null for WebGL). */
  nativeQualityLevel: number | null;
  /** The backend that was active for this scenario. */
  activeBackend: string;
  /** Whether the scenario timed out (partial data). */
  timedOut: boolean;
}

/**
 * Environment info snapshot collected at benchmark start.
 * Populated during the collecting-environment phase from the
 * host's readStats() and optional getEnvironment().
 */
export interface BenchmarkEnvironmentInfo {
  /** Active processing backend at collection time. */
  processingBackend: string;
  /** Native output width (from processor stats). */
  nativeOutputWidth: number;
  /** Native output height (from processor stats). */
  nativeOutputHeight: number;
  /** Native quality level (null for WebGL backends). */
  nativeQualityLevel: number | null;
  /** Achieved FPS at collection time. */
  completedFps: number | null;
  /** Whether NVIDIA RTX Video was reported as available. */
  nvidiaAvailable: boolean;
  /** NVIDIA adapter name (null if not NVIDIA or unknown). */
  nvidiaAdapterName: string | null;
  /** NVIDIA driver version (null if not NVIDIA or unknown). */
  nvidiaDriverVersion: string | null;
}

export interface NativeBenchmarkRunSummary {
  qualityLevel: "low" | "medium" | "high" | "ultra";
  success: boolean;
  framesProcessed: number;
  framesDropped: number;
  framesFailed: number;
  avgTimeUs: number;
  avgFps: number;
  avgInputReceiveUs: number;
  avgUploadUs: number;
  avgEffectUs: number;
  avgDownloadUs: number;
  avgOutputWriteUs: number;
  error?: string;
}

export interface BenchmarkAggregateResult {
  scenarios: BenchmarkScenarioResult[];
  /** Total wall-clock duration of the benchmark run (ms). */
  totalDurationMs: number;
  /** ISO timestamp when the benchmark completed. */
  completedAt: string;
  /** Scenario with the lowest average latency. */
  bestLatency: { scenario: BenchmarkScenarioId; label: string; avgMs: number } | null;
  /** Scenario with the highest semantic quality rank. */
  highestQuality: { scenario: BenchmarkScenarioId; label: string; avgMs: number } | null;
  /** Native-only benchmark summaries collected before live scenarios. */
  nativeBenchmarks: NativeBenchmarkRunSummary[];
  /**
   * Environment info collected at benchmark start.
   * Populated during the collecting-environment phase.
   */
  environment: BenchmarkEnvironmentInfo | null;

  /**
   * Recommended settings that balance quality and performance.
   * Null if no scenarios completed successfully.
   */
  recommendedSettings: Partial<ViewerImageEnhancementSettings> | null;
}

// ─── Progress ────────────────────────────────────────────────────────────────

export interface BenchmarkProgress {
  /** The current state machine state. */
  state: BenchmarkState;
  /** Overall progress 0–100. */
  percent: number;
  /** Human-readable description of the current phase. */
  phaseLabel: string;
  /** Current scenario being collected (null in non-scenario phases). */
  currentScenario: BenchmarkScenarioId | null;
  /** Total number of scenarios configured. */
  totalScenarios: number;
  /** Number of scenarios completed thus far. */
  completedScenarios: number;
  /** Results from completed scenarios (empty during run, populated after). */
  results: BenchmarkScenarioResult[];
  /** Per-frame samples collected for the <em>current</em> scenario. */
  currentSamples: PerFrameSample[];
  /** Target frame count for the current scenario. */
  currentTargetFrames: number;
  /** Elapsed wall-clock ms for the current scenario. */
  currentElapsedMs: number;
  /** Non-null when state === "failed". */
  error: string | null;
}

function initialProgress(): BenchmarkProgress {
  return {
    state: "idle",
    percent: 0,
    phaseLabel: "",
    currentScenario: null,
    totalScenarios: 0,
    completedScenarios: 0,
    results: [],
    currentSamples: [],
    currentTargetFrames: 0,
    currentElapsedMs: 0,
    error: null,
  };
}

// ─── Callback interface (provided by the component) ─────────────────────────

export interface BenchmarkHost {
  /** Apply enhancement settings and return immediately (fire-and-forget). */
  applySettings: (settings: ViewerImageEnhancementSettings) => void;

  /** Return the latest stats snapshot from the processor (or null). */
  readStats: () => {
    processingTimeMs: number | null;
    rendererToResultMs: number | null;
    nativeTransportProcessingTimeMs: number | null;
    totalEnhancedFrameLatencyMs: number | null;
    nativeOutputWidth: number;
    nativeOutputHeight: number;
    nativeQualityLevel: number | null;
    framesDisplayed: number;
    completedFps: number | null;
    backend: string;
    backpressureDrops: number;
    nativeFailures: number;
  } | null;

  /**
   * Subscribe to per-frame lifecycle events for event-driven sample
   * collection (replaces polling-based readStats).
   * Returns an unsubscribe function.
   */
  subscribeFrameEvents?: (listener: FrameEventListener) => () => void;

  /**
   * Wait for the current configuration to be acknowledged by the backend.
   * Resolves with the applied config info, or null on timeout/failure.
   * Default timeout is 5000ms.
   */
  waitForConfigApplied?: (
    timeoutMs?: number,
  ) => Promise<ConfigAppliedEvent | null>;

  /**
   * Optional environment info gatherer.  Called during the
   * collecting-environment phase to gather NVIDIA capability and
   * adapter information.  Return null to skip environment enrichment.
   */
  getEnvironment?: () => Partial<BenchmarkEnvironmentInfo> | null;

  runNativeBenchmark?: (config: {
    processingMode: "vsr" | "high-bitrate" | "denoise" | "deblur";
    qualityLevel: "low" | "medium" | "high" | "ultra";
    inputWidth: number;
    inputHeight: number;
    targetFrames: number;
    frameTimeoutMs?: number;
  }) => Promise<{ success: boolean; error?: string; targetFrames?: number }>;
  getNativeBenchmarkStatus?: () => Promise<{
    benchmarkActive: boolean;
    benchmarkTargetFrames: number;
    benchmarkFramesCompleted: number;
    benchmarkTotalTimeUs: number;
    benchmarkAvgTimeUs?: number;
    benchmarkComplete?: boolean;
  } | null>;
  cancelNativeBenchmark?: () => Promise<boolean>;
  getNativeBenchmarkAggregateResults?: () => Promise<{
    success: boolean;
    error?: string;
    framesProcessed: number;
    framesDropped: number;
    framesFailed: number;
    totalTimeUs: number;
    avgTimeUs: number;
    minTimeUs: number;
    maxTimeUs: number;
    avgInputReceiveUs: number;
    avgUploadUs: number;
    avgEffectUs: number;
    avgDownloadUs: number;
    avgOutputWriteUs: number;
    avgFps: number;
  } | null>;
}

// ─── State assertion helper ─────────────────────────────────────────────────

function assertTransition(from: BenchmarkState, to: BenchmarkState): void {
  if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      console.warn(
        `[Benchmark] Invalid state transition: ${from} → ${to}. ` +
        `Allowed: ${allowed.join(", ")}`,
      );
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

function average(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function now(): number {
  return performance.now();
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class NvidiaBenchmarkService {
  // ── State ──────────────────────────────────────────────────────────────
  private _state: BenchmarkState = "idle";
  private _progress: BenchmarkProgress = initialProgress();
  private _aggregate: BenchmarkAggregateResult | null = null;
  private _abort = new AbortController();
  private _host: BenchmarkHost | null = null;
  private _scenarios: BenchmarkScenarioConfig[] = DEFAULT_SCENARIOS;
  private _savedSettings: ViewerImageEnhancementSettings | null = null;
  private _restoredAfterRun = false;

  // Event-driven collection state
  private _currentGeneration = 0;
  private _currentConfigurationId = 0;
  private _scenarioFrameBuffer: FrameEvent[] = [];
  private _seenScenarioKeys = new Set<string>();
  private _warmupCount = 0;
  private _warmedUp = false;
  private _unsubscribeFrameEvents: (() => void) | null = null;

  /** Optional export callback — called exactly once after successful aggregation. */
  onExport: ((result: BenchmarkAggregateResult, samples: BenchmarkScenarioResult[]) => void | Promise<void>) | null = null;

  private async runNativeBenchmarkSeries(
    host: BenchmarkHost,
    signal: AbortSignal,
    inputWidth: number,
    inputHeight: number,
  ): Promise<NativeBenchmarkRunSummary[]> {
    if (!host.runNativeBenchmark || !host.getNativeBenchmarkStatus || !host.getNativeBenchmarkAggregateResults) {
      return [];
    }

    const summaries: NativeBenchmarkRunSummary[] = [];
    const qualities: NativeBenchmarkRunSummary["qualityLevel"][] = ["low", "medium", "high", "ultra"];

    for (const qualityLevel of qualities) {
      if (signal.aborted) break;

      const started = await host.runNativeBenchmark({
        processingMode: "vsr",
        qualityLevel,
        inputWidth,
        inputHeight,
        targetFrames: 300,
        frameTimeoutMs: 5000,
      });

      if (!started.success) {
        summaries.push({
          qualityLevel,
          success: false,
          framesProcessed: 0,
          framesDropped: 0,
          framesFailed: 0,
          avgTimeUs: 0,
          avgFps: 0,
          avgInputReceiveUs: 0,
          avgUploadUs: 0,
          avgEffectUs: 0,
          avgDownloadUs: 0,
          avgOutputWriteUs: 0,
          error: started.error,
        });
        continue;
      }

      while (!signal.aborted) {
        const status = await host.getNativeBenchmarkStatus();
        if (!status) break;
        if (!status.benchmarkActive && status.benchmarkComplete) {
          break;
        }
        await this.delay(50, signal);
      }

      if (signal.aborted) {
        await host.cancelNativeBenchmark?.().catch(() => false);
        break;
      }

      const aggregate = await host.getNativeBenchmarkAggregateResults();
      if (!aggregate) {
        summaries.push({
          qualityLevel,
          success: false,
          framesProcessed: 0,
          framesDropped: 0,
          framesFailed: 0,
          avgTimeUs: 0,
          avgFps: 0,
          avgInputReceiveUs: 0,
          avgUploadUs: 0,
          avgEffectUs: 0,
          avgDownloadUs: 0,
          avgOutputWriteUs: 0,
          error: "no-native-benchmark-result",
        });
        continue;
      }

      summaries.push({
        qualityLevel,
        success: aggregate.success,
        framesProcessed: aggregate.framesProcessed,
        framesDropped: aggregate.framesDropped,
        framesFailed: aggregate.framesFailed,
        avgTimeUs: aggregate.avgTimeUs,
        avgFps: aggregate.avgFps,
        avgInputReceiveUs: aggregate.avgInputReceiveUs,
        avgUploadUs: aggregate.avgUploadUs,
        avgEffectUs: aggregate.avgEffectUs,
        avgDownloadUs: aggregate.avgDownloadUs,
        avgOutputWriteUs: aggregate.avgOutputWriteUs,
        error: aggregate.error,
      });
    }

    return summaries;
  }

  // ── External store plumbing ───────────────────────────────────────────
  private readonly _listeners = new Set<() => void>();
  private _notify(): void {
    for (const l of this._listeners) l();
  }

  getSnapshot(): BenchmarkProgress {
    return this._progress;
  }

  subscribe(callback: () => void): () => void {
    this._listeners.add(callback);
    return () => { this._listeners.delete(callback); };
  }

  /** Read-only aggregate (null while running). */
  get aggregate(): BenchmarkAggregateResult | null {
    return this._aggregate;
  }

  /** True when the state machine is in a transient (non-terminal) state. */
  get running(): boolean {
    const s = this._state;
    return s !== "idle" && s !== "completed" && s !== "cancelled" && s !== "failed";
  }

  /** Expose saved settings for UI restoration coordination. */
  get savedSettings(): ViewerImageEnhancementSettings | null {
    return this._savedSettings;
  }

  /** Whether settings have been restored since the last run completed/stopped. */
  get restoredAfterRun(): boolean {
    return this._restoredAfterRun;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Seed custom scenarios (e.g. from a config).  Call before start().
   * Passing null/undefined resets to the default scenario list.
   */
  setScenarios(scenarios?: BenchmarkScenarioConfig[] | null): void {
    this._scenarios = scenarios ?? DEFAULT_SCENARIOS;
  }

  /**
   * Kick off a full benchmark run.
   *
   * @param host  Callback interface for settings + stats.
   * @returns     A promise that resolves when the run reaches a terminal state.
   */
  async start(host: BenchmarkHost): Promise<void> {
    if (this.running) return;

    this._host = host;
    this._abort = new AbortController();
    this._aggregate = null;
    this._restoredAfterRun = false;

    try {
      await this.run(host, this._abort.signal);
    } catch (err) {
      if (this._abort.signal.aborted) {
        this.transitionTo("cancelled");
      } else {
        this.setError(
          err instanceof Error ? err.message : "Benchmark run failed unexpectedly",
        );
      }
    }
  }

  /**
   * Request cancellation.  The current scenario will finish its current
   * frame wait loop then exit.  Idempotent.
   */
  cancel(): void {
    if (!this.running) return;
    this.unsubscribeFromFrameEvents();
    this._abort.abort();
    this.transitionTo("cancelled");
  }

  /**
   * Reset to idle.  Clears results and restores saved settings if not
   * already done.
   */
  reset(): void {
    this._abort.abort();
    this._progress = initialProgress();
    this._aggregate = null;
    this._state = "idle";
    this._savedSettings = null;
    this._restoredAfterRun = false;
    this.onExport = null;
    this.unsubscribeFromFrameEvents();
    this._notify();
  }

  // ── State machine transitions ─────────────────────────────────────────

  private transitionTo(to: BenchmarkState): void {
    assertTransition(this._state, to);
    this._state = to;
    this._progress = { ...this._progress, state: to };
    this._notify();
  }

  private setProgress(partial: Partial<BenchmarkProgress>): void {
    this._progress = { ...this._progress, ...partial, state: this._state };
    this._notify();
  }

  private setError(message: string): void {
    this._progress = {
      ...this._progress,
      state: "failed",
      error: message,
      percent: Math.min(this._progress.percent, 99),
      phaseLabel: `Failed: ${message}`,
    };
    this._state = "failed";
    this._notify();
  }

  // ── Core run loop ─────────────────────────────────────────────────────

  private async run(host: BenchmarkHost, signal: AbortSignal): Promise<void> {
    const runStart = now();

    // ── Phase 1: Validating ────────────────────────────────────────────
    this.transitionTo("validating");
    this.setProgress({
      percent: 0,
      phaseLabel: "Validating benchmark configuration…",
    });

    if (this._scenarios.length === 0) {
      this.setError("No benchmark scenarios configured");
      return;
    }

    // Check that the host can subscribe to frame events
    if (typeof host.subscribeFrameEvents !== "function") {
      this.setError("Host does not support frame event subscription");
      return;
    }

    // Check that the host can provide stats (for UI progress)
    const initialStats = host.readStats();
    if (!initialStats) {
      this.setError("Processor not available — cannot run benchmark");
      return;
    }
    this.setProgress({ totalScenarios: this._scenarios.length });

    // ── Phase 2: Stabilizing ───────────────────────────────────────────
    this.transitionTo("stabilizing");
    this.setProgress({
      percent: 5,
      phaseLabel: "Stabilizing processing pipeline…",
      currentScenario: null,
    });

    // Wait a short while for the pipeline to settle
    await this.delay(500, signal);
    if (signal.aborted) return;

    // ── Phase 3: Collecting environment info ───────────────────────────
    this.transitionTo("collecting-environment");
    this.setProgress({
      percent: 10,
      phaseLabel: "Collecting environment information…",
      currentScenario: null,
    });

    // Gather environment info from host stats and optional getEnvironment
    const envStats = host.readStats();
    const envExtra = typeof host.getEnvironment === "function" ? host.getEnvironment() : null;
    const environment: BenchmarkEnvironmentInfo = {
      processingBackend: envStats?.backend ?? "unknown",
      nativeOutputWidth: envStats?.nativeOutputWidth ?? 0,
      nativeOutputHeight: envStats?.nativeOutputHeight ?? 0,
      nativeQualityLevel: envStats?.nativeQualityLevel ?? null,
      completedFps: envStats?.completedFps ?? null,
      nvidiaAvailable: envExtra?.nvidiaAvailable ?? false,
      nvidiaAdapterName: envExtra?.nvidiaAdapterName ?? null,
      nvidiaDriverVersion: envExtra?.nvidiaDriverVersion ?? null,
    };

    let nativeBenchmarks: NativeBenchmarkRunSummary[] = [];
    if (host.runNativeBenchmark && host.getNativeBenchmarkStatus && host.getNativeBenchmarkAggregateResults) {
      this.setProgress({
        percent: 12,
        phaseLabel: "Running native-only NVIDIA benchmark scenarios…",
        currentScenario: null,
      });
      const nativeInputWidth = environment.nativeOutputWidth > 0
        ? Math.max(1, Math.floor(environment.nativeOutputWidth / 2))
        : 1280;
      const nativeInputHeight = environment.nativeOutputHeight > 0
        ? Math.max(1, Math.floor(environment.nativeOutputHeight / 2))
        : 720;
      nativeBenchmarks = await this.runNativeBenchmarkSeries(
        host,
        signal,
        nativeInputWidth,
        nativeInputHeight,
      );
      if (signal.aborted) return;
    }

    await this.delay(200, signal);
    if (signal.aborted) return;

    // ── Phase 4: Running scenarios ─────────────────────────────────────
    this.transitionTo("running-scenarios");
    const scenarioResults: BenchmarkScenarioResult[] = [];
    const exportSamples: BenchmarkScenarioResult[] = [];

    for (let idx = 0; idx < this._scenarios.length; idx++) {
      if (signal.aborted) return;

      const config = this._scenarios[idx]!;
      const scenarioPercentBase = 10 + (idx / this._scenarios.length) * 80;

      this.setProgress({
        currentScenario: config.id,
        phaseLabel: `Running: ${config.label}`,
        currentSamples: [],
        currentTargetFrames: config.minFrames,
        currentElapsedMs: 0,
        percent: scenarioPercentBase,
      });

      // Apply scenario settings
      const merged = this.mergeScopedSettings(config.settings);
      host.applySettings(merged);

      // Wait for explicit configuration acknowledgement (if supported)
      let acknowledgedOutputWidth = 0;
      let acknowledgedOutputHeight = 0;
      if (typeof host.waitForConfigApplied === "function") {
        const ack = await host.waitForConfigApplied(5000);
        if (signal.aborted) return;
        if (ack) {
          this._currentGeneration = ack.generation;
          this._currentConfigurationId = ack.configurationId;
          acknowledgedOutputWidth = ack.outputWidth;
          acknowledgedOutputHeight = ack.outputHeight;
        }
        // If no ack received, still proceed (generation 0 means events will be rejected)
      }

      // Wait for stabilization
      await this.delay(config.stabilizeMs, signal);
      if (signal.aborted) return;

      // Show partial progress
      this.setProgress({ percent: scenarioPercentBase + 2 });

      // ── Event-driven sample collection ────────────────────────────────
      const scenarioStart = now();
      const samples: PerFrameSample[] = [];
      const completionTimestamps: number[] = [];
      const presentationTimestamps: number[] = [];
      let framesDropped = 0;
      let configMismatch = false;

      // Reset per-scenario event tracking state
      this._scenarioFrameBuffer = [];
      this._seenScenarioKeys = new Set<string>();
      this._warmupCount = 0;
      this._warmedUp = false;

      // Subscribe to frame events for this scenario
      this._unsubscribeFrameEvents = host.subscribeFrameEvents((event) => {
        this._scenarioFrameBuffer.push(event);
      });

      // Compute expected configuration attributes from the applied settings
      const expectedBackend = merged.processingBackend === "nvidia-vsr" ? "nvidia-vsr" : "webgl2";
      const expectedNvidiaMode = merged.nvidiaMode;
      const expectedQuality = merged.nvidiaQuality;
      const expectedCanonicalQuality = expectedBackend === "nvidia-vsr"
        ? canonicalQualityLevel(expectedNvidiaMode, expectedQuality as NvidiaQuality)
        : null;

      // Helper: check if an event matches the expected scenario config
      const isMatchingEvent = (ev: FrameEvent): boolean => {
        // Reject wrong backend
        if (ev.backend !== expectedBackend) return false;
        // Reject wrong NVIDIA mode (if applicable)
        if (expectedBackend === "nvidia-vsr" && expectedNvidiaMode && ev.nvidiaMode !== expectedNvidiaMode) return false;
        // Reject wrong canonical quality level (if known)
        if (expectedCanonicalQuality != null && ev.canonicalQualityLevel != null &&
            ev.canonicalQualityLevel !== expectedCanonicalQuality) return false;
        // Reject wrong output dimensions when the applied configuration acknowledged them.
        if (acknowledgedOutputWidth > 0 && ev.outputWidth > 0 && ev.outputWidth !== acknowledgedOutputWidth) return false;
        if (acknowledgedOutputHeight > 0 && ev.outputHeight > 0 && ev.outputHeight !== acknowledgedOutputHeight) return false;
        // Reject stale generations
        if (this._currentGeneration > 0 && ev.generation !== this._currentGeneration) return false;
        // Reject stale configuration IDs
        if (this._currentConfigurationId > 0 && ev.configurationId > 0 &&
            ev.configurationId !== this._currentConfigurationId) return false;
        return true;
      };

      // Collect loop: drain the event buffer and gather samples
      while (samples.length < config.minFrames && !signal.aborted) {
        const elapsed = now() - scenarioStart;

        // Update UI progress (keep polling for progress visibility)
        this.setProgress({
          currentSamples: samples,
          currentTargetFrames: config.minFrames,
          currentElapsedMs: elapsed,
          percent: Math.min(
            scenarioPercentBase + 2 + ((samples.length / config.minFrames) * 78),
            scenarioPercentBase + 80,
          ),
        });

        if (elapsed > config.timeoutMs) {
          // Mark config mismatch if no matching events received
          if (samples.length === 0 && configMismatch) {
            // already flagged
          }
          break;
        }

        // Drain all pending events from the buffer
        while (this._scenarioFrameBuffer.length > 0) {
          const event = this._scenarioFrameBuffer.shift()!;

          // Verify event matches expected configuration
          if (!isMatchingEvent(event)) {
            if (event.stale || event.configurationId !== this._currentConfigurationId) {
              // Mark config mismatch for the scenario result
              configMismatch = true;
            }
            continue;
          }

          // Warm-up: discard first few events to let the pipeline settle.
          // Do NOT add to seenKeys during warmup so the same sequence can
          // still be counted once after warmup completes.
          if (!this._warmedUp) {
            if (event.completed) {
              this._warmupCount++;
              if (this._warmupCount >= 3) {
                this._warmedUp = true;
              }
            }
            continue;
          }

          // After warmup: reject duplicates (same gen+seq already counted)
          const key = `${event.generation}:${event.sequence}`;
          if (this._seenScenarioKeys.has(key)) continue;
          this._seenScenarioKeys.add(key);

          // Collect completion events
          if (event.completed && event.totalLatencyMs != null) {
            const sample: PerFrameSample = {
              processingTimeMs: event.totalLatencyMs,
              rendererToResultMs: event.transportDurationMs ?? null,
              nativeTransportProcessingTimeMs: event.nativeProcessingDurationMs ?? null,
              totalLatencyMs: event.totalLatencyMs,
              nativeOutputWidth: event.outputWidth,
              nativeOutputHeight: event.outputHeight,
              nativeQualityLevel: event.canonicalQualityLevel,
              backpressureDrop: false,
              rawFrameEvent: event,
            };
            samples.push(sample);
            completionTimestamps.push(event.captureStartedAt);

            if (event.presented && event.presentedAt != null) {
              presentationTimestamps.push(event.presentedAt);
            }
          }

          // Track backpressure drops
          if (event.dropReason === "backpressure") {
            framesDropped++;
          }
        }

        // Throttled drain — don't busy-wait
        await this.delay(16, signal);
      }

      // Unsubscribe frame events for this scenario
      this.unsubscribeFromFrameEvents();

      // Handle config mismatch — clear samples and mark result
      if (configMismatch && samples.length === 0) {
        scenarioResults.push({
          scenario: config.id,
          label: config.label,
          framesRequested: config.minFrames,
          framesCollected: 0,
          framesDropped,
          avgProcessingTimeMs: null,
          p50ProcessingTimeMs: null,
          p95ProcessingTimeMs: null,
          avgLatencyMs: null,
          p50LatencyMs: null,
          p95LatencyMs: null,
          achievedFps: null,
          nativeOutputWidth: acknowledgedOutputWidth,
          nativeOutputHeight: acknowledgedOutputHeight,
          nativeQualityLevel: expectedCanonicalQuality,
          activeBackend: expectedBackend,
          timedOut: true,
        });
        // Still create placeholder result for progress tracking
        this.setProgress({
          completedScenarios: idx + 1,
          results: scenarioResults,
          currentScenario: null,
          phaseLabel: `Config mismatch: ${config.label}`,
          percent: scenarioPercentBase + 80,
        });
        continue;
      }

      // ── Compute per-scenario metrics from event timestamps ────────────
      const processingTimes = samples
        .map((s) => s.processingTimeMs)
        .filter((t): t is number => t !== null)
        .sort((a, b) => a - b);
      const latencies = samples
        .map((s) => s.totalLatencyMs)
        .filter((t): t is number => t !== null)
        .sort((a, b) => a - b);

      // Completed FPS from event timestamps
      let completedFps: number | null = null;
      if (completionTimestamps.length >= 2) {
        const windowStart = completionTimestamps[0]!;
        const windowEnd = completionTimestamps[completionTimestamps.length - 1]!;
        const windowDuration = windowEnd - windowStart;
        if (windowDuration > 0) {
          completedFps = Math.round((completionTimestamps.length / windowDuration) * 1000);
        }
      }

      // Presented FPS from presentation timestamps
      let presentedFps: number | null = null;
      if (presentationTimestamps.length >= 2) {
        const pStart = presentationTimestamps[0]!;
        const pEnd = presentationTimestamps[presentationTimestamps.length - 1]!;
        const pDuration = pEnd - pStart;
        if (pDuration > 0) {
          presentedFps = Math.round((presentationTimestamps.length / pDuration) * 1000);
        }
      }

      scenarioResults.push({
        scenario: config.id,
        label: config.label,
        framesRequested: config.minFrames,
        framesCollected: samples.length,
        framesDropped,
        avgProcessingTimeMs: processingTimes.length > 0 ? average(processingTimes) : null,
        p50ProcessingTimeMs: processingTimes.length > 0 ? percentile(processingTimes, 50) : null,
        p95ProcessingTimeMs: processingTimes.length > 0 ? percentile(processingTimes, 95) : null,
        avgLatencyMs: latencies.length > 0 ? average(latencies) : null,
        p50LatencyMs: latencies.length > 0 ? percentile(latencies, 50) : null,
        p95LatencyMs: latencies.length > 0 ? percentile(latencies, 95) : null,
        achievedFps: completedFps ?? presentedFps,
        nativeOutputWidth: samples.length > 0
          ? samples[samples.length - 1]!.nativeOutputWidth
          : acknowledgedOutputWidth,
        nativeOutputHeight: samples.length > 0
          ? samples[samples.length - 1]!.nativeOutputHeight
          : acknowledgedOutputHeight,
        nativeQualityLevel: samples.length > 0
          ? samples[samples.length - 1]!.nativeQualityLevel
          : expectedCanonicalQuality,
        activeBackend: expectedBackend,
        timedOut: samples.length < config.minFrames,
      });

      // Track samples for export
      exportSamples.push(scenarioResults[scenarioResults.length - 1]!);

      this.setProgress({
        completedScenarios: idx + 1,
        results: scenarioResults,
        currentScenario: null,
        phaseLabel: `Completed: ${config.label}`,
        percent: scenarioPercentBase + 80,
      });
    }

    if (signal.aborted) {
      this.unsubscribeFromFrameEvents();
      return;
    }

    // ── Phase 5: Aggregating ───────────────────────────────────────────
    this.transitionTo("aggregating");
    this.setProgress({
      percent: 95,
      phaseLabel: "Aggregating benchmark results…",
      currentScenario: null,
    });

    const completed = scenarioResults.filter((r) => !r.timedOut && r.framesCollected > 0);
    let bestLatency: { scenario: BenchmarkScenarioId; label: string; avgMs: number } | null = null;
    let highestQuality: { scenario: BenchmarkScenarioId; label: string; avgMs: number } | null = null;

    if (completed.length > 0) {
      // Best latency = lowest avg processing time among non-zero results
      const sortedByLatency = [...completed]
        .filter((r) => r.avgProcessingTimeMs != null && r.avgProcessingTimeMs > 0)
        .sort((a, b) => (a.avgProcessingTimeMs ?? Infinity) - (b.avgProcessingTimeMs ?? Infinity));
      if (sortedByLatency.length > 0) {
        bestLatency = {
          scenario: sortedByLatency[0]!.scenario,
          label: sortedByLatency[0]!.label,
          avgMs: sortedByLatency[0]!.avgProcessingTimeMs!,
        };
      }

      // Highest quality = semantic quality order (not processing time)
      const sortedByQuality = [...completed]
        .filter((r) => r.framesCollected > 0)
        .sort((a, b) => compareQuality(a.scenario, b.scenario));
      if (sortedByQuality.length > 0) {
        highestQuality = {
          scenario: sortedByQuality[0]!.scenario,
          label: sortedByQuality[0]!.label,
          avgMs: sortedByQuality[0]!.avgProcessingTimeMs ?? 0,
        };
      }
    }

    await this.delay(200, signal);
    if (signal.aborted) return;

    // ── Phase 6: Exporting ─────────────────────────────────────────────
    this.transitionTo("exporting");
    this.setProgress({
      percent: 99,
      phaseLabel: "Finalizing results…",
    });

    // Build recommended settings
    let recommendedSettings: Partial<ViewerImageEnhancementSettings> | null = null;
    if (bestLatency && highestQuality) {
      // Pick a middle-ground: prefer nvidia-vsr if available, otherwise best WebGL
      const nvidiaResults = completed.filter(
        (r) => r.scenario.startsWith("nvidia-vsr") && r.framesCollected >= r.framesRequested * 0.5,
      );
      if (nvidiaResults.length > 0) {
        // Use the highest NVIDIA quality that stayed within reasonable latency
        const balanced = nvidiaResults
          .filter((r) => (r.avgProcessingTimeMs ?? 0) < (bestLatency.avgMs * 3))
          .sort((a, b) => compareQuality(a.scenario, b.scenario));
        if (balanced.length > 0) {
          const pick = balanced[0]!;
          recommendedSettings = {
            processingBackend: "nvidia-vsr",
            nvidiaQuality: pick.scenario.replace("nvidia-vsr-", "") as "low" | "medium" | "high" | "ultra",
            nvidiaMode: "vsr",
          };
        }
      } else {
        // Fall back to best WebGL scaler
        recommendedSettings = {
          processingBackend: "webgl2",
          webglScalingAlgorithm: bestLatency.scenario.replace("webgl2-", "") as "native" | "bicubic" | "lanczos" | "fsr1-easu",
        };
      }
    }

    this._aggregate = {
      scenarios: scenarioResults,
      totalDurationMs: now() - runStart,
      completedAt: new Date().toISOString(),
      bestLatency,
      highestQuality,
      nativeBenchmarks,
      environment,
      recommendedSettings,
    };

    // Fire export hook exactly once after successful aggregation
    if (typeof this.onExport === "function" && this._aggregate) {
      try {
        this.onExport(this._aggregate, exportSamples);
      } catch {
        // Silently swallow export errors
      }
    }

    await this.delay(100, signal);
    if (signal.aborted) return;

    // ── Complete ───────────────────────────────────────────────────────
    this.transitionTo("completed");
    this.setProgress({
      percent: 100,
      phaseLabel: "Benchmark complete",
      results: scenarioResults,
      currentSamples: [],
    });

    // Schedule settings restoration (the component should call restoreSettings)
    this._restoredAfterRun = false;
  }

  // ── Settings save / restore ──────────────────────────────────────────

  /**
   * Save the current enhancement settings so they can be restored after
   * the benchmark finishes.  Call BEFORE start().
   */
  saveSettings(settings: ViewerImageEnhancementSettings): void {
    this._savedSettings = { ...settings };
  }

  /**
   * Build a settings object by overlaying scenario-specific overrides on
   * the saved (original) settings, keeping the master toggle enabled.
   */
  private mergeScopedSettings(
    overrides: Partial<ViewerImageEnhancementSettings>,
  ): ViewerImageEnhancementSettings {
    const base = this._savedSettings ?? VIEWER_IMAGE_ENHANCEMENT_DEFAULTS;
    return { ...base, ...overrides, enabled: true };
  }

  /**
   * Return the originally-saved settings (or null if never saved).  The
   * component calls this and passes the result to onEnhancementChange to
   * restore the user's original configuration.
   *
   * After calling this, `restoredAfterRun` returns true — the
   * component should check this flag before restoring again to avoid
   * redundant updates.
   */
  buildRestoredSettings(): ViewerImageEnhancementSettings | null {
    if (this._restoredAfterRun || !this._savedSettings) return null;
    this._restoredAfterRun = true;
    return { ...this._savedSettings };
  }

  // ── Utility ──────────────────────────────────────────────────────────

  /** Unsubscribe from frame events (idempotent). */
  private unsubscribeFromFrameEvents(): void {
    if (this._unsubscribeFrameEvents) {
      this._unsubscribeFrameEvents();
      this._unsubscribeFrameEvents = null;
    }
    this._scenarioFrameBuffer = [];
    this._seenScenarioKeys = new Set();
  }

  /**
   * Non-busy delay.  Returns early if the signal is aborted.
   */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ─── Singleton export ───────────────────────────────────────────────────────

/**
 * Global singleton for the benchmark service.
 * Components subscribe via useSyncExternalStore.
 */
export const nvidiaBenchmarkService = new NvidiaBenchmarkService();

export function getBenchmarkProgressSnapshot(): BenchmarkProgress {
  return nvidiaBenchmarkService.getSnapshot();
}

export function subscribeToBenchmarkProgress(callback: () => void): () => void {
  return nvidiaBenchmarkService.subscribe(callback);
}
