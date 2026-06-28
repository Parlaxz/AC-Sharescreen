/**
 * StreamMetricsService — renderer singleton that owns bandwidth telemetry.
 *
 * Architecture:
 *   - One service-level 1-second timer
 *   - Each registered RTCPeerConnection is polled once per tick
 *   - Independent video/audio/transport baselines per connection
 *   - Schema v2 persistence with v1 migration
 *   - Proper active-duration tracking and running peaks
 */

import type {
  TelemetrySample,
  TelemetryState,
  BandwidthSnapshot,
  AggregatedBucket,
  TelemetryMarker,
  MarkerType,
  TelemetrySeriesSnapshot,
  ConnectionTelemetrySnapshot,
  ViewerReportedStatus,
  PeerTelemetryObservation,
  PersistenceRecordV2,
  ViewerRateEntry,
} from "./bandwidth-telemetry-types.js";

// ─── Legacy history record (pre-migration) ─────────────────────────────────

interface LegacyHistoryRecord {
  historyId: string;
  role: "host" | "viewer";
  status: "active" | "completed" | "interrupted";
  mediaSessionId?: string;
  logicalStreamId?: string;
  groupId?: string;
  groupName?: string;
  remoteDisplayName?: string | null;
  startedAt: number;
  lastCheckpointAt?: number;
  stoppedAt?: number | null;
  durationMs?: number;
  totalBytes: number;
  averageBytesPerSecond?: number;
  bytesPerSecond?: number;
  presetName?: string | null;
  customQuality?: boolean;
  samples?: Array<{ timestamp: number; bytesPerSecond: number; totalBytes: number }>;
  markers?: Array<{ timestamp: number; category: string; from: string | null; to: string; label: string; id?: string }>;
  interrupted?: boolean;
  schemaVersion?: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 1000;
const MAX_RAW_SAMPLES = 300;       // 5 minutes
const MEDIUM_BUCKET_SIZE_MS = 5000;
const MAX_MEDIUM_BUCKETS = 360;    // 30 minutes
const LONG_BUCKET_SIZE_MS = 30000;
const MAX_LONG_BUCKETS = 10000;    // ~83 hours
const PERSIST_INTERVAL_TICKS = 10;
const EWMA_ALPHA = 1 - Math.exp(-1 / 3);

// ─── Baseline state per counter ────────────────────────────────────────────

interface CounterBaseline {
  initialized: boolean;
  identity: {
    reportId: string;
    ssrc: number | null;
    trackIdentifier: string | null;
    mid: string | null;
  };
  previousCumulativeBytes: number;
  previousMonotonicTimestamp: number;
}

// ─── Connection state ──────────────────────────────────────────────────────

interface ConnectionState {
  connectionId: string;
  historyId: string;
  viewerDeviceId: string | null;
  displayName: string | null;
  peerConnection: RTCPeerConnection;
  direction: "inbound" | "outbound";
  configuredVideoBitsPerSecond: number | null;
  effectiveVideoBitsPerSecond: number | null;
  receivedStatus: ViewerReportedStatus | null;

  // Independent baselines
  videoBaseline: CounterBaseline;
  audioBaseline: CounterBaseline;
  transportBaseline: CounterBaseline;

  // Accumulation
  totalVideoBytes: number;
  totalAudioBytes: number;
  totalTransportBytes: number;

  // Current rate
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  transportBitsPerSecond: number;

  // Peaks
  peakBitsPerSecond: number;

  // State tracking
  state: TelemetryState;
  pausedAtMonotonic: number | null;
  totalPausedMs: number;

  // Samples & aggregation
  rawSamples: TelemetrySample[];
  mediumBuckets: AggregatedBucket[];
  longBuckets: AggregatedBucket[];
  mediumBucketMeta: Map<number, number>; // bucketStart → lastCumulativeBytes
  longBucketMeta: Map<number, number>;
  ewmaValue: number;
  ewmaInitialized: boolean;
  ewmaLastRaw: number;
  ewmaSeries: number[];

  // Markers
  markers: TelemetryMarker[];

  // Metadata tracking for sampled-marker suppression
  lastConfiguredBps: number | null;
  lastEffectiveBps: number | null;
  lastResolution: string | null;
  lastFps: number | null;
  lastCodec: string | null;
  lastConnectionType: "direct" | "turn" | null;

  // Generation for peer replacement
  generation: number;
}

// ─── Session state ─────────────────────────────────────────────────────────

interface SessionState {
  historyId: string;
  role: "host" | "viewer";
  startedAt: number;
  startedAtMonotonic: number;
  connections: Map<string, ConnectionState>;
  markers: TelemetryMarker[];
  status: "active" | "completed" | "interrupted";
  lastCheckpointAt: number;

  // Aggregate series
  peakBitsPerSecond: number;
  totalBytes: number;
  configuredBitsPerSecond: number | null;
  effectiveBitsPerSecond: number | null;
  state: TelemetryState;

  // Snapshot cache
  lastSnapshot: BandwidthSnapshot | null;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class StreamMetricsService {
  private static instance: StreamMetricsService | null = null;
  private sessions = new Map<string, SessionState>();
  private connections = new Map<string, ConnectionState>(); // connectionId → ConnectionState
  private timer: ReturnType<typeof setInterval> | null = null;
  private onHistoryChanged: (() => void) | null = null;
  private finalizing = new Set<string>();
  private tickInFlight = false;
  private tickCounter = 0;
  private subscribers = new Map<string, Set<() => void>>();
  private pendingBaselines = new Set<string>(); // connectionIds needing forced rebaseline

  static getInstance(): StreamMetricsService {
    if (!StreamMetricsService.instance) {
      StreamMetricsService.instance = new StreamMetricsService();
    }
    return StreamMetricsService.instance;
  }

  static setInstance(svc: StreamMetricsService | null): void {
    StreamMetricsService.instance = svc;
  }

  private constructor() {}

  setOnHistoryChanged(cb: (() => void) | null): void {
    this.onHistoryChanged = cb;
  }

  // ─── Subscription ───────────────────────────────────────────────────────

  subscribe(historyId: string, callback: () => void): () => void {
    if (!this.subscribers.has(historyId)) {
      this.subscribers.set(historyId, new Set());
    }
    this.subscribers.get(historyId)!.add(callback);
    return () => { this.subscribers.get(historyId)?.delete(callback); };
  }

  getSnapshot(historyId: string): BandwidthSnapshot {
    const state = this.sessions.get(historyId);
    if (!state) return emptySnapshot(historyId);
    if (!state.lastSnapshot) {
      state.lastSnapshot = this.buildSnapshot(state);
    }
    return state.lastSnapshot;
  }

  // ─── Session lifecycle ─────────────────────────────────────────────────

  startHostSession(
    mediaSessionId: string,
    logicalStreamId: string,
    groupId: string,
    groupName: string,
  ): string {
    const historyId = `history-${this.generateId()}`;
    const now = Date.now();
    const state: SessionState = {
      historyId,
      role: "host",
      startedAt: now,
      startedAtMonotonic: performance.now(),
      connections: new Map(),
      markers: [],
      status: "active",
      lastCheckpointAt: now,
      peakBitsPerSecond: 0,
      totalBytes: 0,
      configuredBitsPerSecond: null,
      effectiveBitsPerSecond: null,
      state: "playing",
      lastSnapshot: null,
    };
    this.sessions.set(historyId, state);
    this.ensureTimer();
    return historyId;
  }

  startViewerSession(
    mediaSessionId: string,
    logicalStreamId: string,
    groupId: string,
    groupName: string,
  ): string {
    const historyId = `history-${this.generateId()}`;
    const now = Date.now();
    const state: SessionState = {
      historyId,
      role: "viewer",
      startedAt: now,
      startedAtMonotonic: performance.now(),
      connections: new Map(),
      markers: [],
      status: "active",
      lastCheckpointAt: now,
      peakBitsPerSecond: 0,
      totalBytes: 0,
      configuredBitsPerSecond: null,
      effectiveBitsPerSecond: null,
      state: "playing",
      lastSnapshot: null,
    };
    this.sessions.set(historyId, state);
    this.ensureTimer();
    return historyId;
  }

  // ─── Connection registration ───────────────────────────────────────────

  registerConnection(input: {
    historyId: string;
    connectionId: string;
    viewerDeviceId: string | null;
    displayName: string | null;
    peerConnection: RTCPeerConnection;
    direction: "inbound" | "outbound";
    configuredVideoBitsPerSecond?: number | null;
    effectiveVideoBitsPerSecond?: number | null;
  }): () => void {
    const state = this.sessions.get(input.historyId);
    if (!state) return () => {};

    const now = performance.now();
    const conn: ConnectionState = {
      connectionId: input.connectionId,
      historyId: input.historyId,
      viewerDeviceId: input.viewerDeviceId,
      displayName: input.displayName,
      peerConnection: input.peerConnection,
      direction: input.direction,
      configuredVideoBitsPerSecond: input.configuredVideoBitsPerSecond ?? null,
      effectiveVideoBitsPerSecond: input.effectiveVideoBitsPerSecond ?? null,
      receivedStatus: null,
      videoBaseline: makeBaseline(),
      audioBaseline: makeBaseline(),
      transportBaseline: makeBaseline(),
      totalVideoBytes: 0,
      totalAudioBytes: 0,
      totalTransportBytes: 0,
      videoBitsPerSecond: 0,
      audioBitsPerSecond: 0,
      transportBitsPerSecond: 0,
      peakBitsPerSecond: 0,
      state: "playing",
      pausedAtMonotonic: null,
      totalPausedMs: 0,
      rawSamples: [],
      mediumBuckets: [],
      longBuckets: [],
      mediumBucketMeta: new Map(),
      longBucketMeta: new Map(),
      ewmaValue: 0,
      ewmaInitialized: false,
      ewmaLastRaw: 0,
      ewmaSeries: [],
      markers: [],
      lastConfiguredBps: input.configuredVideoBitsPerSecond ?? null,
      lastEffectiveBps: input.effectiveVideoBitsPerSecond ?? null,
      lastResolution: null,
      lastFps: null,
      lastCodec: null,
      lastConnectionType: null,
      generation: 0,
    };

    state.connections.set(input.connectionId, conn);
    this.connections.set(input.connectionId, conn);
    this.ensureTimer();

    return () => {
      state.connections.delete(input.connectionId);
      this.connections.delete(input.connectionId);
    };
  }

  replaceConnectionPeer(
    historyId: string,
    connectionId: string,
    peerConnection: RTCPeerConnection,
  ): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.peerConnection = peerConnection;
    conn.generation++;
    // Force rebaseline on next tick
    this.pendingBaselines.add(connectionId);
  }

  updateViewerReportedStatus(
    historyId: string,
    connectionId: string,
    status: ViewerReportedStatus,
  ): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.receivedStatus = status;
  }

  // ─── State control ─────────────────────────────────────────────────────

  setSessionState(historyId: string, newState: TelemetryState): void {
    const state = this.sessions.get(historyId);
    if (!state) return;

    const oldState = state.state;
    if (oldState === newState) return;

    state.state = newState;

    // Update all connections
    for (const conn of state.connections.values()) {
      const connOldState = conn.state;
      if (newState === "paused" && connOldState === "playing") {
        conn.state = "paused";
        conn.pausedAtMonotonic = performance.now();
        this.addConnectionMarker(conn, "pause", null, "paused", "Session paused");
      } else if (newState === "playing" && connOldState === "paused") {
        if (conn.pausedAtMonotonic !== null) {
          conn.totalPausedMs += performance.now() - conn.pausedAtMonotonic;
          conn.pausedAtMonotonic = null;
        }
        conn.state = "playing";
        this.addConnectionMarker(conn, "resume", null, "resumed", "Session resumed");
      } else if (newState === "reconnecting") {
        conn.state = "reconnecting";
        this.addConnectionMarker(conn, "reconnect", null, "reconnecting", "Session reconnecting");
        this.pendingBaselines.add(conn.connectionId);
      } else {
        conn.state = newState;
      }
    }

    state.lastSnapshot = null;
    this.notifySessionSubscribers(historyId);
  }

  // ─── Markers ───────────────────────────────────────────────────────────

  addMarker(
    historyId: string,
    type: MarkerType,
    from: string | null,
    to: string,
    label: string,
    connectionId: string | null = null,
    viewerDeviceId: string | null = null,
  ): void {
    const state = this.sessions.get(historyId);
    if (!state) return;

    const marker: TelemetryMarker = {
      id: this.generateId(),
      historyId,
      connectionId,
      viewerDeviceId,
      timestampMs: Date.now(),
      type,
      label,
      from,
      to,
      detail: from ? `${from} → ${to}` : to,
    };

    state.markers.push(marker);
    state.lastSnapshot = null;
    this.notifySessionSubscribers(historyId);
  }

  private addConnectionMarker(
    conn: ConnectionState,
    type: MarkerType,
    from: string | null,
    to: string,
    label: string,
  ): void {
    // Duplicate suppression for sampled markers
    if (this.shouldSuppressMarker(conn, type, to)) return;

    const marker: TelemetryMarker = {
      id: `${conn.connectionId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      historyId: conn.historyId,
      connectionId: conn.connectionId,
      viewerDeviceId: conn.viewerDeviceId,
      timestampMs: Date.now(),
      type,
      label,
      from,
      to,
      detail: from ? `${from} → ${to}` : to,
    };

    conn.markers.push(marker);

    const state = this.sessions.get(conn.historyId);
    if (state) {
      state.markers.push(marker);
      state.lastSnapshot = null;
    }
  }

  private shouldSuppressMarker(conn: ConnectionState, type: MarkerType, to: string): boolean {
    switch (type) {
      case "bitrate": return conn.lastConfiguredBps?.toString() === to || conn.lastEffectiveBps?.toString() === to;
      case "resolution": return conn.lastResolution === to;
      case "fps": return conn.lastFps?.toString() === to;
      case "codec": return conn.lastCodec === to;
      case "turn": return conn.lastConnectionType === to;
      default: return false;
    }
  }

  // ─── Session finalization ──────────────────────────────────────────────

  async finalizeSession(historyId: string): Promise<void> {
    if (this.finalizing.has(historyId)) return;
    const state = this.sessions.get(historyId);
    if (!state) return;

    this.finalizing.add(historyId);

    try {
      state.status = "completed";
      state.lastCheckpointAt = Date.now();

      await this.persistSession(state);

      for (const conn of state.connections.values()) {
        this.connections.delete(conn.connectionId);
      }
      this.sessions.delete(historyId);
      this.notifySessionSubscribers(historyId);
      this.notifyHistoryChanged();
    } finally {
      this.finalizing.delete(historyId);
      this.stopTimerIfIdle();
    }
  }

  // ─── Getters ───────────────────────────────────────────────────────────

  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  getActiveMediaSessionIds(): string[] {
    // No longer mediaSessionId-based — return session historyIds
    return Array.from(this.sessions.keys());
  }

  findHistoryIdByMediaSessionId(_mediaSessionId: string): string | null {
    return this.sessions.size > 0 ? this.sessions.keys().next().value ?? null : null;
  }

  getViewerRates(historyId: string): ViewerRateEntry[] {
    const state = this.sessions.get(historyId);
    if (!state || state.role !== "host") return [];
    return Array.from(state.connections.values()).map((c) => ({
      viewerDeviceId: c.viewerDeviceId ?? c.connectionId,
      displayName: c.displayName ?? c.connectionId,
      bitsPerSecond: c.videoBitsPerSecond + c.audioBitsPerSecond,
      totalBytes: c.totalVideoBytes + c.totalAudioBytes,
      rttMs: c.receivedStatus?.rttMs ?? null,
      packetLossPercent: c.receivedStatus?.packetLossPercent ?? null,
      width: c.receivedStatus?.width ?? null,
      height: c.receivedStatus?.height ?? null,
      framesPerSecond: c.receivedStatus?.framesPerSecond ?? null,
      state: c.state,
    }));
  }

  async getHistory(): Promise<StreamHistoryRecord[]> {
    try {
      const api = (window as unknown as { screenlink?: { getStreamHistory?: () => Promise<unknown[]> } }).screenlink;
      if (!api?.getStreamHistory) return [];
      const records = await api.getStreamHistory();
      return records.map((r: unknown) => this.maybeMigrateRecord(r as LegacyHistoryRecord));
    } catch {
      return [];
    }
  }

  // ─── Crash recovery ────────────────────────────────────────────────────

  async recoverInterruptedSessions(): Promise<void> {
    try {
      const api = (window as unknown as {
        screenlink?: {
          getStreamHistory?: () => Promise<unknown[]>;
          saveStreamHistory?: (r: unknown[]) => Promise<void>;
        }
      }).screenlink;
      if (!api?.getStreamHistory) return;

      const records = await api.getStreamHistory();
      let changed = false;
      for (let i = 0; i < records.length; i++) {
        const r = records[i] as LegacyHistoryRecord;
        if (r.status === "active") {
          r.status = "interrupted";
          r.interrupted = true;
          r.stoppedAt = r.lastCheckpointAt ?? r.startedAt;
          r.durationMs = (r.lastCheckpointAt ?? r.startedAt) - r.startedAt;
          changed = true;
        }
      }
      if (changed && api.saveStreamHistory) {
        await api.saveStreamHistory(records);
      }
    } catch {
      console.warn("[StreamMetricsService] Failed to recover interrupted sessions");
    }
  }

  // ─── Timer ────────────────────────────────────────────────────────────

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.handleTick(), SAMPLE_INTERVAL_MS);
  }

  private stopTimerIfIdle(): void {
    if (this.sessions.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private handleTick(): void {
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      this.tickCounter++;
      const shouldPersist = this.tickCounter % PERSIST_INTERVAL_TICKS === 0;

      // Poll each registered connection once
      for (const [, conn] of this.connections) {
        this.pollConnection(conn).catch(() => {});
      }

      // Build aggregate per session
      for (const [, state] of this.sessions) {
        this.buildSessionAggregate(state);
        state.lastSnapshot = null;
        if (shouldPersist) {
          this.checkpointSession(state.historyId);
        }
      }

      this.notifyAllSubscribers();
      if (shouldPersist) this.notifyHistoryChanged();
    } finally {
      this.tickInFlight = false;
    }
  }

  // ─── Per-connection getStats polling ───────────────────────────────────

  private async pollConnection(conn: ConnectionState): Promise<void> {
    if (conn.state !== "playing" && conn.state !== "reconnecting") return;

    // Force baseline if pending
    if (this.pendingBaselines.has(conn.connectionId)) {
      this.resetBaselines(conn);
      this.pendingBaselines.delete(conn.connectionId);
    }

    try {
      const stats = await conn.peerConnection.getStats();
      const now = Date.now();
      const monoNow = performance.now();

      let videoCumulative = 0;
      let audioCumulative = 0;
      let transportCumulative: number | null = null;
      let videoSsrc: number | null = null;
      let audioSsrc: number | null = null;
      let width: number | null = null;
      let height: number | null = null;
      let framesPerSecond: number | null = null;
      let droppedFrames: number | null = null;
      let packetsReceived: number | null = null;
      let packetsLost: number | null = null;
      let packetLossPercent: number | null = null;
      let rttMs: number | null = null;
      let jitterMs: number | null = null;
      let codec: string | null = null;
      let connectionType: "direct" | "turn" | null = null;

      const inboundRtp = conn.direction === "inbound" ? "inbound-rtp" : "outbound-rtp";
      const outboundRtp = conn.direction === "inbound" ? "outbound-rtp" : "outbound-rtp";

      for (const [, report] of stats) {
        // RTP streams
        if (report.type === inboundRtp || report.type === outboundRtp) {
          const kind = report.kind;
          const bytes = report.bytesReceived ?? report.bytesSent ?? 0;
          const ssrc = report.ssrc ?? null;
          const mid = report.mid ?? null;

          if (kind === "video") {
            videoCumulative = bytes;
            videoSsrc = ssrc;
            width = report.frameWidth ?? null;
            height = report.frameHeight ?? null;
            framesPerSecond = report.framesPerSecond ?? null;
            droppedFrames = report.framesDropped ?? null;
            packetsReceived = report.packetsReceived ?? null;
            packetsLost = report.packetsLost ?? null;
            codec = report.mimeType ?? null;
          } else if (kind === "audio") {
            audioCumulative = bytes;
            audioSsrc = ssrc;
            packetsReceived = report.packetsReceived ?? packetsReceived;
            packetsLost = report.packetsLost ?? packetsLost;
          }
        }

        // Candidate pair (transport)
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          transportCumulative = report.bytesReceived ?? report.bytesSent ?? null;
          rttMs = report.currentRoundTripTime ? report.currentRoundTripTime * 1000 : null;
          connectionType = report.localCandidateType === "relay" || report.remoteCandidateType === "relay" ? "turn" : "direct";
        }

        // Remote-inbound (packet loss from receiver reports)
        if (report.type === "remote-inbound-rtp") {
          const lost = report.packetsLost ?? 0;
          const total = (report.packetsLost ?? 0) + (report.packetsReceived ?? 0);
          if (total > 0) packetLossPercent = Math.round((lost / total) * 100);
          jitterMs = report.jitter ? report.jitter * 1000 : null;
        }
      }

      // Process video counter
      const videoRate = this.processCounter(conn, "video", videoCumulative, monoNow);

      // Process audio counter
      const audioRate = this.processCounter(conn, "audio", audioCumulative, monoNow);

      // Process transport counter
      let transportRate: number | null = null;
      if (transportCumulative !== null) {
        transportRate = this.processCounter(conn, "transport", transportCumulative, monoNow);
      }

      // Emit sampled markers
      this.emitSampledMarkers(conn, width, height, framesPerSecond, codec, connectionType, null, null);

      // Build sample
      const totalRate = videoRate + audioRate;
      conn.videoBitsPerSecond = videoRate;
      conn.audioBitsPerSecond = audioRate;
      conn.transportBitsPerSecond = transportRate ?? 0;

      if (totalRate > conn.peakBitsPerSecond) {
        conn.peakBitsPerSecond = totalRate;
      }

      // EWMA
      if (conn.state === "playing" && totalRate > 0) {
        if (!conn.ewmaInitialized) {
          conn.ewmaValue = totalRate;
          conn.ewmaLastRaw = totalRate;
          conn.ewmaInitialized = true;
        } else {
          conn.ewmaValue = totalRate * EWMA_ALPHA + conn.ewmaValue * (1 - EWMA_ALPHA);
          conn.ewmaLastRaw = totalRate;
        }
      }
      conn.ewmaSeries.push(conn.ewmaValue);
      if (conn.ewmaSeries.length > MAX_RAW_SAMPLES) {
        conn.ewmaSeries = conn.ewmaSeries.slice(-MAX_RAW_SAMPLES);
      }

      const sample: TelemetrySample = {
        timestampMs: now,
        monotonicTimestampMs: monoNow,
        intervalMs: SAMPLE_INTERVAL_MS,
        mediaBitsPerSecond: totalRate,
        transportBitsPerSecond: transportRate,
        cumulativeMediaBytes: conn.totalVideoBytes + conn.totalAudioBytes,
        cumulativeTransportBytes: transportCumulative ? conn.totalTransportBytes : null,
        configuredVideoBitsPerSecond: conn.configuredVideoBitsPerSecond,
        effectiveVideoBitsPerSecond: conn.effectiveVideoBitsPerSecond,
        width,
        height,
        framesPerSecond,
        packetLossPercent,
        rttMs,
        jitterMs,
        codec,
        connectionType,
        state: conn.state,
      };

      conn.rawSamples.push(sample);
      if (conn.rawSamples.length > MAX_RAW_SAMPLES) {
        conn.rawSamples = conn.rawSamples.slice(-MAX_RAW_SAMPLES);
      }

      // Aggregate into buckets
      this.aggregateSample(conn, sample);

    } catch (err) {
      console.warn("[StreamMetricsService] getStats failed:", err);
    }
  }

  private processCounter(
    conn: ConnectionState,
    kind: "video" | "audio" | "transport",
    cumulativeBytes: number,
    monoNow: number,
  ): number {
    const baseline = kind === "video" ? conn.videoBaseline
      : kind === "audio" ? conn.audioBaseline
      : conn.transportBaseline;

    if (!baseline.initialized) {
      baseline.initialized = true;
      baseline.previousCumulativeBytes = cumulativeBytes;
      baseline.previousMonotonicTimestamp = monoNow;
      return 0;
    }

    // Counter reset detection
    if (cumulativeBytes < baseline.previousCumulativeBytes) {
      baseline.previousCumulativeBytes = cumulativeBytes;
      baseline.previousMonotonicTimestamp = monoNow;
      return 0;
    }

    const deltaBytes = cumulativeBytes - baseline.previousCumulativeBytes;
    const elapsedSeconds = (monoNow - baseline.previousMonotonicTimestamp) / 1000;

    if (elapsedSeconds <= 0) return 0;

    const bitsPerSecond = Math.round((deltaBytes * 8) / elapsedSeconds);

    // Accumulate
    if (kind === "video") conn.totalVideoBytes += deltaBytes;
    else if (kind === "audio") conn.totalAudioBytes += deltaBytes;
    else conn.totalTransportBytes += deltaBytes;

    baseline.previousCumulativeBytes = cumulativeBytes;
    baseline.previousMonotonicTimestamp = monoNow;

    return bitsPerSecond;
  }

  private resetBaselines(conn: ConnectionState): void {
    conn.videoBaseline = makeBaseline();
    conn.audioBaseline = makeBaseline();
    conn.transportBaseline = makeBaseline();
  }

  private emitSampledMarkers(
    conn: ConnectionState,
    width: number | null,
    height: number | null,
    fps: number | null,
    codec: string | null,
    connectionType: "direct" | "turn" | null,
    configuredBps: number | null,
    effectiveBps: number | null,
  ): void {
    const res = width && height ? `${width}x${height}` : null;
    if (res && res !== conn.lastResolution) {
      if (conn.lastResolution !== null) {
        this.addConnectionMarker(conn, "resolution", conn.lastResolution, res, `Resolution: ${res}`);
      }
      conn.lastResolution = res;
    }

    if (fps !== null && fps !== conn.lastFps) {
      if (conn.lastFps !== null) {
        this.addConnectionMarker(conn, "fps", String(conn.lastFps), String(fps), `FPS: ${fps}`);
      }
      conn.lastFps = fps;
    }

    if (codec && codec !== conn.lastCodec) {
      if (conn.lastCodec !== null) {
        this.addConnectionMarker(conn, "codec", conn.lastCodec, codec, `Codec: ${codec}`);
      }
      conn.lastCodec = codec;
    }

    if (connectionType && connectionType !== conn.lastConnectionType) {
      if (conn.lastConnectionType !== null) {
        this.addConnectionMarker(conn, "turn", conn.lastConnectionType, connectionType,
          connectionType === "direct" ? "Connection: Direct" : "Connection: TURN relay");
      }
      conn.lastConnectionType = connectionType;
    }
  }

  // ─── Bucket aggregation ───────────────────────────────────────────────

  private aggregateSample(conn: ConnectionState, sample: TelemetrySample): void {
    this.aggregateInto(conn, "medium", sample, MEDIUM_BUCKET_SIZE_MS, MAX_MEDIUM_BUCKETS);
    this.aggregateInto(conn, "long", sample, LONG_BUCKET_SIZE_MS, MAX_LONG_BUCKETS);
  }

  private aggregateInto(
    conn: ConnectionState,
    tier: "medium" | "long",
    sample: TelemetrySample,
    bucketSize: number,
    maxBuckets: number,
  ): void {
    const buckets = tier === "medium" ? conn.mediumBuckets : conn.longBuckets;
    const meta = tier === "medium" ? conn.mediumBucketMeta : conn.longBucketMeta;
    const bucketStart = Math.floor(sample.monotonicTimestampMs / bucketSize) * bucketSize;

    const prevBytes = meta.get(bucketStart)
      ?? (buckets.length > 0 ? meta.get(buckets[buckets.length - 1].startTimestampMs) ?? 0 : 0);

    const deltaBytes = Math.max(0, sample.cumulativeMediaBytes - prevBytes);

    const existingBucket = buckets.length > 0 && buckets[buckets.length - 1].startTimestampMs === bucketStart
      ? buckets[buckets.length - 1]
      : null;

    if (existingBucket) {
      existingBucket.byteDelta += deltaBytes;
      existingBucket.endTimestampMs = sample.monotonicTimestampMs;
      existingBucket.intervalMs = existingBucket.endTimestampMs - existingBucket.startTimestampMs;
      existingBucket.maxBitsPerSecond = Math.max(existingBucket.maxBitsPerSecond, sample.mediaBitsPerSecond);
      existingBucket.minBitsPerSecond = Math.min(existingBucket.minBitsPerSecond, sample.mediaBitsPerSecond);
      existingBucket.weightedAverageBitsPerSecond = existingBucket.intervalMs > 0
        ? Math.round((existingBucket.byteDelta * 8000) / existingBucket.intervalMs)
        : sample.mediaBitsPerSecond;
      existingBucket.width = sample.width ?? existingBucket.width;
      existingBucket.height = sample.height ?? existingBucket.height;
      existingBucket.framesPerSecond = sample.framesPerSecond ?? existingBucket.framesPerSecond;
      existingBucket.state = sample.state;
      existingBucket.codec = sample.codec ?? existingBucket.codec;
      existingBucket.connectionType = sample.connectionType ?? existingBucket.connectionType;
    } else {
      const newBucket: AggregatedBucket = {
        startTimestampMs: bucketStart,
        endTimestampMs: sample.monotonicTimestampMs,
        intervalMs: sample.monotonicTimestampMs - bucketStart,
        minBitsPerSecond: sample.mediaBitsPerSecond,
        maxBitsPerSecond: sample.mediaBitsPerSecond,
        weightedAverageBitsPerSecond: sample.mediaBitsPerSecond,
        byteDelta: deltaBytes,
        width: sample.width,
        height: sample.height,
        framesPerSecond: sample.framesPerSecond,
        state: sample.state,
        codec: sample.codec,
        connectionType: sample.connectionType,
      };
      buckets.push(newBucket);
      meta.set(bucketStart, sample.cumulativeMediaBytes);

      while (buckets.length > maxBuckets) {
        const removed = buckets.shift()!;
        meta.delete(removed.startTimestampMs);
      }
    }
  }

  // ─── Session aggregate ────────────────────────────────────────────────

  private buildSessionAggregate(state: SessionState): void {
    let totalBytes = 0;
    let peakBitsPerSecond = 0;

    for (const conn of state.connections.values()) {
      totalBytes += conn.totalVideoBytes + conn.totalAudioBytes;
      if (conn.peakBitsPerSecond > peakBitsPerSecond) {
        peakBitsPerSecond = conn.peakBitsPerSecond;
      }
    }

    state.totalBytes = totalBytes;
    state.peakBitsPerSecond = peakBitsPerSecond;
  }

  // ─── Snapshot building ────────────────────────────────────────────────

  private buildSnapshot(state: SessionState): BandwidthSnapshot {
    // Build aggregate series from all connections
    const allRawSamples: TelemetrySample[] = [];
    const allMediumBuckets: AggregatedBucket[] = [];
    const allLongBuckets: AggregatedBucket[] = [];
    const allMarkers: TelemetryMarker[] = [...state.markers];
    const allConnections: ConnectionTelemetrySnapshot[] = [];

    for (const conn of state.connections.values()) {
      allRawSamples.push(...conn.rawSamples);
      allMediumBuckets.push(...conn.mediumBuckets);
      allLongBuckets.push(...conn.longBuckets);
      allMarkers.push(...conn.markers);

      const connActiveMs = this.computeActiveDuration(conn);
      const totalObservedBits = (conn.totalVideoBytes + conn.totalAudioBytes) * 8;

      const connSnapshot: ConnectionTelemetrySnapshot = {
        connectionId: conn.connectionId,
        viewerDeviceId: conn.viewerDeviceId,
        displayName: conn.displayName,
        receivedStatus: conn.receivedStatus,
        rawSamples: Object.freeze([...conn.rawSamples]),
        mediumBuckets: Object.freeze(this.epochAdjust(conn, conn.mediumBuckets)),
        longBuckets: Object.freeze(this.epochAdjust(conn, conn.longBuckets)),
        markers: Object.freeze([...conn.markers]),
        currentBitsPerSecond: conn.videoBitsPerSecond + conn.audioBitsPerSecond,
        averageBitsPerSecond: connActiveMs > 0
          ? Math.round(totalObservedBits / (connActiveMs / 1000))
          : 0,
        peakBitsPerSecond: conn.peakBitsPerSecond,
        totalBytes: conn.totalVideoBytes + conn.totalAudioBytes,
        durationMs: this.computeDuration(conn),
        activeDurationMs: connActiveMs,
        configuredBitsPerSecond: conn.configuredVideoBitsPerSecond,
        effectiveBitsPerSecond: conn.effectiveVideoBitsPerSecond,
        state: conn.state,
      };
      allConnections.push(Object.freeze(connSnapshot));
    }

    // Sort samples by timestamp
    allRawSamples.sort((a, b) => a.monotonicTimestampMs - b.monotonicTimestampMs);
    allMarkers.sort((a, b) => a.timestampMs - b.timestampMs);

    const activeDurationMs = this.computeSessionActiveDuration(state);
    const totalObservedBits = state.totalBytes * 8;
    const latestSample = allRawSamples[allRawSamples.length - 1];

    const aggregate: TelemetrySeriesSnapshot = {
      rawSamples: Object.freeze(allRawSamples),
      mediumBuckets: Object.freeze(this.epochAdjustSession(state, allMediumBuckets)),
      longBuckets: Object.freeze(this.epochAdjustSession(state, allLongBuckets)),
      markers: Object.freeze(allMarkers),
      currentBitsPerSecond: latestSample?.mediaBitsPerSecond ?? 0,
      averageBitsPerSecond: activeDurationMs > 0
        ? Math.round(totalObservedBits / (activeDurationMs / 1000))
        : 0,
      peakBitsPerSecond: state.peakBitsPerSecond,
      totalBytes: state.totalBytes,
      durationMs: performance.now() - state.startedAtMonotonic,
      activeDurationMs,
      configuredBitsPerSecond: state.configuredBitsPerSecond,
      effectiveBitsPerSecond: state.effectiveBitsPerSecond,
      state: state.state,
    };

    return Object.freeze({
      historyId: state.historyId,
      role: state.role,
      aggregate,
      connections: Object.freeze(allConnections),
    });
  }

  private computeDuration(conn: ConnectionState): number {
    return performance.now() - conn.rawSamples[0]?.monotonicTimestampMs ?? performance.now();
  }

  private computeActiveDuration(conn: ConnectionState): number {
    const total = this.computeDuration(conn);
    let pauseAdjust = conn.totalPausedMs;
    if (conn.pausedAtMonotonic !== null) {
      pauseAdjust += performance.now() - conn.pausedAtMonotonic;
    }
    return Math.max(0, total - pauseAdjust);
  }

  private computeSessionActiveDuration(state: SessionState): number {
    const total = performance.now() - state.startedAtMonotonic;
    let maxPause = 0;
    for (const conn of state.connections.values()) {
      let pause = conn.totalPausedMs;
      if (conn.pausedAtMonotonic !== null) {
        pause += performance.now() - conn.pausedAtMonotonic;
      }
      if (pause > maxPause) maxPause = pause;
    }
    return Math.max(0, total - maxPause);
  }

  private epochAdjust(conn: ConnectionState, buckets: AggregatedBucket[]): AggregatedBucket[] {
    if (buckets.length === 0) return [];
    const firstSample = conn.rawSamples[0];
    if (!firstSample) return buckets;
    const offset = firstSample.timestampMs - firstSample.monotonicTimestampMs;
    return buckets.map((b) => ({
      ...b,
      startTimestampMs: b.startTimestampMs + offset,
      endTimestampMs: b.endTimestampMs + offset,
    }));
  }

  private epochAdjustSession(state: SessionState, buckets: AggregatedBucket[]): AggregatedBucket[] {
    if (buckets.length === 0) return [];
    const offset = state.startedAt - state.startedAtMonotonic;
    return buckets.map((b) => ({
      ...b,
      startTimestampMs: b.startTimestampMs + offset,
      endTimestampMs: b.endTimestampMs + offset,
    }));
  }

  // ─── Checkpoint ───────────────────────────────────────────────────────

  checkpointSession(historyId: string): void {
    const state = this.sessions.get(historyId);
    if (!state) return;
    state.lastCheckpointAt = Date.now();
    this.checkpointPersistence(state);
  }

  private checkpointPersistence(state: SessionState): void {
    this.persistSession(state).catch(() => {});
  }

  // ─── Persistence (schema v2) ──────────────────────────────────────────

  private async persistSession(state: SessionState): Promise<void> {
    const snapshot = this.buildSnapshot(state);

    const record: PersistenceRecordV2 = {
      schemaVersion: 2,
      historyId: state.historyId,
      role: state.role,
      startedAt: state.startedAt,
      stoppedAt: state.status === "active" ? null : Date.now(),
      durationMs: snapshot.aggregate.durationMs,
      activeDurationMs: snapshot.aggregate.activeDurationMs,
      totalBytes: state.totalBytes,
      peakBitsPerSecond: state.peakBitsPerSecond,
      configuredBitsPerSecond: snapshot.aggregate.configuredBitsPerSecond,
      effectiveBitsPerSecond: snapshot.aggregate.effectiveBitsPerSecond,
      rawSamples: [...snapshot.aggregate.rawSamples],
      mediumBuckets: [...snapshot.aggregate.mediumBuckets],
      longBuckets: [...snapshot.aggregate.longBuckets],
      connections: snapshot.connections.map((c) => ({ ...c })),
      markers: [...snapshot.aggregate.markers],
      status: state.status,
    };

    await this.upsertRecord(record);
  }

  private async upsertRecord(record: PersistenceRecordV2): Promise<void> {
    try {
      const api = (
        window as unknown as {
          screenlink?: {
            upsertStreamHistory?: (record: unknown) => Promise<void>;
            getStreamHistory?: () => Promise<unknown[]>;
            saveStreamHistory?: (r: unknown[]) => Promise<void>;
          };
        }
      ).screenlink;

      if (api?.upsertStreamHistory) {
        await api.upsertStreamHistory(record);
      } else if (api?.getStreamHistory && api?.saveStreamHistory) {
        const existing = await api.getStreamHistory();
        const idx = existing.findIndex(
          (r: unknown) => (r as Record<string, unknown>).historyId === record.historyId
        );
        if (idx >= 0) existing[idx] = record;
        else existing.push(record);
        await api.saveStreamHistory(existing);
      }
    } catch {
      console.warn("[StreamMetricsService] Failed to upsert history record");
    }
  }

  // ─── Schema migration ─────────────────────────────────────────────────

  private maybeMigrateRecord(legacy: LegacyHistoryRecord): StreamHistoryRecord {
    if (legacy.schemaVersion === 2) {
      return this.v2ToRecord(legacy as unknown as PersistenceRecordV2);
    }

    // V1 → V2 migration
    const record: StreamHistoryRecord = {
      historyId: legacy.historyId,
      role: legacy.role,
      status: (legacy.status ?? "completed") as StreamHistoryRecord["status"],
      mediaSessionId: legacy.mediaSessionId ?? "",
      logicalStreamId: legacy.logicalStreamId ?? "",
      groupId: legacy.groupId ?? "",
      groupName: legacy.groupName ?? "",
      remoteDisplayName: legacy.remoteDisplayName ?? null,
      startedAt: legacy.startedAt,
      lastCheckpointAt: legacy.lastCheckpointAt ?? legacy.startedAt,
      stoppedAt: legacy.stoppedAt ?? null,
      durationMs: legacy.durationMs ?? 0,
      totalBytes: legacy.totalBytes,
      averageBytesPerSecond: legacy.averageBytesPerSecond
        ? legacy.averageBytesPerSecond * 8 // bytes/s → bits/s
        : legacy.bytesPerSecond
          ? legacy.bytesPerSecond * 8
          : 0,
      presetName: legacy.presetName ?? null,
      customQuality: legacy.customQuality ?? false,
      samples: (legacy.samples ?? []).map((s) => ({
        timestamp: s.timestamp,
        bytesPerSecond: s.bytesPerSecond,
        totalBytes: s.totalBytes,
      })),
      markers: (legacy.markers ?? []).map((m) => ({
        timestamp: m.timestamp,
        category: m.category,
        from: m.from,
        to: m.to,
        label: m.label,
      })),
      interrupted: legacy.interrupted ?? false,
    };

    return record;
  }

  private v2ToRecord(_v2: PersistenceRecordV2): StreamHistoryRecord {
    // V2 records can be stored directly, but for API compatibility return a StreamHistoryRecord
    return {
      historyId: _v2.historyId,
      role: _v2.role,
      status: _v2.status,
      mediaSessionId: _v2.mediaSessionId ?? "",
      logicalStreamId: "",
      groupId: _v2.groupId ?? "",
      groupName: _v2.groupName ?? "",
      remoteDisplayName: null,
      startedAt: _v2.startedAt,
      lastCheckpointAt: _v2.startedAt,
      stoppedAt: _v2.stoppedAt,
      durationMs: _v2.durationMs,
      totalBytes: _v2.totalBytes,
      averageBytesPerSecond: _v2.activeDurationMs > 0
        ? Math.round((_v2.totalBytes * 8000) / _v2.activeDurationMs)
        : 0,
      presetName: null,
      customQuality: false,
      samples: [],
      markers: _v2.markers.map((m) => ({
        timestamp: m.timestampMs,
        category: m.type,
        from: m.from,
        to: m.to,
        label: m.label,
      })),
      interrupted: _v2.status === "interrupted",
    };
  }

  // ─── Subscriber notification ──────────────────────────────────────────

  private notifySessionSubscribers(historyId: string): void {
    const cbs = this.subscribers.get(historyId);
    if (cbs) {
      for (const cb of cbs) {
        try { cb(); } catch { /* swallow */ }
      }
    }
  }

  private notifyAllSubscribers(): void {
    for (const [historyId] of this.subscribers) {
      if (this.sessions.has(historyId)) {
        this.notifySessionSubscribers(historyId);
      }
    }
  }

  private notifyHistoryChanged(): void {
    this.onHistoryChanged?.();
  }

  // ─── ID generation ────────────────────────────────────────────────────

  private generateId(): string {
    if (typeof globalThis !== "undefined" && typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeBaseline(): CounterBaseline {
  return {
    initialized: false,
    identity: { reportId: "", ssrc: null, trackIdentifier: null, mid: null },
    previousCumulativeBytes: 0,
    previousMonotonicTimestamp: 0,
  };
}

function emptySnapshot(historyId: string): BandwidthSnapshot {
  return Object.freeze({
    historyId,
    role: "viewer" as const,
    aggregate: Object.freeze({
      rawSamples: Object.freeze([]),
      mediumBuckets: Object.freeze([]),
      longBuckets: Object.freeze([]),
      markers: Object.freeze([]),
      currentBitsPerSecond: 0,
      averageBitsPerSecond: 0,
      peakBitsPerSecond: 0,
      totalBytes: 0,
      durationMs: 0,
      activeDurationMs: 0,
      configuredBitsPerSecond: null,
      effectiveBitsPerSecond: null,
      state: "paused" as TelemetryState,
    }),
    connections: Object.freeze([]),
  });
}

// ─── StreamHistoryRecord (API compatibility) ────────────────────────────────

export interface StreamHistoryRecord {
  historyId: string;
  role: "host" | "viewer";
  status: "active" | "completed" | "interrupted";
  mediaSessionId: string;
  logicalStreamId: string;
  groupId: string;
  groupName: string;
  remoteDisplayName: string | null;
  startedAt: number;
  lastCheckpointAt: number;
  stoppedAt: number | null;
  durationMs: number;
  totalBytes: number;
  averageBytesPerSecond: number;
  presetName: string | null;
  customQuality: boolean;
  samples: Array<{ timestamp: number; bytesPerSecond: number; totalBytes: number }>;
  markers: Array<{ timestamp: number; category: string; from: string | null; to: string; label: string }>;
  interrupted: boolean;
}
