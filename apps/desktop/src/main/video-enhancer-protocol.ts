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

/**
 * Typed response from the native helper's stats/diagnostics command.
 * Replaces ad-hoc Record<string, unknown> usage.
 */
export interface VideoEnhancerDiagnosticsResponse {
  success: boolean;
  totalFramesSubmitted: number;
  totalFramesCompleted: number;
  totalFramesDropped: number;
  totalProcessingErrors: number;
  lastProcessingTimeUs: number;
  maxProcessingTimeUs: number;
  minProcessingTimeUs: number;
  /** Time to receive input frame data over the pipe (μs) */
  nativeInputReceiveUs?: number;
  /** Time to upload pixels to GPU (μs) */
  nativeUploadUs?: number;
  /** Time for NVIDIA VFX processing (μs) */
  nativeEffectUs?: number;
  /** Time to download processed pixels from GPU (μs) */
  nativeDownloadUs?: number;
  /** Total pre-write native processing time (μs) */
  nativePreWriteTotalUs?: number;
  /** Output write time (μs) — aggregate only */
  nativeOutputWriteUs?: number;
  /** Helper uptime in milliseconds */
  uptimeMs?: number;
  /** Current configuration revision */
  configurationId?: number;
  /** Current effect instance revision */
  effectInstanceId?: number;
}

/**
 * Typed response from the native helper's configure command.
 * Replaces ad-hoc Record<string, unknown> in buildAppliedConfig.
 */
// ─── Native presenter types ────────────────────────────────────────────────

export interface NativePresenterAttachRequest {
  ownerHwnd: number; // BrowserWindow HWND as native handle
  width: number;
  height: number;
}

export interface NativePresenterBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativePresenterDiagnostics {
  active: boolean;
  framesPresented: number;
  framesDropped: number;
  presentErrors: number;
  lastPresentUs: number;
  avgPresentUs: number;
  maxPresentUs: number;
  presenterResizes: number;
}

// ─── Shared memory ring ─────────────────────────────────────────────────

/** Slot control word values (must match SharedFrameRing.h SlotState). */
export const enum ShmSlotState {
  Empty = 0,
  Submitted = 1,
  Processing = 2,
  Done = 3,
  Error = 4,
}

/** Byte offsets and sizes for shared memory ring file access. */
export const kRingSlotCount = 3;
export const kSlotControlSize = 4;       // uint32_t
export const kSlotPaddingSize = 4;       // uint32_t padding
export const kSlotHeaderSize = 104;      // sizeof(FrameHeader)
export const kSlotInputOffset = 112;     // offsetof(RingSlotLayout, inputPixels)
export const kSlotOutputOffset = 112 + 33_177_600; // kSlotInputOffset + kMaxFrameSize
export const kSlotSize = kSlotOutputOffset + 33_177_600; // kSlotOutputOffset + kMaxFrameSize
export const kRingTotalSize = kRingSlotCount * kSlotSize;

/** Capability fields indicating shared memory availability. */
export interface SharedMemoryCapability {
  sharedMemoryAvailable: boolean;
  sharedMemoryPath?: string;
  sharedMemorySlotCount?: number;
  sharedMemorySlotSize?: number;
  sharedMemoryTotalSize?: number;
}

export interface ConfigureNativeResponse {
  success: boolean;
  error?: string;
  configurationId?: number;
  effectInstanceId?: number;
  appliedQualityLevel?: number;
  appliedMode?: string;
  appliedQuality?: string;
  requestedMode?: string;
  requestedQuality?: string;
  inputWidth?: number;
  inputHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  inputPixelFormat?: string;
  effectLoadSucceeded?: boolean;
  effectLoadCount?: number;
  configuredAt?: number;
}
