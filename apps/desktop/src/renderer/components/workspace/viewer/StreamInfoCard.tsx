import { useCallback, useMemo, useRef, useSyncExternalStore, memo } from "react";
import { formatBandwidth, formatTotalBytes } from "./BandwidthDisplay.js";
import { computeWindowedEstimate, fmtHourlyUsage } from "@/services/bandwidth-telemetry-types";
import type { BandwidthSnapshot } from "@/services/bandwidth-telemetry-types";
import { StreamMetricsService } from "@/services/stream-metrics-service";
import type { StreamInfoCardConfig } from "@screenlink/shared";

// ─── Config type (imported from @screenlink/shared, Phase 3) ───────────────

// ─── Windowed hourly estimate hook ──────────────────────────────────────────

function useWindowedHourlyEstimate(
  historyId: string | null | undefined,
  windowMs: number,
): number {
  const cachedRef = useRef<number>(0);

  const subscribe = useCallback((onStoreChange: () => void) => {
    if (!historyId) return () => {};
    return StreamMetricsService.getInstance().subscribe(historyId, onStoreChange);
  }, [historyId]);

  const getSnapshot = useCallback((): number => {
    if (!historyId) return 0;
    try {
      const snap: BandwidthSnapshot = StreamMetricsService.getInstance().getSnapshot(historyId);
      const result = computeWindowedEstimate(
        snap.aggregate.rawSamples,
        windowMs,
        snap.aggregate.totalBytes,
        snap.aggregate.activeDurationMs,
      );
      cachedRef.current = result.bytesPerHour;
      return result.bytesPerHour;
    } catch {
      return cachedRef.current;
    }
  }, [historyId, windowMs]);

  return useSyncExternalStore(subscribe, getSnapshot);
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
  viewerHistoryId?: string | null;
}

export function formatHudFps(fps: number): string {
  return `${Math.floor(fps).toString().padStart(2, "0")} FPS`;
}

export function formatViewingDuration(activeDurationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(activeDurationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

// ─── Component ───────────────────────────────────────────────────────────────

function StreamInfoCardInner({
  snapshot,
  droppedFramesInLast5s,
  config,
  bandwidthBps,
  totalBytes,
  activeDurationMs,
  viewerHistoryId,
}: StreamInfoCardProps) {
  const hourlyEstimate = useWindowedHourlyEstimate(viewerHistoryId, 10_000);

  const lines: string[] = [];

  lines.push(`Viewing ${formatViewingDuration(activeDurationMs)}`);

  // 1. Resolution
  if (config.showResolution && snapshot.videoWidth != null && snapshot.videoHeight != null) {
    lines.push(`${snapshot.videoWidth}x${snapshot.videoHeight}`);
  }

  // 2. FPS
  if (config.showFps && snapshot.videoFrameRate != null) {
    lines.push(formatHudFps(snapshot.videoFrameRate));
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
