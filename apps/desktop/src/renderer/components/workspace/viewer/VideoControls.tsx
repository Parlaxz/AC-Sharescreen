import { useCallback, useState } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  MonitorUp,
  Settings2,
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Lock,
  Unlock,
  VideoOff,
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
import { StreamSwitcher } from "./StreamSwitcher.js";
import type { StreamAnnouncement } from "@/stores/main-store";
import type { ActivePanel } from "./ViewerPanelShell.js";

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
  /**
   * Whether the live stream is user-paused (media stopped, signaling alive).
   * Only meaningful for live streams — replaces the "Live" badge with a
   * pause/resume button.
   */
  isStreamPaused?: boolean;
  /**
   * True while a pause/resume async operation is in flight.
   * Disables the button to prevent overlapping calls.
   */
  isStreamPauseTransitioning?: boolean;
  /** Toggle live-stream pause/resume. Called by button click and Space key. */
  onToggleStreamPause?: () => void;
  /** Current volume 0–1 */
  volume: number;
  /** Whether audio is muted */
  isMuted: boolean;
  /** Set volume 0–1 */
  onVolumeChange: (v: number) => void;
  /** Toggle mute */
  onToggleMute: () => void;
  /** Currently selected stream ID */
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
  /** Maximum volume percentage for the slider (default 100; >100 enables audio boost) */
  maxVolumePercent?: number;
  /** Current active panel in the unified popover shell */
  activePanel: ActivePanel | null;
  /** Called when the user toggles a panel */
  onActivePanelChange: (panel: ActivePanel | null) => void;

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
  /** Called when the user clicks the Compare button */
  onCompareToggle?: () => void;
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
  isStreamPaused = false,
  isStreamPauseTransitioning = false,
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
  visible,
  isLive,
  maxVolumePercent = 200,
  activePanel,
  onActivePanelChange,
  isScreenLinkDeafened = false,
  onToggleScreenLinkDeafen,
  currentBandwidthBps = 0,
  totalBytesReceived = 0,
  discordMuteBinding = { modifiers: ["alt"], key: "M" },
  discordDeafenBinding = { modifiers: ["alt"], key: "D" },
  syncScreenLinkDeafen = true,
  onCompareToggle,
}: VideoControlsProps) {
  const handleVolumeSlider = useCallback(
    (value: number[]) => onVolumeChange(value[0]),
    [onVolumeChange],
  );

  // ── Volume percentage for display ──
  const volumePercent = isMuted ? 0 : Math.round(volume * 100);
  const volumeTooltip = `${volumePercent}%`;

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
  const formatBandwidth = useCallback((bps: number): string => {
    if (bps <= 0) return "0 kbps";
    if (bps < 1_000_000) return `${Math.round(bps / 1000)} kbps`;
    return `${(bps / 1_000_000).toFixed(1)} Mbps`;
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
          {/* ── Left group: Play/Pause or Live pause/resume ────── */}
          <div className="flex items-center gap-1">
            {isLive ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-white hover:bg-white/10"
                    onClick={onToggleStreamPause}
                    disabled={isStreamPauseTransitioning}
                    aria-label={isStreamPaused ? "Resume stream" : "Pause stream"}
                  >
                    {isStreamPaused ? (
                      <Play className="h-3.5 w-3.5" />
                    ) : (
                      <Pause className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isStreamPaused ? "Resume (Space)" : "Pause (Space)"}
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
                value={[isMuted ? 0 : Math.min(volume * 100, maxVolumePercent)]}
                onValueChange={(v) => handleVolumeSlider([v[0] / 100])}
                max={maxVolumePercent}
                step={1}
                aria-label="Volume"
                className="[&>div]:h-1"
                thumbTooltip={volumeTooltip}
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
                <span className="text-[10px] text-white/50 font-mono px-1.5 cursor-pointer select-none tabular-nums" onClick={() => onActivePanelChange(activePanel === "bandwidth" ? null : "bandwidth")}>
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
            <button
              className="flex items-center gap-1.5 px-1.5 cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => onActivePanelChange(activePanel === "diagnostics" ? null : "diagnostics")}
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

            {/* Separator */}
            <span className="w-px h-5 bg-white/10 mx-0.5" />

            {/* Compare (only when onCompareToggle is provided) */}
            {onCompareToggle && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10 data-[state=active]:text-accent data-[state=active]:bg-accent/10"
                    onClick={onCompareToggle}
                    aria-label="Toggle A/B compare mode"
                  >
                    <span className="text-[11px] font-bold leading-none">A/B</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Compare (C)
                </TooltipContent>
              </Tooltip>
            )}

            {/* Settings cog */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
                  onClick={() => onActivePanelChange(activePanel === "settings" ? null : "settings")}
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
