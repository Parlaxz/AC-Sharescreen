import {
  type GroupQualitySettings,
  type HostQualityLimits,
  type ViewerQualityRequest,
  RANGES,
} from "./quality-settings.js";

// ─── Output Type ───────────────────────────────────────────────────────────

/**
 * Pure return type for {@link calculateEffectiveQuality}.
 *
 * - `requested`: the viewer's request if it was honored (and host allowed it),
 *   otherwise `null`.
 * - `effective`: the final resolved quality after clamping and scaling.
 * - `clampReasons`: human-readable descriptions of every clamping decision.
 */
export interface EffectiveQualityResult {
  requested: Partial<ViewerQualityRequest> | null;
  effective: {
    videoBitrateKbps: number;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    degradationPreference: string;
  };
  clampReasons: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ─── Pure Resolver ─────────────────────────────────────────────────────────

/**
 * Resolve effective streaming quality from group defaults, host limits, an
 * optional viewer request, and source capture dimensions.
 *
 * This is a **pure function** with no side effects — it does not read or write
 * any mutable state. It produces a deterministic output given the same inputs.
 *
 * **Resolution order (strict):**
 * 1. Start from `groupSettings.video` defaults.
 * 2. If `viewerRequest` is provided **and** `hostLimits.allowViewerQualityRequests`
 *    is `true`, override the five viewer-controllable fields from the request.
 * 3. Clamp each field to its schema range (`RANGES`).
 * 4. Clamp each field to the corresponding host limit.
 * 5. If `groupSettings.video.preventUpscale`, ensure width/height do not exceed
 *    source dimensions.
 * 6. Apply `scaleResolutionDownBy` **only** when group defaults are used (no
 *    viewer dimensions were honored). Viewers that explicitly request dimensions
 *    produce final output dimensions directly — no group-level scaling on top.
 *
 * @param groupSettings - The group's published quality settings (source of defaults).
 * @param hostLimits    - The host machine's capability limits.
 * @param viewerRequest - The viewer's desired quality, or `null` if absent.
 * @param sourceDimensions - The actual capture source width and height.
 *
 * @returns An `EffectiveQualityResult` with the resolved effective quality and
 *          any clamp reasons.
 */
export function calculateEffectiveQuality(
  groupSettings: GroupQualitySettings,
  hostLimits: HostQualityLimits,
  viewerRequest: ViewerQualityRequest | null,
  sourceDimensions: { width: number; height: number },
): EffectiveQualityResult {
  // 1. Start from group defaults for viewer-requestable fields
  let bitrate = groupSettings.video.videoBitrateKbps;
  let width = groupSettings.video.sendWidth;
  let height = groupSettings.video.sendHeight;
  let fps = groupSettings.video.sendFps;
  let degradation = groupSettings.video.degradationPreference;
  const reasons: string[] = [];

  // 2. If viewer request exists AND host allows viewer quality requests, use those values
  const usingViewerDimensions = viewerRequest !== null && hostLimits.allowViewerQualityRequests;
  if (usingViewerDimensions) {
    bitrate = viewerRequest.videoBitrateKbps;
    width = viewerRequest.maxWidth;
    height = viewerRequest.maxHeight;
    fps = viewerRequest.maxFps;
    degradation = viewerRequest.degradationPreference;
  }

  // 3. Clamp to schema ranges
  bitrate = clamp(bitrate, RANGES.videoBitrateKbps.min, RANGES.videoBitrateKbps.max);
  width = clamp(width, RANGES.sendWidth.min, RANGES.sendWidth.max);
  height = clamp(height, RANGES.sendHeight.min, RANGES.sendHeight.max);
  fps = clamp(fps, RANGES.sendFps.min, RANGES.sendFps.max);

  // 4. Clamp to host limits
  if (bitrate > hostLimits.maxVideoBitrateKbps) {
    reasons.push(`Bitrate clamped from ${bitrate} to host limit ${hostLimits.maxVideoBitrateKbps}`);
    bitrate = hostLimits.maxVideoBitrateKbps;
  }
  if (width > hostLimits.maxWidth) {
    reasons.push(`Width clamped from ${width} to host limit ${hostLimits.maxWidth}`);
    width = hostLimits.maxWidth;
  }
  if (height > hostLimits.maxHeight) {
    reasons.push(`Height clamped from ${height} to host limit ${hostLimits.maxHeight}`);
    height = hostLimits.maxHeight;
  }
  if (fps > hostLimits.maxFps) {
    reasons.push(`FPS clamped from ${fps} to host limit ${hostLimits.maxFps}`);
    fps = hostLimits.maxFps;
  }

  // 5. Clamp to source dimensions when preventUpscale
  if (groupSettings.video.preventUpscale) {
    if (width > sourceDimensions.width) {
      reasons.push(`Width clamped from ${width} to source ${sourceDimensions.width} (preventUpscale)`);
      width = sourceDimensions.width;
    }
    if (height > sourceDimensions.height) {
      reasons.push(`Height clamped from ${height} to source ${sourceDimensions.height} (preventUpscale)`);
      height = sourceDimensions.height;
    }
  }

  // 6. Apply scaleResolutionDownBy only when using group defaults.
  //    When the viewer explicitly requested dimensions (and host allows it),
  //    those ARE the final output dimensions — do NOT compound group-level
  //    scaling on top. The sender-side applyToSender() computes one
  //    source-to-target scaleResolutionDownBy, which is the correct single
  //    scaling operation.
  let outputWidth: number;
  let outputHeight: number;
  if (usingViewerDimensions) {
    // Viewer specified final dimensions — do not apply group scaling
    outputWidth = width;
    outputHeight = height;
  } else {
    // Group defaults — apply group-level scaleResolutionDownBy
    const scale = groupSettings.video.scaleResolutionDownBy;
    outputWidth = Math.round(width / scale);
    outputHeight = Math.round(height / scale);
  }

  return {
    requested: usingViewerDimensions
      ? {
          videoBitrateKbps: viewerRequest!.videoBitrateKbps,
          maxWidth: viewerRequest!.maxWidth,
          maxHeight: viewerRequest!.maxHeight,
          maxFps: viewerRequest!.maxFps,
          degradationPreference: viewerRequest!.degradationPreference,
        }
      : null,
    effective: {
      videoBitrateKbps: bitrate,
      maxWidth: outputWidth,
      maxHeight: outputHeight,
      maxFps: fps,
      degradationPreference: degradation,
    },
    clampReasons: reasons,
  };
}
