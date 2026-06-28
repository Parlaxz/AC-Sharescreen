import type { ViewerImageEnhancementSettings } from "./viewer-image-settings.js";

/**
 * Centralized defaults for the viewer's GPU image enhancement pipeline.
 * Used on first launch, after reset, and as fallback when stored settings
 * are corrupt.
 *
 * Conservative defaults: master disabled, native scaling, no enhancements.
 * Settings tuned after visual testing:
 *   - Sharpness 0.14: subtle spatial sharpening, zero is bypass
 *   - Noise Protection 0.85: protects noise while sharpening coherent edges
 *   - Compression Cleanup 0.20: mild edge-aware cleanup of block/color artifacts
 *   - Debanding 0.10: subtle gradient smoothing, disabled by default
 *   - FSR/Bicubic Blend 0.70: favours EASU when FSR is active
 */
export const VIEWER_IMAGE_ENHANCEMENT_DEFAULTS: ViewerImageEnhancementSettings = {
  enabled: false,
  scalingAlgorithm: "native",
  sharpeningStrength: 0.14,
  noiseProtection: 0.85,
  compressionCleanup: 0.20,
  debanding: 0.10,
  fsrBicubicBlend: 0.70,
};

/**
 * Range metadata shared across all numeric enhancement controls.
 * Every continuous value is clamped to [0, 1] with 0.01 step.
 */
export const IMAGE_ENHANCEMENT_CONTROL_RANGE = { min: 0, max: 1, step: 0.01 } as const;
