import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Monitor,
  ArrowLeft,
  Maximize,
  RefreshCw,
  AlertTriangle,
  WifiOff,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  useStore,
  type StreamAnnouncement,
} from "@/stores/main-store";
import { VideoControls } from "./viewer/VideoControls.js";
import type { QualityLevel } from "./viewer/QualityPopover.js";
import { ViewerSession, type ViewerSessionState } from "@/services/viewer-session.js";

// ─── Reduced motion hook ──────────────────────────────────────────────────

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

// ─── Duration formatting ─────────────────────────────────────────────────

function formatLiveDuration(startedAt: number): string {
  const elapsed = Date.now() - startedAt;
  if (elapsed < 0) return "Live";
  const totalSeconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ─── Auto-hide timeout hook ──────────────────────────────────────────────

function useControlsAutoHide(delay = 3000) {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), delay);
  }, [delay]);

  const keepVisible = useCallback(() => {
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  useEffect(() => {
    timerRef.current = setTimeout(() => setVisible(false), delay);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [delay]);

  return { visible, show, keepVisible, hide };
}

// ─── Props ────────────────────────────────────────────────────────────────

interface ViewerWorkspaceProps {
  /** Class override */
  className?: string;
}

// ─── Transitions ──────────────────────────────────────────────────────────

const fadeSpring = {
  type: "spring" as const,
  stiffness: 300,
  damping: 26,
};

const fadeInstant = {
  duration: 0.15,
  ease: "easeInOut" as const,
};

// ─── Map ViewerSession state to viewStatus string ────────────────────────

function sessionStateToViewStatus(state: ViewerSessionState): string {
  switch (state) {
    case "idle":
    case "connecting":
      return "connecting";
    case "requesting-join":
      return "connecting";
    case "waiting-for-host":
      return "connecting";
    case "accepted":
      return "connecting";
    case "connecting-media":
      return "connecting";
    case "watching":
      return "watching";
    case "ended":
      return "ended";
    case "error":
      return "error";
  }
}

// ─── ViewerWorkspace ──────────────────────────────────────────────────────

/**
 * ViewerWorkspace — Video-first viewer layout (Section 8.5).
 *
 * Uses the real ViewerSession to manage the join flow and media
 * connection. No simulation, no timers.
 *
 * States (Section 15):
 *   - Connecting   → Skeleton + status text
 *   - Reconnecting → Amber Alert with inline Progress (future use)
 *   - Degraded     → Amber Alert
 *   - Ended        → Animated exit + "Return to overview"
 *   - Fatal error  → Destructive Alert + retry
 *   - Watching     → Video stage + header strip + controls
 */
export function ViewerWorkspace({ className }: ViewerWorkspaceProps) {
  const reduced = usePrefersReducedMotion();

  // ─── Store ───────────────────────────────────────────────────────
  const isViewing = useStore((s) => s.isViewing);
  const viewStatus = useStore((s) => s.viewStatus);
  const setIsViewing = useStore((s) => s.setIsViewing);
  const setViewStatus = useStore((s) => s.setViewStatus);
  const toggleFocusMode = useStore((s) => s.toggleFocusMode);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  const watchedStreamsBySessionId = useStore((s) => s.watchedStreamsBySessionId);
  const watchedSessionId = useMemo(
    () => Object.keys(watchedStreamsBySessionId)[0] ?? null,
    [watchedStreamsBySessionId],
  );

  // ── Local state ──────────────────────────────────────────────────
  const [isPaused, setIsPaused] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [quality, setQuality] = useState<QualityLevel>("custom");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<ViewerSessionState>("idle");

  // Video element ref — shared with ViewerSession
  const videoRef = useRef<HTMLVideoElement>(null);

  // ViewerSession instance ref — stable across renders
  const sessionRef = useRef<ViewerSession | null>(null);

  // Auto-hide controls
  const { visible: controlsVisible, show: showControls, keepVisible, hide: hideControls } =
    useControlsAutoHide(3000);

  // Fullscreen change listener
  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Sync volume via ref (volume is a DOM property, not a JSX attribute)
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume]);

  // ── Derive current stream info ───────────────────────────────────
  const currentStream = useMemo(() => {
    if (!selectedGroupId) return null;
    const streams = activeStreamsByGroup[selectedGroupId] ?? [];
    if (currentStreamId) {
      return streams.find((s) => s.logicalStreamId === currentStreamId) ?? streams[0] ?? null;
    }
    if (watchedSessionId) {
      return streams.find((s) => s.mediaSessionId === watchedSessionId) ?? streams[0] ?? null;
    }
    return streams[0] ?? null;
  }, [selectedGroupId, activeStreamsByGroup, currentStreamId, watchedSessionId]);

  // Set initial stream ID
  useEffect(() => {
    if (currentStream && !currentStreamId) {
      setCurrentStreamId(currentStream.logicalStreamId);
    }
  }, [currentStream, currentStreamId]);

  // Watched stream info (set by Watch button or join flow)
  const watchedInfo = useMemo(() => {
    const watchedId = currentStream?.mediaSessionId ?? Object.keys(watchedStreamsBySessionId)[0] ?? null;
    if (watchedId && watchedStreamsBySessionId[watchedId]) {
      return { sessionId: watchedId, ...watchedStreamsBySessionId[watchedId] };
    }
    return null;
  }, [currentStream, watchedStreamsBySessionId]);

  const sharerName = currentStream?.hostDisplayName ?? watchedInfo?.hostName ?? "Unknown";
  const sourceName =
    currentStream?.sourceName ?? currentStream?.sourceKind ?? "Screen share";
  const liveDuration = currentStream
    ? formatLiveDuration(currentStream.startedAt)
    : watchedInfo
    ? formatLiveDuration(watchedInfo.startedAt)
    : "";

  // ── ViewerSession lifecycle ─────────────────────────────────────
  //
  // INTENTIONAL STALE-CLOSURE PATTERN
  // ──────────────────────────────────
  // This effect captures watch-target values (selectedGroupId,
  // watchedInfo, currentStream, sharerName) via refs at mount time,
  // then reads them inside the effect via those refs.  The effect
  // depends ONLY on `isViewing` because:
  //
  //   1. The viewer page mounts once per watch session; target
  //      parameters are set by the Watch button and should not
  //      change mid-session.
  //   2. Adding the watch-target values to the deps array would
  //      tear down and recreate the ViewerSession on every store
  //      update (e.g. new stream heartbeat), which is wrong.
  //   3. The only legitimate re-creation trigger is the user
  //      exiting and re-watching (isViewing toggles).
  //
  // Re-structuring to avoid stale values would require threading
  // the watch target through a dedicated context or route param,
  // which is out of scope for this defect pass.

  const targetRef = useRef({ selectedGroupId, watchedInfo, currentStream, sharerName });
  targetRef.current = { selectedGroupId, watchedInfo, currentStream, sharerName };

  useEffect(() => {
    if (!isViewing || sessionRef.current) return;

    const { selectedGroupId: gId, watchedInfo: wInfo, currentStream: cStream, sharerName: sName } = targetRef.current;

    // Determine the watch target from watched info or active stream.
    // Use watchedInfo.sessionId if available, otherwise fall back to
    // currentStream.mediaSessionId. This ensures local self-preview works
    // when the host watches their own stream without sending remote join requests.
    const targetSessionId = wInfo?.sessionId ?? cStream?.mediaSessionId;
    const targetHostDeviceId = wInfo?.hostDeviceId ?? cStream?.hostDeviceId;
    const targetLogicalStreamId = cStream?.logicalStreamId;

    if (!gId || !targetHostDeviceId || !targetLogicalStreamId || !targetSessionId) {
      // Cannot start session without complete target info
      setViewStatus("error: missing stream target");
      return;
    }

    const session = new ViewerSession();
    sessionRef.current = session;

    // Listen for state changes
    session.onStateChange = (state: ViewerSessionState) => {
      setSessionState(state);
      const status = sessionStateToViewStatus(state);
      setViewStatus(status);
    };

    // Handle errors
    session.onError = (error: string) => {
      setViewStatus(`error: ${error}`);
    };

    // Start the session
    session.start({
      groupId: gId,
      hostDeviceId: targetHostDeviceId,
      logicalStreamId: targetLogicalStreamId,
      mediaSessionId: targetSessionId,
      hostName: sName,
      videoElement: videoRef.current,
    }).catch((err) => {
      setViewStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
    });

    return () => {
      // Cleanup on unmount
      if (sessionRef.current) {
        sessionRef.current.destroy();
        sessionRef.current = null;
      }
    };
  }, [isViewing]);

  // Bind video element to session whenever ref is available
  useEffect(() => {
    if (sessionRef.current && videoRef.current) {
      sessionRef.current.bindVideoElement(videoRef.current);
    }
  }, [videoRef.current, sessionState]);

  // ── Callbacks ────────────────────────────────────────────────────

  const handleExit = useCallback(() => {
    // Stop the session
    if (sessionRef.current) {
      sessionRef.current.stop();
      sessionRef.current.destroy();
      sessionRef.current = null;
    }
    setIsViewing(false);
    setViewStatus("");
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    }
  }, [setIsViewing, setViewStatus]);

  const handleToggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
    toggleFocusMode();
  }, [toggleFocusMode]);

  const handleStreamSwitch = useCallback(
    (stream: StreamAnnouncement) => {
      setCurrentStreamId(stream.logicalStreamId);
    },
    [],
  );

  const handleRetry = useCallback(() => {
    if (sessionRef.current) {
      setViewStatus("connecting");
      void sessionRef.current.retry();
    } else {
      // If no session, reset view status to trigger re-mount effect
      setViewStatus("connecting");
    }
  }, [setViewStatus]);

  // ── Derive display status from session state ─────────────────────
  // Use the store's viewStatus as source of truth, falling back to sessionState
  const displayStatus = viewStatus || sessionStateToViewStatus(sessionState);

  // ── Render by view status (Section 15) ───────────────────────────

  // Connecting state — Skeleton + status text
  if (displayStatus === "connecting") {
    return (
      <ViewerShell className={className} onExit={handleExit}>
        <motion.div
          key="connecting"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? fadeInstant : fadeSpring}
          className="flex flex-col items-center justify-center h-full gap-5"
          role="status"
          aria-label="Connecting to stream"
        >
          {/* 16:9 skeleton stage */}
          <div className="relative w-full max-w-3xl aspect-video rounded-standard overflow-hidden bg-surface-2">
            <Skeleton className="absolute inset-0 rounded-none" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="relative">
                  <Skeleton className="h-16 w-16 rounded-full" />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <Monitor className="h-7 w-7 text-text-muted" />
                  </span>
                </div>
                <div className="text-center">
                  <p className="text-sm text-text-secondary font-medium">
                    Connecting to {sharerName}'s stream
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    Establishing secure relay connection...
                  </p>
                </div>
                <Progress value={35} className="w-48 h-1" />
              </div>
            </div>
          </div>
        </motion.div>
      </ViewerShell>
    );
  }

  // Reconnecting state — Amber Alert with inline Progress
  if (displayStatus === "reconnecting") {
    return (
      <ViewerShell className={className} onExit={handleExit}>
        <motion.div
          key="reconnecting"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? fadeInstant : fadeSpring}
          className="flex flex-col h-full"
        >
          {/* Preserve video layout — show the video element behind */}
          <div className="relative flex-1 flex items-center justify-center bg-canvas">
            <video
              ref={videoRef}
              className="w-full h-full object-contain"
              muted={isMuted}
              playsInline
            />

            {/* Reconnection overlay — inline, non-disruptive */}
            <div className="absolute top-4 left-4 right-4 z-20">
              <Alert variant="warning" className="backdrop-blur-sm bg-surface-2/90">
                <div className="flex items-start gap-3">
                  <WifiOff className="h-4 w-4 mt-0.5 text-warning" />
                  <div className="flex-1">
                    <AlertTitle>Reconnecting</AlertTitle>
                    <AlertDescription>
                      Attempting to restore the connection to {sharerName}'s stream.
                    </AlertDescription>
                    <Progress value={60} className="mt-3 h-1.5" />
                  </div>
                </div>
              </Alert>
            </div>
          </div>

          {/* Controls persist during reconnection */}
          <VideoControlsOverlay
            isPaused={isPaused}
            onTogglePlay={() => setIsPaused((p) => !p)}
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={setVolume}
            onToggleMute={() => setIsMuted((m) => !m)}
            quality={quality}
            onQualitySelect={setQuality}
            currentStreamId={currentStreamId ?? ""}
            onStreamSwitch={handleStreamSwitch}
            connectionState="reconnecting"
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            onExit={handleExit}
            controlsVisible={controlsVisible}
            showControls={showControls}
            isLive
          />
        </motion.div>
      </ViewerShell>
    );
  }

  // Degraded state — Amber Alert
  if (displayStatus === "degraded") {
    return (
      <ViewerShell className={className} onExit={handleExit}>
        <motion.div
          key="degraded"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? fadeInstant : fadeSpring}
          className="flex flex-col h-full"
        >
          <div className="relative flex-1 flex items-center justify-center bg-canvas">
            <video
              ref={videoRef}
              className="w-full h-full object-contain"
              muted={isMuted}
              playsInline
            />

            {/* Degraded overlay — amber, compact */}
            <div className="absolute top-4 left-4 right-4 z-20">
              <Alert variant="warning" className="backdrop-blur-sm bg-surface-2/90">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-4 w-4 mt-0.5 text-warning" />
                  <div className="flex-1">
                    <AlertTitle>Connection degraded</AlertTitle>
                    <AlertDescription>
                      The stream quality may be reduced. The host's connection is
                      experiencing issues.
                    </AlertDescription>
                  </div>
                </div>
              </Alert>
            </div>
          </div>

          <VideoControlsOverlay
            isPaused={isPaused}
            onTogglePlay={() => setIsPaused((p) => !p)}
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={setVolume}
            onToggleMute={() => setIsMuted((m) => !m)}
            quality={quality}
            onQualitySelect={setQuality}
            currentStreamId={currentStreamId ?? ""}
            onStreamSwitch={handleStreamSwitch}
            connectionState="degraded"
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            onExit={handleExit}
            controlsVisible={controlsVisible}
            showControls={showControls}
            isLive
          />
        </motion.div>
      </ViewerShell>
    );
  }

  // Stream ended state — Animated exit
  if (displayStatus === "ended") {
    return (
      <ViewerShell className={className} onExit={handleExit}>
        <motion.div
          key="ended"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? fadeInstant : { duration: 0.4 }}
          className="flex flex-col items-center justify-center h-full"
        >
          {/* Fading video element */}
          <motion.div
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={reduced ? { duration: 0.1 } : { duration: 0.6 }}
            className="absolute inset-0 bg-canvas"
          />

          {/* Ended message */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? fadeInstant : { delay: 0.3, duration: 0.4 }}
            className="relative z-10 flex flex-col items-center gap-4 text-center"
          >
            <div className="h-12 w-12 rounded-full bg-surface-3 flex items-center justify-center">
              <Monitor className="h-6 w-6 text-text-muted" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-text-primary">
                {sharerName}'s stream ended
              </h2>
              <p className="text-sm text-text-secondary mt-1">
                The stream is no longer available.
                {liveDuration && ` It was live for ${liveDuration}.`}
              </p>
            </div>
            <Button variant="default" onClick={handleExit}>
              <ArrowLeft className="h-4 w-4" />
              Return to overview
            </Button>
          </motion.div>
        </motion.div>
      </ViewerShell>
    );
  }

  // Fatal error state — Destructive Alert + retry
  if (displayStatus === "error") {
    return (
      <ViewerShell className={className} onExit={handleExit}>
        <motion.div
          key="error"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? fadeInstant : fadeSpring}
          className="flex flex-col items-center justify-center h-full p-8"
        >
          <div className="max-w-md w-full">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Unable to play stream</AlertTitle>
              <AlertDescription>
                A fatal error occurred while trying to connect to or play
                {sharerName}'s stream. Please try again or check your
                connection.
                {viewStatus.startsWith("error:") && (
                  <span className="block mt-2 text-xs opacity-70">
                    {viewStatus.slice(6)}
                  </span>
                )}
              </AlertDescription>
            </Alert>
            <div className="flex items-center gap-3 mt-4 justify-center">
              <Button variant="default" onClick={handleRetry}>
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
              <Button variant="ghost" onClick={handleExit}>
                <ArrowLeft className="h-4 w-4" />
                Return to overview
              </Button>
            </div>
          </div>
        </motion.div>
      </ViewerShell>
    );
  }

  // ── Watching / default state: Video stage with controls ────────

  return (
    <ViewerShell className={className} onExit={handleExit}>
      <motion.div
        key="watching"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={reduced ? fadeInstant : fadeSpring}
        className="flex flex-col h-full"
        onMouseMove={showControls}
        onMouseEnter={showControls}
        onMouseLeave={hideControls}
      >
        {/* ── Video stage ──────────────────────────────────────────── */}
        <div className="relative flex-1 flex items-center justify-center bg-black">
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            muted={isMuted}
            playsInline
            autoPlay
            aria-label={`${sharerName}'s stream - ${sourceName}`}
          />

          {/* Video controls overlay */}
          <VideoControlsOverlay
            isPaused={isPaused}
            onTogglePlay={() => setIsPaused((p) => !p)}
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={setVolume}
            onToggleMute={() => setIsMuted((m) => !m)}
            quality={quality}
            onQualitySelect={setQuality}
            currentStreamId={currentStreamId ?? ""}
            onStreamSwitch={handleStreamSwitch}
            connectionState={
              displayStatus === "watching"
                ? "connected"
                : displayStatus === "degraded"
                ? "degraded"
                : "connected"
            }
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            onExit={handleExit}
            controlsVisible={controlsVisible}
            showControls={showControls}
            isLive
          />
        </div>
      </motion.div>
    </ViewerShell>
  );
}

// ─── Viewer shell ──────────────────────────────────────────────────────────

/**
 * ViewerShell — Wraps the viewer content with a header strip and exit button.
 * Provides consistent chrome across all viewer states.
 */
function ViewerShell({
  children,
  className,
  onExit,
}: {
  children: React.ReactNode;
  className?: string;
  onExit: () => void;
}) {
  const isViewing = useStore((s) => s.isViewing);
  const viewStatus = useStore((s) => s.viewStatus);
  const toggleFocusMode = useStore((s) => s.toggleFocusMode);
  const focusMode = useStore((s) => s.focusMode);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  const watchedStreamsBySessionId = useStore((s) => s.watchedStreamsBySessionId);

  const currentStream = useMemo(() => {
    if (!selectedGroupId) return null;
    const streams = activeStreamsByGroup[selectedGroupId] ?? [];
    return streams[0] ?? null;
  }, [selectedGroupId, activeStreamsByGroup]);

  // Get the first watched stream if no active stream
  const watchedEntries = useMemo(
    () => Object.entries(watchedStreamsBySessionId),
    [watchedStreamsBySessionId],
  );

  const sharerName = currentStream?.hostDisplayName ?? watchedEntries[0]?.[1]?.hostName ?? "Stream";
  const sourceName =
    currentStream?.sourceName ?? currentStream?.sourceKind ?? "Screen share";

  // Connection status dot
  const connectionDot = useMemo(() => {
    switch (viewStatus) {
      case "reconnecting":
        return "bg-warning";
      case "degraded":
        return "bg-warning";
      case "ended":
        return "bg-text-muted";
      case "error":
        return "bg-danger";
      case "watching":
        return "bg-success";
      default:
        return "bg-warning";
    }
  }, [viewStatus]);

  const connectionLabel = useMemo(() => {
    switch (viewStatus) {
      case "reconnecting":
        return "Reconnecting";
      case "degraded":
        return "Degraded";
      case "ended":
        return "Ended";
      case "error":
        return "Error";
      case "watching":
        return "Watching";
      default:
        return viewStatus || "Connecting";
    }
  }, [viewStatus]);

  const handleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
    toggleFocusMode();
  }, [toggleFocusMode]);

  return (
    <div className={cn("flex flex-col h-full bg-canvas", className)}>
      {/* ─── Header strip ───────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-surface-1 flex-shrink-0">
        {/* Left: source/sharer info */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Monitor className="h-4 w-4 text-text-muted flex-shrink-0" />
            <span className="text-sm font-medium text-text-primary truncate">
              {sharerName}
            </span>
            <Badge
              variant="success"
              className="text-[10px] px-1.5 py-0 leading-none"
            >
              Watching
            </Badge>
          </div>
          <span className="text-xs text-text-muted hidden sm:inline truncate">
            {sourceName}
          </span>

          {/* Connection status dot */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1.5 cursor-default">
                <span
                  className={cn("h-2 w-2 rounded-full", connectionDot)}
                />
                <span className="text-[11px] text-text-muted hidden sm:inline">
                  {connectionLabel}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {connectionLabel}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleFullscreen}
                aria-label="Enter focus mode"
              >
                <Maximize className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Focus mode (Ctrl+Shift+F)
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={onExit}
                aria-label="Exit viewer"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Exit viewer</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Return to group overview
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ─── Content area ────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden relative">{children}</div>
    </div>
  );
}

// ─── VideoControlsOverlay ──────────────────────────────────────────────────

/**
 * VideoControlsOverlay — Wraps VideoControls with auto-hide behavior.
 * Renders controls at the bottom of the video stage using AnimatePresence.
 */
function VideoControlsOverlay({
  isPaused,
  onTogglePlay,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  quality,
  onQualitySelect,
  currentStreamId,
  onStreamSwitch,
  connectionState,
  isFullscreen,
  onToggleFullscreen,
  onExit,
  controlsVisible,
  showControls,
  isLive,
}: {
  isPaused: boolean;
  onTogglePlay: () => void;
  volume: number;
  isMuted: boolean;
  onVolumeChange: (v: number) => void;
  onToggleMute: () => void;
  quality: QualityLevel;
  onQualitySelect: (level: QualityLevel) => void;
  currentStreamId: string;
  onStreamSwitch: (stream: StreamAnnouncement) => void;
  connectionState: "connecting" | "connected" | "degraded" | "reconnecting" | "ended" | "error";
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onExit: () => void;
  controlsVisible: boolean;
  showControls: () => void;
  isLive: boolean;
}) {
  return (
    <AnimatePresence>
      {controlsVisible && (
        <VideoControls
          isPaused={isPaused}
          onTogglePlay={onTogglePlay}
          volume={volume}
          isMuted={isMuted}
          onVolumeChange={onVolumeChange}
          onToggleMute={onToggleMute}
          quality={quality}
          onQualitySelect={onQualitySelect}
          currentStreamId={currentStreamId}
          onStreamSwitch={onStreamSwitch}
          connectionState={connectionState}
          isFullscreen={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
          onExit={onExit}
          visible={controlsVisible}
          isLive={isLive}
        />
      )}
    </AnimatePresence>
  );
}
