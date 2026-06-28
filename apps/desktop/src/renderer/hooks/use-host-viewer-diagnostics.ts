import { useState, useEffect, useRef, useCallback } from "react";
import type { QualityCoordinator } from "@/services/quality-coordinator";
import type { ViewerQualityRequest } from "@screenlink/shared";
import { pollStats } from "@screenlink/vdo-adapter";
import type { StatsSnapshot, VDONinjaSDK } from "@screenlink/vdo-adapter";
import { StreamMetricsService } from "@/services/stream-metrics-service";

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface ViewerStatusEvent {
  viewerDeviceId: string;
  streamId: string;
  state: "playing" | "paused" | "reconnecting";
  viewerDisplayName?: string;
  receivedBitrateKbps: number | null;
  receivedWidth: number | null;
  receivedHeight: number | null;
  displayedFps: number | null;
  sampledAt: number;
}

type HostObservedViewerStats = {
  sentBitrateKbps: number | null;
  packetLossPercent: number | null;
  rttMs: number | null;
  sentWidth: number | null;
  sentHeight: number | null;
  sentFps: number | null;
  codec: string | null;
};

export interface ViewerRow {
  viewerDeviceId: string;
  displayName: string;
  connectedAt: number;

  state: "playing" | "paused" | "reconnecting" | "unknown";

  received: {
    bitrateKbps: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
  };

  sent: {
    bitrateKbps: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    packetLossPercent: number | null;
    rttMs: number | null;
    codec: string | null;
  };

  requested: {
    bitrateKbps: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    presetName: string | null;
  };

  lastStatusAt: number | null;
}

/**
 * Minimal viewer binding info: maps a viewerDeviceId to its media peer UUID
 * so the hook can correlate host-side WebRTC stats with status events.
 */
export interface ViewerBinding {
  viewerDeviceId: string;
  mediaPeerUuid: string;
}

const STALE_STATUS_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;
const EMPTY_RECEIVED: ViewerRow["received"] = { bitrateKbps: null, width: null, height: null, fps: null };
const EMPTY_SENT: ViewerRow["sent"] = { bitrateKbps: null, width: null, height: null, fps: null, packetLossPercent: null, rttMs: null, codec: null };
const EMPTY_REQUESTED: ViewerRow["requested"] = { bitrateKbps: null, width: null, height: null, fps: null, presetName: null };

function toSentStats(stats: HostObservedViewerStats | null): ViewerRow["sent"] {
  if (!stats) return EMPTY_SENT;
  return {
    bitrateKbps: stats.sentBitrateKbps,
    width: stats.sentWidth,
    height: stats.sentHeight,
    fps: stats.sentFps,
    packetLossPercent: stats.packetLossPercent,
    rttMs: stats.rttMs,
    codec: stats.codec,
  };
}

function isViewerStatusEvent(value: unknown): value is ViewerStatusEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).viewerDeviceId === "string" &&
    typeof (value as Record<string, unknown>).state === "string"
  );
}

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function computeHostStats(snapshot: StatsSnapshot): Omit<HostObservedViewerStats, "sentBitrateKbps"> {
  const outbound = snapshot.outbound as Record<string, unknown> | undefined;
  const remoteInbound = snapshot.remoteInbound as Record<string, unknown> | undefined;
  const candidatePair = snapshot.candidatePair as Record<string, unknown> | undefined;
  const codec = snapshot.codec as Record<string, unknown> | undefined;

  const sentWidth = (outbound?.frameWidth as number) ?? null;
  const sentHeight = (outbound?.frameHeight as number) ?? null;
  const sentFps = (outbound?.framesPerSecond as number) ?? null;

  let packetLossPercent: number | null = null;
  if (remoteInbound) {
    const fractionLost = remoteInbound.fractionLost as number | undefined;
    if (typeof fractionLost === "number" && fractionLost >= 0) {
      packetLossPercent = fractionLost * 100;
    }
  }

  let rttMs: number | null = null;
  if (candidatePair) {
    const rtt = candidatePair.currentRoundTripTime as number | undefined;
    if (typeof rtt === "number") {
      rttMs = rtt * 1000;
    }
  }

  const codecMimeType = typeof codec?.mimeType === "string" ? codec.mimeType : null;

  return {
    packetLossPercent,
    rttMs,
    sentWidth,
    sentHeight,
    sentFps,
    codec: codecMimeType,
  };
}

// â”€â”€â”€ Hook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function useHostViewerDiagnostics(
  sdk: VDONinjaSDK | null,
  /** Viewer bindings from ViewerMediaBinding â€” bridges viewerDeviceId â†” mediaPeerUuid for host stats. */
  viewerBindings: ViewerBinding[],
  qualityCoordinator: QualityCoordinator | null,
  groupId: string,
  logicalStreamId: string,
): ViewerRow[] {
  const [rows, setRows] = useState<ViewerRow[]>([]);
  const statusMapRef = useRef<Map<string, ViewerStatusEvent>>(new Map());
  const bytesRef = useRef<Map<string, { lastBytes: number; lastTime: number }>>(new Map());
  const bindingRef = useRef(viewerBindings);
  bindingRef.current = viewerBindings;

  // Listen for viewer.status events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (isViewerStatusEvent(detail)) {
        statusMapRef.current.set(detail.viewerDeviceId, detail);
      }
    };
    window.addEventListener("screenlink:viewer-status", handler);
    return () => window.removeEventListener("screenlink:viewer-status", handler);
  }, []);

  // Poll host-side SDK stats per peer UUID
  const pollHostStats = useCallback(async () => {
    if (!sdk) return null;

    const newBytes = new Map<string, { lastBytes: number; lastTime: number }>();
    const newStats = new Map<string, HostObservedViewerStats>();

    for (const [uuid, group] of sdk.connections) {
      const pc = group.publisher?.pc;
      if (!pc) continue;

      try {
        const snapshot = await pollStats(pc);
        const base = computeHostStats(snapshot);

        let sentBitrateKbps: number | null = null;
        const outbound = snapshot.outbound as Record<string, unknown> | undefined;
        const bytesSent = typeof outbound?.bytesSent === "number" ? outbound.bytesSent : 0;
        const prev = bytesRef.current.get(uuid);
        if (prev && prev.lastTime > 0) {
          const elapsed = (Date.now() - prev.lastTime) / 1000;
          const delta = bytesSent - prev.lastBytes;
          if (elapsed > 0 && delta >= 0) {
            sentBitrateKbps = Math.round((delta * 8) / elapsed / 1000);
          }
        }
        newBytes.set(uuid, { lastBytes: bytesSent, lastTime: Date.now() });
        newStats.set(uuid, { ...base, sentBitrateKbps });
      } catch {
        // Best effort
      }
    }

    bytesRef.current = newBytes;
    return newStats;
  }, [sdk]);

  // Merge all data sources every poll cycle
  useEffect(() => {
    let cancelled = false;

    const buildRows = async () => {
      const hostStats = await pollHostStats();
      if (cancelled) return;

      const now = Date.now();
      const newRows: ViewerRow[] = [];
      const seen = new Set<string>();

      // Build a peerUuid â†’ viewerDeviceId map from bindings
      const peerToViewer = new Map<string, string>();
      for (const b of bindingRef.current) {
        peerToViewer.set(b.mediaPeerUuid, b.viewerDeviceId);
      }

      // 1) Emit rows for viewers from status events (primary source)
      for (const [viewerDeviceId, status] of statusMapRef.current) {
        if (seen.has(viewerDeviceId)) continue;
        seen.add(viewerDeviceId);

        const isStale = (now - status.sampledAt) > STALE_STATUS_MS;
        const state: ViewerRow["state"] = isStale ? "unknown" : status.state;
        const displayName = status.viewerDisplayName ?? viewerDeviceId.slice(0, 8);

        // Look up host stats for this viewer by finding their media peer UUID
        const peerUuid = peerToViewer.get(viewerDeviceId) ?? null;
        const hostStat = peerUuid ? (hostStats?.get(peerUuid) ?? null) : null;

        let requested: ViewerRow["requested"] = EMPTY_REQUESTED;
        if (qualityCoordinator) {
          const req: ViewerQualityRequest | null = qualityCoordinator.getViewerRequest(
            groupId, logicalStreamId, viewerDeviceId,
          );
          if (req) {
            requested = {
              bitrateKbps: req.videoBitrateKbps, width: req.maxWidth,
              height: req.maxHeight, fps: req.maxFps,
              presetName: req.degradationPreference,
            };
          }
        }

        newRows.push({
          viewerDeviceId,
          displayName,
          connectedAt: status.sampledAt,
          state,
          received: !isStale && state !== "paused"
            ? {
                bitrateKbps: status.receivedBitrateKbps,
                width: status.receivedWidth,
                height: status.receivedHeight,
                fps: status.displayedFps,
              }
            : EMPTY_RECEIVED,
          sent: toSentStats(hostStat),
          requested,
          lastStatusAt: status.sampledAt,
        });
      }

      // 2) Emit rows for viewers with host stats but no status yet
      if (hostStats) {
        for (const [peerUuid] of hostStats) {
          const viewerDeviceId = peerToViewer.get(peerUuid) ?? `sdk:${peerUuid.slice(0, 8)}`;
          if (seen.has(viewerDeviceId)) {
            // Already emitted above â€” augment with host stats
            const existing = newRows.find((r) => r.viewerDeviceId === viewerDeviceId);
            if (existing) existing.sent = toSentStats(hostStats.get(peerUuid) ?? null);
            continue;
          }
          seen.add(viewerDeviceId);
          newRows.push({
            viewerDeviceId,
            displayName: viewerDeviceId.slice(0, 8),
            connectedAt: now,
            state: "unknown",
            received: EMPTY_RECEIVED,
            sent: toSentStats(hostStats.get(peerUuid) ?? null),
            requested: EMPTY_REQUESTED,
            lastStatusAt: null,
          });
        }
      }

      if (!cancelled) setRows(newRows);
    };

    buildRows();
    const interval = setInterval(buildRows, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sdk, qualityCoordinator, groupId, logicalStreamId, pollHostStats]);

  return rows;
}

