import type { RTCRtpCodecCapabilityLike } from "./sdk-types.js";

// ─── Codec Preference Record ────────────────────────────────────────────────
// Stage 8: Record requested/preferred/negotiated/observed/fallback reason.

export interface CodecPreferenceRecord {
  requested: string;
  preferred: string;
  negotiated: string | null;
  observed: string | null;
  fallbackReason?: string;
}

// ─── Codec helpers ──────────────────────────────────────────────────────────

function normalizeCodecName(mimeType: string): string {
  return mimeType.toUpperCase().replace("VIDEO/", "");
}

/**
 * Get the auto codec order for codec preference sorting.
 * Stage 8: Order is exactly VP9, H.264, VP8.
 * AV1 is NOT included — it must be explicitly requested.
 */
export function getAutoCodecOrder(): string[] {
  return ["VP9", "H264", "VP8"];
}

// ─── Capability detection ───────────────────────────────────────────────────

export function getSenderVideoCapabilities(): RTCRtpCodecCapabilityLike[] | null {
  try {
    return RTCRtpSender.getCapabilities("video")?.codecs ?? null;
  } catch {
    return null;
  }
}

export function getReceiverVideoCapabilities(): RTCRtpCodecCapabilityLike[] | null {
  try {
    return RTCRtpReceiver.getCapabilities("video")?.codecs ?? null;
  } catch {
    return null;
  }
}

// ─── Stage 8: Codec intersection ───────────────────────────────────────────

/**
 * Normalized match key for codec comparison.
 * Uses mimeType (lowercase), clockRate, channels (default 1), and sdpFmtpLine.
 */
function codecMatchKey(codec: RTCRtpCodecCapabilityLike): string {
  const mime = codec.mimeType?.toLowerCase() ?? "";
  const clock = codec.clockRate ?? 0;
  const channels = codec.channels ?? 1;
  const fmtp = codec.sdpFmtpLine ?? "";
  return `${mime}|${clock}|${channels}|${fmtp}`;
}

function toTransceiverCodec(codec: RTCRtpCodecCapabilityLike): RTCRtpCodec {
  return {
    mimeType: codec.mimeType,
    clockRate: codec.clockRate ?? 0,
    channels: codec.channels,
    sdpFmtpLine: codec.sdpFmtpLine,
  };
}

/**
 * Compute the intersection of sender and receiver codec capabilities
 * using normalized mime/clock/channels/fmtp matching.
 * Stage 8: True sender/receiver codec intersection that preserves H.264
 * variants (profile-level-id, packetization-mode).
 */
export function intersectSenderAndReceiverCodecs(
  senderCodecs: RTCRtpCodecCapabilityLike[],
  receiverCodecs: RTCRtpCodecCapabilityLike[],
): RTCRtpCodecCapabilityLike[] {
  const receiverKeys = new Set<string>();
  for (const c of receiverCodecs) {
    receiverKeys.add(codecMatchKey(c));
  }
  return senderCodecs.filter(c => receiverKeys.has(codecMatchKey(c)));
}

/**
 * Get common video codec capabilities between sender and receiver,
 * with auto order applied (VP9, H.264, VP8).
 * Stage 8: Uses true intersection, not just sender filtering.
 */
export function getCommonVideoCodecCapabilities(): RTCRtpCodecCapabilityLike[] {
  const sender = getSenderVideoCapabilities();
  const receiver = getReceiverVideoCapabilities();
  if (!sender || !receiver) return [];

  // Filter to our supported codecs
  const supportedNames = new Set(["VP9", "H264", "VP8", "AV1"]);

  // Intersect sender and receiver using normalized matching
  const intersected = intersectSenderAndReceiverCodecs(sender, receiver);

  // Filter to only supported codecs
  const codecs = intersected.filter(c => {
    const name = normalizeCodecName(c.mimeType ?? "");
    return supportedNames.has(name);
  });

  // Reorder: VP9 -> H.264 -> VP8 (auto order)
  // AV1 is included only if present but will be placed after auto-ordered codecs
  const order = getAutoCodecOrder();
  return [...codecs].sort((a, b) => {
    const aName = normalizeCodecName(a.mimeType ?? "");
    const bName = normalizeCodecName(b.mimeType ?? "");
    const aIdx = order.indexOf(aName);
    const bIdx = order.indexOf(bName);
    if (aIdx === -1 && bIdx === -1) return 0;
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });
}

// ─── Stage 8: Apply codec preferences before offer ──────────────────────────

/**
 * Apply codec preferences to a transceiver before offer generation.
 * Stage 8: Uses the full negotiation pipeline:
 *   1. Compute sender/receiver intersection
 *   2. Apply auto order (VP9, H.264, VP8) or explicit codec
 *   3. Set on transceiver before createOffer
 *
 * Returns a CodecPreferenceRecord documenting what was requested, preferred,
 * negotiated, and any fallback reason.
 */
export function applyCodecPreferencesToTransceiverBeforeOffer(
  transceiver: RTCRtpTransceiver,
  requestedCodec: string,
): CodecPreferenceRecord {
  const capabilities = getSenderVideoCapabilities();
  if (!capabilities) return { requested: requestedCodec, preferred: "unknown", negotiated: null, observed: null, fallbackReason: "No sender capabilities" };

  const receiverCapabilities = getReceiverVideoCapabilities();
  let targetCodecs: RTCRtpCodecCapabilityLike[];

  // Compute intersection if we have receiver capabilities
  if (receiverCapabilities) {
    targetCodecs = intersectSenderAndReceiverCodecs(capabilities, receiverCapabilities);
  } else {
    targetCodecs = capabilities;
  }

  // Filter to supported codecs
  const supportedNames = new Set(["VP9", "H264", "VP8", "AV1"]);
  targetCodecs = targetCodecs.filter(c => {
    const name = normalizeCodecName(c.mimeType ?? "");
    return supportedNames.has(name);
  });

  let fallbackReason: string | undefined;
  let preferred: string;

  if (requestedCodec === "auto") {
    // Use auto order: VP9, H.264, VP8
    const order = getAutoCodecOrder();
    targetCodecs = [...targetCodecs].sort((a, b) => {
      const aName = normalizeCodecName(a.mimeType ?? "");
      const bName = normalizeCodecName(b.mimeType ?? "");
      const aIdx = order.indexOf(aName);
      const bIdx = order.indexOf(bName);
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
    preferred = targetCodecs[0]?.mimeType ?? "unknown";
  } else {
    // Explicit codec requested: find matching codecs
    const explicitName = requestedCodec.toUpperCase();
    const matching = targetCodecs.filter(c => normalizeCodecName(c.mimeType ?? "") === explicitName);

    if (matching.length > 0) {
      // Requested codec available — prefer it
      targetCodecs = matching;
      preferred = targetCodecs[0]!.mimeType;
    } else {
      // Fallback to auto order
      const order = getAutoCodecOrder();
      targetCodecs = [...targetCodecs].sort((a, b) => {
        const aName = normalizeCodecName(a.mimeType ?? "");
        const bName = normalizeCodecName(b.mimeType ?? "");
        const aIdx = order.indexOf(aName);
        const bIdx = order.indexOf(bName);
        if (aIdx === -1 && bIdx === -1) return 0;
        if (aIdx === -1) return 1;
        if (bIdx === -1) return -1;
        return aIdx - bIdx;
      });
      preferred = targetCodecs[0]?.mimeType ?? "unknown";
      fallbackReason = `${requestedCodec} unavailable, fell back to auto`;
    }
  }

  // Apply to transceiver
  if (targetCodecs.length > 0) {
    try {
      transceiver.setCodecPreferences(targetCodecs.map(toTransceiverCodec));
    } catch {
      // Browser may reject empty array or invalid codec list
    }
  }

  return {
    requested: requestedCodec,
    preferred: normalizeCodecName(preferred),
    negotiated: targetCodecs[0]?.mimeType ?? null,
    observed: null, // not observed from stats — set by viewer-side evidence
    fallbackReason,
  };
}

/**
 * Apply codec preferences to a transceiver.
 * Legacy API — Stage 8 codebase uses applyCodecPreferencesToTransceiverBeforeOffer
 * for the full negotiation pipeline.
 */
export function applyCodecPreferences(
  transceiver: RTCRtpTransceiver,
  requestedCodec: string,
): { selected: string; fallbackReason?: string } {
  const result = applyCodecPreferencesToTransceiverBeforeOffer(transceiver, requestedCodec);
  return {
    selected: result.negotiated ?? "unknown",
    fallbackReason: result.fallbackReason,
  };
}
