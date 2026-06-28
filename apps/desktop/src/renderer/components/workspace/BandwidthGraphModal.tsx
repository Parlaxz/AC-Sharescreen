import { useState, useEffect, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine,
  ResponsiveContainer, CartesianGrid, Label,
} from "recharts";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  StreamMetricsService,
  type StreamHistorySample,
  type StreamSettingMarker,
} from "@/services/stream-metrics-service";
import { formatBytes, formatDuration } from "@/lib/utils";

interface BandwidthGraphModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaSessionId: string | null;
  viewerMode?: boolean;
  viewerHistoryId?: string | null;
}

/** Format bytes per second as KB/s or MB/s */
function fmtByteRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "0 KB/s";
  const kbps = bytesPerSecond / 1024;
  if (kbps >= 1000) return (kbps / 1024).toFixed(1) + " MB/s";
  return kbps.toFixed(0) + " KB/s";
}

/** Convert bytes to KB/s for graphing (Y-axis in KB/s) */
function bytesToKBs(bytesPerSecond: number): number {
  return bytesPerSecond / 1024;
}

export function BandwidthGraphModal({ open, onOpenChange, mediaSessionId, viewerMode, viewerHistoryId }: BandwidthGraphModalProps) {
  const [samples, setSamples] = useState<StreamHistorySample[]>([]);
  const [markers, setMarkers] = useState<StreamSettingMarker[]>([]);
  const [duration, setDuration] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [currentBps, setCurrentBps] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;

    const svc = StreamMetricsService.getInstance();
    const refresh = () => {
      if (viewerMode && viewerHistoryId) {
        setSamples(svc.getLiveSamples(viewerHistoryId));
        setMarkers(svc.getLiveMarkers(viewerHistoryId));
        setDuration(svc.getLiveDuration(viewerHistoryId));
        setTotalBytes(svc.getLiveTotalBytes(viewerHistoryId));
        setCurrentBps(svc.getLiveCurrentBytesPerSecond(viewerHistoryId));
      } else if (viewerMode) {
        // Fall back to deprecated viewer tracker when no historyId
        setCurrentBps(svc.getViewerBps());
        setTotalBytes(svc.getViewerTotalBytes());
        const oldSamples = svc.getViewerSamples();
        setSamples(oldSamples.map((s) => ({
          timestamp: s.timestamp,
          bytesPerSecond: s.bps,
          totalBytes: 0,
        })));
        setMarkers([]);
        setDuration(0);
      } else if (mediaSessionId) {
        setSamples(svc.getLiveSamples(mediaSessionId));
        setMarkers(svc.getLiveMarkers(mediaSessionId));
        setDuration(svc.getLiveDuration(mediaSessionId));
        setTotalBytes(svc.getLiveHostTotal(mediaSessionId));
        setCurrentBps(svc.getLiveCurrentBps(mediaSessionId));
      }
    };
    refresh();
    intervalRef.current = setInterval(refresh, 500);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [open, mediaSessionId, viewerMode, viewerHistoryId]);

  // Empty state: no samples yet
  const hasSamples = samples.length > 0;
  const avgBps = hasSamples
    ? Math.round(samples.reduce((a, b) => a + b.bytesPerSecond, 0) / samples.length)
    : 0;

  // Viewer mode / Host mode share the same overall structure
  const isViewer = !!viewerMode;
  const chartLabel = isViewer ? "Download" : "Host Upload";
  const chartColor = isViewer ? "#22c55e" : "#3b82f6";

  // Build chart data from samples
  const chartData = samples.map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString(),
    rateKBs: bytesToKBs(s.bytesPerSecond || 0),
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bandwidth</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">
              {isViewer ? "Current speed" : "Duration"}
            </div>
            <div className="font-mono tabular-nums">
              {isViewer ? fmtByteRate(currentBps) : formatDuration(Math.floor(duration / 1000))}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">
              {isViewer ? "Average" : "Average bitrate"}
            </div>
            <div className="font-mono tabular-nums">{fmtByteRate(avgBps)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">
              {isViewer ? "Total received" : "Total uploaded"}
            </div>
            <div className="font-mono tabular-nums">{formatBytes(totalBytes)}</div>
          </div>
        </div>

        {!hasSamples ? (
          <div className="h-48 flex items-center justify-center text-sm text-text-muted">
            Waiting for bandwidth samples...
          </div>
        ) : (
          <div className={isViewer ? "h-48" : "h-64"}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: isViewer ? 5 : 20, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="var(--color-text-muted)"
                  label={{ value: "KB/s", angle: -90, position: "insideLeft", style: { fontSize: 11 } }}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  formatter={(value: number) => [value.toFixed(1) + " KB/s"]}
                />
                <Area
                  type="monotone"
                  dataKey="rateKBs"
                  name={chartLabel}
                  stroke={chartColor}
                  fill={chartColor}
                  fillOpacity={0.1}
                  isAnimationActive={false}
                  dot={false}
                />
                {markers.map((m, i) => (
                  <ReferenceLine
                    key={i}
                    x={new Date(m.timestamp).toLocaleTimeString()}
                    stroke="var(--color-warning)"
                    strokeDasharray="4 4"
                    label={<Label value={m.label} position="top" style={{ fontSize: 10, fill: "var(--color-warning)" }} />}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
