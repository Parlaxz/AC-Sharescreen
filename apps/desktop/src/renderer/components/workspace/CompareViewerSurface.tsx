// SPDX-License-Identifier: MIT
/**
 * CompareViewerSurface — Viewer-side A/B compare with vertical wipe.
 *
 * Renders a single video source through two independent GPU enhancement
 * pipelines (A and B). The user can toggle between side-a, side-b, or
 * a vertical wipe divider using CSS clip-path.
 *
 * Key design:
 * - One video source, one audio path, one ViewerSession.
 * - Two processing outputs (EnhancedVideoSurface) mounted simultaneously.
 * - Switching between A and B is instant (no reconnect).
 * - Vertical wipe with pointer capture + keyboard slider.
 * - DOM-compositable presentation (native presenter disabled for compare).
 * - Only one side may use NVIDIA at a time when helper is single-config.
 */

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
import type { ViewerImageEnhancementSettings, ProcessingBackend } from "@/services/viewer-image-processing/viewer-image-settings";
import type { ProcessorState, ProcessorStats } from "@/services/viewer-image-processing/viewer-image-processor";
import { EnhancedVideoSurface } from "@/components/workspace/viewer/EnhancedVideoSurface";
import type { ProcessorAPI } from "@/services/viewer-image-processing/processor-api";

// ─── Types ─────────────────────────────────────────────────────────────────

export type CompareDisplayMode = "side-a" | "side-b" | "vertical-wipe";

export interface CompareViewerSurfaceProps {
  /** The shared source <video> element */
  videoElement: HTMLVideoElement | null;
  /** Settings for variant A (from standard persistence) */
  settingsA: ViewerImageEnhancementSettings;
  /** Settings for variant B (from separate B persistence) */
  settingsB: ViewerImageEnhancementSettings;
  /** Called when user exits compare mode */
  onExit: () => void;
  /** Called when fullscreen state changes */
  onFullscreenChange?: (isFullscreen: boolean) => void;
  /** Whether the stream is paused */
  paused: boolean;
  /** Called to toggle pause */
  onTogglePause?: () => void;

  // Processing telemetry
  onStatsUpdateA?: (stats: ProcessorStats) => void;
  onStatsUpdateB?: (stats: ProcessorStats) => void;
  onProcessorStateChangeA?: (state: ProcessorState) => void;
  onProcessorStateChangeB?: (state: ProcessorState) => void;

  // Benchmark integration (passed through to EnhancedVideoSurface)
  processorApiRefA?: React.MutableRefObject<ProcessorAPI | null>;
  processorApiRefB?: React.MutableRefObject<ProcessorAPI | null>;
}

// ─── Auto-hide timeout hook ────────────────────────────────────────────────

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

// ─── Wipe Controller ──────────────────────────────────────────────────────
// Manages the vertical divider position with pointer capture and keyboard.

function useWipeController() {
  const [dividerPosition, setDividerPosition] = useState(0.5);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const clamp = (value: number) => Math.max(0, Math.min(1, value));

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const x = (e.clientX - rect.left) / rect.width;
    setDividerPosition(clamp(x));
  }, []);

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width;
    setDividerPosition(clamp(x));
  }, []);

  const handlePointerUp = useCallback((e?: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    setDividerPosition((prev) => {
      const delta = e.deltaY > 0 ? -0.02 : 0.02;
      return clamp(prev + delta);
    });
  }, []);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = 0.03;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      setDividerPosition((prev) => clamp(prev - step));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      setDividerPosition((prev) => clamp(prev + step));
    } else if (e.key === "Home") {
      setDividerPosition(0);
    } else if (e.key === "End") {
      setDividerPosition(1);
    }
  }, []);

  const centerDivider = useCallback(() => {
    setDividerPosition(0.5);
  }, []);

  return {
    dividerPosition,
    containerRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleWheel,
    handleKeyDown,
    centerDivider,
  };
}

// ─── NVIDIA single-config validation ───────────────────────────────────────

/**
 * Enforce that only one side may use NVIDIA per processing backend.
 * When helper is single-config (nvidia-vsr), only one EnhancedVideoSurface
 * may be active with nvidia-vsr at a time.
 */
export function getEffectiveBackend(
  settings: ViewerImageEnhancementSettings,
  otherSideBackend: ProcessingBackend | null,
): { effectiveBackend: ProcessingBackend; nvidiaForcedOff: boolean } {
  if (settings.processingBackend !== "nvidia-vsr") {
    return { effectiveBackend: settings.processingBackend, nvidiaForcedOff: false };
  }
  // If the other side is already using nvidia-vsr, this side must fall back to webgl2
  if (otherSideBackend === "nvidia-vsr") {
    return { effectiveBackend: "webgl2", nvidiaForcedOff: true };
  }
  return { effectiveBackend: "nvidia-vsr", nvidiaForcedOff: false };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CompareViewerSurface({
  videoElement,
  settingsA,
  settingsB,
  onExit,
  onFullscreenChange,
  paused,
  onTogglePause,
  onStatsUpdateA,
  onStatsUpdateB,
  onProcessorStateChangeA,
  onProcessorStateChangeB,
  processorApiRefA,
  processorApiRefB,
}: CompareViewerSurfaceProps): ReactElement {
  // ── Layout mode ─────────────────────────────────────────────────
  const [displayMode, setDisplayMode] = useState<CompareDisplayMode>("vertical-wipe");
  const [fullscreen, setFullscreen] = useState(false);
  const [forceDisabled, setForceDisabled] = useState(false);

  // ── Wipe state ──────────────────────────────────────────────────
  const {
    dividerPosition,
    containerRef: wipeContainerRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleWheel,
    handleKeyDown,
    centerDivider,
  } = useWipeController();

  useEffect(() => {
    const handleMode = (event: Event) => {
      const detail = (event as CustomEvent<CompareDisplayMode>).detail;
      if (detail === "side-a" || detail === "side-b" || detail === "vertical-wipe") {
        setDisplayMode(detail);
      }
    };
    const handleCenter = () => centerDivider();
    window.addEventListener("screenlink:compare-mode", handleMode as EventListener);
    window.addEventListener("screenlink:compare-center", handleCenter);
    return () => {
      window.removeEventListener("screenlink:compare-mode", handleMode as EventListener);
      window.removeEventListener("screenlink:compare-center", handleCenter);
    };
  }, [centerDivider]);

  // ── NVIDIA enforcement: only one side may use NVIDIA at a time ──
  const backendA = settingsA.processingBackend;
  const backendB = settingsB.processingBackend;
  const enforcedA = getEffectiveBackend(settingsA, backendB === "nvidia-vsr" ? "nvidia-vsr" : null);
  const enforcedB = getEffectiveBackend(settingsB, enforcedA.effectiveBackend === "nvidia-vsr" ? "nvidia-vsr" : null);
  const effectiveSettingsA = useMemo(() => ({
    ...settingsA,
    processingBackend: enforcedA.effectiveBackend,
  }), [settingsA, enforcedA.effectiveBackend]);
  const effectiveSettingsB = useMemo(() => ({
    ...settingsB,
    processingBackend: enforcedB.effectiveBackend,
  }), [settingsB, enforcedB.effectiveBackend]);

  // ── Auto-hide controls ───────────────────────────────────────────
  const { visible: controlsVisible, show: showControls, hide: hideControls } =
    useControlsAutoHide({ delayMs: 3000 });

  // ── Fullscreen toggle ──────────────────────────────────────────
  const handleToggleFullscreen = useCallback(() => {
    const api = (
      window as unknown as {
        screenlink?: {
          toggleFullscreen: () => Promise<boolean>;
          onFullscreenChanged?: (cb: (isFullscreen: boolean) => void) => () => void;
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

  // ── Fullscreen change listener ──────────────────────────────────
  useEffect(() => {
    const api = (
      window as unknown as {
        screenlink?: { onFullscreenChanged: (cb: (isFullscreen: boolean) => void) => () => void };
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

  // ── Display mode helpers ─────────────────────────────────────────
  //
  // Presentation-only: these styles affect visibility/layering only.
  // Both processing surfaces remain mounted in all modes.
  const showWipe = displayMode === "vertical-wipe";
  const showA = displayMode === "side-a";
  const showB = displayMode === "side-b";

  // Vertical compare: A is full baseline (no clip), B is clipped at divider.
  // Single-side modes: use opacity/pointer-events to hide the non-selected
  // side (never fully clip or display:none a processing surface).
  const layerStyleA = useMemo(() => {
    if (showWipe) return {}; // Full baseline — no clip
    if (showA) return {}; // Fully visible
    return { opacity: 0, pointerEvents: "none" as const }; // Invisible but mounted
  }, [showWipe, showA]);

  const layerStyleB = useMemo(() => {
    if (showWipe) return { clipPath: `inset(0 0 0 ${dividerPosition * 100}%)` };
    if (showB) return {}; // Fully visible
    return { opacity: 0, pointerEvents: "none" as const }; // Invisible but mounted
  }, [showWipe, showB, dividerPosition]);

  // Wipe handle style
  const handleStyle = showWipe
    ? { left: `${dividerPosition * 100}%` }
    : { display: "none" };

  // ── Pause overlay ─────────────────────────────────────────────────
  const showPauseOverlay = paused;

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div
      ref={wipeContainerRef}
      className="relative h-full w-full overflow-hidden bg-black select-none"
      data-compare-viewer
      onMouseMove={showControls}
      onMouseEnter={showControls}
      onMouseLeave={hideControls}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => { e.preventDefault(); handleToggleFullscreen(); }}
      tabIndex={0}
      role="application"
      aria-label="Video comparison viewer"
    >
      {/* ── Video Stage ─────────────────────────────────────────── */}
      <div className="absolute inset-0">
        {/* Persistent raw video underlay — always present in compare mode */}
        {videoElement && (
          <video
            ref={(el) => {
              if (el && videoElement.srcObject) {
                el.srcObject = videoElement.srcObject;
              }
            }}
            className="absolute inset-0 w-full h-full object-contain"
            autoPlay
            playsInline
            muted
            aria-label="Source video underlay"
          />
        )}

        {/* Variant A — overlays full area, styled per display mode */}
        <div className="absolute inset-0" style={layerStyleA}>
          <div className="relative w-full h-full bg-black">
            <EnhancedVideoSurface
              videoElement={videoElement}
              enabled
              presentationMode="dom-only"
              settings={effectiveSettingsA}
              className="w-full h-full"
              onStatsUpdate={onStatsUpdateA}
              onProcessorStateChange={onProcessorStateChangeA}
              processorApiRef={processorApiRefA}
            />

            {/* Label overlay — top-left */}
            <div
              className={cn(
                "absolute top-3 left-3 z-10 px-2 py-1 rounded text-[11px] font-medium pointer-events-none",
                "bg-black/60 text-white/90 backdrop-blur-sm border border-white/10",
              )}
            >
              {`A ${enforcedA.nvidiaForcedOff ? "(NVIDIA off)" : ""}`}
            </div>
          </div>
        </div>

        {/* Variant B — overlays full area, styled per display mode */}
        <div className="absolute inset-0" style={layerStyleB}>
          <div className="relative w-full h-full bg-black">
            <EnhancedVideoSurface
              videoElement={videoElement}
              enabled
              presentationMode="dom-only"
              settings={effectiveSettingsB}
              className="w-full h-full"
              onStatsUpdate={onStatsUpdateB}
              onProcessorStateChange={onProcessorStateChangeB}
              processorApiRef={processorApiRefB}
            />

            {/* Label overlay — top-left */}
            <div
              className={cn(
                "absolute top-3 left-3 z-10 px-2 py-1 rounded text-[11px] font-medium pointer-events-none",
                "bg-black/60 text-white/90 backdrop-blur-sm border border-white/10",
              )}
            >
              {`B ${enforcedB.nvidiaForcedOff ? "(NVIDIA off)" : ""}`}
            </div>
          </div>
        </div>

        {/* ── Wipe handle ──────────────────────────────────────────── */}
        {showWipe && (
          <div
            className="absolute top-0 bottom-0 z-20 w-1 bg-white/60 cursor-col-resize -translate-x-px pointer-events-none"
            style={handleStyle}
            role="slider"
            aria-label="Comparison divider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(dividerPosition * 100)}
          >
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-12 rounded-md bg-white/80 flex items-center justify-center shadow-lg pointer-events-auto cursor-col-resize">
              <svg width="12" height="20" viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4L8 10L4 16" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M8 4L4 10L8 16" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5"/>
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* ── Pause overlay ───────────────────────────────────────── */}
      {showPauseOverlay && (
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
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 bg-black/60 backdrop-blur-sm border-white/10 text-white/80 hover:text-white hover:bg-white/10"
          onClick={onExit}
          aria-label="Exit compare mode"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span className="text-[11px]">Exit Compare</span>
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
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-center gap-2 px-4 pb-3 pt-8">
          <div className="flex items-center gap-1 rounded-standard bg-black/60 backdrop-blur-sm px-2 py-1.5 border border-white/10 max-w-3xl w-full">
            {/* ── Play/Pause ──────────────────────────────────────── */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-white hover:bg-white/10"
                  onClick={onTogglePause}
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

            {/* ── Mode toggle ────────────────────────────────────── */}
            <div className="flex items-center gap-0.5 mx-auto">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-7 w-7",
                      displayMode === "side-a"
                        ? "text-accent bg-accent/10"
                        : "text-white/60 hover:text-white hover:bg-white/10",
                    )}
                    onClick={() => setDisplayMode("side-a")}
                    aria-label="Show variant A only"
                  >
                    <span className="text-[11px] font-bold">A</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Variant A</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-7 w-7",
                      displayMode === "vertical-wipe"
                        ? "text-accent bg-accent/10"
                        : "text-white/60 hover:text-white hover:bg-white/10",
                    )}
                    onClick={() => setDisplayMode("vertical-wipe")}
                    aria-label="Vertical compare"
                  >
                    <Columns className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Vertical Compare</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-7 w-7",
                      displayMode === "side-b"
                        ? "text-accent bg-accent/10"
                        : "text-white/60 hover:text-white hover:bg-white/10",
                    )}
                    onClick={() => setDisplayMode("side-b")}
                    aria-label="Show variant B only"
                  >
                    <span className="text-[11px] font-bold">B</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Variant B</TooltipContent>
              </Tooltip>
            </div>

            {/* ── Fullscreen ────────────────────────────────────── */}
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
                {fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* ── Info strip ──────────────────────────────────────────── */}
        <div className="flex items-center justify-center gap-4 px-4 pb-2">
          <span className="text-[10px] text-white/40 font-mono tabular-nums">
            {displayMode === "side-b" ? "B" : `A ${enforcedA.nvidiaForcedOff ? "(webgl2)" : ""}`}
          </span>
          {showWipe && (
            <span className="text-[10px] text-white/20">
              | {Math.round(dividerPosition * 100)}%
            </span>
          )}
          <span className="text-[10px] text-white/40 font-mono tabular-nums">
            {displayMode === "side-a" ? "A" : `B ${enforcedB.nvidiaForcedOff ? "(webgl2)" : ""}`}
          </span>
        </div>
      </motion.div>
    </div>
  );
}
