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

export interface BackendInitResult {
  success: boolean;
  reason?: string;
}

export interface FrameProcessResult {
  success: boolean;
  gpuTimeMs?: number;
  /** true when the frame was skipped (video not ready) — NOT a failure */
  transient?: boolean;
  /** true when the frame was dropped due to backpressure */
  backpressureDrop?: boolean;
  /** Timing breakdown for Phase 1 truthful statistics */
  timingBreakdown?: {
    // Renderer-process timings (performance.now, process-local)
    captureReadbackMs?: number;
    drawImageMs?: number;
    getImageDataMs?: number;
    inputBufferPreparationMs?: number;
    /** Renderer-observed wait for native result */
    rendererToResultMs?: number;
    textureUploadMs?: number;
    rendererTotalMs?: number;
    // Native-process transport+processing (carried as durations, not raw deltas)
    nativeTransportProcessingMs?: number;
    displayUploadMs?: number;

    // Main-process per-frame timings (captured in VideoHelperManager.submitFrame)
    mainInputHandlingMs?: number;
    pipeWriteMs?: number;
    pipeWaitAndReadMs?: number;
    mainOutputPostMs?: number;

    // Native per-stage timings from frame header (μs→ms conversion)
    nativeInputReceiveMs?: number;
    nativeUploadMs?: number;
    nativeEffectMs?: number;
    nativeDownloadMs?: number;
    nativeOutputWriteMs?: number;
    nativeTotalMs?: number;
  };
  /** Total latency from capture to displayed frame */
  totalLatencyMs?: number;
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
