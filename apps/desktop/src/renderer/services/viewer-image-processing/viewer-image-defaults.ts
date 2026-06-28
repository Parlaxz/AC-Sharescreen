import type { ViewerImageEnhancementSettings } from "./viewer-image-settings.js";

/**
 * Centralized defaults for the viewer's GPU image enhancement pipeline.
 * Used on first launch, after reset, and as fallback when stored settings
 * are corrupt.
 *
 * Conservative defaults: master disabled, native scaling, no enhancements.
 */
export const VIEWER_IMAGE_ENHANCEMENT_DEFAULTS: ViewerImageEnhancementSettings = {
  enabled: false,
  scalingAlgorithm: "native",
  sharpeningStrength: 0.14,
  chromaContribution: 0.20,
  artifactClamp: 0.55,
  textureNoiseSharpening: 0.08,
  antiRinging: 0.45,
  chromaCleanup: 0.35,
  compressionSmoothing: 0.25,
};

/**
 * Range metadata shared across all numeric enhancement controls.
 * Every continuous value is clamped to [0, 1] with 0.01 step.
 */
export const IMAGE_ENHANCEMENT_CONTROL_RANGE = { min: 0, max: 1, step: 0.01 } as const;
