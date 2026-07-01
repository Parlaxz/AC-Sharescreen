/**
 * use-stream-diagnostics — Standalone hook for polling viewer diagnostics
 * from an RTCPeerConnection via ViewerSession.
 *
 * Extracted from the former inline poller pattern used in ViewerWorkspace.
 * Polls every 2 s, converts raw RTC stats into a stable DiagnosticsSnapshot
 * shape suitable for DiagnosticsPanel or other consumers.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { ViewerSession } from "@/services/viewer-session.js";

// ─── DiagnosticsSnapshot ────────────────────────────────────────────────────

export interface DiagnosticsSnapshot {
  /** Connection playback state ("playing" | "paused" | "reconnecting") */
  state: string | null;

  // ── Video ──────────────────────────────────────────────────────────────
  videoCodec: string | null;
  videoBitrateBps: number | null;
  resolutionWidth: number | null;
  resolutionHeight: number | null;
  decodedFps: number | null;

  // ── Audio ──────────────────────────────────────────────────────────────
  audioCodec: string | null;
  audioBitrateBps: number | null;

  // ── Aggregate ──────────────────────────────────────────────────────────
  totalBitrateBps: number | null;

  // ── Quality (from extraQuality param, not from stats) ──────────────────
  requestedBitrateBps: number | null;
  effectiveBitrateBps: number | null;
  configuredBitrateBps: number | null;

  // ── Connection health ──────────────────────────────────────────────────
  packetLossPercent: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  transportBitrateBps: number | null;

  // ── Frame health (cumulative counters) ─────────────────────────────────
  droppedFrames: number | null;
  freezeCount: number | null;

  // ── Cumulative ─────────────────────────────────────────────────────────
  totalBytes: number | null;
  packetsReceived: number | null;

  // ── Timing ─────────────────────────────────────────────────────────────
  latestSampleTimestamp: number | null;
}

// ─── EMPTY_DIAGNOSTICS ──────────────────────────────────────────────────────

export const EMPTY_DIAGNOSTICS: DiagnosticsSnapshot = {
  state: null,

  videoCodec: null,
  videoBitrateBps: null,
  resolutionWidth: null,
  resolutionHeight: null,
  decodedFps: null,

  audioCodec: null,
  audioBitrateBps: null,

  totalBitrateBps: null,

  requestedBitrateBps: null,
  effectiveBitrateBps: null,
  configuredBitrateBps: null,

  packetLossPercent: null,
  jitterMs: null,
  rttMs: null,
  transportBitrateBps: null,

  droppedFrames: null,
  freezeCount: null,

  totalBytes: null,
  packetsReceived: null,

  latestSampleTimestamp: null,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the bitrate (bps) from a byte-count delta between two samples.
 * Uses a mutable ref map keyed by an arbitrary identity string.
 */
function computeBitrateBps(
  bytes: number,
  key: string,
  bytesRef: React.MutableRefObject<Map<string, { lastBytes: number; lastTime: number }>>,
): number | null {
  const prev = bytesRef.current.get(key);
  const now = Date.now();
  if (!prev || prev.lastTime <= 0) {
    bytesRef.current.set(key, { lastBytes: bytes, lastTime: now });
    return null;
  }
  const elapsed = (now - prev.lastTime) / 1000;
  const delta = bytes - prev.lastBytes;
  bytesRef.current.set(key, { lastBytes: bytes, lastTime: now });
  if (elapsed <= 0 || delta < 0) return null;
  return Math.round((delta * 8) / elapsed);
}

/**
 * Look up a codec MIME type from an RTCStatsReport by codecId.
 */
function resolveCodec(report: RTCStatsReport, codecId: string | null): string | null {
  if (!codecId) return null;
  const codec = report.get(codecId);
  if (!codec) return null;
  return (codec as Record<string, unknown>).mimeType as string ?? null;
}

// ─── useStreamDiagnostics ───────────────────────────────────────────────────

export interface ExtraQuality {
  lastRequested?: { videoBitrateKbps?: number } | null;
  effectiveKbps?: number | null;
  configuredBps?: number | null;
}

export function useStreamDiagnostics(
  session: ViewerSession | null,
  extraQuality?: ExtraQuality,
): { snapshot: DiagnosticsSnapshot; droppedFramesInLast5s: number } {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(EMPTY_DIAGNOSTICS);

  // Track byte counts between polls for bitrate computation
  const bytesRef = useRef<Map<string, { lastBytes: number; lastTime: number }>>(new Map());

  // Rolling window of cumulative `framesDropped` values (up to 3 samples)
  const droppedFramesRef = useRef<number[]>([]);

  // Stable ref for extraQuality (read during poll, not a dep)
  const extraRef = useRef(extraQuality);
  extraRef.current = extraQuality;

  const poll = useCallback(async () => {
    if (!session) {
      setSnapshot(EMPTY_DIAGNOSTICS);
      droppedFramesRef.current = [];
      bytesRef.current = new Map();
      return;
    }

    const pc = session.getPeerConnection();
    if (!pc) {
      setSnapshot(EMPTY_DIAGNOSTICS);
      return;
    }

    try {
      const report = await pc.getStats();
      const now = Date.now();

      // Per-stream accumulators
      let videoBytes = 0;
      let audioBytes = 0;
      let videoPacketsReceived = 0;
      let videoPacketsLost = 0;
      let frameWidth: number | null = null;
      let frameHeight: number | null = null;
      let framesPerSecond: number | null = null;
      let framesDropped: number | null = null;
      let freezeCountVal: number | null = null;
      let videoCodecId: string | null = null;
      let audioCodecId: string | null = null;
      let jitterMsVal: number | null = null;
      let audioJitterMs: number | null = null;
      let totalBytes = 0;

      // Transport / candidate-pair values
      let rttMsVal: number | null = null;
      let transportBytes = 0;

      for (const [, r] of report) {
        const s = r as Record<string, unknown>;

        switch (r.type) {
          case "inbound-rtp": {
            if (s.kind === "video") {
              videoBytes = (s.bytesReceived as number) ?? 0;
              videoPacketsReceived = (s.packetsReceived as number) ?? 0;
              videoPacketsLost = (s.packetsLost as number) ?? 0;
              frameWidth = (s.frameWidth as number) ?? null;
              frameHeight = (s.frameHeight as number) ?? null;
              framesPerSecond = (s.framesPerSecond as number) ?? null;
              framesDropped = (s.framesDropped as number) ?? null;
              freezeCountVal = (s.freezeCount as number) ?? null;
              videoCodecId = (s.codecId as string) ?? null;
              jitterMsVal = (s.jitterMs as number) ?? null;
            } else if (s.kind === "audio") {
              audioBytes = (s.bytesReceived as number) ?? 0;
              audioCodecId = (s.codecId as string) ?? null;
              audioJitterMs = (s.jitterMs as number) ?? null;
            }
            break;
          }

          case "candidate-pair": {
            const state = s.state as string;
            const nominated = s.nominated as boolean;
            if (state === "succeeded" || nominated) {
              const rtt = s.currentRoundTripTime as number;
              if (typeof rtt === "number" && rtt > 0) {
                rttMsVal = rtt * 1000;
              }
            }
            break;
          }

          case "transport": {
            transportBytes = (s.bytesReceived as number) ?? 0;
            break;
          }
        }
      }

      // Resolve codec MIME types
      const videoCodec = resolveCodec(report, videoCodecId);
      const audioCodec = resolveCodec(report, audioCodecId);

      // Compute bitrates from byte deltas
      const videoBps = computeBitrateBps(videoBytes, "video", bytesRef);
      const audioBps = computeBitrateBps(audioBytes, "audio", bytesRef);
      const transportBps = computeBitrateBps(transportBytes, "transport", bytesRef);
      const totalBps =
        videoBps != null || audioBps != null
          ? (videoBps ?? 0) + (audioBps ?? 0)
          : null;

      // Compute packet loss percent
      const packetLossPercent: number | null =
        videoPacketsReceived + videoPacketsLost > 0
          ? (videoPacketsLost / (videoPacketsReceived + videoPacketsLost)) * 100
          : null;

      // Jitter: prefer video, fallback to audio
      const jitter = jitterMsVal ?? audioJitterMs;

      // Total bytes
      if (totalBytes === 0) {
        totalBytes = videoBytes + audioBytes;
      }

      // Quality overrides from extraQuality
      const eq = extraRef.current;
      const requestedBps =
        eq?.lastRequested?.videoBitrateKbps != null
          ? eq.lastRequested.videoBitrateKbps * 1000
          : null;
      const effectiveBps =
        eq?.effectiveKbps != null ? eq.effectiveKbps * 1000 : null;
      const configuredBps = eq?.configuredBps ?? null;

      // Prepare snapshot
      const next: DiagnosticsSnapshot = {
        state: "playing",

        videoCodec,
        videoBitrateBps: videoBps,
        resolutionWidth: frameWidth,
        resolutionHeight: frameHeight,
        decodedFps: framesPerSecond,

        audioCodec,
        audioBitrateBps: audioBps,

        totalBitrateBps: totalBps,

        requestedBitrateBps: requestedBps,
        effectiveBitrateBps: effectiveBps,
        configuredBitrateBps: configuredBps,

        packetLossPercent,
        jitterMs: jitter != null ? Math.round(jitter * 10) / 10 : null,
        rttMs: rttMsVal != null ? Math.round(rttMsVal * 10) / 10 : null,
        transportBitrateBps: transportBps,

        droppedFrames: framesDropped,
        freezeCount: freezeCountVal,

        totalBytes: totalBytes > 0 ? totalBytes : null,
        packetsReceived: videoPacketsReceived > 0 ? videoPacketsReceived : null,

        latestSampleTimestamp: now,
      };

      setSnapshot(next);

      // Update rolling window of framesDropped (keep last 3)
      if (framesDropped != null) {
        const arr = droppedFramesRef.current;
        arr.push(framesDropped);
        if (arr.length > 3) {
          arr.shift();
        }
      } else {
        // No data: clear the window
        droppedFramesRef.current = [];
      }
    } catch {
      // Best-effort: getStats can throw if the PC is closing
    }
  }, [session]);

  // ── Polling effect ───────────────────────────────────────────────────

  useEffect(() => {
    // Initial poll
    poll();

    const interval = setInterval(poll, 2000);

    return () => {
      clearInterval(interval);
      bytesRef.current = new Map();
      droppedFramesRef.current = [];
    };
  }, [poll]);

  // ── Compute droppedFramesInLast5s ────────────────────────────────────

  const droppedRef = droppedFramesRef;
  let droppedFramesInLast5s = 0;
  // Must compute synchronously from the ref each render
  const arr = droppedRef.current;
  if (arr.length >= 2) {
    const delta = arr[arr.length - 1] - arr[0];
    droppedFramesInLast5s = delta > 0 ? delta : 0;
  }

  return { snapshot, droppedFramesInLast5s };
}
