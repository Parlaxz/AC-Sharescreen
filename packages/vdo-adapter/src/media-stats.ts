export interface StatsSnapshot {
  outbound?: Record<string, unknown>;
  inbound?: Record<string, unknown>;
  remoteInbound?: Record<string, unknown>;
  candidatePair?: Record<string, unknown>;
  codec?: Record<string, unknown>;
}

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
