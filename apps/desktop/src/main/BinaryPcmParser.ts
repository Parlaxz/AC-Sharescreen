// ── Wire Protocol Constants ──────────────────────────────────────────────────
// All integers are little-endian (x64 native). Named pipes are local-only,
// so no byte-order conversion is needed.

export const PCM_MAGIC = 0x50434D21; // "PCM!"
export const PCM_WIRE_VERSION = 1;
export const HEADER_SIZE = 68; // bytes
export const MAX_FRAMES_PER_PACKET = 960; // 20 ms at 48 kHz
export const MAX_PAYLOAD_BYTES = MAX_FRAMES_PER_PACKET * 2 * 4; // 7 680
export const MAX_PACKET_BYTES = HEADER_SIZE + MAX_PAYLOAD_BYTES; // 7 748

// Bitmask flags carried in the header.flags field
export const PCM_FLAG_SILENT = 1;
export const PCM_FLAG_DISCONTINUITY = 2;
export const PCM_FLAG_TIMESTAMP_ERROR = 4;
export const PCM_FLAG_SYNTHETIC = 8;
export const PCM_FLAG_END_OF_STREAM = 16;

// ── Type Exports ─────────────────────────────────────────────────────────────

export interface PcmPacketHeader {
  magic: number;
  headerSize: number;
  wireVersion: number;
  flags: number;
  sequenceNumber: number; // uint64, safe in JS Number up to 2⁵³
  qpcTimestamp: number;
  qpcFrequency: number;
  devicePosition: number;
  sampleRate: number;
  channels: number;
  sampleFormat: number;
  frameCount: number;
  payloadBytes: number;
  streamGeneration: number;
  droppedPackets: number;
}

export interface ParsedPcmPacket {
  header: PcmPacketHeader;
  /** Float32 interleaved samples – copy of the wire payload. */
  payload: Buffer;
}

export interface PcmParseResult {
  packet: ParsedPcmPacket | null;
  error: string | null;
}

export type PcmPacketCallback = (packet: ParsedPcmPacket) => void;
export type PcmErrorCallback = (error: string) => void;

export interface PcmParserStats {
  totalPackets: number;
  totalBytes: number;
  sequenceGaps: number;
  malformedPackets: number;
  silentPackets: number;
  discontinuityPackets: number;
  timestampErrorPackets: number;
  endOfStream: boolean;
  currentStreamGeneration: number;
  bufferBytes: number;
  maxBufferSize: number;
}

// ── Binary Helpers ───────────────────────────────────────────────────────────

/**
 * Read a 64-bit unsigned integer from `buf` at `offset` (little-endian).
 * JS Number safely represents integers up to 2⁵³ – sufficient for QPC
 * timestamps and sequence numbers carried by the wire protocol.
 */
function readUInt64LE(buf: Buffer, offset: number): number {
  const low = buf.readUInt32LE(offset);
  const high = buf.readUInt32LE(offset + 4);
  return high * 0x1_0000_0000 + low;
}

// ── Header Validation ───────────────────────────────────────────────────────

export function validatePcmHeader(header: PcmPacketHeader): string | null {
  if (header.magic !== PCM_MAGIC) return "Invalid magic";
  if (header.headerSize !== HEADER_SIZE) return "Invalid header size";
  if (header.wireVersion !== PCM_WIRE_VERSION) return "Unsupported wire version";
  if (header.sampleRate === 0) return "Invalid sample rate";
  if (header.channels === 0) return "Invalid channel count";
  if (header.sampleFormat !== 0)
    return "Unsupported sample format (only float32=0)";
  if (header.frameCount === 0 || header.frameCount > MAX_FRAMES_PER_PACKET)
    return "Invalid frame count";

  const expectedPayload = header.frameCount * header.channels * 4;
  if (header.payloadBytes !== expectedPayload)
    return `Payload size mismatch: got ${header.payloadBytes}, expected ${expectedPayload}`;
  if (expectedPayload > MAX_PAYLOAD_BYTES) return "Payload overflow";

  return null;
}

// ── Streaming Parser ────────────────────────────────────────────────────────

/**
 * Streaming parser for the binary PCM wire protocol.
 *
 * Accepts chunks of bytes (e.g. from a named-pipe read) and emits complete
 * `ParsedPcmPacket` objects via the `onPacket` callback.  Malformed data is
 * reported via `onError`; the parser attempts to resync after corruption.
 */
export class BinaryPcmParser {
  private buffer = Buffer.alloc(0);
  private readonly maxBufferSize: number;
  private readonly onPacket: PcmPacketCallback;
  private readonly onError: PcmErrorCallback;

  // Stream-tracking state
  private currentStreamGeneration = -1;
  private totalPackets = 0;
  private totalBytes = 0;
  private sequenceGaps = 0;
  private lastSequenceNumber = -1;
  private malformedPackets = 0;
  private silentPackets = 0;
  private discontinuityPackets = 0;
  private timestampErrorPackets = 0;
  private endOfStream = false;

  constructor(
    onPacket: PcmPacketCallback,
    onError: PcmErrorCallback,
    options?: { maxBufferSize?: number },
  ) {
    this.onPacket = onPacket;
    this.onError = onError;
    this.maxBufferSize = options?.maxBufferSize ?? 1_024_000;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Feed raw bytes read from the pipe into the parser.
   * May synchronously invoke `onPacket` zero, one, or multiple times.
   */
  feed(data: Buffer): void {
    if (data.byteLength === 0) return;

    // Append to internal ring
    if (this.buffer.byteLength === 0) {
      this.buffer = Buffer.from(data);
    } else {
      this.buffer = Buffer.concat([this.buffer, data]);
    }

    // Process as many complete packets as possible first.
    this.processBuffer();

    // Guard against unbounded growth of unparsed residue.
    if (this.buffer.byteLength > this.maxBufferSize) {
      this.onError(
        `Buffer overflow: ${this.buffer.byteLength} unparsed bytes exceeds max of ${this.maxBufferSize}`,
      );
      this.reset();
    }
  }

  /** Reset all stream-tracking state (e.g. on stream generation change). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.currentStreamGeneration = -1;
    this.totalPackets = 0;
    this.totalBytes = 0;
    this.sequenceGaps = 0;
    this.lastSequenceNumber = -1;
    this.malformedPackets = 0;
    this.silentPackets = 0;
    this.discontinuityPackets = 0;
    this.timestampErrorPackets = 0;
    this.endOfStream = false;
  }

  /** Snapshot of current parser statistics. */
  getStats(): PcmParserStats {
    return {
      totalPackets: this.totalPackets,
      totalBytes: this.totalBytes,
      sequenceGaps: this.sequenceGaps,
      malformedPackets: this.malformedPackets,
      silentPackets: this.silentPackets,
      discontinuityPackets: this.discontinuityPackets,
      timestampErrorPackets: this.timestampErrorPackets,
      endOfStream: this.endOfStream,
      currentStreamGeneration: this.currentStreamGeneration,
      bufferBytes: this.buffer.byteLength,
      maxBufferSize: this.maxBufferSize,
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /** Drive the state machine until we run out of complete packets. */
  private processBuffer(): void {
    while (true) {
      if (this.buffer.byteLength < HEADER_SIZE) return;

      // ---- magic scan ----
      const magic = this.buffer.readUInt32LE(0);
      if (magic !== PCM_MAGIC) {
        if (!this.resync()) return;
        continue;
      }

      // ---- header-size gate ----
      const headerSize = this.buffer.readUInt16LE(4);
      if (headerSize < HEADER_SIZE || this.buffer.byteLength < headerSize) {
        return; // need more data
      }

      // ---- parse header ----
      const header = this.parseHeader(headerSize);

      // ---- validate ----
      const validationError = validatePcmHeader(header);
      if (validationError !== null) {
        this.malformedPackets++;
        this.onError(validationError);
        this.buffer = this.buffer.subarray(headerSize);
        continue;
      }

      // ---- payload gate ----
      const totalPacketBytes = headerSize + header.payloadBytes;
      if (this.buffer.byteLength < totalPacketBytes) {
        return; // need more data
      }

      // ---- extract payload ----
      const payload = Buffer.from(
        this.buffer.subarray(headerSize, totalPacketBytes),
      );

      const packet: ParsedPcmPacket = { header, payload };

      // ---- stream-generation check ----
      if (
        this.currentStreamGeneration >= 0 &&
        header.streamGeneration !== this.currentStreamGeneration
      ) {
        this.onError(
          `Stream generation changed from ${this.currentStreamGeneration} to ${header.streamGeneration}`,
        );
        // Reset counters and accept this packet as the start of the new generation
        this.currentStreamGeneration = header.streamGeneration;
        this.totalPackets = 0;
        this.totalBytes = 0;
        this.sequenceGaps = 0;
        this.lastSequenceNumber = -1;
        this.silentPackets = 0;
        this.discontinuityPackets = 0;
        this.timestampErrorPackets = 0;
        this.endOfStream = false;
      }
      if (this.currentStreamGeneration < 0) {
        this.currentStreamGeneration = header.streamGeneration;
      }

      // ---- sequence-gap detection ----
      if (
        this.lastSequenceNumber >= 0 &&
        header.sequenceNumber !== this.lastSequenceNumber + 1
      ) {
        this.sequenceGaps++;
      }
      this.lastSequenceNumber = header.sequenceNumber;

      // ---- stats ----
      this.totalPackets++;
      this.totalBytes += totalPacketBytes;

      if (header.flags & PCM_FLAG_SILENT) this.silentPackets++;
      if (header.flags & PCM_FLAG_DISCONTINUITY) this.discontinuityPackets++;
      if (header.flags & PCM_FLAG_TIMESTAMP_ERROR) this.timestampErrorPackets++;
      if (header.flags & PCM_FLAG_END_OF_STREAM) this.endOfStream = true;

      // ---- consume ----
      this.buffer = this.buffer.subarray(totalPacketBytes);

      // ---- emit ----
      this.onPacket(packet);
    }
  }

  /**
   * Scan forward byte-by-byte looking for PCM_MAGIC.
   * Returns `true` if magic was found (buffer is trimmed), `false` if the
   * entire buffer was exhausted (keeps up to 3 suffix bytes that could be
   * a partial magic prefix).
   */
  private resync(): boolean {
    const len = this.buffer.byteLength;
    for (let i = 1; i <= len - 4; i++) {
      if (this.buffer.readUInt32LE(i) === PCM_MAGIC) {
        this.malformedPackets++;
        this.onError(`Resynced: skipped ${i} bytes of invalid data`);
        this.buffer = this.buffer.subarray(i);
        return true;
      }
    }
    // No magic found – keep at most 3 bytes (partial magic prefix).
    this.malformedPackets++;
    this.onError("No valid PCM header found in buffer – resyncing");
    const keep = Math.min(len, 3);
    this.buffer = this.buffer.subarray(len - keep);
    return false;
  }

  /** Parse header fields starting at offset 0 of the current buffer. */
  private parseHeader(headerSize: number): PcmPacketHeader {
    return {
      magic: this.buffer.readUInt32LE(0),
      headerSize,
      wireVersion: this.buffer.readUInt16LE(6),
      flags: this.buffer.readUInt32LE(8),
      sequenceNumber: readUInt64LE(this.buffer, 12),
      qpcTimestamp: readUInt64LE(this.buffer, 20),
      qpcFrequency: readUInt64LE(this.buffer, 28),
      devicePosition: readUInt64LE(this.buffer, 36),
      sampleRate: this.buffer.readUInt32LE(44),
      channels: this.buffer.readUInt16LE(48),
      sampleFormat: this.buffer.readUInt16LE(50),
      frameCount: this.buffer.readUInt32LE(52),
      payloadBytes: this.buffer.readUInt32LE(56),
      streamGeneration: this.buffer.readUInt32LE(60),
      droppedPackets: this.buffer.readUInt32LE(64),
    };
  }
}
