import type { ViewerImageEnhancementSettings } from "./viewer-image-settings.js";

/**
 * Centralized defaults for the viewer's GPU image enhancement pipeline.
 * Used on first launch, after reset, and as fallback when stored settings
 * are corrupt.
 *
 * Conservative defaults: master disabled, native scaling, no enhancements.
 * All optional effects default to zero (bypass).
 * Schema version 4: added processingBackend, webglScalingAlgorithm,
 * NVIDIA VSR controls, custom output settings.
 */
export const VIEWER_IMAGE_ENHANCEMENT_DEFAULTS: ViewerImageEnhancementSettings = {
  enabled: false,
  processingBackend: "webgl2",
  webglScalingAlgorithm: "native",
  fsrTargetScale: "auto",
  fsrFinalScaler: "bicubic",
  nvidiaMode: "vsr",
  nvidiaQuality: "high",
  nvidiaOutput: "display",
  customOutputWidth: null,
  customOutputHeight: null,
  maintainAspectRatio: true,
  sharpeningStrength: 0.25,
  noiseProtection: 0.0,
  compressionCleanup: 0.0,
  debanding: 0.0,
  _schemaVersion: 4,
};

/**
 * Range metadata shared across all numeric enhancement controls.
 * Every continuous value is clamped to [0, 1] with 0.01 step.
 */
export const IMAGE_ENHANCEMENT_CONTROL_RANGE = { min: 0, max: 1, step: 0.01 } as const;
