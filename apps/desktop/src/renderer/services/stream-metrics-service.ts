/**
 * StreamMetricsService — renderer singleton that collects bandwidth telemetry,
 * manages session lifecycle, aggregates 1s samples into histogram buckets,
 * tracks EWMA, and persists completed stream history.
 *
 * ─── API layers ─────────────────────────────────────────────────────────────
 *   1. Core session lifecycle:  startHostSession / startViewerSession / finalizeSession
 *   2. Data feed:               feedHostBytes / feedViewerBytes
 *   3. State tracking:          setSessionState
 *   4. Markers:                 addMarker
 *   5. Subscription:            subscribe / getSnapshot  (useSyncExternalStore)
 *   6. Getters:                 getViewerRates / getActiveSessionIds / getActiveMediaSessionIds
 *   7. Persistence:             checkpointSession / getHistory
 *   8. Crash recovery:          recoverInterruptedSessions
 *
 * ─── Telemetry contract ─────────────────────────────────────────────────────
 *   - Rates stored internally as bits per second (TelemetrySample.mediaBitsPerSecond)
 *   - Cumulative totals in Bytes
 *   - Monotonic clock (performance.now()) for rate calculations
 *   - Date.now() for display timestamps
 *   - First feedHostBytes/feedViewerBytes establishes baseline (does NOT add to total)
 *
 * ─── Sampling architecture ──────────────────────────────────────────────────
 *   - One setInterval (1 second) shared across all active sessions
 *   - on each tick: sample all sessions, aggregate, persist every 10th tick
 *   - inFlight guard prevents overlapping async work
 *   - Timer starts when first session is created, stops when last is removed
 *
 * ─── Aggregation ────────────────────────────────────────────────────────────
 *   - Raw samples:  1s intervals, keep latest 300 (5 min)
 *   - Medium buckets:  5s aggregates, keep latest 360 (30 min)
 *   - Long buckets:   30s aggregates, keep latest 10 000 (~83 h)
 *   - EWMA: three-second time constant (α ≈ 0.283), only updated when "playing"
 */

import type {
  TelemetrySample,
  TelemetryState,
  BandwidthSnapshot,
  AggregatedBucket,
  TelemetryMarker,
  MarkerType,
  ViewerRateEntry,
} from "./bandwidth-telemetry-types.js";

// ─── History record type ────────────────────────────────────────────────────

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

// ─── Constants ──────────────────────────────────────────────────────────────

/** Timer fires every 1 second */
const SAMPLE_INTERVAL_MS = 1000;

/** Maximum raw samples kept in memory (5 min at 1s) */
const MAX_RAW_SAMPLES = 300;

/** Medium bucket size (5 seconds) */
const MEDIUM_BUCKET_SIZE_MS = 5000;

/** Maximum medium buckets (30 min) */
const MAX_MEDIUM_BUCKETS = 360;

/** Long bucket size (30 seconds) */
const LONG_BUCKET_SIZE_MS = 30000;

/** Maximum long buckets (~83 hours) */
const MAX_LONG_BUCKETS = 10000;

/** Persistence checkpoint every 10 ticks (10 seconds) */
const PERSIST_INTERVAL_TICKS = 10;

/** Three-second EWMA alpha */
const EWMA_ALPHA = 1 - Math.exp(-1 / 3); // ≈ 0.283

// ─── Internal EWMA helpers ──────────────────────────────────────────────────

interface EwmaInternal {
  value: number;
  lastRaw: number;
  initialized: boolean;
  alpha: number;
}

function createEwma(): EwmaInternal {
  return { value: 0, lastRaw: 0, initialized: false, alpha: EWMA_ALPHA };
}

function updateEwma(ewma: EwmaInternal, rawBitsPerSecond: number): number {
  if (!ewma.initialized) {
    ewma.value = rawBitsPerSecond;
    ewma.lastRaw = rawBitsPerSecond;
    ewma.initialized = true;
    return ewma.value;
  }
  ewma.value = rawBitsPerSecond * ewma.alpha + ewma.value * (1 - ewma.alpha);
  ewma.lastRaw = rawBitsPerSecond;
  return ewma.value;
}

// ─── Internal bucket tracking metadata ──────────────────────────────────────

interface BucketMeta {
  lastCumulativeBytes: number;
}

// ─── Internal session state ─────────────────────────────────────────────────

interface InternalSessionState {
  // Identity
  historyId: string;
  role: "host" | "viewer";
  mediaSessionId: string;
  logicalStreamId: string;
  groupId: string;
  groupName: string;
  remoteDisplayName: string | null;

  // Timing
  startedAt: number;          // Date.now()
  startedAtMonotonic: number; // performance.now()

  // Quality
  presetName: string | null;
  customQuality: boolean;

  // Baseline
  hasBaseline: boolean;

  // Byte tracking
  totalBytes: number;
  lastBytes: number;
  lastMonotonicTimestampMs: number;
  lastSsrc: number | null;

  // Current rate (bits per second)
  lastBitsPerSecond: number;

  // EWMA
  ewma: EwmaInternal;
  ewmaSeries: number[];

  // Samples
    rawSamples: TelemetrySample[];

    // Buckets
  mediumBuckets: AggregatedBucket[];
  longBuckets: AggregatedBucket[];

  // Bucket tracking metadata (keyed by bucket start timestamp)
  mediumBucketMeta: Map<number, BucketMeta>;
  longBucketMeta: Map<number, BucketMeta>;

  // State
  state: TelemetryState;
  pausedAt: number | null;   // performance.now() when paused started
  totalPausedMs: number;

  // Markers
  markers: TelemetryMarker[];

  // Viewer rates (host only)
  viewerRates: Map<string, ViewerRateEntry>;

  // Snapshot cache
  lastSnapshot: BandwidthSnapshot | null;

  // Status for persistence
  status: "active" | "completed" | "interrupted";
  lastCheckpointAt: number;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class StreamMetricsService {
  private static instance: StreamMetricsService | null = null;
  private sessions = new Map<string, InternalSessionState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onHistoryChanged: (() => void) | null = null;
  private finalizing = new Set<string>();
  private finalizePromises = new Map<string, Promise<void>>();

  // In-flight guard for timer tick
  private tickInFlight = false;

  // Tick counter for persistence frequency
  private tickCounter = 0;

  // Subscribers keyed by historyId
  private subscribers = new Map<string, Set<() => void>>();

  // ─── Singleton ──────────────────────────────────────────────────────────

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

  // ─── Subscription (useSyncExternalStore) ────────────────────────────────

  /**
   * Subscribe to snapshot changes for a given historyId.
   * Returns an unsubscribe function.
   */
  subscribe(historyId: string, callback: () => void): () => void {
    if (!this.subscribers.has(historyId)) {
      this.subscribers.set(historyId, new Set());
    }
    this.subscribers.get(historyId)!.add(callback);
    return () => {
      this.subscribers.get(historyId)?.delete(callback);
    };
  }

  /**
   * Get the current immutable BandwidthSnapshot for a historyId.
   * Returns a frozen/cached reference — safe for useSyncExternalStore.
   */
  getSnapshot(historyId: string): BandwidthSnapshot {
    const state = this.sessions.get(historyId);
    if (!state) {
      return emptySnapshot(historyId);
    }
    if (!state.lastSnapshot) {
      state.lastSnapshot = this.buildSnapshot(state);
    }
    return state.lastSnapshot;
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────

  /** @returns historyId */
  startHostSession(
    mediaSessionId: string,
    logicalStreamId: string,
    groupId: string,
    groupName: string,
    presetName: string | null,
    customQuality: boolean,
    initialQualityLabel: string | null,
  ): string {
    const historyId = this.generateId();
    const now = Date.now();
    const monoNow = performance.now();
    const state = this.makeState(historyId, "host", mediaSessionId, logicalStreamId, groupId, groupName, null, now, monoNow, presetName, customQuality);

    // Add initial quality marker if provided
    if (initialQualityLabel) {
      const markerId = this.generateId();
      state.markers.push({
        id: markerId,
        timestampMs: now,
        type: "other",
        label: initialQualityLabel,
        detail: null,
      });
    }

    this.sessions.set(historyId, state);
    this.upsertRecord(this.buildRecord(state)).catch(() => {});
    this.ensureTimer();
    return historyId;
  }

  /** @returns historyId */
  startViewerSession(
    mediaSessionId: string,
    logicalStreamId: string,
    groupId: string,
    groupName: string,
    remoteDisplayName: string | null,
  ): string {
    const historyId = this.generateId();
    const now = Date.now();
    const monoNow = performance.now();
    const state = this.makeState(historyId, "viewer", mediaSessionId, logicalStreamId, groupId, groupName, remoteDisplayName, now, monoNow, null, false);

    this.sessions.set(historyId, state);
    this.upsertRecord(this.buildRecord(state)).catch(() => {});
    this.ensureTimer();
    return historyId;
  }

  private makeState(
    historyId: string,
    role: "host" | "viewer",
    mediaSessionId: string,
    logicalStreamId: string,
    groupId: string,
    groupName: string,
    remoteDisplayName: string | null,
    startedAt: number,
    startedAtMonotonic: number,
    presetName: string | null,
    customQuality: boolean,
  ): InternalSessionState {
    return {
      historyId,
      role,
      mediaSessionId,
      logicalStreamId,
      groupId,
      groupName,
      remoteDisplayName,
      startedAt,
      startedAtMonotonic,
      presetName,
      customQuality,
      hasBaseline: false,
      totalBytes: 0,
      lastBytes: 0,
      lastMonotonicTimestampMs: startedAtMonotonic,
      lastSsrc: null,
      lastBitsPerSecond: 0,
      ewma: createEwma(),
      ewmaSeries: [],
      rawSamples: [],
      mediumBuckets: [],
      longBuckets: [],
      mediumBucketMeta: new Map(),
      longBucketMeta: new Map(),
      state: "playing",
      pausedAt: null,
      totalPausedMs: 0,
      markers: [],
      viewerRates: new Map(),
      lastSnapshot: null,
      status: "active",
      lastCheckpointAt: startedAt,
    };
  }

  // ─── Data feed ──────────────────────────────────────────────────────────

  /**
   * Feed cumulative host outbound bytes.
   * First call establishes baseline (does NOT add to total).
   *
   * @param timestamp - monotonic timestamp (performance.now()-based)
   * @param ssrc      - optional SSRC for counter-identity tracking
   */
  feedHostBytes(historyId: string, cumulativeBytes: number, timestamp: number, ssrc?: number | null): void {
    this.feedBytes(historyId, cumulativeBytes, timestamp, "host", ssrc);
  }

  /**
   * Feed cumulative viewer download bytes.
   * First call establishes baseline (does NOT add to total).
   *
   * @param timestamp - monotonic timestamp (performance.now()-based)
   * @param ssrc      - optional SSRC for counter-identity tracking
   */
  feedViewerBytes(historyId: string, cumulativeBytes: number, timestamp: number, ssrc?: number | null): void {
    this.feedBytes(historyId, cumulativeBytes, timestamp, "viewer", ssrc);
  }

  private feedBytes(
    historyId: string,
    cumulativeBytes: number,
    timestamp: number,
    expectedRole: "host" | "viewer",
    ssrc?: number | null,
  ): void {
    const state = this.sessions.get(historyId);
    if (!state) return;
    if (state.role !== expectedRole) return;

    // ── First-sample baseline ──
    if (!state.hasBaseline) {
      state.lastBytes = cumulativeBytes;
      state.lastMonotonicTimestampMs = timestamp;
      if (ssrc !== undefined) state.lastSsrc = ssrc;
      state.hasBaseline = true;
      return;
    }

    // ── SSRC change detection ──
    if (ssrc !== undefined && ssrc !== null && state.lastSsrc !== null && ssrc !== state.lastSsrc) {
      // SSRC changed — establish new baseline without spike
      state.lastBytes = cumulativeBytes;
      state.lastMonotonicTimestampMs = timestamp;
      state.lastSsrc = ssrc;
      return;
    }

    // ── Counter reset detection (decrement) ──
    if (cumulativeBytes < state.lastBytes) {
      // Counter reset — new baseline, total NOT decremented
      state.lastBytes = cumulativeBytes;
      state.lastMonotonicTimestampMs = timestamp;
      if (ssrc !== undefined) state.lastSsrc = ssrc;
      return;
    }

    // ── Normal delta computation ──
    const deltaBytes = cumulativeBytes - state.lastBytes;
    const elapsedSeconds = (timestamp - state.lastMonotonicTimestampMs) / 1000;

    if (elapsedSeconds > 0 && deltaBytes >= 0) {
      const bitsPerSecond = Math.round((deltaBytes * 8) / elapsedSeconds);
      state.lastBitsPerSecond = bitsPerSecond;
      state.totalBytes += deltaBytes;
    }

    state.lastBytes = cumulativeBytes;
    state.lastMonotonicTimestampMs = timestamp;
    if (ssrc !== undefined) state.lastSsrc = ssrc;

    // Invalidate snapshot cache since totals changed
    state.lastSnapshot = null;
  }

  // ─── Session state tracking ─────────────────────────────────────────────

  /**
   * Set the session playback state.
   * Affects EWMA updates (only when "playing") and session average (excludes paused time).
   */
  setSessionState(historyId: string, newState: TelemetryState): void {
    const state = this.sessions.get(historyId);
    if (!state || state.state === newState) return;

    const oldState = state.state;
    state.state = newState;

    // Track pause time exclusion
    if (oldState === "playing" && newState === "paused") {
      state.pausedAt = performance.now();
    } else if (oldState === "paused" && newState === "playing") {
      if (state.pausedAt !== null) {
        state.totalPausedMs += performance.now() - state.pausedAt;
        state.pausedAt = null;
      }
    }

    // Auto-marker for state transitions
    if (oldState === "playing" && newState === "paused") {
      this.addMarker(historyId, "pause", oldState, newState, "Session paused");
    } else if (oldState === "paused" && newState === "playing") {
      this.addMarker(historyId, "resume", oldState, newState, "Session resumed");
    } else if (newState === "reconnecting") {
      this.addMarker(historyId, "reconnect", oldState, newState, "Session reconnecting");
    } else {
      this.addMarker(historyId, "other", oldState, newState, `${oldState} → ${newState}`);
    }

    // addMarker already invalidates snapshot cache + notifies subscribers.
    // Still need to notify history change listeners.
    this.notifyHistoryChanged();
  }

  // ─── Markers ────────────────────────────────────────────────────────────

  /**
   * Add a marker to the session.
   * Accepts MarkerType (superset of legacy category strings).
   */
  addMarker(
    historyId: string,
    type: MarkerType,
    from: string | null,
    to: string,
    label: string,
  ): void {
    const state = this.sessions.get(historyId);
    if (!state) return;

    const now = Date.now();
    const markerId = this.generateId();
    state.markers.push({
      id: markerId,
      timestampMs: now,
      type,
      label,
      detail: from ? `${from} → ${to}` : to,
    });

    state.lastSnapshot = null;
    this.notifySessionSubscribers(historyId);
  }

  // ─── Checkpoint (persistence & backward compat) ─────────────────────────

  /**
   * Persist a checkpoint snapshot for the session.
   * Called internally every 10th timer tick.
   */
  checkpointSession(historyId: string): void {
    const state = this.sessions.get(historyId);
    if (!state) return;

    state.lastCheckpointAt = Date.now();

    this.upsertRecord(this.buildRecord(state)).catch(() => {});
    state.lastSnapshot = null;
    this.notifySessionSubscribers(historyId);
  }

  // ─── Finalize ───────────────────────────────────────────────────────────

  async finalizeSession(historyId: string): Promise<void> {
    if (this.finalizing.has(historyId)) {
      const existing = this.finalizePromises.get(historyId);
      if (existing) return existing;
    }

    const state = this.sessions.get(historyId);
    if (!state) return;

    this.finalizing.add(historyId);

    const promise = (async () => {
      try {
        state.lastCheckpointAt = Date.now();

        const now = Date.now();
        const durationMs = now - state.startedAt;
        const record: StreamHistoryRecord = {
          historyId: state.historyId,
          role: state.role,
          status: "completed",
          mediaSessionId: state.mediaSessionId,
          logicalStreamId: state.logicalStreamId,
          groupId: state.groupId,
          groupName: state.groupName,
          remoteDisplayName: state.remoteDisplayName,
          startedAt: state.startedAt,
          lastCheckpointAt: now,
          stoppedAt: now,
          durationMs,
          totalBytes: state.totalBytes,
          averageBytesPerSecond: durationMs > 0 ? Math.round((state.totalBytes * 1000) / durationMs) : 0,
          presetName: state.presetName,
          customQuality: state.customQuality,
          samples: state.rawSamples.map(s => ({
            timestamp: s.timestampMs,
            bytesPerSecond: Math.round(s.mediaBitsPerSecond / 8),
            totalBytes: s.cumulativeMediaBytes,
          })),
          markers: state.markers.map(m => ({
            timestamp: m.timestampMs,
            category: m.type,
            from: m.detail ? m.detail.split(' → ')[0] : null,
            to: m.detail ? m.detail.split(' → ')[1] || m.label : m.label,
            label: m.label,
          })),
          interrupted: false,
        };

        await this.upsertRecord(record);
        this.sessions.delete(historyId);
        state.lastSnapshot = null;
        this.notifySessionSubscribers(historyId);
      } finally {
        this.finalizing.delete(historyId);
        this.finalizePromises.delete(historyId);
        this.stopTimerIfIdle();
      }
    })();

    this.finalizePromises.set(historyId, promise);
    return promise;
  }

  // ─── Public getters ─────────────────────────────────────────────────────

  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  getActiveMediaSessionIds(): string[] {
    const ids = new Set<string>();
    for (const state of this.sessions.values()) {
      ids.add(state.mediaSessionId);
    }
    return Array.from(ids);
  }

  /**
   * Find the historyId for a given mediaSessionId.
   * Useful for mapping from mediaSessionId-based APIs to historyId-based subscriptions.
   */
  findHistoryIdByMediaSessionId(mediaSessionId: string): string | null {
    for (const [historyId, state] of this.sessions) {
      if (state.mediaSessionId === mediaSessionId) {
        return historyId;
      }
    }
    return null;
  }

  /**
   * Get per-viewer rate entries for a host session.
   */
  getViewerRates(historyId: string): ViewerRateEntry[] {
    const state = this.sessions.get(historyId);
    if (!state || state.role !== "host") return [];
    return Array.from(state.viewerRates.values());
  }

  // ─── History ────────────────────────────────────────────────────────────

  async getHistory(): Promise<StreamHistoryRecord[]> {
    try {
      const api = (window as unknown as { screenlink?: { getStreamHistory?: () => Promise<StreamHistoryRecord[]> } }).screenlink;
      if (!api?.getStreamHistory) return [];
      return await api.getStreamHistory();
    } catch {
      return [];
    }
  }

  // ─── Crash recovery ─────────────────────────────────────────────────────

  async recoverInterruptedSessions(): Promise<void> {
    try {
      const api = (window as unknown as {
        screenlink?: {
          getStreamHistory?: () => Promise<StreamHistoryRecord[]>;
          saveStreamHistory?: (r: StreamHistoryRecord[]) => Promise<void>;
        }
      }).screenlink;
      if (!api?.getStreamHistory) return;

      const records = await api.getStreamHistory();
      let changed = false;
      for (const r of records) {
        if (r.status === "active") {
          r.status = "interrupted";
          r.interrupted = true;
          r.stoppedAt = r.lastCheckpointAt;
          r.durationMs = r.lastCheckpointAt - r.startedAt;
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

  // ─── Timer ──────────────────────────────────────────────────────────────

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

  /**
   * Timer tick: sample all active sessions, aggregate buckets, persist periodically.
   * Guarded by inFlight to prevent overlapping async work.
   */
  private handleTick(): void {
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      this.tickCounter++;
      const shouldPersist = this.tickCounter % PERSIST_INTERVAL_TICKS === 0;

      for (const state of this.sessions.values()) {
        this.collectSample(state);
        if (shouldPersist) {
          this.checkpointSession(state.historyId);
        }
      }

      this.notifyAllSubscribers();
      this.notifyHistoryChanged();
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Collect a TelemetrySample from current session state.
   * Updates raw samples, EWMA, and aggregated buckets.
   */
  private collectSample(state: InternalSessionState): void {
    const now = Date.now();
    const monoNow = performance.now();

    const prevSample = state.rawSamples.length > 0
      ? state.rawSamples[state.rawSamples.length - 1]
      : null;

    const intervalMs = prevSample ? monoNow - prevSample.monotonicTimestampMs : SAMPLE_INTERVAL_MS;

    // Build the TelemetrySample
    const sample: TelemetrySample = {
      timestampMs: now,
      monotonicTimestampMs: monoNow,
      intervalMs: Math.round(intervalMs),
      videoBitsPerSecond: null,
      audioBitsPerSecond: null,
      mediaBitsPerSecond: state.lastBitsPerSecond,
      transportBitsPerSecond: null,
      cumulativeVideoBytes: 0,
      cumulativeAudioBytes: 0,
      cumulativeMediaBytes: state.totalBytes,
      cumulativeTransportBytes: null,
      configuredVideoBitsPerSecond: null,
      effectiveVideoBitsPerSecond: null,
      width: null,
      height: null,
      framesPerSecond: null,
      packetLossPercent: null,
      rttMs: null,
      jitterMs: null,
      state: state.state,
      ssrc: state.lastSsrc,
    };

    state.rawSamples.push(sample);
    if (state.rawSamples.length > MAX_RAW_SAMPLES) {
      state.rawSamples = state.rawSamples.slice(-MAX_RAW_SAMPLES);
    }

    // ── EWMA ──
    if (state.state === "playing" && state.lastBitsPerSecond > 0) {
      updateEwma(state.ewma, state.lastBitsPerSecond);
    }
    state.ewmaSeries.push(state.ewma.value);
    if (state.ewmaSeries.length > MAX_RAW_SAMPLES) {
      state.ewmaSeries = state.ewmaSeries.slice(-MAX_RAW_SAMPLES);
    }

    // ── Aggregate into buckets ──
    this.aggregateIntoSample(state.mediumBuckets, state.mediumBucketMeta, sample, MEDIUM_BUCKET_SIZE_MS, MAX_MEDIUM_BUCKETS);
    this.aggregateIntoSample(state.longBuckets, state.longBucketMeta, sample, LONG_BUCKET_SIZE_MS, MAX_LONG_BUCKETS);

    state.lastSnapshot = null;
  }

  /**
   * Aggregate a single sample into a time-bucketed list.
   */
  private aggregateIntoSample(
    buckets: AggregatedBucket[],
    meta: Map<number, BucketMeta>,
    sample: TelemetrySample,
    bucketSize: number,
    maxBuckets: number,
  ): void {
    const bucketStart = Math.floor(sample.monotonicTimestampMs / bucketSize) * bucketSize;

    // Compute delta bytes — carry forward previous bucket's last position
    const bucketMeta = meta.get(bucketStart);
    const prevLastBytes = bucketMeta
      ? bucketMeta.lastCumulativeBytes
      : buckets.length > 0
        ? (meta.get(buckets[buckets.length - 1].startTimestampMs)?.lastCumulativeBytes ?? 0)
        : 0;

    const deltaBytes = Math.max(0, sample.cumulativeMediaBytes - prevLastBytes);

    const existingBucket = buckets.length > 0 && buckets[buckets.length - 1].startTimestampMs === bucketStart
      ? buckets[buckets.length - 1]
      : null;

    if (existingBucket) {
      // Update existing bucket — accumulate deltas
      const count = existingBucket.sampleCount;
      existingBucket.bucketTotalBytes += deltaBytes;
      existingBucket.sampleCount++;
      // Use the larger of the monotonic end-time or the existing boundary
      existingBucket.endTimestampMs = Math.max(existingBucket.endTimestampMs, sample.monotonicTimestampMs);

      // Compute weighted average from actual byte delta and total elapsed
      const elapsedMs = existingBucket.endTimestampMs - existingBucket.startTimestampMs;
      existingBucket.weightedAverageBitsPerSecond =
        elapsedMs > 0 ? Math.round((existingBucket.bucketTotalBytes * 8000) / elapsedMs) : sample.mediaBitsPerSecond;

      existingBucket.maxBitsPerSecond = Math.max(existingBucket.maxBitsPerSecond, sample.mediaBitsPerSecond);
      existingBucket.minBitsPerSecond = Math.min(existingBucket.minBitsPerSecond, sample.mediaBitsPerSecond);
      existingBucket.width = sample.width ?? existingBucket.width;
      existingBucket.height = sample.height ?? existingBucket.height;
      existingBucket.framesPerSecond = sample.framesPerSecond ?? existingBucket.framesPerSecond;
      existingBucket.state = sample.state;

      // Update meta for next sample
      if (bucketMeta) {
        bucketMeta.lastCumulativeBytes = sample.cumulativeMediaBytes;
      }
    } else {
      // Create new bucket (finalize previous if needed)
      const newBucket: AggregatedBucket = {
        startTimestampMs: bucketStart,
        endTimestampMs: bucketStart + bucketSize,
        minBitsPerSecond: sample.mediaBitsPerSecond,
        maxBitsPerSecond: sample.mediaBitsPerSecond,
        weightedAverageBitsPerSecond: sample.mediaBitsPerSecond,
        bucketTotalBytes: deltaBytes,
        sampleCount: 1,
        width: sample.width,
        height: sample.height,
        framesPerSecond: sample.framesPerSecond,
        state: sample.state,
      };

      buckets.push(newBucket);
      meta.set(bucketStart, { lastCumulativeBytes: sample.cumulativeMediaBytes });

      // Trim old buckets
      while (buckets.length > maxBuckets) {
        const removed = buckets.shift()!;
        meta.delete(removed.startTimestampMs);
      }
    }
  }

  // ─── Bucket timestamp correction ─────────────────────────────────────

  /**
   * Convert monotonic bucket timestamps to epoch timestamps by applying
   * the monotonic→epoch offset from session start.
   */
  private epochAdjustBuckets(
    state: InternalSessionState,
    buckets: AggregatedBucket[],
  ): AggregatedBucket[] {
    if (buckets.length === 0) return [];
    const offset = state.startedAt - state.startedAtMonotonic;
    return buckets.map((b) => ({
      ...b,
      startTimestampMs: b.startTimestampMs + offset,
      endTimestampMs: b.endTimestampMs + offset,
    }));
  }

  // ─── Snapshot building ──────────────────────────────────────────────────

  private buildSnapshot(state: InternalSessionState): BandwidthSnapshot {
    const now = Date.now();
    const monoNow = performance.now();
    const durationMs = monoNow - state.startedAtMonotonic;
    const activeDurationMs = Math.max(0, durationMs - state.totalPausedMs);
    const totalObservedBits = state.totalBytes * 8;

    // Peak rate from raw samples
    let peakBitsPerSecond = 0;
    for (const s of state.rawSamples) {
      if (s.mediaBitsPerSecond > peakBitsPerSecond) {
        peakBitsPerSecond = s.mediaBitsPerSecond;
      }
    }

    const latestSample = state.rawSamples[state.rawSamples.length - 1];
    const currentBitsPerSecond = latestSample?.mediaBitsPerSecond ?? state.lastBitsPerSecond;

    const averageBitsPerSecond = activeDurationMs > 0
      ? Math.round(totalObservedBits / (activeDurationMs / 1000))
      : 0;

    // Per-viewer rates (host only)
    const viewerRates: ViewerRateEntry[] = [];
    if (state.role === "host") {
      for (const entry of state.viewerRates.values()) {
        viewerRates.push({ ...entry });
      }
    }

    return Object.freeze({
      rawSamples: Object.freeze([...state.rawSamples]),
      mediumBuckets: Object.freeze(this.epochAdjustBuckets(state, state.mediumBuckets)),
      longBuckets: Object.freeze(this.epochAdjustBuckets(state, state.longBuckets)),
      ewmaSeries: Object.freeze([...state.ewmaSeries]),
      currentBitsPerSecond,
      averageBitsPerSecond,
      peakBitsPerSecond,
      totalBytes: state.totalBytes,
      durationMs,
      activeDurationMs,
      configuredBitsPerSecond: null,
      effectiveBitsPerSecond: null,
      state: state.state,
      historyId: state.historyId,
      role: state.role as "host" | "viewer",
      viewerRates: Object.freeze(viewerRates),
      markers: Object.freeze([...state.markers]),
    });
  }

  // ─── Subscriber notification ────────────────────────────────────────────

  private notifySessionSubscribers(historyId: string): void {
    const cbs = this.subscribers.get(historyId);
    if (cbs) {
      for (const cb of cbs) {
        try { cb(); } catch { /* swallow subscriber errors */ }
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

  // ─── Persistence ────────────────────────────────────────────────────────

  private buildRecord(state: InternalSessionState): StreamHistoryRecord {
    const now = Date.now();
    const durationMs = now - state.startedAt;
    return {
      historyId: state.historyId,
      role: state.role,
      status: state.status,
      mediaSessionId: state.mediaSessionId,
      logicalStreamId: state.logicalStreamId,
      groupId: state.groupId,
      groupName: state.groupName,
      remoteDisplayName: state.remoteDisplayName,
      startedAt: state.startedAt,
      lastCheckpointAt: now,
      stoppedAt: null,
      durationMs,
      totalBytes: state.totalBytes,
      averageBytesPerSecond: durationMs > 0 ? Math.round((state.totalBytes * 1000) / durationMs) : 0,
      presetName: state.presetName,
      customQuality: state.customQuality,
      samples: state.rawSamples.map(s => ({
        timestamp: s.timestampMs,
        bytesPerSecond: Math.round(s.mediaBitsPerSecond / 8),
        totalBytes: s.cumulativeMediaBytes,
      })),
      markers: state.markers.map(m => ({
        timestamp: m.timestampMs,
        category: m.type,
        from: m.detail ? m.detail.split(' → ')[0] : null,
        to: m.detail ? m.detail.split(' → ')[1] || m.label : m.label,
        label: m.label,
      })),
      interrupted: false,
    };
  }

  private async upsertRecord(record: StreamHistoryRecord): Promise<void> {
    try {
      const api = (
        window as unknown as {
          screenlink?: {
            upsertStreamHistory?: (record: unknown) => Promise<void>;
            getStreamHistory?: () => Promise<StreamHistoryRecord[]>;
            saveStreamHistory?: (r: StreamHistoryRecord[]) => Promise<void>;
          };
        }
      ).screenlink;

      if (api?.upsertStreamHistory) {
        await api.upsertStreamHistory(record);
      } else if (api?.getStreamHistory && api?.saveStreamHistory) {
        const existing = await api.getStreamHistory();
        const idx = existing.findIndex((r: StreamHistoryRecord) => r.historyId === record.historyId);
        if (idx >= 0) existing[idx] = record;
        else existing.push(record);
        await api.saveStreamHistory(existing);
      }
    } catch {
      console.warn("[StreamMetricsService] Failed to upsert history record");
    }
  }

  // ─── ID generation ──────────────────────────────────────────────────────

  private generateId(): string {
    if (typeof globalThis !== "undefined" && typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// ─── Empty snapshot factory ────────────────────────────────────────────────

function emptySnapshot(historyId: string): BandwidthSnapshot {
  return Object.freeze({
    rawSamples: Object.freeze([]),
    mediumBuckets: Object.freeze([]),
    longBuckets: Object.freeze([]),
    ewmaSeries: Object.freeze([]),
    currentBitsPerSecond: 0,
    averageBitsPerSecond: 0,
    peakBitsPerSecond: 0,
    totalBytes: 0,
    durationMs: 0,
    activeDurationMs: 0,
    configuredBitsPerSecond: null,
    effectiveBitsPerSecond: null,
    state: "paused" as TelemetryState,
    historyId,
    role: "viewer" as const,
    viewerRates: Object.freeze([]),
    markers: Object.freeze([]),
  });
}
