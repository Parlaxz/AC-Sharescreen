import { Fragment, useSyncExternalStore, useMemo, useState, useCallback, useEffect } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Label,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label as UILabel } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  TelemetrySample,
  BandwidthSnapshot,
  AggregatedBucket,
  TelemetryMarker,
  MarkerType,
  ViewerRateEntry,
  TelemetryState,
} from "@/services/bandwidth-telemetry-types";
import {
  fmtBitRate,
  fmtCumulativeBytes,
  fmtDuration,
  fmtHourlyUsage,
  estimateHourlyBytes,
} from "@/services/bandwidth-telemetry-types";
import { StreamMetricsService } from "@/services/stream-metrics-service";
import { loadSettings } from "@/services/settings-actions";

// ─── Constants ──────────────────────────────────────────────────────────────

const TIME_RANGES = [
  { label: "60s", value: 60_000 },
  { label: "5 min", value: 300_000 },
  { label: "30 min", value: 1_800_000 },
  { label: "Session", value: Infinity },
] as const;

type SeriesKey = "total" | "video" | "audio" | "network";

const SERIES_CONFIG: Record<SeriesKey, { label: string; color: string; defaultOn: boolean }> = {
  total:   { label: "Total media",  color: "var(--color-accent)",     defaultOn: true },
  video:   { label: "Video",        color: "var(--color-chart-1, #3b82f6)", defaultOn: true },
  audio:   { label: "Audio",        color: "var(--color-chart-2, #22c55e)", defaultOn: false },
  network: { label: "Network/wire", color: "var(--color-chart-3, #f59e0b)", defaultOn: false },
};

const EMPTY_SNAPSHOT: BandwidthSnapshot = Object.freeze({
  historyId: "",
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
    currentVideoBitsPerSecond: null,
    currentAudioBitsPerSecond: null,
    currentTransportBitsPerSecond: null,
    state: "paused" as TelemetryState,
  }),
  connections: Object.freeze([]),
});

// ─── Props ──────────────────────────────────────────────────────────────────

interface BandwidthGraphModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaSessionId: string | null;
  viewerMode?: boolean;
  viewerHistoryId?: string | null;
  contentOnly?: boolean;
}

// ─── Chart data types ───────────────────────────────────────────────────────

interface ChartDataPoint {
  time: number;
  smoothed?: number;
  raw?: number;
  target?: number;
  video?: number | null;
  audio?: number | null;
  transport?: number | null;
}

interface HealthDataPoint {
  time: number;
  packetLoss?: number | null;
  rtt?: number | null;
  jitter?: number | null;
  state?: TelemetryState;
}

// ─── resolveHistoryId ───────────────────────────────────────────────────────

function resolveHistoryId(
  mediaSessionId: string | null,
  viewerHistoryId: string | null,
): { historyId: string | null; role: "host" | "viewer" } {
  if (viewerHistoryId) {
    return { historyId: viewerHistoryId, role: "viewer" };
  }
  if (!mediaSessionId) {
    return { historyId: null, role: "host" };
  }

  const svc = StreamMetricsService.getInstance();
  const hid = svc.findHistoryIdByMediaSessionId(mediaSessionId);
  if (hid) {
    const snap = svc.getSnapshot(hid);
    return { historyId: hid, role: snap.role };
  }

  return { historyId: null, role: "host" };
}

// ─── 30-second average from medium buckets ──────────────────────────────────

function compute30sAverage(series: { mediumBuckets: readonly AggregatedBucket[] }): number {
  const buckets = series.mediumBuckets;
  if (buckets.length === 0) return 0;
  // Last 6 medium buckets ≈ 30 seconds (5s each)
  const last = buckets.slice(-6);
  let totalWeight = 0;
  let weightedSum = 0;
  for (const b of last) {
    totalWeight += b.intervalMs;
    weightedSum += b.weightedAverageBitsPerSecond * b.intervalMs;
  }
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

// ─── Per-kind cumulative estimation from raw samples ───────────────────────

interface KindTotals {
  videoBytes: number;
  audioBytes: number;
  transportBytes: number;
  videoRateSum: number;
  audioRateSum: number;
  transportRateSum: number;
  sampleCount: number;
}

function computeKindTotals(samples: readonly TelemetrySample[]): KindTotals {
  let videoBytes = 0;
  let audioBytes = 0;
  let transportBytes = 0;
  let videoRateSum = 0;
  let audioRateSum = 0;
  let transportRateSum = 0;
  let sampleCount = 0;

  for (const s of samples) {
    const deltaBytes = Math.round((s.mediaBitsPerSecond * s.intervalMs) / 8000);
    if (s.videoBitsPerSecond != null && s.audioBitsPerSecond != null && deltaBytes > 0) {
      const totalRate = s.videoBitsPerSecond + s.audioBitsPerSecond;
      if (totalRate > 0) {
        const videoFrac = s.videoBitsPerSecond / totalRate;
        const audioFrac = s.audioBitsPerSecond / totalRate;
        videoBytes += Math.round(deltaBytes * videoFrac);
        audioBytes += Math.round(deltaBytes * audioFrac);
      }
    }
    if (s.transportBitsPerSecond != null) {
      const transportDeltaBytes = Math.round((s.transportBitsPerSecond * s.intervalMs) / 8000);
      transportBytes += transportDeltaBytes;
    }
    videoRateSum += s.videoBitsPerSecond ?? 0;
    audioRateSum += s.audioBitsPerSecond ?? 0;
    transportRateSum += s.transportBitsPerSecond ?? 0;
    sampleCount++;
  }

  return { videoBytes, audioBytes, transportBytes, videoRateSum, audioRateSum, transportRateSum, sampleCount };
}

// ─── Short duration formatter for label ──────────────────────────────────────

function fmtShortDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  return `${minutes}m`;
}

// ─── Windowed hourly estimate ───────────────────────────────────────────────

function computeWindowedEstimate(
  samples: readonly TelemetrySample[],
  windowMs: number,
  fallbackTotalBytes: number,
  fallbackActiveDurationMs: number,
): { bytesPerHour: number; actualDurationMs: number } {
  if (samples.length < 2) {
    return {
      bytesPerHour: estimateHourlyBytes(fallbackTotalBytes, fallbackActiveDurationMs),
      actualDurationMs: fallbackActiveDurationMs,
    };
  }

  const now = Date.now();
  const cutoff = now - windowMs;

  // Find first sample within the window
  let startIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].timestampMs >= cutoff) {
      startIdx = i;
      break;
    }
  }

  // Not enough samples in window — fall back to session span
  if (startIdx >= samples.length - 1) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const byteDelta = last.cumulativeMediaBytes - first.cumulativeMediaBytes;
    const timeDelta = last.timestampMs - first.timestampMs;
    if (byteDelta > 0 && timeDelta > 0) {
      return {
        bytesPerHour: estimateHourlyBytes(byteDelta, timeDelta),
        actualDurationMs: timeDelta,
      };
    }
    return {
      bytesPerHour: estimateHourlyBytes(fallbackTotalBytes, fallbackActiveDurationMs),
      actualDurationMs: fallbackActiveDurationMs,
    };
  }

  const first = samples[startIdx];
  const last = samples[samples.length - 1];
  const byteDelta = last.cumulativeMediaBytes - first.cumulativeMediaBytes;
  const timeDelta = last.timestampMs - first.timestampMs;

  if (byteDelta <= 0 || timeDelta <= 0) {
    return {
      bytesPerHour: estimateHourlyBytes(fallbackTotalBytes, fallbackActiveDurationMs),
      actualDurationMs: fallbackActiveDurationMs,
    };
  }

  return {
    bytesPerHour: estimateHourlyBytes(byteDelta, timeDelta),
    actualDurationMs: timeDelta,
  };
}

// ─── Chart data preparation ─────────────────────────────────────────────────

function getChartData(
  series: { rawSamples: readonly TelemetrySample[]; mediumBuckets: readonly AggregatedBucket[]; longBuckets: readonly AggregatedBucket[] },
  rangeMs: number,
  showRaw: boolean,
): ChartDataPoint[] {
  const { rawSamples, mediumBuckets, longBuckets } = series;

  if (
    rawSamples.length === 0 &&
    mediumBuckets.length === 0 &&
    longBuckets.length === 0
  ) {
    return [];
  }

  // Short ranges (60s, 5 min): use raw 1s samples (wall-clock timestamps)
  if (rangeMs <= 300_000 && rawSamples.length > 0) {
    const now = Date.now();
    const cutoff = now - rangeMs;
    const data: ChartDataPoint[] = [];

    for (let i = 0; i < rawSamples.length; i++) {
      const s = rawSamples[i];
      if (s.timestampMs < cutoff) continue;
      data.push({
        time: s.timestampMs,
        smoothed: s.mediaBitsPerSecond,
        raw: showRaw ? s.mediaBitsPerSecond : undefined,
        target: s.configuredVideoBitsPerSecond ?? undefined,
        video: s.videoBitsPerSecond ?? null,
        audio: s.audioBitsPerSecond ?? null,
        transport: s.transportBitsPerSecond ?? null,
      });
    }

    return data;
  }

  // Medium/long ranges: use aggregated buckets (monotonic timestamps)
  // Count-based truncation avoids mixing monotonic and wall-clock times
  const useMedium =
    mediumBuckets.length > 0 &&
    (rangeMs <= 1_800_000 || longBuckets.length === 0);
  const buckets = useMedium ? mediumBuckets : longBuckets;
  const bucketDuration = useMedium ? 5_000 : 30_000;

  if (buckets.length === 0) return [];

  const maxBuckets =
    rangeMs === Infinity
      ? buckets.length
      : Math.min(Math.ceil(rangeMs / bucketDuration), buckets.length);
  const subset = buckets.slice(-maxBuckets);
  if (subset.length === 0) return [];

  return subset.map((b) => ({
    time: b.startTimestampMs,
    smoothed: b.weightedAverageBitsPerSecond,
  }));
}

function getConnectionHealthData(
  series: { rawSamples: readonly TelemetrySample[] },
  rangeMs: number,
): HealthDataPoint[] {
  const samples = series.rawSamples;
  if (samples.length === 0) return [];
  const now = Date.now();
  const cutoff = rangeMs === Infinity ? 0 : now - rangeMs;
  return samples
    .filter((s) => s.timestampMs >= cutoff)
    .map((s) => ({
      time: s.timestampMs,
      packetLoss: s.packetLossPercent,
      rtt: s.rttMs,
      jitter: s.jitterMs,
      state: s.state,
    }));
}

// ─── Marker clustering ──────────────────────────────────────────────────────

function clusterMarkers(
  markers: readonly TelemetryMarker[],
): TelemetryMarker[][] {
  if (markers.length === 0) return [];
  const sorted = [...markers].sort((a, b) => a.timestampMs - b.timestampMs);
  const clusters: TelemetryMarker[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const lastCluster = clusters[clusters.length - 1];
    const lastMarker = lastCluster[lastCluster.length - 1];
    if (sorted[i].timestampMs - lastMarker.timestampMs < 2000) {
      lastCluster.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  return clusters;
}

// ─── Marker color by type ───────────────────────────────────────────────────

function getMarkerColor(type: MarkerType): string {
  switch (type) {
    case "bitrate":
    case "preset":
    case "resolution":
    case "fps":
    case "codec":
    case "quality":
      return "var(--color-warning)";
    case "turn":
    case "reconnect":
      return "var(--color-destructive)";
    case "pause":
    case "resume":
      return "var(--color-warning)";
    case "viewer-join":
    case "viewer-leave":
      return "var(--color-success)";
    case "source-switch":
    case "enhancement":
    case "other":
    default:
      return "var(--color-text-muted)";
  }
}

// ─── Axis formatters ────────────────────────────────────────────────────────

function formatTimeAxis(timestampMs: number): string {
  // timestampMs is epoch. Render elapsed from chart minimum.
  return ""; // Auto-formatted by Recharts with number type
}

function formatTooltipTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString();
}

function formatBitRateAxis(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) return (bitsPerSecond / 1_000_000).toFixed(1) + "M";
  if (bitsPerSecond >= 1000) return Math.round(bitsPerSecond / 1000) + "k";
  return String(Math.round(bitsPerSecond));
}

// ─── useBandwidthSnapshot hook ──────────────────────────────────────────────

function useBandwidthSnapshot(historyId: string | null): BandwidthSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!historyId) return () => {};
      return StreamMetricsService.getInstance().subscribe(
        historyId,
        onStoreChange,
      );
    },
    [historyId],
  );

  const getSnapshot = useCallback(() => {
    if (!historyId) return EMPTY_SNAPSHOT;
    return StreamMetricsService.getInstance().getSnapshot(historyId);
  }, [historyId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

// ─── Custom chart tooltips ──────────────────────────────────────────────────

function ThroughputTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload: ChartDataPoint }[];
  label?: number;
}) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;

  return (
    <div className="rounded-standard border border-border-subtle bg-surface-3 p-3 text-xs shadow-md">
      <div className="mb-1.5 text-text-muted">
        {formatTooltipTime(label ?? 0)}
      </div>
      <div className="space-y-0.5">
        {d.smoothed !== undefined && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Total media</span>
            <span className="font-mono tabular-nums text-text-primary">
              {fmtBitRate(d.smoothed)}
            </span>
          </div>
        )}
        {d.raw !== undefined && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Raw</span>
            <span className="font-mono tabular-nums text-text-primary">
              {fmtBitRate(d.raw)}
            </span>
          </div>
        )}
        {d.target !== undefined && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Target</span>
            <span className="font-mono tabular-nums text-text-primary">
              {fmtBitRate(d.target)}
            </span>
          </div>
        )}
        {d.video != null && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Video</span>
            <span className="font-mono tabular-nums text-text-primary">
              {fmtBitRate(d.video)}
            </span>
          </div>
        )}
        {d.audio != null && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Audio</span>
            <span className="font-mono tabular-nums text-text-primary">
              {fmtBitRate(d.audio)}
            </span>
          </div>
        )}
        {d.transport != null && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Network/Wire</span>
            <span className="font-mono tabular-nums text-text-primary">
              {fmtBitRate(d.transport)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function HealthTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload: HealthDataPoint }[];
  label?: number;
}) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;

  return (
    <div className="rounded-standard border border-border-subtle bg-surface-3 p-3 text-xs shadow-md">
      <div className="mb-1.5 text-text-muted">
        t + {formatTimeAxis(label ?? 0)}
      </div>
      <div className="space-y-0.5">
        {d.rtt != null && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">RTT</span>
            <span className="font-mono tabular-nums text-text-primary">
              {d.rtt.toFixed(0)} ms
            </span>
          </div>
        )}
        {d.packetLoss != null && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Packet Loss</span>
            <span className="font-mono tabular-nums text-text-primary">
              {d.packetLoss.toFixed(1)}%
            </span>
          </div>
        )}
        {d.jitter != null && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Jitter</span>
            <span className="font-mono tabular-nums text-text-primary">
              {d.jitter.toFixed(1)} ms
            </span>
          </div>
        )}
        {d.state && (
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">State</span>
            <Badge
              variant={
                d.state === "paused"
                  ? "warning"
                  : d.state === "reconnecting"
                    ? "destructive"
                    : "success"
              }
              className="text-[10px] leading-none"
            >
              {d.state}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Summary Item sub-component ─────────────────────────────────────────────

function SummaryItem({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-0.5 truncate">
        {label}
      </div>
      {children ?? (
        <div className="font-mono tabular-nums text-xs truncate">
          {value ?? "\u2014"}
        </div>
      )}
    </div>
  );
}

// ─── Series Toggle Component ────────────────────────────────────────────────

function SeriesToggle({
  seriesKey,
  enabled,
  onToggle,
}: {
  seriesKey: SeriesKey;
  enabled: boolean;
  onToggle: () => void;
}) {
  const cfg = SERIES_CONFIG[seriesKey];
  return (
    <label className="flex items-center gap-1.5 cursor-pointer text-xs select-none">
      <Checkbox checked={enabled} onCheckedChange={onToggle} />
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ backgroundColor: cfg.color }}
      />
      <span className="text-text-secondary">{cfg.label}</span>
    </label>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function BandwidthGraphModal({
  open,
  onOpenChange,
  mediaSessionId,
  viewerMode = false,
  viewerHistoryId = null,
  contentOnly = false,
}: BandwidthGraphModalProps) {
  // Resolve history ID
  const resolved = useMemo(
    () =>
      resolveHistoryId(
        viewerMode ? null : mediaSessionId,
        viewerHistoryId ?? null,
      ),
    [mediaSessionId, viewerMode, viewerHistoryId],
  );

  // Subscribe to snapshot
  const snapshot = useBandwidthSnapshot(resolved.historyId);
  const role = resolved.role;

  // UI state
  const [timeRange, setTimeRange] = useState<number>(300_000); // default 5 min
  const [showRaw, setShowRaw] = useState(false);
  const [selectedViewer, setSelectedViewer] = useState<string>("__all__");
  const [enabledSeries, setEnabledSeries] = useState<Set<SeriesKey>>(() => new Set(["total", "video"]));
  const [hourlyEstimateDurationMs, setHourlyEstimateDurationMs] = useState(10_000);

  // Load user-configured hourly estimate window from settings
  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then((s) => {
        if (!cancelled) {
          setHourlyEstimateDurationMs(s.hourlyEstimateDurationMs ?? 10_000);
        }
      })
      .catch(() => {
        // keep default
      });
    return () => { cancelled = true; };
  }, []);

  const toggleSeries = useCallback((key: SeriesKey) => {
    setEnabledSeries(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Resolve which series to use based on selected viewer
  const selectedSeries = useMemo((): typeof snapshot.aggregate => {
    if (selectedViewer === "__all__" || snapshot.connections.length === 0) {
      return snapshot.aggregate;
    }
    const conn = snapshot.connections.find(
      (c) => (c.viewerDeviceId ?? c.connectionId) === selectedViewer
    );
    if (!conn) return snapshot.aggregate;
    return {
      rawSamples: conn.rawSamples,
      mediumBuckets: conn.mediumBuckets,
      longBuckets: conn.longBuckets,
      markers: conn.markers,
      currentBitsPerSecond: conn.currentBitsPerSecond,
      averageBitsPerSecond: conn.averageBitsPerSecond,
      peakBitsPerSecond: conn.peakBitsPerSecond,
      totalBytes: conn.totalBytes,
      durationMs: conn.durationMs,
      activeDurationMs: conn.activeDurationMs,
      configuredBitsPerSecond: conn.configuredBitsPerSecond,
      effectiveBitsPerSecond: conn.effectiveBitsPerSecond,
      state: conn.state,
    } as typeof snapshot.aggregate;
  }, [selectedViewer, snapshot]);

  // Latest raw sample for current split values
  const latestSample = useMemo(() => {
    const samples = selectedSeries.rawSamples;
    return samples.length > 0 ? samples[samples.length - 1] : null;
  }, [selectedSeries.rawSamples]);

  // Compute per-kind totals from raw samples
  const kindTotals = useMemo(
    () => computeKindTotals(selectedSeries.rawSamples),
    [selectedSeries.rawSamples],
  );

  // Current bitrates from latest sample
  const currentVideoBps = latestSample?.videoBitsPerSecond ?? 0;
  const currentAudioBps = latestSample?.audioBitsPerSecond ?? 0;
  const currentTransportBps = latestSample?.transportBitsPerSecond ?? 0;

  // Compute summary values
  const avg30s = useMemo(() => compute30sAverage(selectedSeries), [selectedSeries]);
  const hourlyEstimate = useMemo(
    () =>
      computeWindowedEstimate(
        selectedSeries.rawSamples,
        hourlyEstimateDurationMs,
        selectedSeries.totalBytes,
        selectedSeries.activeDurationMs,
      ),
    [selectedSeries.rawSamples, hourlyEstimateDurationMs, selectedSeries.totalBytes, selectedSeries.activeDurationMs],
  );

  // Chart data
  const chartData = useMemo(
    () => getChartData(selectedSeries, timeRange, showRaw),
    [selectedSeries, timeRange, showRaw],
  );

  const healthData = useMemo(
    () => getConnectionHealthData(selectedSeries, timeRange),
    [selectedSeries, timeRange],
  );

  // Markers
  const markerClusters = useMemo(
    () => clusterMarkers(selectedSeries.markers),
    [selectedSeries.markers],
  );

  // Only show markers within the selected time range
  const visibleMarkers = useMemo(() => {
    const now = Date.now();
    const cutoff = timeRange === Infinity ? 0 : now - timeRange;
    return markerClusters.filter((cluster) =>
      cluster.some((m) => m.timestampMs >= cutoff),
    );
  }, [markerClusters, timeRange]);

  // Viewer selector items (host mode)
  const viewerOptions = useMemo(() => {
    if (role !== "host" || snapshot.connections.length === 0) return [];
    return [
      { value: "__all__", label: "All Viewers" },
      ...snapshot.connections.map((v) => ({
        value: v.viewerDeviceId ?? v.connectionId,
        label: v.variantId ? `${v.displayName ?? v.connectionId} [Variant ${v.variantId}]` : (v.displayName ?? v.connectionId),
        variantId: v.variantId,
      })),
    ];
  }, [role, snapshot.connections]);

  // Determine if we have any data
  const hasData =
    selectedSeries.rawSamples.length > 0 ||
    selectedSeries.mediumBuckets.length > 0 ||
    selectedSeries.longBuckets.length > 0;

  // Detect if any connection has a compare variant label
  const hasCompareVariant = useMemo(
    () => snapshot.connections.some((c) => c.variantId),
    [snapshot.connections],
  );

  // Determine if we have split data for chart rendering
  const hasVideoData = chartData.some(d => d.video != null);
  const hasAudioData = chartData.some(d => d.audio != null);
  const hasTransportData = chartData.some(d => d.transport != null);
  const hasSplitData = hasVideoData || hasAudioData || hasTransportData;
  const canShowVideo = hasVideoData && kindTotals.sampleCount > 0;
  const canShowAudio = hasAudioData && kindTotals.sampleCount > 0;
  const canShowTransport = hasTransportData && kindTotals.sampleCount > 0;

  // Colors for chart series
  const seriesColors = {
    total: "var(--color-accent)",
    video: "var(--color-chart-1, #3b82f6)",
    audio: "var(--color-chart-2, #22c55e)",
    network: "var(--color-chart-3, #f59e0b)",
  };

  const content = (
    <Fragment>
      <div className="text-base font-semibold mb-2 text-text-primary flex items-center gap-2">
        Bandwidth
        {hasCompareVariant && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            Compare
          </Badge>
        )}
      </div>

      <ScrollArea className="max-h-[calc(85vh-6rem)] pr-2">
        {/* ── Summary Row ── */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 mb-2 text-xs">
          <SummaryItem
            label="Current"
            value={fmtBitRate(selectedSeries.currentBitsPerSecond)}
          />
          <SummaryItem label="30s Avg" value={fmtBitRate(avg30s)} />
          <SummaryItem
            label="Peak"
            value={fmtBitRate(selectedSeries.peakBitsPerSecond)}
          />
          <SummaryItem
            label="Total"
            value={fmtCumulativeBytes(selectedSeries.totalBytes)}
          />
          <SummaryItem
            label={`Est/hr (last ${fmtShortDuration(hourlyEstimateDurationMs)})`}
            value={
              hourlyEstimate.bytesPerHour > 0
                ? fmtHourlyUsage(hourlyEstimate.bytesPerHour)
                : "\u2014"
            }
          />
          <SummaryItem label="Duration">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono tabular-nums">
                {fmtDuration(selectedSeries.durationMs)}
              </span>
              {selectedSeries.state === "paused" && (
                <Badge variant="warning" className="text-[10px] px-1.5 py-0">
                  paused
                </Badge>
              )}
              {selectedSeries.state === "reconnecting" && (
                <Badge
                  variant="destructive"
                  className="text-[10px] px-1.5 py-0"
                >
                  reconnecting
                </Badge>
              )}
            </div>
          </SummaryItem>
        </div>

        {/* ── Split Summary Row (video/audio/network) ── */}
        {hasSplitData && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 mb-2 text-xs">
            <SummaryItem
              label="Video curr."
              value={fmtBitRate(currentVideoBps)}
            />
            <SummaryItem
              label="Audio curr."
              value={fmtBitRate(currentAudioBps)}
            />
            {currentTransportBps > 0 && (
              <SummaryItem
                label="Wire curr."
                value={fmtBitRate(currentTransportBps)}
              />
            )}
            <SummaryItem
              label="Video total"
              value={fmtCumulativeBytes(kindTotals.videoBytes)}
            />
            <SummaryItem
              label="Audio total"
              value={fmtCumulativeBytes(kindTotals.audioBytes)}
            />
            {kindTotals.transportBytes > 0 && (
              <SummaryItem
                label="Wire total"
                value={fmtCumulativeBytes(kindTotals.transportBytes)}
              />
            )}
          </div>
        )}

        {/* ── Time Range Selector ── */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex gap-0.5">
            {TIME_RANGES.map((r) => (
              <Button
                key={r.label}
                variant={timeRange === r.value ? "default" : "outline"}
                size="sm"
                onClick={() => setTimeRange(r.value)}
                className="text-xs"
              >
                {r.label}
              </Button>
            ))}
          </div>

          {chartData.length > 0 &&
            selectedSeries.rawSamples.length > 0 &&
            timeRange <= 300_000 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={showRaw ? "default" : "outline"}
                    size="sm"
                    onClick={() => setShowRaw(!showRaw)}
                    className="text-xs"
                  >
                    Raw
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Toggle raw bandwidth samples
                </TooltipContent>
              </Tooltip>
            )}
        </div>

        {/* ── Per-Viewer Selector (Host Mode) ── */}
        {role === "host" && viewerOptions.length > 1 && (
          <div className="mb-1.5">
            <Select
              value={selectedViewer}
              onValueChange={setSelectedViewer}
            >
              <SelectTrigger className="w-48 h-8 text-xs">
                <SelectValue placeholder="All Viewers" />
              </SelectTrigger>
              <SelectContent>
                {viewerOptions.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    className="text-xs"
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* ── Empty State ── */}
        {!hasData ? (
            <div className="h-24 flex items-center justify-center text-sm text-text-muted">
              No bandwidth data available yet.
            </div>
        ) : (
          <Tabs defaultValue="throughput">
            <TabsList className="mb-1">
              <TabsTrigger value="throughput">Throughput</TabsTrigger>
              <TabsTrigger value="health">
                Connection Health
              </TabsTrigger>
            </TabsList>

            {/* ── Throughput Tab ── */}
            <TabsContent value="throughput">
              {chartData.length === 0 ? (
                <div className="h-24 flex items-center justify-center text-sm text-text-muted">
                  No bandwidth data available yet.
                </div>
              ) : (
                <>
                  {/* Series toggles */}
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    {([ "total", "video", "audio", "network" ] as SeriesKey[]).map((key) => {
                      const dataAvailable = key === "total" || (key === "video" && canShowVideo) || (key === "audio" && canShowAudio) || (key === "network" && canShowTransport);
                      if (!dataAvailable) return null;
                      return (
                        <SeriesToggle
                          key={key}
                          seriesKey={key}
                          enabled={enabledSeries.has(key)}
                          onToggle={() => toggleSeries(key)}
                        />
                      );
                    })}
                  </div>

                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={chartData}
                        margin={{
                          top: 4,
                          right: 4,
                          left: 0,
                          bottom: 0,
                        }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="var(--color-border)"
                        />
                        <XAxis
                          dataKey="time"
                          type="number"
                          domain={["dataMin", "dataMax"]}
                          tickFormatter={formatTimeAxis}
                          tick={{ fontSize: 11 }}
                          stroke="var(--color-text-muted)"
                        />
                        <YAxis
                          tickFormatter={formatBitRateAxis}
                          tick={{ fontSize: 11 }}
                          stroke="var(--color-text-muted)"
                          label={{
                            value: "bps",
                            angle: -90,
                            position: "insideLeft",
                            style: {
                              fontSize: 11,
                              fill: "var(--color-text-muted)",
                            },
                          }}
                        />
                        <RechartsTooltip
                          content={<ThroughputTooltip />}
                        />

                        {/* Total media (EWMA smoothed) line */}
                        {enabledSeries.has("total") && (
                          <Area
                            type="monotone"
                            dataKey="smoothed"
                            name="Total media"
                            stroke={seriesColors.total}
                            fill={seriesColors.total}
                            fillOpacity={0.08}
                            isAnimationActive={false}
                            dot={false}
                            strokeWidth={2}
                          />
                        )}

                        {/* Raw samples area (optional toggle) */}
                        {showRaw && enabledSeries.has("total") && (
                          <Area
                            type="monotone"
                            dataKey="raw"
                            name="Raw"
                            stroke="var(--color-text-muted)"
                            fill="var(--color-text-muted)"
                            fillOpacity={0.04}
                            isAnimationActive={false}
                            dot={false}
                            strokeWidth={1}
                          />
                        )}

                        {/* Video series */}
                        {enabledSeries.has("video") && hasVideoData && (
                          <Area
                            type="monotone"
                            dataKey="video"
                            name="Video"
                            stroke={seriesColors.video}
                            fill={seriesColors.video}
                            fillOpacity={0.06}
                            isAnimationActive={false}
                            dot={false}
                            strokeWidth={1.5}
                            connectNulls={false}
                          />
                        )}

                        {/* Audio series */}
                        {enabledSeries.has("audio") && hasAudioData && (
                          <Area
                            type="monotone"
                            dataKey="audio"
                            name="Audio"
                            stroke={seriesColors.audio}
                            fill={seriesColors.audio}
                            fillOpacity={0.06}
                            isAnimationActive={false}
                            dot={false}
                            strokeWidth={1.5}
                            connectNulls={false}
                          />
                        )}

                        {/* Network/Wire series */}
                        {enabledSeries.has("network") && hasTransportData && (
                          <Area
                            type="monotone"
                            dataKey="transport"
                            name="Network/Wire"
                            stroke={seriesColors.network}
                            fill={seriesColors.network}
                            fillOpacity={0.06}
                            isAnimationActive={false}
                            dot={false}
                            strokeWidth={1.5}
                            connectNulls={false}
                          />
                        )}

                        {/* Target reference line */}
                        {selectedSeries.configuredBitsPerSecond != null &&
                          selectedSeries.configuredBitsPerSecond > 0 && (
                            <ReferenceLine
                              y={selectedSeries.configuredBitsPerSecond}
                              stroke="var(--color-warning)"
                              strokeDasharray="6 3"
                              label={
                                <Label
                                  value={`Target: ${fmtBitRate(selectedSeries.configuredBitsPerSecond)}`}
                                  position="right"
                                  style={{
                                    fontSize: 10,
                                    fill: "var(--color-warning)",
                                  }}
                                />
                              }
                            />
                          )}

                        {/* Marker reference lines */}
                        {visibleMarkers.map((cluster) => {
                          const first = cluster[0];
                          const markerTime = first.timestampMs;
                          const label =
                            cluster.length === 1
                              ? first.label
                              : `${first.label} +${cluster.length - 1}`;
                          const color = getMarkerColor(first.type);
                          const clusterTooltip =
                            cluster.length > 1
                              ? cluster.map((m) => `\u2022 ${m.label}`).join("\n")
                              : first.detail
                                ? `\u2022 ${first.label}\n${first.detail}`
                                : undefined;

                          return (
                            <ReferenceLine
                              key={first.id}
                              x={markerTime}
                              stroke={color}
                              strokeDasharray="4 4"
                              label={
                                <Label
                                  value={label}
                                  position="top"
                                  style={{
                                    fontSize: 10,
                                    fill: color,
                                  }}
                                />
                              }
                              {...(clusterTooltip ? {
                                ifOverflow: "extendDomain",
                                // tooltip shown via title-like label for now
                              } : {})}
                            />
                          );
                        })}
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </TabsContent>

            {/* ── Connection Health Tab ── */}
            <TabsContent value="health">
              {healthData.length === 0 ? (
                <div className="h-24 flex items-center justify-center text-sm text-text-muted">
                  No connection health data available.
                </div>
              ) : (
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={healthData}
                      margin={{
                        top: 4,
                        right: 4,
                        left: 0,
                        bottom: 0,
                      }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--color-border)"
                      />
                      <XAxis
                        dataKey="time"
                        tickFormatter={formatTimeAxis}
                        tick={{ fontSize: 11 }}
                        stroke="var(--color-text-muted)"
                      />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        stroke="var(--color-text-muted)"
                        yAxisId="left"
                        label={{
                          value: "ms",
                          angle: -90,
                          position: "insideLeft",
                          style: {
                            fontSize: 11,
                            fill: "var(--color-text-muted)",
                          },
                        }}
                      />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        stroke="var(--color-text-muted)"
                        orientation="right"
                        yAxisId="right"
                        domain={[0, 100]}
                        label={{
                          value: "%",
                          angle: 90,
                          position: "insideRight",
                          style: {
                            fontSize: 11,
                            fill: "var(--color-text-muted)",
                          },
                        }}
                      />
                      <RechartsTooltip
                        content={<HealthTooltip />}
                      />

                      <Area
                        type="monotone"
                        dataKey="rtt"
                        name="RTT"
                        yAxisId="left"
                        stroke="var(--color-accent)"
                        fill="var(--color-accent)"
                        fillOpacity={0.06}
                        isAnimationActive={false}
                        dot={false}
                        strokeWidth={1.5}
                      />
                      <Area
                        type="monotone"
                        dataKey="jitter"
                        name="Jitter"
                        yAxisId="left"
                        stroke="var(--color-warning)"
                        fill="var(--color-warning)"
                        fillOpacity={0.06}
                        isAnimationActive={false}
                        dot={false}
                        strokeWidth={1.5}
                      />
                      <Area
                        type="monotone"
                        dataKey="packetLoss"
                        name="Packet Loss"
                        yAxisId="right"
                        stroke="var(--color-destructive)"
                        fill="var(--color-destructive)"
                        fillOpacity={0.06}
                        isAnimationActive={false}
                        dot={false}
                        strokeWidth={1.5}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Connection status badge */}
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-xs text-text-muted">Status:</span>
                <Badge
                  variant={
                    selectedSeries.state === "playing"
                      ? "success"
                      : selectedSeries.state === "paused"
                        ? "warning"
                        : "destructive"
                  }
                  className="text-xs"
                >
                  {selectedSeries.state === "playing"
                    ? "Connected"
                    : selectedSeries.state === "paused"
                      ? "Paused"
                      : "Reconnecting"}
                </Badge>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </ScrollArea>
    </Fragment>
  );

  if (!contentOnly) {
    return (
      <TooltipProvider>
        <div className="w-[950px] p-3">{content}</div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="w-[950px] p-3">{content}</div>
    </TooltipProvider>
  );
}

// ─── Test exports ──────────────────────────────────────────────────────────
export { computeKindTotals };
export type { KindTotals, SeriesKey, ChartDataPoint };
