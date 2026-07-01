import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { StreamMetricsService } from "@/services/stream-metrics-service";
import { estimateHourlyBytes, fmtHourlyUsage } from "@/services/bandwidth-telemetry-types";

// ─── Props ──────────────────────────────────────────────────────────────────

interface BandwidthDisplayProps {
  currentBandwidthBps: number;
  totalBytesReceived: number;
  activeDurationMs: number;
  viewerHistoryId?: string | null;
  /** Called when the bandwidth display is clicked (opens bandwidth modal) */
  onOpenBandwidthModal: () => void;
}

// ─── Formatting helpers (local, mirrors VideoControls) ─────────────────────

function formatBandwidth(bps: number): string {
  if (bps <= 0) return "0 K";
  const Bps = bps / 8;
  if (Bps < 1000) return `${Math.round(Bps)} B`;
  const kBps = Bps / 1000;
  if (kBps < 1000) return `${kBps.toFixed(1)} K`;
  return `${(kBps / 1000).toFixed(2)} M`;
}

function formatTotalBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBitrateShort(bps: number): string {
  if (bps <= 0) return "0";
  const Bps = bps / 8;
  if (Bps < 1000) return `${Math.round(Bps)} B/s`;
  const kBps = Bps / 1000;
  if (kBps < 1000) return `${kBps.toFixed(1)} kB/s`;
  return `${(kBps / 1000).toFixed(2)} MB/s`;
}

// ─── useBandwidthSplit hook ─────────────────────────────────────────────────

interface BandwidthSplit {
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
}

const EMPTY_BANDWIDTH_SPLIT: BandwidthSplit = Object.freeze({
  videoBitsPerSecond: 0,
  audioBitsPerSecond: 0,
});

function useBandwidthSplit(historyId: string | null | undefined): BandwidthSplit {
  const cachedSnapshotRef = useRef<BandwidthSplit>(EMPTY_BANDWIDTH_SPLIT);

  const subscribe = useCallback((onStoreChange: () => void) => {
    if (!historyId) return () => {};
    return StreamMetricsService.getInstance().subscribe(historyId, onStoreChange);
  }, [historyId]);

  const getSnapshot = useCallback((): BandwidthSplit => {
    if (!historyId) {
      cachedSnapshotRef.current = EMPTY_BANDWIDTH_SPLIT;
      return EMPTY_BANDWIDTH_SPLIT;
    }

    let nextSnapshot = EMPTY_BANDWIDTH_SPLIT;

    try {
      const snap = StreamMetricsService.getInstance().getSnapshot(historyId);
      const samples = snap.aggregate.rawSamples;
      if (samples.length > 0) {
        const latest = samples[samples.length - 1];
        nextSnapshot = {
          videoBitsPerSecond: latest.videoBitsPerSecond ?? 0,
          audioBitsPerSecond: latest.audioBitsPerSecond ?? 0,
        };
      }
    } catch {
      nextSnapshot = EMPTY_BANDWIDTH_SPLIT;
    }

    const cached = cachedSnapshotRef.current;
    if (
      cached.videoBitsPerSecond === nextSnapshot.videoBitsPerSecond
      && cached.audioBitsPerSecond === nextSnapshot.audioBitsPerSecond
    ) {
      return cached;
    }

    cachedSnapshotRef.current = nextSnapshot;
    return nextSnapshot;
  }, [historyId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

// ─── BandwidthDisplay ───────────────────────────────────────────────────────

/**
 * BandwidthDisplay — Visible viewer bandwidth/data counter.
 *
 * Primary value is total media bitrate. The tooltip shows the video/audio
 * composition breakdown and cumulative totals.
 *
 * Subscribes to StreamMetricsService internally for the video/audio split
 * without requiring additional props from parent wiring.
 */
export function BandwidthDisplay({
  currentBandwidthBps,
  totalBytesReceived,
  activeDurationMs,
  viewerHistoryId = null,
  onOpenBandwidthModal,
}: BandwidthDisplayProps) {
  const split = useBandwidthSplit(viewerHistoryId);

  const hourlyEstimate = useMemo(
    () => estimateHourlyBytes(totalBytesReceived, activeDurationMs),
    [totalBytesReceived, activeDurationMs],
  );

  const hasSplitData = split.videoBitsPerSecond > 0 || split.audioBitsPerSecond > 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="text-sm font-bold text-white font-mono px-1.5 cursor-pointer select-none tabular-nums"
          onClick={onOpenBandwidthModal}
        >
          {formatBandwidth(currentBandwidthBps)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="space-y-1">
        <div className="font-medium text-text-primary text-xs border-b border-white/10 pb-1 mb-1">
          {formatBandwidth(currentBandwidthBps)}
        </div>
        {hasSplitData && (
          <div className="space-y-0.5 text-[11px]">
            <div className="flex justify-between gap-4">
              <span className="text-text-muted">Video</span>
              <span className="font-mono tabular-nums text-text-primary">
                {formatBitrateShort(split.videoBitsPerSecond)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-text-muted">Audio</span>
              <span className="font-mono tabular-nums text-text-primary">
                {formatBitrateShort(split.audioBitsPerSecond)}
              </span>
            </div>
          </div>
        )}
        <div className="space-y-0.5 text-[11px] pt-0.5 border-t border-white/10">
          <div className="flex justify-between gap-4">
            <span className="text-text-muted">Total data</span>
            <span className="font-mono tabular-nums text-text-primary">
              {formatTotalBytes(totalBytesReceived)}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-muted">Est/hr</span>
            <span className="font-mono tabular-nums text-text-primary">
              {hourlyEstimate > 0 ? fmtHourlyUsage(hourlyEstimate) : "\u2014"}
            </span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Test exports ──────────────────────────────────────────────────────────
export { formatBandwidth, formatTotalBytes, formatBitrateShort };
