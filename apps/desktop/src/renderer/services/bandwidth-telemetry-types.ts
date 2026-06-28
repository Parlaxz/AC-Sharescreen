/**
 * bandwidth-telemetry-types.ts
 *
 * Canonical types for ScreenLink bandwidth telemetry.
 *
 * CONTRACT:
 *   - All rate fields use bitsPerSecond (not bps, which is ambiguous).
 *   - All cumulative fields use Bytes (not KB, MB).
 *   - Monotonic clock (performance.now()) drives rate calculations.
 *   - Date.now() used only for wall-clock display timestamps.
 *   - Unavailable values are null, never 0 (0 means measured zero).
 *   - Inbound RTP media bytes are not exact ISP-billed usage.
 */

// ─── Sample ─────────────────────────────────────────────────────────────────

export type TelemetryState = "playing" | "paused" | "reconnecting";

export interface TelemetrySample {
  /** Wall-clock time for display (Date.now()) */
  timestampMs: number;
  /** Monotonic time for rate calculations (performance.now()) */
  monotonicTimestampMs: number;
  /** Real elapsed wall-clock since previous sample */
  intervalMs: number;

  /** Media-level bitrates (RTP payload) */
  videoBitsPerSecond: number | null;
  audioBitsPerSecond: number | null;
  /** Sum of videoBitsPerSecond + audioBitsPerSecond */
  mediaBitsPerSecond: number;
  /** Transport-level estimate (candidate-pair), or null */
  transportBitsPerSecond: number | null;

  /** Cumulative RTP byte counters */
  cumulativeVideoBytes: number;
  cumulativeAudioBytes: number;
  cumulativeMediaBytes: number;
  /** Transport-level cumulative bytes, or null */
  cumulativeTransportBytes: number | null;

  /** Configured encoder target, or null */
  configuredVideoBitsPerSecond: number | null;
  /** Effective sender-side limit (encoder + constraints), or null */
  effectiveVideoBitsPerSecond: number | null;

  /** Video resolution / FPS */
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;

  /** Connection quality */
  packetLossPercent: number | null;
  rttMs: number | null;
  jitterMs: number | null;

  /** Session state at sample time */
  state: TelemetryState;

  /** SSRC for counter-identity tracking (optional) */
  ssrc: number | null;
}

// ─── Aggregated bucket ──────────────────────────────────────────────────────

export interface AggregatedBucket {
  startTimestampMs: number;
  endTimestampMs: number;
  minBitsPerSecond: number;
  maxBitsPerSecond: number;
  /** Byte-accurate weighted average = totalBytes * 8000 / totalElapsedMs */
  weightedAverageBitsPerSecond: number;
  /** Cumulative bytes observed in this bucket */
  bucketTotalBytes: number;
  /** Number of raw samples collapsed into this bucket */
  sampleCount: number;
  /** Latest metadata from the period (for tooltip) */
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;
  state: TelemetryState;
}

// ─── Snapshot (for React subscriptions) ──────────────────────────────────────

export interface BandwidthSnapshot {
  /** Immutable recent raw samples (1s intervals, latest 5 min) */
  rawSamples: readonly TelemetrySample[];
  /** 5-second aggregates for latest 30 min */
  mediumBuckets: readonly AggregatedBucket[];
  /** 30-second aggregates for full session */
  longBuckets: readonly AggregatedBucket[];
  /** Three-second EWMA series (one per raw sample, starts after 3 samples) */
  ewmaSeries: readonly number[];

  /** Summary values */
  currentBitsPerSecond: number;
  averageBitsPerSecond: number;
  peakBitsPerSecond: number;
  totalBytes: number;
  durationMs: number;
  activeDurationMs: number;
  configuredBitsPerSecond: number | null;
  effectiveBitsPerSecond: number | null;
  state: TelemetryState;

  /** Session metadata */
  historyId: string;
  role: "host" | "viewer";

  /** Latest per-viewer rates (host only) */
  viewerRates: readonly ViewerRateEntry[];

  /** Markers */
  markers: readonly TelemetryMarker[];
}

export interface TelemetryMarker {
  id: string;
  timestampMs: number;
  type: MarkerType;
  label: string;
  detail: string | null;
}

export type MarkerType =
  | "bitrate"
  | "preset"
  | "resolution"
  | "fps"
  | "codec"
  | "turn"
  | "pause"
  | "resume"
  | "reconnect"
  | "source-switch"
  | "viewer-join"
  | "viewer-leave"
  | "enhancement"
  | "other";

export interface ViewerRateEntry {
  viewerDeviceId: string;
  displayName: string;
  bitsPerSecond: number;
  totalBytes: number;
  rttMs: number | null;
  packetLossPercent: number | null;
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;
  state: TelemetryState;
}

// ─── Subscription ───────────────────────────────────────────────────────────

export type SnapshotSubscriber = (snapshot: BandwidthSnapshot) => void;

// ─── EWMA ───────────────────────────────────────────────────────────────────

export interface EwmaState {
  /** The smoothed value (bits per second) */
  value: number;
  /** Last raw sample value used for update */
  lastRaw: number;
  /** Whether the EWMA has been initialized */
  initialized: boolean;
}

export function createEwma(alpha: number): { value: number; lastRaw: number; initialized: boolean; alpha: number } {
  return { value: 0, lastRaw: 0, initialized: false, alpha };
}

export function updateEwma(
  ewma: { value: number; lastRaw: number; initialized: boolean; alpha: number },
  rawBitsPerSecond: number,
): number {
  if (!ewma.initialized) {
    ewma.value = rawBitsPerSecond;
    ewma.lastRaw = rawBitsPerSecond;
    ewma.initialized = true;
    return ewma.value;
  }
  ewma.value = rawBitsPerSecond * ewma.alpha + ewma.value * (1 - ewma.alpha);
  ewma.lastRaw = rawBitsPerSecond;
  return ewma.value;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

/**
 * Format a bitrate for display.
 * kbps below 1 Mbps, Mbps at or above 1 Mbps.
 */
export function fmtBitRate(bitsPerSecond: number): string {
  if (bitsPerSecond <= 0) return "0 kbps";
  if (bitsPerSecond < 1_000_000) {
    return Math.round(bitsPerSecond / 1000) + " kbps";
  }
  return (bitsPerSecond / 1_000_000).toFixed(1) + " Mbps";
}

/**
 * Format a byte rate for display.
 * B/s, KB/s, or MB/s.
 */
export function fmtByteRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "0 B/s";
  if (bytesPerSecond < 1024) return Math.round(bytesPerSecond) + " B/s";
  const kb = bytesPerSecond / 1024;
  if (kb < 1024) return kb.toFixed(1) + " KB/s";
  const mb = kb / 1024;
  return mb.toFixed(1) + " MB/s";
}

/**
 * Format cumulative bytes for display.
 * KB, MB, or GB.
 */
export function fmtCumulativeBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1024) return Math.round(kb) + " KB";
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(1) + " MB";
  const gb = mb / 1024;
  return gb.toFixed(1) + " GB";
}

/**
 * Estimate hourly usage from totalBytes and activeDurationMs.
 */
export function estimateHourlyBytes(totalBytes: number, activeDurationMs: number): number {
  if (activeDurationMs <= 0 || totalBytes <= 0) return 0;
  const hours = activeDurationMs / 3_600_000;
  return Math.round(totalBytes / hours);
}

export function fmtHourlyUsage(bytesPerHour: number): string {
  if (bytesPerHour <= 0) return "0 MB/h";
  const mb = bytesPerHour / (1024 * 1024);
  if (mb < 1024) return Math.round(mb) + " MB/h";
  return (mb / 1024).toFixed(1) + " GB/h";
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
