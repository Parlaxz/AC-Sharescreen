import { useCallback, useState } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  MonitorUp,
  Radio,
  Settings2,
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Lock,
  Unlock,
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
import { toast } from "sonner";
import type { ViewerRequestState } from "./ViewerSettingsPanel.js";
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
  /** Whether ScreenLink audio is locally deafened (for Discord deafen feature) */
  isScreenLinkDeafened?: boolean;
  /** Toggle local ScreenLink audio deafen */
  onToggleScreenLinkDeafen?: () => void;
  /** Current bandwidth in bits per second (for bandwidth display) */
  currentBandwidthBps?: number;
  /** Total bytes received in this session (for bandwidth display) */
  totalBytesReceived?: number;
  /** Discord mute shortcut binding */
  discordMuteBinding?: ShortcutBinding;
  /** Discord deafen shortcut binding */
  discordDeafenBinding?: ShortcutBinding;
  /** Whether Discord deafen should also mute ScreenLink playback */
  syncScreenLinkDeafen?: boolean;
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
  isScreenLinkDeafened = false,
  onToggleScreenLinkDeafen,
  currentBandwidthBps = 0,
  totalBytesReceived = 0,
  discordMuteBinding = { modifiers: ["alt"], key: "M" },
  discordDeafenBinding = { modifiers: ["alt"], key: "D" },
  syncScreenLinkDeafen = true,
}: VideoControlsProps) {
  const handleVolumeSlider = useCallback(
    (value: number[]) => onVolumeChange(value[0]),
    [onVolumeChange],
  );

  // ── Bar lock state (right-click to lock, double-click to unlock) ──
  const [barLocked, setBarLocked] = useState(false);

  const handleBarContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Only lock on right-click of empty space (not on buttons/controls)
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, [role='slider'], [data-radix-portal]")) return;
      e.preventDefault();
      setBarLocked((prev) => !prev);
    },
    [],
  );

  const handleBarDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, [role='slider'], [data-radix-portal]")) return;
      e.preventDefault();
      setBarLocked(false);
    },
    [],
  );

  // ── Discord mute/deafen state ──
  const [discordMuted, setDiscordMuted] = useState(false);
  const [discordDeafened, setDiscordDeafened] = useState(false);

  const formatBindingLabel = useCallback((binding: ShortcutBinding): string => {
    const modifierLabel = binding.modifiers.map((modifier) => modifier[0].toUpperCase() + modifier.slice(1)).join("+");
    return modifierLabel ? `${modifierLabel}+${binding.key}` : binding.key;
  }, []);

  const handleDiscordMute = useCallback(async () => {
    const api = (window as unknown as { screenlink?: { sendShortcut: (binding: ShortcutBinding) => Promise<{ success: boolean; error?: string }> } }).screenlink;
    if (!api?.sendShortcut) {
      toast.error("Discord shortcut bridge is unavailable.");
      return;
    }

    const result = await api.sendShortcut(discordMuteBinding);
    if (!result.success) {
      toast.error(result.error ?? `Failed to send ${formatBindingLabel(discordMuteBinding)}.`);
      return;
    }

    setDiscordMuted((prev) => !prev);
  }, [discordMuteBinding, formatBindingLabel]);

  const handleDiscordDeafen = useCallback(async () => {
    const api = (window as unknown as { screenlink?: { sendShortcut: (binding: ShortcutBinding) => Promise<{ success: boolean; error?: string }> } }).screenlink;
    if (!api?.sendShortcut) {
      toast.error("Discord shortcut bridge is unavailable.");
      return;
    }

    const result = await api.sendShortcut(discordDeafenBinding);
    if (!result.success) {
      toast.error(result.error ?? `Failed to send ${formatBindingLabel(discordDeafenBinding)}.`);
      return;
    }

    const newDeafened = !discordDeafened;
    setDiscordDeafened(newDeafened);
    if (syncScreenLinkDeafen && onToggleScreenLinkDeafen) {
      onToggleScreenLinkDeafen();
    }
  }, [discordDeafened, onToggleScreenLinkDeafen, discordDeafenBinding, formatBindingLabel, syncScreenLinkDeafen]);

  // ── Bandwidth formatting ──
  const formatBandwidth = useCallback((Bps: number): string => {
    if (Bps <= 0) return "0 KB/s";
    const KBps = Bps / 1000;
    if (KBps < 1000) return `${KBps.toFixed(0)} KB/s`;
    return `${(KBps / 1000).toFixed(1)} MB/s`;
  }, []);

  const formatTotalBytes = useCallback((bytes: number): string => {
    if (bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes.toFixed(0)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: barLocked || visible ? 1 : 0, y: barLocked || visible ? 0 : 20 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className={cn(
        "absolute bottom-0 left-0 right-0 z-30",
        "bg-gradient-to-t from-black/80 via-black/50 to-transparent",
      )}
    >
      {/* Control bar */}
      <div
        className={cn(
          "flex items-center justify-center gap-1 px-4 pb-3 pt-8",
          barLocked && "pb-4",
        )}
        onContextMenu={handleBarContextMenu}
        onDoubleClick={handleBarDoubleClick}
      >
        {/* Inner row */}
        <div
          className={cn(
            "flex items-center gap-1 rounded-standard bg-black/60 backdrop-blur-sm px-2 py-1.5 border max-w-3xl w-full",
            barLocked ? "border-accent/50 ring-1 ring-accent/30" : "border-white/10",
          )}
        >
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

          {/* ── Discord controls ──────────────────────────────────── */}
          <span className="w-px h-5 bg-white/10 mx-0.5" />
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-7 w-7 hover:bg-white/10",
                    discordMuted ? "text-white" : "text-white/50",
                  )}
                  onClick={handleDiscordMute}
                  aria-label="Toggle Discord mute"
                >
                  {discordMuted ? (
                    <MicOff className="h-3.5 w-3.5" />
                  ) : (
                    <Mic className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Toggle Discord mute ({formatBindingLabel(discordMuteBinding)})
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-7 w-7 hover:bg-white/10",
                    discordDeafened ? "text-white" : "text-white/50",
                  )}
                  onClick={handleDiscordDeafen}
                  aria-label="Toggle Discord deafen"
                >
                  {discordDeafened ? (
                    <HeadphoneOff className="h-3.5 w-3.5" />
                  ) : (
                    <Headphones className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Toggle Discord deafen ({formatBindingLabel(discordDeafenBinding)}){syncScreenLinkDeafen && isScreenLinkDeafened ? " (+ScreenLink)" : ""}
              </TooltipContent>
            </Tooltip>
          </div>

          {/* ── Spacer ──────────────────────────────────────────── */}
          <div className="flex-1" />

          {/* ── Bandwidth display ────────────────────────────────── */}
          {currentBandwidthBps > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-white/50 font-mono px-1.5 cursor-default select-none tabular-nums">
                  {formatBandwidth(currentBandwidthBps)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Total received: {formatTotalBytes(totalBytesReceived)}
              </TooltipContent>
            </Tooltip>
          )}

          {/* ── Right group: Stream switcher | Connection dot | Settings | Fullscreen ── */}
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

            {/* Connection state dot — click to open diagnostics */}
            <DiagnosticsPanel
              session={session}
              onOpenChange={onPanelsOpenChange}
              lastRequestedQuality={viewerRequest}
              effectiveBitrateKbps={effectiveBitrateKbps}
              configuredBitrateBps={configuredBitrateBps}
            >
              <button
                className="flex items-center gap-1.5 px-1.5 cursor-pointer hover:opacity-80 transition-opacity"
                aria-label={`Connection: ${STATE_LABELS[connectionState]} — click for diagnostics`}
                title={`${STATE_LABELS[connectionState]} — click for diagnostics`}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    STATE_DOT_CLASSES[connectionState],
                  )}
                />
              </button>
            </DiagnosticsPanel>

            {/* Separator */}
            <span className="w-px h-5 bg-white/10 mx-0.5" />

            {/* Settings cog */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
                  onClick={() => window.dispatchEvent(new CustomEvent("screenlink:viewer-toggle-settings"))}
                  aria-label="Viewer settings"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Settings (S)
              </TooltipContent>
            </Tooltip>

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

            {/* Bar lock indicator */}
            {barLocked && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center text-accent/70 ml-0.5">
                    <Lock className="h-3 w-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Controls locked — double-click empty space to unlock
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* Settings popover remains mounted (hidden)
              so keyboard events (S) and header button dispatches work.
              PopoverContent portals to document.body so it's visible. */}
          <div className="absolute opacity-0 pointer-events-none overflow-hidden w-0 h-0" aria-hidden="true">
            <ViewerSettingsPanel
              requestState={viewerRequest}
              onRequestChange={onQualityRequestChange}
              requestPending={qualityRequestPending}
              lastRequestAccepted={lastQualityAccepted}
              requestFeedback={qualityFeedback}
              onOpenChange={onPanelsOpenChange}
            >
              <span />
            </ViewerSettingsPanel>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Re-export types ───────────────────────────────────────────────────────
export type { ViewerRequestState } from "./ViewerSettingsPanel.js";

// ─── Shortcut binding type ─────────────────────────────────────────────────

export type ShortcutBinding = {
  modifiers: Array<"alt" | "ctrl" | "shift" | "win">;
  key: string;
};
