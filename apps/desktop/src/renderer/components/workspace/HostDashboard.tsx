import { useCallback, useMemo, useState } from "react";
import { Monitor, StopCircle, Radio, Eye, Clock, AlertTriangle, RefreshCw } from "lucide-react";
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
import { useStore } from "@/stores/main-store";
import { getRuntime } from "@/services/phase3-runtime";
import { stopShare } from "@/services/share-coordinator";

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
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);

  const group = selectedGroupId ? groupsById[selectedGroupId] : null;
  const connectionLabel = getConnectionLabel(isSharing, isDegraded, localShareState);
  const connectionClass = getConnectionClass(connectionLabel);
  const liveDuration = useMemo(() => formatLiveDuration(sessionDuration), [sessionDuration]);

  const handleStopSharing = useCallback(async () => {
    setStopConfirmOpen(false);
    await stopShare();
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
      s.setWatchedStreams({
        [localStream.mediaSessionId]: {
          hostDeviceId: localStream.hostDeviceId,
          hostName: localStream.hostDisplayName,
          startedAt: localStream.startedAt,
        },
      });
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
          <p>
            The active publisher is using the real capture and publication pipeline. Use the share setup flow to change the source.
          </p>
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
          <Button variant="outline" size="sm" onClick={() => setOpenShareSetup(true)}>
            <RefreshCw className="h-3.5 w-3.5" />
            Change source
          </Button>
          <Button variant="outline" size="sm" onClick={handlePreview}>
            <Eye className="h-3.5 w-3.5" />
            Preview
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
    </div>
  );
}
