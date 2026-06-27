import { useCallback } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  MonitorUp,
  Radio,
} from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DisplayMode, ViewerRequestState } from "./ViewerSettingsPanel.js";
import { ViewerSettingsPanel } from "./ViewerSettingsPanel.js";
import { DiagnosticsPanel } from "./DiagnosticsPanel.js";
import { StreamSwitcher } from "./StreamSwitcher.js";
import type { StreamAnnouncement } from "@/stores/main-store";
import type { ViewerSession } from "@/services/viewer-session.js";

// ─── Connection state indicator ──────────────────────────────────────────

type ConnectionState = "connecting" | "connected" | "degraded" | "reconnecting" | "ended" | "error";

const STATE_DOT_CLASSES: Record<ConnectionState, string> = {
  connecting: "bg-warning",
  connected: "bg-success",
  degraded: "bg-warning",
  reconnecting: "bg-warning",
  ended: "bg-text-muted",
  error: "bg-danger",
};

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  degraded: "Degraded",
  reconnecting: "Reconnecting",
  ended: "Stream ended",
  error: "Error",
};

// ─── Props ────────────────────────────────────────────────────────────────

interface VideoControlsProps {
  /** Whether playback is paused (only meaningful for recordings/VOD) */
  isPaused: boolean;
  /** Toggle play/pause */
  onTogglePlay: () => void;
  /** Current volume 0–1 */
  volume: number;
  /** Whether audio is muted */
  isMuted: boolean;
  /** Set volume 0–1 */
  onVolumeChange: (v: number) => void;
  /** Toggle mute */
  onToggleMute: () => void;
  /** Current viewer request state (null = no request = host defaults) */
  viewerRequest: ViewerRequestState | null;
  /** Called when the user changes their quality request */
  onQualityRequestChange: (state: ViewerRequestState | null) => void;
  /** Whether a quality request is pending */
  qualityRequestPending?: boolean;
  /** Feedback message from last request */
  qualityFeedback?: string | null;
  /** Whether the last request was accepted */
  lastQualityAccepted?: boolean;
  /** Effective bitrate kbps from host feedback (for diagnostics) */
  effectiveBitrateKbps?: number | null;
  /** Configured sender max bitrate in bps (for diagnostics) */
  configuredBitrateBps?: number | null;
  /** Display mode for video element (fit/fill/actual) */
  displayMode?: DisplayMode;
  /** Called when display mode changes */
  onDisplayModeChange?: (mode: DisplayMode) => void;
  /** Currently selected stream ID */
  currentStreamId: string;
  /** Called when switching streams */
  onStreamSwitch: (stream: StreamAnnouncement) => void;
  /** Connection state for the indicator */
  connectionState: ConnectionState;
  /** Whether fullscreen is active */
  isFullscreen: boolean;
  /** Toggle fullscreen */
  onToggleFullscreen: () => void;
  /** Exit viewer */
  onExit: () => void;
  /** Controls visibility (for auto-hide) */
  visible: boolean;
  /** Whether this is a live stream (vs VOD/recording) */
  isLive: boolean;
  /** Active ViewerSession for diagnostics polling */
  session?: ViewerSession | null;
  /** Called when any popover panel opens or closes (keeps controls visible) */
  onPanelsOpenChange?: (open: boolean) => void;
}

// ─── VideoControls ────────────────────────────────────────────────────────

/**
 * VideoControls — Bottom control bar for the viewer (Section 8.5).
 *
 * Button order: Exit viewer | Settings cog | Information icon | Fullscreen
 *
 * Composed from: Button (icon-only with Tooltip), Slider, Badge,
 * ViewerSettingsPanel (quality), DiagnosticsPanel (real stats),
 * StreamSwitcher.
 *
 * Auto-hide is handled externally via the `visible` prop (framer-motion
 * AnimatePresence in ViewerWorkspace). Controls stay visible while any
 * popover/panel is open or a control is focused.
 */
export function VideoControls({
  isPaused,
  onTogglePlay,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  viewerRequest,
  onQualityRequestChange,
  qualityRequestPending = false,
  qualityFeedback = null,
  lastQualityAccepted,
  effectiveBitrateKbps = null,
  configuredBitrateBps = null,
  displayMode = "fit",
  onDisplayModeChange,
  currentStreamId,
  onStreamSwitch,
  connectionState,
  isFullscreen,
  onToggleFullscreen,
  onExit,
  visible,
  isLive,
  session = null,
  onPanelsOpenChange,
}: VideoControlsProps) {
  const handleVolumeSlider = useCallback(
    (value: number[]) => onVolumeChange(value[0]),
    [onVolumeChange],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : 20 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className={cn(
        "absolute bottom-0 left-0 right-0 z-30",
        "bg-gradient-to-t from-black/80 via-black/50 to-transparent",
      )}
    >
      {/* Control bar */}
      <div className="flex items-center justify-center gap-1 px-4 pb-3 pt-8">
        {/* Inner row */}
        <div className="flex items-center gap-1 rounded-standard bg-black/60 backdrop-blur-sm px-2 py-1.5 border border-white/10 max-w-2xl w-full">
          {/* ── Left group: Play/Pause or Live badge ─────────────── */}
          <div className="flex items-center gap-1">
            {isLive ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="success"
                    className="text-[10px] px-2 py-0.5 leading-none cursor-default select-none"
                  >
                    <Radio className="h-2.5 w-2.5 mr-1 inline" />
                    Live
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top">
                  This stream is live — playback controls are not available
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-white hover:bg-white/10"
                    onClick={onTogglePlay}
                    aria-label={isPaused ? "Play" : "Pause"}
                  >
                    {isPaused ? (
                      <Play className="h-3.5 w-3.5" />
                    ) : (
                      <Pause className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isPaused ? "Play" : "Pause"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* ── Volume control ──────────────────────────────────── */}
          <div className="flex items-center gap-1.5 min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
                  onClick={onToggleMute}
                  aria-label={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="h-3.5 w-3.5" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {isMuted ? "Unmute" : "Mute"}
              </TooltipContent>
            </Tooltip>

            <div className="hidden sm:block w-20">
              <Slider
                value={[isMuted ? 0 : volume * 100]}
                onValueChange={(v) => handleVolumeSlider([v[0] / 100])}
                max={100}
                step={1}
                aria-label="Volume"
                className="[&>div]:h-1"
              />
            </div>
          </div>

          {/* ── Spacer ──────────────────────────────────────────── */}
          <div className="flex-1" />

          {/* ── Right group: Stream switcher | Connection | Fullscreen ── */}
          <div className="flex items-center gap-1">
            {/* Stream switcher */}
            <StreamSwitcher
              currentStreamId={currentStreamId}
              onSwitch={onStreamSwitch}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
                    aria-label="Switch stream"
                  >
                    <MonitorUp className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Switch stream
                </TooltipContent>
              </Tooltip>
            </StreamSwitcher>

            {/* Connection state */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5 px-1.5 cursor-default">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      STATE_DOT_CLASSES[connectionState],
                    )}
                  />
                  <span className="text-[11px] text-white/60 hidden sm:inline">
                    {STATE_LABELS[connectionState]}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Connection: {STATE_LABELS[connectionState]}
              </TooltipContent>
            </Tooltip>

            {/* Separator */}
            <span className="w-px h-5 bg-white/10 mx-0.5" />

            {/* Fullscreen */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
                  onClick={onToggleFullscreen}
                  aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? (
                    <Minimize className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Settings and Diagnostics popovers remain mounted (hidden)
              so keyboard events (S, I) and header button dispatches work.
              PopoverContent portals to document.body so it's visible. */}
          <div className="absolute opacity-0 pointer-events-none overflow-hidden w-0 h-0" aria-hidden="true">
            <ViewerSettingsPanel
              requestState={viewerRequest}
              onRequestChange={onQualityRequestChange}
              requestPending={qualityRequestPending}
              lastRequestAccepted={lastQualityAccepted}
              requestFeedback={qualityFeedback}
              displayMode={displayMode}
              onDisplayModeChange={onDisplayModeChange}
              onOpenChange={onPanelsOpenChange}
            >
              <span />
            </ViewerSettingsPanel>

            <DiagnosticsPanel
              session={session}
              onOpenChange={onPanelsOpenChange}
              lastRequestedQuality={viewerRequest}
              effectiveBitrateKbps={effectiveBitrateKbps}
              configuredBitrateBps={configuredBitrateBps}
            >
              <span />
            </DiagnosticsPanel>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Re-export types ───────────────────────────────────────────────────────
export type { ViewerRequestState, DisplayMode } from "./ViewerSettingsPanel.js";
