import {
  type GroupQualitySettings,
  type HostQualityLimits,
  type ViewerQualityRequest,
  RANGES,
} from "@screenlink/shared";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EffectiveQuality {
  requested: Partial<ViewerQualityRequest> | null;
  effective: {
    videoBitrateKbps: number;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    degradationPreference: string;
  };
  configured: {
    // what was actually applied to the sender
    maxBitrate: number;
    maxFramerate: number;
    scaleResolutionDownBy: number;
    degradationPreference: string;
    priority: string;
  } | null;
  clampReasons: string[];
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ─── QualityCoordinator ─────────────────────────────────────────────────────

export class QualityCoordinator {
  /**
   * Calculate effective quality for a viewer by combining group defaults,
   * the viewer's request (if any), schema ranges, host limits, and source
   * dimensions.
   */
  calculateEffectiveQuality(
    groupSettings: GroupQualitySettings,
    hostLimits: HostQualityLimits,
    viewerRequest: ViewerQualityRequest | null,
    sourceDimensions: { width: number; height: number },
  ): EffectiveQuality {
    // 1. Start from group defaults for viewer-requestable fields
    let bitrate = groupSettings.video.videoBitrateKbps;
    let width = groupSettings.video.sendWidth;
    let height = groupSettings.video.sendHeight;
    let fps = groupSettings.video.sendFps;
    let degradation = groupSettings.video.degradationPreference;
    const reasons: string[] = [];

    // 2. If viewer request exists, use those values (they may exceed defaults)
    if (viewerRequest) {
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

    // 6. Apply scaleResolutionDownBy
    const scale = groupSettings.video.scaleResolutionDownBy;
    const scaleWidth = Math.round(width / scale);
    const scaleHeight = Math.round(height / scale);

    return {
      requested: viewerRequest
        ? {
            videoBitrateKbps: viewerRequest.videoBitrateKbps,
            maxWidth: viewerRequest.maxWidth,
            maxHeight: viewerRequest.maxHeight,
            maxFps: viewerRequest.maxFps,
            degradationPreference: viewerRequest.degradationPreference,
          }
        : null,
      effective: {
        videoBitrateKbps: bitrate,
        maxWidth: scaleWidth,
        maxHeight: scaleHeight,
        maxFps: fps,
        degradationPreference: degradation,
      },
      configured: null, // filled in after sender application
      clampReasons: reasons,
    };
  }

  /**
   * Apply effective quality to an RTCRtpSender by setting encoding parameters.
   * Returns the read-back configured values.
   */
  async applyToSender(
    sender: RTCRtpSender,
    effective: EffectiveQuality["effective"],
  ): Promise<EffectiveQuality["configured"]> {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const enc = params.encodings[0]!;
    enc.maxBitrate = effective.videoBitrateKbps * 1000;
    enc.maxFramerate = effective.maxFps;
    enc.scaleResolutionDownBy =
      effective.maxWidth > 0 && effective.maxHeight > 0
        ? effective.maxWidth / effective.maxWidth
        : 1;
    enc.degradationPreference = effective.degradationPreference;
    // Set priority
    enc.priority = "medium";

    await sender.setParameters(params);

    // Read back
    const readback = sender.getParameters();
    return {
      maxBitrate: readback.encodings?.[0]?.maxBitrate ?? 0,
      maxFramerate: readback.encodings?.[0]?.maxFramerate ?? 0,
      scaleResolutionDownBy: 1,
      degradationPreference: effective.degradationPreference,
      priority: "medium",
    };
  }
}
