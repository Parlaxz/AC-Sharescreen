import { Fragment, useSyncExternalStore, useMemo, useState, useCallback } from "react";
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

// ─── Constants ──────────────────────────────────────────────────────────────

const TIME_RANGES = [
  { label: "60s", value: 60_000 },
  { label: "5 min", value: 300_000 },
  { label: "30 min", value: 1_800_000 },
  { label: "Session", value: Infinity },
] as const;

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

function compute30sAverage(snapshot: BandwidthSnapshot): number {
  const buckets = snapshot.aggregate.mediumBuckets;
  if (buckets.length === 0) return 0;

  // Last 6 medium buckets ≈ 30 seconds (5s each)
  const last = buckets.slice(-6);
  const sum = last.reduce(
    (a, b) => a + b.weightedAverageBitsPerSecond,
    0,
  );
  return Math.round(sum / last.length);
}

// ─── Chart data preparation ─────────────────────────────────────────────────

function getChartData(
  snapshot: BandwidthSnapshot,
  rangeMs: number,
  showRaw: boolean,
): ChartDataPoint[] {
  const { rawSamples, mediumBuckets, longBuckets } = snapshot.aggregate;

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
    const baseTime = rawSamples[0].timestampMs;
    const data: ChartDataPoint[] = [];

    for (let i = 0; i < rawSamples.length; i++) {
      const s = rawSamples[i];
      if (s.timestampMs < cutoff) continue;
      data.push({
        time: s.timestampMs,
        smoothed: s.mediaBitsPerSecond,
        raw: showRaw ? s.mediaBitsPerSecond : undefined,
        target: s.configuredVideoBitsPerSecond ?? undefined,
        video: null,
        audio: null,
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

  const baseTime = subset[0].startTimestampMs;
  return subset.map((b) => ({
    time: b.startTimestampMs,
    smoothed: b.weightedAverageBitsPerSecond,
  }));
}

function getConnectionHealthData(
  snapshot: BandwidthSnapshot,
): HealthDataPoint[] {
  const { rawSamples } = snapshot.aggregate;
  if (rawSamples.length === 0) return [];

  return rawSamples.map((s) => ({
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
            <span className="text-text-secondary">Smoothed</span>
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
      <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5 truncate">
        {label}
      </div>
      {children ?? (
        <div className="font-mono tabular-nums text-sm truncate">
          {value ?? "\u2014"}
        </div>
      )}
    </div>
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

  // Compute summary values
  const avg30s = useMemo(() => compute30sAverage(snapshot), [snapshot]);
  const hourlyEstimate = useMemo(
    () =>
      estimateHourlyBytes(snapshot.aggregate.totalBytes, snapshot.aggregate.activeDurationMs),
    [snapshot.aggregate.totalBytes, snapshot.aggregate.activeDurationMs],
  );

  // Chart data
  const chartData = useMemo(
    () => getChartData(snapshot, timeRange, showRaw),
    [snapshot, timeRange, showRaw],
  );

  const healthData = useMemo(
    () => getConnectionHealthData(snapshot),
    [snapshot],
  );

  // Markers
  const markerClusters = useMemo(
    () => clusterMarkers(snapshot.aggregate.markers),
    [snapshot.aggregate.markers],
  );

  // Only show markers when raw samples are available (correct wall-clock alignment)
  const visibleMarkers = useMemo(() => {
    if (snapshot.aggregate.rawSamples.length === 0) return [];
    const now = Date.now();
    const cutoff = timeRange === Infinity ? 0 : now - timeRange;
    return markerClusters.filter((cluster) =>
      cluster.some((m) => m.timestampMs >= cutoff),
    );
  }, [markerClusters, timeRange, snapshot.aggregate.rawSamples.length]);

  // Base wall-clock time for marker X-axis placement
  const baseTime = useMemo(() => {
    if (snapshot.aggregate.rawSamples.length > 0)
      return snapshot.aggregate.rawSamples[0].timestampMs;
    return Date.now();
  }, [snapshot.aggregate.rawSamples]);

  // Viewer selector items (host mode)
  const viewerOptions = useMemo(() => {
    if (role !== "host" || snapshot.connections.length === 0) return [];
    return [
      { value: "__all__", label: "All Viewers" },
      ...snapshot.connections.map((v) => ({
        value: v.viewerDeviceId ?? v.connectionId,
        label: v.displayName ?? v.connectionId,
      })),
    ];
  }, [role, snapshot.connections]);

  // Determine if we have any data
  const hasData =
    snapshot.aggregate.rawSamples.length > 0 ||
    snapshot.aggregate.mediumBuckets.length > 0 ||
    snapshot.aggregate.longBuckets.length > 0;

  const content = (
    <Fragment>
      <div className="text-lg font-semibold mb-4 text-text-primary">
        Bandwidth
      </div>

      <ScrollArea className="max-h-[calc(85vh-8rem)] pr-2">
        {/* ── Summary Row ── */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-4 text-sm">
          <SummaryItem
            label="Current"
            value={fmtBitRate(snapshot.aggregate.currentBitsPerSecond)}
          />
          <SummaryItem label="30s Avg" value={fmtBitRate(avg30s)} />
          <SummaryItem
            label="Peak"
            value={fmtBitRate(snapshot.aggregate.peakBitsPerSecond)}
          />
          <SummaryItem
            label="Total"
            value={fmtCumulativeBytes(snapshot.aggregate.totalBytes)}
          />
          <SummaryItem
            label="Est/hr"
            value={
              hourlyEstimate > 0
                ? fmtHourlyUsage(hourlyEstimate)
                : "\u2014"
            }
          />
          <SummaryItem label="Duration">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono tabular-nums">
                {fmtDuration(snapshot.aggregate.durationMs)}
              </span>
              {snapshot.aggregate.state === "paused" && (
                <Badge variant="warning" className="text-[10px] px-1.5 py-0">
                  paused
                </Badge>
              )}
              {snapshot.aggregate.state === "reconnecting" && (
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

        {/* ── Time Range Selector ── */}
        <div className="flex items-center justify-between mb-2">
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
            snapshot.aggregate.rawSamples.length > 0 &&
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
          <div className="mb-3">
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
          <div className="h-64 flex items-center justify-center text-sm text-text-muted">
            No bandwidth data available yet.
          </div>
        ) : (
          <Tabs defaultValue="throughput">
            <TabsList className="mb-2">
              <TabsTrigger value="throughput">Throughput</TabsTrigger>
              <TabsTrigger value="health">
                Connection Health
              </TabsTrigger>
            </TabsList>

            {/* ── Throughput Tab ── */}
            <TabsContent value="throughput">
              {chartData.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-sm text-text-muted">
                  No bandwidth data available yet.
                </div>
              ) : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={chartData}
                      margin={{
                        top: 16,
                        right: 16,
                        left: 8,
                        bottom: 8,
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

                      {/* Smoothed (EWMA) line */}
                      <Area
                        type="monotone"
                        dataKey="smoothed"
                        name="Smoothed"
                        stroke="var(--color-accent)"
                        fill="var(--color-accent)"
                        fillOpacity={0.08}
                        isAnimationActive={false}
                        dot={false}
                        strokeWidth={2}
                      />

                      {/* Raw samples area (optional toggle) */}
                      {showRaw && (
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

                      {/* Target reference line */}
                      {snapshot.aggregate.configuredBitsPerSecond != null &&
                        snapshot.aggregate.configuredBitsPerSecond > 0 && (
                          <ReferenceLine
                            y={snapshot.aggregate.configuredBitsPerSecond}
                            stroke="var(--color-warning)"
                            strokeDasharray="6 3"
                            label={
                              <Label
                                value={`Target: ${fmtBitRate(snapshot.aggregate.configuredBitsPerSecond)}`}
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
                        const markerTime =
                          (first.timestampMs - baseTime) / 1000;
                        const label =
                          cluster.length === 1
                            ? first.label
                            : `${first.label} +${cluster.length - 1}`;
                        const color = getMarkerColor(first.type);

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
                          />
                        );
                      })}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </TabsContent>

            {/* ── Connection Health Tab ── */}
            <TabsContent value="health">
              {healthData.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-sm text-text-muted">
                  No connection health data available.
                </div>
              ) : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={healthData}
                      margin={{
                        top: 16,
                        right: 16,
                        left: 8,
                        bottom: 8,
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
              <div className="flex items-center gap-2 mt-3">
                <span className="text-xs text-text-muted">Status:</span>
                <Badge
                  variant={
                    snapshot.aggregate.state === "playing"
                      ? "success"
                      : snapshot.aggregate.state === "paused"
                        ? "warning"
                        : "destructive"
                  }
                  className="text-xs"
                >
                  {snapshot.aggregate.state === "playing"
                    ? "Connected"
                    : snapshot.aggregate.state === "paused"
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

  if (contentOnly) {
    return (
      <TooltipProvider>
        <div className="w-[950px] p-4">{content}</div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverContent side="top" align="center" className="w-[950px] p-4">
          {content}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
