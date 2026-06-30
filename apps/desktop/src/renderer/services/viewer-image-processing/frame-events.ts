// SPDX-License-Identifier: MIT
/**
 * frame-events.ts
 *
 * Immutable per-frame event type owned by the processing layer.
 * Emitted by ViewerImageProcessor for each frame lifecycle event
 * (completion, presentation, drop) and consumed by the benchmark
 * service for event-driven scenario collection.
 *
 * All fields are readonly — once emitted, events are immutable.
 */

import type { BackendKind, TimingBreakdown } from "./viewer-image-backend";
import type { NvidiaProcessingMode } from "@screenlink/shared";

// ─── Frame event ─────────────────────────────────────────────────────────────

export interface FrameEvent {
  /** Client identity (from NVIDIA client lease, if available). */
  readonly clientId?: string;

  /** Monotonic generation counter (incremented on start/restart/stream switch). */
  readonly generation: number;

  /** Monotonic frame sequence number within generation. */
  readonly sequence: number;

  /** Source media time (video.currentTime at capture start), if available. */
  readonly sourceMediaTime?: number;

  /** Configuration identity from applied config. 0 when unknown/unavailable. */
  readonly configurationId: number;

  /** Active processing backend. */
  readonly backend: BackendKind;

  /** NVIDIA processing mode (only meaningful when backend is nvidia-vsr). */
  readonly nvidiaMode?: NvidiaProcessingMode;

  /** Canonical QualityLevel integer. null for non-NVIDIA backends. */
  readonly canonicalQualityLevel: number | null;

  /** Input (source) pixel dimensions at capture time. */
  readonly inputWidth: number;

  /** Input (source) pixel dimensions at capture time. */
  readonly inputHeight: number;

  /** Output (processed) pixel dimensions. */
  readonly outputWidth: number;

  /** Output (processed) pixel dimensions. */
  readonly outputHeight: number;

  /** How the frame was captured from the video source. */
  readonly capturePath: "canvas-2d-drawimage" | "webgl-texsubimage2d" | "message-port";

  /** How the frame was transported to the native processor. */
  readonly transportPath: "invoke" | "message-port" | "none";

  /** How the result was presented to the display. */
  readonly presentationPath: "webgl-texture-upload" | "native-presenter" | "fallback-cpu";

  // ─── Absolute timestamps (performance.now) ───────────────────────────
  /** When the frame capture started (renderer-side). */
  readonly captureStartedAt: number;

  /** When the frame was submitted to the native processor. */
  readonly submittedAt?: number;

  /** When native processing completed (from frame header or renderer-observed). */
  readonly nativeCompletedAt?: number;

  /** When the frame was presented (WebGL draw or native presenter ack). */
  readonly presentedAt?: number;

  // ─── Per-stage durations (ms) ────────────────────────────────────────
  /** Duration of the capture phase (drawImage + getImageData or texSubImage2D). */
  readonly captureDurationMs: number;

  /** Duration of IPC transport to native processor. */
  readonly transportDurationMs?: number;

  /** Duration of native VSR processing (renderer-observed round-trip or header). */
  readonly nativeProcessingDurationMs?: number;

  /** Duration of the presentation / upload phase. */
  readonly presentationDurationMs?: number;

  /** Total latency from capture start to presentation (ms). */
  readonly totalLatencyMs?: number;

  // ─── Lifecycle flags ─────────────────────────────────────────────────
  /** True when the frame was fully processed and (for WebGL) presented. */
  readonly completed: boolean;

  /** True when the frame was presented to the display. */
  readonly presented: boolean;

  /** True when this frame belongs to a stale generation. */
  readonly stale: boolean;

  /** Human-readable reason when the frame was skipped/dropped. */
  readonly dropReason?: "backpressure" | "stale-generation" | "stale-config" | "transient" | "failure";

  /** Raw timing breakdown from backend, if available. */
  readonly timingBreakdown?: TimingBreakdown;
}

// ─── Listener type ───────────────────────────────────────────────────────────

export type FrameEventListener = (event: FrameEvent) => void;

// ─── Config-applied event ────────────────────────────────────────────────────

export interface ConfigAppliedEvent {
  /** The configuration id that was applied. */
  readonly configurationId: number;

  /** Active backend after config application. */
  readonly backend: BackendKind;

  /** NVIDIA processing mode (only when backend is nvidia-vsr). */
  readonly nvidiaMode?: NvidiaProcessingMode;

  /** Canonical QualityLevel from the applied config. */
  readonly canonicalQualityLevel: number | null;

  /** Output width from the applied config. */
  readonly outputWidth: number;

  /** Output height from the applied config. */
  readonly outputHeight: number;

  /** The generation counter at the time of config application. */
  readonly generation: number;
}

export type ConfigAppliedListener = (event: ConfigAppliedEvent) => void;

// ─── Enhancement diagnostics (comprehensive, for display/export) ────────────

/**
 * Comprehensive diagnostics snapshot for the NVIDIA VSR enhancement pipeline.
 *
 * This type aggregates every available diagnostic signal:
 *   - Timing breakdown (per-frame and aggregated)
 *   - Native presenter state (GPU-resident display)
 *   - Shared memory ring (SHM) async submission counters
 *   - Quality and configuration metadata
 *   - Processor-level counters
 *   - Native benchmark results
 *
 * Convention: `undefined` = measurement not available (never convert to 0).
 * `0` = real measured zero.
 */
export interface EnhancementFrameDiagnostics {
  // ── Timing breakdown (latest-frame values) ────────────────────────────────
  timingBreakdown?: TimingBreakdown;

  // ── Aggregated timing averages over the measurement window ───────────────
  /** Average capture+readback time (ms) */
  avgCaptureReadbackMs?: number;
  /** Average drawImage time (ms) */
  avgDrawImageMs?: number;
  /** Average getImageData time (ms) */
  avgGetImageDataMs?: number;
  /** Average input buffer preparation time (ms) */
  avgInputBufferPreparationMs?: number;
  /** Average renderer-to-result round-trip (ms) */
  avgRendererToResultMs?: number;
  /** Average texture upload time (ms) */
  avgTextureUploadMs?: number;
  /** Average renderer total time (ms) */
  avgRendererTotalMs?: number;
  /** Average native transport+processing time (ms) */
  avgNativeTransportProcessingMs?: number;
  /** Average display upload time (ms) */
  avgDisplayUploadMs?: number;
  /** Average total latency (ms) */
  avgTotalLatencyMs?: number;

  // ── Processor-level counters ─────────────────────────────────────────────
  framesDisplayed?: number;
  framesProcessed?: number;
  processingAttempts?: number;
  completedAttempts?: number;
  failures?: number;
  backpressureDrops?: number;
  schedulerDrops?: number;
  staleGenerationDrops?: number;
  staleConfigDrops?: number;
  coalescedFrames?: number;
  completedFps?: number;

  // ── Native presenter diagnostics ─────────────────────────────────────────
  /** Whether the native presenter is actively displaying frames */
  nativePresenterActive?: boolean;
  /** Current presenter queue depth (frames in flight) */
  presenterQueueDepth?: number;
  /** Number of frames coalesced by the presenter (cumulative) */
  presenterFramesCoalesced?: number;
  /** Number of frames skipped by the presenter (cumulative) */
  presenterFramesSkipped?: number;
  /** Presenter GPU latency for last frame (microseconds) */
  presenterGpuLatencyUs?: number;
  /** Total frames presented by the native presenter (cumulative) */
  presenterFramesPresented?: number;
  /** Total frames dropped by the native presenter (cumulative) */
  presenterFramesDropped?: number;

  // ── SHM ring diagnostics ─────────────────────────────────────────────────
  /** Number of SHM ring buffer overruns (cumulative) */
  shmOverruns?: number;
  /** Number of SHM submissions with notify failure (cumulative) */
  shmNotifyFailures?: number;
  /** Number of SHM submissions that timed out (cumulative) */
  shmTimeouts?: number;
  /** Average SHM write-to-notify latency (microseconds) */
  shmAvgWriteNotifyUs?: number;
  /** Average SHM notify-to-response latency (microseconds) */
  shmAvgNotifyResponseUs?: number;

  // ── Quality / configuration metadata ─────────────────────────────────────
  inputWidth?: number;
  inputHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  processingMode?: string;
  qualityLevel?: string;
  canonicalQualityLevel?: number;
  configurationId?: number;
  generation?: number;
  presentationPath?: "native-presenter" | "webgl" | "fallback-cpu";
  capturePath?: "none" | "video-frame" | "rqvc-canvas";
}

