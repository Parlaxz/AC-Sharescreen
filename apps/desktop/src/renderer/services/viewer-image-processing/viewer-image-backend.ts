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

export type BackendKind = "webgl2" | "unavailable";

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
  destroy(): Promise<void>;
}
