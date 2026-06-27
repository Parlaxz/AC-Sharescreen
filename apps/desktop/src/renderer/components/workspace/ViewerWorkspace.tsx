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
  Settings2,
  Info,
} from "lucide-react";
import { motion } from "motion/react";
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
import { useStore } from "@/stores/main-store";
import type { StreamAnnouncement } from "@/stores/main-store";
import { VideoControls } from "./viewer/VideoControls.js";
import type { ViewerRequestState } from "./viewer/ViewerSettingsPanel.js";
import { ViewerSession, type ViewerSessionState } from "@/services/viewer-session.js";
import { getRuntime } from "@/services/phase3-runtime.js";

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
  const watchingTarget = useStore((s) => s.watchingTarget);
  // Use explicit watching target — no first-entry heuristics
  const currentTarget = watchingTarget;
  const watchedSessionId = currentTarget?.mediaSessionId ?? null;

  // ── Local state ──────────────────────────────────────────────────
  const [isPaused, setIsPaused] = useState(false);
  const [volume, setVolume] = useState(() => {
    try {
      const stored = localStorage.getItem("screenlink:viewer-volume");
      return stored !== null ? parseFloat(stored) : 1;
    } catch { return 1; }
  });
  const [isMuted, setIsMuted] = useState(() => {
    try {
      return localStorage.getItem("screenlink:viewer-muted") === "true";
    } catch { return false; }
  });
  // Viewer quality request state (null = no request = host defaults)
  const [viewerRequest, setViewerRequest] = useState<ViewerRequestState | null>(() => {
    try {
      const raw = localStorage.getItem("screenlink:viewer-request");
      if (raw) return JSON.parse(raw) as ViewerRequestState;
    } catch { /* ignore */ }
    return null; // default: no request = host defaults
  });
  // "Last requested" = what we last sent (for diagnostics)
  const [lastRequestedQuality, setLastRequestedQuality] = useState<ViewerRequestState | null>(null);
  // "Effective" = what the host replied (from quality.effective)
  const [effectiveBitrateKbps, setEffectiveBitrateKbps] = useState<number | null>(null);
  const [configuredBitrateBps, setConfiguredBitrateBps] = useState<number | null>(null);
  const [displayMode, setDisplayMode] = useState<"fit" | "fill" | "actual">(() => {
    try { return (localStorage.getItem("screenlink:viewer-display-mode") as "fit" | "fill" | "actual") ?? "fit"; }
    catch { return "fit"; }
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<ViewerSessionState>("idle");
  const [qualityRequestPending, setQualityRequestPending] = useState(false);
  const [qualityFeedback, setQualityFeedback] = useState<string | null>(null);
  const [lastQualityAccepted, setLastQualityAccepted] = useState<boolean | undefined>(undefined);
  /** Track whether any popover panel is open to keep controls visible */
  const [panelsOpen, setPanelsOpen] = useState(false);

  // Video element ref — shared with ViewerSession
  const videoRef = useRef<HTMLVideoElement>(null);

  // ViewerSession instance ref — stable across renders
  const sessionRef = useRef<ViewerSession | null>(null);

  // Auto-hide controls — stay visible while any popover panel is open
  // Track panel open state as a synthetic "always show" signal
  const { visible: controlsVisible, show: showControls, keepVisible, hide: hideControls } =
    useControlsAutoHide(panelsOpen ? 999999 : 3000);

  // Fullscreen change listener — use Electron IPC when available.
  // Syncs focusMode with fullscreen state so AppShell hides chrome
  // (TitleBar, GroupRail, GroupDashboard) when in fullscreen.
  useEffect(() => {
    const syncFullscreenFocus = (isFs: boolean) => {
      setIsFullscreen(isFs);
      useStore.getState().setFocusMode(isFs);
    };

    const api = (window as unknown as { screenlink?: { onFullscreenChanged: (cb: (isFullscreen: boolean) => void) => () => void } }).screenlink;
    if (api) {
      // Use Electron native fullscreen events
      const unsubscribe = api.onFullscreenChanged(syncFullscreenFocus);
      return unsubscribe;
    }
    // Fallback for non-Electron environments
    const handler = () => {
      syncFullscreenFocus(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Listen for viewer keyboard shortcut events
  useEffect(() => {
    const handleToggleMute = () => {
      setIsMuted((m) => !m);
    };
    window.addEventListener("screenlink:viewer-toggle-mute", handleToggleMute);
    return () => {
      window.removeEventListener("screenlink:viewer-toggle-mute", handleToggleMute);
    };
  }, []);

  // Sync volume via ref (volume is a DOM property, not a JSX attribute)
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume]);

  // Sync muted via ref — the JSX muted attribute can get out of sync during
  // re-renders when the video element is reused across state transitions.
  // This explicit DOM sync ensures the video element's muted property
  // always matches the isMuted state.
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isMuted;
    }
  }, [isMuted]);

  // Persist volume to localStorage
  useEffect(() => {
    try { localStorage.setItem("screenlink:viewer-volume", String(volume)); } catch {}
  }, [volume]);

  // Persist mute state to localStorage
  useEffect(() => {
    try { localStorage.setItem("screenlink:viewer-muted", String(isMuted)); } catch {}
  }, [isMuted]);

  // Map display mode to CSS object-fit and object-position values
  // "fill" uses cover (not stretch) to avoid distortion
  const videoObjectFit = displayMode === "fit" ? "contain"
    : displayMode === "fill" ? "cover"
    : "none"; // actual size — no scaling
  const videoObjectPosition = displayMode === "actual" ? "0 0" : "center";

  // Persist viewer request preferences to localStorage (reuse on later streams)
  useEffect(() => {
    try {
      if (viewerRequest) {
        localStorage.setItem("screenlink:viewer-request", JSON.stringify(viewerRequest));
      } else {
        localStorage.removeItem("screenlink:viewer-request");
      }
    } catch { /* ignore */ }
  }, [viewerRequest]);

  // Persist display mode to localStorage
  useEffect(() => {
    try { localStorage.setItem("screenlink:viewer-display-mode", displayMode); } catch {}
  }, [displayMode]);

  // ── Derive current stream info from explicit watching target ─────
  const currentStream = useMemo(() => {
    if (!watchingTarget) return null;
    // First try to find the exact stream in active streams
    const streams = selectedGroupId ? (activeStreamsByGroup[selectedGroupId] ?? []) : [];
    const exact = streams.find(
      (s) => s.logicalStreamId === watchingTarget.logicalStreamId && s.mediaSessionId === watchingTarget.mediaSessionId
    );
    if (exact) return exact;
    // If stream is gone (host stopped), still return the target info for display
    // This keeps the "ended" state working even after the stream disappears
    if (!currentStreamId) return null;
    return streams.find((s) => s.logicalStreamId === currentStreamId) ?? null;
  }, [selectedGroupId, activeStreamsByGroup, currentStreamId, watchingTarget]);

  // Set initial stream ID
  useEffect(() => {
    if (currentStream && !currentStreamId) {
      setCurrentStreamId(currentStream.logicalStreamId);
    }
  }, [currentStream, currentStreamId]);

  // Watched stream info from explicit target
  const watchedInfo = useMemo(() => {
    if (!watchingTarget) return null;
    return {
      sessionId: watchingTarget.mediaSessionId,
      hostDeviceId: watchingTarget.hostDeviceId,
      hostName: watchingTarget.hostName,
      startedAt: watchingTarget.startedAt,
    };
  }, [watchingTarget]);

  const sharerName = watchedInfo?.hostName ?? watchingTarget?.hostName ?? currentStream?.hostDisplayName ?? "Unknown";
  const sourceName = watchingTarget?.sourceName
    ?? currentStream?.sourceName
    ?? watchingTarget?.sourceKind
    ?? currentStream?.sourceKind
    ?? "Screen share";
  const liveDuration = currentStream
    ? formatLiveDuration(currentStream.startedAt)
    : watchedInfo
    ? formatLiveDuration(watchedInfo.startedAt)
    : "";

  // ── Send real quality request when user sets quality ──────────
  const handleQualityRequestChange = useCallback(async (newRequest: ViewerRequestState | null) => {
    const prevRequest = viewerRequest;
    setViewerRequest(newRequest);
    setQualityRequestPending(true);
    setQualityFeedback(null);

    try {
      const runtime = getRuntime();
      if (!runtime || !watchingTarget) return;

      const groupId = watchingTarget.groupId;
      const logicalStreamId = watchingTarget.logicalStreamId;

      // Get connection manager and connection
      const connManager = runtime.getConnectionManager();
      const conn = connManager.getConnection(groupId);
      if (!conn) {
        setQualityFeedback("Not connected to group");
        setLastQualityAccepted(false);
        setQualityRequestPending(false);
        return;
      }
      const hostPeerUuid = conn.peerForDevice(watchingTarget.hostDeviceId);

      // If setting request state to null, send quality.viewer.clear
      if (newRequest === null) {
        setLastRequestedQuality(null);
        if (hostPeerUuid) {
          await conn.sendToPeer(hostPeerUuid, {
            type: "quality.viewer.clear",
            streamSessionId: logicalStreamId,
          });
        } else {
          await conn.broadcast({
            type: "quality.viewer.clear",
            streamSessionId: logicalStreamId,
          });
        }
        setQualityFeedback("Quality request cleared — using host defaults");
        setLastQualityAccepted(true);
        setQualityRequestPending(false);
        return;
      }

      // Record the last requested values for diagnostics
      setLastRequestedQuality(newRequest);

      // Send through the authenticated group control channel with explicit fields
      const requestId = crypto.randomUUID();
      const payload = {
        type: "quality.viewer.request" as const,
        streamSessionId: logicalStreamId,
        requestId,
        revision: Date.now(),
        videoBitrateKbps: newRequest.videoBitrateKbps,
        maxWidth: newRequest.maxWidth,
        maxHeight: newRequest.maxHeight,
        maxFps: newRequest.maxFps,
        degradationPreference: "balanced",
      };

      if (hostPeerUuid) {
        await conn.sendToPeer(hostPeerUuid, payload);
      } else {
        await conn.broadcast(payload);
      }

      // Accept optimistically — real feedback comes via quality.effective messages
      setQualityFeedback(`Requested ${newRequest.videoBitrateKbps} kbps, ${newRequest.maxWidth}×${newRequest.maxHeight} @ ${newRequest.maxFps}fps — awaiting host response`);
      setLastQualityAccepted(undefined);
    } catch (err) {
      setViewerRequest(prevRequest);
      setQualityFeedback(`Failed to send quality request: ${err instanceof Error ? err.message : String(err)}`);
      setLastQualityAccepted(false);
    } finally {
      setQualityRequestPending(false);
    }
  }, [viewerRequest, watchingTarget]);

  // ── Listen for incoming quality feedback (after currentStream is declared) ──
  useEffect(() => {
    const handleQualityEffective = (event: CustomEvent) => {
      const detail = event.detail ?? {};
      const streamSessionId = detail.streamSessionId;
      const cs = currentStream;
      const watchedLogicalStreamId = cs?.logicalStreamId;
      if (!streamSessionId || !watchedLogicalStreamId) return;
      if (streamSessionId !== watchedLogicalStreamId) return;

      const kbps = detail.videoBitrateKbps;
      const clampReasons: string[] = detail.clampReasons ?? [];

      if (kbps) setEffectiveBitrateKbps(kbps);

      if (clampReasons.length > 0) {
        setQualityFeedback(`Accepted, capped: ${clampReasons.join("; ")}`);
        setLastQualityAccepted(true);
      } else {
        setQualityFeedback(`Accepted at ${kbps} kbps`);
        setLastQualityAccepted(true);
      }
    };

    const handleQualityConfigured = (event: CustomEvent) => {
      const detail = event.detail ?? {};
      const streamSessionId = detail.streamSessionId;
      const cs = currentStream;
      const watchedLogicalStreamId = cs?.logicalStreamId;
      if (!streamSessionId || !watchedLogicalStreamId) return;
      if (streamSessionId !== watchedLogicalStreamId) return;

      const kbps = detail.videoBitrateKbps;
      const fps = detail.maxFramerate;
      const scale = detail.scaleResolutionDownBy;

      if (kbps) setConfiguredBitrateBps(kbps * 1000);

      const parts: string[] = [];
      if (kbps) parts.push(`${kbps} kbps`);
      if (fps) parts.push(`${fps} fps`);
      if (scale) parts.push(`scale ${scale}x`);
      setQualityFeedback(parts.length > 0 ? `Applied: ${parts.join(", ")}` : "Applied to sender");
      setLastQualityAccepted(true);
    };

    window.addEventListener("screenlink:quality-effective", handleQualityEffective as EventListener);
    window.addEventListener("screenlink:quality-configured", handleQualityConfigured as EventListener);
    return () => {
      window.removeEventListener("screenlink:quality-effective", handleQualityEffective as EventListener);
      window.removeEventListener("screenlink:quality-configured", handleQualityConfigured as EventListener);
    };
  }, [watchingTarget?.logicalStreamId]);

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

  // ── Detect exact watched stream stop using explicit target — do NOT eject on other streams ──
  useEffect(() => {
    if (!isViewing || !watchingTarget || !sessionRef.current) return;

    const exactLogicalStreamId = watchingTarget.logicalStreamId;
    const exactMediaSessionId = watchingTarget.mediaSessionId;
    if (!exactLogicalStreamId) return;

    let endTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = useStore.subscribe((state, prevState) => {
      if (!sessionRef.current) return;

      // 1) Check if our exact logical stream disappeared from active streams
      if (selectedGroupId) {
        const currStreams = state.activeStreamsByGroup[selectedGroupId] ?? [];
        const stillExists = currStreams.some(
          (s) => s.logicalStreamId === exactLogicalStreamId && s.mediaSessionId === exactMediaSessionId
        );
        if (!stillExists) {
          // Our stream is gone — destroy session and show ended
          sessionRef.current.stop();
          sessionRef.current.destroy();
          sessionRef.current = null;
          setViewStatus("ended");

          // Auto-navigate to overview after short delay
          if (endTimer) clearTimeout(endTimer);
          endTimer = setTimeout(() => {
            const s = useStore.getState();
            s.setIsViewing(false);
            s.navigate("overview");
          }, 4000);
          return;
        }
      }

      // 2) Check if watched session removed from watchedStreamsBySessionId
      const prevWatched = prevState.watchedStreamsBySessionId;
      const currWatched = state.watchedStreamsBySessionId;
      if (exactMediaSessionId && prevWatched[exactMediaSessionId] && !currWatched[exactMediaSessionId]) {
        if (sessionRef.current) {
          sessionRef.current.stop();
          sessionRef.current.destroy();
          sessionRef.current = null;
        }
        setViewStatus("ended");

        if (endTimer) clearTimeout(endTimer);
        endTimer = setTimeout(() => {
          const s = useStore.getState();
          s.setIsViewing(false);
          s.navigate("overview");
        }, 4000);
      }
    });

    return () => {
      unsubscribe();
      if (endTimer) clearTimeout(endTimer);
    };
  }, [isViewing, selectedGroupId, setViewStatus, watchingTarget?.logicalStreamId, watchingTarget?.mediaSessionId]);

  // Bind video element to session whenever ref is available
  useEffect(() => {
    if (sessionRef.current && videoRef.current) {
      sessionRef.current.bindVideoElement(videoRef.current);
    }
  }, [videoRef.current, sessionState]);

  // ── Callbacks ────────────────────────────────────────────────────

  const handleExit = useCallback(async () => {
    // Stop the session
    if (sessionRef.current) {
      sessionRef.current.stop();
      sessionRef.current.destroy();
      sessionRef.current = null;
    }
    // Clear watching target to avoid stale state
    useStore.getState().setWatchingTarget(null);
    setIsViewing(false);
    setViewStatus("");
    // Exit fullscreen if active
    if (isFullscreen) {
      const api = (window as unknown as { screenlink?: { toggleFullscreen: () => Promise<boolean> } }).screenlink;
      if (api) {
        await api.toggleFullscreen();
      } else if (document.fullscreenElement) {
        void document.exitFullscreen();
      }
    }
  }, [setIsViewing, setViewStatus, isFullscreen]);

  const handleToggleFullscreen = useCallback(async () => {
    const api = (window as unknown as { screenlink?: { toggleFullscreen: () => Promise<boolean>; onFullscreenChanged: (cb: (isFullscreen: boolean) => void) => () => void } }).screenlink;
    if (api) {
      const newFs = await api.toggleFullscreen();
      // Sync focusMode with fullscreen so AppShell hides chrome
      useStore.getState().setFocusMode(newFs);
    } else {
      // Fallback for non-Electron environments
      if (document.fullscreenElement) {
        void document.exitFullscreen();
        useStore.getState().setFocusMode(false);
      } else {
        void document.documentElement.requestFullscreen();
        useStore.getState().setFocusMode(true);
      }
    }
  }, []);

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
            viewerRequest={viewerRequest}
            onQualityRequestChange={handleQualityRequestChange}
            qualityRequestPending={qualityRequestPending}
            qualityFeedback={qualityFeedback}
            lastQualityAccepted={lastQualityAccepted}
            effectiveBitrateKbps={effectiveBitrateKbps}
            configuredBitrateBps={configuredBitrateBps}
            displayMode={displayMode}
            onDisplayModeChange={setDisplayMode}
            currentStreamId={currentStreamId ?? ""}
            onStreamSwitch={handleStreamSwitch}
            connectionState="reconnecting"
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            onExit={handleExit}
            controlsVisible={controlsVisible}
            showControls={showControls}
            isLive
            onPanelsOpenChange={setPanelsOpen}
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
            viewerRequest={viewerRequest}
            onQualityRequestChange={handleQualityRequestChange}
            qualityRequestPending={qualityRequestPending}
            qualityFeedback={qualityFeedback}
            lastQualityAccepted={lastQualityAccepted}
            effectiveBitrateKbps={effectiveBitrateKbps}
            configuredBitrateBps={configuredBitrateBps}
            displayMode={displayMode}
            onDisplayModeChange={setDisplayMode}
            currentStreamId={currentStreamId ?? ""}
            onStreamSwitch={handleStreamSwitch}
            connectionState="degraded"
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            onExit={handleExit}
            controlsVisible={controlsVisible}
            showControls={showControls}
            isLive
            onPanelsOpenChange={setPanelsOpen}
          />
        </motion.div>
      </ViewerShell>
    );
  }

  // Stream ended state — Animated exit with auto-navigate
  if (displayStatus === "ended") {
    return (
      <motion.div
        key="ended"
        initial={{ opacity: 1 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={reduced ? fadeInstant : { duration: 0.4 }}
        className="flex flex-col items-center justify-center h-full bg-canvas"
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
              The streamer ended the share
            </h2>
            <p className="text-sm text-text-secondary mt-1">
              {sharerName}'s stream is no longer available.
              {liveDuration && ` It was live for ${liveDuration}.`}
            </p>
          </div>
          <Button variant="default" onClick={handleExit}>
            <ArrowLeft className="h-4 w-4" />
            Return to overview
          </Button>
        </motion.div>
      </motion.div>
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
            className="w-full h-full"
            style={{
              objectFit: videoObjectFit,
              objectPosition: videoObjectPosition,
            }}
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
            viewerRequest={viewerRequest}
            onQualityRequestChange={handleQualityRequestChange}
            qualityRequestPending={qualityRequestPending}
            qualityFeedback={qualityFeedback}
            lastQualityAccepted={lastQualityAccepted}
            effectiveBitrateKbps={effectiveBitrateKbps}
            configuredBitrateBps={configuredBitrateBps}
            displayMode={displayMode}
            onDisplayModeChange={setDisplayMode}
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
            session={sessionRef.current}
            onPanelsOpenChange={setPanelsOpen}
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

  // Connection status dot — authoritative, no hardcoded green badge
  // Only show "Watching" when viewStatus is exactly "watching" and NO
  // error is present. Never show Watching + error simultaneously.
  const isErrorState = viewStatus.startsWith("error:") || viewStatus === "error";
  const isEndedState = viewStatus === "ended";
  const isConnectedState = viewStatus === "watching" && !isErrorState;

  const connectionDot = useMemo(() => {
    if (isErrorState) return "bg-danger";
    if (isEndedState) return "bg-text-muted";
    if (isConnectedState) return "bg-success";
    if (viewStatus === "reconnecting" || viewStatus === "degraded") return "bg-warning";
    return "bg-warning";
  }, [viewStatus, isErrorState, isEndedState, isConnectedState]);

  const connectionLabel = useMemo(() => {
    if (isErrorState) return "Error";
    if (isEndedState) return "Ended";
    if (isConnectedState) return "Watching";
    if (viewStatus === "degraded") return "Degraded";
    if (viewStatus === "reconnecting") return "Reconnecting";
    return viewStatus || "Connecting";
  }, [viewStatus, isErrorState, isEndedState, isConnectedState]);

  const handleFullscreen = useCallback(async () => {
    const api = (window as unknown as { screenlink?: { toggleFullscreen: () => Promise<boolean> } }).screenlink;
    if (api) {
      const newFs = await api.toggleFullscreen();
      useStore.getState().setFocusMode(newFs);
    } else {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
        useStore.getState().setFocusMode(false);
      } else {
        void document.documentElement.requestFullscreen();
        useStore.getState().setFocusMode(true);
      }
    }
  }, []);

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
            {isConnectedState && (
              <Badge
                variant="success"
                className="text-[10px] px-1.5 py-0 leading-none"
              >
                Watching
              </Badge>
            )}
            {!isConnectedState && !isErrorState && !isEndedState && (
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0 leading-none"
              >
                {connectionLabel}
              </Badge>
            )}
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

        {/* Right: actions — order: Fullscreen, Settings, Diagnostics, Exit */}
        <div className="flex items-center gap-1">

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleFullscreen}
                aria-label="Toggle fullscreen"
              >
                <Maximize className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Fullscreen (F)
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => window.dispatchEvent(new CustomEvent("screenlink:viewer-toggle-settings"))}
                aria-label="Viewer settings"
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Settings (S)
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => window.dispatchEvent(new CustomEvent("screenlink:viewer-toggle-info"))}
                aria-label="Diagnostics"
              >
                <Info className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Diagnostics (I)
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
 * Always renders controls (never unmounts) to keep keyboard event
 * listeners and popover state alive. Visibility is controlled via the
 * `visible` prop and framer-motion opacity/y animation.
 */
function VideoControlsOverlay({
  isPaused,
  onTogglePlay,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  viewerRequest,
  onQualityRequestChange,
  qualityRequestPending,
  qualityFeedback,
  lastQualityAccepted,
  effectiveBitrateKbps,
  configuredBitrateBps,
  displayMode,
  onDisplayModeChange,
  currentStreamId,
  onStreamSwitch,
  connectionState,
  isFullscreen,
  onToggleFullscreen,
  onExit,
  controlsVisible,
  showControls,
  isLive,
  session,
  onPanelsOpenChange,
}: {
  isPaused: boolean;
  onTogglePlay: () => void;
  volume: number;
  isMuted: boolean;
  onVolumeChange: (v: number) => void;
  onToggleMute: () => void;
  viewerRequest: ViewerRequestState | null;
  onQualityRequestChange: (state: ViewerRequestState | null) => void;
  qualityRequestPending: boolean;
  qualityFeedback: string | null;
  lastQualityAccepted: boolean | undefined;
  effectiveBitrateKbps: number | null;
  configuredBitrateBps: number | null;
  displayMode: "fit" | "fill" | "actual";
  onDisplayModeChange: (mode: "fit" | "fill" | "actual") => void;
  currentStreamId: string;
  onStreamSwitch: (stream: StreamAnnouncement) => void;
  connectionState: "connecting" | "connected" | "degraded" | "reconnecting" | "ended" | "error";
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onExit: () => void;
  controlsVisible: boolean;
  showControls: () => void;
  isLive: boolean;
  session?: ViewerSession | null;
  onPanelsOpenChange?: (open: boolean) => void;
}) {
  return (
    <VideoControls
      isPaused={isPaused}
      onTogglePlay={onTogglePlay}
      volume={volume}
      isMuted={isMuted}
      onVolumeChange={onVolumeChange}
      onToggleMute={onToggleMute}
      viewerRequest={viewerRequest}
      onQualityRequestChange={onQualityRequestChange}
      qualityRequestPending={qualityRequestPending}
      qualityFeedback={qualityFeedback}
      lastQualityAccepted={lastQualityAccepted}
      effectiveBitrateKbps={effectiveBitrateKbps}
      configuredBitrateBps={configuredBitrateBps}
      displayMode={displayMode}
      onDisplayModeChange={onDisplayModeChange}
      currentStreamId={currentStreamId}
      onStreamSwitch={onStreamSwitch}
      connectionState={connectionState}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
      onExit={onExit}
      visible={controlsVisible}
      isLive={isLive}
      session={session}
      onPanelsOpenChange={onPanelsOpenChange}
    />
  );
}
