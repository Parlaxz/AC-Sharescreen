import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StreamMetricsService, type StreamHistoryRecord, type StreamHistorySample, type StreamSettingMarker } from "@/services/stream-metrics-service";
import { formatBytes, formatDuration } from "@/lib/utils";

function fmtBytesPerSecond(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} KB/s`;
  return `${bps} B/s`;
}

/** Simple inline sparkline rendered as a series of vertical bars */
function Sparkline({ samples, width = 120, height = 28 }: { samples: StreamHistorySample[]; width?: number; height?: number }) {
  if (samples.length === 0) return <span className="text-[10px] text-text-muted italic">No samples</span>;
  const maxBps = Math.max(...samples.map(s => s.bytesPerSecond), 1);
  const barWidth = Math.max(2, Math.floor(width / samples.length));
  return (
    <svg width={width} height={height} className="inline-block align-middle">
      {samples.map((s, i) => {
        const barHeight = Math.max(1, (s.bytesPerSecond / maxBps) * (height - 2));
        return <rect key={i} x={i * barWidth} y={height - 2 - barHeight} width={Math.max(1, barWidth - 1)} height={barHeight} fill="currentColor" opacity={0.6} />;
      })}
    </svg>
  );
}

export function StreamHistorySection() {
  const [records, setRecords] = useState<StreamHistoryRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    StreamMetricsService.getInstance().getHistory().then(setRecords).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const svc = StreamMetricsService.getInstance();
    svc.setOnHistoryChanged(load);
    return () => svc.setOnHistoryChanged(null);
  }, [load]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-text-primary">
          Past streams ({records.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="text-xs text-text-muted">No past streams yet.</p>
        ) : (
          <div className="space-y-0">
            {[...records].reverse().map((r, i) => (
              <div key={r.historyId}>
                {i > 0 && <Separator className="my-2" />}
                <button type="button" onClick={() => toggleExpand(r.historyId)}
                  className="w-full text-left hover:bg-accent/5 rounded px-1 py-1 -mx-1 transition-colors">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-text-primary truncate">
                      {r.role === "host" ? (r.groupName || "Stream") : (r.remoteDisplayName || "Viewing")}
                    </span>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${r.role === "host" ? "bg-accent/10 text-accent" : "bg-blue-500/10 text-blue-400"}`}>
                        {r.role === "host" ? "Hosted" : "Viewed"}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${r.interrupted ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}>
                        {r.interrupted ? "Interrupted" : "Completed"}
                      </span>
                      <span className="text-text-muted">{formatDuration(Math.floor(r.durationMs / 1000))}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-text-muted mt-0.5">
                    <span>{new Date(r.startedAt).toLocaleString()}</span>
                    {r.role === "host" ? (
                      <>
                        <span>{formatBytes(r.totalBytes)} uploaded</span>
                        <span>{fmtBytesPerSecond(r.averageBytesPerSecond)} avg</span>
                      </>
                    ) : (
                      <>
                        <span>{formatBytes(r.totalBytes)} downloaded</span>
                        <span>{fmtBytesPerSecond(r.averageBytesPerSecond)} avg</span>
                      </>
                    )}
                    {r.role === "host" && r.presetName && <span>{r.presetName}</span>}
                    {r.role === "host" && r.customQuality && <span>Custom</span>}
                  </div>
                </button>

                {expanded.has(r.historyId) && (
                  <div className="pl-3 mt-1.5 space-y-1 text-[11px] text-text-muted">
                    {/* Bandwidth sparkline */}
                    {r.samples.length > 0 && (
                      <div className="flex items-center gap-2 py-1">
                        <span className="text-[10px] text-text-muted">Bandwidth:</span>
                        <Sparkline samples={r.samples} width={160} height={24} />
                        <span className="text-[10px] tabular-nums text-text-muted">
                          {fmtBytesPerSecond(r.averageBytesPerSecond)} avg
                        </span>
                      </div>
                    )}

                    {/* Settings markers (quality changes) */}
                    {r.markers.length > 0 && (
                      <>
                        <div className="font-medium text-text-secondary text-[11px] pt-1">Settings changes</div>
                        {r.markers.map((m, j) => (
                          <div key={j} className="flex justify-between">
                            <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                            <span>{m.label}</span>
                          </div>
                        ))}
                      </>
                    )}

                    {/* Session details */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] pt-1">
                      <div><span className="text-text-muted">Session ID:</span> {r.mediaSessionId.slice(0, 8)}…</div>
                      <div><span className="text-text-muted">History ID:</span> {r.historyId.slice(0, 8)}…</div>
                      {r.groupId && <div><span className="text-text-muted">Group:</span> {r.groupName || r.groupId.slice(0, 8)}</div>}
                      {r.role === "viewer" && r.remoteDisplayName && <div><span className="text-text-muted">Host:</span> {r.remoteDisplayName}</div>}
                      <div><span className="text-text-muted">Started:</span> {new Date(r.startedAt).toLocaleString()}</div>
                      <div><span className="text-text-muted">Duration:</span> {formatDuration(Math.floor(r.durationMs / 1000))}</div>
                      <div><span className="text-text-muted">Total:</span> {formatBytes(r.totalBytes)}</div>
                      <div><span className="text-text-muted">Avg rate:</span> {fmtBytesPerSecond(r.averageBytesPerSecond)}</div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
