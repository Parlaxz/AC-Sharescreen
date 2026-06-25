import { useCallback, useEffect, useRef, useState } from "react";
import {
  Monitor,
  StopCircle,
  Radio,
  Eye,
  Volume2,
  Settings2,
  RefreshCw,
  Check,
  X,
  Clock,
  ArrowUpFromLine,
  ArrowDownToLine,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  useStore,
} from "@/stores/main-store";
import { AnimatedNumber } from "@/components/primitives/AnimatedNumber";
import { AnimatedCountBadge } from "@/components/primitives/AnimatedCountBadge";
import { notifyRemoteRequest, type RemoteRequest } from "./RemoteRequestToast.js";

// ─── Motion reduced detection ──────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

// ─── Spring transitions ────────────────────────────────────────────────────

const springStiff = {
  type: "spring" as const,
  stiffness: 350,
  damping: 28,
};

const cardEntrance = {
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12 },
  transition: { type: "spring", stiffness: 300, damping: 26 },
};

const fadeTransition = { duration: 0.15 };

// ─── Duration hook (live counter) ──────────────────────────────────────────

function useLiveDuration(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

// ─── Connection status ─────────────────────────────────────────────────────

type ConnectionQuality = "good" | "degraded" | "poor" | "disconnected";

function useConnectionQuality(): ConnectionQuality {
  const isDegraded = useStore((s) => s.isDegraded);
  const isSharing = useStore((s) => s.isSharing);
  const localShareState = useStore((s) => s.localShareState);

  if (!isSharing || localShareState === "idle" || localShareState === "stopping") {
    return "disconnected";
  }
  if (localShareState === "error") return "poor";
  if (isDegraded) return "degraded";
  return "good";
}

const connectionDotColors: Record<ConnectionQuality, string> = {
  good: "bg-success",
  degraded: "bg-warning",
  poor: "bg-danger",
  disconnected: "bg-text-muted",
};

const connectionLabels: Record<ConnectionQuality, string> = {
  good: "Connected",
  degraded: "Degraded",
  poor: "Connection issue",
  disconnected: "Disconnected",
};

// ─── Stat helpers ──────────────────────────────────────────────────────────

function formatResolution(width: number, height: number): string {
  if (!width || !height) return "—";
  return `${width}×${height}`;
}

function formatCodec(mimeType: string): string {
  if (!mimeType) return "—";
  // Strip "video/" or "audio/" prefix
  return mimeType.replace(/^(video|audio)\//, "").toUpperCase();
}

function formatFps(fps: number): string {
  if (!fps) return "—";
  return `${fps.toFixed(1)} fps`;
}

function formatMs(ms: number): string {
  if (!ms) return "—";
  return `${ms.toFixed(0)} ms`;
}

function formatPercent(pct: number): string {
  if (pct === undefined || pct === null) return "—";
  return `${pct.toFixed(2)}%`;
}

// ─── Time ago helper ───────────────────────────────────────────────────────

function timeAgo(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86400_000) return `${Math.floor(elapsed / 3600_000)}h ago`;
  return `${Math.floor(elapsed / 86400_000)}d ago`;
}

// ─── Props ─────────────────────────────────────────────────────────────────

interface HostDashboardProps {
  /** Show loading skeleton instead of content */
  loading?: boolean;
}

// ─── HostDashboard ─────────────────────────────────────────────────────────

/**
 * HostDashboard — Primary workspace content when the local user is sharing
 * (Stage 3.7E). Rendered in place of GroupOverview when `useStore.isSharing === true`.
 *
 * Sections (Section 8.4):
 *   1. Live state header — group name, "Live" Badge, animated duration, viewer count
 *   2. Stop sharing button — always-visible destructive button in header
 *   3. Stop-sharing confirmation — Watermelon Dialog
 *   4. Local preview — Card with video placeholder + overlay badge + skeleton
 *   5. Stream statistics — Card grid with resolution, fps, bitrate, codec, etc.
 *   6. Source/Audio/Quality controls — row of control buttons
 *   7. Remote quality request state — inline pending request rows
 *   8. Connection status — colored status dot + text
 *
 * Composed entirely from Watermelon primitives + framer-motion AnimatePresence.
 * Honors prefers-reduced-motion.
 */
export function HostDashboard({
  loading = false,
}: HostDashboardProps) {
  const reduced = usePrefersReducedMotion();

  // ── Store bindings ───────────────────────────────────────────────────
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
  const viewers = useStore((s) => s.viewers);
  const sessionDuration = useStore((s) => s.sessionDuration);
  const totalBytesSent = useStore((s) => s.totalBytesSent);
  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);
  const setIsSharing = useStore((s) => s.setIsSharing);
  const setLocalShareState = useStore((s) => s.setLocalShareState);
  const localShareState = useStore((s) => s.localShareState);

  const group = selectedGroupId ? groupsById[selectedGroupId] : null;
  const liveSeconds = useLiveDuration(isSharing ? Date.now() - (sessionDuration > 0 ? Date.now() - sessionDuration * 1000 : 0) : null);
  // Use the store sessionDuration as the baseline; liveSeconds for real-time display
  const effectiveDuration = sessionDuration > 0 ? sessionDuration + (Date.now() - (Date.now() - sessionDuration * 1000)) / 1000 : liveSeconds;

  // ── Local state ──────────────────────────────────────────────────────
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<RemoteRequest[]>([]);
  const [streamStats, setStreamStats] = useState<{
    codec: string;
    latency: number;
    packetLoss: number;
    dataPerHour: number;
  } | null>(null);

  // ── Simulate preview load ────────────────────────────────────────────
  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => setPreviewReady(true), 1500);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  // ── Simulate stats update ────────────────────────────────────────────
  useEffect(() => {
    if (loading || !isSharing) return;
    const interval = setInterval(() => {
      setStreamStats({
        codec: "video/VP9",
        latency: 12 + Math.random() * 8,
        packetLoss: Math.random() * 0.5,
        dataPerHour: 150 + Math.random() * 100,
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [loading, isSharing]);

  // ── Simulate incoming remote requests ────────────────────────────────
  const requestIdCounter = useRef(0);
  const simulateRemoteRequest = useCallback(() => {
    const names = ["Alice", "Bob", "Charlie", "Diana", "Eve"];
    const kinds: Array<RemoteRequest["requestKind"]> = [
      "higher-quality",
      "lower-quality",
      "specific-preset",
    ];
    const request: RemoteRequest = {
      id: `req-${++requestIdCounter.current}`,
      viewerName: names[Math.floor(Math.random() * names.length)],
      requestKind: kinds[Math.floor(Math.random() * kinds.length)],
      receivedAt: Date.now(),
      status: "pending",
    };
    setPendingRequests((prev) => [...prev, request]);
    notifyRemoteRequest(
      request.viewerName,
      request.requestKind,
      () => handleAcceptRequest(request.id),
      () => handleRejectRequest(request.id),
    );
  }, []);

  // Remove after initial simulation for production — this is demo wiring
  useEffect(() => {
    if (!isSharing || loading) return;
    const timer = setTimeout(simulateRemoteRequest, 5000);
    return () => clearTimeout(timer);
  }, [isSharing, loading, simulateRemoteRequest]);

  // ── Request handlers ─────────────────────────────────────────────────
  const handleAcceptRequest = useCallback((requestId: string) => {
    setPendingRequests((prev) =>
      prev.map((r) =>
        r.id === requestId ? { ...r, status: "accepted" as const } : r,
      ),
    );
    toast.success("Quality request accepted");
    // Auto-remove after animation
    setTimeout(() => {
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
    }, 2000);
  }, []);

  const handleRejectRequest = useCallback((requestId: string) => {
    setPendingRequests((prev) =>
      prev.map((r) =>
        r.id === requestId ? { ...r, status: "rejected" as const } : r,
      ),
    );
    toast.error("Quality request rejected");
    setTimeout(() => {
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
    }, 2000);
  }, []);

  // ── Stop sharing handler ─────────────────────────────────────────────
  const handleStopSharing = useCallback(() => {
    // Call the existing stop service — currently store-based
    // TODO: Full integration with StreamSessionManager.stopStream()
    setIsSharing(false);
    setLocalShareState("idle");
    setStopConfirmOpen(false);
    toast.success("Sharing stopped");
  }, [setIsSharing, setLocalShareState]);

  // ── Control button handlers ──────────────────────────────────────────
  const handleChangeSource = useCallback(() => {
    setOpenShareSetup(true);
  }, [setOpenShareSetup]);

  const handleChangeAudio = useCallback(() => {
    toast("Audio settings coming soon");
  }, []);

  const handleChangeQuality = useCallback(() => {
    toast("Quality settings coming soon");
  }, []);

  // ── Connection quality ───────────────────────────────────────────────
  const connectionQuality = useConnectionQuality();

  // ── Transition props ─────────────────────────────────────────────────
  const entranceProps = reduced
    ? {
        initial: false,
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: fadeTransition,
      }
    : cardEntrance;

  const transitionProps = reduced
    ? { initial: false, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } };

  // ── Loading state ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-6 max-w-3xl" role="status" aria-label="Loading host dashboard">
        <div className="space-y-4">
          <Skeleton className="h-8 w-60" />
          <Skeleton className="h-40 w-full rounded-standard" />
          <Skeleton className="h-32 w-full rounded-standard" />
          <Skeleton className="h-24 w-full rounded-standard" />
        </div>
      </div>
    );
  }

  // ── Not sharing fallback ─────────────────────────────────────────────
  if (!isSharing) {
    return null;
  }

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-3xl">
      <AnimatePresence mode="popLayout">
        {/* ─── Section 1: Live state header ──────────────────────────── */}
        <motion.div
          key="header"
          {...entranceProps}
          layout={reduced ? false : true}
          className="flex items-start justify-between mb-6"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-semibold text-text-primary truncate">
                  {group?.name ?? "Sharing"}
                </h1>
                <Badge
                  variant="success"
                  className="text-[10px] px-2 py-0.5 leading-none flex-shrink-0"
                >
                  <Radio className="h-2.5 w-2.5 mr-1" />
                  Live
                </Badge>
              </div>
              <div className="flex items-center gap-3 mt-1">
                {/* Animated live duration (Section 3.7E — key-change animation) */}
                <motion.span
                  key={Math.floor(effectiveDuration / 60)}
                  initial={reduced ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.12 }}
                  className="text-xs text-text-muted font-mono tabular-nums flex items-center gap-1"
                >
                  <Clock className="h-3 w-3" />
                  <AnimatedNumber
                    value={effectiveDuration}
                    format="duration"
                    className="text-xs"
                  />
                </motion.span>

                {/* Viewer count */}
                <span className="text-xs text-text-muted flex items-center gap-1">
                  <Eye className="h-3 w-3" />
                  <AnimatedCountBadge
                    count={viewerCount}
                    variant="default"
                    className="text-[10px] px-1.5 py-0 font-mono tabular-nums"
                  >
                    {viewerCount} {viewerCount === 1 ? "viewer" : "viewers"}
                  </AnimatedCountBadge>
                </span>
              </div>
            </div>
          </div>

          {/* Stop sharing button — always visible top-right */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setStopConfirmOpen(true)}
                aria-label="Stop sharing"
                className="flex-shrink-0"
              >
                <StopCircle className="h-4 w-4" />
                Stop sharing
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              End this stream and disconnect viewers
            </TooltipContent>
          </Tooltip>
        </motion.div>

        {/* ─── Section 4: Local preview ──────────────────────────────── */}
        <motion.div
          key="preview"
          {...entranceProps}
          layout={reduced ? false : true}
          className="mb-4"
        >
          <Card className="overflow-hidden">
            <div className="relative">
              {!previewReady ? (
                <Skeleton className="aspect-video w-full rounded-none" />
              ) : (
                <div className="aspect-video w-full bg-surface-3 flex items-center justify-center">
                  <video
                    className="w-full h-full object-contain"
                    autoPlay
                    muted
                    playsInline
                    aria-label="Local stream preview"
                  />
                </div>
              )}

              {/* Overlay badge — "Preview" label */}
              <div className="absolute top-2 left-2">
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 bg-black/60 text-white border-none"
                >
                  Preview
                </Badge>
              </div>

              {/* Source name overlay */}
              <div className="absolute bottom-2 left-2">
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 bg-black/60 text-white border-none flex items-center gap-1"
                >
                  <Monitor className="h-2.5 w-2.5" />
                  {sourceName || sourceKind || "Unknown source"}
                </Badge>
              </div>
            </div>
          </Card>
        </motion.div>

        {/* ─── Section 5: Stream statistics ──────────────────────────── */}
        <motion.div
          key="stats"
          {...entranceProps}
          layout={reduced ? false : true}
          className="mb-4"
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-text-primary">
                Stream statistics
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Stats grid: 3 columns on wide, 1 on narrow */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* Resolution */}
                <div>
                  <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                    Resolution
                  </span>
                  {captureWidth > 0 ? (
                    <span className="font-mono tabular-nums text-sm text-text-primary">
                      {formatResolution(captureWidth, captureHeight)}
                    </span>
                  ) : (
                    <Skeleton className="h-4 w-20" />
                  )}
                </div>

                {/* Frame rate */}
                <div>
                  <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                    Frame rate
                  </span>
                  {captureFps > 0 ? (
                    <span className="font-mono tabular-nums text-sm text-text-primary">
                      <AnimatedNumber
                        value={captureFps}
                        decimals={1}
                      />
                      {" fps"}
                    </span>
                  ) : (
                    <Skeleton className="h-4 w-16" />
                  )}
                </div>

                {/* Bitrate */}
                <div>
                  <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                    Bitrate
                  </span>
                  <span className="font-mono tabular-nums text-sm text-text-primary">
                    <AnimatedNumber
                      value={captureBitrate}
                      format="bitrate"
                    />
                  </span>
                </div>

                {/* Total bytes sent */}
                <div>
                  <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                    Total data
                  </span>
                  <span className="font-mono tabular-nums text-sm text-text-primary">
                    <AnimatedNumber
                      value={totalBytesSent}
                      format="bytes"
                    />
                  </span>
                </div>

                {/* Viewer count */}
                <div>
                  <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                    Viewers
                  </span>
                  <span className="font-mono tabular-nums text-sm text-text-primary">
                    {viewerCount}
                  </span>
                </div>

                {/* Source */}
                <div>
                  <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                    Source
                  </span>
                  <span className="text-sm text-text-primary truncate block">
                    {sourceName || sourceKind || "—"}
                  </span>
                </div>
              </div>

              {/* ─── Advanced stats (Disclosure/Collapsible) ────────── */}
              <Separator className="my-3" />

              <div className="space-y-2">
                <button
                  className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-compact px-1 -ml-1"
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                  aria-expanded={advancedOpen}
                  aria-controls="advanced-stats-content"
                >
                  {advancedOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <span className="font-medium">Advanced</span>
                </button>

                <AnimatePresence initial={false}>
                  {advancedOpen && (
                    <motion.div
                      key="advanced-stats-content"
                      id="advanced-stats-content"
                      initial={
                        reduced
                          ? false
                          : { height: 0, opacity: 0 }
                      }
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={springStiff}
                      className="overflow-hidden"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                        {/* Codec */}
                        <div>
                          <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                            Codec
                          </span>
                          <span className="font-mono tabular-nums text-xs text-text-primary">
                            {streamStats?.codec
                              ? formatCodec(streamStats.codec)
                              : "—"}
                          </span>
                        </div>

                        {/* Latency (RTT) */}
                        <div>
                          <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                            Latency
                          </span>
                          <span className="font-mono tabular-nums text-xs text-text-primary">
                            {streamStats?.latency != null
                              ? formatMs(streamStats.latency)
                              : "—"}
                          </span>
                        </div>

                        {/* Packet loss */}
                        <div>
                          <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                            Packet loss
                          </span>
                          <span className="font-mono tabular-nums text-xs text-text-primary">
                            {streamStats?.packetLoss != null
                              ? formatPercent(streamStats.packetLoss)
                              : "—"}
                          </span>
                        </div>

                        {/* Data per hour */}
                        <div>
                          <span className="block text-[11px] uppercase tracking-wider text-text-muted mb-1 font-medium">
                            Data / hour
                          </span>
                          <span className="font-mono tabular-nums text-xs text-text-primary">
                            {streamStats?.dataPerHour != null ? (
                              <AnimatedNumber
                                value={streamStats.dataPerHour}
                                format="bytes"
                                className="text-xs"
                              />
                            ) : (
                              "—"
                            )}
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ─── Source / Audio / Quality controls ──────────────────────── */}
        <motion.div
          key="controls"
          {...entranceProps}
          layout={reduced ? false : true}
          className="mb-4"
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-text-primary">
                Stream controls
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleChangeSource}
                >
                  <Monitor className="h-3.5 w-3.5" />
                  Change source
                </Button>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Volume2 className="h-3.5 w-3.5" />
                      Change audio
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64" side="bottom" align="start">
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium text-text-primary">
                        Audio mode
                      </h4>
                      <p className="text-xs text-text-secondary">
                        Audio source options will appear here.
                      </p>
                      <Separator className="my-2" />
                      <div className="space-y-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-xs"
                        >
                          No audio
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-xs"
                        >
                          Application audio
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-xs"
                        >
                          Monitor audio
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-xs"
                        >
                          System audio
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Settings2 className="h-3.5 w-3.5" />
                      Change quality
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72" side="bottom" align="start">
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium text-text-primary">
                        Quality preset
                      </h4>
                      <p className="text-xs text-text-secondary">
                        Preset selection grid will appear here.
                      </p>
                      <Separator className="my-2" />
                      <div className="grid grid-cols-2 gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-auto flex-col py-2 text-xs"
                        >
                          <span className="font-medium">Data saver</span>
                          <span className="text-[10px] text-text-muted font-mono">
                            640×360
                          </span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-auto flex-col py-2 text-xs"
                        >
                          <span className="font-medium">Balanced</span>
                          <span className="text-[10px] text-text-muted font-mono">
                            854×480
                          </span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-auto flex-col py-2 text-xs"
                        >
                          <span className="font-medium">Clear</span>
                          <span className="text-[10px] text-text-muted font-mono">
                            1280×720
                          </span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-auto flex-col py-2 text-xs"
                        >
                          <span className="font-medium">Custom</span>
                          <span className="text-[10px] text-text-muted font-mono">
                            Manual
                          </span>
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ─── Section 7: Remote quality request state ───────────────── */}
        <motion.div
          key="requests"
          {...entranceProps}
          layout={reduced ? false : true}
          className="mb-4"
        >
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-text-primary">
                Pending requests
              </CardTitle>
              {pendingRequests.length > 0 && (
                <Badge
                  variant="default"
                  className="text-[10px] px-1.5 py-0"
                >
                  {pendingRequests.length}
                </Badge>
              )}
            </CardHeader>
            <CardContent>
              {pendingRequests.length === 0 ? (
                <p className="text-xs text-text-muted">
                  No pending quality requests from viewers.
                </p>
              ) : (
                <div className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {pendingRequests.map((req) => (
                      <motion.div
                        key={req.id}
                        layout
                        initial={
                          reduced
                            ? { opacity: 0 }
                            : { opacity: 0, x: -12 }
                        }
                        animate={{
                          opacity: 1,
                          x: 0,
                          backgroundColor:
                            req.status === "accepted"
                              ? "rgba(34, 197, 94, 0.08)"
                              : req.status === "rejected"
                                ? "rgba(239, 68, 68, 0.08)"
                                : "transparent",
                        }}
                        exit={
                          reduced
                            ? { opacity: 0 }
                            : { opacity: 0, x: 12 }
                        }
                        transition={springStiff}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2 rounded-compact",
                          req.status === "accepted" &&
                            "border border-success/30",
                          req.status === "rejected" &&
                            "border border-danger/30",
                          req.status === "pending" &&
                            "bg-surface-hover",
                        )}
                      >
                        {/* Status icon */}
                        <div className="flex-shrink-0">
                          {req.status === "accepted" ? (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{
                                type: "spring",
                                stiffness: 400,
                                damping: 20,
                              }}
                            >
                              <Check className="h-4 w-4 text-success" />
                            </motion.div>
                          ) : req.status === "rejected" ? (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{
                                type: "spring",
                                stiffness: 400,
                                damping: 20,
                              }}
                            >
                              <X className="h-4 w-4 text-danger" />
                            </motion.div>
                          ) : req.requestKind === "higher-quality" ? (
                            <ArrowUpFromLine className="h-4 w-4 text-accent" />
                          ) : (
                            <ArrowDownToLine className="h-4 w-4 text-warning" />
                          )}
                        </div>

                        {/* Request info */}
                        <div className="flex-1 min-w-0">
                          <span className="block text-xs font-medium text-text-primary truncate">
                            {req.viewerName}
                          </span>
                          <span className="block text-[11px] text-text-muted">
                            {req.requestKind === "higher-quality"
                              ? "Higher quality"
                              : req.requestKind === "lower-quality"
                                ? "Lower quality"
                                : "Preset change"}
                            {" · "}
                            {timeAgo(req.receivedAt)}
                          </span>
                        </div>

                        {/* Action buttons (only for pending) */}
                        {req.status === "pending" && (
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-success hover:text-success hover:bg-success/10"
                                  onClick={() =>
                                    handleAcceptRequest(req.id)
                                  }
                                  aria-label={`Accept ${req.viewerName}'s request`}
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                Accept
                              </TooltipContent>
                            </Tooltip>

                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-danger hover:text-danger hover:bg-danger/10"
                                  onClick={() =>
                                    handleRejectRequest(req.id)
                                  }
                                  aria-label={`Reject ${req.viewerName}'s request`}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                Reject
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        )}

                        {/* Applied / rejected indicator */}
                        {req.status === "accepted" && (
                          <span className="text-[11px] text-success font-medium flex-shrink-0">
                            Applied
                          </span>
                        )}
                        {req.status === "rejected" && (
                          <span className="text-[11px] text-danger font-medium flex-shrink-0">
                            Rejected
                          </span>
                        )}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* ─── Section 8: Connection status ───────────────────────────── */}
        <motion.div
          key="connection"
          {...entranceProps}
          layout={reduced ? false : true}
        >
          <Card>
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-2.5">
                <motion.span
                  className={cn(
                    "h-2 w-2 rounded-full flex-shrink-0",
                    connectionDotColors[connectionQuality],
                  )}
                  animate={{
                    scale:
                      connectionQuality === "good" ? 1 : [1, 1.3, 1],
                  }}
                  transition={{
                    duration: 2,
                    repeat: connectionQuality !== "good"
                      ? Infinity
                      : 0,
                    ease: "easeInOut",
                  }}
                />
                <span className="text-xs text-text-secondary">
                  {connectionLabels[connectionQuality]}
                </span>
                {isDegraded && (
                  <Badge
                    variant="warning"
                    className="text-[10px] px-1.5 py-0 ml-auto"
                  >
                    <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                    Degraded
                  </Badge>
                )}
                {localShareState === "starting" && (
                  <Badge
                    variant="default"
                    className="text-[10px] px-1.5 py-0 ml-auto"
                  >
                    <RefreshCw className="h-2.5 w-2.5 mr-0.5 animate-spin" />
                    Starting
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </AnimatePresence>

      {/* ─── Stop-sharing confirmation dialog ───────────────────────── */}
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
            <Button
              variant="destructive"
              onClick={handleStopSharing}
            >
              <StopCircle className="h-4 w-4" />
              Stop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
