// SPDX-License-Identifier: MIT
/**
 * Backend interface for the GPU image enhancement pipeline.
 *
 * All rendering backends (WebGL2, NVIDIA VSR, etc.) implement this
 * interface.  The processor consumes a ViewerImageBackend via constructor
 * injection so the correct backend can be selected at startup or swapped
 * live.
 */

import type {
  ViewerImageEnhancementSettings,
  ScalingAlgorithm,
  FsrFinalScaler,
} from "./viewer-image-settings";

// ─── Backend kind ────────────────────────────────────────────────────────────

export type BackendKind = "webgl2" | "nvidia-vsr" | "unavailable";

// ─── Shared result types ─────────────────────────────────────────────────────

/**
 * Timing breakdown for a single frame's lifecycle.
 *
 * All fields are optional; `undefined` means the measurement was not available
 * for that frame (e.g. native timings before the first native-header response).
 * `0` is a real measured zero — never substitute 0 for unavailable.
 *
 * This is the canonical type used in FrameProcessResult, FrameEvent,
 * PerFrameSample, and the benchmark export path.
 */
export interface TimingBreakdown {
  // ── Renderer-process timings (performance.now, process-local) ──────────
  captureReadbackMs?: number;
  drawImageMs?: number;
  getImageDataMs?: number;
  inputBufferPreparationMs?: number;
  /** Renderer-observed wait for native result */
  rendererToResultMs?: number;
  textureUploadMs?: number;
  rendererTotalMs?: number;

  // ── Native-process transport+processing (carried as durations) ─────────
  nativeTransportProcessingMs?: number;
  displayUploadMs?: number;

  // ── Main-process per-frame timings (VideoHelperManager.submitFrame) ────
  mainInputHandlingMs?: number;
  requestWriteMs?: number;
  responseWaitMs?: number;
  mainHandlerTotalMs?: number;

  // ── Native per-stage timings from frame header (μs→ms) ─────────────────
  // Only includes stages knowable-before-write. nativeOutputWriteMs NOT
  // exposed per-frame (aggregate only).
  nativeInputReceiveMs?: number;
  nativeUploadMs?: number;
  nativeEffectMs?: number;
  nativeDownloadMs?: number;
  nativePreWriteTotalMs?: number;
}

export interface BackendInitResult {
  success: boolean;
  reason?: string;
}

export interface FrameProcessResult {
  success: boolean;
  gpuTimeMs?: number;
  outputWidth?: number;
  outputHeight?: number;
  /** true when the frame was skipped (video not ready) — NOT a failure */
  transient?: boolean;
  /** true when the frame was dropped due to backpressure */
  backpressureDrop?: boolean;
  /** Timing breakdown for Phase 1 truthful statistics */
  timingBreakdown?: TimingBreakdown;
  /** Total latency from capture to displayed frame */
  totalLatencyMs?: number;

  /** Configuration identity from the applied config (0 when unknown). */
  configurationId?: number;

  /** Canonical QualityLevel integer from the applied config. null for non-NVIDIA backends. */
  canonicalQualityLevel?: number | null;
}

// ─── Frame metadata passed alongside each frame ──────────────────────────────

export interface FrameMetadata {
  /** Monotonic generation counter (incremented on start/restart/stream switch) */
  generation: number;
  /** Monotonic frame sequence number within generation */
  frameSequence: number;
}

// ─── Backend stats (common across all backends) ──────────────────────────────

export interface BackendStats {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  enhancedScalingActive: boolean;
  lastGpuTimeMs: number | null;
  backend: BackendKind;
  framesProcessed: number;
  /** Active processing passes description */
  activePasses: string[];
  /** Backpressure drops count for async backends */
  backpressureDrops: number;
  /** Current stream generation */
  generation?: number;
  /** Canonical NVIDIA QualityLevel when backend is nvidia-vsr */
  nativeQualityLevel?: number | null;

  // ── Phase 6: Processor-level counters ──────────────────────────────────
  /** Number of frames submitted for processing */
  processingAttempts?: number;
  /** Number of frames completed successfully */
  completedAttempts?: number;
  /** Number of frames displayed */
  displayedCount?: number;
  /** Number of frames coalesced due to backpressure */
  coalescedCount?: number;
  /** Number of backend-generated drops */
  backendDrops?: number;
  /** Number of stale-generation result discards */
  staleGenerationResults?: number;
  /** Number of processing failures */
  failures?: number;

  // ── Extended fields (populated by WebGL2 backend, undefined for others) ──
  scalingAlgorithm?: ScalingAlgorithm;
  easuTargetWidth?: number;
  easuTargetHeight?: number;
  finalBicubicActive?: boolean;
  fsrFinalScaler?: FsrFinalScaler | null;
  rcasActive?: boolean;

  // ── Phase 2: Requested/Applied config state ────────────────────────────
  /** Current config application state */
  configState?: "idle" | "applying" | "applied" | "error";
  /** Number of stale config drops */
  staleConfigDrops?: number;

  // ── Native presenter diagnostics ───────────────────────────────────────
  /** Current presentation path identifier */
  presentationPath?: "native-presenter" | "webgl" | "fallback-cpu";
  /** Current capture path identifier */
  capturePath?: "none" | "video-frame" | "rqvc-canvas";
  /** Presenter latency for the last frame (microseconds) */
  presenterLatencyUs?: number;
  /** Number of frames presented natively (cumulative) */
  presenterFramesPresented?: number;
  /** Number of frames dropped by the presenter (cumulative) */
  presenterFramesDropped?: number;
}

// ─── Backend interface ───────────────────────────────────────────────────────

export interface ViewerImageBackend {
  readonly kind: BackendKind;

  initialize(canvas?: HTMLCanvasElement): Promise<BackendInitResult>;
  updateSettings(settings: ViewerImageEnhancementSettings): void;
  processFrame(
    video: HTMLVideoElement,
    metadata?: FrameMetadata,
  ): Promise<FrameProcessResult>;
  resizeOutput(width: number, height: number, dpr: number): void;
  onSourceResize?(sourceWidth: number, sourceHeight: number): void;
  getStats(): BackendStats;
  destroy(reason?: string): Promise<void>;
}
