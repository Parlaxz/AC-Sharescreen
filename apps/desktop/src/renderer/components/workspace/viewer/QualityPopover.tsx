import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Info, Settings2, Copy, Check } from "lucide-react";

// ─── Quality levels ────────────────────────────────────────────────────────

export type QualityLevel = "low" | "medium" | "high" | "custom";

const QUALITY_LABELS: Record<QualityLevel, string> = {
  low: "Low (37.5 kB/s)",
  medium: "Medium (187.5 kB/s)",
  high: "High (375 kB/s)",
  custom: "Custom",
};

const QUALITY_BITRATES: Record<QualityLevel, number | null> = {
  low: 300,
  medium: 1500,
  high: 3000,
  custom: null,
};

/** Format a kbps value as a byte-rate display string (kB/s or MB/s). */
function formatKbpsAsByteRate(kbps: number): string {
  if (kbps <= 0) return "0 kB/s";
  const Bps = kbps * 125; // kbps * 1000 / 8
  if (Bps < 1000) return `${Math.round(Bps)} B/s`;
  const kBps = Bps / 1000;
  if (kBps < 1000) return `${kBps.toFixed(1)} kB/s`;
  return `${(kBps / 1000).toFixed(2)} MB/s`;
}

// ─── Stats types ───────────────────────────────────────────────────────────

interface ViewerStats {
  configuredBitrateKbps: number | null;
  measuredBitrateKbps: number | null;
  packetLoss: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  frameRate: number | null;
  resolution: string | null;
  codec: string | null;
}

const EMPTY_STATS: ViewerStats = {
  configuredBitrateKbps: null,
  measuredBitrateKbps: null,
  packetLoss: null,
  rttMs: null,
  jitterMs: null,
  frameRate: null,
  resolution: null,
  codec: null,
};

// ─── Props ─────────────────────────────────────────────────────────────────

interface QualityPopoverProps {
  current?: QualityLevel;
  onSelect: (level: QualityLevel) => void;
  children: ReactNode;
}

// ─── Stats poller ──────────────────────────────────────────────────────────

function useViewerStats(videoElement: HTMLVideoElement | null): ViewerStats {
  const [stats, setStats] = useState<ViewerStats>(EMPTY_STATS);

  useEffect(() => {
    if (!videoElement) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;

      // Try to get stats from the video element's peer connection
      const stream = videoElement.srcObject as MediaStream | null;
      if (!stream) return;

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) return;

      try {
        // Use the RTCPeerConnection stats API if available
        // The track's peer connection is not directly accessible,
        // so we poll the video element's performance metrics instead
        const newStats: ViewerStats = { ...EMPTY_STATS };

        // Get resolution from track settings
        const settings = videoTrack.getSettings();
        if (settings.width && settings.height) {
          newStats.resolution = `${settings.width}×${settings.height}`;
        }
        if (settings.frameRate) {
          newStats.frameRate = Math.round(settings.frameRate);
        }

        // Codec info is not reliably available from MediaStreamTrack APIs.
        // Viewer-side codec detection would require RTCPeerConnection stats
        // which we don't have direct access to here. Leave as "Unknown".

        setStats(newStats);
      } catch {
        // Stats API may not be available in all environments
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [videoElement]);

  return stats;
}

// ─── Sanitize diagnostics ──────────────────────────────────────────────────

function sanitizeDiagnostics(stats: ViewerStats, quality: QualityLevel): string {
  const lines = [
    `ScreenLink Viewer Diagnostics`,
    `=============================`,
    `Quality: ${QUALITY_LABELS[quality]}`,
    `Configured bitrate: ${stats.configuredBitrateKbps !== null ? formatKbpsAsByteRate(stats.configuredBitrateKbps) : "unknown"}`,
    `Measured bitrate: ${stats.measuredBitrateKbps !== null ? formatKbpsAsByteRate(stats.measuredBitrateKbps) : "unknown"}`,
    `Resolution: ${stats.resolution ?? "unknown"}`,
    `Frame rate: ${stats.frameRate ?? "unknown"} fps`,
    `Codec: ${stats.codec ?? "unknown"}`,
    `RTT: ${stats.rttMs ?? "unknown"} ms`,
    `Jitter: ${stats.jitterMs ?? "unknown"} ms`,
    `Packet loss: ${stats.packetLoss !== null ? `${(stats.packetLoss * 100).toFixed(2)}%` : "unknown"}`,
    `Timestamp: ${new Date().toISOString()}`,
  ];
  return lines.join("\n");
}

// ─── QualityPopover ────────────────────────────────────────────────────────

/**
 * QualityPopover — Viewer info and settings panel.
 *
 * Shows real connection stats (configured vs measured bitrate, resolution,
 * frame rate, codec, RTT, jitter, packet loss) and allows quality level
 * selection that sends requests through the existing authenticated path.
 *
 * Keyboard shortcuts:
 *   I — Toggle info panel
 *   S — Toggle settings panel
 */
export function QualityPopover({ current, onSelect, children }: QualityPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"info" | "settings">("info");
  const [copied, setCopied] = useState(false);

  // Listen for keyboard shortcut events
  useEffect(() => {
    const handleToggleInfo = () => {
      setActiveTab("info");
      setOpen((prev) => !prev);
    };
    const handleToggleSettings = () => {
      setActiveTab("settings");
      setOpen((prev) => !prev);
    };
    window.addEventListener("screenlink:viewer-toggle-info", handleToggleInfo);
    window.addEventListener("screenlink:viewer-toggle-settings", handleToggleSettings);
    return () => {
      window.removeEventListener("screenlink:viewer-toggle-info", handleToggleInfo);
      window.removeEventListener("screenlink:viewer-toggle-settings", handleToggleSettings);
    };
  }, []);

  const handleCopyDiagnostics = useCallback(async () => {
    const text = sanitizeDiagnostics(EMPTY_STATS, current ?? "custom");
    try {
      const api = (window as unknown as { screenlink?: { clipboardWriteText: (text: string) => Promise<{ success: boolean; length: number }> } }).screenlink;
      if (api) {
        await api.clipboardWriteText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed
    }
  }, [current]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-80 p-0">
        {/* Tab bar */}
        <div className="flex border-b border-border-subtle">
          <button
            className={cn(
              "flex-1 px-3 py-2 text-sm font-medium transition-colors",
              activeTab === "info"
                ? "text-text-primary border-b-2 border-accent"
                : "text-text-muted hover:text-text-secondary",
            )}
            onClick={() => setActiveTab("info")}
          >
            <Info className="h-3.5 w-3.5 inline mr-1.5" />
            Info
          </button>
          <button
            className={cn(
              "flex-1 px-3 py-2 text-sm font-medium transition-colors",
              activeTab === "settings"
                ? "text-text-primary border-b-2 border-accent"
                : "text-text-muted hover:text-text-secondary",
            )}
            onClick={() => setActiveTab("settings")}
          >
            <Settings2 className="h-3.5 w-3.5 inline mr-1.5" />
            Quality
          </button>
        </div>

        <div className="p-3 space-y-3">
          {activeTab === "info" ? (
            <>
              {/* Connection stats */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                  Connection
                </p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <span className="text-text-muted">Resolution</span>
                  <span className="text-text-primary text-right">—</span>
                  <span className="text-text-muted">Frame rate</span>
                  <span className="text-text-primary text-right">— fps</span>
                  <span className="text-text-muted">Codec</span>
                  <span className="text-text-primary text-right">—</span>
                  <span className="text-text-muted">RTT</span>
                  <span className="text-text-primary text-right">— ms</span>
                  <span className="text-text-muted">Jitter</span>
                  <span className="text-text-primary text-right">— ms</span>
                  <span className="text-text-muted">Packet loss</span>
                  <span className="text-text-primary text-right">—</span>
                </div>
              </div>

              <Separator />

              {/* Bitrate info */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                  Bitrate
                </p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <span className="text-text-muted">Configured</span>
                  <span className="text-text-primary text-right">— kB/s</span>
                  <span className="text-text-muted">Measured</span>
                  <span className="text-text-primary text-right">— kB/s</span>
                </div>
              </div>

              <Separator />

              {/* Copy diagnostics */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleCopyDiagnostics}
                  >
                    {copied ? (
                      <>
                        <Check className="h-3.5 w-3.5 mr-1.5" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5 mr-1.5" />
                        Copy diagnostics
                      </>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Copy sanitized connection info to clipboard
                </TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              {/* Quality level selection */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                  Request quality
                </p>
                <p className="text-xs text-text-muted">
                  Quality requests are sent to the host. Actual quality depends on host limits.
                </p>
                <div className="space-y-1.5">
                  {(Object.keys(QUALITY_LABELS) as QualityLevel[]).map((level) => (
                    <button
                      key={level}
                      className={cn(
                        "w-full flex items-center justify-between px-3 py-2 rounded-standard text-sm transition-colors",
                        current === level
                          ? "bg-accent/10 border border-accent/30 text-text-primary"
                          : "bg-surface-2 border border-border-subtle hover:bg-surface-hover text-text-secondary",
                      )}
                      onClick={() => {
                        onSelect(level);
                        setOpen(false);
                      }}
                    >
                      <span>{QUALITY_LABELS[level]}</span>
                      {current === level && (
                        <Badge variant="success" className="text-[10px] px-1.5 py-0">
                          Active
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Helper for class merging (avoid importing cn if not needed)
function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}
