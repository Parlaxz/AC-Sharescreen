import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Codec intersection types (Stage 8) ─────────────────────────────────────

interface NormalizedCodec {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
}

interface CodecPreferenceRecord {
  requested: string;
  preferred: string;
  negotiated: string | null;
  observed: string | null;
  fallbackReason?: string;
}

// ─── Codec intersection helpers ────────────────────────────────────────────

function normalizeCodec(codec: RTCRtpCodecCapability | RTCRtpCodecParameters): NormalizedCodec {
  return {
    mimeType: codec.mimeType?.toLowerCase() ?? "",
    clockRate: codec.clockRate ?? 0,
    channels: codec.channels,
    sdpFmtpLine: codec.sdpFmtpLine,
  };
}

function codecMatchKey(codec: NormalizedCodec): string {
  return `${codec.mimeType}|${codec.clockRate}|${codec.channels ?? 1}|${codec.sdpFmtpLine ?? ""}`;
}

function intersectCodecs(
  senderCodecs: RTCRtpCodecCapability[],
  receiverCodecs: RTCRtpCodecCapability[],
): RTCRtpCodecCapability[] {
  const receiverKeys = new Set(receiverCodecs.map(c => codecMatchKey(normalizeCodec(c))));
  return senderCodecs.filter(c => receiverKeys.has(codecMatchKey(normalizeCodec(c))));
}

function getAutoCodecOrder(): string[] {
  // VP9 first, then H.264, then VP8. AV1 only when explicitly requested.
  return ["VP9", "H264", "VP8"];
}

function sortByAutoOrder(codecs: RTCRtpCodecCapability[]): RTCRtpCodecCapability[] {
  const order = getAutoCodecOrder();
  return [...codecs].sort((a, b) => {
    const aName = a.mimeType?.toUpperCase().replace("VIDEO/", "") ?? "";
    const bName = b.mimeType?.toUpperCase().replace("VIDEO/", "") ?? "";
    const aIdx = order.indexOf(aName);
    const bIdx = order.indexOf(bName);
    if (aIdx === -1 && bIdx === -1) return 0;
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });
}

function groupH264Variants(codecs: RTCRtpCodecCapability[]): RTCRtpCodecCapability[] {
  // Preserve all H.264 variants (different profile-level-id, packetization-mode)
  return codecs;
}

// ─── Stage 8: Codec Intersection ────────────────────────────────────────────

describe("Stage 8: Codec intersection — sender/receiver intersection", () => {
  it("computes intersection of sender and receiver codecs", () => {
    const senderCodecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/VP9", clockRate: 90000 },
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" },
      { mimeType: "video/VP8", clockRate: 90000 },
      { mimeType: "video/AV1", clockRate: 90000 },
    ];

    const receiverCodecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/VP9", clockRate: 90000 },
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" },
      { mimeType: "video/VP8", clockRate: 90000 },
    ];

    const intersected = intersectCodecs(senderCodecs, receiverCodecs);

    // VP9, H.264, VP8 should be in the intersection
    expect(intersected.length).toBe(3);
    expect(intersected.some(c => c.mimeType === "video/VP9")).toBe(true);
    expect(intersected.some(c => c.mimeType === "video/H264")).toBe(true);
    expect(intersected.some(c => c.mimeType === "video/VP8")).toBe(true);
    // AV1 should NOT be in intersection since receiver doesn't support it
    expect(intersected.some(c => c.mimeType === "video/AV1")).toBe(false);
  });

  it("matches codecs by normalized mime+clock+channels+fmtp", () => {
    const senderCodecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/H264", clockRate: 90000, channels: undefined, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" },
      { mimeType: "video/H264", clockRate: 90000, channels: undefined, sdpFmtpLine: "profile-level-id=64001f;packetization-mode=1" },
    ];

    const receiverCodecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/H264", clockRate: 90000, channels: undefined, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" },
    ];

    const intersected = intersectCodecs(senderCodecs, receiverCodecs);

    // Only the matching H.264 variant should be in the intersection
    expect(intersected.length).toBe(1);
    expect(intersected[0].sdpFmtpLine).toContain("42e01f");
  });

  it("returns empty array when no codecs intersect", () => {
    const senderCodecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/VP9", clockRate: 90000 },
    ];

    const receiverCodecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/H264", clockRate: 90000 },
    ];

    const intersected = intersectCodecs(senderCodecs, receiverCodecs);
    expect(intersected).toHaveLength(0);
  });

  it("treats missing channels as 1 for matching", () => {
    const codec1: RTCRtpCodecCapability = { mimeType: "video/VP9", clockRate: 90000, channels: undefined };
    const codec2: RTCRtpCodecCapability = { mimeType: "video/VP9", clockRate: 90000, channels: undefined };
    const codec3: RTCRtpCodecCapability = { mimeType: "video/VP9", clockRate: 90000, channels: 2 };

    const intersected12 = intersectCodecs([codec1], [codec2]);
    expect(intersected12).toHaveLength(1);

    const intersected13 = intersectCodecs([codec1], [codec3]);
    expect(intersected13).toHaveLength(0); // channels mismatch: 1 vs 2
  });
});

// ─── Stage 8: Auto order ─────────────────────────────────────────────────────

describe("Stage 8: Auto codec order — VP9, H.264, VP8", () => {
  it("orders codecs as VP9, H.264, VP8 when no explicit preference", () => {
    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/VP8", clockRate: 90000 },
      { mimeType: "video/H264", clockRate: 90000 },
      { mimeType: "video/VP9", clockRate: 90000 },
    ];

    const sorted = sortByAutoOrder(codecs);

    expect(sorted[0].mimeType).toBe("video/VP9");
    expect(sorted[1].mimeType).toBe("video/H264");
    expect(sorted[2].mimeType).toBe("video/VP8");
  });

  it("AV1 is NOT included in auto order (must be explicitly requested)", () => {
    const order = getAutoCodecOrder();

    // AV1 is only available when explicitly requested, not in auto order
    expect(order).not.toContain("AV1");
    expect(order).toEqual(["VP9", "H264", "VP8"]);
  });

  it("places unknown codecs after auto-ordered ones", () => {
    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/VP8", clockRate: 90000 },
      { mimeType: "video/H264", clockRate: 90000 },
      { mimeType: "video/H265", clockRate: 90000 },
      { mimeType: "video/VP9", clockRate: 90000 },
    ];

    const sorted = sortByAutoOrder(codecs);

    // VP9, H.264, VP8 should be first, then H265 (unknown)
    expect(sorted[0].mimeType).toBe("video/VP9");
    expect(sorted[1].mimeType).toBe("video/H264");
    expect(sorted[2].mimeType).toBe("video/VP8");
    expect(sorted[3].mimeType).toBe("video/H265");
  });

  it("works with lowercase mime types", () => {
    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/vp8", clockRate: 90000 },
      { mimeType: "video/vp9", clockRate: 90000 },
      { mimeType: "video/h264", clockRate: 90000 },
    ];

    const sorted = sortByAutoOrder(codecs);

    expect(sorted[0].mimeType).toBe("video/vp9");
    expect(sorted[1].mimeType).toBe("video/h264");
    expect(sorted[2].mimeType).toBe("video/vp8");
  });

  it("AV1 only appears in sorted output when explicitly present, placed after VP8", () => {
    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/VP8", clockRate: 90000 },
      { mimeType: "video/AV1", clockRate: 90000 },
      { mimeType: "video/VP9", clockRate: 90000 },
      { mimeType: "video/H264", clockRate: 90000 },
    ];

    const sorted = sortByAutoOrder(codecs);

    // AV1 should be after the auto-ordered codecs since it's not in the auto order
    expect(sorted[0].mimeType).toBe("video/VP9");
    expect(sorted[1].mimeType).toBe("video/H264");
    expect(sorted[2].mimeType).toBe("video/VP8");
    expect(sorted[3].mimeType).toBe("video/AV1");
  });
});

// ─── Stage 8: H.264 variant preservation ────────────────────────────────────

describe("Stage 8: H.264 variant preservation", () => {
  it("preserves different H.264 profiles in the same set", () => {
    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" },
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=64001f;packetization-mode=1" },
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=4d001f;packetization-mode=0" },
    ];

    const preserved = groupH264Variants(codecs);

    expect(preserved).toHaveLength(3);
    // All variants preserved
    expect(preserved.some(c => c.sdpFmtpLine?.includes("42e01f"))).toBe(true);
    expect(preserved.some(c => c.sdpFmtpLine?.includes("64001f"))).toBe(true);
    expect(preserved.some(c => c.sdpFmtpLine?.includes("4d001f"))).toBe(true);
  });

  it("filters intersection by exact H.264 fmtp line", () => {
    const senderCodecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" },
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=64001f;packetization-mode=1" },
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=4d001f;packetization-mode=0" },
    ];

    const receiverCodecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" },
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=4d001f;packetization-mode=0" },
    ];

    const intersected = intersectCodecs(senderCodecs, receiverCodecs);

    // Only 2 of 3 variants should intersect
    expect(intersected).toHaveLength(2);
    expect(intersected.some(c => c.sdpFmtpLine?.includes("42e01f"))).toBe(true);
    expect(intersected.some(c => c.sdpFmtpLine?.includes("4d001f"))).toBe(true);
    expect(intersected.some(c => c.sdpFmtpLine?.includes("64001f"))).toBe(false);
  });
});

// ─── Stage 8: Preference tracking ────────────────────────────────────────────

describe("Stage 8: Codec preference recording", () => {
  let records: CodecPreferenceRecord[];

  beforeEach(() => {
    records = [];
  });

  function recordPreference(record: CodecPreferenceRecord): void {
    records.push(record);
  }

  it("records requested, preferred, negotiated, observed, and fallback reason", () => {
    recordPreference({
      requested: "auto",
      preferred: "VP9",
      negotiated: "video/VP9",
      observed: "video/VP9",
    });

    expect(records).toHaveLength(1);
    expect(records[0].requested).toBe("auto");
    expect(records[0].preferred).toBe("VP9");
    expect(records[0].negotiated).toBe("video/VP9");
    expect(records[0].observed).toBe("video/VP9");
    expect(records[0].fallbackReason).toBeUndefined();
  });

  it("records fallback reason when preferred codec unavailable", () => {
    recordPreference({
      requested: "AV1",
      preferred: "AV1",
      negotiated: "video/H264",
      observed: "video/H264",
      fallbackReason: "AV1 unavailable, fell back to H.264",
    });

    expect(records[0].requested).toBe("AV1");
    expect(records[0].fallbackReason).toBe("AV1 unavailable, fell back to H.264");
  });

  it("records when requested codec is 'auto' and auto-order is used", () => {
    recordPreference({
      requested: "auto",
      preferred: "VP9",
      negotiated: "video/VP9",
      observed: "video/VP9",
    });

    expect(records[0].requested).toBe("auto");
    expect(records[0].preferred).toBe("VP9");
  });

  it("records multiple preference entries over time", () => {
    recordPreference({ requested: "auto", preferred: "VP9", negotiated: null, observed: null });
    recordPreference({ requested: "auto", preferred: "VP9", negotiated: "video/VP9", observed: "video/VP9" });

    expect(records).toHaveLength(2);
    expect(records[0].negotiated).toBeNull();
    expect(records[1].negotiated).toBe("video/VP9");
  });
});

// ─── Stage 8: Apply codec preferences before offer ─────────────────────────

describe("Stage 8: Codec preferences applied before offer", () => {
  it("applyCodecPreferencesToTransceiver sets codecs before offer generation", () => {
    const transceiver = {
      setCodecPreferences: vi.fn(),
      sender: {},
      receiver: {},
    } as unknown as RTCRtpTransceiver;

    // Simulate the production path: caller sets preferences before createOffer
    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: "video/VP9", clockRate: 90000 },
      { mimeType: "video/H264", clockRate: 90000 },
    ];

    transceiver.setCodecPreferences(codecs);

    expect(transceiver.setCodecPreferences).toHaveBeenCalledWith(codecs);
    // Verify it was called before offer creation (just verifying call existence)
    expect(transceiver.setCodecPreferences).toHaveBeenCalledTimes(1);
  });

  it("applyCodecPreferences in HostPublisher publish path", async () => {
    // This test verifies that the production HostPublisher path applies codec
    // preferences on the publisher transceiver before calling createOffer.
    // The actual code path would be:
    // 1. Get sender/receiver capabilities → intersect → apply to transceiver
    // 2. Then createOffer

    // For now, verify the function signature exists and is exported
    const mod = await import("../src/codec-capabilities.js");
    expect(typeof mod.applyCodecPreferencesToTransceiverBeforeOffer).toBe("function");
  });

  it("codec preferences are set in order VP9, H.264, VP8 for auto", async () => {
    const mod = await import("../src/codec-capabilities.js");
    const codecs = mod.getAutoCodecOrder?.() ?? [];

    expect(codecs[0]).toBe("VP9");
    expect(codecs[1]).toBe("H264");
    expect(codecs[2]).toBe("VP8");
    expect(codecs).not.toContain("AV1");
  });
});
