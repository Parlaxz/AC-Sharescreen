/**
 * WebRTC statistics types and utility functions.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface OutboundStats {
  bytesSent: number;
  packetsSent: number;
  framesEncoded: number;
  framesSent: number;
  frameWidth: number;
  frameHeight: number;
  framesPerSecond: number;
  qualityLimitationReason: string;
  retransmittedBytesSent: number;
  nackCount: number;
  pliCount: number;
  firCount: number;
  qpSum: number;
}

export interface InboundStats {
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  jitter: number;
  framesDecoded: number;
  framesDropped: number;
  frameWidth: number;
  frameHeight: number;
  framesPerSecond: number;
  freezeCount: number;
  totalFreezesDuration: number;
  nackCount: number;
  pliCount: number;
}

export interface CandidatePairStats {
  state: string;
  nominated: boolean;
  selected: boolean;
  currentRoundTripTime: number;
  availableOutgoingBitrate: number;
  availableIncomingBitrate: number;
  bytesSent: number;
  bytesReceived: number;
}

// ─── Utility Functions ─────────────────────────────────────────────────────

/**
 * Compute bitrate (kbps) from byte counters over a time interval.
 * Returns null if the delta is negative, time is zero/negative, or counter reset.
 */
export function computeKbps(
  currentBytes: number,
  previousBytes: number,
  elapsedMs: number,
): number | null {
  if (currentBytes < previousBytes || elapsedMs <= 0) return null;
  const deltaBytes = currentBytes - previousBytes;
  const deltaBits = deltaBytes * 8;
  const deltaSeconds = elapsedMs / 1000;
  return deltaBits / deltaSeconds / 1000;
}

/**
 * Estimate total bytes transferred over one hour at a given bitrate.
 */
export function estimateBytesPerHour(kbps: number): number {
  // kbps * 1000 / 8 = bytes per second. Multiply by 3600 for bytes per hour.
  return (kbps * 1000) / 8 * 3600;
}

/**
 * Format a byte count as a human-readable string with both decimal (GB)
 * and binary (GiB) representations.
 */
export function formatDataAmount(bytes: number): string {
  const decimalGb = bytes / 1_000_000_000;
  const binaryGib = bytes / (1024 * 1024 * 1024);
  return `${decimalGb.toFixed(2)} GB / ${binaryGib.toFixed(2)} GiB`;
}
