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
