/**
 * Codec capability detection using the standardized
 * RTCRtpSender/RTCRtpReceiver.getCapabilities() API.
 *
 * These replace the older MediaCapabilities-based detection which required
 * async encodingInfo queries with magic dimensions.
 */

export function getSenderVideoCapabilities(): RTCRtpCodec[] | null {
  try {
    return RTCRtpSender.getCapabilities("video")?.codecs ?? null;
  } catch {
    return null;
  }
}

export function getReceiverVideoCapabilities(): RTCRtpCodec[] | null {
  try {
    return RTCRtpReceiver.getCapabilities("video")?.codecs ?? null;
  } catch {
    return null;
  }
}

export function getCommonVideoCodecCapabilities(): RTCRtpCodec[] {
  const sender = getSenderVideoCapabilities();
  if (!sender) return [];

  // Filter to our supported codecs
  const codecs = sender.filter(c => {
    const name = c.mimeType?.toUpperCase().replace("VIDEO/", "");
    return name === "VP9" || name === "H264" || name === "VP8" || name === "AV1";
  });

  // Reorder: VP9 -> AV1 -> H264 -> VP8
  const order = ["VP9", "AV1", "H264", "VP8"];
  return [...codecs].sort((a, b) => {
    const aName = a.mimeType?.toUpperCase().replace("VIDEO/", "") ?? "";
    const bName = b.mimeType?.toUpperCase().replace("VIDEO/", "") ?? "";
    return order.indexOf(aName) - order.indexOf(bName);
  });
}

export function applyCodecPreferences(
  transceiver: RTCRtpTransceiver,
  requestedCodec: string,
): { selected: string; fallbackReason?: string } {
  const capabilities = getSenderVideoCapabilities();
  if (!capabilities) return { selected: "unknown" };

  // If "auto", use the auto order
  if (requestedCodec === "auto") {
    const preferred = getCommonVideoCodecCapabilities();
    try {
      transceiver.setCodecPreferences(preferred);
    } catch {
      // Browser may reject empty array
    }
    return { selected: preferred[0]?.mimeType ?? "unknown" };
  }

  // Find the requested codec
  const target = capabilities.find(
    c => c.mimeType?.toUpperCase().includes(requestedCodec.toUpperCase()),
  );
  if (target) {
    try {
      transceiver.setCodecPreferences([target]);
    } catch {
      // Browser may reject empty array
    }
    return { selected: target.mimeType ?? "unknown" };
  }

  // Fallback to auto if requested codec not available
  const preferred = getCommonVideoCodecCapabilities();
  try {
    transceiver.setCodecPreferences(preferred);
  } catch {
    // Browser may reject empty array
  }
  return {
    selected: preferred[0]?.mimeType ?? "unknown",
    fallbackReason: `${requestedCodec} unavailable, fell back to auto`,
  };
}
