export const VIDEO_ENHANCER_PROTOCOL_VERSION = "0.1.0";

import type { AppliedNvidiaConfig } from "@screenlink/shared";

// ─── Capability probing ─────────────────────────────────────────────────────

export interface VideoEnhancerCapability {
  available: boolean;
  reason: string;
  adapterName: string;
  driverVersion: string;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface VideoEnhancerConfig {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  processingMode: "vsr" | "high-bitrate" | "denoise" | "deblur";
  qualityLevel: "low" | "medium" | "high" | "ultra";
  pixelFormat: "bgra8" | "rgba8";
}

/**
 * Result of a configure/start operation with applied config details.
 * If success is false, the other fields may be undefined/incomplete.
 */
export interface VideoEnhancerConfigureResult {
  success: boolean;
  error?: string;
  /** Full applied config when successful */
  appliedConfig?: AppliedNvidiaConfig;
}

// ─── Frame submission ───────────────────────────────────────────────────────

export interface VideoEnhancerFrameSubmit {
  generation: number;
  frameSequence: number;
  inputWidth: number;
  inputHeight: number;
  pixelFormat: "bgra8" | "rgba8";
  outputWidth: number;
  outputHeight: number;
  processingMode: number;
  qualityLevel: number;
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export interface VideoEnhancerDiagnostics {
  totalFramesSubmitted: number;
  totalFramesCompleted: number;
  totalFramesDropped: number;
  totalProcessingErrors: number;
  lastProcessingTimeUs: number;
  maxProcessingTimeUs: number;
  minProcessingTimeUs: number;

  // Phase 6: Native timing breakdown (microseconds, process-local)
  // Per-frame native timings ONLY include stages knowable before transmission:
  /** Time to receive input frame data over the pipe */
  nativeInputReceiveUs?: number;
  /** Time to upload pixels to GPU (CPU→GPU transfer) */
  nativeUploadUs?: number;
  /** Time for NVIDIA VFX processing (NvVFX_Run interval only) */
  nativeEffectUs?: number;
  /** Time to download processed pixels from GPU (GPU→CPU transfer) */
  nativeDownloadUs?: number;
  /** Total pre-write native processing time (inputReceive + upload + effect + download).
   *  Does NOT include output write time, which is only available in aggregate diagnostics. */
  nativePreWriteTotalUs?: number;
  /** Output write time — aggregate-only; NOT per-frame. Kept here for diagnostics query. */
  nativeOutputWriteUs?: number;
}

export interface VideoEnhancerStats {
  framesSubmitted: number;
  framesCompleted: number;
  framesDropped: number;
  errors: number;
  lastProcessingTimeMs: number;
}
