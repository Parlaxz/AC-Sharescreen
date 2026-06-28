import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StreamMetricsService, type StreamHistoryRecord } from "@/services/stream-metrics-service";
import { formatBytes, formatDuration } from "@/lib/utils";

function fmtBps(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kbps`;
  return `${bps} bps`;
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
              <div key={r.mediaSessionId}>
                {i > 0 && <Separator className="my-2" />}
                <button type="button" onClick={() => toggleExpand(r.mediaSessionId)}
                  className="w-full text-left hover:bg-accent/5 rounded px-1 py-1 -mx-1 transition-colors">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-text-primary truncate">{r.groupName || "Stream"}</span>
                    <span className="text-text-muted shrink-0 ml-2">{formatDuration(Math.floor(r.durationMs / 1000))}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-text-muted mt-0.5">
                    <span>{new Date(r.startedAt).toLocaleString()}</span>
                    <span>{formatBytes(r.hostUploadBytes)} uploaded</span>
                    <span>{fmtBps(r.avgHostUploadBps)} avg</span>
                    {r.presetName && <span>{r.presetName}</span>}
                    {r.customQuality && <span>Custom</span>}
                  </div>
                </button>

                {expanded.has(r.mediaSessionId) && (
                  <div className="pl-3 mt-1.5 space-y-1 text-[11px] text-text-muted">
                    <div className="font-medium text-text-secondary text-[11px]">Viewers ({r.viewerCount})</div>
                    {Object.keys(r.viewerDownloads).length > 0 ? (
                      Object.entries(r.viewerDownloads).map(([id, v]) => (
                        <div key={id} className="flex justify-between">
                          <span>{v.displayName || id.slice(0, 8)}</span>
                          <span className="tabular-nums">{formatBytes(v.totalBytes)} downloaded</span>
                        </div>
                      ))
                    ) : (
                      <div className="italic">No viewer stats recorded</div>
                    )}

                    {r.markers.length > 0 && (
                      <>
                        <div className="font-medium text-text-secondary text-[11px] pt-1">Quality changes</div>
                        {r.markers.map((m, j) => (
                          <div key={j} className="flex justify-between">
                            <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                            <span>{m.label}</span>
                          </div>
                        ))}
                      </>
                    )}
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
