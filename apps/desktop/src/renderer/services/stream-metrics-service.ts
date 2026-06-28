/**
 * StreamMetricsService — renderer singleton that collects bandwidth samples,
 * setting-change markers, and persists completed stream history.
 *
 * Data sources (callers):
 *   - StreamSessionManager: onStreamStart, onQualityChange, onStreamStop
 *   - useHostViewerDiagnostics: onHostStats (outbound RTCP bytes)
 *
 * No Zustand involvement. No network messages. Pure local collection.
 */

export interface BandwidthSample {
  timestamp: number;
  hostUploadBps: number;
  totalViewerDownloadBps: number;
}

export interface SettingMarker {
  timestamp: number;
  label: string;
}

export interface StreamHistoryRecord {
  mediaSessionId: string;
  logicalStreamId: string;
  groupId: string;
  groupName: string;
  startedAt: number;
  stoppedAt: number;
  durationMs: number;
  hostUploadBytes: number;
  avgHostUploadBps: number;
  presetName: string | null;
  customQuality: boolean;
  markers: SettingMarker[];
  viewerDownloads: Record<string, { displayName: string; totalBytes: number }>;
  viewerCount: number;
}

interface SessionState {
  mediaSessionId: string;
  logicalStreamId: string;
  groupId: string;
  groupName: string;
  startedAt: number;
  presetName: string | null;
  customQuality: boolean;
  lastQualityLabel: string | null;
  samples: BandwidthSample[];
  markers: SettingMarker[];
  hostTotalBytes: number;
  viewerBytes: Map<string, { displayName: string; totalBytes: number; _lastBytes: number }>;
  lastHostBytes: number;
  lastHostTimestamp: number;
  lastAvgBpsWindow: number[];
}

const SAMPLE_INTERVAL_MS = 10_000;
const MAX_LIVE_SAMPLES = 180;

export class StreamMetricsService {
  private static instance: StreamMetricsService | null = null;
  private sessions = new Map<string, SessionState>();
  private nextSampleTimer: ReturnType<typeof setTimeout> | null = null;
  private onHistoryChanged: (() => void) | null = null;

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

  onStreamStart(
    mediaSessionId: string,
    logicalStreamId: string,
    groupId: string,
    groupName: string,
    presetName: string | null,
    customQuality: boolean,
    initialQualityLabel: string | null,
  ): void {
    const now = Date.now();
    const state: SessionState = {
      mediaSessionId,
      logicalStreamId,
      groupId,
      groupName,
      startedAt: now,
      presetName,
      customQuality,
      lastQualityLabel: initialQualityLabel,
      samples: [],
      markers: [],
      hostTotalBytes: 0,
      viewerBytes: new Map(),
      lastHostBytes: 0,
      lastHostTimestamp: now,
      lastAvgBpsWindow: [],
    };
    this.sessions.set(mediaSessionId, state);
    this.scheduleSample(mediaSessionId);
  }

  onQualityChange(mediaSessionId: string, label: string): void {
    const state = this.sessions.get(mediaSessionId);
    if (!state) return;
    const now = Date.now();
    state.markers.push({ timestamp: now, label });
    state.lastQualityLabel = label;
  }

  async onStreamStop(mediaSessionId: string): Promise<void> {
    const state = this.sessions.get(mediaSessionId);
    if (!state) return;
    const now = Date.now();
    this.clearSampleTimer();
    this.takeSample(mediaSessionId);
    const record = this.buildRecord(state, now);
    if (record) {
      await this.persistRecord(record);
    }
    this.sessions.delete(mediaSessionId);
  }

  onHostStats(mediaSessionId: string, bytes: number, timestamp: number): void {
    const state = this.sessions.get(mediaSessionId);
    if (!state) return;
    if (bytes >= state.lastHostBytes && state.lastHostTimestamp > 0 && state.lastHostBytes > 0) {
      const deltaBytes = bytes - state.lastHostBytes;
      const elapsed = (timestamp - state.lastHostTimestamp) / 1000;
      if (elapsed > 0) {
        const bps = Math.round(deltaBytes * 8 / elapsed);
        state.lastAvgBpsWindow.push(bps);
        if (state.lastAvgBpsWindow.length > 3) state.lastAvgBpsWindow.shift();
      }
    }
    if (bytes >= state.lastHostBytes) state.hostTotalBytes += bytes - state.lastHostBytes;
    state.lastHostBytes = bytes;
    state.lastHostTimestamp = timestamp;
  }

  onViewerStats(mediaSessionId: string, viewerDeviceId: string, displayName: string, bytes: number): void {
    const state = this.sessions.get(mediaSessionId);
    if (!state) return;
    let entry = state.viewerBytes.get(viewerDeviceId);
    if (!entry) {
      entry = { displayName, totalBytes: 0, _lastBytes: bytes };
      state.viewerBytes.set(viewerDeviceId, entry);
    } else {
      if (bytes > entry._lastBytes) entry.totalBytes += bytes - entry._lastBytes;
      entry._lastBytes = bytes;
    }
  }

  getLiveSamples(mediaSessionId: string, maxCount = MAX_LIVE_SAMPLES): BandwidthSample[] {
    const state = this.sessions.get(mediaSessionId);
    if (!state) return [];
    const samples = state.samples;
    return samples.length > maxCount ? samples.slice(-maxCount) : samples;
  }

  getLiveMarkers(mediaSessionId: string): SettingMarker[] {
    return this.sessions.get(mediaSessionId)?.markers ?? [];
  }

  getLiveStartTimeMs(mediaSessionId: string): number | null {
    return this.sessions.get(mediaSessionId)?.startedAt ?? null;
  }

  getLiveDuration(mediaSessionId: string): number {
    const state = this.sessions.get(mediaSessionId);
    return state ? Date.now() - state.startedAt : 0;
  }

  getLiveHostTotal(mediaSessionId: string): number {
    return this.sessions.get(mediaSessionId)?.hostTotalBytes ?? 0;
  }

  getLiveViewerCount(mediaSessionId: string): number {
    return this.sessions.get(mediaSessionId)?.viewerBytes.size ?? 0;
  }

  getLiveCurrentBps(mediaSessionId: string): number {
    const state = this.sessions.get(mediaSessionId);
    if (!state || state.lastAvgBpsWindow.length === 0) return 0;
    const sum = state.lastAvgBpsWindow.reduce((a, b) => a + b, 0);
    return Math.round(sum / state.lastAvgBpsWindow.length);
  }

  getActiveMediaSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Feed viewer download stats for the viewer-side bandwidth graph */
  feedViewerBandwidth(bps: number, totalBytes: number): void {
    // Store in a simple viewer-side tracker
    this._viewerBps = bps;
    this._viewerTotalBytes = totalBytes;
    this._viewerSamples = this._viewerSamples || [];
    this._viewerSamples.push({ timestamp: Date.now(), bps });
    if (this._viewerSamples.length > MAX_LIVE_SAMPLES) {
      this._viewerSamples = this._viewerSamples.slice(-MAX_LIVE_SAMPLES);
    }
  }

  private _viewerBps = 0;
  private _viewerTotalBytes = 0;
  private _viewerSamples: { timestamp: number; bps: number }[] = [];

  getViewerBps(): number { return this._viewerBps; }
  getViewerTotalBytes(): number { return this._viewerTotalBytes; }
  getViewerSamples(): { timestamp: number; bps: number }[] { return [...(this._viewerSamples || [])]; }

  private async persistRecord(record: StreamHistoryRecord): Promise<void> {
    try {
      const api = (
        window as unknown as {
          screenlink?: {
            getStreamHistory?: () => Promise<StreamHistoryRecord[]>;
            saveStreamHistory?: (r: StreamHistoryRecord[]) => Promise<void>;
          };
        }
      ).screenlink;
      if (!api?.getStreamHistory || !api?.saveStreamHistory) return;
      const existing = await api.getStreamHistory();
      existing.push(record);
      await api.saveStreamHistory(existing);
      this.onHistoryChanged?.();
    } catch {
      console.warn("[StreamMetricsService] Failed to persist history record");
    }
  }

  async getHistory(): Promise<StreamHistoryRecord[]> {
    try {
      const api = (window as unknown as { screenlink?: { getStreamHistory?: () => Promise<StreamHistoryRecord[]> } }).screenlink;
      if (!api?.getStreamHistory) return [];
      return await api.getStreamHistory();
    } catch {
      return [];
    }
  }

  private scheduleSample(mediaSessionId: string): void {
    if (this.nextSampleTimer) return;
    this.nextSampleTimer = setTimeout(() => {
      this.nextSampleTimer = null;
      for (const [id] of this.sessions) this.takeSample(id);
      if (this.sessions.size > 0) this.scheduleSample(this.sessions.keys().next().value!);
    }, SAMPLE_INTERVAL_MS);
  }

  private clearSampleTimer(): void {
    if (this.nextSampleTimer) { clearTimeout(this.nextSampleTimer); this.nextSampleTimer = null; }
  }

  private takeSample(mediaSessionId: string): void {
    const state = this.sessions.get(mediaSessionId);
    if (!state) return;
    const hostBps = state.lastAvgBpsWindow.length > 0
      ? Math.round(state.lastAvgBpsWindow.reduce((a, b) => a + b, 0) / state.lastAvgBpsWindow.length)
      : 0;
    state.samples.push({ timestamp: Date.now(), hostUploadBps: hostBps, totalViewerDownloadBps: 0 });
    if (state.samples.length > MAX_LIVE_SAMPLES) state.samples = state.samples.slice(-MAX_LIVE_SAMPLES);
  }

  private buildRecord(state: SessionState, now: number): StreamHistoryRecord | null {
    const durationMs = now - state.startedAt;
    // no minimum duration
    return {
      mediaSessionId: state.mediaSessionId,
      logicalStreamId: state.logicalStreamId,
      groupId: state.groupId,
      groupName: state.groupName,
      startedAt: state.startedAt,
      stoppedAt: now,
      durationMs,
      hostUploadBytes: state.hostTotalBytes,
      avgHostUploadBps: durationMs > 0 ? Math.round((state.hostTotalBytes * 8 * 1000) / durationMs) : 0,
      presetName: state.presetName,
      customQuality: state.customQuality,
      markers: [...state.markers],
      viewerDownloads: Object.fromEntries(
        Array.from(state.viewerBytes.entries()).map(([k, v]) => [k, { displayName: v.displayName, totalBytes: v.totalBytes }]),
      ),
      viewerCount: state.viewerBytes.size,
    };
  }
}
