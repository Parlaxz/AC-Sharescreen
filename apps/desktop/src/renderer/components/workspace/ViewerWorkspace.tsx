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
import type { ViewerRequestState } from "./viewer/ViewerSettingsPanel.js";
import { loadSettings } from "@/services/settings-actions";
import {
  createBandwidthTracker,
  updateBandwidthTracker,
} from "@/services/viewer-bandwidth.js";
import {
  getViewerQualityDispatchError,
  resolveViewerQualityFeedbackStreamId,
} from "./viewer/viewer-quality-helpers.js";
import { ViewerSession, type ViewerSessionState, type ViewerPauseState } from "@/services/viewer-session.js";
import { getRuntime } from "@/services/phase3-runtime.js";
import { EnhancedVideoSurface } from "@/components/workspace/viewer/EnhancedVideoSurface";
import type { ProcessorStats } from "@/components/workspace/viewer/EnhancedVideoSurface";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";
import {
  loadImageEnhancementSettings,
  saveImageEnhancementSettings,
  resetImageEnhancementSettings,
} from "@/services/viewer-image-processing/viewer-image-settings";

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
  const navigate = useStore((s) => s.navigate);
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

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<ViewerSessionState>("idle");
  const [qualityRequestPending, setQualityRequestPending] = useState(false);
  const [qualityFeedback, setQualityFeedback] = useState<string | null>(null);
  const [lastQualityAccepted, setLastQualityAccepted] = useState<boolean | undefined>(undefined);
  /** Track whether any popover panel is open to keep controls visible */
  const [panelsOpen, setPanelsOpen] = useState(false);

  // ── Pause state ─────────────────────────────────────────────────────
  const [streamPauseState, setStreamPauseState] = useState<ViewerPauseState>("playing");
  const [streamPausePoster, setStreamPausePoster] = useState<string | null>(null);
  const streamPauseTransitioning = streamPauseState === "pausing" || streamPauseState === "resuming";

  // ── GPU image enhancement state ──────────────────────────────────────
  const [enhancementSettings, setEnhancementSettings] = useState<ViewerImageEnhancementSettings>(() => {
    return loadImageEnhancementSettings();
  });
  const [enhancementStats, setEnhancementStats] = useState<ProcessorStats | null>(null);
  const [enhancementFallback, setEnhancementFallback] = useState(false);

  // Refs for closure-safe access in callbacks
  const enhancementSettingsRef = useRef(enhancementSettings);
  enhancementSettingsRef.current = enhancementSettings;
  const enhancementFallbackRef = useRef(enhancementFallback);
  enhancementFallbackRef.current = enhancementFallback;

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
  const bandwidthTrackerRef = useRef(createBandwidthTracker());
  const bandwidthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll WebRTC stats for bandwidth
  useEffect(() => {
    if (!sessionRef.current || sessionState !== "watching") {
      setCurrentBandwidthBps(0);
      setTotalBytesReceived(0);
      bandwidthTrackerRef.current = createBandwidthTracker();
      if (bandwidthPollRef.current) {
        clearInterval(bandwidthPollRef.current);
        bandwidthPollRef.current = null;
      }
      return;
    }

    const poll = async () => {
      if (!sessionRef.current) return;
      try {
        const diag = await sessionRef.current.getDiagnostics();
        if (diag) {
          const videoBytes = diag.inboundVideo.bytesReceived ?? 0;
          const audioBytes = diag.inboundAudio.bytesReceived ?? 0;
          const totalNow = videoBytes + audioBytes;
          const next = updateBandwidthTracker(
            bandwidthTrackerRef.current,
            totalNow,
            performance.now(),
          );
          bandwidthTrackerRef.current = next;
          setTotalBytesReceived(next.totalBytesReceived);
          setCurrentBandwidthBps(next.currentBytesPerSecond);
        }
      } catch {
        // best-effort
      }
    };

    poll();
    bandwidthPollRef.current = setInterval(poll, 1000);

    return () => {
      if (bandwidthPollRef.current) {
        clearInterval(bandwidthPollRef.current);
        bandwidthPollRef.current = null;
      }
    };
  }, [sessionState]);

  // Video element ref — shared with ViewerSession
  const videoRef = useRef<HTMLVideoElement>(null);

  // Audio boost via Web Audio API GainNode (allows volume > 1.0)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

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
    // Navigate back to the group overview
    navigate("overview");
  }, [setIsViewing, setViewStatus, isFullscreen, navigate]);

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

  // ── Pause/resume callbacks (single owner of toggle) ──────────────
  const handlePauseStream = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.pauseState !== "playing") return;
    try {
      await session.pause();
    } catch (err) {
      console.error("[ViewerWorkspace] pause failed:", err);
    }
  }, []);

  const handleResumeStream = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.pauseState !== "paused") return;
    try {
      await session.resume();
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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        handleToggleFullscreen();
      }
    };
    window.addEventListener("screenlink:viewer-toggle-mute", handleToggleMute);
    window.addEventListener("screenlink:viewer-toggle-pause", handleTogglePause);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("screenlink:viewer-toggle-mute", handleToggleMute);
      window.removeEventListener("screenlink:viewer-toggle-pause", handleTogglePause);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleToggleFullscreen, handleToggleMute, isFullscreen, streamPauseState]);

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
  }, [volume, isMuted]);

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
    const target = watchingTarget;
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
        setQualityFeedback(`Accepted at ${kbps} kbps`);
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

    // Wire pause state events for reactive UI updates
    session.onPauseStateChange = (pauseState: ViewerPauseState) => {
      setStreamPauseState(pauseState);
    };
    session.onPosterFrameChange = (poster: string | null) => {
      // When GPU enhancements are active and running, capture poster from enhanced canvas
      // instead of the (possibly hidden) native video element
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
              className="h-full object-contain"
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
            isStreamPaused={streamPauseState === "paused"}
            isStreamPauseTransitioning={streamPauseTransitioning}
            onToggleStreamPause={handleToggleStreamPause}
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={handleVolumeChange}
            onToggleMute={handleToggleMute}
            viewerRequest={viewerRequest}
            onQualityRequestChange={handleQualityRequestChange}
            qualityRequestPending={qualityRequestPending}
            qualityFeedback={qualityFeedback}
            lastQualityAccepted={lastQualityAccepted}
            effectiveBitrateKbps={effectiveBitrateKbps}
            configuredBitrateBps={configuredBitrateBps}
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
            isScreenLinkDeafened={isScreenLinkDeafened}
            onToggleScreenLinkDeafen={handleToggleScreenLinkDeafen}
            currentBandwidthBps={currentBandwidthBps}
            totalBytesReceived={totalBytesReceived}
            discordMuteBinding={discordMuteBinding}
            discordDeafenBinding={discordDeafenBinding}
            syncScreenLinkDeafen={syncScreenLinkDeafen}
            maxVolumePercent={maxVolumePercent}
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
              className="h-full object-contain"
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
            isStreamPaused={streamPauseState === "paused"}
            isStreamPauseTransitioning={streamPauseTransitioning}
            onToggleStreamPause={handleToggleStreamPause}
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={handleVolumeChange}
            onToggleMute={handleToggleMute}
            viewerRequest={viewerRequest}
            onQualityRequestChange={handleQualityRequestChange}
            qualityRequestPending={qualityRequestPending}
            qualityFeedback={qualityFeedback}
            lastQualityAccepted={lastQualityAccepted}
            effectiveBitrateKbps={effectiveBitrateKbps}
            configuredBitrateBps={configuredBitrateBps}
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
            isScreenLinkDeafened={isScreenLinkDeafened}
            onToggleScreenLinkDeafen={handleToggleScreenLinkDeafen}
            currentBandwidthBps={currentBandwidthBps}
            totalBytesReceived={totalBytesReceived}
            discordMuteBinding={discordMuteBinding}
            discordDeafenBinding={discordDeafenBinding}
            syncScreenLinkDeafen={syncScreenLinkDeafen}
            maxVolumePercent={maxVolumePercent}
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
            data-video-native
            className={cn(
              "h-full object-contain",
              streamPauseState === "paused" && "opacity-30",
              // Hide native video when GPU canvas is actively rendering
              !enhancementFallback && enhancementSettings.enabled && streamPauseState === "playing" && "invisible",
            )}
            playsInline
            autoPlay
            aria-label={`${sharerName}'s stream - ${sourceName}`}
            onContextMenu={(e) => {
              e.preventDefault();
              handleToggleFullscreen();
            }}
          />

          {/* ── GPU-enhanced display surface ────────────────────── */}
          <EnhancedVideoSurface
            videoElement={videoRef.current}
            enabled={!enhancementFallback && enhancementSettings.enabled}
            settings={enhancementSettings}
            onProcessorStateChange={(state) => {
              if (state === "error") {
                setEnhancementFallback(true);
              }
            }}
            onProcessingError={(reason) => {
              console.warn("[ViewerWorkspace] GPU enhancement error:", reason);
              setEnhancementFallback(true);
            }}
            onFirstFrame={() => {
              // First enhanced frame successfully rendered
            }}
            onStatsUpdate={(stats) => {
              setEnhancementStats(stats);
            }}
          />

          {/* ── Paused overlay (frozen frame poster + play icon + label) ── */}
          {(streamPauseState === "paused" || streamPauseState === "resuming") && (
            <div
              className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/40"
              aria-label={streamPauseState === "paused" ? "Stream paused" : "Resuming stream"}
              role="status"
            >
              {/* Poster frame as background image */}
              {streamPausePoster && (
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-60"
                  style={{ backgroundImage: `url(${streamPausePoster})` }}
                />
              )}

              {/* Centered icon + label */}
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
                    <p className="text-sm text-white/80 font-medium">
                      Resuming stream...
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Top-left exit button — fades in/out with controls */}
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: controlsVisible ? 1 : 0, x: controlsVisible ? 0 : -10 }}
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

          {/* Video controls overlay */}
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
            viewerRequest={viewerRequest}
            onQualityRequestChange={handleQualityRequestChange}
            qualityRequestPending={qualityRequestPending}
            qualityFeedback={qualityFeedback}
            lastQualityAccepted={lastQualityAccepted}
            effectiveBitrateKbps={effectiveBitrateKbps}
            configuredBitrateBps={configuredBitrateBps}
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
            isScreenLinkDeafened={isScreenLinkDeafened}
            onToggleScreenLinkDeafen={handleToggleScreenLinkDeafen}
            currentBandwidthBps={currentBandwidthBps}
            totalBytesReceived={totalBytesReceived}
            discordMuteBinding={discordMuteBinding}
            discordDeafenBinding={discordDeafenBinding}
            syncScreenLinkDeafen={syncScreenLinkDeafen}
            maxVolumePercent={maxVolumePercent}
            enhancementSettings={enhancementSettings}
            onEnhancementChange={handleEnhancementChange}
            onEnhancementReset={handleEnhancementReset}
            enhancementStats={enhancementStats}
          />
        </div>
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
  viewerRequest,
  onQualityRequestChange,
  qualityRequestPending,
  qualityFeedback,
  lastQualityAccepted,
  effectiveBitrateKbps,
  configuredBitrateBps,
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
  isScreenLinkDeafened,
  onToggleScreenLinkDeafen,
  currentBandwidthBps,
  totalBytesReceived,
  discordMuteBinding,
  discordDeafenBinding,
  syncScreenLinkDeafen,
  maxVolumePercent,
  enhancementSettings,
  onEnhancementChange,
  onEnhancementReset,
  enhancementStats,
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
  viewerRequest: ViewerRequestState | null;
  onQualityRequestChange: (state: ViewerRequestState | null) => void;
  qualityRequestPending: boolean;
  qualityFeedback: string | null;
  lastQualityAccepted: boolean | undefined;
  effectiveBitrateKbps: number | null;
  configuredBitrateBps: number | null;
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
  isScreenLinkDeafened?: boolean;
  onToggleScreenLinkDeafen?: () => void;
  currentBandwidthBps?: number;
  totalBytesReceived?: number;
  discordMuteBinding?: ShortcutBinding;
  discordDeafenBinding?: ShortcutBinding;
  syncScreenLinkDeafen?: boolean;
  maxVolumePercent?: number;
  enhancementSettings?: ViewerImageEnhancementSettings;
  onEnhancementChange?: (partial: Partial<ViewerImageEnhancementSettings>) => void;
  onEnhancementReset?: () => void;
  enhancementStats?: {
    inputWidth: number;
    inputHeight: number;
    outputWidth: number;
    outputHeight: number;
    processingTimeMs: number | null;
    enhancedScalingActive: boolean;
    backend: string;
  } | null;
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
      viewerRequest={viewerRequest}
      onQualityRequestChange={onQualityRequestChange}
      qualityRequestPending={qualityRequestPending}
      qualityFeedback={qualityFeedback}
      lastQualityAccepted={lastQualityAccepted}
      effectiveBitrateKbps={effectiveBitrateKbps}
      configuredBitrateBps={configuredBitrateBps}
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
      isScreenLinkDeafened={isScreenLinkDeafened}
      onToggleScreenLinkDeafen={onToggleScreenLinkDeafen}
      currentBandwidthBps={currentBandwidthBps}
      totalBytesReceived={totalBytesReceived}
      discordMuteBinding={discordMuteBinding}
      discordDeafenBinding={discordDeafenBinding}
      syncScreenLinkDeafen={syncScreenLinkDeafen}
      maxVolumePercent={maxVolumePercent}
      enhancementSettings={enhancementSettings}
      onEnhancementChange={onEnhancementChange}
      onEnhancementReset={onEnhancementReset}
      enhancementStats={enhancementStats}
    />
  );
}
