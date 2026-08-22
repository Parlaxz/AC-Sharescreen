import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowLeft,
  Maximize,
  RefreshCw,
  Info,
  Play,
} from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useStore } from "@/stores/main-store";
import type { StreamAnnouncement, StreamInfoCardConfig } from "@screenlink/shared";
import { VideoControls, type ShortcutBinding } from "./viewer/VideoControls.js";
import type { FramePerformanceSample } from "./viewer/FramePerformanceGraph.js";
import { StreamMetricsService } from "@/services/stream-metrics-service";
import type { BandwidthSnapshot } from "@/services/bandwidth-telemetry-types";
import { ViewerFrameTiming, type FrameTimingSample } from "@/services/viewer-frame-timing";
import { ViewerPanelShell } from "./viewer/ViewerPanelShell.js";
import type { ActivePanel } from "./viewer/ViewerPanelShell.js";
import { ViewerStatusOverlay, fadeSpring, fadeInstant } from "./viewer/ViewerStatusOverlay.js";
import { ViewerSettingsPanel, type ViewerRequestState, type MediaMode } from "./viewer/ViewerSettingsPanel.js";
import { loadSettings } from "@/services/settings-actions";
import { saveSettings } from "@/services/settings-actions";
import { StreamInfoCard } from "./viewer/StreamInfoCard.js";
import { useStreamDiagnostics } from "@/hooks/use-stream-diagnostics";
import {
  getViewerQualityEffectiveFeedback,
  getViewerQualityDispatchError,
  resolveViewerQualityFeedbackStreamId,
} from "./viewer/viewer-quality-helpers.js";
import { getRuntime } from "@/services/phase3-runtime.js";
import { uiSoundService } from "@/services/ui-sound-service.js";
import { initializeAppRuntime } from "@/services/initialize-app-runtime.js";
import type { PersistedSettings } from "@screenlink/shared";
import type { ScreenLinkAPI } from "../../../preload/api-types.js";
import { navigateToGroupOverview } from "@/services/group-navigation";
import type { ViewerSession, ViewerSessionState, ViewerPauseState } from "@/services/viewer-session.js";
import { useViewerSession } from "@/hooks/use-viewer-session";
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

// ─── Viewer lifecycle is now owned by ViewerSessionController (Phase 4) ──
// The module-level lifecycle queue has been removed.
// Use useViewerSession() hook instead.

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
  if (kbps <= 0) return "0 kbps";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
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

  // ─── Viewer session controller (Phase 4) ─────────────────────────
  const {
    snapshot: vsSnapshot,
    controller,
    start: controllerStart,
    recover: controllerRecover,
    stop: controllerStop,
    refreshTarget: controllerRefreshTarget,
  } = useViewerSession();

  // ─── Store ───────────────────────────────────────────────────────
  const isViewing = useStore((s) => s.isViewing);
  const setIsViewing = useStore((s) => s.setIsViewing);
  const setViewStatus = useStore((s) => s.setViewStatus);
  const toggleFocusMode = useStore((s) => s.toggleFocusMode);
  const navigate = useStore((s) => s.navigate);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
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
  const [mediaMode, setMediaMode] = useState<MediaMode>(() => {
    try {
      const stored = localStorage.getItem("screenlink:viewer-media-mode");
      if (stored === "audio" || stored === "video") return stored;
    } catch { /* ignore */ }
    return "av";
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
  /** The viewer's preferred codec from settings (e.g. "auto", "vp9", "h264") */
  const [requestedCodec, setRequestedCodec] = useState<string | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
  // Phase 4: lifecycle phase/error derived from controller snapshot
  const sessionPhase = vsSnapshot.phase;
  const viewerError = vsSnapshot.error;

  // For backward compatibility with the rest of the component
  const sessionState = sessionPhase === "connecting" ? "connecting"
    : sessionPhase === "watching" ? "watching"
    : sessionPhase === "paused" ? "paused"
    : sessionPhase === "reconnecting" ? "reconnecting"
    : sessionPhase === "ended" ? "ended"
    : sessionPhase === "error" ? "error"
    : "idle";
  // viewerError is now derived — no local setter needed
  const [qualityRequestPending, setQualityRequestPending] = useState(false);
  const [qualityFeedback, setQualityFeedback] = useState<string | null>(null);
  const [lastQualityAccepted, setLastQualityAccepted] = useState<boolean | undefined>(undefined);
  /** Track which popover panel is active (null = closed) */
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  /** Viewer history ID for StreamMetricsService session */
  const [viewerHistoryId, setViewerHistoryId] = useState<string | null>(null);
  const viewerHistoryIdRef = useRef<string | null>(null);

  // ── Pause state (from controller snapshot, Phase 4) ────────────────
  const streamPauseState = vsSnapshot.pause;
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

  // ── Stream info card overlay state ──
  const [showStreamInfoCard, setShowStreamInfoCard] = useState(false);
  const [streamInfoCardConfig, setStreamInfoCardConfig] = useState<StreamInfoCardConfig>({
    visible: false,
    showResolution: true,
    showFps: true,
    showBitrate: true,
    showDroppedFrames: true,
    showNetworkUsage: true,
    position: "top-right",
    fontSize: 12,
    textColor: "#ffffff",
    boxOpacity: 60,
    boxWidth: 200,
  });

  const [maxVolumePercent, setMaxVolumePercent] = useState(200);

  // ── Compare controls visibility (Phase 9, default off) ──
  const [showCompareControls, setShowCompareControls] = useState(false);

  // ── Settings loader (shared between mount and page-change) ──────────────
  const applySettings = useCallback((settings: PersistedSettings) => {
    if (settings.discordMuteShortcut?.key) {
      setDiscordMuteBinding(settings.discordMuteShortcut);
    }
    if (settings.discordDeafenShortcut?.key) {
      setDiscordDeafenBinding(settings.discordDeafenShortcut);
    }
    setSyncScreenLinkDeafen(settings.discordDeafenScreenLink ?? true);
    setMaxVolumePercent(settings.viewerMaxVolumePercent ?? 200);
    setShowCompareControls(settings.showCompareControls ?? false);
    if (settings.streamInfoCard) {
      setShowStreamInfoCard(settings.streamInfoCard.visible ?? false);
      setStreamInfoCardConfig(settings.streamInfoCard);
    }
    // Extract codec preference from global quality defaults
    const codec = settings.globalQualityDefaults?.video?.codec;
    if (codec) {
      setRequestedCodec(codec);
    }
  }, []);

  // Load settings on mount
  useEffect(() => {
    void loadSettings().then(applySettings).catch(() => {
      // keep defaults
    });
  }, [applySettings]);

  // Re-read settings when navigating back to viewer page (e.g. from Settings)
  // so HUD/overlay config, discord bindings, volume cap, etc. are applied
  // without requiring an app restart.
  const currentPage = useStore((s) => s.currentPage);
  const prevPageRef = useRef(currentPage);
  useEffect(() => {
    if (currentPage === "viewer" && prevPageRef.current !== "viewer") {
      void loadSettings().then(applySettings).catch(() => {
        // keep defaults
      });
    }
    prevPageRef.current = currentPage;
  }, [currentPage, applySettings]);

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

  const handleToggleStreamInfoCard = useCallback(async () => {
    const next = !showStreamInfoCard;
    setShowStreamInfoCard(next);
    try {
      await saveSettings({ streamInfoCard: { ...streamInfoCardConfig, visible: next } });
    } catch {
      // best-effort
    }
  }, [showStreamInfoCard, streamInfoCardConfig]);

  // ── Bandwidth tracking ──
  const [currentBandwidthBps, setCurrentBandwidthBps] = useState(0);
  const [totalBytesReceived, setTotalBytesReceived] = useState(0);
  const [activeDurationMs, setActiveDurationMs] = useState(0);
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<BandwidthSnapshot | null>(null);
  const [framePerformanceSamples, setFramePerformanceSamples] = useState<FramePerformanceSample[]>([]);
  const unregisterMetricsRef = useRef<(() => void) | null>(null);
  const metricsSubscriptionRef = useRef<(() => void) | null>(null);
  const frameTimingRef = useRef<ViewerFrameTiming | null>(null);
  const frameTimingUnsubscribeRef = useRef<(() => void) | null>(null);
  const frameFallbackIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameStateRef = useRef<ViewerSessionState>(sessionState);
  const frameBucketRef = useRef<number | null>(null);
  const frameLastUpdateRef = useRef(0);

  if (!frameTimingRef.current) {
    frameTimingRef.current = new ViewerFrameTiming();
  }

  const appendFramePerformanceSample = useCallback((sample: FrameTimingSample) => {
    const now = Date.now();
    // Throttle visible FPS updates to ~2/sec so the display doesn't jitter
    if (now - frameLastUpdateRef.current < 500) return;
    frameLastUpdateRef.current = now;

    const state =
      frameStateRef.current === "paused"
        ? "paused"
        : frameStateRef.current === "reconnecting"
        ? "reconnecting"
        : "playing";
    const point: FramePerformanceSample = {
      timestamp: now,
      displayedFps: sample.displayedFps,
      decodedFps: sample.decodedFps,
      frameIntervalMs: sample.displayedFrameIntervalMs,
      decodeTimeMs: sample.decodeTimeMs,
      state,
    };

    setFramePerformanceSamples((prev) => {
      const next = [...prev];
      const bucket = Math.floor(now / 1000) * 1000;

      if (sample.segmentStart && next.length > 0) {
        next.push({
          timestamp: Math.max(now - 1, 0),
          displayedFps: null,
          decodedFps: null,
          frameIntervalMs: null,
          decodeTimeMs: null,
          state: "paused",
        });
        frameBucketRef.current = null;
      }

      if (frameBucketRef.current === bucket && next.length > 0) {
        next[next.length - 1] = point;
      } else {
        next.push(point);
        frameBucketRef.current = bucket;
      }

      return next.slice(-121);
    });
  }, []);

  const resetFramePerformance = useCallback((gapState?: "paused" | "reconnecting") => {
    frameTimingRef.current?.reset();
    frameBucketRef.current = null;
    setFramePerformanceSamples((prev) => {
      if (!gapState) return [];
      if (prev.length === 0) return prev;
      return [
        ...prev,
        {
          timestamp: Date.now(),
          displayedFps: null,
          decodedFps: null,
          frameIntervalMs: null,
          decodeTimeMs: null,
          state: gapState,
        },
      ].slice(-121);
    });
  }, []);

  useEffect(() => {
    frameStateRef.current = sessionState;
  }, [sessionState]);

  // ViewerSession instance ref — stable across renders
  const sessionRef = useRef<ViewerSession | null>(null);

  // ── Stream diagnostics hook (polls every 2s) ──
  const { snapshot: diagSnapshot, droppedFramesInLast5s } = useStreamDiagnostics(sessionRef.current, {
    lastRequested: lastRequestedQuality,
    effectiveKbps: effectiveBitrateKbps,
    configuredBps: configuredBitrateBps,
  });

  useEffect(() => {
    const frameTiming = frameTimingRef.current;
    if (!frameTiming) return;

    frameTimingUnsubscribeRef.current?.();
    frameTimingUnsubscribeRef.current = frameTiming.onSample(appendFramePerformanceSample);

    return () => {
      frameTimingUnsubscribeRef.current?.();
      frameTimingUnsubscribeRef.current = null;
    };
  }, [appendFramePerformanceSample]);

  useEffect(() => {
    if (!videoRef.current || !viewerHistoryIdRef.current || sessionState === "ended" || sessionState === "error") {
      if (frameFallbackIntervalRef.current) {
        clearInterval(frameFallbackIntervalRef.current);
        frameFallbackIntervalRef.current = null;
      }
      if (sessionState === "ended" || sessionState === "error") {
        frameTimingRef.current?.detach();
        resetFramePerformance();
      }
      return;
    }

    if (frameFallbackIntervalRef.current) {
      clearInterval(frameFallbackIntervalRef.current);
    }

    frameFallbackIntervalRef.current = setInterval(() => {
      frameTimingRef.current?.pollDecodedFallback();
    }, 1000);

    return () => {
      if (frameFallbackIntervalRef.current) {
        clearInterval(frameFallbackIntervalRef.current);
        frameFallbackIntervalRef.current = null;
      }
    };
  }, [sessionState, viewerHistoryId, resetFramePerformance]);

  useEffect(() => {
    if (sessionState === "paused") {
      resetFramePerformance("paused");
    } else if (sessionState === "reconnecting") {
      resetFramePerformance("reconnecting");
    }
  }, [resetFramePerformance, sessionState]);

  useEffect(() => {
    resetFramePerformance();
  }, [resetFramePerformance, viewerHistoryId, watchingTarget?.mediaSessionId]);

  // Poll WebRTC stats for bandwidth
  useEffect(() => {
    // Session ended or errored: full reset
    if (!sessionRef.current || sessionState === "ended" || sessionState === "error") {
      setCurrentBandwidthBps(0);
      setTotalBytesReceived(0);
      setActiveDurationMs(0);
      setDiagnosticsSnapshot(null);
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
          setDiagnosticsSnapshot(snapshot);
        });
        metricsSubscriptionRef.current = unsub;

        // Initial read
        const snapshot = StreamMetricsService.getInstance().getSnapshot(historyId);
        setCurrentBandwidthBps(snapshot.aggregate.currentBitsPerSecond);
        setTotalBytesReceived(snapshot.aggregate.totalBytes);
        setActiveDurationMs(snapshot.aggregate.activeDurationMs);
        setDiagnosticsSnapshot(snapshot);
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
    frameTimingRef.current?.attach(el);
  }, []);

  // Audio boost via Web Audio API GainNode (allows volume > 1.0)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const lastBoostStreamRef = useRef<MediaStream | null>(null);

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
    // Phase 4: controller.stop() serializes teardown.
    await controllerStop();

    // Clear visual stale state (React component state).
    if (nvidiaBenchmarkService.running) {
      nvidiaBenchmarkService.cancel();
    }
    nvidiaBenchmarkService.reset();
    setEnhancementActive(false);
    setEnhancementFallback(false);
    setEnhancementStats(null);
    setStreamPausePoster(null);
    setCurrentStreamId(null);
    setCurrentBandwidthBps(0);
    setTotalBytesReceived(0);
    setDiagnosticsSnapshot(null);
    setQualityFeedback(null);
    setLastQualityAccepted(undefined);
    setLastRequestedQuality(null);
    setEffectiveBitrateKbps(null);
    setConfiguredBitrateBps(null);
    resetFramePerformance();

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
   * Start a viewer session via the controller (Phase 4).
   * Replaces the old startViewerSession that managed ViewerSession directly.
   * Controller owns lifecycle serialization, snapshot, and stream-end detection.
   */
  const startViewerSession = useCallback(async (): Promise<void> => {
    await ensureAppRuntimeInitialized();

    const target = watchingTarget;
    if (!target) {
      return;
    }

    // Use the watchingTarget as StreamTarget
    const streamTarget = {
      groupId: target.groupId,
      logicalStreamId: target.logicalStreamId,
      mediaSessionId: target.mediaSessionId,
      hostDeviceId: target.hostDeviceId,
      hostName: target.hostName,
      startedAt: target.startedAt,
      sourceName: target.sourceName,
      sourceKind: target.sourceKind,
    };

    // Reset enhancement and poster state
    setEnhancementActive(false);
    setStreamPausePoster(null);

    // Start via controller — snapshot subscriptions will propagate state
    await controllerStart(streamTarget, videoRef.current);
  }, [ensureAppRuntimeInitialized, watchingTarget, controllerStart]);

  const handleRetry = useCallback(async () => {
    if (viewerHistoryIdRef.current) {
      StreamMetricsService.getInstance().setSessionState(viewerHistoryIdRef.current, "reconnecting");
    }

    await ensureAppRuntimeInitialized();

    try {
      await controllerRecover();
    } catch (err) {
      // Error is reflected in the controller snapshot
    }
  }, [ensureAppRuntimeInitialized, controllerRecover]);

  // ── Pause/resume callbacks (media op first, marker via setSessionState) ──
  const handlePauseStream = useCallback(async () => {
    await controller.pause().catch(() => {});
  }, [controller]);

  const handleResumeStream = useCallback(async () => {
    await controller.resume().catch(() => {});
  }, [controller]);

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

  // ── Viewer readiness controller (join/leave audio cues) ───────────
  //
  // Sends stream.viewer.ready exactly once per watch attempt, after the
  // first visible frame is presented. The session.sendViewerReady() method
  // has its own one-shot and stale-generation guards.
  //
  // Enhanced path: fires from handleEnhancementReadyFirstFrame when the
  //   GPU pipeline produces its first frame.
  // Native path: fires from requestVideoFrameCallback on the <video>
  //   element when watching and enhancement is not active.
  // Compare mode: each EnhancedVideoSurface fires onFirstFrame, but the
  //   session's _viewerReadySent guard prevents double-ack.

  /** Track the effective presentation type from the enhancement backend */
  const effectivePresentationRef = useRef<"native-video" | "webgl" | "nvidia" | "fallback">("native-video");

  /** One-shot ready-send guard (complements session-level guard) */
  const viewerReadyRef = useRef(false);

  const trySendViewerReady = useCallback((): void => {
    if (viewerReadyRef.current) return;
    const session = sessionRef.current;
    if (!session) return;
    const sent = session.sendViewerReady(effectivePresentationRef.current);
    if (sent) {
      viewerReadyRef.current = true;
    }
  }, []);

  /** Fired by EnhancedVideoSurface on first GPU-rendered frame */
  const handleEnhancementReadyFirstFrame = useCallback(() => {
    setEnhancementActive(true);
    trySendViewerReady();
  }, [trySendViewerReady]);

  /** Tracks effective backend for correct presentation type */
  const handleEnhancementEffectiveBackend = useCallback((effective: string, _fallbackReason?: string) => {
    if (effective === "nvidia-vsr") {
      effectivePresentationRef.current = "nvidia";
    } else if (effective === "webgl2") {
      effectivePresentationRef.current = "webgl";
    } else {
      effectivePresentationRef.current = "fallback";
    }
  }, []);

  /** Arms native video readiness detection when watching + enhancement not active.
   *  Uses requestVideoFrameCallback for precise first-frame detection. */
  useEffect(() => {
    if (sessionState !== "watching") return;
    if (viewerReadyRef.current) return;

    // If enhancement is active and will produce a frame, skip native path
    if (enhancementSettings.enabled && !enhancementFallback) return;

    const video = videoRef.current;
    if (!video) return;

    if (typeof video.requestVideoFrameCallback !== "function") {
      // Fallback: use playing + non-zero dimensions
      const onPlaying = () => {
        if (!video || viewerReadyRef.current || sessionState !== "watching") return;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          effectivePresentationRef.current = "native-video";
          trySendViewerReady();
        }
      };
      video.addEventListener("playing", onPlaying, { once: true });
      return () => video.removeEventListener("playing", onPlaying);
    }

    let cancelled = false;
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (cancelled || viewerReadyRef.current) return;
      // First visible frame: non-zero dimensions + valid metadata
      if (video.videoWidth > 0 && video.videoHeight > 0 &&
          metadata.width > 0 && metadata.height > 0) {
        effectivePresentationRef.current = "native-video";
        trySendViewerReady();
      } else {
        // No valid frame yet — re-arm
        video.requestVideoFrameCallback(onFrame);
      }
    };
    video.requestVideoFrameCallback(onFrame);
    return () => { cancelled = true; };
  }, [sessionState, enhancementSettings.enabled, enhancementFallback, trySendViewerReady]);

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

  // Preload UI sound cues on mount (fire-and-forget — failures are tolerated)
  useEffect(() => {
    void uiSoundService.preload();
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
      const video = videoRef.current;
      const currentStream = video?.srcObject;
      if (currentStream !== lastBoostStreamRef.current) {
        audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        gainNodeRef.current = null;
        lastBoostStreamRef.current = null;
        if (video) video.muted = isMutedRef.current;
      } else {
        if ((audioCtxRef.current?.state as AudioContextState) !== "suspended") return true;
        try { await audioCtxRef.current?.resume(); } catch {}
        return (audioCtxRef.current?.state as AudioContextState) !== "suspended";
      }
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
      lastBoostStreamRef.current = stream;

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
      lastBoostStreamRef.current = null;
      ctx.close().catch(() => {});
      // Restore native mute state (will be re-applied by sync effect on next render)
      video.muted = isMutedRef.current;
      return false;
    } catch {
      // On failure, restore native path state
      if (gainNodeRef.current) {
        gainNodeRef.current = null;
        audioCtxRef.current = null;
        lastBoostStreamRef.current = null;
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

  const handleMediaModeChange = useCallback((mode: MediaMode) => {
    setMediaMode(mode);
    // Send to host if session is active
    const session = sessionRef.current;
    if (session) {
      const audioEnabled = mode !== "video";
      const videoEnabled = mode !== "audio";
      session.setMediaMode(audioEnabled, videoEnabled);
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
    const handleApplyPreset = (e: Event) => {
      const { slot } = (e as CustomEvent).detail as { slot: number };
      const raw = useStore.getState().qualityPresets as Array<Record<string, unknown>>;
      const pinned = raw.filter(
        (p) => (p as any).showInViewerPanel === true && (p as any).viewerPanelSlot === slot,
      );
      if (pinned.length === 0) return;
      const video = ((pinned[0] as any).settings?.video as Record<string, unknown>) ?? {};
      const vb = video.videoBitrateKbps;
      if (typeof vb !== "number") return;
      qualityRequestHandlerRef.current({
        videoBitrateKbps: vb,
        maxWidth: (video.sendWidth ?? video.captureWidth ?? 1280) as number,
        maxHeight: (video.sendHeight ?? video.captureHeight ?? 720) as number,
        maxFps: (video.sendFps ?? video.captureFps ?? 30) as number,
      });
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

    window.addEventListener("screenlink:viewer-apply-preset", handleApplyPreset);
    window.addEventListener("screenlink:viewer-toggle-mute", handleToggleMute);
    window.addEventListener("screenlink:viewer-toggle-settings", handleToggleSettings);
    window.addEventListener("screenlink:viewer-toggle-info", handleToggleInfo);
    window.addEventListener("screenlink:viewer-escape", handlePanelEscape);
    // Phase 9: compare events only registered when the setting is enabled.
    if (showCompareControls) {
      window.addEventListener("screenlink:compare-toggle", handleCompareToggleEvent);
      window.addEventListener("screenlink:compare-mode", handleCompareModeEvent);
      window.addEventListener("screenlink:compare-exit", handleCompareExitEvent);
      window.addEventListener("screenlink:compare-open-settings-b", handleCompareOpenSettingsBEvent);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("screenlink:viewer-apply-preset", handleApplyPreset);
      window.removeEventListener("screenlink:viewer-toggle-mute", handleToggleMute);
      window.removeEventListener("screenlink:viewer-toggle-settings", handleToggleSettings);
      window.removeEventListener("screenlink:viewer-toggle-info", handleToggleInfo);
      window.removeEventListener("screenlink:viewer-escape", handlePanelEscape);
      if (showCompareControls) {
        window.removeEventListener("screenlink:compare-toggle", handleCompareToggleEvent);
        window.removeEventListener("screenlink:compare-mode", handleCompareModeEvent);
        window.removeEventListener("screenlink:compare-exit", handleCompareExitEvent);
        window.removeEventListener("screenlink:compare-open-settings-b", handleCompareOpenSettingsBEvent);
      }
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleOpenCompareSettingsB, handleToggleFullscreen, handleToggleMute, isFullscreen, streamPauseState, showCompareControls]);

  // ── Quality feedback subscription (Phase 4, typed via controller) ────
  // Phase 6C: Confirmed feedback from the host updates qualityFeedback with
  // concrete accepted/configured values, replacing the pending "awaiting" state.
  useEffect(() => {
    return controller.subscribeQuality((feedback) => {
      if (feedback.type === "effective") {
        const data = feedback.data as { videoBitrateKbps?: number };
        if (typeof data.videoBitrateKbps === "number") {
          setEffectiveBitrateKbps(data.videoBitrateKbps);
          // Confirmed by host — mark as accepted and show effective values.
          setQualityFeedback(`Host accepted: ${fmtKbps(data.videoBitrateKbps)}`);
          setLastQualityAccepted(true);
        }
      }
      if (feedback.type === "configured") {
        const data = feedback.data as { configuredMaxBitrate?: number };
        if (typeof data.configuredMaxBitrate === "number") {
          setConfiguredBitrateBps(data.configuredMaxBitrate);
          // Configured value reported by the sender — confirmed success.
          setQualityFeedback(`Applied: ${fmtKbps(data.configuredMaxBitrate / 1000)}`);
          setLastQualityAccepted(true);
        }
      }
    });
  }, [controller]);

  // Sync volume — routes to gain node when active, native path otherwise.
  // NOTE: This effect NEVER creates AudioContext. Boost is created by
  // ensureAudioBoost() called from user-gesture handlers only.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // During pause, audio must be inaudible regardless of saved
    // volume/mute/deafen preferences. Do NOT alter the user's saved
    // preferences — this is a transient override.
    const isPausedState = streamPauseState === "paused" || streamPauseState === "pausing";
    const actualVolume = isPausedState ? 0 : (isMuted ? 0 : volume);

    if (gainNodeRef.current) {
      const currentStream = video.srcObject;
      if (currentStream !== lastBoostStreamRef.current) {
        audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        gainNodeRef.current = null;
        lastBoostStreamRef.current = null;
      } else {
        // Boost mode: gain node controls volume, native path stays silenced.
        // Defensively re-silence the native path — stream reconnection can
        // reset the element's muted/volume state, causing double audio.
        gainNodeRef.current.gain.value = actualVolume;
        video.volume = 0;
        video.muted = true;
        return;
      }
    }

    // Normal mode: spec-safe [0, 1] range
    video.volume = Math.min(1, actualVolume);
    video.muted = isPausedState ? true : isMuted;
  }, [volume, isMuted, sessionState, streamPauseState]);

  // Tear down boost on unmount
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
        gainNodeRef.current = null;
        lastBoostStreamRef.current = null;
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

  // Persist media mode to localStorage
  useEffect(() => {
    try { localStorage.setItem("screenlink:viewer-media-mode", mediaMode); } catch {}
  }, [mediaMode]);

  // When muted, force video-only (disable audio). Restore user's choice when unmuted.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || sessionState !== "watching") return;

    if (isMuted) {
      session.setMediaMode(false, true);  // video only
    } else {
      const audioEnabled = mediaMode !== "video";
      const videoEnabled = mediaMode !== "audio";
      session.setMediaMode(audioEnabled, videoEnabled);
    }
  }, [isMuted, mediaMode, sessionState]);

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
      logicalStreamId: watchingTarget.logicalStreamId,
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
    // Ensure the runtime is initialized before attempting to send a quality
    // request.  This mirrors what startViewerSession does and prevents
    // "Phase3Runtime is null" false-rejections when the user tweaks quality
    // settings before or during the session's connection handshake.
    await ensureAppRuntimeInitialized();

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
        // Phase 6C: Show neutral until confirmed via quality.effective/configured feedback.
        setQualityFeedback("Cleared — using host defaults");
        setLastQualityAccepted(undefined);
        setQualityRequestPending(false);
        // Persist cleared state
        try { localStorage.removeItem("screenlink:viewer-request"); } catch {}
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

      // Persist the successful request so it survives page reloads
      try { localStorage.setItem("screenlink:viewer-request", JSON.stringify(newRequest)); } catch {}

      // Phase 6C: Show pending until confirmed via quality.effective/quality.configured feedback.
      const reqByteRate = fmtKbps(newRequest.videoBitrateKbps);
      setQualityFeedback("Request sent — awaiting host confirmation");
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
  }, [viewerRequest, watchingTarget, ensureAppRuntimeInitialized]);

  const qualityRequestHandlerRef = useRef(handleQualityRequestChange);
  qualityRequestHandlerRef.current = handleQualityRequestChange;

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

  // ── ViewerSession lifecycle ─────────────────────────────────────
  //
  // INTENTIONAL STALE-CLOSURE PATTERN
  // ──────────────────────────────────
  // This effect uses refs for the latest startViewerSession/controllerStop
  // callbacks so it can depend ONLY on `isViewing`.  Without these refs,
  // watchingTarget object identity changes would tear down the session.
  //
  // The cleanup is deferred (setTimeout 0) so that React StrictMode's
  // transient cleanup/remount cycle does not tear down a live session.
  // On real unmount or isViewing → false the deferred stop still fires.

  const startViewerSessionRef = useRef(startViewerSession);
  startViewerSessionRef.current = startViewerSession;
  const controllerStopRef = useRef(controllerStop);
  controllerStopRef.current = controllerStop;
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifecycleStartedRef = useRef(false);

  useEffect(() => {
    if (!isViewing) {
      lifecycleStartedRef.current = false;
      return;
    }

    // Cancel any pending deferred stop (StrictMode probe cleanup → remount)
    if (stopTimerRef.current !== null) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }

    // React StrictMode re-runs this effect without changing isViewing.
    // Keep the original serialized start rather than enqueueing a second one.
    if (!lifecycleStartedRef.current) {
      lifecycleStartedRef.current = true;
      void startViewerSessionRef.current();
    }

    return () => {
      // Defer cleanup so React StrictMode's transient
      // cleanup/remount does not tear down a live session.
      // On real unmount or isViewing change the timer still fires.
      stopTimerRef.current = setTimeout(() => {
        stopTimerRef.current = null;
        lifecycleStartedRef.current = false;
        void controllerStopRef.current();
      }, 0);
    };
  }, [isViewing]);

  // ── Synchronize sessionRef for diagnostics ──────────────────────
  // The controller owns the ViewerSession; copy its reference so
  // downstream diagnostics (stream metrics, quality requests, etc.)
  // can read session state without importing the controller.
  useEffect(() => {
    sessionRef.current = controller.session;
  }, [controller, controller.session]);

  // ── Stream-end detection is now owned by ViewerSessionController (Phase 4) ──
  // The controller subscribes to activeStreamsByGroup and triggers ended phase
  // when the exact (logicalStreamId, mediaSessionId) pair disappears.
  // ViewerWorkspace reacts to the snapshot phase change instead.
  useEffect(() => {
    if (sessionPhase !== "ended") return;
    setActivePanel(null);
    const timer = setTimeout(() => {
      useStore.getState().setIsViewing(false);
      navigateToGroupOverview();
    }, 4000);
    return () => clearTimeout(timer);
  }, [sessionPhase, navigateToGroupOverview]);

  // ── Derive display status from session state ─────────────────────
  const displayStatus = sessionStateToViewStatus(sessionState);

  // ── Render by view status (Section 15) ───────────────────────────

  // Terminal states that don't need a video element

  // Stream ended state — Animated exit with auto-navigate
  if (displayStatus === "ended") {
    return (
      <ViewerStatusOverlay
        displayStatus="ended"
        sharerName={sharerName}
        viewerError={viewerError}
        liveDuration={liveDuration}
        onRetry={handleRetry}
        onExit={handleExit}
        reduced={reduced}
      />
    );
  }

  // Fatal error state — Destructive Alert + retry
  const isFatalError = displayStatus === "error";
  if (isFatalError) {
    return (
      <ViewerShell className={className} onExit={handleExit}>
        <ViewerStatusOverlay
          displayStatus="error"
          sharerName={sharerName}
          viewerError={viewerError}
          liveDuration={liveDuration}
          onRetry={handleRetry}
          onExit={handleExit}
          reduced={reduced}
        />
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
            <ViewerStatusOverlay
              displayStatus="connecting"
              sharerName={sharerName}
              viewerError={viewerError}
              liveDuration={liveDuration}
              onRetry={handleRetry}
              onExit={handleExit}
              reduced={reduced}
            />
          )}

          {/* ▸ Reconnecting overlay — amber alert + progress */}
          {displayStatus === "reconnecting" && (
            <ViewerStatusOverlay
              displayStatus="reconnecting"
              sharerName={sharerName}
              viewerError={viewerError}
              liveDuration={liveDuration}
              onRetry={handleRetry}
              onExit={handleExit}
              reduced={reduced}
            />
          )}

          {/* ▸ Degraded overlay — amber alert */}
          {displayStatus === "degraded" && (
            <ViewerStatusOverlay
              displayStatus="degraded"
              sharerName={sharerName}
              viewerError={viewerError}
              liveDuration={liveDuration}
              onRetry={handleRetry}
              onExit={handleExit}
              reduced={reduced}
            />
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
                onFirstFrame={handleEnhancementReadyFirstFrame}
                onBackendChange={handleEnhancementEffectiveBackend}
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
                onFirstFrame={handleEnhancementReadyFirstFrame}
                onBackendChange={handleEnhancementEffectiveBackend}
                onStatsUpdate={handleEnhancementStatsUpdate}
                processorApiRef={processorApiRef}
                onContextMenu={(e) => { e.preventDefault(); handleToggleFullscreen(); }}
              />

              {/* ── Paused overlay ── */}
              <ViewerOverlayPaused
                pauseState={streamPauseState}
                posterUrl={streamPausePoster}
              />
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
                  mediaMode={mediaMode}
                  onMediaModeChange={handleMediaModeChange}
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

          {/* ▸ Stream info card overlay */}
          {showStreamInfoCard && (
            <StreamInfoCard
              snapshot={{
                ...diagSnapshot,
                // Frame timing provides real displayed FPS from rVFC; the
                // deprecated useStreamDiagnostics hook always returns null.
                videoFrameRate:
                  framePerformanceSamples.length > 0
                    ? (framePerformanceSamples[framePerformanceSamples.length - 1]
                        .displayedFps ?? diagSnapshot.videoFrameRate)
                    : diagSnapshot.videoFrameRate,
              }}
              droppedFramesInLast5s={droppedFramesInLast5s}
              config={streamInfoCardConfig}
              bandwidthBps={currentBandwidthBps}
              totalBytes={totalBytesReceived}
              activeDurationMs={activeDurationMs}
              viewerHistoryId={viewerHistoryId}
            />
          )}

          {/* ▸ Controls and panels — shown whenever not connecting */}
          {displayStatus !== "connecting" && (
            <ViewerPanelShell
              activePanel={activePanel}
              onActivePanelChange={setActivePanel}
              session={sessionRef.current}
              lastRequestedQuality={lastRequestedQuality}
              effectiveBitrateKbps={effectiveBitrateKbps}
              configuredBitrateBps={configuredBitrateBps}
              requestedCodec={requestedCodec}
              diagnosticsSnapshot={diagnosticsSnapshot}
              framePerformanceSamples={framePerformanceSamples}
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
              mediaMode={mediaMode}
              onMediaModeChange={handleMediaModeChange}
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
                viewerHistoryId={viewerHistoryId}
                discordMuteBinding={discordMuteBinding}
                discordDeafenBinding={discordDeafenBinding}
                syncScreenLinkDeafen={syncScreenLinkDeafen}
                maxVolumePercent={maxVolumePercent}
                activePanel={activePanel}
                onActivePanelChange={setActivePanel}
                showStreamInfoCard={showStreamInfoCard}
                onToggleStreamInfoCard={handleToggleStreamInfoCard}
                onCompareToggle={showCompareControls ? handleCompareToggleWithSettingsB : undefined}
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
  viewerHistoryId,
  discordMuteBinding,
  discordDeafenBinding,
  syncScreenLinkDeafen,
  maxVolumePercent,
  activePanel,
  onActivePanelChange,
  onCompareToggle,
  showStreamInfoCard,
  onToggleStreamInfoCard,
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
  viewerHistoryId?: string | null;
  discordMuteBinding?: ShortcutBinding;
  discordDeafenBinding?: ShortcutBinding;
  syncScreenLinkDeafen?: boolean;
  maxVolumePercent?: number;
  activePanel: ActivePanel | null;
  onActivePanelChange: (panel: ActivePanel | null) => void;
  onCompareToggle?: () => void;
  showStreamInfoCard?: boolean;
  onToggleStreamInfoCard?: () => void;
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
      viewerHistoryId={viewerHistoryId}
      discordMuteBinding={discordMuteBinding}
      discordDeafenBinding={discordDeafenBinding}
      syncScreenLinkDeafen={syncScreenLinkDeafen}
      maxVolumePercent={maxVolumePercent}
      activePanel={activePanel}
      onActivePanelChange={onActivePanelChange}
      onCompareToggle={onCompareToggle}
      showStreamInfoCard={showStreamInfoCard}
      onToggleStreamInfoCard={onToggleStreamInfoCard}
    />
  );
}

/**
 * Paused overlay — shown when the stream is paused or resuming.
 * Uses a poster frame as the background image when available.
 * Internal guard: renders nothing when pauseState is neither "paused" nor "resuming".
 */
function ViewerOverlayPaused({
  pauseState,
  posterUrl,
}: {
  pauseState: string;
  posterUrl: string | null;
}) {
  const isPaused = pauseState === "paused";
  const isResuming = pauseState === "resuming";
  if (!isPaused && !isResuming) return null;

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/40"
      aria-label={isPaused ? "Stream paused" : "Resuming stream"}
      role="status"
    >
      {posterUrl && (
        <div className="absolute inset-0 bg-cover bg-center opacity-60" style={{ backgroundImage: `url(${posterUrl})` }} />
      )}
      <div className="relative z-10 flex flex-col items-center gap-3 pointer-events-none">
        {isPaused ? (
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
  );
}
