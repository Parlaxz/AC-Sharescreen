/**
 * Canonical QualityLevel encoding for NVIDIA RTX Video enhancement.
 *
 * Maps (mode, quality) → a single integer qualityLevel:
 *   VSR:         1..4  (low→1, medium→2, high→3, ultra→4)
 *   Denoise:     8..11 (low→8, medium→9, high→10, ultra→11)
 *   Deblur:      12..15 (low→12, medium→13, high→14, ultra→15)
 *   High-Bitrate: 16..19 (low→16, medium→17, high→18, ultra→19)
 *
 * This is the SINGLE canonical mapping shared across all layers
 * (native C++, main process, renderer). No other mapping should diverge.
 */

export type NvidiaProcessingMode = "vsr" | "high-bitrate" | "denoise" | "deblur";
export type NvidiaQuality = "low" | "medium" | "high" | "ultra";

export const NVIDIA_PROCESSING_MODES: readonly NvidiaProcessingMode[] = [
  "vsr",
  "high-bitrate",
  "denoise",
  "deblur",
] as const;

export const NVIDIA_QUALITIES: readonly NvidiaQuality[] = [
  "low",
  "medium",
  "high",
  "ultra",
] as const;

const MODE_BASE: Record<NvidiaProcessingMode, number> = {
  vsr: 1,
  denoise: 8,
  deblur: 12,
  "high-bitrate": 16,
};

const QUALITY_OFFSET: Record<NvidiaQuality, number> = {
  low: 0,
  medium: 1,
  high: 2,
  ultra: 3,
};

/**
 * Compute the canonical QualityLevel for a given mode + quality.
 * Returns -1 for invalid inputs.
 */
export function canonicalQualityLevel(
  mode: string,
  quality: string,
): number {
  const base = MODE_BASE[mode as NvidiaProcessingMode];
  const offset = QUALITY_OFFSET[quality as NvidiaQuality];
  if (base === undefined || offset === undefined) return -1;
  return base + offset;
}

/**
 * Decompose a canonical QualityLevel back to (mode, quality).
 * Returns null for invalid quality levels.
 */
export function decomposeQualityLevel(
  ql: number,
): { mode: NvidiaProcessingMode; quality: NvidiaQuality } | null {
  if (ql >= 1 && ql <= 4) {
    const mode: NvidiaProcessingMode = "vsr";
    const offsets: NvidiaQuality[] = ["low", "medium", "high", "ultra"];
    return { mode, quality: offsets[ql - 1]! };
  }
  if (ql >= 8 && ql <= 11) {
    const mode: NvidiaProcessingMode = "denoise";
    const offsets: NvidiaQuality[] = ["low", "medium", "high", "ultra"];
    return { mode, quality: offsets[ql - 8]! };
  }
  if (ql >= 12 && ql <= 15) {
    const mode: NvidiaProcessingMode = "deblur";
    const offsets: NvidiaQuality[] = ["low", "medium", "high", "ultra"];
    return { mode, quality: offsets[ql - 12]! };
  }
  if (ql >= 16 && ql <= 19) {
    const mode: NvidiaProcessingMode = "high-bitrate";
    const offsets: NvidiaQuality[] = ["low", "medium", "high", "ultra"];
    return { mode, quality: offsets[ql - 16]! };
  }
  return null;
}

/**
 * Validate that a QualityLevel is in one of the supported ranges.
 */
export function isValidQualityLevel(ql: number): boolean {
  return (
    (ql >= 1 && ql <= 4) ||
    (ql >= 8 && ql <= 11) ||
    (ql >= 12 && ql <= 15) ||
    (ql >= 16 && ql <= 19)
  );
}

/**
 * Determine output dimensions based on processing mode.
 * VSR and High-Bitrate produce 2× source resolution.
 * Denoise and Deblur produce same-resolution output.
 */
export function nvidiaOutputDimensions(
  mode: NvidiaProcessingMode,
  inputWidth: number,
  inputHeight: number,
): { width: number; height: number } {
  if (mode === "denoise" || mode === "deblur") {
    return { width: inputWidth, height: inputHeight };
  }
  return { width: inputWidth * 2, height: inputHeight * 2 };
}

/**
 * Applied NVIDIA configuration returned from native helper after a successful
 * configure/start. Threaded through main/preload/renderer for requested-vs-applied
 * contract validation.
 *
 * The native side may not be able to query every applied value directly from the
 * SDK; fields marked with verificationMethod 'set-and-load-confirmed' are set from
 * what was requested and confirmed by a successful effect load, not from a read-back.
 */
export interface AppliedNvidiaConfig {
  /** Monotonically increasing configuration revision. Advances only on actual change. */
  configurationId: number;
  /** Monotonically increasing effect instance revision. Advances on each effect reload. */
  effectInstanceId: number;
  /** Requested processing mode as originally sent (e.g. "vsr") */
  requestedMode: string;
  /** Requested quality as originally sent (e.g. "high") */
  requestedQuality: string;
  /** Applied processing mode (same as requested unless fallback) */
  appliedMode: string;
  /** Applied quality (same as requested unless fallback) */
  appliedQuality: string;
  /** Canonical QualityLevel integer */
  appliedQualityLevel: number;
  /** Input width configured */
  inputWidth: number;
  /** Input height configured */
  inputHeight: number;
  /** Output width configured */
  outputWidth: number;
  /** Output height configured */
  outputHeight: number;
  /** Input pixel format string */
  inputPixelFormat: string;
  /** Native GPU pixel format string */
  nativeGpuFormat: string;
  /** GPU index (always 0 unless multi-GPU logic added) */
  gpuIndex: number;
  /** Whether CUDA stream was bound before effect load */
  cudaStreamBound: boolean;
  /** Whether effect loading succeeded */
  effectLoadSucceeded: boolean;
  /** Number of times effect has been loaded */
  effectLoadCount: number;
  /** Timestamp of configuration (ms since epoch) */
  configuredAt: number;
  /** How verification was performed when SDK cannot query exact applied values */
  verificationMethod: "set-and-load-confirmed" | "sdk-queried" | "passthrough";
}

/**
 * Diagnostics snapshot from the native D3D11 presenter.
 */
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

/**
 * Narrowest compliant implementation of AppliedNvidiaConfig.
 * Uses verificationMethod = 'set-and-load-confirmed' when SDK cannot
 * query exact applied values.
 */
export function createAppliedNvidiaConfig(params: {
  configurationId: number;
  effectInstanceId: number;
  requestedMode: string;
  requestedQuality: string;
  appliedMode: string;
  appliedQuality: string;
  appliedQualityLevel: number;
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  inputPixelFormat: string;
  effectLoadSucceeded: boolean;
  effectLoadCount: number;
  /** Optional override for configuredAt. Falls back to Date.now() when absent. */
  configuredAt?: number;
}): AppliedNvidiaConfig {
  return {
    configurationId: params.configurationId,
    effectInstanceId: params.effectInstanceId,
    requestedMode: params.requestedMode,
    requestedQuality: params.requestedQuality,
    appliedMode: params.appliedMode,
    appliedQuality: params.appliedQuality,
    appliedQualityLevel: params.appliedQualityLevel,
    inputWidth: params.inputWidth,
    inputHeight: params.inputHeight,
    outputWidth: params.outputWidth,
    outputHeight: params.outputHeight,
    inputPixelFormat: params.inputPixelFormat,
    nativeGpuFormat: "rgba8",
    gpuIndex: 0,
    cudaStreamBound: true,
    effectLoadSucceeded: params.effectLoadSucceeded,
    effectLoadCount: params.effectLoadCount,
    configuredAt: params.configuredAt ?? Date.now(),
    verificationMethod: "set-and-load-confirmed",
  };
}
