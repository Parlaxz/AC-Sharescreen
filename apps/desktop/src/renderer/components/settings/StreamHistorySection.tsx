import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StreamMetricsService, type StreamHistoryRecord } from "@/services/stream-metrics-service";
import { formatBytes, formatDuration } from "@/lib/utils";
import { Monitor, Users, ArrowUp, ArrowDown, Clock, Wifi, AlertCircle, AlertTriangle, RefreshCw } from "lucide-react";

function fmtBytesPerSecond(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} KB/s`;
  return `${bps} B/s`;
}

function Sparkline({ samples, width = 120, height = 28 }: { samples: Array<{ timestamp: number; bytesPerSecond: number; totalBytes: number }>; width?: number; height?: number }) {
  if (samples.length === 0) return <span className="text-[10px] text-text-muted italic">No data</span>;
  const maxBps = Math.max(...samples.map(s => s.bytesPerSecond), 1);
  const barWidth = Math.max(2, Math.floor(width / samples.length));
  return (
    <svg width={width} height={height} className="inline-block align-middle">
      {samples.map((s, i) => {
        const barHeight = Math.max(1, (s.bytesPerSecond / maxBps) * (height - 2));
        return <rect key={i} x={i * barWidth} y={height - 2 - barHeight} width={Math.max(1, barWidth - 1)} height={barHeight} fill="currentColor" opacity={0.6} rx={1} />;
      })}
    </svg>
  );
}

export function StreamHistorySection() {
  const [records, setRecords] = useState<StreamHistoryRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await StreamMetricsService.getInstance().getHistory();
      // Guard: only apply if this generation is still current
      if (generation !== loadGenerationRef.current) return;
      setRecords(result);
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      setLoadError(err instanceof Error ? err.message : "Failed to load stream history");
      // Keep existing records when load fails (don't clear them)
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const svc = StreamMetricsService.getInstance();
    svc.setOnHistoryChanged(load);
    return () => { svc.setOnHistoryChanged(null); };
  }, [load]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Stable ID for aria-controls
  const panelId = (historyId: string) => `stream-history-panel-${historyId}`;

  return (
    <Card className="overflow-hidden border-border-subtle">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-text-muted" />
            <CardTitle className="text-sm font-medium text-text-primary">
              Past Streams
            </CardTitle>
          </div>
          {!loading && (
            <span className="text-[11px] text-text-muted tabular-nums">{records.length} session{records.length !== 1 ? "s" : ""}</span>
          )}
          {loading && <Skeleton className="h-3 w-16 rounded-compact" data-testid="history-count-skeleton" />}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Loading state */}
        {loading && (
          <div className="space-y-3 py-2" data-testid="stream-history-loading" role="status" aria-busy="true">
            <Skeleton className="h-12 w-full rounded-standard" />
            <Skeleton className="h-12 w-full rounded-standard" />
            <Skeleton className="h-12 w-full rounded-standard" />
          </div>
        )}

        {/* Error state with retry — preserves existing records */}
        {loadError && (
          <Alert variant="destructive" className="mb-3">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Failed to load stream history</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
            <Button variant="outline" size="sm" className="mt-2" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Retry
            </Button>
          </Alert>
        )}

        {/* Empty state — only when no records AND not loading AND no error */}
        {!loading && !loadError && records.length === 0 && (
          <p className="text-xs text-text-muted italic">No past streams yet.</p>
        )}

        {/* Records list */}
        {!loading && records.length > 0 && (
          <div className="space-y-1">
            {[...records].reverse().map((r, i) => (
              <div key={r.historyId}>
                {i > 0 && <Separator className="my-1.5" />}
                <button type="button" onClick={() => toggleExpand(r.historyId)}
                  aria-expanded={expanded.has(r.historyId)}
                  aria-controls={panelId(r.historyId)}
                  className="w-full text-left hover:bg-accent/5 rounded-lg px-2.5 py-2 -mx-0.5 transition-colors group">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Role icon */}
                      {r.role === "host" ? (
                        <Monitor className="w-3.5 h-3.5 shrink-0 text-accent" />
                      ) : (
                        <Users className="w-3.5 h-3.5 shrink-0 text-text-secondary" />
                      )}
                      <span id={`${panelId(r.historyId)}-label`} className="text-sm font-medium text-text-primary truncate">
                        {r.role === "host" ? (r.groupName || "Stream") : (r.remoteDisplayName || "Viewing")}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        r.role === "host"
                          ? "bg-accent/10 text-accent"
                          : "bg-text-secondary/10 text-text-secondary"
                      }`}>
                        {r.role === "host" ? "HOST" : "VIEW"}
                      </span>
                      {r.interrupted ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-warning/10 text-warning flex items-center gap-0.5">
                          <AlertCircle className="w-2.5 h-2.5" />
                          Interrupted
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-success/10 text-success">
                          Done
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-text-muted mt-1 ml-5.5">
                    <span className="tabular-nums">{formatDuration(Math.floor(r.durationMs / 1000))}</span>
                    <span className="text-text-muted/40">|</span>
                    <span>{new Date(r.startedAt).toLocaleDateString()} {new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="text-text-muted/40">|</span>
                    {r.role === "host" ? (
                      <span className="flex items-center gap-1">
                        <ArrowUp className="w-3 h-3" />
                        {formatBytes(r.totalBytes)} &middot; {fmtBytesPerSecond(r.averageBytesPerSecond)}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <ArrowDown className="w-3 h-3" />
                        {formatBytes(r.totalBytes)} &middot; {fmtBytesPerSecond(r.averageBytesPerSecond)}
                      </span>
                    )}
                    {r.role === "host" && r.presetName && (
                      <>
                        <span className="text-text-muted/40">|</span>
                        <span>{r.presetName}{r.customQuality ? " (Custom)" : ""}</span>
                      </>
                    )}
                  </div>
                </button>

                {expanded.has(r.historyId) && (
                  <div id={panelId(r.historyId)} role="region" aria-labelledby={`${panelId(r.historyId)}-label`}
                    className="ml-5.5 pl-2.5 mt-1 mb-1.5 space-y-2 border-l-2 border-border-subtle">
                    {/* Bandwidth sparkline — always render so Sparkline's "No data" fallback is reachable */}
                    <div className="flex items-center gap-2 py-1 px-2">
                      <Wifi className="w-3 h-3 text-text-muted shrink-0" />
                      <Sparkline samples={r.samples} width={200} height={28} />
                      {r.samples.length > 0 && (
                        <span className="text-[10px] tabular-nums text-text-muted whitespace-nowrap">
                          {fmtBytesPerSecond(r.averageBytesPerSecond)} avg
                        </span>
                      )}
                    </div>

                    {/* Settings markers */}
                    {r.markers.length > 0 && (
                      <div className="px-2">
                        <div className="font-medium text-text-secondary text-[10px] uppercase tracking-wider mb-1">Changes</div>
                        <div className="space-y-0.5">
                          {r.markers.map((m, j) => (
                            <div key={j} className="flex justify-between text-[11px] text-text-muted py-0.5">
                              <span className="tabular-nums">{new Date(m.timestamp).toLocaleTimeString()}</span>
                              <span className="text-text-secondary">{m.from ? `${m.from} \u2192 ${m.to}` : m.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Session details grid */}
                    <div className="grid grid-cols-3 gap-x-4 gap-y-0.5 text-[10px] px-2 pb-1">
                      <div><span className="text-text-muted">Session:</span> <span className="tabular-nums">{r.mediaSessionId.slice(0, 8)}\u2026</span></div>
                      <div><span className="text-text-muted">Duration:</span> <span className="tabular-nums">{formatDuration(Math.floor(r.durationMs / 1000))}</span></div>
                      <div><span className="text-text-muted">Total:</span> <span className="tabular-nums">{formatBytes(r.totalBytes)}</span></div>
                      <div><span className="text-text-muted">Avg rate:</span> <span className="tabular-nums">{fmtBytesPerSecond(r.averageBytesPerSecond)}</span></div>
                      <div><span className="text-text-muted">Samples:</span> <span className="tabular-nums">{r.samples.length}</span></div>
                      <div><span className="text-text-muted">Status:</span> {r.interrupted ? <span className="text-warning">Interrupted</span> : <span className="text-success">Completed</span>}</div>
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
