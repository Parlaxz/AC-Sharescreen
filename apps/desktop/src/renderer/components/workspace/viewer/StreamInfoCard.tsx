import { useMemo, memo } from "react";
import { formatBandwidth, formatTotalBytes } from "./BandwidthDisplay.js";
import { estimateHourlyBytes, fmtHourlyUsage } from "@/services/bandwidth-telemetry-types";

// ─── Config type ─────────────────────────────────────────────────────────────

export interface StreamInfoCardConfig {
  showResolution: boolean;
  showFps: boolean;
  showBitrate: boolean;
  showDroppedFrames: boolean;
  showNetworkUsage: boolean;
  fontSize: number;
  textColor: string;
  boxOpacity: number;
  boxWidth: number;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface StreamInfoCardProps {
  snapshot: {
    videoWidth: number | null;
    videoHeight: number | null;
    videoFrameRate: number | null;
    videoBitrateBps: number | null;
  };
  droppedFramesInLast5s: number;
  config: StreamInfoCardConfig;
  bandwidthBps: number;
  totalBytes: number;
  activeDurationMs: number;
}

// ─── Component ───────────────────────────────────────────────────────────────

function StreamInfoCardInner({
  snapshot,
  droppedFramesInLast5s,
  config,
  bandwidthBps,
  totalBytes,
  activeDurationMs,
}: StreamInfoCardProps) {
  const hourlyEstimate = useMemo(
    () => estimateHourlyBytes(totalBytes, activeDurationMs),
    [totalBytes, activeDurationMs],
  );

  const lines: string[] = [];

  // 1. Resolution
  if (config.showResolution && snapshot.videoWidth != null && snapshot.videoHeight != null) {
    lines.push(`${snapshot.videoWidth}x${snapshot.videoHeight}`);
  }

  // 2. FPS
  if (config.showFps && snapshot.videoFrameRate != null) {
    lines.push(`${snapshot.videoFrameRate} fps`);
  }

  // 3. Bitrate
  if (config.showBitrate && snapshot.videoBitrateBps != null) {
    lines.push(formatBandwidth(snapshot.videoBitrateBps));
  }

  // 4. Dropped frames
  if (config.showDroppedFrames) {
    lines.push(`${droppedFramesInLast5s} dropped in 5s`);
  }

  // 5. Network (realtime  |  total  |  est/hr)
  if (config.showNetworkUsage) {
    const realtime = formatBandwidth(bandwidthBps);
    const total = formatTotalBytes(totalBytes);
    const hourly = hourlyEstimate > 0 ? fmtHourlyUsage(hourlyEstimate) : "\u2014";
    lines.push(`${realtime}  |  ${total}  |  ${hourly}`);
  }

  return (
    <div
      className="absolute top-3 right-3 z-30 bg-black/60 rounded-md p-2.5 font-mono tabular-nums leading-relaxed"
      style={{
        width: config.boxWidth,
        fontSize: config.fontSize,
        color: config.textColor,
      }}
    >
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

export const StreamInfoCard = memo(StreamInfoCardInner);
