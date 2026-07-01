export interface StatsSnapshot {
  outbound?: Record<string, unknown>;
  inbound?: Record<string, unknown>;
  remoteInbound?: Record<string, unknown>;
  candidatePair?: Record<string, unknown>;
  codec?: Record<string, unknown>;
}

// ─── Codec Evidence Types ─────────────────────────────────────────────────

export type CodecVerificationState =
  | "collecting-evidence"
  | "verified-decoding"
  | "verified-receiving"
  | "not-verified"
  | "multiple-active-codecs";

export interface InboundRtpCodecEvidence {
  verificationState: CodecVerificationState;
  mimeType: string | null;
  payloadType: number | null;
  codecId: string | null;
  rtpStatsId: string | null;
  ssrc: number | null;
  bytesReceived: number;
  deltaBytesReceived: number | null;
  packetsReceived: number;
  deltaPacketsReceived: number | null;
  framesDecoded: number;
  deltaFramesDecoded: number | null;
  sdpFmtpLine: string | null;
  decoderImplementation: string | null;
  powerEfficientDecoder: boolean | null;
  timestamp: number;
}

export interface PreviousSample {
  rtpStatsId: string;
  bytesReceived: number;
  packetsReceived: number;
  framesDecoded: number;
  timestamp: number;
}

// ─── Repair/auxiliary codec exclusion ─────────────────────────────────────
// These should never be selected as the active video codec.

const REPAIR_CODEC_PREFIXES = [
  "video/rtx",
  "video/red",
  "video/flexfec-03",
  "video/ulpfec",
];

function isRepairCodec(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return REPAIR_CODEC_PREFIXES.some(p => lower.startsWith(p));
}

// ─── Collect codec evidence from a single polling interval ────────────────

/**
 * Collect codec evidence from a single getStats() report.
 *
 * Resolution logic:
 * 1. Find all inbound-rtp entries where kind===video (or mediaType===video as fallback)
 * 2. For each, follow codecId → matching codec stats record
 * 3. Compare bytesReceived with previous sample (keyed by rtp stats id)
 * 4. Stream is active only when bytesReceived increased
 * 5. Exclude repair/auxiliary codec records (rtx, red, fec)
 * 6. If multiple active streams resolve to different codecs → multiple-active-codecs
 * 7. If no previous sample → collecting-evidence
 * 8. If bytes advanced + framesDecoded advanced → verified-decoding
 * 9. If bytes advanced but framesDecoded unchanged/unavailable → verified-receiving
 * 10. If no traffic increase → not-verified
 * 11. If codecId missing/unresolvable → mimeType null
 *
 * @param statsReport - Raw RTCStatsReport from pc.getStats()
 * @param codecMap - Prebuilt Map of codec id → codec stats record
 * @param previousSamples - Map of rtpStatsId → PreviousSample from prior poll
 * @returns Object with evidence and updatedSamples map for next poll
 */
export function collectCodecEvidence(
  statsReport: RTCStatsReport,
  codecMap: Map<string, Record<string, unknown>>,
  previousSamples: Map<string, PreviousSample>,
): { evidence: InboundRtpCodecEvidence | null; updatedSamples: Map<string, PreviousSample> } {
  const videoInboundEntries: Record<string, unknown>[] = [];
  const now = Date.now();

  // Phase 1: collect video inbound-rtp entries
  for (const stat of statsReport.values() as Iterable<Record<string, unknown>>) {
    if (stat.type === "inbound-rtp") {
      const kind = ((stat.kind as string) || (stat.mediaType as string) || "");
      if (kind === "video") {
        videoInboundEntries.push(stat);
      }
    }
  }

  if (videoInboundEntries.length === 0) return { evidence: null, updatedSamples: new Map() };

  // Phase 2: build codec resolution for each active stream
  const streamResults: StreamResult[] = [];
  const updatedSamples = new Map<string, PreviousSample>();

  for (const entry of videoInboundEntries) {
    const rtpId = entry.id as string;
    const ssrc = (entry.ssrc as number) ?? null;
    const bytesReceived = (entry.bytesReceived as number) ?? 0;
    const packetsReceived = (entry.packetsReceived as number) ?? 0;
    const framesDecoded = (entry.framesDecoded as number) ?? 0;
    const codecId = (entry.codecId as string) ?? null;

    // Look up codec record via codecId
    let codecRecord: Record<string, unknown> | null = null;
    if (codecId && codecMap.has(codecId)) {
      codecRecord = codecMap.get(codecId)!;
      // Exclude repair/auxiliary codecs
      if (codecRecord && isRepairCodec((codecRecord.mimeType as string) ?? "")) {
        codecRecord = null;
      }
    }

    // Compare with previous sample
    const prev = previousSamples.get(rtpId);
    const hasPrevious = prev !== undefined;
    const deltaBytes = hasPrevious ? bytesReceived - prev!.bytesReceived : null;
    const deltaPackets = hasPrevious ? packetsReceived - prev!.packetsReceived : null;
    const deltaFrames = hasPrevious ? framesDecoded - prev!.framesDecoded : null;
    const isActive = hasPrevious ? (deltaBytes! > 0) : true; // first sighting = potential

    // Save updated sample
    updatedSamples.set(rtpId, {
      rtpStatsId: rtpId,
      bytesReceived,
      packetsReceived,
      framesDecoded,
      timestamp: now,
    });

    streamResults.push({
      rtpStatsId: rtpId,
      ssrc,
      bytesReceived,
      packetsReceived,
      framesDecoded,
      codecId,
      codecRecord,
      deltaBytes,
      deltaPackets,
      deltaFrames,
      isActive: isActive && (deltaBytes === null || deltaBytes > 0),
      hasPrevious,
    });
  }

  // Phase 3: determine active streams
  const activeStreams = streamResults.filter(s => s.isActive);

  if (activeStreams.length === 0) {
    // All streams are stale — report from most recent
    const last = streamResults.reduce((a, b) =>
      (previousSamples.get(a.rtpStatsId)?.timestamp ?? 0) >
      (previousSamples.get(b.rtpStatsId)?.timestamp ?? 0) ? a : b
    );
    return { evidence: buildEvidence(last, "not-verified", now), updatedSamples };
  }

  // Phase 4: resolve codec MIME types for active streams
  const activeMimeTypes = new Set<string>();

  for (const s of activeStreams) {
    if (s.codecRecord) {
      const mime = s.codecRecord.mimeType as string;
      if (mime && !isRepairCodec(mime)) {
        activeMimeTypes.add(mime);
      }
    } else {
      // Unresolvable codecId produces null mimeType
      activeMimeTypes.add("");
    }
  }

  // Remove empty string placeholder (unresolvable)
  activeMimeTypes.delete("");

  // Phase 5: determine verification state
  if (activeMimeTypes.size > 1) {
    // Multiple different codecs active
    return { evidence: {
      verificationState: "multiple-active-codecs",
      mimeType: null,
      payloadType: null,
      codecId: null,
      rtpStatsId: null,
      ssrc: null,
      bytesReceived: 0,
      deltaBytesReceived: null,
      packetsReceived: 0,
      deltaPacketsReceived: null,
      framesDecoded: 0,
      deltaFramesDecoded: null,
      sdpFmtpLine: null,
      decoderImplementation: null,
      powerEfficientDecoder: null,
      timestamp: now,
    }, updatedSamples };
  }

  // Use first active stream with a resolvable codec, or first active stream
  const primary = activeStreams.find(s => s.codecRecord !== null);
  const fallbackPrimary = activeStreams[0];

  let selectedPrimary: StreamResult;
  if (primary) {
    selectedPrimary = primary;
  } else if (fallbackPrimary) {
    selectedPrimary = fallbackPrimary;
  } else {
    return { evidence: null, updatedSamples };
  }

  // Determine state
  let state: CodecVerificationState;
  if (!selectedPrimary.hasPrevious) {
    state = "collecting-evidence";
  } else if (selectedPrimary.deltaFrames !== null && selectedPrimary.deltaFrames > 0) {
    state = "verified-decoding";
  } else if (selectedPrimary.deltaBytes !== null && selectedPrimary.deltaBytes > 0) {
    state = "verified-receiving";
  } else {
    state = "not-verified";
  }

  return { evidence: buildEvidence(selectedPrimary, state, now), updatedSamples };
}

// ─── Helper type for stream results (internal) ───────────────────────────

type StreamResult = {
  rtpStatsId: string;
  ssrc: number | null;
  bytesReceived: number;
  packetsReceived: number;
  framesDecoded: number;
  codecId: string | null;
  codecRecord: Record<string, unknown> | null;
  deltaBytes: number | null;
  deltaPackets: number | null;
  deltaFrames: number | null;
  isActive: boolean;
  hasPrevious: boolean;
};

function buildEvidence(
  stream: StreamResult,
  state: CodecVerificationState,
  timestamp: number,
): InboundRtpCodecEvidence {
  return {
    verificationState: state,
    mimeType: (stream.codecRecord?.mimeType as string) ?? null,
    payloadType: (stream.codecRecord?.payloadType as number) ?? null,
    codecId: stream.codecId,
    rtpStatsId: stream.rtpStatsId,
    ssrc: stream.ssrc,
    bytesReceived: stream.bytesReceived,
    deltaBytesReceived: stream.deltaBytes,
    packetsReceived: stream.packetsReceived,
    deltaPacketsReceived: stream.deltaPackets,
    framesDecoded: stream.framesDecoded,
    deltaFramesDecoded: stream.deltaFrames,
    sdpFmtpLine: (stream.codecRecord?.sdpFmtpLine as string) ?? null,
    decoderImplementation: (stream.codecRecord?.decoderImplementation as string) ?? null,
    powerEfficientDecoder: (stream.codecRecord?.powerEfficientDecoder as boolean) ?? null,
    timestamp,
  };
}

// ─── High-level resolver (pre-builds codecMap from report) ────────────────

/**
 * High-level entry point: resolve the active video codec from raw stats.
 *
 * Builds the codec Map from the report, then delegates to collectCodecEvidence.
 * Returns the evidence object and the updated previousSamples map for the
 * next polling interval (covers ALL video inbound-rtp entries).
 */
export function resolveActiveCodecFromStats(
  statsReport: RTCStatsReport,
  _codecMap?: Map<string, Record<string, unknown>> | null,
  previousSamples?: Map<string, PreviousSample> | null,
): { evidence: InboundRtpCodecEvidence | null; updatedSamples: Map<string, PreviousSample> } {
  // Build codec map from the report if not provided
  const codecMap = _codecMap ?? new Map();
  if (!_codecMap) {
    for (const stat of statsReport.values() as Iterable<Record<string, unknown>>) {
      if (stat.type === "codec" && stat.id) {
        codecMap.set(stat.id as string, stat);
      }
    }
  }

  return collectCodecEvidence(
    statsReport,
    codecMap,
    previousSamples ?? new Map(),
  );
}

// ─── Legacy pollStats (unchanged) ─────────────────────────────────────────

export async function pollStats(pc: RTCPeerConnection): Promise<StatsSnapshot> {
  const report = await pc.getStats();
  const snapshot: StatsSnapshot = {};

  report.forEach(stat => {
    switch (stat.type) {
      case "outbound-rtp": {
        const outbound = stat as RTCOutboundRtpStreamStats;
        if (outbound.kind === "video") {
          snapshot.outbound = Object.fromEntries(
            [
              "bytesSent", "packetsSent", "framesEncoded", "framesSent",
              "frameWidth", "frameHeight", "framesPerSecond",
              "qualityLimitationReason", "retransmittedBytesSent",
              "nackCount", "pliCount", "firCount", "qpSum",
            ]
              .filter(k => k in outbound)
              .map(k => [k, (outbound as unknown as Record<string, unknown>)[k]]),
          );
        }
        break;
      }
      case "inbound-rtp": {
        const inbound = stat as RTCInboundRtpStreamStats;
        if (inbound.kind === "video") {
          snapshot.inbound = Object.fromEntries(
            [
              "bytesReceived", "packetsReceived", "packetsLost", "jitter",
              "framesDecoded", "framesDropped", "frameWidth", "frameHeight",
              "framesPerSecond", "nackCount", "pliCount", "firCount",
              "qpSum", "totalDecodeTime", "totalInterFrameDelay",
            ]
              .filter(k => k in inbound)
              .map(k => [k, (inbound as unknown as Record<string, unknown>)[k]]),
          );
        }
        break;
      }
      case "remote-inbound-rtp": {
        const remoteInbound = stat as unknown as Record<string, unknown>;
        snapshot.remoteInbound = Object.fromEntries(
          [
            "fractionLost", "packetsLost", "roundTripTime",
            "totalRoundTripTime", "roundTripTimeMeasurements",
          ]
            .filter(k => k in remoteInbound)
            .map(k => [k, remoteInbound[k]]),
        );
        break;
      }
      case "candidate-pair": {
        const pair = stat as unknown as Record<string, unknown>;
        if (pair.selected) {
          snapshot.candidatePair = Object.fromEntries(
            [
              "availableOutgoingBitrate", "availableIncomingBitrate",
              "bytesSent", "bytesReceived", "totalRoundTripTime",
              "currentRoundTripTime", "requestsReceived", "requestsSent",
              "responsesReceived", "responsesSent", "consentRequestsSent",
              "packetsSent", "packetsReceived", "state", "priority",
            ]
              .filter(k => k in pair)
              .map(k => [k, pair[k]]),
          );
        }
        break;
      }
      case "codec": {
        const codec = stat as unknown as Record<string, unknown>;
        snapshot.codec = Object.fromEntries(
          [
            "mimeType", "payloadType", "clockRate", "channels",
            "sdpFmtpLine", "codecType",
          ]
            .filter(k => k in codec)
            .map(k => [k, codec[k]]),
        );
        break;
      }
    }
  });

  return snapshot;
}
