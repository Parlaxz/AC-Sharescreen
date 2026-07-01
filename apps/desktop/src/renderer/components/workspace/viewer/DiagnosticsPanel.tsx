/**
 * DiagnosticsPanel — Live viewer diagnostics surface.
 *
 * Consumes an authoritative StreamMetricsService snapshot (no polling of
 * ViewerSession.getDiagnostics). Accepts frame performance samples as props
 * for the tabbed FramePerformanceGraph.
 *
 * Layout (≈950px wide, scroll):
 *   1. 3-column grid: Detailed video | Detailed audio | At a glance
 *   2. Codec section (requested vs active, match, verification)
 *   3. FramePerformanceGraph (Frame rate / Frame time tabs)
 *   4. NVIDIA / Benchmark collapsible sections
 *   5. Copy diagnostics button
 */
import { useState, useCallback, useEffect } from "react";
import { useSyncExternalStore } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Copy, Check, FolderOpen, ChevronDown, ChevronRight } from "lucide-react";
import { formatBitrateBps } from "@/lib/utils";
import {
  TooltipProvider,
} from "@/components/ui/tooltip";
import { fmtBitRate, fmtCumulativeBytes } from "@/services/bandwidth-telemetry-types";
import type { BandwidthSnapshot } from "@/services/bandwidth-telemetry-types";
import type { TelemetrySample } from "@/services/bandwidth-telemetry-types";
import { FramePerformanceGraph, type FramePerformanceSample } from "./FramePerformanceGraph.js";
import {
  getNvidiaCapabilitySnapshot,
  subscribeToNvidiaCapability,
} from "@/services/nvidia-capability-store";
import {
  nvidiaBenchmarkService,
  getBenchmarkProgressSnapshot,
  subscribeToBenchmarkProgress,
} from "@/services/viewer-image-processing/nvidia-benchmark-service";

// ─── Helpers ────────────────────────────────────────────────────────────────

const NA = "\u2014";

function fmtBps(bps: number | null | undefined): string {
  if (bps == null || bps <= 0) return NA;
  return formatBitrateBps(bps);
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null) return NA;
  return `${pct.toFixed(2)}%`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return NA;
  return `${ms.toFixed(1)} ms`;
}

function fmtFps(fps: number | null | undefined): string {
  if (fps == null) return NA;
  return `${fps.toFixed(1)} FPS`;
}

function fmtResolution(
  w: number | null | undefined,
  h: number | null | undefined,
): string {
  if (w && h) return `${w}\u00d7${h}`;
  return NA;
}

function fmtSampleAge(latestTimestamp: number | null | undefined): string {
  if (latestTimestamp == null) return NA;
  const age = Date.now() - latestTimestamp;
  if (age < 1000) return `${Math.round(age)} ms ago`;
  if (age < 60000) return `${(age / 1000).toFixed(1)}s ago`;
  return `${Math.floor(age / 60000)}m ago`;
}

function candidateTypeLabel(t: string | null | undefined): string {
  if (!t) return NA;
  if (t === "host") return "Host (direct)";
  if (t === "srflx") return "Server reflexive";
  if (t === "prflx") return "Peer reflexive";
  if (t === "relay") return "Relay (TURN)";
  return t;
}

function getActiveCodecFromSnapshot(snapshot: BandwidthSnapshot): string | null {
  // First try: latest sample's codec
  const samples = snapshot.aggregate.rawSamples;
  if (samples.length > 0) {
    const last = samples[samples.length - 1];
    if (last.codec) return last.codec;
  }
  // Second try: received status from first connection
  if (snapshot.connections.length > 0) {
    const status = snapshot.connections[0].receivedStatus;
    if (status?.codec) return status.codec;
  }
  // Third try: bucket metadata
  const buckets = snapshot.aggregate.mediumBuckets;
  if (buckets.length > 0) {
    const last = buckets[buckets.length - 1];
    if (last.codec) return last.codec;
  }
  return null;
}

function getLatestSample(snapshot: BandwidthSnapshot): TelemetrySample | null {
  const samples = snapshot.aggregate.rawSamples;
  return samples.length > 0 ? samples[samples.length - 1] : null;
}

/** Format a codec MIME string to a display name. */
function formatCodecDisplay(mime: string | null | undefined): string {
  if (!mime) return NA;
  // Strip "video/" or "audio/" prefix, uppercase
  return mime.replace(/^(video|audio)\//i, "").toUpperCase();
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface DiagnosticsPanelProps {
  /** Bandwidth snapshot from StreamMetricsService */
  snapshot: BandwidthSnapshot | null;
  /** Frame timing samples for graph (optional) */
  frameSamples?: FramePerformanceSample[];
  /** Viewer requested quality (for display) */
  requestedQuality?: {
    videoBitrateKbps: number;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
  } | null;
  /** Effective quality kbps from host feedback */
  effectiveBitrateKbps?: number | null;
  /** Configured sender max bitrate in bps */
  configuredBitrateBps?: number | null;
  /** The requested/preferred codec (from viewer configuration) */
  requestedCodec?: string | null;
  /** Controls trigger element */
  children?: React.ReactNode;
  /** Called when the popover opens or closes */
  onOpenChange?: (open: boolean) => void;
  /** When true, render inline without Popover wrapper */
  contentOnly?: boolean;
}

// ─── Detail row sub-component ──────────────────────────────────────────────

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <span className="text-text-muted">{label}</span>
      <span className={`text-text-primary text-right ${mono ? "font-mono tabular-nums text-[11px]" : "text-[11px]"}`}>
        {value}
      </span>
    </>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[10px] font-medium text-text-secondary uppercase tracking-wide mb-1.5">
        {title}
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        {children}
      </div>
    </div>
  );
}

// ─── At-a-glance value sub-component ────────────────────────────────────────

function GlanceValue({
  label,
  children,
  sub,
}: {
  label: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-0.5">
        {label}
      </div>
      <div className="font-mono tabular-nums text-sm font-semibold text-text-primary">
        {children}
      </div>
      {sub && (
        <div className="text-[10px] text-text-muted mt-0.5">{sub}</div>
      )}
    </div>
  );
}

// ─── NVIDIA Diagnostics Mini Section ──────────────────────────────────────

function NvidiaDiagnosticsSection() {
  const capability = useSyncExternalStore(
    subscribeToNvidiaCapability,
    getNvidiaCapabilitySnapshot,
    getNvidiaCapabilitySnapshot,
  );

  if (!capability.probed) return null;

  const isAvailable = capability.available;

  const handleOpenFolder = useCallback(async () => {
    try {
      const api = (window as unknown as { screenlink?: { nvidiaOpenBenchmarkFolder: () => Promise<boolean> } }).screenlink;
      await api?.nvidiaOpenBenchmarkFolder();
    } catch {
      // Best-effort
    }
  }, []);

  return (
    <div>
      <p className="text-[10px] font-medium text-text-secondary uppercase tracking-wide mb-1.5">
        NVIDIA RTX Video
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <DetailRow
          label="Status"
          value={
            isAvailable ? (
              <span className="text-emerald-500">Available</span>
            ) : (
              <span className="text-amber-500">{capability.reason.split("-").join(" ")}</span>
            )
          }
        />
        {capability.adapterName && (
          <DetailRow
            label="Adapter"
            value={
              <span className="truncate" title={capability.adapterName}>
                {capability.adapterName}
              </span>
            }
          />
        )}
        {capability.driverVersion && <DetailRow label="Driver" value={capability.driverVersion} />}
        {capability.supportedModes && capability.supportedModes.length > 0 && (
          <DetailRow label="Modes" value={capability.supportedModes.join(", ")} />
        )}
        {capability.supportedQualities && capability.supportedQualities.length > 0 && (
          <DetailRow label="Qualities" value={capability.supportedQualities.join(", ")} />
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="w-full text-[10px] h-7 mt-2"
        onClick={handleOpenFolder}
      >
        <FolderOpen className="h-3 w-3 mr-1.5" />
        Open Benchmark Results Folder
      </Button>
    </div>
  );
}

// ─── Benchmark Results Summary ─────────────────────────────────────────────

function BenchmarkResultsSummary() {
  const progress = useSyncExternalStore(
    subscribeToBenchmarkProgress,
    getBenchmarkProgressSnapshot,
    getBenchmarkProgressSnapshot,
  );
  const aggregate = nvidiaBenchmarkService.aggregate;

  if (!aggregate || aggregate.scenarios.length === 0) return null;

  const completedCount = aggregate.scenarios.filter(
    (s) => !s.timedOut && s.framesCollected > 0,
  ).length;
  const totalCount = aggregate.scenarios.length;

  const _fmtMs = (v: number | null | undefined): string =>
    v != null ? `${v.toFixed(1)} ms` : NA;

  return (
    <div>
      <p className="text-[10px] font-medium text-text-secondary uppercase tracking-wide mb-1.5">
        Last Benchmark
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <DetailRow label="Scenarios" value={`${completedCount}/${totalCount} completed`} />
        <DetailRow
          label="Duration"
          value={`${(aggregate.totalDurationMs / 1000).toFixed(1)}s`}
        />
        {aggregate.bestLatency && (
          <DetailRow
            label="Best latency"
            value={
              <span className="truncate text-[10px]" title={aggregate.bestLatency.label}>
                {_fmtMs(aggregate.bestLatency.avgMs)}
              </span>
            }
          />
        )}
        {aggregate.highestQuality && (
          <DetailRow
            label="Best quality"
            value={
              <span className="truncate text-[10px]" title={aggregate.highestQuality.label}>
                {aggregate.highestQuality.label}
              </span>
            }
          />
        )}
      </div>
    </div>
  );
}

// ─── Copy diagnostics ─────────────────────────────────────────────────────

function sanitizeSnapshot(d: BandwidthSnapshot | null): string {
  if (!d) return "No diagnostics data available.";

  const agg = d.aggregate;
  const sample = agg.rawSamples.length > 0 ? agg.rawSamples[agg.rawSamples.length - 1] : null;
  const conn = d.connections[0];
  const status = conn?.receivedStatus;

  const lines = [
    "ScreenLink Viewer Diagnostics",
    "============================",
    `State: ${agg.state}`,
    `History: ${d.historyId}`,
    "",
    "Media:",
    `  Total bitrate: ${fmtBitRate(agg.currentBitsPerSecond)}`,
    `  Video bitrate: ${sample?.videoBitsPerSecond != null ? fmtBitRate(sample.videoBitsPerSecond) : "unknown"}`,
    `  Audio bitrate: ${sample?.audioBitsPerSecond != null ? fmtBitRate(sample.audioBitsPerSecond) : "unknown"}`,
    `  Resolution: ${sample?.width && sample?.height ? `${sample.width}\u00d7${sample.height}` : "unknown"}`,
    `  FPS: ${sample?.framesPerSecond != null ? `${sample.framesPerSecond} fps` : "unknown"}`,
    `  Codec: ${sample?.codec ?? status?.codec ?? "unknown"}`,
    "",
    "Quality:",
    `  Effective: ${agg.effectiveBitsPerSecond != null ? fmtBitRate(agg.effectiveBitsPerSecond) : "unknown"}`,
    `  Configured: ${agg.configuredBitsPerSecond != null ? fmtBitRate(agg.configuredBitsPerSecond) : "unknown"}`,
    "",
    "Connection health:",
    `  RTT: ${sample?.rttMs != null ? `${sample.rttMs.toFixed(0)} ms` : "unknown"}`,
    `  Packet loss: ${sample?.packetLossPercent != null ? `${sample.packetLossPercent.toFixed(1)}%` : "unknown"}`,
    `  Jitter: ${sample?.jitterMs != null ? `${sample.jitterMs.toFixed(1)} ms` : "unknown"}`,
    "",
    `Total bytes: ${fmtCumulativeBytes(agg.totalBytes)}`,
    `Duration: ${(agg.durationMs / 1000).toFixed(0)}s`,
    `Timestamp: ${new Date().toISOString()}`,
  ];
  return lines.join("\n");
}

// ─── DiagnosticsPanel ─────────────────────────────────────────────────────

export function DiagnosticsPanel({
  snapshot,
  frameSamples = [],
  requestedQuality,
  effectiveBitrateKbps,
  configuredBitrateBps,
  requestedCodec = null,
  children,
  onOpenChange,
  contentOnly = false,
}: DiagnosticsPanelProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Listen for keyboard shortcut I to toggle, Escape to close
  useEffect(() => {
    const handleToggle = () => setOpen((prev) => !prev);
    const handleEscape = () => setOpen(false);
    window.addEventListener("screenlink:viewer-toggle-info", handleToggle);
    window.addEventListener("screenlink:viewer-escape", handleEscape);
    return () => {
      window.removeEventListener("screenlink:viewer-toggle-info", handleToggle);
      window.removeEventListener("screenlink:viewer-escape", handleEscape);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const text = sanitizeSnapshot(snapshot);
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
  }, [snapshot]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange],
  );

  // ── Extract data from snapshot ───────────────────────────────────────

  const agg = snapshot?.aggregate ?? null;
  const latestSample = snapshot ? getLatestSample(snapshot) : null;
  const firstConn = snapshot?.connections?.[0] ?? null;
  const receivedStatus = firstConn?.receivedStatus ?? null;

  // Determine values
  const activeCodec = snapshot ? getActiveCodecFromSnapshot(snapshot) : null;
  const resW = latestSample?.width ?? receivedStatus?.width ?? null;
  const resH = latestSample?.height ?? receivedStatus?.height ?? null;
  const decodedFps = latestSample?.framesPerSecond ?? receivedStatus?.framesPerSecond ?? null;
  const videoBps = latestSample?.videoBitsPerSecond ?? receivedStatus?.videoBitsPerSecond ?? null;
  const audioBps = latestSample?.audioBitsPerSecond ?? receivedStatus?.audioBitsPerSecond ?? null;
  const totalBps = agg?.currentBitsPerSecond ?? (videoBps != null || audioBps != null ? (videoBps ?? 0) + (audioBps ?? 0) : null);

  // Displayed FPS from frame samples (preferred), falling back to decoded FPS
  const latestFrameSample = frameSamples.length > 0 ? frameSamples[frameSamples.length - 1] : null;
  const displayedFps = latestFrameSample?.displayedFps ?? null;
  const primaryFps = displayedFps ?? decodedFps;

  // Quality values
  const reqBitrateKbps = requestedQuality?.videoBitrateKbps ?? null;
  const effBitrateBps = effectiveBitrateKbps != null ? effectiveBitrateKbps * 1000 : (agg?.effectiveBitsPerSecond ?? null);
  const confBitrateBps = configuredBitrateBps ?? agg?.configuredBitsPerSecond ?? null;

  // Packet loss / jitter / RTT
  const packetLoss = latestSample?.packetLossPercent ?? receivedStatus?.packetLossPercent ?? null;
  const jitterMs = latestSample?.jitterMs ?? receivedStatus?.jitterMs ?? null;
  const rttMs = latestSample?.rttMs ?? receivedStatus?.rttMs ?? null;
  const transportBps = latestSample?.transportBitsPerSecond ?? null;
  const primaryVideoStream = latestSample?.videoRtpStreams?.[0] ?? null;
  const primaryAudioStream = latestSample?.audioRtpStreams?.[0] ?? null;

  // Dropped frames, freeze
  const droppedFrames = primaryVideoStream?.framesDropped ?? receivedStatus?.droppedFrames ?? null;
  const freezeCount = primaryVideoStream?.freezeCount ?? null;

  // Requested codec for display
  const reqCodecDisplay = requestedCodec
    ? requestedCodec.toUpperCase().replace("VIDEO/", "")
    : null;

  // Normalize active codec for comparison
  const activeCodecDisplay = activeCodec
    ? activeCodec.toUpperCase().replace("VIDEO/", "")
    : null;

  const codecMatch: "yes" | "no" | "unknown" =
    reqCodecDisplay && activeCodecDisplay
      ? reqCodecDisplay === activeCodecDisplay ? "yes" : "no"
      : "unknown";

  const content = (
    <TooltipProvider>
      <div className="space-y-3 text-[11px]">
        {/* ── 3-column grid: Video | Audio | At a glance ── */}
      <div className="grid grid-cols-3 gap-4">
        {/* Detailed Video */}
        <DetailSection title="Detailed video">
          <DetailRow label="Active codec" value={formatCodecDisplay(activeCodec)} />
          <DetailRow label="Resolution" value={fmtResolution(resW, resH)} mono />
          <DetailRow label="Bitrate" value={fmtBps(videoBps)} mono />
          <DetailRow label="FPS (decoded)" value={fmtFps(decodedFps)} mono />
          <DetailRow label="Packet loss" value={fmtPct(packetLoss)} />
          <DetailRow label="Jitter" value={fmtMs(jitterMs)} />
          <DetailRow label="Dropped / Freeze" value={`${droppedFrames ?? NA} / ${freezeCount ?? NA}`} />
          <DetailRow label="Packets" value={receivedStatus?.packetsReceived != null ? `${receivedStatus.packetsReceived} recv` : NA} />
        </DetailSection>

        {/* Detailed Audio */}
        <DetailSection title="Detailed audio">
          <DetailRow label="Codec" value={formatCodecDisplay(primaryAudioStream?.codecMimeType ?? latestSample?.codec ?? NA)} />
          <DetailRow label="Bitrate" value={fmtBps(audioBps)} mono />
          <DetailRow label="Jitter" value={fmtMs(jitterMs)} />
          <DetailRow label="Packets" value={
            receivedStatus?.packetsReceived != null
              ? `${receivedStatus.packetsReceived} recv`
              : NA
          } />
        </DetailSection>

        {/* At a Glance */}
        <div>
          <p className="text-[10px] font-medium text-text-secondary uppercase tracking-wide mb-2">
            At a glance
          </p>
          <div className="space-y-3">
            {/* Resolution — prominent */}
            <GlanceValue label="Resolution">
              {fmtResolution(resW, resH)}
            </GlanceValue>

            {/* FPS — prefer displayed, fallback decoded, tooltip */}
            <GlanceValue label="FPS">
              {primaryFps != null ? `${primaryFps.toFixed(1)}` : NA}
              {displayedFps != null && decodedFps != null && (
                <span className="text-[10px] font-normal text-text-muted ml-1">
                  (decoded: {decodedFps.toFixed(1)})
                </span>
              )}
            </GlanceValue>

            {/* Quality */}
            <GlanceValue label="Quality">
              {reqBitrateKbps != null || effBitrateBps != null ? (
                <>
                  {reqBitrateKbps != null
                    ? `Request: ${formatBitrateBps(reqBitrateKbps * 1000)}`
                    : "Request: \u2014"}
                </>
              ) : NA}
            </GlanceValue>
            {effBitrateBps != null && (
              <div className="text-[10px] text-text-muted -mt-2">
                Effective: {fmtBps(effBitrateBps)}
              </div>
            )}

            {/* Bitrate — large total, subline video/audio */}
            <GlanceValue
              label="Bitrate"
              sub={
                videoBps != null || audioBps != null
                  ? `Video ${fmtBps(videoBps)} \u00b7 Audio ${fmtBps(audioBps)}`
                  : undefined
              }
            >
              {totalBps != null ? fmtBps(totalBps) : NA}
            </GlanceValue>
          </div>
        </div>
      </div>

      <Separator />

      {/* ── Connection / Codec row ── */}
      <div className="grid grid-cols-2 gap-4">
        {/* Connection info */}
        <DetailSection title="Connection">
          <DetailRow label="State" value={
            <span className={`capitalize ${
              agg?.state === "playing" ? "text-emerald-500" :
              agg?.state === "paused" ? "text-amber-500" :
              "text-rose-500"
            }`}>
              {agg?.state ?? NA}
            </span>
          } />
          <DetailRow label="RTT" value={fmtMs(rttMs)} mono />
          <DetailRow label="Transport (wire)" value={transportBps != null ? fmtBps(transportBps) : NA} mono />
          <DetailRow label="Total bytes" value={agg ? fmtCumulativeBytes(agg.totalBytes) : NA} mono />
          <DetailRow label="Sample age" value={fmtSampleAge(latestSample?.timestampMs ?? null)} />
          <DetailRow label="Duration" value={
            agg ? `${(agg.durationMs / 1000).toFixed(0)}s` : NA
          } />
        </DetailSection>

        {/* Codec configuration vs observation */}
        <DetailSection title="Codec">
          <DetailRow label="Requested" value={reqCodecDisplay ?? NA} />
          <DetailRow label="Active receive" value={activeCodecDisplay ?? NA} />
          <DetailRow label="Match" value={
            <span className={
              codecMatch === "yes" ? "text-emerald-500" :
              codecMatch === "no" ? "text-rose-500" :
              "text-text-muted"
            }>
              {codecMatch === "yes" ? "Yes" :
               codecMatch === "no" ? "No" :
               "Unknown"}
            </span>
          } />
        </DetailSection>
      </div>

      <Separator />

      {/* ── Frame Performance Graph ── */}
      <FramePerformanceGraph samples={frameSamples} maxSamples={120} />

      <Separator />

      {/* ── Benchmark & NVIDIA sections ── */}
      <div className="grid grid-cols-2 gap-4">
        <BenchmarkResultsSummary />
        <NvidiaDiagnosticsSection />
      </div>

      <Separator />

      {/* ── Action buttons ── */}
      <div className="grid grid-cols-2 gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" className="w-full" onClick={handleCopy}>
              {copied ? (
                <><Check className="h-3.5 w-3.5 mr-1.5" />Copied</>
              ) : (
                <><Copy className="h-3.5 w-3.5 mr-1.5" />Copy diagnostics</>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Copy sanitized connection info to clipboard</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={async () => {
                try {
                  const api = (window as unknown as { screenlink?: { nvidiaOpenBenchmarkFolder: () => Promise<boolean> } }).screenlink;
                  await api?.nvidiaOpenBenchmarkFolder();
                } catch { /* best-effort */ }
              }}
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
              Results folder
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open NVIDIA benchmark results folder</TooltipContent>
        </Tooltip>
      </div>
      </div>
    </TooltipProvider>
  );

  if (contentOnly) {
    return <div className="w-[950px] max-w-[calc(100vw-32px)] p-4 max-h-[80vh] overflow-y-auto">{content}</div>;
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-[950px] max-w-[calc(100vw-32px)] p-4 max-h-[80vh] overflow-y-auto">
        {content}
      </PopoverContent>
    </Popover>
  );
}
