/**
 * Bitrate and scaling utility functions.
 */

/**
 * Compute an effective video ceiling for a viewer, taking into account:
 * - The viewer's requested bitrate
 * - The per-viewer maximum allowed by policy
 * - The total media budget and what other peers are using
 *
 * Returns the minimum of the requested bitrate, the per-viewer cap,
 * and the remaining available budget.
 */
export function computeEffectiveVideoCeiling(
  requested: number,
  maxPerViewer: number,
  maxBudget: number,
  otherPeersCeilings: number[],
): number {
  const usedByOthers = otherPeersCeilings.reduce((a, b) => a + b, 0);
  const available = maxBudget - usedByOthers;
  return Math.min(requested, maxPerViewer, available);
}

/**
 * Compute the scale factor needed to fit source dimensions into target dimensions.
 * The scale factor is always >= 1 (we only downscale).
 *
 * Returns the larger of the width scale and height scale, meaning the
 * source will be downscaled enough to fit within both constraints.
 */
export function computeScale(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): number {
  const widthScale = targetWidth > 0 ? sourceWidth / targetWidth : 1;
  const heightScale = targetHeight > 0 ? sourceHeight / targetHeight : 1;
  return Math.max(1, widthScale, heightScale);
}

/**
 * The minimum configurable video ceiling in kbps.
 */
export const MIN_CONFIGURABLE_VIDEO_CEILING_KBPS = 100;
