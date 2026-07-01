/**
 * bandwidth-telemetry-types.ts
 *
 * Canonical types for ScreenLink bandwidth telemetry.
 *
 * CONTRACT:
 *   - All rate fields use bitsPerSecond.
 *   - All cumulative fields use bytes.
 *   - All chart timestamps are epoch milliseconds.
 *   - All interval calculations use monotonic milliseconds.
 *   - Unavailable values are null, never 0 (0 means measured zero).
 */

// ─── Counter identity ──────────────────────────────────────────────────────

export interface CounterIdentity {
  reportId: string;
  ssrc: number | null;
  trackIdentifier: string | null;
  mid: string | null;
}

// ─── Media counter observation ─────────────────────────────────────────────

export interface MediaCounterObservation {
  identity: CounterIdentity;
  cumulativeBytes: number;
}

// ─── Peer telemetry observation ────────────────────────────────────────────

export type TelemetryState = "playing" | "paused" | "reconnecting";

export interface PeerTelemetryObservation {
  timestampMs: number;
  monotonicTimestampMs: number;
  video: MediaCounterObservation | null;
  audio: MediaCounterObservation | null;
  transportCumulativeBytes: number | null;
  configuredVideoBitsPerSecond: number | null;
  effectiveVideoBitsPerSecond: number | null;
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;
  decodedFramesPerSecond: number | null;
  droppedFrames: number | null;
  freezeCount: number | null;
  packetsReceived: number | null;
  packetsLost: number | null;
  packetLossPercent: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  codec: string | null;
  connectionType: "direct" | "turn" | null;
  state: TelemetryState;
}

// ─── RTP Stream Evidence ──────────────────────────────────────────

/**
 * Base fields shared by both video and audio RTP stream evidence.
 * All rate fields are bitsPerSecond. Timestamps are monotonic ms.
 */
export interface RtpStreamBaseEvidence {
  /** The RTCStatsReport id for this inbound-rtp (or outbound-rtp) record. */
  id: string;
  /** Synchronisation source identifier. */
  ssrc: number | null;
  /** Media stream identifier. */
  mid: string | null;
  /** The codecId from the RTP record, used to look up the matching codec. */
  codecId: string | null;
  /** Resolved codec MIME type (e.g. "video/VP9" or "audio/opus"). */
  codecMimeType: string | null;
  /** Cumulative bytes received (or sent for outbound). */
  bytesReceived: number;
  /** Byte delta since the previous sample. */
  bytesDelta: number;
  /** Instantaneous bit rate computed from the byte delta and elapsed wall time. */
  bitsPerSecond: number;
  /** Cumulative packets received. */
  packetsReceived: number | null;
  /** Cumulative packets lost. */
  packetsLost: number | null;
  /** Packet loss percentage for this interval, null when insufficient data. */
  packetLossPercent: number | null;
  /** Jitter in milliseconds (converted from the stats seconds value exactly once). */
  jitterMs: number | null;
}

/** Video-specific RTP stream evidence. */
export interface VideoRtpStreamDetails extends RtpStreamBaseEvidence {
  kind: "video";
  /** Frame width in pixels. */
  frameWidth: number | null;
  /** Frame height in pixels. */
  frameHeight: number | null;
  /** Framerate as reported by the decoder. */
  framesPerSecond: number | null;
  /** Cumulative frames decoded. */
  framesDecoded: number | null;
  /** Cumulative frames dropped. */
  framesDropped: number | null;
  /** Cumulative key frames decoded (inter-frame). */
  keyFramesDecoded: number | null;
  /** Cumulative freeze count. */
  freezeCount: number | null;
  /** Decoder implementation name (e.g. "FFmpeg", "VideoToolbox"). */
  decoderImplementation: string | null;
}

/** Audio-specific RTP stream evidence. */
export interface AudioRtpStreamDetails extends RtpStreamBaseEvidence {
  kind: "audio";
  /** Audio level (0-1, only valid on the last 3 seconds). */
  audioLevel: number | null;
  /** Cumulative audio energy. */
  totalAudioEnergy: number | null;
  /** Cumulative audio sample duration in seconds. */
  totalSamplesDuration: number | null;
  /** Codec clock rate (e.g. 48000). */
  clockRate: number | null;
  /** Number of audio channels. */
  channels: number | null;
  /** Average jitter-buffer delay in milliseconds.
   *  = delta(jitterBufferDelay) / delta(jitterBufferEmittedCount) * 1000 */
  jitterBufferDelayMs: number | null;
  /** Cumulative count of emitted packets from the jitter buffer. */
  jitterBufferEmittedCount: number | null;
  /** Cumulative count of concealed samples. */
  concealedSamples: number | null;
  /** Cumulative count of concealment events. */
  concealedEvents: number | null;
  /** Concealment percentage = delta(concealedSamples) / delta(totalSamplesReceived) * 100. */
  concealmentPercent: number | null;
  /** Cumulative total samples received by the audio decoder. */
  totalSamplesReceived: number | null;
}

/**
 * Resolved codec information from an RTCStatsReport codec entry.
 */
export interface CodecEvidence {
  /** The codec's report ID (same as codecId in RTP stream references). */
  id: string;
  /** MIME type (e.g. "video/VP9", "audio/opus"). */
  mimeType: string;
  /** Codec clock rate in Hz (e.g. 48000 for audio). */
  clockRate: number | null;
  /** Number of audio channels (null for video). */
  channels: number | null;
  /** SDP fmtp line parameters (e.g. "minptime=10;useinbandfec=1"). */
  sdpFmtpLine: string | null;
  /** Payload type number (e.g. 96). */
  payloadType: number | null;
}

/**
 * Verification state for a stream's evidence.
 * - collecting: first sample seen, awaiting second to confirm
 * - active-decoding: stream has confirmed recent decoded frame activity
 * - stale: no decoded frame activity within the grace period (3-5s)
 */
export type StreamVerificationState = "collecting" | "active-decoding" | "stale";

/** Union type for per-stream RTP evidence. */
export type RtpStreamEvidence = VideoRtpStreamDetails | AudioRtpStreamDetails;

// ─── Media breakdown ──────────────────────────────────────────────

export interface MediaBreakdown {
  videoBitsPerSecond: number | null;
  audioBitsPerSecond: number | null;
  mediaBitsPerSecond: number | null;
  transportBitsPerSecond: number | null;
  cumulativeVideoBytes: number;
  cumulativeAudioBytes: number;
  cumulativeMediaBytes: number;
  cumulativeTransportBytes: number | null;
}

// ─── Telemetry sample (raw, 1s) ────────────────────────────────────────────

export interface TelemetrySample {
  timestampMs: number;
  monotonicTimestampMs: number;
  intervalMs: number;
  mediaBitsPerSecond: number;
  videoBitsPerSecond: number | null;
  audioBitsPerSecond: number | null;
  transportBitsPerSecond: number | null;
  cumulativeMediaBytes: number;
  cumulativeTransportBytes: number | null;
  configuredVideoBitsPerSecond: number | null;
  effectiveVideoBitsPerSecond: number | null;
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;
  packetLossPercent: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  codec: string | null;
  connectionType: "direct" | "turn" | null;
  state: TelemetryState;
  /** Easy Compare variant label, if this connection belongs to a compare variant. */
  variantId?: "A" | "B";
  /** Per-stream video RTP evidence for this sample interval. */
  videoRtpStreams: readonly VideoRtpStreamDetails[];
  /** Per-stream audio RTP evidence for this sample interval. */
  audioRtpStreams: readonly AudioRtpStreamDetails[];
}

// ─── Aggregated bucket ──────────────────────────────────────────────────────

export interface AggregatedBucket {
  startTimestampMs: number;
  endTimestampMs: number;
  intervalMs: number;
  minBitsPerSecond: number;
  maxBitsPerSecond: number;
  weightedAverageBitsPerSecond: number;
  byteDelta: number;
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;
  state: TelemetryState;
  codec: string | null;
  connectionType: "direct" | "turn" | null;
}

// ─── Markers ────────────────────────────────────────────────────────────────

export interface TelemetryMarker {
  id: string;
  historyId: string;
  connectionId: string | null;
  viewerDeviceId: string | null;
  timestampMs: number;
  type: MarkerType;
  label: string;
  from: string | null;
  to: string;
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
  | "stream-switch"
  | "viewer-join"
  | "viewer-leave"
  | "enhancement"
  | "quality"
  | "fallback"
  | "other";

// ─── Telemetry series snapshot ──────────────────────────────────────────────

export interface TelemetrySeriesSnapshot {
  rawSamples: readonly TelemetrySample[];
  mediumBuckets: readonly AggregatedBucket[];
  longBuckets: readonly AggregatedBucket[];
  markers: readonly TelemetryMarker[];
  currentBitsPerSecond: number;
  averageBitsPerSecond: number;
  peakBitsPerSecond: number;
  totalBytes: number;
  durationMs: number;
  activeDurationMs: number;
  configuredBitsPerSecond: number | null;
  effectiveBitsPerSecond: number | null;
  state: TelemetryState;
  /** Current aggregate video bits per second (null when unavailable). */
  currentVideoBitsPerSecond: number | null;
  /** Current aggregate audio bits per second (null when unavailable). */
  currentAudioBitsPerSecond: number | null;
  /** Current aggregate transport bits per second (null when unavailable/not measured). */
  currentTransportBitsPerSecond: number | null;
}

// ─── Viewer reported status ─────────────────────────────────────────────────

export interface ViewerReportedStatus {
  videoBitsPerSecond: number | null;
  audioBitsPerSecond: number | null;
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;
  decodedFramesPerSecond: number | null;
  droppedFrames: number | null;
  packetsReceived: number | null;
  packetsLost: number | null;
  packetLossPercent: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  codec: string | null;
  connectionType: "direct" | "turn" | null;
  state: TelemetryState;
}

// ─── Connection telemetry snapshot ──────────────────────────────────────────

export interface ConnectionTelemetrySnapshot extends TelemetrySeriesSnapshot {
  connectionId: string;
  viewerDeviceId: string | null;
  displayName: string | null;
  receivedStatus: ViewerReportedStatus | null;
  /** Easy Compare variant label, if this connection belongs to a compare variant. */
  variantId?: "A" | "B";
}

// ─── Bandwidth snapshot (root) ──────────────────────────────────────────────

export interface BandwidthSnapshot {
  historyId: string;
  role: "host" | "viewer";
  aggregate: TelemetrySeriesSnapshot;
  connections: readonly ConnectionTelemetrySnapshot[];
}

// ─── Viewer rate entry (for viewer selector) ────────────────────────────────

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

// ─── Persistence record (schema v2) ─────────────────────────────────────────

export interface PersistenceRecordV2 {
  schemaVersion: 2;
  historyId: string;
  role: "host" | "viewer";
  startedAt: number;
  stoppedAt: number | null;
  durationMs: number;
  activeDurationMs: number;
  totalBytes: number;
  peakBitsPerSecond: number;
  configuredBitsPerSecond: number | null;
  effectiveBitsPerSecond: number | null;
  rawSamples: TelemetrySample[];
  mediumBuckets: AggregatedBucket[];
  longBuckets: AggregatedBucket[];
  connections: ConnectionTelemetrySnapshot[];
  markers: TelemetryMarker[];
  status: "active" | "completed" | "interrupted";
  groupId?: string;
  groupName?: string;
  mediaSessionId?: string;
}

// ─── Subscription ───────────────────────────────────────────────────────────

export type SnapshotSubscriber = (snapshot: BandwidthSnapshot) => void;

// ─── EWMA ───────────────────────────────────────────────────────────────────

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

export function fmtBitRate(bitsPerSecond: number): string {
  // Convert from bits to bytes: bps / 8 = B/s
  if (bitsPerSecond <= 0) return "0 kB/s";
  const Bps = bitsPerSecond / 8;
  if (Bps < 1000) return Math.round(Bps) + " B/s";
  const kBps = Bps / 1000;
  if (kBps < 1000) return kBps.toFixed(1) + " kB/s";
  return (kBps / 1000).toFixed(2) + " MB/s";
}

export function fmtByteRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "0 B/s";
  if (bytesPerSecond < 1024) return Math.round(bytesPerSecond) + " B/s";
  const kb = bytesPerSecond / 1024;
  if (kb < 1024) return kb.toFixed(1) + " KB/s";
  const mb = kb / 1024;
  return mb.toFixed(1) + " MB/s";
}

export function fmtCumulativeBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1024) return Math.round(kb) + " KB";
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(1) + " MB";
  const gb = mb / 1024;
  return gb.toFixed(1) + " GB";
}

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
