import { useState, useEffect, useRef, useCallback } from "react";
import type { ViewerInfo } from "@/stores/main-store";
import type { QualityCoordinator } from "@/services/quality-coordinator";
import type { ViewerQualityRequest } from "@screenlink/shared";
import { pollStats } from "@screenlink/vdo-adapter";
import type { StatsSnapshot, VDONinjaSDK } from "@screenlink/vdo-adapter";

// ─── Types ─────────────────────────────────────────────────────────────────

interface ViewerStatusEvent {
  viewerDeviceId: string;
  streamId: string;
  state: "playing" | "paused" | "reconnecting";
  receivedBitrateKbps: number | null;
  receivedWidth: number | null;
  receivedHeight: number | null;
  displayedFps: number | null;
  sampledAt: number;
}

interface HostObservedViewerStats {
  sentBitrateKbps: number | null;
  packetLossPercent: number | null;
  rttMs: number | null;
  sentWidth: number | null;
  sentHeight: number | null;
  sentFps: number | null;
  codec: string | null;
}

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

const STALE_STATUS_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;
const EMPTY_RECEIVED = { bitrateKbps: null, width: null, height: null, fps: null } as const;
const EMPTY_SENT = { bitrateKbps: null, width: null, height: null, fps: null, packetLossPercent: null, rttMs: null, codec: null } as const;
const EMPTY_REQUESTED = { bitrateKbps: null, width: null, height: null, fps: null, presetName: null } as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeHostStats(snapshot: StatsSnapshot): HostObservedViewerStats {
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
    sentBitrateKbps: null,
    packetLossPercent,
    rttMs,
    sentWidth,
    sentHeight,
    sentFps,
    codec: codecMimeType,
  };
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useHostViewerDiagnostics(
  sdk: VDONinjaSDK | null,
  viewers: ViewerInfo[],
  qualityCoordinator: QualityCoordinator | null,
  groupId: string,
  logicalStreamId: string,
): ViewerRow[] {
  const [rows, setRows] = useState<ViewerRow[]>([]);
  const statusMapRef = useRef<Map<string, ViewerStatusEvent>>(new Map());
  const bytesRef = useRef<Map<string, { lastBytes: number; lastTime: number }>>(new Map());

  // Listen for viewer.status events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as ViewerStatusEvent;
      if (detail && detail.viewerDeviceId) {
        statusMapRef.current.set(detail.viewerDeviceId, detail);
      }
    };
    window.addEventListener("screenlink:viewer-status", handler);
    return () => window.removeEventListener("screenlink:viewer-status", handler);
  }, []);

  // Poll host-side SDK stats
  const pollHostStats = useCallback(async () => {
    if (!sdk) return null;

    const newBytes = new Map<string, { lastBytes: number; lastTime: number }>();
    const newStats = new Map<string, HostObservedViewerStats>();

    for (const [uuid, group] of sdk.connections) {
      const pc = group.publisher?.pc;
      if (!pc) continue;

      try {
        const snapshot = await pollStats(pc);
        const stats = computeHostStats(snapshot);

        const outbound = snapshot.outbound as Record<string, unknown> | undefined;
        const bytesSent = typeof outbound?.bytesSent === "number" ? outbound.bytesSent : 0;
        const prev = bytesRef.current.get(uuid);
        if (prev && prev.lastTime > 0) {
          const elapsed = (Date.now() - prev.lastTime) / 1000;
          const delta = bytesSent - prev.lastBytes;
          if (elapsed > 0 && delta >= 0) {
            stats.sentBitrateKbps = Math.round((delta * 8) / elapsed / 1000);
          }
        }
        newBytes.set(uuid, { lastBytes: bytesSent, lastTime: Date.now() });
        newStats.set(uuid, stats);
      } catch {
        // Best effort
      }
    }

    bytesRef.current = newBytes;
    return newStats;
  }, [sdk]);

  // Merge all data sources every poll cycle
  useEffect(() => {
    if (viewers.length === 0) {
      setRows([]);
      return;
    }

    let cancelled = false;

    const buildRows = async () => {
      const hostStats = await pollHostStats();
      if (cancelled) return;

      const now = Date.now();
      const newRows: ViewerRow[] = [];

      for (const viewer of viewers) {
        const status = statusMapRef.current.get(viewer.viewerDeviceId);
        const isStale = !status || (now - status.sampledAt) > STALE_STATUS_MS;

        let state: ViewerRow["state"] = "unknown";
        if (status) {
          state = status.state;
          if (isStale) state = "unknown";
        }

        const hostStat = hostStats?.get(viewer.peerUuid) ?? null;

        let requested: ViewerRow["requested"] = { ...EMPTY_REQUESTED };
        if (qualityCoordinator) {
          const req: ViewerQualityRequest | null = qualityCoordinator.getViewerRequest(
            groupId,
            logicalStreamId,
            viewer.viewerDeviceId,
          );
          if (req) {
            requested = {
              bitrateKbps: req.videoBitrateKbps,
              width: req.maxWidth,
              height: req.maxHeight,
              fps: req.maxFps,
              presetName: null,
            };
          }
        }

        newRows.push({
          viewerDeviceId: viewer.viewerDeviceId,
          displayName: viewer.displayName,
          connectedAt: viewer.connectedAt,
          state,
          received: status && !isStale && state !== "paused"
            ? {
                bitrateKbps: status.receivedBitrateKbps,
                width: status.receivedWidth,
                height: status.receivedHeight,
                fps: status.displayedFps,
              }
            : { ...EMPTY_RECEIVED },
          sent: hostStat
            ? {
                bitrateKbps: hostStat.sentBitrateKbps,
                width: hostStat.sentWidth,
                height: hostStat.sentHeight,
                fps: hostStat.sentFps,
                packetLossPercent: hostStat.packetLossPercent,
                rttMs: hostStat.rttMs,
                codec: hostStat.codec,
              }
            : { ...EMPTY_SENT },
          requested,
          lastStatusAt: status?.sampledAt ?? null,
        });
      }

      if (!cancelled) setRows(newRows);
    };

    buildRows();
    const interval = setInterval(buildRows, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [viewers, sdk, qualityCoordinator, groupId, logicalStreamId, pollHostStats]);

  return rows;
}
