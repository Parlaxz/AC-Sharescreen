import { computeScale } from "@screenlink/shared";

export type DegradationPreference = "maintain-resolution" | "maintain-framerate" | "balanced";

export interface QualityTarget {
  videoCeilingKbps: number;
  maxFps: number;
  targetWidth: number;
  targetHeight: number;
  degradationPreference: DegradationPreference;
  /** When true, reactivate the sender encoding. When false, deactivate. */
  active?: boolean;
}

export type QualityResult =
  | { scale: number; success: true; configuredBitrate: number }
  | { success: false; error: string; code: string };

export function readSenderParameters(sender: RTCRtpSender): RTCRtpSendParameters {
  return sender.getParameters();
}

export async function applyQualityToSender(
  sender: RTCRtpSender,
  target: QualityTarget,
): Promise<QualityResult> {
  let params: RTCRtpSendParameters;
  try {
    params = sender.getParameters();
  } catch {
    return { success: false, error: "GET_PARAMETERS_FAILED", code: "GET_PARAMETERS_FAILED" };
  }

  if (!Array.isArray(params.encodings) || params.encodings.length === 0) {
    return { success: false, error: "ENCODING_PARAMETERS_UNAVAILABLE", code: "ENCODING_PARAMETERS_UNAVAILABLE" };
  }

  const settings = sender.track?.getSettings();
  const scale = computeScale(
    settings?.width ?? 1920,
    settings?.height ?? 1080,
    target.targetWidth,
    target.targetHeight,
  );

  const encoding = params.encodings[0]!;
  encoding.maxBitrate = target.videoCeilingKbps * 1000;
  encoding.maxFramerate = target.maxFps;
  encoding.scaleResolutionDownBy = scale;
  // Active state: when explicitly provided, set it. Otherwise leave as-is.
  if (target.active !== undefined) {
    encoding.active = target.active;
  }
  params.degradationPreference = target.degradationPreference;

  try {
    await sender.setParameters(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `setParameters failed: ${message}`, code: "SET_PARAMETERS_FAILED" };
  }

  // Read back to verify
  let readback: RTCRtpSendParameters;
  try {
    readback = sender.getParameters();
  } catch {
    return { scale, success: true, configuredBitrate: target.videoCeilingKbps * 1000 };
  }

  const appliedBitrate = readback.encodings?.[0]?.maxBitrate;
  return { scale, success: true, configuredBitrate: appliedBitrate ?? target.videoCeilingKbps * 1000 };
}
