import { useState, useEffect, useRef, useCallback } from "react";
import type { QualityCoordinator } from "@/services/quality-coordinator";
import type { ViewerQualityRequest } from "@screenlink/shared";
import type { VDONinjaSDK } from "@screenlink/vdo-adapter";
import { StreamMetricsService } from "@/services/stream-metrics-service";

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
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).viewerDeviceId === "string" &&
    typeof (value as Record<string, unknown>).state === "string"
  );
}

function computeBitrate(
  bytesSent: number,
  uuid: string,
  bytesRef: React.MutableRefObject<Map<string, { lastBytes: number; lastTime: number }>>,
): number | null {
  const prev = bytesRef.current.get(uuid);
  if (!prev || prev.lastTime <= 0) return null;
  const elapsed = (Date.now() - prev.lastTime) / 1000;
  const delta = bytesSent - prev.lastBytes;
  if (elapsed <= 0 || delta < 0) return null;
  return Math.round((delta * 8) / elapsed / 1000);
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
  const bytesRef = useRef<Map<string, { lastBytes: number; lastTime: number }>>(new Map());
  const registrationsRef = useRef<Map<string, { pc: RTCPeerConnection; unregister: () => void }>>(new Map());
  const historyIdRef = useRef<string | null>(null);
  const bindingRef = useRef(viewerBindings);
  bindingRef.current = viewerBindings;

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

  // ─── Return cleanup on unmount (audit item 2) ──────────────────────

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

  const pollHostStats = useCallback(async () => {
    if (!sdk) return null;

    const newBytes = new Map<string, { lastBytes: number; lastTime: number }>();
    const newStats = new Map<string, HostObservedViewerStats>();
    const svc = StreamMetricsService.getInstance();

    const peerToViewer = new Map<string, ViewerBinding>();
    for (const b of bindingRef.current) {
      peerToViewer.set(b.mediaPeerUuid, b);
    }

    const activeUuids = new Set<string>();

    for (const [uuid, group] of sdk.connections) {
      activeUuids.add(uuid);
      const pc = group.publisher?.pc;
      if (!pc) continue;

      try {
        const report = await pc.getStats();
        let bytesSent = 0;
        let sentWidth: number | null = null;
        let sentHeight: number | null = null;
        let sentFps: number | null = null;
        let mimeType: string | null = null;
        let fractionLost: number | null = null;
        let rttMsVal: number | null = null;

        for (const [, r] of report) {
          if (r.type === "outbound-rtp" && r.kind === "video") {
            bytesSent = (r as Record<string, unknown>).bytesSent as number ?? 0;
            sentWidth = (r as Record<string, unknown>).frameWidth as number ?? null;
            sentHeight = (r as Record<string, unknown>).frameHeight as number ?? null;
            sentFps = (r as Record<string, unknown>).framesPerSecond as number ?? null;
          }
          if (r.type === "remote-inbound-rtp" && r.kind === "video") {
            fractionLost = (r as Record<string, unknown>).fractionLost as number ?? null;
          }
          if (r.type === "candidate-pair") {
            const state = (r as Record<string, unknown>).state as string;
            const nom = (r as Record<string, unknown>).nominated as boolean;
            if (state === "succeeded" || nom) {
              const rtt = (r as Record<string, unknown>).currentRoundTripTime as number;
              if (typeof rtt === "number") rttMsVal = rtt * 1000;
            }
          }
          if (r.type === "codec") {
            mimeType = (r as Record<string, unknown>).mimeType as string ?? null;
          }
        }

        const sentBitrateKbps = computeBitrate(bytesSent, uuid, bytesRef);
        newBytes.set(uuid, { lastBytes: bytesSent, lastTime: Date.now() });

        newStats.set(uuid, {
          sentBitrateKbps,
          packetLossPercent: fractionLost !== null ? fractionLost * 100 : null,
          rttMs: rttMsVal,
          sentWidth,
          sentHeight,
          sentFps,
          codec: mimeType,
        });

        // Register with StreamMetricsService (audit items 2-3)
        if (mediaSessionId && pc) {
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
              historyId = svc.startHostSession(mediaSessionId, logicalStreamId, groupId, "");
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
      } catch {
        // Best effort
      }
    }

    // Unregister disappeared peers (audit item 2)
    for (const [connId, entry] of registrationsRef.current) {
      const uuid = connId.replace("host-", "");
      if (!activeUuids.has(uuid)) {
        entry.unregister();
        registrationsRef.current.delete(connId);
      }
    }

    bytesRef.current = newBytes;
    return newStats;
  }, [sdk, mediaSessionId, logicalStreamId, groupId]);

  // Merge all data sources every poll cycle
  useEffect(() => {
    let cancelled = false;

    const buildRows = async () => {
      const hostStats = await pollHostStats();
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
