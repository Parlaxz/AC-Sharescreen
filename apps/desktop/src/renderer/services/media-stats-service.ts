import type { VDONinjaSDK } from "@screenlink/vdo-adapter";

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
}

export class MediaStatsPoller {
  private sdk: VDONinjaSDK | null = null;
  private peerUuid: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private previousOutboundBytes = 0;
  private previousInboundBytes = 0;
  private previousTimestamp = 0;
  private onStats: ((stats: MediaStatsSnapshot) => void) | null = null;

  start(
    sdk: VDONinjaSDK,
    peerUuid: string | null,
    callback: (stats: MediaStatsSnapshot) => void,
  ): void {
    this.sdk = sdk;
    this.peerUuid = peerUuid;
    this.onStats = callback;
    this.previousOutboundBytes = 0;
    this.previousInboundBytes = 0;
    this.previousTimestamp = Date.now();

    // Poll every 2 seconds
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 2000);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.sdk = null;
    this.peerUuid = null;
    this.onStats = null;
  }

  private async poll(): Promise<void> {
    if (!this.sdk || !this.onStats) return;

    try {
      // Try to get the RTCPeerConnection from the SDK's internal connections
      const pc = this.getPeerConnection();
      if (!pc) return;

      const report = await pc.getStats();
      const now = Date.now();
      const elapsed = (now - this.previousTimestamp) / 1000;

      // Process stats
      const snapshot: MediaStatsSnapshot = {
        outboundBitrateKbps: 0,
        outboundBytes: 0,
        outboundFps: 0,
        outboundWidth: 0,
        outboundHeight: 0,
        retransmittedBytes: 0,
        nackCount: 0,
        pliCount: 0,
        qualityLimitation: "",
        inboundBitrateKbps: 0,
        inboundBytes: 0,
        inboundFps: 0,
        inboundWidth: 0,
        inboundHeight: 0,
        packetsLost: 0,
        jitter: 0,
        roundTripTime: 0,
        framesDropped: 0,
        freezeCount: 0,
        isRelay: false,
        relayProtocol: "",
        currentRtt: 0,
        availableOutgoingBitrate: 0,
        codecMimeType: "",
      };

      const inboundStats: Map<string, number> = new Map();
      const outboundStats: Map<string, number> = new Map();

      let selectedPairLocalId: string | undefined;
      let selectedPairRemoteId: string | undefined;
      const candidates = new Map<string, { candidateType: string; protocol: string }>();

      report.forEach(stat => {
        const s = stat as unknown as Record<string, unknown>;

        if (s.type === "outbound-rtp" && s.kind === "video") {
          outboundStats.set("bytesSent", s.bytesSent as number);
          outboundStats.set("packetsSent", s.packetsSent as number);
          outboundStats.set("framesEncoded", s.framesEncoded as number);
          outboundStats.set("framesSent", s.framesSent as number);
          outboundStats.set("frameWidth", s.frameWidth as number);
          outboundStats.set("frameHeight", s.frameHeight as number);
          outboundStats.set("framesPerSecond", s.framesPerSecond as number);
          outboundStats.set("retransmittedBytesSent", s.retransmittedBytesSent as number);
          outboundStats.set("nackCount", s.nackCount as number);
          outboundStats.set("pliCount", s.pliCount as number);
          snapshot.qualityLimitation = (s.qualityLimitationReason as string) || "";
        }

        if (s.type === "inbound-rtp" && s.kind === "video") {
          inboundStats.set("bytesReceived", s.bytesReceived as number);
          inboundStats.set("packetsReceived", s.packetsReceived as number);
          inboundStats.set("packetsLost", s.packetsLost as number);
          inboundStats.set("jitter", s.jitter as number);
          inboundStats.set("framesDecoded", s.framesDecoded as number);
          inboundStats.set("framesDropped", s.framesDropped as number);
          inboundStats.set("frameWidth", s.frameWidth as number);
          inboundStats.set("frameHeight", s.frameHeight as number);
          inboundStats.set("framesPerSecond", s.framesPerSecond as number);
          inboundStats.set("freezeCount", s.freezeCount as number);
          inboundStats.set("nackCount", s.nackCount as number);
          inboundStats.set("pliCount", s.pliCount as number);
        }

        if (s.type === "remote-inbound-rtp") {
          inboundStats.set("roundTripTime", s.roundTripTime as number);
          inboundStats.set("jitter", s.jitter as number);
          inboundStats.set("fractionLost", s.fractionLost as number);
        }

        if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).selected) {
          const pair = s as RTCIceCandidatePairStats;
          snapshot.currentRtt = pair.currentRoundTripTime || 0;
          snapshot.availableOutgoingBitrate = (pair.availableOutgoingBitrate || 0) / 1000;
          selectedPairLocalId = pair.localCandidateId;
          selectedPairRemoteId = pair.remoteCandidateId;
        }

        if (s.type === "codec") {
          const codec = s as { mimeType?: string };
          if (codec.mimeType?.startsWith("video/")) {
            snapshot.codecMimeType = codec.mimeType;
          }
        }

        if (s.type === "local-candidate" || s.type === "remote-candidate") {
          const cand = s as unknown as Record<string, unknown>;
          candidates.set(cand.id as string, {
            candidateType: (cand.candidateType as string) || "",
            protocol: (cand.protocol as string) || "",
          });
        }
      });

      // Resolve relay status from SELECTED pair only
      const selectedLocal = selectedPairLocalId ? candidates.get(selectedPairLocalId) : undefined;
      const selectedRemote = selectedPairRemoteId ? candidates.get(selectedPairRemoteId) : undefined;
      if (selectedLocal?.candidateType === "relay" || selectedRemote?.candidateType === "relay") {
        snapshot.isRelay = true;
        snapshot.relayProtocol = selectedLocal?.protocol || selectedRemote?.protocol || "";
      }

      // Compute bitrates from byte deltas
      const currentOutboundBytes = outboundStats.get("bytesSent") || 0;
      const currentInboundBytes = inboundStats.get("bytesReceived") || 0;

      if (elapsed > 0 && this.previousOutboundBytes > 0) {
        const outboundDelta = currentOutboundBytes - this.previousOutboundBytes;
        if (outboundDelta >= 0) {
          snapshot.outboundBitrateKbps = (outboundDelta * 8) / elapsed / 1000;
        }
      }
      if (elapsed > 0 && this.previousInboundBytes > 0) {
        const inboundDelta = currentInboundBytes - this.previousInboundBytes;
        if (inboundDelta >= 0) {
          snapshot.inboundBitrateKbps = (inboundDelta * 8) / elapsed / 1000;
        }
      }

      // Populate values from stats maps
      snapshot.outboundBytes = currentOutboundBytes;
      snapshot.outboundFps = outboundStats.get("framesPerSecond") || 0;
      snapshot.outboundWidth = outboundStats.get("frameWidth") || 0;
      snapshot.outboundHeight = outboundStats.get("frameHeight") || 0;
      snapshot.retransmittedBytes = outboundStats.get("retransmittedBytesSent") || 0;
      snapshot.nackCount = Math.max(
        outboundStats.get("nackCount") || 0,
        inboundStats.get("nackCount") || 0,
      );
      snapshot.pliCount = Math.max(
        outboundStats.get("pliCount") || 0,
        inboundStats.get("pliCount") || 0,
      );

      snapshot.inboundBytes = currentInboundBytes;
      snapshot.inboundFps = inboundStats.get("framesPerSecond") || 0;
      snapshot.inboundWidth = inboundStats.get("frameWidth") || 0;
      snapshot.inboundHeight = inboundStats.get("frameHeight") || 0;
      snapshot.packetsLost = inboundStats.get("packetsLost") || 0;
      snapshot.jitter = inboundStats.get("jitter") || 0;
      snapshot.roundTripTime = inboundStats.get("roundTripTime") || 0;
      snapshot.framesDropped = inboundStats.get("framesDropped") || 0;
      snapshot.freezeCount = inboundStats.get("freezeCount") || 0;

      // Update previous values
      this.previousOutboundBytes = currentOutboundBytes;
      this.previousInboundBytes = currentInboundBytes;
      this.previousTimestamp = now;

      this.onStats(snapshot);
    } catch (err) {
      console.warn("[Stats] Poll failed:", err);
    }
  }

  private getPeerConnection(): RTCPeerConnection | null {
    if (!this.sdk) return null;
    try {
      const connections = this.sdk.connections;
      if (!connections || !(connections instanceof Map)) return null;

      // If we have a specific peer UUID, look up that connection
      if (this.peerUuid && connections.has(this.peerUuid)) {
        const group = connections.get(this.peerUuid)!;
        const pc = group.viewer?.pc ?? group.publisher?.pc ?? null;
        if (pc) return pc;
      }

      // Fallback: iterate connections to find the first with a video PC
      for (const [, group] of connections) {
        const pc = group.viewer?.pc ?? group.publisher?.pc ?? null;
        if (pc) return pc;
      }

      return null;
    } catch {
      return null;
    }
  }
}
