import { useCallback, useMemo, useState } from "react";
import { Monitor, StopCircle, Radio, Eye, Clock, AlertTriangle, RefreshCw, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useStore } from "@/stores/main-store";
import { getRuntime } from "@/services/phase3-runtime";
import { stopShare } from "@/services/share-coordinator";
import { navigateToGroupOverview } from "@/services/group-navigation";
import type { CaptureSourceDTO } from "../../../preload/api-types.js";
import { useHostViewerDiagnostics, type ViewerRow } from "@/hooks/use-host-viewer-diagnostics";
import { Separator } from "@/components/ui/separator";

function formatLiveDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 1) {
    return `${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${remainingMinutes}m`;
}

function getConnectionLabel(isSharing: boolean, isDegraded: boolean, localShareState: string): string {
  if (!isSharing || localShareState === "idle" || localShareState === "stopping") {
    return "Disconnected";
  }
  if (localShareState === "starting") {
    return "Connecting";
  }
  if (isDegraded) {
    return "Degraded";
  }
  return "Connected";
}

function getConnectionClass(label: string): string {
  if (label === "Connected") return "bg-success";
  if (label === "Degraded" || label === "Connecting") return "bg-warning";
  return "bg-text-muted";
}

function ViewerRowItem({ row }: { row: ViewerRow }) {
  const statusDot = (() => {
    switch (row.state) {
      case "playing": return "bg-green-500";
      case "paused": return "bg-amber-500";
      case "reconnecting": return "bg-orange-500 animate-pulse";
      default: return "bg-gray-400";
    }
  })();

  const statusLabel = (() => {
    switch (row.state) {
      case "playing": return "Playing";
      case "paused": return "Paused";
      case "reconnecting": return "Reconnecting";
      default: return "No report";
    }
  })();

  const fmtKBps = (kbps: number | null) => kbps !== null ? `${(kbps / 1000).toFixed(1)} Mbps` : null;

  return (
    <div className="py-1.5 space-y-0.5">
      {/* Row 1: name + state */}
      <div className="flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 rounded-full ${statusDot} shrink-0`} />
        <span className="text-text-primary font-medium truncate">{row.displayName}</span>
        <span className="text-text-muted ml-auto shrink-0">{statusLabel}</span>
      </div>

      {row.state === "paused" && (
        <div className="text-[11px] text-text-muted pl-4">
          Control connection active · Media stopped
        </div>
      )}

      {row.state === "reconnecting" && (
        <div className="text-[11px] text-text-muted pl-4">
          Waiting for media statistics
        </div>
      )}

      {row.state === "playing" && (
        <>
          <div className="text-[11px] text-text-secondary pl-4">
            {(row.sent.width || row.sent.height || row.sent.fps) ? (
              <>
                Sent {row.sent.width}×{row.sent.height ?? "?"} {row.sent.fps ?? "?"} FPS
                {(row.received.width || row.received.height || row.received.fps) ? (
                  <> → Received {row.received.width}×{row.received.height ?? "?"} {row.received.fps ?? "?"} FPS</>
                ) : null}
              </>
            ) : (
              <span className="text-text-muted">No host stats</span>
            )}
          </div>

          <div className="text-[11px] text-text-muted pl-4 flex flex-wrap gap-x-3 gap-y-0">
            {row.sent.bitrateKbps !== null && (
              <span>{fmtKBps(row.sent.bitrateKbps)}</span>
            )}
            {row.sent.rttMs !== null && (
              <span>RTT {Math.round(row.sent.rttMs)} ms</span>
            )}
            {row.sent.packetLossPercent !== null && (
              <span>Loss {row.sent.packetLossPercent.toFixed(1)}%</span>
            )}
            {row.sent.codec && (
              <span>{row.sent.codec}</span>
            )}
          </div>

          {row.requested.bitrateKbps !== null && (
            <div className="text-[10px] text-text-muted pl-4">
              Requested: {row.requested.width}×{row.requested.height ?? "?"} · {row.requested.fps} FPS · {row.requested.bitrateKbps} kbps
              {row.requested.presetName ? ` · ${row.requested.presetName}` : null}
            </div>
          )}
        </>
      )}

      {row.state === "unknown" && row.lastStatusAt === null && (
        <div className="text-[11px] text-text-muted pl-4">
          No status received yet
        </div>
      )}

      {row.state === "unknown" && row.lastStatusAt !== null && (
        <div className="text-[11px] text-text-muted pl-4">
          Status stale (last: {Math.round((Date.now() - row.lastStatusAt) / 1000)}s ago)
        </div>
      )}
    </div>
  );
}

interface HostDashboardProps {
  loading?: boolean;
}

export function HostDashboard({ loading = false }: HostDashboardProps) {
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);
  const isSharing = useStore((s) => s.isSharing);
  const isDegraded = useStore((s) => s.isDegraded);
  const sourceName = useStore((s) => s.sourceName);
  const sourceKind = useStore((s) => s.sourceKind);
  const captureWidth = useStore((s) => s.captureWidth);
  const captureHeight = useStore((s) => s.captureHeight);
  const captureFps = useStore((s) => s.captureFps);
  const captureBitrate = useStore((s) => s.captureBitrate);
  const viewerCount = useStore((s) => s.viewerCount);
  const sessionDuration = useStore((s) => s.sessionDuration);
  const localShareState = useStore((s) => s.localShareState);
  const onlineDeviceIdsByGroup = useStore((s) => s.onlineDeviceIdsByGroup);
  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);
  const setSource = useStore((s) => s.setSource);
  const isSwitchingSource = useStore((s) => s.isSwitchingSource);
  const setSwitchingSource = useStore((s) => s.setSwitchingSource);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [switchSourceOpen, setSwitchSourceOpen] = useState(false);
  const [sources, setSources] = useState<CaptureSourceDTO[] | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [selectedSwitchSource, setSelectedSwitchSource] = useState<CaptureSourceDTO | null>(null);
  const [switchSourceError, setSwitchSourceError] = useState<string | null>(null);

  const runtime = getRuntime();
  const sdk = runtime
    ?.getStreamSessionManager()
    ?.getPublisherManager()
    ?.getPublisher()
    ?.getSDK() ?? null;

  const logicalStreamId = runtime?.getStreamSessionManager()?.currentLogicalStreamId ?? "";

  const viewerBindings = useMemo(() => {
    return runtime
      ?.getViewerMediaBinding()
      ?.getAllViewers()
      ?.map((v) => ({ viewerDeviceId: v.viewerDeviceId, mediaPeerUuid: v.mediaPeerUuid }))
      ?? [];
  }, [runtime]);

  const viewerRows = useHostViewerDiagnostics(
    sdk,
    viewerBindings,
    runtime?.getQualityCoordinator() ?? null,
    selectedGroupId ?? "",
    logicalStreamId,
  );

  const group = selectedGroupId ? groupsById[selectedGroupId] : null;
  const connectionLabel = getConnectionLabel(isSharing, isDegraded, localShareState);
  const connectionClass = getConnectionClass(connectionLabel);
  const liveDuration = useMemo(() => formatLiveDuration(sessionDuration), [sessionDuration]);

  const openSourcePicker = useCallback(async () => {
    setSwitchSourceOpen(true);
    setSelectedSwitchSource(null);
    setSwitchSourceError(null);
    setSourcesLoading(true);
    try {
      const api = typeof window !== "undefined"
        ? (window as unknown as { screenlink?: { getSources: () => Promise<CaptureSourceDTO[]> } }).screenlink
        : null;
      if (!api?.getSources) throw new Error("Sources API not available");
      const list = await api.getSources();
      setSources(list);
    } catch (err) {
      setSwitchSourceError(err instanceof Error ? err.message : "Failed to load sources");
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  const handleSwitchSource = useCallback(async () => {
    if (!selectedSwitchSource) return;
    setSwitchSourceError(null);
    setSwitchingSource(true);

    try {
      // Get or acquire the runtime — it can be null after HMR or page transitions
      // that temporarily release the singleton. Try to re-acquire if needed.
      let runtime = getRuntime();
      if (!runtime) {
        const { acquirePhase3Runtime } = await import("../../services/phase3-runtime.js");
        runtime = await acquirePhase3Runtime();
      }
      const ssm = runtime.getStreamSessionManager();
      if (!ssm) throw new Error("No active stream session");

      await ssm.switchSource({
        id: selectedSwitchSource.id,
        name: selectedSwitchSource.name,
        kind: selectedSwitchSource.kind,
      });

      // Update store with new source metadata
      setSource({
        id: selectedSwitchSource.id,
        name: selectedSwitchSource.name,
        kind: selectedSwitchSource.kind,
        displayId: selectedSwitchSource.displayId,
        fingerprint: null,
      });

      setSwitchSourceOpen(false);
    } catch (err) {
      setSwitchSourceError(err instanceof Error ? err.message : "Failed to switch source");
    } finally {
      setSwitchingSource(false);
    }
  }, [selectedSwitchSource, setSource, setSwitchingSource]);

  const handleStopSharing = useCallback(async () => {
    setStopConfirmOpen(false);
    await stopShare();
    navigateToGroupOverview();
  }, []);

  const handlePreview = useCallback(() => {
    const s = useStore.getState();
    const runtime = getRuntime();
    const sessionManager = runtime?.getStreamSessionManager();
    const targetGroupId = sessionManager?.currentGroupId ?? s.selectedGroupId;
    const targetMediaSessionId = sessionManager?.currentMediaSessionId;
    const targetLogicalStreamId = sessionManager?.currentLogicalStreamId;
    const localDeviceId = runtime?.deviceId ?? sessionManager?.hostDeviceId ?? null;
    const streams = targetGroupId ? (s.activeStreamsByGroup[targetGroupId] ?? []) : [];
    const localStream = streams.find((stream) => {
      if (targetMediaSessionId && stream.mediaSessionId === targetMediaSessionId) return true;
      if (targetLogicalStreamId && stream.logicalStreamId === targetLogicalStreamId) return true;
      if (localDeviceId && stream.hostDeviceId === localDeviceId) return true;
      return false;
    }) ?? null;

    if (localStream && targetGroupId) {
      // Set explicit watching target — ViewerWorkspace uses this as its
      // source of truth for what stream to connect to (no heuristics).
      const target = {
        groupId: targetGroupId,
        logicalStreamId: localStream.logicalStreamId,
        mediaSessionId: localStream.mediaSessionId,
        hostDeviceId: localStream.hostDeviceId,
        hostName: localStream.hostDisplayName,
        startedAt: localStream.startedAt,
        sourceName: localStream.sourceName,
        sourceKind: localStream.sourceKind,
      };
      s.setWatchedStreams({
        [localStream.mediaSessionId]: {
          hostDeviceId: localStream.hostDeviceId,
          hostName: localStream.hostDisplayName,
          startedAt: localStream.startedAt,
        },
      });
      s.setWatchingTarget(target);
      s.setSelectedGroupId(targetGroupId);
      s.setIsViewing(true);
      s.setViewStatus("connecting");
    }

    s.navigate("viewer");
  }, []);

  if (loading || !isSharing) {
    return null;
  }

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold text-text-primary">
              {group?.name ?? "Sharing"}
            </h1>
            <Badge variant="success" className="text-[10px] px-2 py-0.5 leading-none">
              <Radio className="h-2.5 w-2.5 mr-1" />
              Live
            </Badge>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {liveDuration}
            </span>
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {viewerCount} {viewerCount === 1 ? "viewer" : "viewers"}
            </span>
          </div>
        </div>

        <Button variant="destructive" size="sm" onClick={() => setStopConfirmOpen(true)}>
          <StopCircle className="h-4 w-4" />
          Stop sharing
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-text-primary">Current share</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-text-secondary">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-text-muted" />
            <span className="text-text-primary">{sourceName || sourceKind || "Unknown source"}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-text-primary">Stream details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">Resolution</span>
              <span className="font-mono tabular-nums text-text-primary">
                {captureWidth > 0 && captureHeight > 0 ? `${captureWidth}×${captureHeight}` : "—"}
              </span>
            </div>
            <div>
              <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">Frame rate</span>
              <span className="font-mono tabular-nums text-text-primary">{captureFps > 0 ? `${captureFps} fps` : "—"}</span>
            </div>
            <div>
              <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">Bitrate</span>
              <span className="font-mono tabular-nums text-text-primary">{captureBitrate > 0 ? `${captureBitrate} kbps` : "—"}</span>
            </div>
            <div>
              <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">Connection</span>
              <span className="text-text-primary">{connectionLabel}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-text-primary">Stream controls</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={openSourcePicker}
            disabled={isSwitchingSource}
          >
            {isSwitchingSource ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Monitor className="h-3.5 w-3.5" />
            )}
            {isSwitchingSource ? "Switching…" : "Switch source"}
          </Button>
          <Button variant="outline" size="sm" onClick={handlePreview}>
            <Eye className="h-3.5 w-3.5" />
            Preview
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOpenShareSetup(true)}>
            <RefreshCw className="h-3.5 w-3.5" />
            Change source
          </Button>
          {isDegraded ? (
            <Badge variant="warning" className="text-[10px] px-1.5 py-0">
              <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
              Degraded
            </Badge>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-3 px-4">
          <div className="flex items-center gap-2.5 text-xs text-text-secondary">
            <span className={`h-2 w-2 rounded-full ${connectionClass}`} />
            <span>{connectionLabel}</span>
            {selectedGroupId && (
              <span className="ml-auto text-text-muted">
                {onlineDeviceIdsByGroup[selectedGroupId]?.length ?? 0} peer{(onlineDeviceIdsByGroup[selectedGroupId]?.length ?? 0) !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-text-primary">
            Viewers ({viewerRows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          {viewerRows.length === 0 ? (
            <p className="text-[11px] text-text-muted py-1">
              No viewers connected yet
            </p>
          ) : (
            viewerRows.map((row, i) => (
              <div key={row.viewerDeviceId}>
                {i > 0 && <Separator className="my-1.5" />}
                <ViewerRowItem row={row} />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={stopConfirmOpen} onOpenChange={setStopConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Stop sharing?</DialogTitle>
            <DialogDescription>
              Viewers will be disconnected. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleStopSharing}>
              <StopCircle className="h-4 w-4" />
              Stop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Switch Source Dialog */}
      <Dialog open={switchSourceOpen} onOpenChange={setSwitchSourceOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Switch source</DialogTitle>
            <DialogDescription>
              Select a new screen or window to share. Viewers stay connected seamlessly.
            </DialogDescription>
          </DialogHeader>

          {switchSourceError && (
            <div className="text-xs text-error bg-error/10 rounded px-3 py-2">
              {switchSourceError}
            </div>
          )}

          {sourcesLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : sources ? (
            <Tabs defaultValue="screen" className="w-full">
              <TabsList className="w-full">
                <TabsTrigger value="screen" className="flex-1">Screens</TabsTrigger>
                <TabsTrigger value="window" className="flex-1">Windows</TabsTrigger>
              </TabsList>
              {(["screen", "window"] as const).map((tabKind) => (
                <TabsContent key={tabKind} value={tabKind}>
                  <ScrollArea className="max-h-72">
                    <div className="space-y-1.5 pr-3">
                      {sources
                        .filter((s) => s.kind === tabKind)
                        .map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setSelectedSwitchSource(s)}
                            className={cn(
                              "w-full flex items-center gap-3 rounded-lg border p-2.5 text-left transition-colors",
                              selectedSwitchSource?.id === s.id
                                ? "border-accent bg-accent/10"
                                : "border-border hover:border-accent/50 hover:bg-accent/5",
                            )}
                          >
                            <img
                              src={s.thumbnailDataUrl}
                              alt={s.name}
                              className="h-12 w-20 rounded object-cover shrink-0 bg-surface"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium text-text-primary truncate">
                                {s.name}
                              </div>
                              <div className="text-xs text-text-muted">
                                {s.kind === "screen" ? "Monitor" : "Application"}
                              </div>
                            </div>
                          </button>
                        ))}
                      {sources.filter((s) => s.kind === tabKind).length === 0 && (
                        <p className="text-xs text-text-muted text-center py-6">
                          No {tabKind === "screen" ? "screens" : "windows"} available
                        </p>
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <p className="text-xs text-text-muted text-center py-6">Unable to load sources</p>
          )}

          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={handleSwitchSource}
              disabled={!selectedSwitchSource || isSwitchingSource}
            >
              {isSwitchingSource ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" />
                  Switching…
                </>
              ) : (
                <>
                  <ArrowRight className="h-3.5 w-3.5 mr-1" />
                  Switch to selected
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
