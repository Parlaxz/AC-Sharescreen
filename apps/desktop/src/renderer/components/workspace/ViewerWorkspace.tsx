import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Monitor,
  ArrowLeft,
  Maximize,
  RefreshCw,
  AlertTriangle,
  WifiOff,
  Info,
  Play,
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
import { VideoControls, type ShortcutBinding } from "./viewer/VideoControls.js";
import { StreamMetricsService } from "@/services/stream-metrics-service";
import { ViewerPanelShell } from "./viewer/ViewerPanelShell.js";
import type { ActivePanel } from "./viewer/ViewerPanelShell.js";
import { ViewerSettingsPanel, type ViewerRequestState } from "./viewer/ViewerSettingsPanel.js";
import { loadSettings } from "@/services/settings-actions";
import {
  getViewerQualityDispatchError,
  resolveViewerQualityFeedbackStreamId,
} from "./viewer/viewer-quality-helpers.js";
import { ViewerSession, type ViewerSessionState, type ViewerPauseState } from "@/services/viewer-session.js";
import { getRuntime } from "@/services/phase3-runtime.js";
import { initializeAppRuntime } from "@/services/initialize-app-runtime.js";
import type { ScreenLinkAPI } from "../../../preload/api-types.js";
import { navigateToGroupOverview } from "@/services/group-navigation";
import { EnhancedVideoSurface } from "@/components/workspace/viewer/EnhancedVideoSurface";
import { CompareViewerSurface, type CompareDisplayMode } from "@/components/workspace/CompareViewerSurface";
import type { ProcessorState, ProcessorStats } from "@/services/viewer-image-processing/viewer-image-processor";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";
import {
  loadImageEnhancementSettings,
  loadImageEnhancementSettingsB,
  saveImageEnhancementSettings,
  saveImageEnhancementSettingsB,
  resetImageEnhancementSettings,
  resetImageEnhancementSettingsB,
} from "@/services/viewer-image-processing/viewer-image-settings";
import {
  nvidiaBenchmarkService,
  getBenchmarkProgressSnapshot,
  subscribeToBenchmarkProgress,
  type BenchmarkHost,
} from "@/services/viewer-image-processing/nvidia-benchmark-service";
import type { ProcessorAPI } from "@/services/viewer-image-processing/processor-api";
import { getNvidiaCapabilitySnapshot } from "@/services/nvidia-capability-store";

// ─── Module-level viewer lifecycle serialization ────────────────────────
// Survives component remounts so create/start/destroy operations for the
// viewer session cannot overlap across remounts or quick retries.
let viewerLifecycle: Promise<void> = Promise.resolve();

function queueViewerLifecycle(
  operation: () => Promise<void>,
): Promise<void> {
  const run = viewerLifecycle.then(operation, operation);
  viewerLifecycle = run.catch(() => {});
  return run;
}

type NativeBenchmarkStatusShape = {
  benchmarkActive: boolean;
  benchmarkTargetFrames: number;
  benchmarkFramesCompleted: number;
  benchmarkTotalTimeUs: number;
  benchmarkAvgTimeUs?: number;
  benchmarkComplete?: boolean;
};

type NativeBenchmarkAggregateShape = {
  success: boolean;
  error?: string;
  framesProcessed: number;
  framesDropped: number;
  framesFailed: number;
  totalTimeUs: number;
  avgTimeUs: number;
  minTimeUs: number;
  maxTimeUs: number;
  avgInputReceiveUs: number;
  avgUploadUs: number;
  avgEffectUs: number;
  avgDownloadUs: number;
  avgOutputWriteUs: number;
  avgFps: number;
};

type SavedBenchmarkResult = {
  success: boolean;
  id?: string;
  error?: string;
};

type SavedBenchmarkRecord = {
  id: string;
  config: {
    processingMode: "vsr" | "high-bitrate" | "denoise" | "deblur";
    qualityLevel: "low" | "medium" | "high" | "ultra";
    inputWidth: number;
    inputHeight: number;
    frames: number;
    frameTimeoutMs?: number;
  };
  status: "idle" | "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  framesProcessed: number;
  framesDropped: number;
  framesFailed: number;
  avgProcessingTimeMs: number;
  minProcessingTimeMs: number;
  maxProcessingTimeMs: number;
  p50ProcessingTimeMs: number;
  p95ProcessingTimeMs: number;
  p99ProcessingTimeMs: number;
  avgFps: number;
  avgNativeInputReceiveMs?: number;
  avgNativeUploadMs?: number;
  avgNativeEffectMs?: number;
  avgNativeDownloadMs?: number;
};

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

// ─── Bitrate formatting ──────────────────────────────────────────────────

function fmtKbps(kbps: number): string {
  if (kbps <= 0) return "0 kB/s";
  const Bps = kbps * 125; // kbps * 1000 / 8
  if (Bps < 1000) return `${Math.round(Bps)} B/s`;
  const kBps = Bps / 1000;
  if (kBps < 1000) return `${kBps.toFixed(1)} kB/s`;
  return `${(kBps / 1000).toFixed(2)} MB/s`;
}

// ─── Auto-hide timeout hook ──────────────────────────────────────────────

function useControlsAutoHide({ delayMs = 3000, locked = false }: { delayMs?: number; locked?: boolean }) {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const scheduleTimer = useCallback(() => {
    cancelTimer();
    timerRef.current = setTimeout(() => setVisible(false), delayMs);
  }, [delayMs, cancelTimer]);

  const show = useCallback(() => {
    setVisible(true);
    scheduleTimer();
  }, [scheduleTimer]);

  const keepVisible = useCallback(() => {
    setVisible(true);
    cancelTimer();
  }, [cancelTimer]);

  const hide = useCallback(() => {
    cancelTimer();
    setVisible(false);
  }, [cancelTimer]);

  useEffect(() => {
    if (locked) {
      setVisible(true);
      cancelTimer();
      return;
    }
    scheduleTimer();
    return cancelTimer;
  }, [locked, scheduleTimer, cancelTimer]);

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
    case "paused":
      return "paused";
    case "reconnecting":
      return "connecting";
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
  const setIsViewing = useStore((s) => s.setIsViewing);
  const setViewStatus = useStore((s) => s.setViewStatus);
  const toggleFocusMode = useStore((s) => s.toggleFocusMode);
  const navigate = useStore((s) => s.navigate);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);
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

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<ViewerSessionState>("idle");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [qualityRequestPending, setQualityRequestPending] = useState(false);
  const [qualityFeedback, setQualityFeedback] = useState<string | null>(null);
  const [lastQualityAccepted, setLastQualityAccepted] = useState<boolean | undefined>(undefined);
  /** Track which popover panel is active (null = closed) */
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  /** Viewer history ID for StreamMetricsService session */
  const [viewerHistoryId, setViewerHistoryId] = useState<string | null>(null);
  const viewerHistoryIdRef = useRef<string | null>(null);

  // ── Pause state ─────────────────────────────────────────────────────
  const [streamPauseState, setStreamPauseState] = useState<ViewerPauseState>("playing");
  const [streamPausePoster, setStreamPausePoster] = useState<string | null>(null);
  const streamPauseTransitioning = streamPauseState === "pausing" || streamPauseState === "resuming";

  // ── GPU image enhancement state ──────────────────────────────────────
  const [enhancementSettings, setEnhancementSettings] = useState<ViewerImageEnhancementSettings>(() => {
    return loadImageEnhancementSettings();
  });
  const [enhancementStats, setEnhancementStats] = useState<ProcessorStats | null>(null);
  const [enhancementStatsB, setEnhancementStatsB] = useState<ProcessorStats | null>(null);
  const [enhancementFallback, setEnhancementFallback] = useState(false);
  /** Tracks whether at least one GPU-enhanced frame has been successfully rendered */
  const [enhancementActive, setEnhancementActive] = useState(false);

  // ── Compare mode state ───────────────────────────────────────────────────
  const [isCompareActive, setIsCompareActive] = useState(false);
  const [compareSettingsBOpen, setCompareSettingsBOpen] = useState(false);
  const [settingsB, setSettingsB] = useState<ViewerImageEnhancementSettings>(() => {
    return loadImageEnhancementSettingsB();
  });

  // Refs for closure-safe access in callbacks
  const enhancementSettingsRef = useRef(enhancementSettings);
  enhancementSettingsRef.current = enhancementSettings;
  const enhancementFallbackRef = useRef(enhancementFallback);
  enhancementFallbackRef.current = enhancementFallback;
  const enhancementStatsRef = useRef<ProcessorStats | null>(null);
  enhancementStatsRef.current = enhancementStats;
  /** Tracks whether the stored viewerRequest has been auto-sent for this session */
  const viewerRequestAutoSentRef = useRef(false);

  // ── Benchmark service subscription ──────────────────────────────────
  const benchmarkProgress = useSyncExternalStore(
    subscribeToBenchmarkProgress,
    getBenchmarkProgressSnapshot,
    getBenchmarkProgressSnapshot,
  );
  /** Ref populated by EnhancedVideoSurface when the processor is ready. */
  const processorApiRef = useRef<ProcessorAPI | null>(null);
  const processorApiRefB = useRef<ProcessorAPI | null>(null);

  // ── Discord shortcut bindings (loaded from settings) ──
  const [discordMuteBinding, setDiscordMuteBinding] = useState<ShortcutBinding>({ modifiers: ["alt"], key: "M" });
  const [discordDeafenBinding, setDiscordDeafenBinding] = useState<ShortcutBinding>({ modifiers: ["alt"], key: "D" });
  const [syncScreenLinkDeafen, setSyncScreenLinkDeafen] = useState(true);
  const [maxVolumePercent, setMaxVolumePercent] = useState(200);

  useEffect(() => {
    void loadSettings().then((settings) => {
      if (settings.discordMuteShortcut?.key) {
        setDiscordMuteBinding(settings.discordMuteShortcut);
      }
      if (settings.discordDeafenShortcut?.key) {
        setDiscordDeafenBinding(settings.discordDeafenShortcut);
      }
      setSyncScreenLinkDeafen(settings.discordDeafenScreenLink ?? true);
      setMaxVolumePercent(settings.viewerMaxVolumePercent ?? 200);
    }).catch(() => {
      // keep defaults
    });
  }, []);

  // Clamp current volume when maxVolumePercent changes
  useEffect(() => {
    const maxVol = maxVolumePercent / 100;
    setVolume((prev) => Math.min(prev, maxVol));
  }, [maxVolumePercent]);

  // ── ScreenLink deafen state (for Discord deafen feature) ──
  const [isScreenLinkDeafened, setIsScreenLinkDeafened] = useState(false);
  // Remember previous mute state before deafening
  const preDeafenMutedRef = useRef(false);

  const handleToggleScreenLinkDeafen = useCallback(() => {
    setIsScreenLinkDeafened((prev) => {
      if (!prev) {
        // Deafening: remember current mute state, then mute
        preDeafenMutedRef.current = isMuted;
        setIsMuted(true);
      } else {
        // Un-deafening: restore previous mute state
        setIsMuted(preDeafenMutedRef.current);
      }
      return !prev;
    });
  }, [isMuted]);

  // ── Bandwidth tracking ──
  const [currentBandwidthBps, setCurrentBandwidthBps] = useState(0);
  const [totalBytesReceived, setTotalBytesReceived] = useState(0);
  const [activeDurationMs, setActiveDurationMs] = useState(0);
  const unregisterMetricsRef = useRef<(() => void) | null>(null);
  const metricsSubscriptionRef = useRef<(() => void) | null>(null);

  // Poll WebRTC stats for bandwidth
  useEffect(() => {
    // Session ended or errored: full reset
    if (!sessionRef.current || sessionState === "ended" || sessionState === "error") {
      setCurrentBandwidthBps(0);
      setTotalBytesReceived(0);
      setActiveDurationMs(0);
      // Unregister metrics connection
      if (unregisterMetricsRef.current) { unregisterMetricsRef.current(); unregisterMetricsRef.current = null; }
      if (metricsSubscriptionRef.current) { metricsSubscriptionRef.current(); metricsSubscriptionRef.current = null; }
      // Finalize viewer session if active
      if (viewerHistoryIdRef.current) {
        const id = viewerHistoryIdRef.current;
        viewerHistoryIdRef.current = null;
        setViewerHistoryId(null);
        StreamMetricsService.getInstance().finalizeSession(id).catch(() => {});
      }
      return;
    }

    // Paused or reconnecting: keep registration but show zero
    if (sessionState === "paused" || sessionState === "reconnecting") {
      setCurrentBandwidthBps(0);
      return;
    }

    // Start viewer session if not already started
    if (!viewerHistoryIdRef.current && watchingTarget) {
      const groupName = selectedGroupId ? (groupsById[selectedGroupId]?.name ?? "") : "";
      const historyId = StreamMetricsService.getInstance().startViewerSession(
        watchingTarget.mediaSessionId,
        watchingTarget.logicalStreamId,
        selectedGroupId ?? "",
        groupName,
      );
      viewerHistoryIdRef.current = historyId;
      setViewerHistoryId(historyId);
    }

    // Register RTCPeerConnection with StreamMetricsService when available
    if (viewerHistoryIdRef.current && !unregisterMetricsRef.current) {
      const pc = sessionRef.current.getPeerConnection();
      if (pc) {
        const historyId = viewerHistoryIdRef.current;
        const unregister = StreamMetricsService.getInstance().registerConnection({
          historyId,
          connectionId: `viewer-${historyId}`,
          viewerDeviceId: null,
          displayName: null,
          peerConnection: pc,
          direction: "inbound",
        });
        unregisterMetricsRef.current = unregister;

        // Subscribe to snapshot changes
        const unsub = StreamMetricsService.getInstance().subscribe(historyId, () => {
          if (viewerHistoryIdRef.current !== historyId) return;
          const snapshot = StreamMetricsService.getInstance().getSnapshot(historyId);
          setCurrentBandwidthBps(snapshot.aggregate.currentBitsPerSecond);
          setTotalBytesReceived(snapshot.aggregate.totalBytes);
          setActiveDurationMs(snapshot.aggregate.activeDurationMs);
        });
        metricsSubscriptionRef.current = unsub;

        // Initial read
        const snapshot = StreamMetricsService.getInstance().getSnapshot(historyId);
        setTotalBytesReceived(snapshot.aggregate.totalBytes);
        setActiveDurationMs(snapshot.aggregate.activeDurationMs);
      }
    }

    return () => {
      // Cleanup runs only when the effect re-runs due to deps changing;
      // the explicit reset at the top of the next run handles teardown.
    };
  }, [sessionState, watchingTarget, selectedGroupId, groupsById]);

  // Video element ref — shared with ViewerSession
  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * Stable callback ref that binds the video element to the session only
   * when the actual DOM element changes. Unlike the old effect-based bind
   * (which ran on every sessionState change), this avoids redundant
   * bindVideoElement calls that can interfere with stream attachment.
   */
  const videoRefCallback = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    // Always bind/unbind (including null) so the session stays in sync
    // with the actual video element lifecycle.
    sessionRef.current?.bindVideoElement(el);
  }, []);

  // Audio boost via Web Audio API GainNode (allows volume > 1.0)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  // ViewerSession instance ref — stable across renders
  const sessionRef = useRef<ViewerSession | null>(null);
  const startAttemptRef = useRef(0);

  // Auto-hide controls — stay visible while any popover panel is open
  // Track panel open state as a synthetic "always show" signal
  const { visible: controlsVisible, show: showControls, keepVisible, hide: hideControls } =
    useControlsAutoHide({ delayMs: 3000, locked: activePanel !== null });

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

  // ── Callbacks ────────────────────────────────────────────────────

  const handleExit = useCallback(async () => {
    // ── Critical ordering: destroy() MUST complete before any new
    //    Watch attempt can begin ─────────────────────────────────
    //
    //    If destroy() is fire-and-forget, the old session's async
    //    teardown (ViewerClient.shutdown → sdk.stopViewing →
    //    sdk.disconnect) can still be in-flight when React state
    //    transitions allow a rejoin.  Once the old teardown reaches
    //    the video-element cleanup step it calls
    //    videoElement.pause(); videoElement.srcObject = null;
    //    on the shared DOM element, which blanks the new session's
    //    stream, producing a persistent black screen.
    //
    //    Capturing sessionRef.current before the null-assignment
    //    ensures we hold a reference to the exact session we mean
    //    to destroy, even if the ref is cleared concurrently.
    startAttemptRef.current++;
    const session = sessionRef.current;
    if (sessionRef.current === session) {
      sessionRef.current = null;
    }

    if (session) {
      await queueViewerLifecycle(() => session.destroy());
    }

    // 2) Clear visual stale state that destroy() does not own
    //    (React component state managed via useState).
    // Cancel any running benchmark
    if (nvidiaBenchmarkService.running) {
      nvidiaBenchmarkService.cancel();
    }
    nvidiaBenchmarkService.reset();
    setEnhancementActive(false);
    setEnhancementFallback(false);
    setEnhancementStats(null);
    setStreamPauseState("playing");
    setStreamPausePoster(null);
    setSessionState("idle");
    setViewerError(null);
    setCurrentStreamId(null);
    setCurrentBandwidthBps(0);
    setTotalBytesReceived(0);

    // Finalize viewer session if active
    if (viewerHistoryIdRef.current) {
      const id = viewerHistoryIdRef.current;
      viewerHistoryIdRef.current = null;
      setViewerHistoryId(null);
      StreamMetricsService.getInstance().finalizeSession(id).catch(() => {});
    }

    // 3) Clear watching target and store viewing state
    useStore.getState().setWatchingTarget(null);
    setIsViewing(false);
    setViewStatus("");

    // 4) Exit fullscreen if active
    if (isFullscreen) {
      const api = (window as unknown as { screenlink?: { toggleFullscreen: () => Promise<boolean> } }).screenlink;
      if (api) {
        await api.toggleFullscreen();
      } else if (document.fullscreenElement) {
        void document.exitFullscreen();
      }
    }

    // 5) Navigate back to group overview with refresh
    navigateToGroupOverview();
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

  /**
   * Ensure the Phase3Runtime singleton is initialized before starting or
   * retrying a viewer session.  If no runtime exists (e.g. after app
   * startup race or runtime destruction), reinitialize it from the
   * screenlink API.
   */
  const ensureAppRuntimeInitialized = useCallback(async (): Promise<void> => {
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) {
      const api = (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink;
      if (!api) return;
      try {
        await initializeAppRuntime(api);
      } catch {
        // Non-fatal — the retry/start below will fail gracefully
      }
    }
  }, []);

  /**
   * Create and start a new ViewerSession when the existing session ref is
   * null (e.g. after the previous session was destroyed and the user
   * retries).  Extracted from the useEffect so it can be called both from
   * the isViewing effect and from the retry handler.
   */
  const startViewerSession = useCallback(async (
    claimOwnedSession: (session: ViewerSession) => void,
    shouldAbort: () => boolean = () => false,
  ): Promise<void> => {
    const attempt = ++startAttemptRef.current;

    // Reset enhancement active state for the new session so the raw video
    // is not hidden before the new enhanced path produces its first frame.
    setEnhancementActive(false);
    setStreamPauseState("playing");
    setStreamPausePoster(null);
    setViewerError(null);
    setSessionState("connecting");
    setViewStatus("connecting");

    await ensureAppRuntimeInitialized();

    await queueViewerLifecycle(async () => {
      if (shouldAbort() || attempt !== startAttemptRef.current || sessionRef.current || !useStore.getState().isViewing) {
        return;
      }

      const { selectedGroupId: gId, watchedInfo: wInfo, currentStream: cStream, sharerName: sName } = targetRef.current;

      const targetSessionId = wInfo?.sessionId ?? cStream?.mediaSessionId;
      const targetHostDeviceId = wInfo?.hostDeviceId ?? cStream?.hostDeviceId;
      const targetLogicalStreamId = cStream?.logicalStreamId;

      if (!gId || !targetHostDeviceId || !targetLogicalStreamId || !targetSessionId) {
        if (attempt !== startAttemptRef.current || shouldAbort()) return;
        setViewerError("missing stream target");
        setSessionState("error");
        setViewStatus("error");
        return;
      }

      const session = new ViewerSession();

      if (shouldAbort() || attempt !== startAttemptRef.current || !useStore.getState().isViewing) {
        await session.destroy().catch(() => {});
        return;
      }

      claimOwnedSession(session);
      sessionRef.current = session;

      session.onStateChange = (state: ViewerSessionState) => {
        if (sessionRef.current !== session) return;
        setSessionState(state);
        if (state !== "error") {
          setViewerError(null);
        }
        const status = sessionStateToViewStatus(state);
        setViewStatus(status);
      };

      session.onPauseStateChange = (pauseState: ViewerPauseState) => {
        if (sessionRef.current !== session) return;
        setStreamPauseState(pauseState);
      };
      session.onPosterFrameChange = (poster: string | null) => {
        if (sessionRef.current !== session) return;
        if (enhancementSettingsRef.current?.enabled && !enhancementFallbackRef.current) {
          const canvas = document.querySelector('[data-enhanced-canvas]') as HTMLCanvasElement | null;
          if (canvas && canvas.width > 0 && canvas.height > 0) {
            try {
              const enhancedPoster = canvas.toDataURL("image/jpeg", 0.85);
              setStreamPausePoster(enhancedPoster);
              return;
            } catch {
              // Fall through to use video element poster
            }
          }
        }
        setStreamPausePoster(poster);
      };

      session.onError = (error: string) => {
        if (sessionRef.current !== session) return;
        setViewerError(error);
      };

      await session.start({
        groupId: gId,
        hostDeviceId: targetHostDeviceId,
        logicalStreamId: targetLogicalStreamId,
        mediaSessionId: targetSessionId,
        hostName: sName,
        videoElement: videoRef.current,
      }).catch((err: unknown) => {
        if (sessionRef.current !== session) return;
        setViewerError(err instanceof Error ? err.message : String(err));
        setSessionState("error");
        setViewStatus("error");
      });
    });
  }, [ensureAppRuntimeInitialized, setViewStatus]);

  const handleRetry = useCallback(async () => {
    if (viewerHistoryIdRef.current) {
      StreamMetricsService.getInstance().setSessionState(viewerHistoryIdRef.current, "reconnecting");
    }
    setViewerError(null);
    setSessionState("connecting");
    setViewStatus("connecting");

    if (sessionRef.current) {
      await ensureAppRuntimeInitialized();
      void sessionRef.current.retry();
    } else {
      await startViewerSession(() => {});
    }
  }, [setViewStatus, ensureAppRuntimeInitialized, startViewerSession]);

  // ── Pause/resume callbacks (media op first, marker via setSessionState) ──
  const handlePauseStream = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.pauseState !== "playing") return;
    try {
      await session.pause();
      if (viewerHistoryIdRef.current) {
        StreamMetricsService.getInstance().setSessionState(viewerHistoryIdRef.current, "paused");
      }
    } catch (err) {
      console.error("[ViewerWorkspace] pause failed:", err);
    }
  }, []);

  const handleResumeStream = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.pauseState !== "paused") return;
    try {
      await session.resume();
      if (viewerHistoryIdRef.current) {
        const svc = StreamMetricsService.getInstance();
        svc.setSessionState(viewerHistoryIdRef.current, "playing");
        // The peer connection stayed alive through pause — no need to
        // replace it or re-register. The same connection is reused.
      }
    } catch (err) {
      console.error("[ViewerWorkspace] resume failed:", err);
    }
  }, []);

  const handleToggleStreamPause = useCallback(() => {
    if (streamPauseState === "paused") {
      void handleResumeStream();
    } else if (streamPauseState === "playing") {
      void handlePauseStream();
    }
  }, [streamPauseState, handlePauseStream, handleResumeStream]);

  const handleEnhancementChange = useCallback((partial: Partial<ViewerImageEnhancementSettings>) => {
    setEnhancementSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  const handleEnhancementReset = useCallback(() => {
    setEnhancementSettings(resetImageEnhancementSettings());
  }, []);

  const handleEnhancementProcessorStateChange = useCallback((state: ProcessorState) => {
    if (state === "error") {
      setEnhancementActive(false);
      setEnhancementFallback(true);
    }
  }, []);

  const handleEnhancementProcessingError = useCallback((reason: string) => {
    console.warn("[ViewerWorkspace] GPU enhancement error:", reason);
    if (viewerHistoryIdRef.current) {
      StreamMetricsService.getInstance().addMarker(
        viewerHistoryIdRef.current, "enhancement", "webgl2", "webgl2", `Enhancement fallback: ${reason}`
      );
    }
    setEnhancementActive(false);
    setEnhancementFallback(true);
  }, []);

  const handleEnhancementContextRestored = useCallback(() => {
    setEnhancementActive(false);
    setEnhancementFallback(false);
  }, []);

  const handleEnhancementFirstFrame = useCallback(() => {
    setEnhancementActive(true);
  }, []);

  const handleEnhancementStatsUpdate = useCallback((stats: ProcessorStats) => {
    setEnhancementStats(stats);
    enhancementStatsRef.current = stats;
  }, []);

  const handleEnhancementStatsUpdateB = useCallback((stats: ProcessorStats) => {
    setEnhancementStatsB(stats);
  }, []);

  // ── Compare mode handlers ──────────────────────────────────────────────
  const handleCompareToggle = useCallback(() => {
    setIsCompareActive((prev) => !prev);
  }, []);

  const handleCompareExit = useCallback(() => {
    setIsCompareActive(false);
    setCompareSettingsBOpen(false);
  }, []);

  // Activate compare mode AND open B settings panel
  const handleCompareToggleWithSettingsB = useCallback(() => {
    setIsCompareActive((prev) => {
      if (!prev) {
        // Opening compare — also open B settings panel
        setCompareSettingsBOpen(true);
      }
      return !prev;
    });
  }, []);

  const handleOpenCompareSettingsB = useCallback(() => {
    setIsCompareActive(true);
    setCompareSettingsBOpen(true);
  }, []);

  const handleCloseCompareSettingsB = useCallback(() => {
    setCompareSettingsBOpen(false);
  }, []);

  const handleEnhancementChangeB = useCallback((partial: Partial<ViewerImageEnhancementSettings>) => {
    setSettingsB((prev) => ({ ...prev, ...partial }));
  }, []);

  const handleCompareSettingsBReset = useCallback(() => {
    setSettingsB(resetImageEnhancementSettingsB());
  }, []);

  // Persist settings B when changed
  useEffect(() => {
    try {
      saveImageEnhancementSettingsB(settingsB);
    } catch { /* ignore */ }
  }, [settingsB]);

  // ── Benchmark helpers and handlers ───────────────────────────────────

  /**
   * Build a BenchmarkHost from the current processor refs and the
   * processorApiRef (populated by EnhancedVideoSurface).
   *
   * applySettings maps to handleEnhancementChange; readStats maps to
   * the latest ProcessorStats snapshot; subscribeFrameEvents and
   * waitForConfigApplied delegate to the active processor via the
   * processorApiRef.
   */
  const buildBenchmarkHost = useCallback((): BenchmarkHost => ({
    applySettings: (settings) => {
      handleEnhancementChange(settings);
    },
    readStats: () => {
      const stats = enhancementStatsRef.current;
      if (!stats) return null;
      return {
        processingTimeMs: stats.processingTimeMs,
        rendererToResultMs: stats.rendererToResultTimeMs,
        nativeTransportProcessingTimeMs: stats.nativeTransportProcessingTimeMs,
        totalEnhancedFrameLatencyMs: stats.totalEnhancedFrameLatencyMs,
        nativeOutputWidth: stats.nativeOutputWidth,
        nativeOutputHeight: stats.nativeOutputHeight,
        nativeQualityLevel: stats.nativeQualityLevel,
        framesDisplayed: stats.framesDisplayed,
        completedFps: stats.completedFps,
        backend: stats.backend,
        backpressureDrops: stats.backpressureDrops,
        nativeFailures: stats.nativeFailures,
      };
    },
    /**
     * Subscribe to real per-frame lifecycle events from the active
     * ViewerImageProcessor (via processorApiRef).  Falls back to a
     * no-op when no processor is available (safe for no-live-stream).
     */
    subscribeFrameEvents: (listener) => {
      const api = processorApiRef.current;
      return api
        ? api.subscribeFrameEvents(listener)
        : (() => {});
    },
    /**
     * Wait for the next configuration acknowledgement from the active
     * processor.  Returns null on timeout or when no processor is
     * available (safe for no-live-stream).
     */
    waitForConfigApplied: async (timeoutMs) => {
      const api = processorApiRef.current;
      return api
        ? api.waitForConfigApplied(timeoutMs)
        : null;
    },
    /**
     * Gather environment info using the NVIDIA capability store and
     * processor stats.  Returns null when no stats are available
     * (safe for no-live-stream).
     */
    getEnvironment: () => {
      const capability = getNvidiaCapabilitySnapshot();
      if (!capability.probed) return null;
      return {
        nvidiaAvailable: capability.available,
        nvidiaAdapterName: capability.adapterName ?? null,
        nvidiaDriverVersion: capability.driverVersion ?? null,
      } satisfies Partial<import("@/services/viewer-image-processing/nvidia-benchmark-service").BenchmarkEnvironmentInfo>;
    },
    runNativeBenchmark: async (config) => {
      const api = (window as unknown as { screenlink?: {
        nvidiaRunBenchmark: (cfg: {
          processingMode: "vsr" | "high-bitrate" | "denoise" | "deblur";
          qualityLevel: "low" | "medium" | "high" | "ultra";
          inputWidth: number;
          inputHeight: number;
          frames: number;
          frameTimeoutMs?: number;
        }) => Promise<{ success: boolean; error?: string; targetFrames?: number }>;
      } }).screenlink;
      if (!api?.nvidiaRunBenchmark) {
        return { success: false, error: "native-benchmark-api-unavailable" };
      }
      return api.nvidiaRunBenchmark({
        processingMode: config.processingMode,
        qualityLevel: config.qualityLevel,
        inputWidth: config.inputWidth,
        inputHeight: config.inputHeight,
        frames: config.targetFrames,
        frameTimeoutMs: config.frameTimeoutMs,
      });
    },
    getNativeBenchmarkStatus: async () => {
      const api = (window as unknown as { screenlink?: { nvidiaGetBenchmarkStatus: () => Promise<NativeBenchmarkStatusShape | null> } }).screenlink;
      return api?.nvidiaGetBenchmarkStatus ? api.nvidiaGetBenchmarkStatus() : null;
    },
    cancelNativeBenchmark: async () => {
      const api = (window as unknown as { screenlink?: { nvidiaCancelBenchmark: () => Promise<boolean> } }).screenlink;
      return api?.nvidiaCancelBenchmark ? api.nvidiaCancelBenchmark() : false;
    },
    getNativeBenchmarkAggregateResults: async () => {
      const api = (window as unknown as { screenlink?: { nvidiaGetBenchmarkAggregateResults: () => Promise<NativeBenchmarkAggregateShape | null> } }).screenlink;
      return api?.nvidiaGetBenchmarkAggregateResults ? api.nvidiaGetBenchmarkAggregateResults() : null;
    },
  }), [handleEnhancementChange]);

  /**
   * Start a full benchmark run.
   * Saves current enhancement settings, builds a host from the current
   * processor stats, and kicks off the service.
   */
  const handleRunBenchmark = useCallback(() => {
    // Save current settings for later restoration
    nvidiaBenchmarkService.saveSettings(enhancementSettingsRef.current);
    // Build host from refs (closure-safe)
    const host = buildBenchmarkHost();
    // Use default scenarios
    nvidiaBenchmarkService.setScenarios();
    // Start the run
    nvidiaBenchmarkService.start(host);
  }, [buildBenchmarkHost]);

  /**
   * Export handler — called by the benchmark service after successful
   * aggregation.  Persists the run via IPC export API and opens the
   * benchmark results folder.  Tracks state for UI feedback.
   *
   * State machine: idle → saving → saved → exporting → exported/failed
   */
  const [exportState, setExportState] = useState<"idle" | "saving" | "saved" | "exporting" | "exported" | "failed">("idle");
  const exportErrorRef = useRef<string | null>(null);

  useEffect(() => {
    nvidiaBenchmarkService.onExport = async (aggregate, samples) => {
      const api = (window as unknown as { screenlink?: {
        nvidiaSaveBenchmarkResult: (record: SavedBenchmarkRecord) => Promise<SavedBenchmarkResult>;
        nvidiaExportBenchmarkResult: (resultId: string) => Promise<string | null>;
        nvidiaOpenBenchmarkFolder: () => Promise<boolean>;
      } }).screenlink;
      const record: SavedBenchmarkRecord = {
        id: crypto.randomUUID(),
        config: {
          processingMode: "vsr",
          qualityLevel: (aggregate.recommendedSettings?.nvidiaQuality as SavedBenchmarkRecord["config"]["qualityLevel"] | undefined) ?? "high",
          inputWidth: aggregate.environment?.nativeOutputWidth ? Math.max(1, Math.floor(aggregate.environment.nativeOutputWidth / 2)) : 1280,
          inputHeight: aggregate.environment?.nativeOutputHeight ? Math.max(1, Math.floor(aggregate.environment.nativeOutputHeight / 2)) : 720,
          frames: samples.reduce((sum, sample) => sum + sample.framesCollected, 0),
        },
        status: aggregate.scenarios.every((scenario) => !scenario.timedOut) ? "completed" : "failed",
        startedAt: Date.now() - aggregate.totalDurationMs,
        completedAt: Date.now(),
        framesProcessed: samples.reduce((sum, sample) => sum + sample.framesCollected, 0),
        framesDropped: samples.reduce((sum, sample) => sum + sample.framesDropped, 0),
        framesFailed: samples.filter((sample) => sample.timedOut).length,
        avgProcessingTimeMs: aggregate.bestLatency?.avgMs ?? 0,
        minProcessingTimeMs: Math.min(...samples.map((sample) => sample.p50ProcessingTimeMs ?? Infinity).filter(Number.isFinite), 0),
        maxProcessingTimeMs: Math.max(...samples.map((sample) => sample.p95ProcessingTimeMs ?? 0), 0),
        p50ProcessingTimeMs: aggregate.bestLatency?.avgMs ?? 0,
        p95ProcessingTimeMs: Math.max(...samples.map((sample) => sample.p95ProcessingTimeMs ?? 0), 0),
        p99ProcessingTimeMs: Math.max(...samples.map((sample) => sample.p95ProcessingTimeMs ?? 0), 0),
        avgFps: Math.max(...samples.map((sample) => sample.achievedFps ?? 0), 0),
        avgNativeInputReceiveMs: aggregate.nativeBenchmarks[0]?.avgInputReceiveUs ? aggregate.nativeBenchmarks[0].avgInputReceiveUs / 1000 : undefined,
        avgNativeUploadMs: aggregate.nativeBenchmarks[0]?.avgUploadUs ? aggregate.nativeBenchmarks[0].avgUploadUs / 1000 : undefined,
        avgNativeEffectMs: aggregate.nativeBenchmarks[0]?.avgEffectUs ? aggregate.nativeBenchmarks[0].avgEffectUs / 1000 : undefined,
        avgNativeDownloadMs: aggregate.nativeBenchmarks[0]?.avgDownloadUs ? aggregate.nativeBenchmarks[0].avgDownloadUs / 1000 : undefined,
      };

      try {
        setExportState("saving");
        exportErrorRef.current = null;

        if (api?.nvidiaSaveBenchmarkResult) {
          const save = await api.nvidiaSaveBenchmarkResult(record);
          if (!save?.success) {
            exportErrorRef.current = save?.error ?? "Save failed";
            setExportState("failed");
            console.error("[benchmark] Save failed:", save?.error);
            return;
          }
          setExportState("saved");

          if (save.id && api.nvidiaExportBenchmarkResult) {
            setExportState("exporting");
            const exportPath = await api.nvidiaExportBenchmarkResult(save.id);
            if (!exportPath) {
              exportErrorRef.current = "Export returned no path";
              console.error("[benchmark] Export failed: no path returned");
            }
          }
        }

        setExportState("exported");
        await api?.nvidiaOpenBenchmarkFolder?.();
      } catch (err) {
        exportErrorRef.current = err instanceof Error ? err.message : "Export error";
        setExportState("failed");
        console.error("[benchmark] Export error:", err);
      }
    };
    return () => {
      nvidiaBenchmarkService.onExport = null;
    };
  }, []);

  /** Cancel the running benchmark. */
  const handleCancelBenchmark = useCallback(() => {
    nvidiaBenchmarkService.cancel();
  }, []);

  /**
   * Apply the benchmark's recommended settings to the enhancement pipeline.
   * Called when the user clicks "Apply Recommended" in the results card.
   */
  const handleApplyBenchmarkRecommendation = useCallback(() => {
    const aggregate = nvidiaBenchmarkService.aggregate;
    if (aggregate?.recommendedSettings) {
      handleEnhancementChange(aggregate.recommendedSettings);
    }
  }, [handleEnhancementChange]);

  /**
   * Restore original enhancement settings after a benchmark reaches a
   * terminal state (completed / cancelled / failed).
   */
  const handleRestoreBenchmarkSettings = useCallback(() => {
    if (benchmarkProgress.state === "completed" ||
        benchmarkProgress.state === "cancelled" ||
        benchmarkProgress.state === "failed") {
      const restored = nvidiaBenchmarkService.buildRestoredSettings();
      if (restored) {
        handleEnhancementChange(restored);
      }
    }
  }, [benchmarkProgress.state, handleEnhancementChange]);

  // Restore settings when benchmark reaches a terminal state
  useEffect(() => {
    handleRestoreBenchmarkSettings();
  }, [handleRestoreBenchmarkSettings]);

  // Cancel benchmark on unmount
  useEffect(() => {
    return () => {
      if (nvidiaBenchmarkService.running) {
        nvidiaBenchmarkService.cancel();
      }
    };
  }, []);

  // ── Audio boost pipeline (Web Audio API GainNode) ────────────────
  // HTMLMediaElement.volume is spec-capped at [0, 1]. For boost >100% we use a
  // GainNode. The pipeline is created ON DEMAND from user-gesture handlers so
  // AudioContext starts in "running" state.
  //
  // IMPORTANT: NEVER initialise AudioContext from a useEffect — an AudioContext
  // created outside a user gesture is suspended and produces no output. Once the
  // gain-node ref is set, the native path is dead (video.volume = 0), so a
  // suspended AudioContext = permanent silence.

  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;

  /**
   * Initialise or resume the Web Audio boost pipeline.
   * Must only be called from a user-gesture handler (pointer / keyboard event)
   * so AudioContext starts in "running" state.
   * Safe to call repeatedly — no-op once the gain node exists and context is running.
   *
   * @param targetVolume — optional initial gain to set (avoids stale-ref issue
   *                       when called before the re-render that updates refs).
   */
  const ensureAudioBoost = useCallback(async (targetVolume?: number): Promise<boolean> => {
    if (gainNodeRef.current) {
      // Already initialised — resume if suspended
      if ((audioCtxRef.current?.state as AudioContextState) !== "suspended") return true;
      try { await audioCtxRef.current?.resume(); } catch {}
      return (audioCtxRef.current?.state as AudioContextState) !== "suspended";
    }

    const video = videoRef.current;
    if (!video) return false;

    // Need a MediaStream to create a MediaStreamAudioSourceNode.
    // The stream must already be attached (user is watching before they can
    // adjust volume past 100%).
    const stream = video.srcObject;
    if (!stream || !(stream instanceof MediaStream)) return false;

    try {
      const ctx = new AudioContext();

      // createMediaStreamSource reads audio directly from the WebRTC
      // MediaStream, bypassing the video element's internal audio pipeline.
      // This is the correct API for srcObject-based streams and works
      // reliably in Chromium.
      const source = ctx.createMediaStreamSource(stream);

      const gain = ctx.createGain();
      const vol = targetVolume ?? volumeRef.current;
      gain.gain.value = isMutedRef.current ? 0 : vol;
      source.connect(gain);
      gain.connect(ctx.destination);

      audioCtxRef.current = ctx;
      gainNodeRef.current = gain;

      // Silence the native video element output.
      // createMediaStreamSource reads the raw MediaStream, not the element's
      // output, so the element's own audio path would produce double audio
      // if left unmuted. Use both volume=0 and muted=true for certainty.
      video.volume = 0;
      video.muted = true;

      // During a user gesture the context starts running synchronously.
      if ((ctx.state as AudioContextState) !== "suspended") return true;

      // Suspended — attempt resume (should succeed during user gesture).
      try { await ctx.resume(); } catch {}

      if ((ctx.state as AudioContextState) !== "suspended") return true;

      // Still suspended — roll back to native path.
      audioCtxRef.current = null;
      gainNodeRef.current = null;
      ctx.close().catch(() => {});
      // Restore native mute state (will be re-applied by sync effect on next render)
      video.muted = isMutedRef.current;
      return false;
    } catch {
      // On failure, restore native path state
      if (gainNodeRef.current) {
        gainNodeRef.current = null;
        audioCtxRef.current = null;
      }
      if (video) {
        video.muted = isMutedRef.current;
      }
      return false;
    }
  }, []);

  /**
   * User-gesture-safe volume change handler.
   * Wraps setVolume and initialises the boost pipeline when volume first exceeds 1.
   * This runs inside a user gesture (slider drag / keyboard), so AudioContext
   * starts in "running" state.
   */
  const handleVolumeChange = useCallback((newVolume: number) => {
    setVolume(newVolume);
    if (newVolume > 1 && !gainNodeRef.current) {
      // Fire-and-forget: if init fails, native path clamps to 1 as fallback.
      ensureAudioBoost(newVolume);
    }
  }, []);

  /**
   * User-gesture-safe mute toggle.
   * Initialises boost pipeline when unmuting with volume > 1.
   */
  const handleToggleMute = useCallback(() => {
    setIsMuted((m) => !m);
    // If currently muted (will become unmuted) and volume > 1, init boost.
    // Click/keyboard is a user gesture — AudioContext starts running.
    if (isMutedRef.current && volumeRef.current > 1 && !gainNodeRef.current) {
      ensureAudioBoost(volumeRef.current);
    }
  }, []);

  // Listen for viewer keyboard shortcut events
  useEffect(() => {
    const handleTogglePause = () => {
      // Guard: only toggle when in a toggleable state
      if (streamPauseState === "paused") {
        void handleResumeStream();
      } else if (streamPauseState === "playing") {
        void handlePauseStream();
      }
      // ignore pausing/resuming — operation already in flight
    };
    const handleCompareToggleEvent = () => handleCompareToggleWithSettingsB();
    const handleCompareModeEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === "side-a" || detail === "side-b" || detail === "vertical-wipe") {
        setIsCompareActive(true);
      }
    };
    const handleCompareExitEvent = () => setIsCompareActive(false);
    const handleCompareOpenSettingsBEvent = () => handleOpenCompareSettingsB();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        handleToggleFullscreen();
      }
    };
    // Panel toggle handlers
    const handleToggleSettings = () => {
      setActivePanel((prev) => (prev === "settings" ? null : "settings"));
    };
    const handleToggleInfo = () => {
      setActivePanel((prev) => (prev === "diagnostics" ? null : "diagnostics"));
    };
    const handlePanelEscape = () => {
      setActivePanel((prev) => {
        if (prev !== null) return null;
        return prev;
      });
    };

    window.addEventListener("screenlink:viewer-toggle-mute", handleToggleMute);
    window.addEventListener("screenlink:viewer-toggle-pause", handleTogglePause);
    window.addEventListener("screenlink:viewer-toggle-settings", handleToggleSettings);
    window.addEventListener("screenlink:viewer-toggle-info", handleToggleInfo);
    window.addEventListener("screenlink:viewer-escape", handlePanelEscape);
    window.addEventListener("screenlink:compare-toggle", handleCompareToggleEvent);
    window.addEventListener("screenlink:compare-mode", handleCompareModeEvent);
    window.addEventListener("screenlink:compare-exit", handleCompareExitEvent);
    window.addEventListener("screenlink:compare-open-settings-b", handleCompareOpenSettingsBEvent);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("screenlink:viewer-toggle-mute", handleToggleMute);
      window.removeEventListener("screenlink:viewer-toggle-pause", handleTogglePause);
      window.removeEventListener("screenlink:viewer-toggle-settings", handleToggleSettings);
      window.removeEventListener("screenlink:viewer-toggle-info", handleToggleInfo);
      window.removeEventListener("screenlink:viewer-escape", handlePanelEscape);
      window.removeEventListener("screenlink:compare-toggle", handleCompareToggleEvent);
      window.removeEventListener("screenlink:compare-mode", handleCompareModeEvent);
      window.removeEventListener("screenlink:compare-exit", handleCompareExitEvent);
      window.removeEventListener("screenlink:compare-open-settings-b", handleCompareOpenSettingsBEvent);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleOpenCompareSettingsB, handleToggleFullscreen, handleToggleMute, isFullscreen, streamPauseState]);

  // Sync volume — routes to gain node when active, native path otherwise.
  // NOTE: This effect NEVER creates AudioContext. Boost is created by
  // ensureAudioBoost() called from user-gesture handlers only.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const actualVolume = isMuted ? 0 : volume;

    if (gainNodeRef.current) {
      // Boost mode: gain node controls volume, native path stays silenced.
      // Defensively re-silence the native path — stream reconnection can
      // reset the element's muted/volume state, causing double audio.
      gainNodeRef.current.gain.value = actualVolume;
      video.volume = 0;
      video.muted = true;
      return;
    }

    // Normal mode: spec-safe [0, 1] range
    video.volume = Math.min(1, actualVolume);
    video.muted = isMuted;
  }, [volume, isMuted, sessionState]);

  // Tear down boost on unmount
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
        gainNodeRef.current = null;
      }
    };
  }, []);

  // Persist volume to localStorage
  useEffect(() => {
    try { localStorage.setItem("screenlink:viewer-volume", String(volume)); } catch {}
  }, [volume]);

  // Persist mute state to localStorage
  useEffect(() => {
    try { localStorage.setItem("screenlink:viewer-muted", String(isMuted)); } catch {}
  }, [isMuted]);

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

  // ── Reset enhancement fallback/active state when re-enabled ──────────
  useEffect(() => {
    setEnhancementActive(false);
    if (enhancementSettings.enabled) {
      setEnhancementFallback(false);
    }
  }, [enhancementSettings.enabled]);

  // Persist image enhancement settings to localStorage
  useEffect(() => {
    try {
      saveImageEnhancementSettings(enhancementSettings);
    } catch { /* ignore */ }
  }, [enhancementSettings]);

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
    const runtime = getRuntime();
    let target = watchingTarget;

    // Fallback: when watchingTarget is null (e.g. during a stream-end
    // transition) but the ViewerSession is still alive with valid
    // identifiers, reconstruct the target from session data so the
    // quality request can still be sent.
    if (!target && sessionRef.current) {
      const sessionInfo = sessionRef.current.getTargetInfo();
      if (sessionInfo) {
        target = {
          groupId: sessionInfo.groupId,
          logicalStreamId: sessionInfo.logicalStreamId,
          mediaSessionId: sessionInfo.mediaSessionId,
          hostDeviceId: sessionInfo.hostDeviceId,
          hostName: sessionInfo.hostName,
          startedAt: Date.now(),
        };
      }
    }

    const dispatchError = getViewerQualityDispatchError(runtime, target);
    if (dispatchError || !runtime || !target) {
      setQualityFeedback(dispatchError);
      setLastQualityAccepted(false);
      return;
    }

    const prevRequest = viewerRequest;
    setViewerRequest(newRequest);
    setQualityRequestPending(true);
    setQualityFeedback(null);

    try {
      const groupId = target.groupId;
      const logicalStreamId = target.logicalStreamId;

      // Get connection manager and connection
      const connManager = runtime.getConnectionManager();
      const conn = connManager.getConnection(groupId);
      if (!conn) {
        setQualityFeedback("Not connected to group");
        setLastQualityAccepted(false);
        setQualityRequestPending(false);
        return;
      }
      const hostPeerUuid = conn.peerForDevice(target.hostDeviceId);

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
      // Use the viewer's actual degradation preference; do not hardcode "balanced".
      // When no explicit preference exists and dimensions are specified, default
      // to "maintain-resolution" to preserve the selected output quality.
      const effectiveDegradation = newRequest.degradationPreference
        ?? (newRequest.maxWidth || newRequest.maxHeight ? "maintain-resolution" : "balanced");
      const payload = {
        type: "quality.viewer.request" as const,
        streamSessionId: logicalStreamId,
        requestId,
        revision: Date.now(),
        videoBitrateKbps: newRequest.videoBitrateKbps,
        maxWidth: newRequest.maxWidth,
        maxHeight: newRequest.maxHeight,
        maxFps: newRequest.maxFps,
        degradationPreference: effectiveDegradation,
      };

      if (hostPeerUuid) {
        await conn.sendToPeer(hostPeerUuid, payload);
      } else {
        await conn.broadcast(payload);
      }

      // Accept optimistically — real feedback comes via quality.effective messages
      const reqByteRate = fmtKbps(newRequest.videoBitrateKbps);
      setQualityFeedback(`Requested ${reqByteRate}, ${newRequest.maxWidth}×${newRequest.maxHeight} @ ${newRequest.maxFps}fps — awaiting host response`);
      setLastQualityAccepted(undefined);
      if (viewerHistoryIdRef.current) {
        StreamMetricsService.getInstance().addMarker(
          viewerHistoryIdRef.current, "preset", null,
          `${newRequest.videoBitrateKbps}kbps ${newRequest.maxWidth}×${newRequest.maxHeight}`,
          `Quality request: ${reqByteRate}`
        );
      }
    } catch (err) {
      setViewerRequest(prevRequest);
      setQualityFeedback(`Failed to send quality request: ${err instanceof Error ? err.message : String(err)}`);
      setLastQualityAccepted(false);
    } finally {
      setQualityRequestPending(false);
    }
  }, [viewerRequest, watchingTarget]);

  // ── Auto-send stored quality request when session starts watching ──
  // When the user joins a new stream, the stored viewerRequest from a
  // previous session is restored from localStorage but never dispatched
  // to the new host. This effect sends it once when media connects.
  useEffect(() => {
    if (
      sessionState === "watching" &&
      viewerRequest &&
      !viewerRequestAutoSentRef.current
    ) {
      viewerRequestAutoSentRef.current = true;
      handleQualityRequestChange(viewerRequest);
    }
  }, [sessionState, viewerRequest, handleQualityRequestChange]);

  // ── Listen for incoming quality feedback (after currentStream is declared) ──
  useEffect(() => {
    const handleQualityEffective = (event: CustomEvent) => {
      const detail = event.detail ?? {};
      const streamSessionId = detail.streamSessionId;
      const watchedLogicalStreamId = resolveViewerQualityFeedbackStreamId({
        watchingTargetLogicalStreamId: watchingTarget?.logicalStreamId,
        currentStreamLogicalStreamId: currentStream?.logicalStreamId,
      });
      if (!streamSessionId || !watchedLogicalStreamId) return;
      if (streamSessionId !== watchedLogicalStreamId) return;

      const kbps = detail.videoBitrateKbps;
      const clampReasons: string[] = detail.clampReasons ?? [];

      if (kbps) setEffectiveBitrateKbps(kbps);

      if (clampReasons.length > 0) {
        setQualityFeedback(`Accepted, capped: ${clampReasons.join("; ")}`);
        setLastQualityAccepted(true);
      } else {
        setQualityFeedback(`Accepted at ${fmtKbps(kbps)}`);
        setLastQualityAccepted(true);
      }
    };

    const handleQualityConfigured = (event: CustomEvent) => {
      const detail = event.detail ?? {};
      const streamSessionId = detail.streamSessionId;
      const watchedLogicalStreamId = resolveViewerQualityFeedbackStreamId({
        watchingTargetLogicalStreamId: watchingTarget?.logicalStreamId,
        currentStreamLogicalStreamId: currentStream?.logicalStreamId,
      });
      if (!streamSessionId || !watchedLogicalStreamId) return;
      if (streamSessionId !== watchedLogicalStreamId) return;

      const kbps = detail.videoBitrateKbps;
      const fps = detail.maxFramerate;
      const scale = detail.scaleResolutionDownBy;

      if (kbps) setConfiguredBitrateBps(kbps * 1000);

      const parts: string[] = [];
      if (kbps) parts.push(fmtKbps(kbps));
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
  }, [watchingTarget?.logicalStreamId, currentStream?.logicalStreamId]);

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
    let cancelled = false;
    let ownedSession: ViewerSession | null = null;

    void startViewerSession((session) => {
      ownedSession = session;
    }, () => cancelled);

    return () => {
      cancelled = true;
      startAttemptRef.current++;
      const session = ownedSession;
      ownedSession = null;

      if (sessionRef.current === session) {
        sessionRef.current = null;
      }

      if (session) {
        void queueViewerLifecycle(() => session.destroy());
      }
    };
  }, [isViewing, startViewerSession]);

  // ── Detect exact watched stream stop using explicit target — do NOT eject on other streams ──
  useEffect(() => {
    if (!isViewing || !watchingTarget || !sessionRef.current) return;

    const exactLogicalStreamId = watchingTarget.logicalStreamId;
    const exactMediaSessionId = watchingTarget.mediaSessionId;
    if (!exactLogicalStreamId) return;

    let endTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = useStore.subscribe((state, prevState) => {
      if (!sessionRef.current) return;

      // Don't treat stream as "gone" during the initial connection flow
      // or while the user has intentionally paused.
      // The join flow starts before the stream is announced in activeStreamsByGroup,
      // so the stream won't exist there until the host accepts the join and the
      // stream.started message arrives.  Without this guard, any unrelated store
      // update during the join window incorrectly destroys the session and cancels
      // the pending join response.
      // While paused, the media connection is intentionally stopped; the stream
      // may be removed from activeStreamsByGroup by a stream.restarted event
      // that we want to handle at resume time, not by destroying the session.
      if (sessionRef.current.state !== "watching") return;
      if (sessionRef.current.pauseState === "paused") return;

      // 1) Check if our exact logical stream disappeared from active streams
      if (selectedGroupId) {
        const currStreams = state.activeStreamsByGroup[selectedGroupId] ?? [];
        const stillExists = currStreams.some(
          (s) => s.logicalStreamId === exactLogicalStreamId && s.mediaSessionId === exactMediaSessionId
        );
        if (!stillExists) {
          const session = sessionRef.current;
          // Our stream is gone — destroy session and show ended
          startAttemptRef.current++;
          if (sessionRef.current === session) {
            sessionRef.current = null;
          }
          if (session) {
            void queueViewerLifecycle(() => session.destroy());
          }
          setSessionState("ended");
          setViewerError(null);
          setViewStatus("ended");
          setActivePanel(null);

          // Finalize viewer session
          if (viewerHistoryIdRef.current) {
            const id = viewerHistoryIdRef.current;
            viewerHistoryIdRef.current = null;
            setViewerHistoryId(null);
            StreamMetricsService.getInstance().finalizeSession(id).catch(() => {});
          }

          // Auto-navigate to overview after short delay
          if (endTimer) clearTimeout(endTimer);
          endTimer = setTimeout(() => {
            useStore.getState().setIsViewing(false);
            navigateToGroupOverview();
          }, 4000);
          return;
        }
      }

      // 2) Check if watched session removed from watchedStreamsBySessionId
      const prevWatched = prevState.watchedStreamsBySessionId;
      const currWatched = state.watchedStreamsBySessionId;
      if (exactMediaSessionId && prevWatched[exactMediaSessionId] && !currWatched[exactMediaSessionId]) {
        const session = sessionRef.current;
        startAttemptRef.current++;
        if (sessionRef.current === session) {
          sessionRef.current = null;
        }
        if (session) {
          void queueViewerLifecycle(() => session.destroy());
        }
        setSessionState("ended");
        setViewerError(null);
        setViewStatus("ended");
        setActivePanel(null);

        // Finalize viewer session
        if (viewerHistoryIdRef.current) {
          const id = viewerHistoryIdRef.current;
          viewerHistoryIdRef.current = null;
          setViewerHistoryId(null);
          StreamMetricsService.getInstance().finalizeSession(id).catch(() => {});
        }

          if (endTimer) clearTimeout(endTimer);
        endTimer = setTimeout(() => {
          useStore.getState().setIsViewing(false);
          navigateToGroupOverview();
        }, 4000);
      }
    });

    return () => {
      unsubscribe();
      if (endTimer) clearTimeout(endTimer);
    };
  }, [isViewing, selectedGroupId, setViewStatus, watchingTarget?.logicalStreamId, watchingTarget?.mediaSessionId]);

  // ── Derive display status from session state ─────────────────────
  const displayStatus = sessionStateToViewStatus(sessionState);

  // ── Render by view status (Section 15) ───────────────────────────

  // Terminal states that don't need a video element

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
  const isFatalError = displayStatus === "error";
  if (isFatalError) {
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
                {viewerError && (
                  <span className="block mt-2 text-xs opacity-70">
                    {viewerError}
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

  // ── Unified viewer stage: connecting / reconnecting / degraded / watching ──
  // One persistent <video> element stays mounted across all these states.
  // Status UI is rendered as conditional overlays on top of the video stage.

  return (
    <ViewerShell className={className} onExit={handleExit}>
      <motion.div
        key="viewer-stage"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={reduced ? fadeInstant : fadeSpring}
        className="flex flex-col h-full"
        {...(displayStatus === "watching" ? {
          onMouseMove: showControls,
          onMouseEnter: showControls,
          onMouseLeave: hideControls,
        } : {})}
      >
        {/* ── Video stage ──────────────────────────────────────────── */}
        <div className="relative flex-1 flex items-center justify-center bg-black">
          {/* ── Raw source video — persistent across all states ── */}
          <video
            ref={videoRefCallback}
            data-video-native
            className={cn(
              "h-full object-contain absolute inset-0",
              // In compare mode: hide raw video, CompareViewerSurface layers on top
              isCompareActive && "invisible",
              // Non-compare mode visibility rules:
              !isCompareActive && streamPauseState === "paused" && "opacity-30",
              // Only hide raw video when enhanced output is actually active/ready
              !isCompareActive && enhancementActive && !enhancementFallback && enhancementSettings.enabled && streamPauseState === "playing" && "invisible",
            )}
            playsInline
            autoPlay
            aria-label={`${sharerName}'s stream - ${sourceName}`}
            onContextMenu={(e) => {
              e.preventDefault();
              handleToggleFullscreen();
            }}
          />

          {/* ▸ Connecting overlay — skeleton + status text */}
          {displayStatus === "connecting" && (
            <motion.div
              key="connecting-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduced ? fadeInstant : fadeSpring}
              className="absolute inset-0 z-10 flex items-center justify-center bg-surface-2/80"
              role="status"
              aria-label="Connecting to stream"
            >
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
            </motion.div>
          )}

          {/* ▸ Reconnecting overlay — amber alert + progress */}
          {displayStatus === "reconnecting" && (
            <motion.div
              key="reconnecting-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduced ? fadeInstant : fadeSpring}
              className="absolute top-4 left-4 right-4 z-20"
            >
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
            </motion.div>
          )}

          {/* ▸ Degraded overlay — amber alert */}
          {displayStatus === "degraded" && (
            <motion.div
              key="degraded-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduced ? fadeInstant : fadeSpring}
              className="absolute top-4 left-4 right-4 z-20"
            >
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
            </motion.div>
          )}

          {/* ── Compare / Enhancement / Paused overlays ── */}
          {isCompareActive ? (
            <div className="absolute inset-0 z-10">
              <CompareViewerSurface
                videoElement={videoRef.current}
                settingsA={enhancementSettings}
                settingsB={settingsB}
                onExit={handleCompareExit}
                paused={streamPauseState === "paused"}
                onTogglePause={handleToggleStreamPause}
                onStatsUpdateA={handleEnhancementStatsUpdate}
                onStatsUpdateB={handleEnhancementStatsUpdateB}
                processorApiRefA={processorApiRef}
                processorApiRefB={processorApiRefB}
              />
            </div>
          ) : (
            <>
              {/* ── GPU-enhanced display surface ────────────────────── */}
              <EnhancedVideoSurface
                videoElement={videoRef.current}
                enabled={!enhancementFallback && enhancementSettings.enabled}
                settings={enhancementSettings}
                onProcessorStateChange={handleEnhancementProcessorStateChange}
                onProcessingError={handleEnhancementProcessingError}
                onContextRestored={handleEnhancementContextRestored}
                onFirstFrame={handleEnhancementFirstFrame}
                onStatsUpdate={handleEnhancementStatsUpdate}
                processorApiRef={processorApiRef}
                onContextMenu={(e) => { e.preventDefault(); handleToggleFullscreen(); }}
              />

              {/* ── Paused overlay ── */}
              {(streamPauseState === "paused" || streamPauseState === "resuming") && (
                <div
                  className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/40"
                  aria-label={streamPauseState === "paused" ? "Stream paused" : "Resuming stream"}
                  role="status"
                >
                  {streamPausePoster && (
                    <div className="absolute inset-0 bg-cover bg-center opacity-60" style={{ backgroundImage: `url(${streamPausePoster})` }} />
                  )}
                  <div className="relative z-10 flex flex-col items-center gap-3 pointer-events-none">
                    {streamPauseState === "paused" ? (
                      <>
                        <div className="h-16 w-16 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
                          <Play className="h-8 w-8 text-white" />
                        </div>
                        <p className="text-sm text-white/80 font-medium">
                          Paused — Press <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-xs font-mono">Space</kbd> to resume
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="h-12 w-12 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
                          <RefreshCw className="h-6 w-6 text-white animate-spin" />
                        </div>
                        <p className="text-sm text-white/80 font-medium">Resuming stream...</p>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          </div> {/* ── End video stage ── */}

          {/* ▸ Compare settings B modal */}
          {isCompareActive && compareSettingsBOpen && (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 px-4"
              onClick={handleCloseCompareSettingsB}
            >
              <div
                className="w-full max-w-4xl rounded-2xl border border-accent/30 bg-surface/95 p-4 shadow-2xl backdrop-blur-md"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-text-primary">Comparison Configuration B</div>
                    <div className="text-xs text-text-secondary">Viewer-local settings for the second processing path.</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={handleCompareSettingsBReset}>Reset B</Button>
                    <Button variant="ghost" size="sm" onClick={handleCloseCompareSettingsB}>Close</Button>
                  </div>
                </div>
                <ViewerSettingsPanel
                  requestState={viewerRequest}
                  onRequestChange={handleQualityRequestChange}
                  requestPending={qualityRequestPending}
                  lastRequestAccepted={lastQualityAccepted}
                  requestFeedback={qualityFeedback}
                  enhancementSettings={settingsB}
                  onEnhancementChange={setSettingsB}
                  onEnhancementReset={handleCompareSettingsBReset}
                  enhancementStats={enhancementStatsB}
                  hideQuality
                  contentOnly
                  variant="B"
                  benchmarkRunning={false}
                >
                  <span />
                </ViewerSettingsPanel>
              </div>
            </div>
          )}

          {/* ▸ Top-left exit button — fades with controls when watching, always visible otherwise */}
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{
              opacity: displayStatus === "watching" ? (controlsVisible ? 1 : 0) : 1,
              x: displayStatus === "watching" ? (controlsVisible ? 0 : -10) : 0,
            }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="absolute top-3 left-3 z-30"
          >
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 bg-black/60 backdrop-blur-sm border-white/10 text-white/80 hover:text-white hover:bg-white/10"
              onClick={handleExit}
              aria-label="Exit viewer"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="text-xs">Exit</span>
            </Button>
          </motion.div>

          {/* ▸ Controls and panels — shown whenever not connecting */}
          {displayStatus !== "connecting" && (
            <ViewerPanelShell
              activePanel={activePanel}
              onActivePanelChange={setActivePanel}
              session={sessionRef.current}
              lastRequestedQuality={lastRequestedQuality}
              effectiveBitrateKbps={effectiveBitrateKbps}
              configuredBitrateBps={configuredBitrateBps}
              requestState={viewerRequest}
              onRequestChange={handleQualityRequestChange}
              requestPending={qualityRequestPending}
              lastRequestAccepted={lastQualityAccepted}
              requestFeedback={qualityFeedback}
              enhancementSettings={enhancementSettings}
              onEnhancementChange={handleEnhancementChange}
              onEnhancementReset={handleEnhancementReset}
              enhancementStats={enhancementStats}
              mediaSessionId={watchedSessionId}
              viewerHistoryId={viewerHistoryId}
              benchmarkRunning={nvidiaBenchmarkService.running}
              benchmarkProgress={benchmarkProgress}
              onRunBenchmark={handleRunBenchmark}
              onCancelBenchmark={handleCancelBenchmark}
              onApplyBenchmarkRecommendation={handleApplyBenchmarkRecommendation}
            >
              <VideoControlsOverlay
                isPaused={isPaused}
                onTogglePlay={() => setIsPaused((p) => !p)}
                isStreamPaused={streamPauseState === "paused"}
                isStreamPauseTransitioning={streamPauseTransitioning}
                onToggleStreamPause={handleToggleStreamPause}
                volume={volume}
                isMuted={isMuted}
                onVolumeChange={handleVolumeChange}
                onToggleMute={handleToggleMute}
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
                isScreenLinkDeafened={isScreenLinkDeafened}
                onToggleScreenLinkDeafen={handleToggleScreenLinkDeafen}
                currentBandwidthBps={currentBandwidthBps}
                totalBytesReceived={totalBytesReceived}
                activeDurationMs={activeDurationMs}
                discordMuteBinding={discordMuteBinding}
                discordDeafenBinding={discordDeafenBinding}
                syncScreenLinkDeafen={syncScreenLinkDeafen}
                maxVolumePercent={maxVolumePercent}
                activePanel={activePanel}
                onActivePanelChange={setActivePanel}
                onCompareToggle={handleCompareToggleWithSettingsB}
              />
            </ViewerPanelShell>
          )}
      </motion.div>
    </ViewerShell>
  );
}

// ─── Viewer shell ──────────────────────────────────────────────────────────

/**
 * ViewerShell — Minimal wrapper around viewer content.
 */
function ViewerShell({
  children,
  className,
  onExit: _onExit,
}: {
  children: React.ReactNode;
  className?: string;
  onExit: () => void;
}) {
  return (
    <div className={cn("flex flex-col h-full bg-canvas", className)}>
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
  isStreamPaused,
  isStreamPauseTransitioning,
  onToggleStreamPause,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  currentStreamId,
  onStreamSwitch,
  connectionState,
  isFullscreen,
  onToggleFullscreen,
  onExit,
  controlsVisible,
  showControls,
  isLive,
  isScreenLinkDeafened,
  onToggleScreenLinkDeafen,
  currentBandwidthBps,
  totalBytesReceived,
  activeDurationMs,
  discordMuteBinding,
  discordDeafenBinding,
  syncScreenLinkDeafen,
  maxVolumePercent,
  activePanel,
  onActivePanelChange,
  onCompareToggle,
}: {
  isPaused: boolean;
  onTogglePlay: () => void;
  isStreamPaused?: boolean;
  isStreamPauseTransitioning?: boolean;
  onToggleStreamPause?: () => void;
  volume: number;
  isMuted: boolean;
  onVolumeChange: (v: number) => void;
  onToggleMute: () => void;
  currentStreamId: string;
  onStreamSwitch: (stream: StreamAnnouncement) => void;
  connectionState: "connecting" | "connected" | "degraded" | "reconnecting" | "ended" | "error";
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onExit: () => void;
  controlsVisible: boolean;
  showControls: () => void;
  isLive: boolean;
  isScreenLinkDeafened?: boolean;
  onToggleScreenLinkDeafen?: () => void;
  currentBandwidthBps?: number;
  totalBytesReceived?: number;
  activeDurationMs?: number;
  discordMuteBinding?: ShortcutBinding;
  discordDeafenBinding?: ShortcutBinding;
  syncScreenLinkDeafen?: boolean;
  maxVolumePercent?: number;
  activePanel: ActivePanel | null;
  onActivePanelChange: (panel: ActivePanel | null) => void;
  onCompareToggle?: () => void;
}) {
  return (
    <VideoControls
      isPaused={isPaused}
      onTogglePlay={onTogglePlay}
      isStreamPaused={isStreamPaused}
      isStreamPauseTransitioning={isStreamPauseTransitioning}
      onToggleStreamPause={onToggleStreamPause}
      volume={volume}
      isMuted={isMuted}
      onVolumeChange={onVolumeChange}
      onToggleMute={onToggleMute}
      currentStreamId={currentStreamId}
      onStreamSwitch={onStreamSwitch}
      connectionState={connectionState}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
      onExit={onExit}
      visible={controlsVisible}
      isLive={isLive}
      isScreenLinkDeafened={isScreenLinkDeafened}
      onToggleScreenLinkDeafen={onToggleScreenLinkDeafen}
      currentBandwidthBps={currentBandwidthBps}
      totalBytesReceived={totalBytesReceived}
      activeDurationMs={activeDurationMs}
      discordMuteBinding={discordMuteBinding}
      discordDeafenBinding={discordDeafenBinding}
      syncScreenLinkDeafen={syncScreenLinkDeafen}
      maxVolumePercent={maxVolumePercent}
      activePanel={activePanel}
      onActivePanelChange={onActivePanelChange}
      onCompareToggle={onCompareToggle}
    />
  );
}
