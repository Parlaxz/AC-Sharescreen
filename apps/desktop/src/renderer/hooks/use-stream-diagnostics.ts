/**
 * use-stream-diagnostics — Standalone hook for polling viewer diagnostics
 * from ViewerSession.
 *
 * Polls every 2 s, converts raw RTC stats into a stable DiagnosticsSnapshot
 * shape suitable for DiagnosticsPanel or other consumers.
 */

import { useState, useEffect, useRef } from "react";
import type { ViewerSession } from "@/services/viewer-session.js";

// ─── DiagnosticsSnapshot ────────────────────────────────────────────────────

export interface DiagnosticsSnapshot {
  connectionState: string | null;
  selectedCandidatePair: string | null;
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
  audioCodec: string | null;
  audioBitrateBps: number | null;
  audioPacketsReceived: number;
  audioPacketsLost: number;
  audioJitter: number | null;
  audioBytesReceived: number;
  rttMs: number | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  isRelay: boolean;
  requestedBitrateKbps: number | null;
  effectiveBitrateKbps: number | null;
  senderMaxBitrateBps: number | null;
  timestamp: number | null;
}

// ─── EMPTY_DIAGNOSTICS ──────────────────────────────────────────────────────

export const EMPTY_DIAGNOSTICS: DiagnosticsSnapshot = {
  connectionState: null,
  selectedCandidatePair: null,
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
  isRelay: false,
  requestedBitrateKbps: null,
  effectiveBitrateKbps: null,
  senderMaxBitrateBps: null,
  timestamp: null,
};

// ─── useStreamDiagnostics ───────────────────────────────────────────────────

export function useStreamDiagnostics(
  session: ViewerSession | null,
  extraQuality?: {
    lastRequested?: { videoBitrateKbps?: number } | null;
    effectiveKbps?: number | null;
    configuredBps?: number | null;
  },
): { snapshot: DiagnosticsSnapshot; droppedFramesInLast5s: number } {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(EMPTY_DIAGNOSTICS);
  const [droppedFramesInLast5s, setDroppedFramesInLast5s] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const droppedRef = useRef<Array<{ framesDropped: number; time: number }>>([]);

  useEffect(() => {
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
          const inboundVideo = diag.inboundVideo;
          const inboundAudio = diag.inboundAudio;
          const pair = diag.selectedCandidatePair;

          const localType = diag.localCandidateType;
          const remoteType = diag.remoteCandidateType;
          const realRttMs = diag.rttMs;
          const isRelay = localType === "relay" || remoteType === "relay";

          const lrq = extraQuality?.lastRequested;
          const ekbps = extraQuality?.effectiveKbps;
          const cbBps = extraQuality?.configuredBps;

          setSnapshot({
            connectionState: diag.connectionState,
            selectedCandidatePair: pair,
            videoCodec: inboundVideo.codecId,
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
            requestedBitrateKbps: lrq?.videoBitrateKbps ?? null,
            effectiveBitrateKbps: ekbps ?? null,
            senderMaxBitrateBps: cbBps ?? null,
            timestamp: diag.timestamp,
          });

          // Track dropped frames over a rolling ~5s window
          if (inboundVideo.framesDropped != null) {
            const now = Date.now();
            droppedRef.current.push({ framesDropped: inboundVideo.framesDropped, time: now });
            const cutoff = now - 6000;
            droppedRef.current = droppedRef.current.filter((s) => s.time >= cutoff);

            if (droppedRef.current.length >= 2) {
              const oldest = droppedRef.current[0];
              const newest = droppedRef.current[droppedRef.current.length - 1];
              setDroppedFramesInLast5s(Math.max(0, newest.framesDropped - oldest.framesDropped));
            }
          }
        }
      } catch {
        // best-effort
      }
    };

    poll();
    pollRef.current = setInterval(poll, 2000);

    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [session, extraQuality?.lastRequested, extraQuality?.effectiveKbps, extraQuality?.configuredBps]);

  return { snapshot, droppedFramesInLast5s };
}
