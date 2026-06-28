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
  type BandwidthSample,
  type SettingMarker,
} from "@/services/stream-metrics-service";
import { formatBytes, formatDuration } from "@/lib/utils";

interface BandwidthGraphModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaSessionId: string | null;
  viewerMode?: boolean;
}

function fmtKBps(bps: number): string {
  if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(1) + " Mbps";
  if (bps >= 1_000) return (bps / 1_000).toFixed(0) + " kbps";
  return bps + " bps";
}

export function BandwidthGraphModal({ open, onOpenChange, mediaSessionId, viewerMode }: BandwidthGraphModalProps) {
  const [samples, setSamples] = useState<BandwidthSample[]>([]);
  const [markers, setMarkers] = useState<SettingMarker[]>([]);
  const [duration, setDuration] = useState(0);
  const [hostTotal, setHostTotal] = useState(0);
  const [avgBpsState, setAvgBpsState] = useState(0);
  const [viewerSamples, setViewerSamples] = useState<Array<{ timestamp: number; bps: number }>>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;

    const svc = StreamMetricsService.getInstance();
    const refresh = () => {
      if (viewerMode) {
        setAvgBpsState(svc.getViewerBps());
        setHostTotal(svc.getViewerTotalBytes());
        setViewerSamples(svc.getViewerSamples());
      } else if (mediaSessionId) {
        setSamples(svc.getLiveSamples(mediaSessionId));
        setMarkers(svc.getLiveMarkers(mediaSessionId));
        setDuration(svc.getLiveDuration(mediaSessionId));
        setHostTotal(svc.getLiveHostTotal(mediaSessionId));
        setAvgBpsState(svc.getLiveCurrentBps(mediaSessionId));
      }
    };
    refresh();
    intervalRef.current = setInterval(refresh, 2000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [open, mediaSessionId, viewerMode]);

  // Viewer mode: show download graph
  if (viewerMode) {
    const chartData = viewerSamples.map(function(s) {
      return { time: new Date(s.timestamp).toLocaleTimeString(), kbps: (s.bps || 0) / 1000 };
    });
    const avgBpsCalc = viewerSamples.length > 0
      ? Math.round(viewerSamples.reduce(function(a, b) { return a + b.bps; }, 0) / viewerSamples.length)
      : 0;

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bandwidth</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Current speed</div>
              <div className="font-mono tabular-nums">{fmtKBps(avgBpsState)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Average</div>
              <div className="font-mono tabular-nums">{fmtKBps(avgBpsCalc)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Total received</div>
              <div className="font-mono tabular-nums">{formatBytes(hostTotal)}</div>
            </div>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" label={{ value: "KB/s", angle: -90, position: "insideLeft", style: { fontSize: 11 } }} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="kbps" name="Download" stroke="#22c55e" fill="#22c55e" fillOpacity={0.1} isAnimationActive={false} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Host mode: show upload graph
  const hostChartData = samples.map(function(s) {
    return { time: new Date(s.timestamp).toLocaleTimeString(), hostKbps: s.hostUploadBps / 1000 };
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bandwidth</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Duration</div>
            <div className="font-mono tabular-nums">{formatDuration(Math.floor(duration / 1000))}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Average bitrate</div>
            <div className="font-mono tabular-nums">{fmtKBps(avgBpsState)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Total uploaded</div>
            <div className="font-mono tabular-nums">{formatBytes(hostTotal)}</div>
          </div>
        </div>

        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={hostChartData} margin={{ top: 20, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="time" tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" label={{ value: "kbps", angle: -90, position: "insideLeft", style: { fontSize: 11 } }} />
              <Tooltip contentStyle={{ fontSize: 12 }} formatter={(value: number) => [value.toFixed(0) + " kbps"]} />
              <Area type="monotone" dataKey="hostKbps" name="Host Upload" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} isAnimationActive={false} dot={false} />
              {markers.map((m, i) => (
                <ReferenceLine key={i} x={new Date(m.timestamp).toLocaleTimeString()} stroke="var(--color-warning)" strokeDasharray="4 4" label={<Label value={m.label} position="top" style={{ fontSize: 10, fill: "var(--color-warning)" }} />} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
