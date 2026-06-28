import { useState, useEffect, useCallback, useRef } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Info, Copy, Check } from "lucide-react";
import type { ViewerSession } from "@/services/viewer-session.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DiagnosticsSnapshot {
  // Connection
  connectionState: string;
  selectedCandidatePair: {
    local: string | null;
    remote: string | null;
    state: string | null;
    nominated: boolean | null;
  };

  // Video inbound
  videoCodec: string | null;
  videoWidth: number | null;
  videoHeight: number | null;
  videoFrameRate: number | null;
  videoBitrateBps: number | null;
  videoPacketsReceived: number;
  videoPacketsLost: number;
  videoPacketLossPercent: number | null;
  videoJitter: number | null;
  videoFramesDropped: number | null;
  videoFreezeCount: number | null;
  videoBytesReceived: number;

  // Audio inbound
  audioCodec: string | null;
  audioBitrateBps: number | null;
  audioPacketsReceived: number;
  audioPacketsLost: number;
  audioJitter: number | null;
  audioBytesReceived: number;

  // Round-trip time from candidate-pair
  rttMs: number | null;

  // ICE / path
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  isRelay: boolean | null;

  // Viewer quality info (if available from session state)
  requestedBitrateKbps: number | null;
  effectiveBitrateKbps: number | null;
  senderMaxBitrateBps: number | null;

  timestamp: number;
}

const EMPTY_DIAGNOSTICS: DiagnosticsSnapshot = {
  connectionState: "unknown",
  selectedCandidatePair: { local: null, remote: null, state: null, nominated: null },
  videoCodec: null,
  videoWidth: null,
  videoHeight: null,
  videoFrameRate: null,
  videoBitrateBps: null,
  videoPacketsReceived: 0,
  videoPacketsLost: 0,
  videoPacketLossPercent: null,
  videoJitter: null,
  videoFramesDropped: null,
  videoFreezeCount: null,
  videoBytesReceived: 0,
  audioCodec: null,
  audioBitrateBps: null,
  audioPacketsReceived: 0,
  audioPacketsLost: 0,
  audioJitter: null,
  audioBytesReceived: 0,
  rttMs: null,
  localCandidateType: null,
  remoteCandidateType: null,
  isRelay: null,
  requestedBitrateKbps: null,
  effectiveBitrateKbps: null,
  senderMaxBitrateBps: null,
  timestamp: Date.now(),
};

// ─── Props ─────────────────────────────────────────────────────────────────

interface DiagnosticsPanelProps {
  /** Active ViewerSession to poll real diagnostics from */
  session: ViewerSession | null;
  /** Controls trigger element */
  children: React.ReactNode;
  /** Called when the popover opens or closes (for auto-hide coordination) */
  onOpenChange?: (open: boolean) => void;
  /** Viewer requested quality values (for display in diagnostics) */
  lastRequestedQuality?: { videoBitrateKbps: number; maxWidth: number; maxHeight: number; maxFps: number } | null;
  /** Effective quality kbps from host feedback */
  effectiveBitrateKbps?: number | null;
  /** Configured sender max bitrate in bps */
  configuredBitrateBps?: number | null;
  /** When true, render the diagnostics content directly without Popover wrapper */
  contentOnly?: boolean;
}

// ─── Diagnostics poller hook ──────────────────────────────────────────────

function useDiagnosticsPoller(
  session: ViewerSession | null,
  extraQuality?: { lastRequested?: { videoBitrateKbps?: number } | null; effectiveKbps?: number | null; configuredBps?: number | null },
): DiagnosticsSnapshot {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(EMPTY_DIAGNOSTICS);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Stop any existing poller
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    if (!session) return;

    let cancelled = false;

    const poll = async () => {
      if (cancelled || !session) return;
      try {
        const diag = await session.getDiagnostics();
        if (diag && !cancelled) {
          // Convert to our snapshot format
          const inboundVideo = diag.inboundVideo;
          const inboundAudio = diag.inboundAudio;
          const pair = diag.selectedCandidatePair;

          // Real candidate types from ViewerSession diagnostics (from ICE candidate stats)
          const localType = diag.localCandidateType;
          const remoteType = diag.remoteCandidateType;
          const realRttMs = diag.rttMs;
          const isRelay = localType === "relay" || remoteType === "relay";
          // Read quality state from extraQuality argument (avoids stale closure issues)
          const lrq = extraQuality?.lastRequested;
          const ekbps = extraQuality?.effectiveKbps;
          const cbBps = extraQuality?.configuredBps;

          setSnapshot({
            connectionState: diag.connectionState,
            selectedCandidatePair: pair,
            videoCodec: inboundVideo.codecId,
            // Real frame dimensions from inbound-rtp stats
            videoWidth: inboundVideo.frameWidth ?? null,
            videoHeight: inboundVideo.frameHeight ?? null,
            videoFrameRate: inboundVideo.framesPerSecond ?? null,
            videoBitrateBps: inboundVideo.bitrateBps || null,
            videoPacketsReceived: inboundVideo.packetsReceived,
            videoPacketsLost: inboundVideo.packetsLost,
            videoPacketLossPercent: inboundVideo.packetsReceived > 0
              ? (inboundVideo.packetsLost / (inboundVideo.packetsReceived + inboundVideo.packetsLost)) * 100
              : null,
            videoJitter: inboundVideo.jitter || null,
            // Real frames dropped and freeze count from inbound-rtp stats
            videoFramesDropped: inboundVideo.framesDropped ?? null,
            videoFreezeCount: inboundVideo.freezeCount ?? null,
            videoBytesReceived: 0,
            audioCodec: inboundAudio.codecId,
            audioBitrateBps: inboundAudio.bitrateBps || null,
            audioPacketsReceived: inboundAudio.packetsReceived,
            audioPacketsLost: inboundAudio.packetsLost,
            audioJitter: inboundAudio.jitter || null,
            audioBytesReceived: 0,
            rttMs: realRttMs,
            localCandidateType: localType,
            remoteCandidateType: remoteType,
            isRelay,
            // Quality info from viewer state (captured via local vars to avoid closure issues)
            requestedBitrateKbps: lrq?.videoBitrateKbps ?? null,
            effectiveBitrateKbps: ekbps ?? null,
            senderMaxBitrateBps: cbBps ?? null,
            timestamp: diag.timestamp,
          });
        }
      } catch {
        // Polling is best-effort
      }
    };

    // Poll immediately then every 2s
    poll();
    pollRef.current = setInterval(poll, 2000);

    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // Include extraQuality so the poll callback reads fresh quality values.
    // Without this, changing lastRequestedQuality / effectiveBitrateKbps /
    // configuredBitrateBps from the parent would never update the snapshot.
  }, [session, extraQuality]);

  return snapshot;
}

// ─── Sanitized diagnostics copy ───────────────────────────────────────────

function sanitizeDiagnostics(d: DiagnosticsSnapshot): string {
  const lines = [
    "ScreenLink Viewer Diagnostics",
    "============================",
    `Connection: ${d.connectionState}`,
    `ICE pair: ${d.selectedCandidatePair.local ?? "?"} ↔ ${d.selectedCandidatePair.remote ?? "?"} (${d.selectedCandidatePair.state ?? "?"})`,
    `Relay: ${d.isRelay === null ? "unknown" : d.isRelay ? "yes" : "no"}`,
    "",
    "Video:",
    `  Codec: ${d.videoCodec ?? "unknown"}`,
    `  Resolution: ${d.videoWidth && d.videoHeight ? `${d.videoWidth}×${d.videoHeight}` : "unknown"}`,
    `  Frame rate: ${d.videoFrameRate ?? "unknown"} fps`,
    `  Bitrate: ${d.videoBitrateBps !== null ? `${(d.videoBitrateBps / 1000).toFixed(1)} kbps` : "unknown"}`,
    `  Packets: ${d.videoPacketsReceived} received, ${d.videoPacketsLost} lost`,
    `  Packet loss: ${d.videoPacketLossPercent !== null ? `${d.videoPacketLossPercent.toFixed(2)}%` : "unknown"}`,
    `  Jitter: ${d.videoJitter !== null ? `${d.videoJitter.toFixed(1)} ms` : "unknown"}`,
    `  Frames dropped: ${d.videoFramesDropped ?? "unknown"}`,
    `  Freeze count: ${d.videoFreezeCount ?? "unknown"}`,
    "",
    "Audio:",
    `  Codec: ${d.audioCodec ?? "unknown"}`,
    `  Bitrate: ${d.audioBitrateBps !== null ? `${(d.audioBitrateBps / 1000).toFixed(1)} kbps` : "unknown"}`,
    `  Packets: ${d.audioPacketsReceived} received, ${d.audioPacketsLost} lost`,
    `  Jitter: ${d.audioJitter !== null ? `${d.audioJitter.toFixed(1)} ms` : "unknown"}`,
    "",
    `Timestamp: ${new Date(d.timestamp).toISOString()}`,
  ];
  return lines.join("\n");
}

// ─── DiagnosticsPanel ─────────────────────────────────────────────────────

/**
 * DiagnosticsPanel — Real viewer diagnostics popover.
 * Polls the active ViewerSession for RTCPeerConnection stats every 2s.
 * Does NOT use EMPTY_STATS for active sessions — polls real data.
 */
export function DiagnosticsPanel({
  session,
  children,
  onOpenChange,
  lastRequestedQuality,
  effectiveBitrateKbps,
  configuredBitrateBps,
  contentOnly = false,
}: DiagnosticsPanelProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const stats = useDiagnosticsPoller(open ? session : null, {
    lastRequested: lastRequestedQuality,
    effectiveKbps: effectiveBitrateKbps,
    configuredBps: configuredBitrateBps,
  });

  // Listen for keyboard shortcut I to toggle diagnostics panel, and Escape to close
  useEffect(() => {
    const handleToggle = () => {
      setOpen((prev) => !prev);
    };
    const handleEscape = () => {
      setOpen(false);
    };
    window.addEventListener("screenlink:viewer-toggle-info", handleToggle);
    window.addEventListener("screenlink:viewer-escape", handleEscape);
    return () => {
      window.removeEventListener("screenlink:viewer-toggle-info", handleToggle);
      window.removeEventListener("screenlink:viewer-escape", handleEscape);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const text = sanitizeDiagnostics(stats);
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
  }, [stats]);

  const fmtBps = (bps: number | null): string => {
    if (bps === null || bps === 0) return "—";
    return `${(bps / 1000).toFixed(1)} kbps`;
  };

  const fmtPct = (pct: number | null): string => {
    if (pct === null) return "—";
    return `${pct.toFixed(2)}%`;
  };

  const fmtMs = (ms: number | null): string => {
    if (ms === null || ms === 0) return "—";
    return `${ms.toFixed(1)} ms`;
  };

  const candidateTypeLabel = (t: string | null): string => {
    if (!t) return "—";
    if (t === "host") return "Host (direct)";
    if (t === "srflx") return "Server reflexive";
    if (t === "prflx") return "Peer reflexive";
    if (t === "relay") return "Relay (TURN)";
    return t;
  };

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [onOpenChange]);

  const content = (
    <div className="space-y-4">
      {/* Connection + Video columns */}
      <div className="grid grid-cols-4 gap-3">
        {/* Connection section */}
        <div>
          <p className="text-[10px] font-medium text-text-secondary uppercase tracking-wide mb-1.5">
            Connection
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <span className="text-text-muted">State</span>
            <span className="text-text-primary text-right capitalize">{stats.connectionState}</span>
            <span className="text-text-muted">ICE pair</span>
            <span className="text-text-primary text-right truncate text-[10px]" title={`${stats.selectedCandidatePair.local ?? "?"} ↔ ${stats.selectedCandidatePair.remote ?? "?"}`}>
              {stats.selectedCandidatePair.local ?? "?"}↔{stats.selectedCandidatePair.remote ?? "?"}
            </span>
            <span className="text-text-muted">Local / Remote</span>
            <span className="text-text-primary text-right text-[10px]">{candidateTypeLabel(stats.localCandidateType)} / {candidateTypeLabel(stats.remoteCandidateType)}</span>
            <span className="text-text-muted">Relay</span>
            <span className="text-text-primary text-right">{stats.isRelay === null ? "—" : stats.isRelay ? "Yes" : "No"}</span>
            <span className="text-text-muted">RTT</span>
            <span className="text-text-primary text-right">{fmtMs(stats.rttMs)}</span>
          </div>
        </div>

        {/* Video section */}
        <div>
          <p className="text-[10px] font-medium text-text-secondary uppercase tracking-wide mb-1.5">
            Video
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <span className="text-text-muted">Codec</span>
            <span className="text-text-primary text-right truncate">{stats.videoCodec ?? "—"}</span>
            <span className="text-text-muted">Resolution</span>
            <span className="text-text-primary text-right">
              {stats.videoWidth && stats.videoHeight ? `${stats.videoWidth}×${stats.videoHeight}` : "—"}
            </span>
            <span className="text-text-muted">FPS</span>
            <span className="text-text-primary text-right">{stats.videoFrameRate ?? "—"}</span>
            <span className="text-text-muted">Bitrate</span>
            <span className="text-text-primary text-right">{fmtBps(stats.videoBitrateBps)}</span>
            <span className="text-text-muted">Packet loss</span>
            <span className="text-text-primary text-right">{fmtPct(stats.videoPacketLossPercent)}</span>
            <span className="text-text-muted">Jitter</span>
            <span className="text-text-primary text-right">{fmtMs(stats.videoJitter)}</span>
            <span className="text-text-muted">Dropped / Freeze</span>
            <span className="text-text-primary text-right">{stats.videoFramesDropped ?? "—"} / {stats.videoFreezeCount ?? "—"}</span>
          </div>
        </div>
      </div>

      <Separator />

      {/* Audio + Quality columns */}
      <div className="grid grid-cols-4 gap-3">
        {/* Audio section */}
        <div>
          <p className="text-[10px] font-medium text-text-secondary uppercase tracking-wide mb-1.5">
            Audio
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <span className="text-text-muted">Codec</span>
            <span className="text-text-primary text-right truncate">{stats.audioCodec ?? "—"}</span>
            <span className="text-text-muted">Bitrate</span>
            <span className="text-text-primary text-right">{fmtBps(stats.audioBitrateBps)}</span>
            <span className="text-text-muted">Packets</span>
            <span className="text-text-primary text-right">{stats.audioPacketsReceived} recv / {stats.audioPacketsLost} lost</span>
            <span className="text-text-muted">Jitter</span>
            <span className="text-text-primary text-right">{fmtMs(stats.audioJitter)}</span>
          </div>
        </div>

        {/* Quality section */}
        <div>
          <p className="text-[10px] font-medium text-text-secondary uppercase tracking-wide mb-1.5">
            Quality
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {stats.requestedBitrateKbps !== null ? (
              <><span className="text-text-muted">Requested</span><span className="text-text-primary text-right">{stats.requestedBitrateKbps} kbps</span></>
            ) : (
              <><span className="text-text-muted">Requested</span><span className="text-text-primary text-right">—</span></>
            )}
            {stats.effectiveBitrateKbps !== null ? (
              <><span className="text-text-muted">Effective</span><span className="text-text-primary text-right">{stats.effectiveBitrateKbps} kbps</span></>
            ) : (
              <><span className="text-text-muted">Effective</span><span className="text-text-primary text-right">—</span></>
            )}
            {stats.senderMaxBitrateBps !== null ? (
              <><span className="text-text-muted">Sender max</span><span className="text-text-primary text-right">{Math.round(stats.senderMaxBitrateBps / 1000)} kbps</span></>
            ) : (
              <><span className="text-text-muted">Sender max</span><span className="text-text-primary text-right">—</span></>
            )}
          </div>
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
            onClick={handleCopy}
          >
            {copied ? (
              <><Check className="h-3.5 w-3.5 mr-1.5" />Copied</>
            ) : (
              <><Copy className="h-3.5 w-3.5 mr-1.5" />Copy diagnostics</>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Copy sanitized connection info to clipboard
        </TooltipContent>
      </Tooltip>
    </div>
  );

  if (contentOnly) {
    return <div className="w-[750px] p-4 max-h-[80vh] overflow-y-auto">{content}</div>;
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-[750px] p-4 max-h-[80vh] overflow-y-auto">
        {content}
      </PopoverContent>
    </Popover>
  );
}
