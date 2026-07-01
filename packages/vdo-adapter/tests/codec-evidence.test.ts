// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import type { InboundRtpCodecEvidence } from "../src/media-stats.js";

// ─── Fake RTCStatsReport builder ──────────────────────────────────────────

function fakeCodecStat(
  id: string,
  mimeType: string,
  payloadType: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "codec",
    mimeType,
    payloadType,
    clockRate: 90000,
    sdpFmtpLine: null,
    ...overrides,
  };
}

function fakeInboundRtp(
  id: string,
  kind: string,
  codecId: string,
  ssrc: number,
  bytesReceived: number,
  packetsReceived: number,
  framesDecoded: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "inbound-rtp",
    kind,
    codecId,
    ssrc,
    bytesReceived,
    packetsReceived,
    framesDecoded,
    jitter: 1.5,
    packetsLost: 0,
    ...overrides,
  };
}

function makeReport(
  entries: Record<string, unknown>[],
): RTCStatsReport {
  const map = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    map.set(e.id as string, e);
  }
  return {
    forEach: (cb: (stat: Record<string, unknown>) => void) => {
      map.forEach((v) => cb(v));
    },
    get: (id: string) => map.get(id) ?? null,
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    size: map.size,
  } as unknown as RTCStatsReport;
}

function makeMap(entries: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    map.set(e.id as string, e);
  }
  return map;
}

// ─── Import the real module ───────────────────────────────────────────────

let resolveActiveCodecFromStats: typeof import("../src/media-stats.js")["resolveActiveCodecFromStats"];
let collectCodecEvidence: typeof import("../src/media-stats.js")["collectCodecEvidence"];

async function loadModule() {
  const mod = await import("../src/media-stats.js");
  resolveActiveCodecFromStats = mod.resolveActiveCodecFromStats;
  collectCodecEvidence = mod.collectCodecEvidence;
}

// ─── Tests: Collect Codec Evidence ────────────────────────────────────────

describe("collectCodecEvidence", () => {
  beforeAll(async () => {
    await loadModule();
  });

  it("returns null when no video inbound-rtp entries exist", () => {
    const report = makeReport([
      fakeInboundRtp("audio-1", "audio", "codec-1", 1001, 5000, 100, 0),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const result = collectCodecEvidence(report, codecs, new Map());
    expect(result.evidence).toBeNull();
  });

  it("returns collecting-evidence when no previous sample exists", () => {
    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-1", 2001, 10000, 200, 50),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, new Map());
    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("collecting-evidence");
    expect(ev!.mimeType).toBe("video/VP9");
    expect(ev!.payloadType).toBe(100);
    expect(ev!.codecId).toBe("codec-1");
    expect(ev!.rtpStatsId).toBe("rtp-1");
    expect(ev!.ssrc).toBe(2001);
  });

  it("returns verified-decoding when bytes and frames advanced", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-1", 2001, 15000, 300, 75),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("verified-decoding");
    expect(ev!.mimeType).toBe("video/VP9");
    expect(ev!.deltaBytesReceived).toBe(5000);
    expect(ev!.deltaFramesDecoded).toBe(25);
  });

  it("returns verified-receiving when bytes advanced but no framesDecoded change", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-1", 2001, 15000, 300, 50),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("verified-receiving");
    expect(ev!.deltaFramesDecoded).toBe(0);
  });

  it("returns not-verified when bytes did not increase", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 15000,
      packetsReceived: 300,
      framesDecoded: 75,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-1", 2001, 15000, 300, 75),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("not-verified");
  });

  it("resolves AV1 through codecId", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-av1", 2001, 15000, 300, 75),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-av1", "video/AV1", 101),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.mimeType).toBe("video/AV1");
    expect(ev!.verificationState).toBe("verified-decoding");
  });

  it("resolves VP9 through codecId", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 5000,
      packetsReceived: 100,
      framesDecoded: 25,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-1", 2002, 10000, 200, 50),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.mimeType).toBe("video/VP9");
    expect(ev!.payloadType).toBe(100);
    expect(ev!.verificationState).toBe("verified-decoding");
  });

  it("produces Unknown when codecId is missing", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "", 2001, 15000, 300, 75),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, new Map(), previous);
    expect(ev).not.toBeNull();
    expect(ev!.mimeType).toBeNull();
    // Frames ARE being decoded (from inbound-rtp), so verified-decoding
    // The codec is just unknown because codecId is missing/unresolvable
    expect(ev!.verificationState).toBe("verified-decoding");
  });

  it("falls back to the first active stream when no active codec record resolves", () => {
    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "", 2001, 15000, 300, 75),
    ]);

    const { evidence: ev } = collectCodecEvidence(report, new Map(), new Map());

    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("collecting-evidence");
    expect(ev!.mimeType).toBeNull();
    expect(ev!.codecId).toBe("");
    expect(ev!.rtpStatsId).toBe("rtp-1");
  });

  it("handles kind fallback: mediaType=video", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      {
        id: "rtp-1",
        type: "inbound-rtp",
        kind: "",
        mediaType: "video",
        codecId: "codec-1",
        ssrc: 2001,
        bytesReceived: 15000,
        packetsReceived: 300,
        framesDecoded: 75,
        jitter: 1.0,
        packetsLost: 0,
      },
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("verified-decoding");
    expect(ev!.mimeType).toBe("video/VP9");
  });

  it("does not select repair/auxiliary codecs (rtx, red, fec)", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-repair", 2001, 15000, 300, 75),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-repair", "video/rtx", 102),
      fakeCodecStat("codec-red", "video/red", 103),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.mimeType).toBeNull();
    // Frames ARE being decoded (from inbound-rtp), but the codec is unknown
    // because the inbound-rtp.codecId points to a repair/auxiliary codec
    expect(ev!.verificationState).toBe("verified-decoding");
  });

  it("shuffling generic codec-record order does not change result", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const inhoud = fakeInboundRtp("rtp-1", "video", "codec-vp9", 2001, 15000, 300, 75);

    // Codec records in reverse order
    const report1 = makeReport([inhoud]);
    const codecs1 = makeMap([
      fakeCodecStat("codec-h264", "video/H264", 101),
      fakeCodecStat("codec-vp9", "video/VP9", 100),
    ]);

    const { evidence: ev1 } = collectCodecEvidence(report1, codecs1, previous);
    expect(ev1!.mimeType).toBe("video/VP9");

    // Same but codec records in different order
    const report2 = makeReport([inhoud]);
    const codecs2 = makeMap([
      fakeCodecStat("codec-vp9", "video/VP9", 100),
      fakeCodecStat("codec-h264", "video/H264", 101),
    ]);

    const { evidence: ev2 } = collectCodecEvidence(report2, codecs2, previous);
    expect(ev2!.mimeType).toBe("video/VP9");
  });

  it("includes sdpFmtpLine, decoderImplementation, powerEfficientDecoder when present", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-1", 2001, 15000, 300, 75),
    ]);
    const codecs = makeMap([
      {
        id: "codec-1",
        type: "codec",
        mimeType: "video/H264",
        payloadType: 102,
        clockRate: 90000,
        sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1",
        decoderImplementation: "FFmpeg",
        powerEfficientDecoder: true,
      },
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.mimeType).toBe("video/H264");
    expect(ev!.sdpFmtpLine).toBe("profile-level-id=42e01f;packetization-mode=1");
    expect(ev!.decoderImplementation).toBe("FFmpeg");
    expect(ev!.powerEfficientDecoder).toBe(true);
  });
});

// ─── Tests: Multiple active RTP streams ───────────────────────────────────

describe("collectCodecEvidence — multiple active streams", () => {
  beforeAll(async () => {
    await loadModule();
  });

  it("returns multiple-active-codecs when active streams resolve to different codecs", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });
    previous.set("rtp-2", {
      rtpStatsId: "rtp-2",
      bytesReceived: 5000,
      packetsReceived: 100,
      framesDecoded: 20,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-vp9", 4001, 15000, 300, 75),
      fakeInboundRtp("rtp-2", "video", "codec-h264", 4002, 8000, 150, 30),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-vp9", "video/VP9", 100),
      fakeCodecStat("codec-h264", "video/H264", 102),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("multiple-active-codecs");
    expect(ev!.mimeType).toBeNull();
    expect(ev!.payloadType).toBeNull();
  });

  it("deduplicates same codec across multiple active RTP streams", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });
    previous.set("rtp-2", {
      rtpStatsId: "rtp-2",
      bytesReceived: 5000,
      packetsReceived: 100,
      framesDecoded: 20,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-vp9", 4001, 15000, 300, 75),
      fakeInboundRtp("rtp-2", "video", "codec-vp9", 4002, 8000, 150, 30),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-vp9", "video/VP9", 100),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("verified-decoding");
    expect(ev!.mimeType).toBe("video/VP9");
  });

  it("ignores stale RTP entries when another stream is active", () => {
    const previous = new Map();
    previous.set("rtp-stale", {
      rtpStatsId: "rtp-stale",
      bytesReceived: 99999,
      packetsReceived: 999,
      framesDecoded: 200,
      timestamp: 1000,
    });
    previous.set("rtp-active", {
      rtpStatsId: "rtp-active",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-stale", "video", "codec-other", 5001, 99999, 999, 200),
      fakeInboundRtp("rtp-active", "video", "codec-vp9", 5002, 15000, 300, 75),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-vp9", "video/VP9", 100),
      fakeCodecStat("codec-other", "video/H264", 102),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("verified-decoding");
    expect(ev!.mimeType).toBe("video/VP9");
  });

  it("multiple active streams with same codec and one unverifiable still resolves", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-vp9", 6001, 15000, 300, 75),
      // Second stream with no previous sample (collecting-evidence)
      fakeInboundRtp("rtp-2", "video", "codec-vp9", 6002, 5000, 100, 25),
    ]);
    const codecs = makeMap([
      fakeCodecStat("codec-vp9", "video/VP9", 100),
    ]);
    const { evidence: ev } = collectCodecEvidence(report, codecs, previous);
    // Both active streams resolve to VP9, so verified-decoding
    expect(ev).not.toBeNull();
    expect(ev!.verificationState).toBe("verified-decoding");
    expect(ev!.mimeType).toBe("video/VP9");
  });
});

// ─── Tests: resolveActiveCodecFromStats (high-level) ──────────────────────

describe("resolveActiveCodecFromStats", () => {
  beforeAll(async () => {
    await loadModule();
  });

  it("first polling interval returns collecting-evidence", () => {
    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-1", 7001, 10000, 200, 50),
    ]);
    const codecMap = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const { evidence, updatedSamples } = resolveActiveCodecFromStats(report, codecMap, new Map());
    expect(evidence).not.toBeNull();
    expect(evidence!.verificationState).toBe("collecting-evidence");
    expect(updatedSamples.has("rtp-1")).toBe(true);
  });

  it("second polling with increased bytes returns verified", () => {
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-1", 7001, 15500, 300, 72),
    ]);
    const codecMap = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const { evidence, updatedSamples } = resolveActiveCodecFromStats(report, codecMap, previous);
    expect(evidence).not.toBeNull();
    expect(evidence!.verificationState).toBe("verified-decoding");
    expect(evidence!.mimeType).toBe("video/VP9");
    expect(updatedSamples.get("rtp-1")!.bytesReceived).toBe(15500);
  });

  it("no video inbound-rtp returns null evidence", () => {
    const report = makeReport([
      {
        id: "candidate-1",
        type: "candidate-pair",
        selected: true,
        state: "succeeded",
      },
    ]);
    const { evidence } = resolveActiveCodecFromStats(report, new Map(), new Map());
    expect(evidence).toBeNull();
  });

  it("requested AV1 plus active VP9 displays mismatch info", () => {
    // This test validates the data shape — the actual "mismatch" label
    // lives in the UI component. We verify the evidence reports VP9.
    const previous = new Map();
    previous.set("rtp-1", {
      rtpStatsId: "rtp-1",
      bytesReceived: 10000,
      packetsReceived: 200,
      framesDecoded: 50,
      timestamp: 1000,
    });

    const report = makeReport([
      fakeInboundRtp("rtp-1", "video", "codec-1", 8001, 15000, 300, 75),
    ]);
    const codecMap = makeMap([
      fakeCodecStat("codec-1", "video/VP9", 100),
    ]);
    const { evidence } = resolveActiveCodecFromStats(report, codecMap, previous);
    expect(evidence).not.toBeNull();
    expect(evidence!.mimeType).toBe("video/VP9");
    // Requested=AV1, Active=VP9 → the UI will show Match: No
    const requestedCodec = "AV1";
    const normalizedActive = evidence!.mimeType?.toUpperCase().replace("VIDEO/", "") ?? "";
    const match = normalizedActive === requestedCodec.toUpperCase().replace("VIDEO/", "");
    expect(match).toBe(false);
  });
});
