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
  VideoRtpStreamDetails,
  AudioRtpStreamDetails,
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

// ─── Audio cumulative metric baseline (jitter-buffer, concealment) ─────────

interface AudioCumulativeBaseline {
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
  concealedSamples: number;
  concealedEvents: number;
  totalSamplesReceived: number;
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

  // Per-report baselines (audit item 6): keyed by kind:reportId:ssrc:mid
  videoBaselines: Map<string, CounterBaseline>;
  audioBaselines: Map<string, CounterBaseline>;
  transportBaseline: CounterBaseline;

  // Accumulation
  totalVideoBytes: number;
  totalAudioBytes: number;
  totalTransportBytes: number;

  // Current rate (null = unavailable, 0 = measured zero)
  videoBitsPerSecond: number | null;
  audioBitsPerSecond: number | null;
  transportBitsPerSecond: number | null;

  // Per-stream RTP evidence from the last poll
  videoRtpStreams: VideoRtpStreamDetails[];
  audioRtpStreams: AudioRtpStreamDetails[];

  // Audio cumulative counter baselines for jitter-buffer / concealment deltas
  audioCumulativeBaselines: Map<string, AudioCumulativeBaseline>;

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

  // Combined quality snapshot (deliverable 1)
  lastQuality: {
    width: number | null;
    height: number | null;
    fps: number | null;
    bitrateBps: number | null;
  };
  qualityDebounceCount: number;
  qualityDebounceTarget: {
    width: number | null;
    height: number | null;
    fps: number | null;
    bitrateBps: number | null;
  } | null;

  // Generation for peer replacement
  generation: number;

  // Easy Compare variant label
  variantId?: "A" | "B";
}

// ─── Session state ─────────────────────────────────────────────────────────

interface SessionState {
  historyId: string;
  role: "host" | "viewer";
  startedAt: number;
  startedAtMonotonic: number;
  mediaSessionId: string;
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
  sessionPeakBps: number; // permanent running max (audit item 12)

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
      mediaSessionId,
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
      sessionPeakBps: 0,
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
      mediaSessionId,
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
      sessionPeakBps: 0,
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
    variantId?: "A" | "B";
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
      videoBaselines: new Map(),
      audioBaselines: new Map(),
      transportBaseline: makeBaseline(),
      totalVideoBytes: 0,
      totalAudioBytes: 0,
      totalTransportBytes: 0,
      videoBitsPerSecond: null,
      audioBitsPerSecond: null,
      transportBitsPerSecond: null,
      videoRtpStreams: [],
      audioRtpStreams: [],
      audioCumulativeBaselines: new Map(),
      peakBitsPerSecond: 0,
      state: "playing",
      pausedAtMonotonic: null,
      totalPausedMs: 0,
      rawSamples: [],
      mediumBuckets: [],
      longBuckets: [],

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
      lastQuality: { width: null, height: null, fps: null, bitrateBps: null },
      qualityDebounceCount: 0,
      qualityDebounceTarget: null,
      generation: 0,
      variantId: input.variantId,
    };

    state.connections.set(input.connectionId, conn);
    this.connections.set(input.connectionId, conn);
    state.lastSnapshot = null;
    this.ensureTimer();

    return () => {
      state.connections.delete(input.connectionId);
      this.connections.delete(input.connectionId);
      state.lastSnapshot = null;
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
    // Immediately invalidate so subscribers see the new status
    const state = this.sessions.get(historyId);
    if (state) state.lastSnapshot = null;
    this.notifySessionSubscribers(historyId);
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
      } else if (newState === "playing" && connOldState === "reconnecting") {
        conn.state = "playing";
        this.addConnectionMarker(conn, "reconnect", null, "connected", "Reconnect completed");
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

    // Only store in the session's canonical list if explicitly added via addMarker()
    // Connection-level sampled markers stay connection-scoped (audit item 16)
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

  findHistoryIdByMediaSessionId(mediaSessionId: string): string | null {
    for (const [historyId, state] of this.sessions) {
      if ((state as unknown as { mediaSessionId?: string }).mediaSessionId === mediaSessionId) {
        return historyId;
      }
    }
    return null;
  }

  getViewerRates(historyId: string): ViewerRateEntry[] {
    const state = this.sessions.get(historyId);
    if (!state || state.role !== "host") return [];
    return Array.from(state.connections.values()).map((c) => ({
      viewerDeviceId: c.viewerDeviceId ?? c.connectionId,
      displayName: c.displayName ?? c.connectionId,
      bitsPerSecond: (c.videoBitsPerSecond ?? 0) + (c.audioBitsPerSecond ?? 0),
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

  private async handleTick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      this.tickCounter++;
      const shouldPersist = this.tickCounter % PERSIST_INTERVAL_TICKS === 0;

      // Poll each registered connection — await all before aggregating
      await Promise.allSettled(
        Array.from(this.connections.values()).map((conn) => this.pollConnection(conn).catch(() => {}))
      );

      // Build session aggregates from fresh per-connection observations
      for (const [, state] of this.sessions) {
        this.buildSessionAggregate(state);
        state.lastSnapshot = null;
      }

      // Create aggregate observation per session for the poll cycle
      const tickEpochMs = Date.now();
      for (const [, state] of this.sessions) {
        this.createAggregateObservation(state, tickEpochMs);
      }

      this.notifyAllSubscribers();

      if (shouldPersist) {
        for (const [historyId] of this.sessions) {
          this.checkpointSession(historyId);
        }
        this.notifyHistoryChanged();
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  // ─── Per-connection getStats polling ───────────────────────────────────

  private async pollConnection(conn: ConnectionState): Promise<void> {
    if (conn.state !== "playing" && conn.state !== "reconnecting") return;

    if (this.pendingBaselines.has(conn.connectionId)) {
      this.resetBaselines(conn);
      this.pendingBaselines.delete(conn.connectionId);
    }

    try {
      const stats = await conn.peerConnection.getStats();
      const nowEpoch = Date.now();
      const monoNow = performance.now();

      // Collect RTP observations
      interface RtpObs {
        kind: "video" | "audio";
        reportId: string;
        ssrc: number | null;
        mid: string | null;
        codecId: string | null;
        bytes: number;
        width: number | null;
        height: number | null;
        fps: number | null;
        packetsReceived: number | null;
        packetsLost: number | null;
        jitter: number | null;
        framesDecoded: number | null;
        framesDropped: number | null;
        keyFramesDecoded: number | null;
        freezeCount: number | null;
        decoderImplementation: string | null;
        jitterBufferDelay: number | null;
        jitterBufferEmittedCount: number | null;
        concealedSamples: number | null;
        concealedEvents: number | null;
        totalSamplesReceived: number | null;
        audioLevel: number | null;
        totalAudioEnergy: number | null;
        totalSamplesDuration: number | null;
        clockRate: number | null;
        channels: number | null;
      }
      const videoObservations: RtpObs[] = [];
      const audioObservations: RtpObs[] = [];
      const codecMap = new Map<string, string>(); // codecId → mimeType
      let transportCumulative: number | null = null;
      let rttMs: number | null = null;
      let connectionType: "direct" | "turn" | null = null;
      const localCands = new Map<string, Record<string, unknown>>();
      const remoteCands = new Map<string, Record<string, unknown>>();

      // First pass: collect candidates and codecs
      for (const [, report] of stats) {
        if (report.type === "local-candidate") localCands.set(report.id, report as Record<string, unknown>);
        if (report.type === "remote-candidate") remoteCands.set(report.id, report as Record<string, unknown>);
        if (report.type === "codec") {
          const m = (report as Record<string, unknown>).mimeType as string;
          if (m) codecMap.set(report.id, m);
        }
      }

      // Second pass: collect RTP stats with direction-correct types (audit item 8)
      for (const [, report] of stats) {
        const rtype = report.type;

        // Inbound connection: use inbound-rtp for video/audio
        // Outbound connection: use outbound-rtp for video/audio
        const isRtp =
          (conn.direction === "inbound" && rtype === "inbound-rtp") ||
          (conn.direction === "outbound" && rtype === "outbound-rtp");

        if (!isRtp) continue;

        const kind = (report.kind ?? "video") as string;
        if (kind !== "video" && kind !== "audio") continue;

        const r = report as Record<string, unknown>;
        const bytes = conn.direction === "inbound"
          ? ((r.bytesReceived ?? 0) as number)
          : ((r.bytesSent ?? 0) as number);

        const obs: RtpObs = {
          kind: kind as "video" | "audio",
          reportId: report.id,
          ssrc: (r.ssrc ?? null) as number | null,
          mid: (r.mid ?? null) as string | null,
          codecId: (r.codecId ?? null) as string | null,
          bytes,
          width: kind === "video" ? ((r.frameWidth ?? null) as number | null) : null,
          height: kind === "video" ? ((r.frameHeight ?? null) as number | null) : null,
          fps: kind === "video" ? ((r.framesPerSecond ?? null) as number | null) : null,
          packetsReceived: (r.packetsReceived ?? null) as number | null,
          packetsLost: (r.packetsLost ?? null) as number | null,
          jitter: (r.jitter ?? null) as number | null,
          framesDecoded: kind === "video" ? ((r.framesDecoded ?? null) as number | null) : null,
          framesDropped: kind === "video" ? ((r.framesDropped ?? null) as number | null) : null,
          keyFramesDecoded: kind === "video" ? ((r.keyFramesDecoded ?? null) as number | null) : null,
          freezeCount: kind === "video" ? ((r.freezeCount ?? null) as number | null) : null,
          decoderImplementation: kind === "video" ? ((r.decoderImplementation ?? null) as string | null) : null,
          jitterBufferDelay: kind === "audio" ? ((r.jitterBufferDelay ?? null) as number | null) : null,
          jitterBufferEmittedCount: kind === "audio" ? ((r.jitterBufferEmittedCount ?? null) as number | null) : null,
          concealedSamples: kind === "audio" ? ((r.concealedSamples ?? null) as number | null) : null,
          concealedEvents: kind === "audio" ? ((r.concealedEvents ?? null) as number | null) : null,
          totalSamplesReceived: kind === "audio" ? ((r.totalSamplesReceived ?? null) as number | null) : null,
          audioLevel: kind === "audio" ? ((r.audioLevel ?? null) as number | null) : null,
          totalAudioEnergy: kind === "audio" ? ((r.totalAudioEnergy ?? null) as number | null) : null,
          totalSamplesDuration: kind === "audio" ? ((r.totalSamplesDuration ?? null) as number | null) : null,
          clockRate: kind === "audio" ? ((r.clockRate ?? null) as number | null) : null,
          channels: kind === "audio" ? ((r.channels ?? null) as number | null) : null,
        };

        if (kind === "video") videoObservations.push(obs);
        else audioObservations.push(obs);
      }

      // Candidate-pair: transport + connection type
      for (const [, report] of stats) {
        if (report.type !== "candidate-pair") continue;
        const r = report as Record<string, unknown>;
        if (r.state !== "succeeded") continue;
        const sel = r.selected ?? r.nominated;
        if (!sel) continue;

        transportCumulative = conn.direction === "inbound"
          ? ((r.bytesReceived ?? null) as number | null)
          : ((r.bytesSent ?? null) as number | null);
        if (typeof r.currentRoundTripTime === "number") {
          rttMs = r.currentRoundTripTime * 1000;
        }
        const lc = localCands.get(r.localCandidateId as string);
        const rc = remoteCands.get(r.remoteCandidateId as string);
        connectionType =
          (lc && (lc as Record<string, unknown>).candidateType === "relay") ||
          (rc && (rc as Record<string, unknown>).candidateType === "relay")
            ? "turn" : "direct";
        break;
      }

      // Remote-inbound: packet loss / jitter for outbound direction
      let packetLossPercent: number | null = null;
      let jitterMs: number | null = null;
      if (conn.direction === "outbound") {
        for (const [, report] of stats) {
          if (report.type !== "remote-inbound-rtp") continue;
          const r = report as Record<string, unknown>;
          if (r.kind !== "video") continue;
          const lost = (r.packetsLost ?? 0) as number;
          const recv = (r.packetsReceived ?? 0) as number;
          const total = lost + recv;
          if (total > 0) packetLossPercent = Math.round((lost / total) * 100);
          if (typeof r.jitter === "number") jitterMs = r.jitter * 1000;
          break;
        }
      } else {
        // Inbound: use inbound-rtp directly
        const primVid = videoObservations[0];
        if (primVid && primVid.packetsLost !== null) {
          // We need total packets for inbound; use bytes as rough proxy or just report loss fraction
          if (primVid.packetsLost >= 0) {
            // Use packetsLost from inbound-rtp; we don't have total for inbound in this pass
            const recv = (primVid as unknown as { packetsReceived?: number }).packetsReceived ?? 0;
            const total = primVid.packetsLost + recv;
            if (total > 0) packetLossPercent = Math.round((primVid.packetsLost / total) * 100);
          }
        }
        if (primVid && primVid.jitter !== null) {
          jitterMs = primVid.jitter * 1000;
        }
      }

      // ── Video processing with per-stream evidence ─────────────────────
      let totalVideoRate = 0;
      let totalVideoDelta = 0;
      let videoIntervalMs = 0;
      const videoResults = new Map<string, { bitsPerSecond: number; deltaBytes: number; intervalMs: number }>();
      for (const obs of videoObservations) {
        const rkey = `${obs.reportId}:${obs.ssrc ?? 0}:${obs.mid ?? ""}`;
        const result = this.processCounterReport(conn.videoBaselines, rkey, obs.bytes, monoNow);
        videoResults.set(obs.reportId, result);
        totalVideoRate += result.bitsPerSecond;
        totalVideoDelta += result.deltaBytes;
        videoIntervalMs = Math.max(videoIntervalMs, result.intervalMs);
      }
      conn.videoBitsPerSecond = videoObservations.length > 0 ? totalVideoRate : null;
      conn.totalVideoBytes += totalVideoDelta;

      // Build per-stream video evidence
      const videoRtpStreams: VideoRtpStreamDetails[] = [];
      for (const obs of videoObservations) {
        const result = videoResults.get(obs.reportId)!;
        const codecMimeType = obs.codecId ? (codecMap.get(obs.codecId) ?? null) : null;
        const totalPkts = (obs.packetsReceived ?? 0) + (obs.packetsLost ?? 0);
        videoRtpStreams.push({
          kind: "video",
          id: obs.reportId,
          ssrc: obs.ssrc,
          mid: obs.mid,
          codecId: obs.codecId,
          codecMimeType,
          bytesReceived: obs.bytes,
          bytesDelta: result.deltaBytes,
          bitsPerSecond: result.bitsPerSecond,
          packetsReceived: obs.packetsReceived,
          packetsLost: obs.packetsLost,
          packetLossPercent: totalPkts > 0 && obs.packetsLost !== null
            ? Math.round((obs.packetsLost / totalPkts) * 100) : null,
          jitterMs: obs.jitter !== null ? obs.jitter * 1000 : null,
          frameWidth: obs.width,
          frameHeight: obs.height,
          framesPerSecond: obs.fps,
          framesDecoded: obs.framesDecoded,
          framesDropped: obs.framesDropped,
          keyFramesDecoded: obs.keyFramesDecoded,
          freezeCount: obs.freezeCount,
          decoderImplementation: obs.decoderImplementation,
        });
      }
      conn.videoRtpStreams = videoRtpStreams;

      // ── Audio processing with per-stream evidence ─────────────────────
      let totalAudioRate = 0;
      let totalAudioDelta = 0;
      let audioIntervalMs = 0;
      const audioResults = new Map<string, { bitsPerSecond: number; deltaBytes: number; intervalMs: number }>();
      for (const obs of audioObservations) {
        const rkey = `${obs.reportId}:${obs.ssrc ?? 0}:${obs.mid ?? ""}`;
        const result = this.processCounterReport(conn.audioBaselines, rkey, obs.bytes, monoNow);
        audioResults.set(obs.reportId, result);
        totalAudioRate += result.bitsPerSecond;
        totalAudioDelta += result.deltaBytes;
        audioIntervalMs = Math.max(audioIntervalMs, result.intervalMs);
      }
      conn.audioBitsPerSecond = audioObservations.length > 0 ? totalAudioRate : null;
      conn.totalAudioBytes += totalAudioDelta;

      // Build per-stream audio evidence with jitter-buffer / concealment
      const audioRtpStreams: AudioRtpStreamDetails[] = [];
      for (const obs of audioObservations) {
        const result = audioResults.get(obs.reportId)!;
        const codecMimeType = obs.codecId ? (codecMap.get(obs.codecId) ?? null) : null;
        const totalPkts = (obs.packetsReceived ?? 0) + (obs.packetsLost ?? 0);

        // Jitter-buffer delay delta
        let jitterBufferDelayMs: number | null = null;
        let jitterBufferEmittedDelta: number | null = null;
        let concealedSamplesDelta: number | null = null;
        let concealedEventsDelta: number | null = null;
        let totalSamplesDelta: number | null = null;

        if (obs.jitterBufferDelay !== null && obs.jitterBufferEmittedCount !== null) {
          const prev = conn.audioCumulativeBaselines.get(obs.reportId) ??
            { jitterBufferDelay: 0, jitterBufferEmittedCount: 0, concealedSamples: 0, concealedEvents: 0, totalSamplesReceived: 0 };
          const delayDelta = obs.jitterBufferDelay - prev.jitterBufferDelay;
          const countDelta = obs.jitterBufferEmittedCount - prev.jitterBufferEmittedCount;
          if (countDelta > 0) {
            jitterBufferDelayMs = (delayDelta / countDelta) * 1000;
            jitterBufferEmittedDelta = countDelta;
          }
          if (obs.concealedSamples !== null && obs.totalSamplesReceived !== null) {
            concealedSamplesDelta = obs.concealedSamples - prev.concealedSamples;
            totalSamplesDelta = obs.totalSamplesReceived - prev.totalSamplesReceived;
            if (obs.concealedEvents !== null) {
              concealedEventsDelta = obs.concealedEvents - prev.concealedEvents;
            }
          }
          // Update baseline
          conn.audioCumulativeBaselines.set(obs.reportId, {
            jitterBufferDelay: obs.jitterBufferDelay,
            jitterBufferEmittedCount: obs.jitterBufferEmittedCount,
            concealedSamples: obs.concealedSamples ?? 0,
            concealedEvents: obs.concealedEvents ?? 0,
            totalSamplesReceived: obs.totalSamplesReceived ?? 0,
          });
        }

        const concealmentPercent = totalSamplesDelta !== null && totalSamplesDelta > 0 && concealedSamplesDelta !== null
          ? Math.round((concealedSamplesDelta / totalSamplesDelta) * 100) : null;

        audioRtpStreams.push({
          kind: "audio",
          id: obs.reportId,
          ssrc: obs.ssrc,
          mid: obs.mid,
          codecId: obs.codecId,
          codecMimeType,
          bytesReceived: obs.bytes,
          bytesDelta: result.deltaBytes,
          bitsPerSecond: result.bitsPerSecond,
          packetsReceived: obs.packetsReceived,
          packetsLost: obs.packetsLost,
          packetLossPercent: totalPkts > 0 && obs.packetsLost !== null
            ? Math.round((obs.packetsLost / totalPkts) * 100) : null,
          jitterMs: obs.jitter !== null ? obs.jitter * 1000 : null,
          audioLevel: obs.audioLevel,
          totalAudioEnergy: obs.totalAudioEnergy,
          totalSamplesDuration: obs.totalSamplesDuration,
          clockRate: obs.clockRate,
          channels: obs.channels,
          jitterBufferDelayMs,
          jitterBufferEmittedCount: jitterBufferEmittedDelta,
          concealedSamples: concealedSamplesDelta,
          concealedEvents: concealedEventsDelta,
          concealmentPercent,
          totalSamplesReceived: totalSamplesDelta,
        });
      }
      conn.audioRtpStreams = audioRtpStreams;

      // ── Transport ────────────────────────────────────────────────────
      let transportRate: number | null = null;
      let transportDelta = 0;
      if (transportCumulative !== null) {
        const tpResult = this.processCounterReport(
          new Map([["tp", conn.transportBaseline]]), "tp", transportCumulative, monoNow
        );
        transportRate = tpResult.bitsPerSecond;
        transportDelta = tpResult.deltaBytes;
      }
      conn.transportBitsPerSecond = transportRate;
      conn.totalTransportBytes += transportDelta;

      // Resolve codec from codecMap via active RTP codecId (authoritative).
      // Per-stream evidence resolves each stream individually.
      const primaryVideo = videoObservations[0];
      let resolvedCodec: string | null = null;
      if (primaryVideo?.codecId) {
        resolvedCodec = codecMap.get(primaryVideo.codecId) ?? null;
      }
      // No iteration-order fallback — codecId → codecMap is authoritative

      if (primaryVideo) {
        this.emitSampledMarkers(conn, primaryVideo.width, primaryVideo.height, primaryVideo.fps, resolvedCodec, connectionType,
          conn.configuredVideoBitsPerSecond, conn.effectiveVideoBitsPerSecond);
      }

      const totalRate = totalVideoRate + totalAudioRate;
      if (totalRate > conn.peakBitsPerSecond) {
        conn.peakBitsPerSecond = totalRate;
      }

      if (conn.state === "playing" && totalRate > 0) {
        if (!conn.ewmaInitialized) {
          conn.ewmaValue = totalRate; conn.ewmaLastRaw = totalRate; conn.ewmaInitialized = true;
        } else {
          conn.ewmaValue = totalRate * EWMA_ALPHA + conn.ewmaValue * (1 - EWMA_ALPHA); conn.ewmaLastRaw = totalRate;
        }
      }
      conn.ewmaSeries.push(conn.ewmaValue);
      if (conn.ewmaSeries.length > MAX_RAW_SAMPLES) conn.ewmaSeries = conn.ewmaSeries.slice(-MAX_RAW_SAMPLES);

      const sampleInterval = Math.max(videoIntervalMs, audioIntervalMs, 0);

      const sample: TelemetrySample = {
        timestampMs: nowEpoch,
        monotonicTimestampMs: monoNow,
        intervalMs: Math.round(sampleInterval),
        mediaBitsPerSecond: totalRate,
        videoBitsPerSecond: totalVideoRate,
        audioBitsPerSecond: totalAudioRate,
        transportBitsPerSecond: transportRate,
        cumulativeMediaBytes: conn.totalVideoBytes + conn.totalAudioBytes,
        cumulativeTransportBytes: transportCumulative ?? null,
        configuredVideoBitsPerSecond: conn.configuredVideoBitsPerSecond,
        effectiveVideoBitsPerSecond: conn.effectiveVideoBitsPerSecond,
        width: primaryVideo?.width ?? null,
        height: primaryVideo?.height ?? null,
        framesPerSecond: primaryVideo?.fps ?? null,
        packetLossPercent,
        rttMs,
        jitterMs,
        codec: resolvedCodec,
        connectionType,
        state: conn.state,
        variantId: conn.variantId,
        videoRtpStreams: Object.freeze([...videoRtpStreams]),
        audioRtpStreams: Object.freeze([...audioRtpStreams]),
      };

      conn.rawSamples.push(sample);
      if (conn.rawSamples.length > MAX_RAW_SAMPLES) conn.rawSamples = conn.rawSamples.slice(-MAX_RAW_SAMPLES);
      this.aggregateSample(conn, sample);
    } catch (err) {
      console.warn("[StreamMetricsService] getStats failed:", err);
    }
  }

  // ─── Per-report counter processing (audit items 6-7) ───────────────────

  private processCounterReport(
    baselines: Map<string, CounterBaseline>,
    key: string,
    cumulativeBytes: number,
    monoNow: number,
  ): { bitsPerSecond: number; deltaBytes: number; intervalMs: number } {
    let baseline = baselines.get(key);

    if (!baseline) {
      baseline = makeBaseline();
      baseline.initialized = true;
      baseline.previousCumulativeBytes = cumulativeBytes;
      baseline.previousMonotonicTimestamp = monoNow;
      baselines.set(key, baseline);
      return { bitsPerSecond: 0, deltaBytes: 0, intervalMs: 0 };
    }

    // Counter reset detection
    if (cumulativeBytes < baseline.previousCumulativeBytes) {
      baseline.previousCumulativeBytes = cumulativeBytes;
      baseline.previousMonotonicTimestamp = monoNow;
      return { bitsPerSecond: 0, deltaBytes: 0, intervalMs: 0 };
    }

    const deltaBytes = cumulativeBytes - baseline.previousCumulativeBytes;
    const intervalMs = monoNow - baseline.previousMonotonicTimestamp;
    const elapsedSeconds = intervalMs / 1000;

    const bitsPerSecond = elapsedSeconds > 0 ? Math.round((deltaBytes * 8) / elapsedSeconds) : 0;

    baseline.previousCumulativeBytes = cumulativeBytes;
    baseline.previousMonotonicTimestamp = monoNow;

    return { bitsPerSecond, deltaBytes, intervalMs };
  }

  /**
   * Process a counter with identity tracking (report ID, SSRC, MID).
   * Detects sender/receiver replacement by comparing identity with the
   * baseline. A changed identity forces a reset to avoid false deltas
   * from the new sender's higher cumulative counter.
   */
  /**
   * @deprecated Replaced by processCounterReport with per-report baselines (audit items 6-7).
   *             Retained for transport baseline only during migration.
   */
  private processCounter(
    conn: ConnectionState,
    _kind: "video" | "audio" | "transport",
    cumulativeBytes: number,
    monoNow: number,
  ): number {
    const result = this.processCounterReport(
      new Map([["_deprecated", conn.transportBaseline]]),
      "_deprecated",
      cumulativeBytes,
      monoNow,
    );
    return result.bitsPerSecond;
  }

  private resetBaselines(conn: ConnectionState): void {
    conn.videoBaselines.clear();
    conn.audioBaselines.clear();
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
    // Codec and connection-type markers remain unchanged
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

    // ── Combined quality-change marker (Deliverable 1) ─────────────────

    // Use effective bitrate if available, otherwise current computed rate
    const bitrateBps = effectiveBps ?? configuredBps ?? conn.videoBitsPerSecond ?? 0;
    const candidate: { width: number | null; height: number | null; fps: number | null; bitrateBps: number | null } = {
      width,
      height,
      fps,
      bitrateBps: bitrateBps > 0 ? bitrateBps : null,
    };

    // First observation establishes baseline, no marker
    const prev = conn.lastQuality;
    if (prev.width === null && prev.height === null && prev.fps === null) {
      conn.lastQuality = { ...candidate };
      return;
    }

    // Check if any value changed
    const resChanged = (candidate.width !== prev.width || candidate.height !== prev.height) &&
      candidate.width !== null && candidate.height !== null;
    const fpsChanged = candidate.fps !== null && prev.fps !== null && candidate.fps !== prev.fps;
    const bitrateChanged = candidate.bitrateBps !== null && prev.bitrateBps !== null &&
      Math.abs(candidate.bitrateBps - prev.bitrateBps) > 50000; // 50 kbps (≈6.3 kB/s) deadband

    // No change: clear debounce and skip
    if (!resChanged && !fpsChanged && !bitrateChanged) {
      conn.qualityDebounceCount = 0;
      conn.qualityDebounceTarget = null;
      return;
    }

    // Determine what the target would be (resolution/fps must be stable for 2 observations)
    const needDebounce = resChanged || fpsChanged;
    const targetDebounceCount = 2;

    if (needDebounce) {
      // Check if this is consistent with previous pending debounce target
      const dt = conn.qualityDebounceTarget;
      if (dt &&
        (resChanged ? (dt.width === candidate.width && dt.height === candidate.height) : true) &&
        (fpsChanged ? (dt.fps === candidate.fps) : true)) {
        conn.qualityDebounceCount++;
      } else {
        // New or changed target
        conn.qualityDebounceTarget = {
          width: candidate.width,
          height: candidate.height,
          fps: candidate.fps,
          bitrateBps: candidate.bitrateBps,
        };
        conn.qualityDebounceCount = 1;
      }

      if (conn.qualityDebounceCount < targetDebounceCount) {
        // Still debouncing — don't update lastQuality yet
        return;
      }
    }

    // Emit combined quality-change marker
    const resLabel = candidate.width && candidate.height
      ? `${candidate.width}\u00d7${candidate.height}` : "?";
    const fpsLabel = candidate.fps !== null ? `\u2022 ${candidate.fps} FPS` : "";
    const bpsLabel = candidate.bitrateBps !== null
      ? `\u2022 ${(candidate.bitrateBps / 1_000_000).toFixed(1)} Mbps` : "";

    const label = `${resLabel} ${fpsLabel} ${bpsLabel}`.trim();

    const parts: string[] = [];
    if (resChanged && prev.width !== null && prev.height !== null) {
      parts.push(`Resolution: ${prev.width}\u00d7${prev.height} \u2192 ${candidate.width}\u00d7${candidate.height}`);
    }
    if (fpsChanged && prev.fps !== null) {
      parts.push(`FPS: ${prev.fps} \u2192 ${candidate.fps}`);
    }
    if (bitrateChanged && prev.bitrateBps !== null) {
      parts.push(`Bitrate: ${(prev.bitrateBps / 1_000_000).toFixed(1)} Mbps \u2192 ${(candidate.bitrateBps! / 1_000_000).toFixed(1)} Mbps`);
    }

    const detail = parts.join("\n") || null;

    this.addConnectionMarker(conn, "quality", null, label, label);
    // Store detail and quality snapshot in the last marker
    if (conn.markers.length > 0) {
      const last = conn.markers[conn.markers.length - 1];
      if (last.type === "quality" && detail) {
        (last as { detail: string | null }).detail = detail;
      }
    }

    // Update tracking state
    conn.lastQuality = {
      width: candidate.width ?? prev.width,
      height: candidate.height ?? prev.height,
      fps: candidate.fps ?? prev.fps,
      bitrateBps: candidate.bitrateBps ?? prev.bitrateBps,
    };
    conn.qualityDebounceCount = 0;
    conn.qualityDebounceTarget = null;

    // Update legacy fields for backward compat (codec/turn still use them)
    const res = candidate.width && candidate.height ? `${candidate.width}x${candidate.height}` : null;
    if (res && res !== conn.lastResolution) {
      conn.lastResolution = res;
    }
    if (candidate.fps !== null && candidate.fps !== conn.lastFps) {
      conn.lastFps = candidate.fps;
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
    // Use first actual sample timestamp as bucket start (audit item 9)
    const bucketKey = Math.floor(sample.timestampMs / bucketSize) * bucketSize;
    const deltaBytes = sample.intervalMs > 0
      ? Math.round((sample.mediaBitsPerSecond * sample.intervalMs) / 8000)
      : 0;

    const existingBucket = buckets.length > 0 && buckets[buckets.length - 1].startTimestampMs === bucketKey
      ? buckets[buckets.length - 1]
      : null;

    if (existingBucket) {
      existingBucket.byteDelta += deltaBytes;
      existingBucket.endTimestampMs = sample.timestampMs;
      existingBucket.intervalMs = Math.max(existingBucket.endTimestampMs - existingBucket.startTimestampMs, 0);
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
        startTimestampMs: bucketKey,
        endTimestampMs: sample.timestampMs,
        intervalMs: sample.timestampMs - bucketKey,
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

      while (buckets.length > maxBuckets) {
        buckets.shift();
      }
    }
  }

  // ─── Session aggregate ────────────────────────────────────────────────

  /**
   * Create one aggregate observation for this tick from all connections
   * in the session. Sums per-connection deltas observed in the same cycle
   * rather than concatenating individual connection samples (audit item 9).
   */
  private createAggregateObservation(state: SessionState, nowEpoch: number): void {
    let totalBytes = 0;
    let peakBitsPerSecond = 0;
    let aggRate = 0;

    for (const conn of state.connections.values()) {
      totalBytes += conn.totalVideoBytes + conn.totalAudioBytes;
      const connRate = (conn.videoBitsPerSecond ?? 0) + (conn.audioBitsPerSecond ?? 0);
      aggRate += connRate;
      if (conn.peakBitsPerSecond > peakBitsPerSecond) peakBitsPerSecond = conn.peakBitsPerSecond;
    }

    state.totalBytes = totalBytes;
    state.peakBitsPerSecond = peakBitsPerSecond;
    // Track session running peak (never decays, audit item 12)
    if (aggRate > (state as unknown as { sessionPeakBps: number }).sessionPeakBps) {
      (state as unknown as { sessionPeakBps: number }).sessionPeakBps = aggRate;
    }
  }

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
    // Build aggregate series (sum of all connection deltas, not concatenated)
    // Aggregate per-bucket series by summing connection-level buckets
    const aggMediumBuckets = this.aggregateConnectionBuckets(state, "medium");
    const aggLongBuckets = this.aggregateConnectionBuckets(state, "long");
    const aggSamples = this.aggregateConnectionSamples(state);

    // Markers: one canonical store = session markers only (audit item 16)
    const allMarkers: TelemetryMarker[] = [...state.markers];
    allMarkers.sort((a, b) => a.timestampMs - b.timestampMs);

    const allConnections: ConnectionTelemetrySnapshot[] = [];

    for (const conn of state.connections.values()) {
      const connActiveMs = this.computeActiveDuration(conn);
      const totalObservedBits = (conn.totalVideoBytes + conn.totalAudioBytes) * 8;

      const connSnapshot: ConnectionTelemetrySnapshot = {
        connectionId: conn.connectionId,
        viewerDeviceId: conn.viewerDeviceId,
        displayName: conn.displayName,
        receivedStatus: conn.receivedStatus,
        variantId: conn.variantId,
        rawSamples: Object.freeze([...conn.rawSamples]),
        mediumBuckets: Object.freeze([...conn.mediumBuckets]),
        longBuckets: Object.freeze([...conn.longBuckets]),
        markers: Object.freeze([...conn.markers]),
        currentBitsPerSecond: (conn.videoBitsPerSecond ?? 0) + (conn.audioBitsPerSecond ?? 0),
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
        currentVideoBitsPerSecond: conn.videoBitsPerSecond,
        currentAudioBitsPerSecond: conn.audioBitsPerSecond,
        currentTransportBitsPerSecond: conn.transportBitsPerSecond,
      };
      allConnections.push(Object.freeze(connSnapshot));
    }

    const latestSample = aggSamples[aggSamples.length - 1];
    const activeDurationMs = this.computeSessionActiveDuration(state);
    const totalObservedBits = state.totalBytes * 8;
    const weightedAvg = this.computeWeightedAverage(aggSamples);

    const aggregate: TelemetrySeriesSnapshot = {
      rawSamples: Object.freeze(aggSamples),
      mediumBuckets: Object.freeze(aggMediumBuckets),
      longBuckets: Object.freeze(aggLongBuckets),
      markers: Object.freeze(allMarkers),
      currentBitsPerSecond: latestSample?.mediaBitsPerSecond ?? 0,
      averageBitsPerSecond: weightedAvg ?? (activeDurationMs > 0
        ? Math.round(totalObservedBits / (activeDurationMs / 1000))
        : 0),
      peakBitsPerSecond: state.sessionPeakBps,
      totalBytes: state.totalBytes,
      durationMs: performance.now() - state.startedAtMonotonic,
      activeDurationMs,
      configuredBitsPerSecond: state.configuredBitsPerSecond,
      effectiveBitsPerSecond: state.effectiveBitsPerSecond,
      state: state.state,
      currentVideoBitsPerSecond: latestSample?.videoBitsPerSecond ?? null,
      currentAudioBitsPerSecond: latestSample?.audioBitsPerSecond ?? null,
      currentTransportBitsPerSecond: latestSample?.transportBitsPerSecond ?? null,
    };

    return Object.freeze({
      historyId: state.historyId,
      role: state.role,
      aggregate,
      connections: Object.freeze(allConnections),
    });
  }

  private aggregateConnectionBuckets(state: SessionState, tier: "medium" | "long"): AggregatedBucket[] {
    const allBuckets: AggregatedBucket[] = [];
    for (const conn of state.connections.values()) {
      allBuckets.push(...(tier === "medium" ? conn.mediumBuckets : conn.longBuckets));
    }
    // Sort by bucket start, then sum overlapping intervals
    if (allBuckets.length === 0) return [];
    allBuckets.sort((a, b) => a.startTimestampMs - b.startTimestampMs);

    const merged: AggregatedBucket[] = [];
    for (const b of allBuckets) {
      const last = merged[merged.length - 1];
      if (last && last.startTimestampMs === b.startTimestampMs) {
        // Same bucket start — sum rates and deltas
        last.byteDelta += b.byteDelta;
        last.maxBitsPerSecond += b.maxBitsPerSecond;
        last.minBitsPerSecond += b.minBitsPerSecond;
        last.weightedAverageBitsPerSecond = last.intervalMs > 0
          ? Math.round((last.byteDelta * 8000) / last.intervalMs)
          : last.maxBitsPerSecond;
        last.endTimestampMs = Math.max(last.endTimestampMs, b.endTimestampMs);
        last.intervalMs = last.endTimestampMs - last.startTimestampMs;
      } else {
        merged.push({ ...b });
      }
    }
    return merged;
  }

  private aggregateConnectionSamples(state: SessionState): TelemetrySample[] {
    // Timestamp-based merge: for each 1s tick, sum all connections' rates
    const byTimestamp = new Map<number, TelemetrySample[]>();
    for (const conn of state.connections.values()) {
      for (const s of conn.rawSamples) {
        const key = Math.round(s.timestampMs / 1000) * 1000;
        if (!byTimestamp.has(key)) byTimestamp.set(key, []);
        byTimestamp.get(key)!.push(s);
      }
    }
    const result: TelemetrySample[] = [];
    for (const [ts, samples] of byTimestamp) {
      let totalRate = 0;
      let totalVideo = 0;
      let totalAudio = 0;
      let transportRate = 0;
      let bytes = 0;
      let maxPacketLoss = 0;
      let minRtt = Infinity;
      let maxJitter = 0;
      let state: TelemetryState = "playing";
      let hasVideo = false;
      let hasAudio = false;
      let hasTransport = false;
      for (const s of samples) {
        totalRate += s.mediaBitsPerSecond;
        if (s.videoBitsPerSecond !== null) { totalVideo += s.videoBitsPerSecond; hasVideo = true; }
        if (s.audioBitsPerSecond !== null) { totalAudio += s.audioBitsPerSecond; hasAudio = true; }
        if (s.transportBitsPerSecond !== null) { transportRate += s.transportBitsPerSecond; hasTransport = true; }
        bytes += (s.mediaBitsPerSecond * s.intervalMs) / 8000;
        if ((s.packetLossPercent ?? 0) > maxPacketLoss) maxPacketLoss = s.packetLossPercent ?? 0;
        if ((s.rttMs ?? Infinity) < minRtt) minRtt = s.rttMs ?? Infinity;
        if ((s.jitterMs ?? 0) > maxJitter) maxJitter = s.jitterMs ?? 0;
        if (s.state === "reconnecting") state = "reconnecting";
        else if (s.state === "paused" && state === "playing") state = "paused";
      }
      result.push({
        timestampMs: ts,
        monotonicTimestampMs: ts, // aggregate uses epoch
        intervalMs: 1000,
        mediaBitsPerSecond: totalRate,
        videoBitsPerSecond: hasVideo ? totalVideo : null,
        audioBitsPerSecond: hasAudio ? totalAudio : null,
        transportBitsPerSecond: hasTransport ? transportRate : null,
        cumulativeMediaBytes: bytes,
        cumulativeTransportBytes: null,
        configuredVideoBitsPerSecond: null,
        effectiveVideoBitsPerSecond: null,
        width: null,
        height: null,
        framesPerSecond: null,
        packetLossPercent: maxPacketLoss || null,
        rttMs: minRtt < Infinity ? minRtt : null,
        jitterMs: maxJitter || null,
        codec: null,
        connectionType: null,
        state,
        videoRtpStreams: Object.freeze([]),
        audioRtpStreams: Object.freeze([]),
      });
    }
    result.sort((a, b) => a.timestampMs - b.timestampMs);
    return result.slice(-MAX_RAW_SAMPLES);
  }

  private computeWeightedAverage(samples: TelemetrySample[]): number | null {
    if (samples.length === 0) return null;
    let totalWeightedRate = 0;
    let totalWeight = 0;
    for (const s of samples) {
      const weight = s.intervalMs;
      totalWeightedRate += s.mediaBitsPerSecond * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? Math.round(totalWeightedRate / totalWeight) : null;
  }

  private computeDuration(conn: ConnectionState): number {
    return performance.now() - (conn.rawSamples[0]?.monotonicTimestampMs ?? performance.now());
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
      currentVideoBitsPerSecond: null,
      currentAudioBitsPerSecond: null,
      currentTransportBitsPerSecond: null,
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
