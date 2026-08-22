// ─── PerViewerStats ─────────────────────────────────────────────────────────

export interface PerViewerStats {
  viewerDeviceId: string;
  mediaPeerUuid: string;
  videoBitrateKbps: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  qualityLimitationReason: string | null;
  retransmittedBytes: number;
  nackCount: number;
  pliCount: number;
  availableOutgoingBitrate: number;
  rtt: number;
  packetLoss: number;
  candidateType: string;
  relayProtocol: string;
  audioBitrateKbps: number;
  audioCodec: string;
  lastUpdated: number;
}

export interface MediaStatsSnapshot {
  // Outbound
  outboundBitrateKbps: number;
  outboundBytes: number;
  outboundFps: number;
  outboundWidth: number;
  outboundHeight: number;
  retransmittedBytes: number;
  nackCount: number;
  pliCount: number;
  qualityLimitation: string;

  // Inbound
  inboundBitrateKbps: number;
  inboundBytes: number;
  inboundFps: number;
  inboundWidth: number;
  inboundHeight: number;
  packetsLost: number;
  jitter: number;
  roundTripTime: number;
  framesDropped: number;
  freezeCount: number;

  // Path
  isRelay: boolean;
  relayProtocol: string;
  currentRtt: number;
  availableOutgoingBitrate: number;

  // Codec
  codecMimeType: string;

  // Audio outbound
  audioOutboundBytes: number;
  audioOutboundPackets: number;
  audioOutboundBitrateKbps: number;
  audioCodec: string;
  audioSsrc: number;
  audioLevel: number;
  totalAudioEnergy: number;
  totalSamplesSent: number;

  // Audio inbound
  audioInboundBytes: number;
  audioInboundPackets: number;
  audioInboundBitrateKbps: number;
  audioPacketsLost: number;
  audioJitter: number;
  audioJitterBufferDelay: number;
  audioConcealedSamples: number;
  audioConcealmentEvents: number;
  audioTotalSamplesReceived: number;
}
