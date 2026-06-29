export const VIDEO_ENHANCER_PROTOCOL_VERSION = "0.1.0";

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
  /** Time to receive input frame data over the pipe */
  nativeInputReceiveUs?: number;
  /** Time to upload pixels to GPU (CPU→GPU transfer) */
  nativeUploadUs?: number;
  /** Time for NVIDIA VFX processing (RunFrame) */
  nativeEffectUs?: number;
  /** Time to download processed pixels from GPU (GPU→CPU transfer) */
  nativeDownloadUs?: number;
  /** Time to write output frame back over the pipe */
  nativeOutputWriteUs?: number;
  /** Total native processing time (sum of above) */
  nativeTotalUs?: number;
}

export interface VideoEnhancerStats {
  framesSubmitted: number;
  framesCompleted: number;
  framesDropped: number;
  errors: number;
  lastProcessingTimeMs: number;
}
