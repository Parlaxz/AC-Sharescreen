/**
 * @deprecated Viewer diagnostics now come from StreamMetricsService.
 * This hook was the old session.getDiagnostics() poller which has been removed.
 * Keep for backward compat with any remaining callers; returns empty data.
 */
import type { ViewerSession } from "@/services/viewer-session.js";

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

export function useStreamDiagnostics(
  _session: ViewerSession | null,
  _extraQuality?: {
    lastRequested?: { videoBitrateKbps?: number } | null;
    effectiveKbps?: number | null;
    configuredBps?: number | null;
  },
): { snapshot: DiagnosticsSnapshot; droppedFramesInLast5s: number } {
  return { snapshot: EMPTY_DIAGNOSTICS, droppedFramesInLast5s: 0 };
}
