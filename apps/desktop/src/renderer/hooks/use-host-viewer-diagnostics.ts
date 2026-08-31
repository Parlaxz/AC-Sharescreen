import { useState, useEffect, useRef, useCallback } from "react";
import type { QualityCoordinator } from "@/services/quality-coordinator";
import type { ViewerQualityRequest } from "@screenlink/shared";
import type { VDONinjaSDK } from "@screenlink/vdo-adapter";
import { StreamMetricsService } from "@/services/stream-metrics-service";
import type { ConnectionTelemetrySnapshot } from "@/services/bandwidth-telemetry-types";

// ─── Types ──────────────────────────────────────────────────────────────────

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
  receivedAt: number;
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
  const record = value as Record<string, unknown>;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof record.viewerDeviceId === "string" &&
    (record.state === "playing" || record.state === "paused" || record.state === "reconnecting")
  );
}

/** Build HostObservedViewerStats from a StreamMetricsService connection snapshot. */
function buildStatsFromConnectionSnapshot(snap: ConnectionTelemetrySnapshot): HostObservedViewerStats {
  const latestSample = snap.rawSamples[snap.rawSamples.length - 1];
  return {
    sentBitrateKbps: snap.currentVideoBitsPerSecond !== null
      ? Math.round(snap.currentVideoBitsPerSecond / 1000)
      : null,
    packetLossPercent: latestSample?.packetLossPercent ?? null,
    rttMs: latestSample?.rttMs ?? null,
    sentWidth: latestSample?.width ?? null,
    sentHeight: latestSample?.height ?? null,
    sentFps: latestSample?.framesPerSecond ?? null,
    codec: latestSample?.codec ?? null,
  };
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useHostViewerDiagnostics(
  sdk: VDONinjaSDK | null,
  viewerBindings: ViewerBinding[],
  qualityCoordinator: QualityCoordinator | null,
  groupId: string,
  logicalStreamId: string,
  mediaSessionId?: string | null,
): ViewerRow[] {
  const [rows, setRows] = useState<ViewerRow[]>([]);
  const statusMapRef = useRef<Map<string, ViewerStatusEvent>>(new Map());
  const registrationsRef = useRef<Map<string, { pc: RTCPeerConnection; unregister: () => void }>>(new Map());
  const historyIdRef = useRef<string | null>(null);
  const bindingRef = useRef(viewerBindings);
  bindingRef.current = viewerBindings;

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (isViewerStatusEvent(detail)) {
        const receivedAt = Date.now();
        const sampledAt = typeof detail.sampledAt === "number" && Number.isFinite(detail.sampledAt)
          ? detail.sampledAt
          : receivedAt;
        const previous = statusMapRef.current.get(detail.viewerDeviceId);
        if (previous && sampledAt < previous.sampledAt) return;
        statusMapRef.current.set(detail.viewerDeviceId, { ...detail, sampledAt, receivedAt });
      }
    };
    window.addEventListener("screenlink:viewer-status", handler);
    return () => window.removeEventListener("screenlink:viewer-status", handler);
  }, []);

  useEffect(() => {
    statusMapRef.current.clear();
    setRows([]);
  }, [logicalStreamId]);

  // ─── Return cleanup on unmount ─────────────────────────────────────

  useEffect(() => {
    return () => {
      const svc = StreamMetricsService.getInstance();
      for (const [connId, entry] of registrationsRef.current) {
        entry.unregister();
      }
      registrationsRef.current.clear();
      if (historyIdRef.current) {
        const id = historyIdRef.current;
        historyIdRef.current = null;
        svc.finalizeSession(id).catch(() => {});
      }
    };
  }, []);

  const pollHostStats = useCallback(() => {
    if (!sdk) return null;

    const newStats = new Map<string, HostObservedViewerStats>();
    const svc = StreamMetricsService.getInstance();

    const peerToViewer = new Map<string, ViewerBinding>();
    for (const b of bindingRef.current) {
      peerToViewer.set(b.mediaPeerUuid, b);
    }

    const activeUuids = new Set<string>();

    // Enumerate SDK connections to track active peers and manage registrations.
    for (const [uuid, group] of sdk.connections) {
      activeUuids.add(uuid);
      const pc = group.publisher?.pc;
      if (!pc) continue;

      // Register with StreamMetricsService (unchanged from prior phase)
      if (mediaSessionId) {
        const connId = `host-${uuid}`;
        const existing = registrationsRef.current.get(connId);

        // PC changed (reconnect) — replace registration
        if (existing && existing.pc !== pc) {
          existing.unregister();
          registrationsRef.current.delete(connId);
        }

        if (!registrationsRef.current.has(connId)) {
          let historyId = historyIdRef.current;
          if (!historyId) {
            historyId = svc.startViewerSession(mediaSessionId, logicalStreamId, groupId, "");
            historyIdRef.current = historyId;
          }

          const binding = peerToViewer.get(uuid);
          const viewerDeviceId = binding?.viewerDeviceId ?? null;
          const displayName = viewerDeviceId?.slice(0, 8) ?? null;

          const unregister = svc.registerConnection({
            historyId,
            connectionId: connId,
            viewerDeviceId,
            displayName,
            peerConnection: pc,
            direction: "outbound",
          });
          registrationsRef.current.set(connId, { pc, unregister });
        }
      }
    }

    // Unregister disappeared peers
    for (const [connId, entry] of registrationsRef.current) {
      const uuid = connId.replace("host-", "");
      if (!activeUuids.has(uuid)) {
        entry.unregister();
        registrationsRef.current.delete(connId);
      }
    }

    // Build stats from StreamMetricsService connection snapshots
    const historyId = historyIdRef.current;
    if (historyId) {
      const snapshot = svc.getSnapshot(historyId);
      for (const conn of snapshot.connections) {
        const uuid = conn.connectionId.replace("host-", "");
        if (activeUuids.has(uuid)) {
          newStats.set(uuid, buildStatsFromConnectionSnapshot(conn));
        }
      }
    }

    return newStats;
  }, [sdk, mediaSessionId, logicalStreamId, groupId]);

  // Merge all data sources every poll cycle
  useEffect(() => {
    let cancelled = false;

    const buildRows = () => {
      const hostStats = pollHostStats();
      if (cancelled) return;

      const now = Date.now();
      const newRows: ViewerRow[] = [];
      const seen = new Set<string>();

      const peerToViewer = new Map<string, string>();
      const boundViewers = new Set<string>();
      for (const b of bindingRef.current) {
        peerToViewer.set(b.mediaPeerUuid, b.viewerDeviceId);
        boundViewers.add(b.viewerDeviceId);
      }

      // 1) Emit rows for viewers from status events (primary source).
      //    Only show viewers that have an active binding — kicked viewers
      //    (whose bindings have been removed) are excluded even if they
      //    continue sending status reports over the group control channel.
      for (const [viewerDeviceId, status] of statusMapRef.current) {
        if (seen.has(viewerDeviceId)) continue;
        if (!boundViewers.has(viewerDeviceId)) continue;
        if (status.streamId !== logicalStreamId) continue;
        seen.add(viewerDeviceId);

        const isStale = (now - status.receivedAt) > STALE_STATUS_MS;
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
          connectedAt: status.receivedAt,
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
          lastStatusAt: status.receivedAt,
        });
      }

      // 2) Augment existing rows with host stats
      if (hostStats) {
        for (const [peerUuid] of hostStats) {
          const viewerDeviceId = peerToViewer.get(peerUuid);
          if (!viewerDeviceId) continue;
          if (seen.has(viewerDeviceId)) {
            const existing = newRows.find(function(r) { return r.viewerDeviceId === viewerDeviceId; });
            if (existing) existing.sent = toSentStats(hostStats.get(peerUuid) ?? null);
          }
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
