import type { VDONinjaSDK } from "@screenlink/vdo-adapter";

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

// ─── PerViewerPollerState ────────────────────────────────────────────────────
// Stage 7: Each viewer poller holds its own exact RTCPeerConnection and state.

interface PerViewerPollerState {
  groupId: string;
  logicalStreamId: string;
  viewerDeviceId: string;
  mediaPeerUuid: string;
  pc: RTCPeerConnection;
  callback: (stats: MediaStatsSnapshot) => void;
  pollTimer: ReturnType<typeof setInterval> | null;
  previousOutboundBytes: number;
  previousInboundBytes: number;
  previousAudioOutboundBytes: number;
  previousAudioInboundBytes: number;
  previousTimestamp: number;
}

/** Composite key for per-viewer poller: groupId::logicalStreamId::viewerDeviceId::mediaPeerUuid */
function viewerPollerKey(
  groupId: string,
  logicalStreamId: string,
  viewerDeviceId: string,
  mediaPeerUuid: string,
): string {
  return `${groupId}::${logicalStreamId}::${viewerDeviceId}::${mediaPeerUuid}`;
}

// ─── MediaStatsPoller ───────────────────────────────────────────────────────

export class MediaStatsPoller {
  private sdk: VDONinjaSDK | null = null;
  private peerUuid: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private previousOutboundBytes = 0;
  private previousInboundBytes = 0;
  private previousTimestamp = 0;
  private previousAudioOutboundBytes = 0;
  private previousAudioInboundBytes = 0;
  private onStats: ((stats: MediaStatsSnapshot) => void) | null = null;

  // Per-viewer stats accumulation (Phase 3)
  readonly viewerStats: Map<string, PerViewerStats> = new Map();

  // Stage 7: Per-viewer pollers keyed by composite key
  private viewerPollers = new Map<string, PerViewerPollerState>();

  /**
   * Accumulate a per-viewer stats entry keyed by viewerDeviceId::mediaPeerUuid.
   * If an entry for the given composite key already exists, it is overwritten
   * with the latest data. The `lastUpdated` field is set to Date.now() automatically.
   *
   * Stage 7: Uses composite key format matching getViewerStats lookup.
   */
  accumulateViewerStats(stats: Omit<PerViewerStats, "lastUpdated">): void {
    const key = `${stats.viewerDeviceId}::${stats.mediaPeerUuid}`;
    this.viewerStats.set(key, {
      ...stats,
      lastUpdated: Date.now(),
    });
  }

  // ── Stage 7: Per-viewer poller methods ──────────────────────────────────

  /**
   * Start a per-viewer stats poller with an exact RTCPeerConnection.
   * Keyed by groupId + logicalStreamId + viewerDeviceId + mediaPeerUuid.
   * Stage 7: No first-connection fallback — uses the exact PC provided.
   */
  startViewerPoller(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
    mediaPeerUuid: string,
    pc: RTCPeerConnection,
    callback: (stats: MediaStatsSnapshot) => void,
  ): void {
    const key = viewerPollerKey(groupId, logicalStreamId, viewerDeviceId, mediaPeerUuid);

    // If a poller already exists for this exact key, clear it first
    this.stopViewerPoller(groupId, logicalStreamId, viewerDeviceId, mediaPeerUuid);

    const state: PerViewerPollerState = {
      groupId,
      logicalStreamId,
      viewerDeviceId,
      mediaPeerUuid,
      pc,
      callback,
      pollTimer: null,
      previousOutboundBytes: 0,
      previousInboundBytes: 0,
      previousAudioOutboundBytes: 0,
      previousAudioInboundBytes: 0,
      previousTimestamp: Date.now(),
    };

    this.viewerPollers.set(key, state);

    // Start polling immediately and every 2 seconds
    this.pollViewerPoller(state);
    state.pollTimer = setInterval(() => this.pollViewerPoller(state), 2000);
  }

  /**
   * Stop and delete a specific per-viewer poller.
   * Stage 7: Removes exact poller state for the specified key.
   */
  stopViewerPoller(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
    mediaPeerUuid: string,
  ): void {
    const key = viewerPollerKey(groupId, logicalStreamId, viewerDeviceId, mediaPeerUuid);
    const state = this.viewerPollers.get(key);
    if (!state) return;

    if (state.pollTimer) {
      clearInterval(state.pollTimer);
    }
    this.viewerPollers.delete(key);
  }

  /**
   * Stop and delete all per-viewer pollers.
   */
  stopAllViewerPollers(): void {
    for (const [key, state] of this.viewerPollers) {
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
      }
      this.viewerPollers.delete(key);
    }
  }

  /**
   * Check if a per-viewer poller exists for the given key.
   */
  hasViewerPoller(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
    mediaPeerUuid: string,
  ): boolean {
    const key = viewerPollerKey(groupId, logicalStreamId, viewerDeviceId, mediaPeerUuid);
    return this.viewerPollers.has(key);
  }

  /**
   * Get the exact RTCPeerConnection used by a per-viewer poller.
   */
  getViewerPollerPC(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
    mediaPeerUuid: string,
  ): RTCPeerConnection | null {
    const key = viewerPollerKey(groupId, logicalStreamId, viewerDeviceId, mediaPeerUuid);
    return this.viewerPollers.get(key)?.pc ?? null;
  }

  /**
   * Get the latest accumulated stats for a specific viewer key.
   * Stage 7: Per-viewer stats keyed by groupId + logicalStreamId + viewerDeviceId + mediaPeerUuid.
   * Lookup uses viewerDeviceId::mediaPeerUuid to match accumulateViewerStats keying.
   */
  getViewerStats(
    _groupId: string,
    _logicalStreamId: string,
    viewerDeviceId: string,
    mediaPeerUuid: string,
  ): PerViewerStats | null {
    const key = `${viewerDeviceId}::${mediaPeerUuid}`;
    return this.viewerStats.get(key) ?? null;
  }

  /**
   * Disconnect a viewer: stops the poller and removes accumulated stats.
   * Stage 7: Clean up all state for the exact viewer.
   * Uses the same key format as accumulateViewerStats (viewerDeviceId::mediaPeerUuid).
   */
  disconnectViewer(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
    mediaPeerUuid: string,
  ): void {
    this.stopViewerPoller(groupId, logicalStreamId, viewerDeviceId, mediaPeerUuid);

    // Remove accumulated stats using the same key format as accumulateViewerStats
    const statsKey = `${viewerDeviceId}::${mediaPeerUuid}`;
    this.viewerStats.delete(statsKey);
  }

  // ── Legacy poller (SDK-based) ───────────────────────────────────────────

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
    this.previousAudioOutboundBytes = 0;
    this.previousAudioInboundBytes = 0;
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
        audioOutboundBytes: 0,
        audioOutboundPackets: 0,
        audioOutboundBitrateKbps: 0,
        audioCodec: "",
        audioSsrc: 0,
        audioLevel: 0,
        totalAudioEnergy: 0,
        totalSamplesSent: 0,
        audioInboundBytes: 0,
        audioInboundPackets: 0,
        audioInboundBitrateKbps: 0,
        audioPacketsLost: 0,
        audioJitter: 0,
        audioJitterBufferDelay: 0,
        audioConcealedSamples: 0,
        audioConcealmentEvents: 0,
        audioTotalSamplesReceived: 0,
      };

      const inboundStats: Map<string, number> = new Map();
      const outboundStats: Map<string, number> = new Map();
      const audioOutboundStats: Map<string, number> = new Map();
      const audioInboundStats: Map<string, number> = new Map();

      let selectedPairLocalId: string | undefined;
      let selectedPairRemoteId: string | undefined;
      const candidates = new Map<string, { candidateType: string; protocol: string }>();
      const codecs = new Map<string, { mimeType: string }>();
      let audioCodecId: string | undefined;
      let videoCodecId: string | undefined;

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
          videoCodecId = (s.codecId as string) || videoCodecId;
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
          videoCodecId = (s.codecId as string) || videoCodecId;
        }

        if (s.type === "outbound-rtp" && s.kind === "audio") {
          audioOutboundStats.set("bytesSent", s.bytesSent as number);
          audioOutboundStats.set("packetsSent", s.packetsSent as number);
          audioOutboundStats.set("ssrc", s.ssrc as number);
          audioOutboundStats.set("audioLevel", s.audioLevel as number);
          audioOutboundStats.set("totalAudioEnergy", s.totalAudioEnergy as number);
          audioOutboundStats.set("totalSamplesSent", s.totalSamplesSent as number);
          audioCodecId = (s.codecId as string) || audioCodecId;
        }

        if (s.type === "inbound-rtp" && s.kind === "audio") {
          audioInboundStats.set("bytesReceived", s.bytesReceived as number);
          audioInboundStats.set("packetsReceived", s.packetsReceived as number);
          audioInboundStats.set("packetsLost", s.packetsLost as number);
          audioInboundStats.set("jitter", s.jitter as number);
          audioInboundStats.set("jitterBufferDelay", s.jitterBufferDelay as number);
          audioInboundStats.set("jitterBufferEmittedCount", s.jitterBufferEmittedCount as number);
          audioInboundStats.set("concealedSamples", s.concealedSamples as number);
          audioInboundStats.set("concealmentEvents", s.concealmentEvents as number);
          audioInboundStats.set("totalSamplesReceived", s.totalSamplesReceived as number);
          audioCodecId = (s.codecId as string) || audioCodecId;
        }

        if (s.type === "remote-inbound-rtp") {
          inboundStats.set("roundTripTime", s.roundTripTime as number);
          inboundStats.set("jitter", s.jitter as number);
          inboundStats.set("fractionLost", s.fractionLost as number);
        }

        if (s.type === "candidate-pair" && (s as unknown as { selected?: boolean }).selected) {
          const pair = s as unknown as RTCIceCandidatePairStats;
          snapshot.currentRtt = pair.currentRoundTripTime || 0;
          snapshot.availableOutgoingBitrate = (pair.availableOutgoingBitrate || 0) / 1000;
          selectedPairLocalId = pair.localCandidateId;
          selectedPairRemoteId = pair.remoteCandidateId;
        }

        if (s.type === "codec") {
          const codec = s as { mimeType?: string; id?: string };
          if (codec.id) {
            codecs.set(codec.id, { mimeType: codec.mimeType || '' });
          }
          // Fallback: direct match if no id
          if (codec.mimeType?.startsWith("audio/") && !snapshot.audioCodec) {
            snapshot.audioCodec = codec.mimeType;
          }
          if (codec.mimeType?.startsWith("video/") && !snapshot.codecMimeType) {
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

      // Resolve codecs from active RTP report codecId
      if (audioCodecId && codecs.has(audioCodecId)) {
        snapshot.audioCodec = codecs.get(audioCodecId)!.mimeType;
      }
      if (videoCodecId && codecs.has(videoCodecId)) {
        snapshot.codecMimeType = codecs.get(videoCodecId)!.mimeType;
      }

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
      const currentAudioOutBytes = audioOutboundStats.get("bytesSent") || 0;
      const currentAudioInBytes = audioInboundStats.get("bytesReceived") || 0;

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
      // Audio bitrate from deltas
      if (elapsed > 0 && this.previousAudioOutboundBytes > 0) {
        const delta = currentAudioOutBytes - this.previousAudioOutboundBytes;
        if (delta >= 0) {
          snapshot.audioOutboundBitrateKbps = (delta * 8) / elapsed / 1000;
        }
      }
      if (elapsed > 0 && this.previousAudioInboundBytes > 0) {
        const delta = currentAudioInBytes - this.previousAudioInboundBytes;
        if (delta >= 0) {
          snapshot.audioInboundBitrateKbps = (delta * 8) / elapsed / 1000;
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

      // Audio stats
      snapshot.audioOutboundBytes = currentAudioOutBytes;
      snapshot.audioOutboundPackets = audioOutboundStats.get("packetsSent") || 0;
      snapshot.audioSsrc = audioOutboundStats.get("ssrc") || 0;
      snapshot.audioLevel = audioOutboundStats.get("audioLevel") || 0;
      snapshot.totalAudioEnergy = audioOutboundStats.get("totalAudioEnergy") || 0;
      snapshot.totalSamplesSent = audioOutboundStats.get("totalSamplesSent") || 0;

      snapshot.audioInboundBytes = currentAudioInBytes;
      snapshot.audioInboundPackets = audioInboundStats.get("packetsReceived") || 0;
      snapshot.audioPacketsLost = audioInboundStats.get("packetsLost") || 0;
      snapshot.audioJitter = audioInboundStats.get("jitter") || 0;
      snapshot.audioJitterBufferDelay = audioInboundStats.get("jitterBufferDelay") || 0;
      snapshot.audioConcealedSamples = audioInboundStats.get("concealedSamples") || 0;
      snapshot.audioConcealmentEvents = audioInboundStats.get("concealmentEvents") || 0;
      snapshot.audioTotalSamplesReceived = audioInboundStats.get("totalSamplesReceived") || 0;

      // Update previous values
      this.previousOutboundBytes = currentOutboundBytes;
      this.previousInboundBytes = currentInboundBytes;
      this.previousAudioOutboundBytes = currentAudioOutBytes;
      this.previousAudioInboundBytes = currentAudioInBytes;
      this.previousTimestamp = now;

      this.onStats(snapshot);
    } catch (err) {
      console.warn("[Stats] Poll failed:", err);
    }
  }

  /**
   * Stage 7: Poll a per-viewer poller using its exact RTCPeerConnection.
   * No first-connection fallback — uses the exact PC stored in the poller state.
   * Guard: `pc.getStats()` may return undefined in test environments.
   */
  private async pollViewerPoller(state: PerViewerPollerState): Promise<void> {
    const pc = state.pc;
    if (!pc) return;

    try {
      const report = await pc.getStats();
      if (!report || typeof report.forEach !== "function") return;
      const now = Date.now();
      const elapsed = (now - state.previousTimestamp) / 1000;

      // Process stats (simplified for per-viewer reporting)
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
        audioOutboundBytes: 0,
        audioOutboundPackets: 0,
        audioOutboundBitrateKbps: 0,
        audioCodec: "",
        audioSsrc: 0,
        audioLevel: 0,
        totalAudioEnergy: 0,
        totalSamplesSent: 0,
        audioInboundBytes: 0,
        audioInboundPackets: 0,
        audioInboundBitrateKbps: 0,
        audioPacketsLost: 0,
        audioJitter: 0,
        audioJitterBufferDelay: 0,
        audioConcealedSamples: 0,
        audioConcealmentEvents: 0,
        audioTotalSamplesReceived: 0,
      };

      const outboundStats: Map<string, number> = new Map();
      const inboundStats: Map<string, number> = new Map();
      const audioOutboundStats: Map<string, number> = new Map();
      const audioInboundStats: Map<string, number> = new Map();

      let selectedPairLocalId: string | undefined;
      let selectedPairRemoteId: string | undefined;
      const candidates = new Map<string, { candidateType: string; protocol: string }>();
      const codecs = new Map<string, { mimeType: string }>();
      let audioCodecId: string | undefined;
      let videoCodecId: string | undefined;

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
          videoCodecId = (s.codecId as string) || videoCodecId;
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
          videoCodecId = (s.codecId as string) || videoCodecId;
        }

        if (s.type === "outbound-rtp" && s.kind === "audio") {
          audioOutboundStats.set("bytesSent", s.bytesSent as number);
          audioOutboundStats.set("packetsSent", s.packetsSent as number);
          audioOutboundStats.set("ssrc", s.ssrc as number);
          audioOutboundStats.set("audioLevel", s.audioLevel as number);
          audioOutboundStats.set("totalAudioEnergy", s.totalAudioEnergy as number);
          audioOutboundStats.set("totalSamplesSent", s.totalSamplesSent as number);
          audioCodecId = (s.codecId as string) || audioCodecId;
        }

        if (s.type === "inbound-rtp" && s.kind === "audio") {
          audioInboundStats.set("bytesReceived", s.bytesReceived as number);
          audioInboundStats.set("packetsReceived", s.packetsReceived as number);
          audioInboundStats.set("packetsLost", s.packetsLost as number);
          audioInboundStats.set("jitter", s.jitter as number);
          audioInboundStats.set("jitterBufferDelay", s.jitterBufferDelay as number);
          audioInboundStats.set("jitterBufferEmittedCount", s.jitterBufferEmittedCount as number);
          audioInboundStats.set("concealedSamples", s.concealedSamples as number);
          audioInboundStats.set("concealmentEvents", s.concealmentEvents as number);
          audioInboundStats.set("totalSamplesReceived", s.totalSamplesReceived as number);
          audioCodecId = (s.codecId as string) || audioCodecId;
        }

        if (s.type === "remote-inbound-rtp") {
          inboundStats.set("roundTripTime", s.roundTripTime as number);
          inboundStats.set("jitter", s.jitter as number);
          inboundStats.set("fractionLost", s.fractionLost as number);
        }

        if (s.type === "candidate-pair" && (s as unknown as { selected?: boolean }).selected) {
          const pair = s as unknown as RTCIceCandidatePairStats;
          snapshot.currentRtt = pair.currentRoundTripTime || 0;
          snapshot.availableOutgoingBitrate = (pair.availableOutgoingBitrate || 0) / 1000;
          selectedPairLocalId = pair.localCandidateId;
          selectedPairRemoteId = pair.remoteCandidateId;
        }

        if (s.type === "codec") {
          const codec = s as { mimeType?: string; id?: string };
          if (codec.id) {
            codecs.set(codec.id, { mimeType: codec.mimeType || '' });
          }
          if (codec.mimeType?.startsWith("audio/") && !snapshot.audioCodec) {
            snapshot.audioCodec = codec.mimeType;
          }
          if (codec.mimeType?.startsWith("video/") && !snapshot.codecMimeType) {
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

      // Resolve codecs
      if (audioCodecId && codecs.has(audioCodecId)) {
        snapshot.audioCodec = codecs.get(audioCodecId)!.mimeType;
      }
      if (videoCodecId && codecs.has(videoCodecId)) {
        snapshot.codecMimeType = codecs.get(videoCodecId)!.mimeType;
      }

      // Resolve relay
      const selectedLocal = selectedPairLocalId ? candidates.get(selectedPairLocalId) : undefined;
      const selectedRemote = selectedPairRemoteId ? candidates.get(selectedPairRemoteId) : undefined;
      if (selectedLocal?.candidateType === "relay" || selectedRemote?.candidateType === "relay") {
        snapshot.isRelay = true;
        snapshot.relayProtocol = selectedLocal?.protocol || selectedRemote?.protocol || "";
      }

      // Bitrate deltas
      const currentOutboundBytes = outboundStats.get("bytesSent") || 0;
      const currentInboundBytes = inboundStats.get("bytesReceived") || 0;
      const currentAudioOutBytes = audioOutboundStats.get("bytesSent") || 0;
      const currentAudioInBytes = audioInboundStats.get("bytesReceived") || 0;

      if (elapsed > 0 && state.previousOutboundBytes > 0) {
        const delta = currentOutboundBytes - state.previousOutboundBytes;
        if (delta >= 0) {
          snapshot.outboundBitrateKbps = (delta * 8) / elapsed / 1000;
        }
      }
      if (elapsed > 0 && state.previousInboundBytes > 0) {
        const delta = currentInboundBytes - state.previousInboundBytes;
        if (delta >= 0) {
          snapshot.inboundBitrateKbps = (delta * 8) / elapsed / 1000;
        }
      }
      if (elapsed > 0 && state.previousAudioOutboundBytes > 0) {
        const delta = currentAudioOutBytes - state.previousAudioOutboundBytes;
        if (delta >= 0) {
          snapshot.audioOutboundBitrateKbps = (delta * 8) / elapsed / 1000;
        }
      }
      if (elapsed > 0 && state.previousAudioInboundBytes > 0) {
        const delta = currentAudioInBytes - state.previousAudioInboundBytes;
        if (delta >= 0) {
          snapshot.audioInboundBitrateKbps = (delta * 8) / elapsed / 1000;
        }
      }

      // Populate remaining fields
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

      snapshot.audioOutboundBytes = currentAudioOutBytes;
      snapshot.audioOutboundPackets = audioOutboundStats.get("packetsSent") || 0;
      snapshot.audioSsrc = audioOutboundStats.get("ssrc") || 0;
      snapshot.audioLevel = audioOutboundStats.get("audioLevel") || 0;
      snapshot.totalAudioEnergy = audioOutboundStats.get("totalAudioEnergy") || 0;
      snapshot.totalSamplesSent = audioOutboundStats.get("totalSamplesSent") || 0;

      snapshot.audioInboundBytes = currentAudioInBytes;
      snapshot.audioInboundPackets = audioInboundStats.get("packetsReceived") || 0;
      snapshot.audioPacketsLost = audioInboundStats.get("packetsLost") || 0;
      snapshot.audioJitter = audioInboundStats.get("jitter") || 0;
      snapshot.audioJitterBufferDelay = audioInboundStats.get("jitterBufferDelay") || 0;
      snapshot.audioConcealedSamples = audioInboundStats.get("concealedSamples") || 0;
      snapshot.audioConcealmentEvents = audioInboundStats.get("concealmentEvents") || 0;
      snapshot.audioTotalSamplesReceived = audioInboundStats.get("totalSamplesReceived") || 0;

      // Update state
      state.previousOutboundBytes = currentOutboundBytes;
      state.previousInboundBytes = currentInboundBytes;
      state.previousAudioOutboundBytes = currentAudioOutBytes;
      state.previousAudioInboundBytes = currentAudioInBytes;
      state.previousTimestamp = now;

      state.callback(snapshot);
    } catch (err) {
      console.warn("[Stats] Per-Viewer Poll failed:", err);
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

