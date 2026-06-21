import { computeScale } from "@screenlink/shared";

export type DegradationPreference = "maintain-resolution" | "maintain-framerate" | "balanced";

export interface QualityTarget {
  videoCeilingKbps: number;
  maxFps: number;
  targetWidth: number;
  targetHeight: number;
  degradationPreference: DegradationPreference;
}

export function readSenderParameters(sender: RTCRtpSender): RTCRtpSendParameters {
  return sender.getParameters();
}

export function applyQualityToSender(
  sender: RTCRtpSender,
  target: QualityTarget,
): { scale: number; success: boolean } | { error: string } {
  const params = sender.getParameters();

  if (!Array.isArray(params.encodings) || params.encodings.length === 0) {
    return { error: "ENCODING_PARAMETERS_UNAVAILABLE" };
  }

  const settings = sender.track?.getSettings();
  const scale = computeScale(
    settings?.width ?? 1920,
    settings?.height ?? 1080,
    target.targetWidth,
    target.targetHeight,
  );

  const encoding = params.encodings[0]!;
  if (encoding) {
    encoding.maxBitrate = target.videoCeilingKbps * 1000;
    encoding.maxFramerate = target.maxFps;
    encoding.scaleResolutionDownBy = scale;
  }

  params.degradationPreference = target.degradationPreference;

  try {
    sender.setParameters(params).catch(() => {});
  } catch {
    return { error: "SET_PARAMETERS_FAILED" };
  }

  return { scale, success: true };
}
