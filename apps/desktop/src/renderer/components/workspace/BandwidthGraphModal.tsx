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
  /** When true, show viewer download instead of host upload */
  viewerMode?: boolean;
}

function fmtKBps(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kbps`;
  return `${bps} bps`;
}

export function BandwidthGraphModal({ open, onOpenChange, mediaSessionId, viewerMode }: BandwidthGraphModalProps) {
  const [samples, setSamples] = useState<BandwidthSample[]>([]);
  const [markers, setMarkers] = useState<SettingMarker[]>([]);
  const [duration, setDuration] = useState(0);
  const [hostTotal, setHostTotal] = useState(0);
  const [avgBps, setAvgBps] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;

    const svc = StreamMetricsService.getInstance();
    const refresh = () => {
      if (viewerMode) {
        // Viewer mode: show viewer download stats
        setAvgBps(svc.getViewerBps());
        setHostTotal(svc.getViewerTotalBytes());
      } else if (mediaSessionId) {
        setSamples(svc.getLiveSamples(mediaSessionId));
        setMarkers(svc.getLiveMarkers(mediaSessionId));
        setDuration(svc.getLiveDuration(mediaSessionId));
        setHostTotal(svc.getLiveHostTotal(mediaSessionId));
        setAvgBps(svc.getLiveCurrentBps(mediaSessionId));
      }
    };
    refresh();
    intervalRef.current = setInterval(refresh, 2000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [open, mediaSessionId, viewerMode]);

  const chartData = samples.map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString(),
    hostKbps: s.hostUploadBps / 1000,
  }));

  // In viewer mode, show simple stats instead of graph (no host data)
  if (viewerMode) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Bandwidth</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Current speed</div>
              <div className="font-mono tabular-nums">{fmtKBps(avgBps)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Total received</div>
              <div className="font-mono tabular-nums">{formatBytes(hostTotal)}</div>
            </div>
          </div>
          <p className="text-[11px] text-text-muted mt-2">
            Viewer download stats. Host upload data is available on the host dashboard.
          </p>
        </DialogContent>
      </Dialog>
    );
  }

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
            <div className="font-mono tabular-nums">{fmtKBps(avgBps)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Total uploaded</div>
            <div className="font-mono tabular-nums">{formatBytes(hostTotal)}</div>
          </div>
        </div>

        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 20, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="time" tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" label={{ value: "kbps", angle: -90, position: "insideLeft", style: { fontSize: 11 } }} />
              <Tooltip contentStyle={{ fontSize: 12 }} formatter={(value: number) => [`${value.toFixed(0)} kbps`]} />
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
