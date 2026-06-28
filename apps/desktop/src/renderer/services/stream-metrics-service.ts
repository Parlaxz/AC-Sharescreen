/**
 * StreamMetricsService — renderer singleton that collects bandwidth samples,
 * setting-change markers, and persists completed stream history.
 *
 * Data sources (callers):
 *   - StreamSessionManager: onStreamStart, onQualityChange, onStreamStop
 *   - useHostViewerDiagnostics: onHostStats (outbound RTCP bytes)
 *
 * Key design:
 *   - Sessions keyed by historyId (UUID, not mediaSessionId)
 *   - One setInterval timer; starts when sessions.size===1, stops at 0
 *   - Timer ticks every 10 seconds, checkpointing ALL active sessions
 *   - Upsert persistence (no append -> no duplicates)
 *   - No cap on persisted samples
 *   - Crash recovery: active records are marked interrupted on load
 *
 * No Zustand involvement. No network messages. Pure local collection.
 */

// ─── Types (exported) ───────────────────────────────────────────────────────

export type StreamHistoryRole = "host" | "viewer";
export type StreamHistoryStatus = "active" | "completed" | "interrupted";

export interface StreamHistorySample {
  timestamp: number;
  bytesPerSecond: number;   // bytes per second (NOT bits)
  totalBytes: number;
}

export interface StreamSettingMarker {
  timestamp: number;
  category: "resolution" | "fps" | "bitrate" | "preset" | "codec" | "other";
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

// Re-export the old names for backward compatibility
export type BandwidthSample = StreamHistorySample;
export type SettingMarker = StreamSettingMarker;

// ─── Internal types ─────────────────────────────────────────────────────────

interface SessionState {
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
  presetName: string | null;
  customQuality: boolean;
  samples: StreamHistorySample[];
  markers: StreamSettingMarker[];
  totalBytes: number;
  lastBytes: number;          // for delta computation
  lastTimestamp: number;      // for delta computation
  lastBytesPerSecond: number; // most recent rate (bytes/s)
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 10_000;

// ─── Service ────────────────────────────────────────────────────────────────

export class StreamMetricsService {
  private static instance: StreamMetricsService | null = null;
  private sessions = new Map<string, SessionState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onHistoryChanged: (() => void) | null = null;
  private finalizing = new Set<string>();
  private finalizePromises = new Map<string, Promise<void>>();

  // Viewer-side tracker (kept for backward compat / Part 3 wiring)
  private _viewerBps = 0;
  private _viewerTotalBytes = 0;
  private _viewerSamples: { timestamp: number; bps: number }[] = [];

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
    const state: SessionState = {
      historyId,
      role: "host",
      status: "active",
      mediaSessionId,
      logicalStreamId,
      groupId,
      groupName,
      remoteDisplayName: null,
      startedAt: now,
      lastCheckpointAt: now,
      presetName,
      customQuality,
      samples: [],
      markers: [],
      totalBytes: 0,
      lastBytes: 0,
      lastTimestamp: now,
      lastBytesPerSecond: 0,
    };

    // Add initial quality marker if provided
    if (initialQualityLabel) {
      state.markers.push({
        timestamp: now,
        category: "other",
        from: null,
        to: initialQualityLabel,
        label: initialQualityLabel,
      });
    }

    this.sessions.set(historyId, state);
    // Persist immediately so even crashed streams are recorded
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
    const state: SessionState = {
      historyId,
      role: "viewer",
      status: "active",
      mediaSessionId,
      logicalStreamId,
      groupId,
      groupName,
      remoteDisplayName,
      startedAt: now,
      lastCheckpointAt: now,
      presetName: null,
      customQuality: false,
      samples: [],
      markers: [],
      totalBytes: 0,
      lastBytes: 0,
      lastTimestamp: now,
      lastBytesPerSecond: 0,
    };

    this.sessions.set(historyId, state);
    this.upsertRecord(this.buildRecord(state)).catch(() => {});
    this.ensureTimer();
    return historyId;
  }

  // ─── Data feed ──────────────────────────────────────────────────────────

  /** Feed cumulative host outbound bytes (in bytes, NOT bits) */
  feedHostBytes(historyId: string, cumulativeBytes: number, timestamp: number): void {
    const state = this.sessions.get(historyId);
    if (!state) return;
    if (state.role !== "host") return;

    if (cumulativeBytes >= state.lastBytes) {
      const deltaBytes = cumulativeBytes - state.lastBytes;
      const elapsed = (timestamp - state.lastTimestamp) / 1000;
      if (elapsed > 0 && deltaBytes >= 0) {
        const bytesPerSecond = elapsed > 0 ? Math.round(deltaBytes / elapsed) : 0;
        state.lastBytesPerSecond = bytesPerSecond;
      }
      state.totalBytes += deltaBytes;
    }
    // If cumulativeBytes < lastBytes, counter reset: just update baseline
    state.lastBytes = cumulativeBytes;
    state.lastTimestamp = timestamp;
  }

  /** Feed cumulative viewer download bytes (in bytes) */
  feedViewerBytes(historyId: string, cumulativeBytes: number, timestamp: number): void {
    const state = this.sessions.get(historyId);
    if (!state) return;
    if (state.role !== "viewer") return;

    if (cumulativeBytes >= state.lastBytes) {
      const deltaBytes = cumulativeBytes - state.lastBytes;
      const elapsed = (timestamp - state.lastTimestamp) / 1000;
      if (elapsed > 0 && deltaBytes >= 0) {
        const bytesPerSecond = elapsed > 0 ? Math.round(deltaBytes / elapsed) : 0;
        state.lastBytesPerSecond = bytesPerSecond;
      }
      state.totalBytes += deltaBytes;
    }
    state.lastBytes = cumulativeBytes;
    state.lastTimestamp = timestamp;
  }

  // ─── Markers ────────────────────────────────────────────────────────────

  addMarker(
    historyId: string,
    category: StreamSettingMarker["category"],
    from: string | null,
    to: string,
    label: string,
  ): void {
    const state = this.sessions.get(historyId);
    if (!state) return;
    state.markers.push({ timestamp: Date.now(), category, from, to, label });
  }

  // ─── Checkpoint & finalize ──────────────────────────────────────────────

  checkpointSession(historyId: string): void {
    const state = this.sessions.get(historyId);
    if (!state) return;

    state.samples.push({
      timestamp: Date.now(),
      bytesPerSecond: state.lastBytesPerSecond,
      totalBytes: state.totalBytes,
    });
    state.lastCheckpointAt = Date.now();
    state.status = "active"; // ensure still active while live
    // Recalculate duration
    const durationMs = Date.now() - state.startedAt;

    this.upsertRecord({
      historyId: state.historyId,
      role: state.role,
      status: "active",
      mediaSessionId: state.mediaSessionId,
      logicalStreamId: state.logicalStreamId,
      groupId: state.groupId,
      groupName: state.groupName,
      remoteDisplayName: state.remoteDisplayName,
      startedAt: state.startedAt,
      lastCheckpointAt: state.lastCheckpointAt,
      stoppedAt: null,
      durationMs,
      totalBytes: state.totalBytes,
      averageBytesPerSecond: durationMs > 0 ? Math.round((state.totalBytes * 1000) / durationMs) : 0,
      presetName: state.presetName,
      customQuality: state.customQuality,
      samples: [...state.samples],
      markers: [...state.markers],
      interrupted: false,
    }).catch(() => {});
  }

  async finalizeSession(historyId: string): Promise<void> {
    // Idempotent: if already finalizing, return existing promise
    if (this.finalizing.has(historyId)) {
      const existing = this.finalizePromises.get(historyId);
      if (existing) return existing;
    }

    const state = this.sessions.get(historyId);
    if (!state) return;

    this.finalizing.add(historyId);

    const promise = (async () => {
      try {
        // Take a final sample
        state.samples.push({
          timestamp: Date.now(),
          bytesPerSecond: state.lastBytesPerSecond,
          totalBytes: state.totalBytes,
        });

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
          samples: [...state.samples],
          markers: [...state.markers],
          interrupted: false,
        };

        await this.upsertRecord(record);
        this.sessions.delete(historyId);
      } finally {
        this.finalizing.delete(historyId);
        this.finalizePromises.delete(historyId);
        this.stopTimerIfIdle();
      }
    })();

    this.finalizePromises.set(historyId, promise);
    return promise;
  }

  // ─── Getters ────────────────────────────────────────────────────────────

  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get live samples.
   * @param id - historyId (preferred) or mediaSessionId (backward compat)
   */
  getLiveSamples(id: string): StreamHistorySample[] {
    const byHistoryId = this.sessions.get(id);
    if (byHistoryId) return byHistoryId.samples;
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === id) return state.samples;
    }
    return [];
  }

  /**
   * Get live markers.
   * @param id - historyId (preferred) or mediaSessionId (backward compat)
   */
  getLiveMarkers(id: string): StreamSettingMarker[] {
    const byHistoryId = this.sessions.get(id);
    if (byHistoryId) return byHistoryId.markers;
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === id) return state.markers;
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
   * Get total bytes for a historyId (direct lookup).
   * For backward compat by mediaSessionId, use getLiveHostTotal.
   */
  getLiveTotalBytes(historyId: string): number {
    return this.sessions.get(historyId)?.totalBytes ?? 0;
  }

  getLiveCurrentBytesPerSecond(historyId: string): number {
    return this.sessions.get(historyId)?.lastBytesPerSecond ?? 0;
  }

  /**
   * Get total host bytes for a session.
   * @param id - historyId (preferred) or mediaSessionId (backward compat)
   */
  getLiveHostTotal(id: string): number {
    const byHistoryId = this.sessions.get(id);
    if (byHistoryId) return byHistoryId.totalBytes;
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === id && state.role === "host") return state.totalBytes;
    }
    return 0;
  }

  getActiveMediaSessionIds(): string[] {
    const ids = new Set<string>();
    for (const state of this.sessions.values()) {
      ids.add(state.mediaSessionId);
    }
    return Array.from(ids);
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
      const api = (window as unknown as { screenlink?: { getStreamHistory?: () => Promise<StreamHistoryRecord[]>; saveStreamHistory?: (r: StreamHistoryRecord[]) => Promise<void> } }).screenlink;
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

  // ─── Backward-compatible lifecycle methods ──────────────────────────────

  /**
   * Backward-compatible onStreamStart — delegates to startHostSession.
   * @returns historyId
   */
  onStreamStart(
    mediaSessionId: string,
    logicalStreamId: string,
    groupId: string,
    groupName: string,
    presetName: string | null,
    customQuality: boolean,
    initialQualityLabel: string | null,
  ): string {
    return this.startHostSession(
      mediaSessionId,
      logicalStreamId,
      groupId,
      groupName,
      presetName,
      customQuality,
      initialQualityLabel,
    );
  }

  /**
   * Backward-compatible onStreamStop — looks up session by mediaSessionId
   * and finalizes it.
   */
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

  onViewerStats(mediaSessionId: string, _viewerDeviceId: string, _displayName: string, bytes: number): void {
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === mediaSessionId && state.role === "host") {
        this.feedHostBytes(state.historyId, bytes, Date.now());
        return;
      }
    }
  }

  // Backward-compat live getters by mediaSessionId
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
   * Backward-compat: returns bits per second (8 * bytesPerSecond).
   */
  getLiveCurrentBps(mediaSessionId: string): number {
    for (const state of this.sessions.values()) {
      if (state.mediaSessionId === mediaSessionId) {
        return state.lastBytesPerSecond * 8;
      }
    }
    return 0;
  }

  // ─── Viewer-side tracker (for viewer bandwidth graph, Part 3) ──────────

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

  // ─── Timer ─────────────────────────────────────────────────────────────

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const id of this.sessions.keys()) {
        this.checkpointSession(id);
      }
    }, SAMPLE_INTERVAL_MS);
  }

  private stopTimerIfIdle(): void {
    if (this.sessions.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  private buildRecord(state: SessionState): StreamHistoryRecord {
    const durationMs = Date.now() - state.startedAt;
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
      lastCheckpointAt: Date.now(),
      stoppedAt: state.role === "host" ? null : null,
      durationMs,
      totalBytes: state.totalBytes,
      averageBytesPerSecond: durationMs > 0 ? Math.round((state.totalBytes * 1000) / durationMs) : 0,
      presetName: state.presetName,
      customQuality: state.customQuality,
      samples: [...state.samples],
      markers: [...state.markers],
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
        // Fallback: read-modify-write (less safe but works)
        const existing = await api.getStreamHistory();
        const idx = existing.findIndex((r: StreamHistoryRecord) => r.historyId === record.historyId);
        if (idx >= 0) existing[idx] = record;
        else existing.push(record);
        await api.saveStreamHistory(existing);
      }
      this.onHistoryChanged?.();
    } catch {
      console.warn("[StreamMetricsService] Failed to upsert history record");
    }
  }

  // ─── ID generation ─────────────────────────────────────────────────────

  private generateId(): string {
    if (typeof globalThis !== "undefined" && typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    // Fallback for environments without crypto.randomUUID
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
