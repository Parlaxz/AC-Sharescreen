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
 *   6. Getters (new):           getViewerRates
 *   7. Getters (backward-compat):  getLiveSamples / getLiveMarkers / getLiveDuration /
 *                                  getLiveTotalBytes / getLiveCurrentBytesPerSecond /
 *                                  getLiveHostTotal / getLiveCurrentBps / getLiveStartTimeMs /
 *                                  getLiveViewerCount / getViewerBps / getViewerTotalBytes /
 *                                  getViewerSamples / feedViewerBandwidth
 *   8. Backward-compat lifecycle:  onStreamStart / onStreamStop / onQualityChange /
 *                                  onHostStats / onViewerStats
 *   9. Persistence:             checkpointSession
 *  10. Crash recovery:          recoverInterruptedSessions
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

// ─── Backward-compat type re-exports ────────────────────────────────────────

export type StreamHistoryRole = "host" | "viewer";
export type StreamHistoryStatus = "active" | "completed" | "interrupted";

export interface StreamHistorySample {
  timestamp: number;
  bytesPerSecond: number;   // bytes per second (NOT bits)
  totalBytes: number;
}

export interface StreamSettingMarker {
  timestamp: number;
  category: string;
  from: string | null;
  to: string;
  label: string;
}

export interface StreamHistoryRecord {
  historyId: string;
  role: StreamHistoryRole;
  status: StreamHistoryStatus;
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
  samples: StreamHistorySample[];
  markers: StreamSettingMarker[];
  interrupted: boolean;
}

export type BandwidthSample = StreamHistorySample;
export type SettingMarker = StreamSettingMarker;

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
  role: StreamHistoryRole;
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

  // Persisted-format samples (for getLiveSames / checkpointSession backward compat)
  persistSamples: StreamHistorySample[];

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

  // Markers (new format for snapshot)
  markers: TelemetryMarker[];
  // Markers (old format for persistence & backward compat getLiveMarkers)
  oldMarkers: StreamSettingMarker[];

  // Viewer rates (host only)
  viewerRates: Map<string, ViewerRateEntry>;

  // Snapshot cache
  lastSnapshot: BandwidthSnapshot | null;

  // Status for persistence
  status: StreamHistoryStatus;
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

  // Viewer-side tracker (backward compat)
  private _viewerBps = 0;
  private _viewerTotalBytes = 0;
  private _viewerSamples: { timestamp: number; bps: number }[] = [];

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
      state.oldMarkers.push({
        timestamp: now,
        category: "other",
        from: null,
        to: initialQualityLabel,
        label: initialQualityLabel,
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
    role: StreamHistoryRole,
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
      persistSamples: [],
      mediumBuckets: [],
      longBuckets: [],
      mediumBucketMeta: new Map(),
      longBucketMeta: new Map(),
      state: "playing",
      pausedAt: null,
      totalPausedMs: 0,
      markers: [],
      oldMarkers: [],
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
    expectedRole: StreamHistoryRole,
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

    state.lastSnapshot = null;
    this.notifySessionSubscribers(historyId);
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
    state.oldMarkers.push({
      timestamp: now,
      category: type,
      from,
      to,
      label,
    });

    state.lastSnapshot = null;
    this.notifySessionSubscribers(historyId);
  }

  // ─── Checkpoint (persistence & backward compat) ─────────────────────────

  /**
   * Persist a checkpoint sample for the session.
   * Public for backward compat — also called internally every 10th timer tick.
   */
  checkpointSession(historyId: string): void {
    const state = this.sessions.get(historyId);
    if (!state) return;

    const now = Date.now();
    const bytesPerSecond = Math.round(state.lastBitsPerSecond / 8);

    state.persistSamples.push({
      timestamp: now,
      bytesPerSecond,
      totalBytes: state.totalBytes,
    });
    state.lastCheckpointAt = now;

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
        // Push final sample
        {
          const now = Date.now();
          const bytesPerSecond = Math.round(state.lastBitsPerSecond / 8);
          state.persistSamples.push({
            timestamp: now,
            bytesPerSecond,
            totalBytes: state.totalBytes,
          });
          state.lastCheckpointAt = now;
        }

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
          samples: [...state.persistSamples],
          markers: [...state.oldMarkers],
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

  // ─── Public getters (backward compat) ───────────────────────────────────

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
   * Get live samples (persisted-format).
   * @param id - historyId (preferred) or mediaSessionId (backward compat)
   */
  getLiveSamples(id: string): StreamHistorySample[] {
    const byHistoryId = this.sessions.get(id);
    if (byHistoryId) return byHistoryId.persistSamples;
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === id) return state.persistSamples;
    }
    return [];
  }

  /**
   * Get live markers.
   * @param id - historyId (preferred) or mediaSessionId (backward compat)
   */
  getLiveMarkers(id: string): StreamSettingMarker[] {
    const byHistoryId = this.sessions.get(id);
    if (byHistoryId) return byHistoryId.oldMarkers;
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === id) return state.oldMarkers;
    }
    return [];
  }

  /**
   * Get live duration.
   * @param id - historyId (preferred) or mediaSessionId (backward compat)
   */
  getLiveDuration(id: string): number {
    const byHistoryId = this.sessions.get(id);
    if (byHistoryId) return Date.now() - byHistoryId.startedAt;
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === id) return Date.now() - state.startedAt;
    }
    return 0;
  }

  /**
   * Get total bytes (raw cumulative bytes).
   */
  getLiveTotalBytes(historyId: string): number {
    return this.sessions.get(historyId)?.totalBytes ?? 0;
  }

  /**
   * Get current rate in bytes per second (backward compat with old tests).
   */
  getLiveCurrentBytesPerSecond(historyId: string): number {
    return Math.round((this.sessions.get(historyId)?.lastBitsPerSecond ?? 0) / 8);
  }

  /**
   * Get total host bytes for a session.
   */
  getLiveHostTotal(id: string): number {
    const byHistoryId = this.sessions.get(id);
    if (byHistoryId) return byHistoryId.totalBytes;
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === id && state.role === "host") return state.totalBytes;
    }
    return 0;
  }

  // ─── Backward-compat lifecycle methods ──────────────────────────────────

  /** @returns historyId */
  onStreamStart(
    mediaSessionId: string,
    logicalStreamId: string,
    groupId: string,
    groupName: string,
    presetName: string | null,
    customQuality: boolean,
    initialQualityLabel: string | null,
  ): string {
    const id = this.startHostSession(
      mediaSessionId,
      logicalStreamId,
      groupId,
      groupName,
      presetName,
      customQuality,
      initialQualityLabel,
    );
    return id;
  }

  async onStreamStop(mediaSessionId: string): Promise<void> {
    const toFinalize: string[] = [];
    for (const [historyId, state] of this.sessions) {
      if (state.mediaSessionId === mediaSessionId) {
        toFinalize.push(historyId);
      }
    }
    await Promise.all(toFinalize.map((id) => this.finalizeSession(id)));
  }

  onQualityChange(mediaSessionId: string, label: string): void {
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === mediaSessionId && state.role === "host") {
        this.addMarker(state.historyId, "other", null, label, label);
        return;
      }
    }
  }

  onHostStats(mediaSessionId: string, bytes: number, timestamp: number): void {
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === mediaSessionId && state.role === "host") {
        this.feedHostBytes(state.historyId, bytes, timestamp);
        return;
      }
    }
  }

  onViewerStats(mediaSessionId: string, viewerDeviceId: string, displayName: string, bytes: number): void {
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === mediaSessionId && state.role === "host") {
        this.feedHostBytes(state.historyId, bytes, Date.now());

        // Update per-viewer rate tracking
        const now = Date.now();
        const existing = state.viewerRates.get(viewerDeviceId);
        const entry: ViewerRateEntry = {
          viewerDeviceId,
          displayName,
          bitsPerSecond: state.lastBitsPerSecond,
          totalBytes: state.totalBytes,
          rttMs: existing?.rttMs ?? null,
          packetLossPercent: existing?.packetLossPercent ?? null,
          width: existing?.width ?? null,
          height: existing?.height ?? null,
          framesPerSecond: existing?.framesPerSecond ?? null,
          state: state.state,
        };
        state.viewerRates.set(viewerDeviceId, entry);
        state.lastSnapshot = null;
        return;
      }
    }
  }

  // ─── Backward-compat getters by mediaSessionId ──────────────────────────

  getLiveStartTimeMs(mediaSessionId: string): number | null {
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === mediaSessionId) {
        return state.startedAt;
      }
    }
    return null;
  }

  getLiveViewerCount(_mediaSessionId: string): number {
    return 0;
  }

  /**
   * Returns bits per second (the name "Bps" means bits per second).
   * Now correctly sourced from internal bitsPerSecond (not bytesPerSecond * 8).
   */
  getLiveCurrentBps(mediaSessionId: string): number {
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === mediaSessionId) {
        return state.lastBitsPerSecond;
      }
    }
    return 0;
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

  // ─── Viewer-side tracker (backward compat) ──────────────────────────────

  feedViewerBandwidth(bps: number, totalBytes: number): void {
    this._viewerBps = bps;
    this._viewerTotalBytes = totalBytes;
    this._viewerSamples = this._viewerSamples || [];
    this._viewerSamples.push({ timestamp: Date.now(), bps });
    if (this._viewerSamples.length > 180) {
      this._viewerSamples = this._viewerSamples.slice(-180);
    }
  }

  getViewerBps(): number { return this._viewerBps; }
  getViewerTotalBytes(): number { return this._viewerTotalBytes; }
  getViewerSamples(): { timestamp: number; bps: number }[] { return [...(this._viewerSamples || [])]; }

  // ─── New getters ────────────────────────────────────────────────────────

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

    // Compute delta bytes from last sample in this bucket
    const bucketMeta = meta.get(bucketStart);
    const deltaBytes = bucketMeta
      ? Math.max(0, sample.cumulativeMediaBytes - bucketMeta.lastCumulativeBytes)
      : 0;

    const existingBucket = buckets.length > 0 && buckets[buckets.length - 1].startTimestampMs === bucketStart
      ? buckets[buckets.length - 1]
      : null;

    if (existingBucket) {
      // Update existing bucket
      const count = existingBucket.sampleCount;
      const newWeightedAvg = (existingBucket.weightedAverageBitsPerSecond * count + sample.mediaBitsPerSecond) / (count + 1);

      existingBucket.weightedAverageBitsPerSecond = Math.round(newWeightedAvg);
      existingBucket.maxBitsPerSecond = Math.max(existingBucket.maxBitsPerSecond, sample.mediaBitsPerSecond);
      existingBucket.minBitsPerSecond = Math.min(existingBucket.minBitsPerSecond, sample.mediaBitsPerSecond);
      existingBucket.bucketTotalBytes += deltaBytes;
      existingBucket.sampleCount++;
      existingBucket.endTimestampMs = Math.max(existingBucket.endTimestampMs, sample.monotonicTimestampMs);
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

  // ─── Snapshot building ──────────────────────────────────────────────────

  private buildSnapshot(state: InternalSessionState): BandwidthSnapshot {
    const now = Date.now();
    const durationMs = now - state.startedAt;
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
    const currentBitsPerSecond = latestSample?.mediaBitsPerSecond ?? 0;

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
      mediumBuckets: Object.freeze([...state.mediumBuckets]),
      longBuckets: Object.freeze([...state.longBuckets]),
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
      samples: [...state.persistSamples],
      markers: [...state.oldMarkers],
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
