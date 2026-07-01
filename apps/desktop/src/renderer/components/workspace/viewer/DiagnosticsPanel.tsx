/**
 * DiagnosticsPanel — Live viewer diagnostics surface.
 *
 * Consumes an authoritative StreamMetricsService snapshot (no polling of
 * ViewerSession.getDiagnostics). Accepts frame performance samples as props
 * for the FramePerformanceGraph.
 *
 * Layout (820px wide):
 *   1. Compact header with title + copy button
 *   2. "At a glance" inline flex row (5 key metrics + bitrate summary)
 *   3. FramePerformanceGraph (always visible)
 *   4. Collapsible "Advanced diagnostics" with Detailed video/audio,
 *      Connection/Codec, NVIDIA, and Benchmark sections
 */
import { useState, useCallback, useEffect } from "react";
import { useSyncExternalStore } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Copy, Check, FolderOpen, ChevronDown, ChevronRight } from "lucide-react";
import { formatBitrateBps } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
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
  if (w != null && h != null) return `${w}\u00d7${h}`;
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

/** Get the latest raw sample from the first connection (has per-stream evidence that aggregate strips). */
function getConnectionSample(snapshot: BandwidthSnapshot): TelemetrySample | null {
  const conn = snapshot.connections?.[0];
  const samples = conn?.rawSamples;
  return (samples?.length ?? 0) > 0 ? samples![samples!.length - 1] : null;
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
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className="font-mono tabular-nums text-sm font-semibold text-text-primary">
        {children}
      </div>
      {sub && (
        <div className="text-[10px] text-text-muted truncate">{sub}</div>
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
  const [advancedOpen, setAdvancedOpen] = useState(false);

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
  const connSample = snapshot ? getConnectionSample(snapshot) : null;
  const firstConn = snapshot?.connections?.[0] ?? null;
  const receivedStatus = firstConn?.receivedStatus ?? null;

  // Use connection-level sample for rich metadata (aggregate strips width/height/codec/RTP evidence)
  const richSample = connSample ?? latestSample;

  // Determine values
  const activeCodec = snapshot ? getActiveCodecFromSnapshot(snapshot) : null;
  const resW = richSample?.width ?? receivedStatus?.width ?? null;
  const resH = richSample?.height ?? receivedStatus?.height ?? null;
  const decodedFps = richSample?.framesPerSecond ?? receivedStatus?.framesPerSecond ?? null;
  const videoBps = richSample?.videoBitsPerSecond ?? receivedStatus?.videoBitsPerSecond ?? null;
  const audioBps = richSample?.audioBitsPerSecond ?? receivedStatus?.audioBitsPerSecond ?? null;

  // Displayed FPS from frame samples (preferred), falling back to decoded FPS
  const latestFrameSample = frameSamples.length > 0 ? frameSamples[frameSamples.length - 1] : null;
  const displayedFps = latestFrameSample?.displayedFps ?? null;
  const primaryFps = displayedFps ?? decodedFps;

  // Quality values
  const reqBitrateKbps = requestedQuality?.videoBitrateKbps ?? null;
  const effBitrateBps = effectiveBitrateKbps != null ? effectiveBitrateKbps * 1000 : (agg?.effectiveBitsPerSecond ?? null);
  const confBitrateBps = configuredBitrateBps ?? agg?.configuredBitsPerSecond ?? null;

  // Packet loss / jitter / RTT
  const packetLoss = richSample?.packetLossPercent ?? receivedStatus?.packetLossPercent ?? null;
  const jitterMs = richSample?.jitterMs ?? receivedStatus?.jitterMs ?? null;
  const rttMs = richSample?.rttMs ?? receivedStatus?.rttMs ?? null;
  const transportBps = richSample?.transportBitsPerSecond ?? null;
  const primaryVideoStream = richSample?.videoRtpStreams?.[0] ?? null;
  const primaryAudioStream = richSample?.audioRtpStreams?.[0] ?? null;

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

  // ── Empty state ────────────────────────────────────────────────────
  if (!snapshot && frameSamples.length === 0) {
    return (
      <div className={contentOnly ? `w-[820px] max-w-[calc(100vw-32px)]` : ""}>
        <div className="flex items-center justify-center h-32 text-sm text-text-muted">
          No diagnostics data yet.
        </div>
      </div>
    );
  }

  const content = (
    <TooltipProvider>
      <div className="space-y-3 text-[11px]">
        {/* ── Header ── */}
        <div className="flex items-center justify-between pb-2 border-b border-border-subtle">
          <h2 className="text-xs font-semibold text-text-primary uppercase tracking-wide">
            ScreenLink Viewer Diagnostics
          </h2>
          <Button variant="ghost" size="sm" className="h-7 text-[10px] gap-1" onClick={handleCopy}>
            {copied ? (
              <><Check className="h-3 w-3" />Copied</>
            ) : (
              <><Copy className="h-3 w-3" />Copy</>
            )}
          </Button>
        </div>

        {/* ── At a glance ── */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 py-2">
          <GlanceValue label="Resolution">
            {fmtResolution(resW, resH)}
          </GlanceValue>
          <GlanceValue
            label="FPS"
            sub={displayedFps != null && decodedFps != null ? `decoded: ${decodedFps.toFixed(1)}` : undefined}
          >
            {primaryFps != null ? `${primaryFps.toFixed(1)}` : "Collecting\u2026"}
          </GlanceValue>
          <GlanceValue label="Quality">
            {reqBitrateKbps != null
              ? formatBitrateBps(reqBitrateKbps * 1000)
              : effBitrateBps != null
                ? fmtBps(effBitrateBps)
                : "Collecting\u2026"}
          </GlanceValue>
          <GlanceValue label="Codec">
            {activeCodecDisplay ? (
              <span className={codecMatch === "yes" ? "text-emerald-500" : codecMatch === "no" ? "text-rose-500" : ""}>
                {activeCodecDisplay}
              </span>
            ) : "Collecting\u2026"}
          </GlanceValue>
          <GlanceValue label="State">
            <span className={`capitalize ${agg?.state === "playing" ? "text-emerald-500" : agg?.state === "paused" ? "text-amber-500" : "text-rose-500"}`}>
              {agg?.state ?? "Collecting\u2026"}
            </span>
          </GlanceValue>
          <div className="w-full text-[10px] text-text-muted">
            Video {fmtBps(videoBps)} &middot; Audio {fmtBps(audioBps)} &middot; RTT {fmtMs(rttMs)} &middot; Loss {fmtPct(packetLoss)}
          </div>
        </div>

        {/* ── Performance graphs ── */}
        <FramePerformanceGraph samples={frameSamples} maxSamples={120} />

        {/* ── Advanced diagnostics collapsible ── */}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full flex items-center justify-between h-7 text-[11px] text-text-secondary hover:text-text-primary">
              <span>Advanced diagnostics</span>
              {advancedOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
            {/* ── 2-column grid: Detailed video | Detailed audio ── */}
            <div className="grid grid-cols-2 gap-4">
              <DetailSection title="Detailed video">
                <DetailRow label="Active codec" value={formatCodecDisplay(activeCodec)} />
                <DetailRow label="Packet loss" value={fmtPct(packetLoss)} />
                <DetailRow label="Jitter" value={fmtMs(jitterMs)} />
                <DetailRow label="Dropped / Freeze" value={`${droppedFrames ?? NA} / ${freezeCount ?? NA}`} />
                <DetailRow label="Packets" value={receivedStatus?.packetsReceived != null ? `${receivedStatus.packetsReceived} recv` : NA} />
                <DetailRow label="Decode time" value={fmtMs(latestFrameSample?.decodeTimeMs ?? null)} />
              </DetailSection>
              <DetailSection title="Detailed audio">
                <DetailRow label="Codec" value={formatCodecDisplay(primaryAudioStream?.codecMimeType ?? latestSample?.codec ?? null)} />
                <DetailRow label="Bitrate" value={fmtBps(audioBps)} mono />
                <DetailRow label="Jitter" value={fmtMs(primaryAudioStream?.jitterMs ?? jitterMs)} />
                <DetailRow label="Packets" value={receivedStatus?.packetsReceived != null ? `${receivedStatus.packetsReceived} recv` : NA} />
                <DetailRow label="Jitter buffer" value={primaryAudioStream?.jitterBufferDelayMs != null ? fmtMs(primaryAudioStream.jitterBufferDelayMs) : NA} />
                <DetailRow label="Concealment" value={primaryAudioStream?.concealmentPercent != null ? fmtPct(primaryAudioStream.concealmentPercent) : NA} />
              </DetailSection>
            </div>

            {/* ── 2-column grid: Connection | Codec ── */}
            <div className="grid grid-cols-2 gap-4">
              <DetailSection title="Connection">
                <DetailRow label="State" value={
                  <span className={`capitalize ${agg?.state === "playing" ? "text-emerald-500" : agg?.state === "paused" ? "text-amber-500" : "text-rose-500"}`}>
                    {agg?.state ?? NA}
                  </span>
                } />
                <DetailRow label="RTT" value={fmtMs(rttMs)} mono />
                <DetailRow label="Transport (wire)" value={transportBps != null ? fmtBps(transportBps) : NA} mono />
                <DetailRow label="Total bytes" value={agg ? fmtCumulativeBytes(agg.totalBytes) : NA} mono />
                <DetailRow label="Sample age" value={fmtSampleAge(latestSample?.timestampMs ?? null)} />
                <DetailRow label="Duration" value={agg ? `${(agg.durationMs / 1000).toFixed(0)}s` : NA} />
              </DetailSection>
              <DetailSection title="Codec">
                <DetailRow label="Requested" value={reqCodecDisplay ?? NA} />
                <DetailRow label="Active receive" value={activeCodecDisplay ?? NA} />
                <DetailRow label="Match" value={
                  <span className={codecMatch === "yes" ? "text-emerald-500" : codecMatch === "no" ? "text-rose-500" : "text-text-muted"}>
                    {codecMatch === "yes" ? "Yes" : codecMatch === "no" ? "No" : "Unknown"}
                  </span>
                } />
              </DetailSection>
            </div>

            {/* ── NVIDIA & Benchmark sections ── */}
            <div className="grid grid-cols-2 gap-4">
              <BenchmarkResultsSummary />
              <NvidiaDiagnosticsSection />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </TooltipProvider>
  );

  if (contentOnly) {
    return <div className="w-[820px] max-w-[calc(100vw-32px)] p-4 max-h-[80vh] overflow-y-auto">{content}</div>;
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-[820px] max-w-[calc(100vw-32px)] p-4 max-h-[80vh] overflow-y-auto">
        {content}
      </PopoverContent>
    </Popover>
  );
}
