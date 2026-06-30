// SPDX-License-Identifier: MIT
/**
 * CompareViewerSurface — Dual-video viewer for Easy Compare streams.
 *
 * Renders two video panes (A and B) side-by-side or in single-pane mode,
 * with auto-hiding overlay controls, mode toggle, and session management
 * for both variants.
 *
 * Layout modes:
 *   - side-by-side (default): both panes fill 50% width each
 *   - a-only: variant A fills the full viewport
 *   - b-only: variant B fills the full viewport
 */

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type ReactElement,
} from "react";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Columns,
  Monitor,
  Play,
  Pause,
  Maximize,
  Minimize,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ViewerSession } from "@/services/viewer-session.js";
import { getRuntime } from "@/services/phase3-runtime.js";
import type { CompareConfigSnapshot } from "@screenlink/shared";
import type { StreamAnnouncement } from "@/stores/main-store";

// ─── Types ─────────────────────────────────────────────────────────────────

export type CompareDisplayMode = "side-by-side" | "a-only" | "b-only";

export interface CompareStreamAnnouncement extends StreamAnnouncement {
  compareMode?: string;
  primaryVariant?: string;
  variantADescriptor?: {
    mediaSessionId?: string;
    configSnapshot?: CompareConfigSnapshot;
  };
  variantBDescriptor?: {
    mediaSessionId?: string;
    configSnapshot?: CompareConfigSnapshot;
  };
}

export interface CompareViewerSurfaceProps {
  /** The Easy Compare stream announcement with variant metadata */
  streamAnnouncement: CompareStreamAnnouncement;
  /** Media session ID for variant A */
  mediaSessionA: string;
  /** Media session ID for variant B */
  mediaSessionB: string;
  /** Group ID the streams belong to */
  groupId: string;
  /** Host device ID */
  hostDeviceId: string;
  /** Host display name */
  hostName: string;
  /** Called when user exits the compare viewer */
  onExit: () => void;
  /** Called when fullscreen state changes */
  onFullscreenChange?: (isFullscreen: boolean) => void;
}

// ─── Auto-hide timeout hook (local copy — mirrors ViewerWorkspace) ────────

function useControlsAutoHide({
  delayMs = 3000,
  locked = false,
}: {
  delayMs?: number;
  locked?: boolean;
}) {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
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

// ─── Format helpers ─────────────────────────────────────────────────────────

function formatLabel(
  variantId: string,
  config?: CompareConfigSnapshot,
): string {
  if (!config) return variantId;
  return `${variantId} — ${config.resolutionWidth}×${config.resolutionHeight} @ ${config.fps}fps · ${config.videoBitrateKbps}kbps`;
}

function formatInfoLine(
  variantId: string,
  config?: CompareConfigSnapshot,
  state?: string,
): string {
  if (state === "loading") return `${variantId}: Connecting...`;
  if (state === "error") return `${variantId}: Error`;
  if (!config) return `${variantId}: Live`;
  return `${variantId}: ${config.resolutionWidth}×${config.resolutionHeight} @ ${config.fps}fps · ${config.videoBitrateKbps}kbps`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CompareViewerSurface({
  streamAnnouncement,
  mediaSessionA,
  mediaSessionB,
  groupId,
  hostDeviceId,
  hostName,
  onExit,
  onFullscreenChange,
}: CompareViewerSurfaceProps): ReactElement {
  // ── Layout mode ─────────────────────────────────────────────────
  const [displayMode, setDisplayMode] = useState<CompareDisplayMode>(
    "side-by-side",
  );
  const [fullscreen, setFullscreen] = useState(false);

  // ── Pause state (shared across both variants) ────────────────────
  const [paused, setPaused] = useState(false);

  // ── Per-variant stream readiness ─────────────────────────────────
  const [streamAStatus, setStreamAStatus] = useState<
    "loading" | "ready" | "ended" | "error"
  >("loading");
  const [streamBStatus, setStreamBStatus] = useState<
    "loading" | "ready" | "ended" | "error"
  >("loading");

  // ── Video refs ───────────────────────────────────────────────────
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);

  // ── Session refs ─────────────────────────────────────────────────
  const sessionARef = useRef<ViewerSession | null>(null);
  const sessionBRef = useRef<ViewerSession | null>(null);
  const sessionsDestroyedRef = useRef(false);

  // ── Extracted config ─────────────────────────────────────────────
  const configA = streamAnnouncement.variantADescriptor?.configSnapshot;
  const configB = streamAnnouncement.variantBDescriptor?.configSnapshot;
  const labelA = formatLabel("A", configA);
  const labelB = formatLabel("B", configB);

  // ── Auto-hide controls ───────────────────────────────────────────
  const { visible: controlsVisible, show: showControls, hide: hideControls } =
    useControlsAutoHide({ delayMs: 3000 });

  // ── Create sessions on mount ─────────────────────────────────────
  useEffect(() => {
    const runtime = getRuntime();
    if (!runtime || runtime.isDestroyed()) return;

    const logicalStreamId = streamAnnouncement.logicalStreamId;

    // ── Session A ──────────────────────────────────────────────
    const sessionA = new ViewerSession();
    sessionARef.current = sessionA;

    sessionA.onStateChange = (state) => {
      if (state === "watching") setStreamAStatus("ready");
      else if (state === "ended") setStreamAStatus("ended");
      else if (state === "error") setStreamAStatus("error");
    };

    sessionA
      .start({
        groupId,
        hostDeviceId,
        logicalStreamId,
        mediaSessionId: mediaSessionA,
        hostName,
        videoElement: videoARef.current,
        compareVariantId: "A",
      })
      .catch(() => setStreamAStatus("error"));

    // ── Session B ──────────────────────────────────────────────
    const sessionB = new ViewerSession();
    sessionBRef.current = sessionB;

    sessionB.onStateChange = (state) => {
      if (state === "watching") setStreamBStatus("ready");
      else if (state === "ended") setStreamBStatus("ended");
      else if (state === "error") setStreamBStatus("error");
    };

    sessionB
      .start({
        groupId,
        hostDeviceId,
        logicalStreamId,
        mediaSessionId: mediaSessionB,
        hostName,
        videoElement: videoBRef.current,
        compareVariantId: "B",
      })
      .catch(() => setStreamBStatus("error"));

    // ── Cleanup on unmount ──────────────────────────────────────
    return () => {
      sessionsDestroyedRef.current = true;
      const sA = sessionARef.current;
      const sB = sessionBRef.current;
      sessionARef.current = null;
      sessionBRef.current = null;
      if (sA) void sA.destroy();
      if (sB) void sB.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fullscreen toggle ──────────────────────────────────────────
  const handleToggleFullscreen = useCallback(() => {
    const api = (
      window as unknown as {
        screenlink?: {
          toggleFullscreen: () => Promise<boolean>;
          onFullscreenChanged?: (
            cb: (isFullscreen: boolean) => void,
          ) => () => void;
        };
      }
    ).screenlink;
    const toggle = async () => {
      if (api) {
        const newFs = await api.toggleFullscreen();
        setFullscreen(newFs);
        onFullscreenChange?.(newFs);
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
        setFullscreen(false);
        onFullscreenChange?.(false);
      } else {
        await document.documentElement.requestFullscreen();
        setFullscreen(true);
        onFullscreenChange?.(true);
      }
    };
    void toggle();
  }, [onFullscreenChange]);

  // ── Pause / Resume ────────────────────────────────────────────
  const handleTogglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev;

      const vA = videoARef.current;
      const vB = videoBRef.current;

      if (next) {
        // Pause both
        if (vA && !vA.paused) vA.pause();
        if (vB && !vB.paused) vB.pause();
      } else {
        // Resume both
        if (vA && vA.paused) void vA.play().catch(() => {});
        if (vB && vB.paused) void vB.play().catch(() => {});
      }

      return next;
    });
  }, []);

  // ── Cycle display mode ─────────────────────────────────────────
  const cycleDisplayMode = useCallback(() => {
    setDisplayMode((prev) => {
      const modes: CompareDisplayMode[] = ["a-only", "side-by-side", "b-only"];
      const idx = modes.indexOf(prev);
      return modes[(idx + 1) % modes.length];
    });
  }, []);

  // ── Keyboard listeners (compare-specific) ──────────────────────
  useEffect(() => {
    const handleCycleMode = () => cycleDisplayMode();
    const handleTogglePauseEvent = () => handleTogglePause();

    // Shift+Tab, Space, F, and Esc are all handled by use-keyboard-shortcuts
    // which dispatches custom events or uses the Electron API directly.
    // We only listen for the custom events here.
    window.addEventListener("screenlink:compare-cycle-mode", handleCycleMode);
    window.addEventListener(
      "screenlink:compare-toggle-pause",
      handleTogglePauseEvent,
    );

    return () => {
      window.removeEventListener(
        "screenlink:compare-cycle-mode",
        handleCycleMode,
      );
      window.removeEventListener(
        "screenlink:compare-toggle-pause",
        handleTogglePauseEvent,
      );
    };
  }, [cycleDisplayMode, handleTogglePause]);

  // ── Fullscreen change listener (Electron API) ──────────────────
  useEffect(() => {
    const api = (
      window as unknown as {
        screenlink?: {
          onFullscreenChanged: (
            cb: (isFullscreen: boolean) => void,
          ) => () => void;
        };
      }
    ).screenlink;
    if (api) {
      const unsub = api.onFullscreenChanged((isFs) => {
        setFullscreen(isFs);
        onFullscreenChange?.(isFs);
      });
      return unsub;
    }
    const handler = () => {
      setFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, [onFullscreenChange]);

  // ── Modes for quick access ──────────────────────────────────────
  const isSideBySide = displayMode === "side-by-side";
  const isAOnly = displayMode === "a-only";
  const isBOnly = displayMode === "b-only";

  // ── Pane visibility flags ────────────────────────────────────────
  const showPaneA = isSideBySide || isAOnly;
  const showPaneB = isSideBySide || isBOnly;

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-black select-none"
      data-compare-viewer
      onMouseMove={showControls}
      onMouseEnter={showControls}
      onMouseLeave={hideControls}
    >
      {/* ── Video Stage ─────────────────────────────────────────── */}
      <div className="absolute inset-0 flex">
        {/* Pane A */}
        {showPaneA && (
          <div
            className={cn(
              "relative flex items-center justify-center overflow-hidden bg-black",
              isSideBySide && "w-1/2",
              isAOnly && "w-full",
            )}
          >
            <video
              ref={videoARef}
              data-compare-video="a"
              className={cn(
                "h-full w-full",
                isSideBySide ? "object-contain" : "object-contain",
                paused && "opacity-30",
              )}
              playsInline
              autoPlay
              muted={false}
              aria-label="Variant A stream"
            />

            {/* Label overlay — top-left */}
            <div
              className={cn(
                "absolute top-3 left-3 z-10 px-2 py-1 rounded text-[11px] font-medium pointer-events-none",
                "bg-black/60 text-white/90 backdrop-blur-sm border border-white/10",
              )}
            >
              {labelA}
            </div>

            {/* Status overlay when not ready */}
            {streamAStatus === "loading" && (
              <div className="absolute inset-0 z-5 flex items-center justify-center bg-black/40">
                <span className="text-xs text-white/60 font-mono">
                  Connecting A...
                </span>
              </div>
            )}

            {streamAStatus === "error" && (
              <div className="absolute inset-0 z-5 flex items-center justify-center bg-black/60">
                <span className="text-xs text-danger/80 font-mono">
                  A: Error
                </span>
              </div>
            )}
          </div>
        )}

        {/* Hairline divider — only in side-by-side mode */}
        {isSideBySide && (
          <div className="absolute left-1/2 top-0 bottom-0 w-px z-20 bg-white/20 pointer-events-none -translate-x-px" />
        )}

        {/* Pane B */}
        {showPaneB && (
          <div
            className={cn(
              "relative flex items-center justify-center overflow-hidden bg-black",
              isSideBySide && "w-1/2",
              isBOnly && "w-full",
            )}
          >
            <video
              ref={videoBRef}
              data-compare-video="b"
              className={cn(
                "h-full w-full",
                isSideBySide ? "object-contain" : "object-contain",
                paused && "opacity-30",
              )}
              playsInline
              autoPlay
              muted
              aria-label="Variant B stream"
            />

            {/* Label overlay — top-left */}
            <div
              className={cn(
                "absolute top-3 left-3 z-10 px-2 py-1 rounded text-[11px] font-medium pointer-events-none",
                "bg-black/60 text-white/90 backdrop-blur-sm border border-white/10",
              )}
            >
              {labelB}
            </div>

            {/* Status overlay when not ready */}
            {streamBStatus === "loading" && (
              <div className="absolute inset-0 z-5 flex items-center justify-center bg-black/40">
                <span className="text-xs text-white/60 font-mono">
                  Connecting B...
                </span>
              </div>
            )}

            {streamBStatus === "error" && (
              <div className="absolute inset-0 z-5 flex items-center justify-center bg-black/60">
                <span className="text-xs text-danger/80 font-mono">
                  B: Error
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Pause overlay ───────────────────────────────────────── */}
      {paused && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/40 pointer-events-none"
          aria-label="Paused"
          role="status"
        >
          <div className="h-16 w-16 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
            <Play className="h-8 w-8 text-white" />
          </div>
          <p className="text-sm text-white/80 font-medium mt-3">
            Paused — Press{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-xs font-mono">
              Space
            </kbd>{" "}
            to resume
          </p>
        </div>
      )}

      {/* ── Top-left: Compare Mode badge ─────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, x: -10 }}
        animate={{
          opacity: controlsVisible ? 1 : 0,
          x: controlsVisible ? 0 : -10,
        }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="absolute top-3 left-3 z-30"
      >
        <Badge
          variant="outline"
          className="gap-1.5 bg-black/60 backdrop-blur-sm border-accent/30 text-accent text-[10px] font-medium px-2 py-0.5"
        >
          <Columns className="h-3 w-3" />
          Compare Mode
        </Badge>
      </motion.div>

      {/* ── Top-right: Exit button ────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, x: 10 }}
        animate={{
          opacity: controlsVisible ? 1 : 0,
          x: controlsVisible ? 0 : 10,
        }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="absolute top-3 right-3 z-30"
      >
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 bg-black/60 backdrop-blur-sm border-white/10 text-white/80 hover:text-white hover:bg-white/10"
          onClick={onExit}
          aria-label="Exit viewer"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span className="text-[11px]">Exit</span>
        </Button>
      </motion.div>

      {/* ── Bottom control bar ────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{
          opacity: controlsVisible ? 1 : 0,
          y: controlsVisible ? 0 : 20,
        }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="absolute bottom-0 left-0 right-0 z-30 bg-gradient-to-t from-black/80 via-black/50 to-transparent"
      >
        {/* Controls row */}
        <div className="flex items-center justify-center gap-2 px-4 pb-3 pt-8">
          <div className="flex items-center gap-1 rounded-standard bg-black/60 backdrop-blur-sm px-2 py-1.5 border border-white/10 max-w-3xl w-full">
            {/* ── Left: Play/Pause ──────────────────────────────── */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-white hover:bg-white/10"
                  onClick={handleTogglePause}
                  aria-label={paused ? "Resume" : "Pause"}
                >
                  {paused ? (
                    <Play className="h-3.5 w-3.5" />
                  ) : (
                    <Pause className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {paused ? "Resume (Space)" : "Pause (Space)"}
              </TooltipContent>
            </Tooltip>

            {/* ── Center: Mode toggle segmented control ────────── */}
            <div className="flex items-center gap-0.5 mx-auto">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-7 w-7",
                      isAOnly
                        ? "text-accent bg-accent/10"
                        : "text-white/60 hover:text-white hover:bg-white/10",
                    )}
                    onClick={() => setDisplayMode("a-only")}
                    aria-label="Show variant A only"
                  >
                    <Monitor className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  A only
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-7 w-7",
                      isSideBySide
                        ? "text-accent bg-accent/10"
                        : "text-white/60 hover:text-white hover:bg-white/10",
                    )}
                    onClick={() => setDisplayMode("side-by-side")}
                    aria-label="Show both variants side by side"
                  >
                    <Columns className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Side by side
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-7 w-7",
                      isBOnly
                        ? "text-accent bg-accent/10"
                        : "text-white/60 hover:text-white hover:bg-white/10",
                    )}
                    onClick={() => setDisplayMode("b-only")}
                    aria-label="Show variant B only"
                  >
                    <Monitor className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  B only
                </TooltipContent>
              </Tooltip>
            </div>

            {/* ── Right: Fullscreen ────────────────────────────── */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
                  onClick={handleToggleFullscreen}
                  aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {fullscreen ? (
                    <Minimize className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {fullscreen ? "Exit fullscreen" : "Fullscreen (F)"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* ── Info strip ──────────────────────────────────────────── */}
        <div className="flex items-center justify-center gap-4 px-4 pb-2">
          <span className="text-[10px] text-white/40 font-mono tabular-nums">
            {formatInfoLine("A", configA, streamAStatus)}
          </span>
          {isSideBySide && (
            <span className="text-[10px] text-white/20">|</span>
          )}
          <span className="text-[10px] text-white/40 font-mono tabular-nums">
            {formatInfoLine("B", configB, streamBStatus)}
          </span>
        </div>
      </motion.div>
    </div>
  );
}
