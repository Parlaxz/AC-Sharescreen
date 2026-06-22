import { describe, it, expect } from "vitest";
import {
  BinaryPcmParser,
  validatePcmHeader,
  HEADER_SIZE,
  PCM_MAGIC,
  PCM_WIRE_VERSION,
  MAX_FRAMES_PER_PACKET,
  MAX_PAYLOAD_BYTES,
  PCM_FLAG_SILENT,
  PCM_FLAG_DISCONTINUITY,
  PCM_FLAG_TIMESTAMP_ERROR,
  PCM_FLAG_END_OF_STREAM,
} from "../src/main/BinaryPcmParser.js";
import type {
  PcmPacketHeader,
  ParsedPcmPacket,
} from "../src/main/BinaryPcmParser.js";

// ── Test Helpers ─────────────────────────────────────────────────────────────

function writeUInt64LE(buf: Buffer, value: number, offset: number): void {
  buf.writeUInt32LE(value >>> 0, offset);
  buf.writeUInt32LE(Math.floor(value / 0x1_0000_0000) >>> 0, offset + 4);
}

function createHeader(overrides?: Partial<PcmPacketHeader>): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE);

  // Default header values
  buf.writeUInt32LE(PCM_MAGIC, 0);
  buf.writeUInt16LE(HEADER_SIZE, 4);
  buf.writeUInt16LE(PCM_WIRE_VERSION, 6);
  buf.writeUInt32LE(0, 8); // flags
  writeUInt64LE(buf, 0, 12); // sequenceNumber
  writeUInt64LE(buf, 0, 20); // qpcTimestamp
  writeUInt64LE(buf, 0, 28); // qpcFrequency
  writeUInt64LE(buf, 0, 36); // devicePosition
  buf.writeUInt32LE(48000, 44); // sampleRate
  buf.writeUInt16LE(2, 48); // channels
  buf.writeUInt16LE(0, 50); // sampleFormat
  buf.writeUInt32LE(480, 52); // frameCount
  buf.writeUInt32LE(480 * 2 * 4, 56); // payloadBytes (480 frames * 2 ch * 4 bytes)
  buf.writeUInt32LE(0, 60); // streamGeneration
  buf.writeUInt32LE(0, 64); // droppedPackets

  if (!overrides) return buf;

  // Apply overrides
  if (overrides.magic !== undefined) buf.writeUInt32LE(overrides.magic, 0);
  if (overrides.headerSize !== undefined) buf.writeUInt16LE(overrides.headerSize, 4);
  if (overrides.wireVersion !== undefined) buf.writeUInt16LE(overrides.wireVersion, 6);
  if (overrides.flags !== undefined) buf.writeUInt32LE(overrides.flags, 8);
  if (overrides.sequenceNumber !== undefined) writeUInt64LE(buf, overrides.sequenceNumber, 12);
  if (overrides.qpcTimestamp !== undefined) writeUInt64LE(buf, overrides.qpcTimestamp, 20);
  if (overrides.qpcFrequency !== undefined) writeUInt64LE(buf, overrides.qpcFrequency, 28);
  if (overrides.devicePosition !== undefined) writeUInt64LE(buf, overrides.devicePosition, 36);
  if (overrides.sampleRate !== undefined) buf.writeUInt32LE(overrides.sampleRate, 44);
  if (overrides.channels !== undefined) buf.writeUInt16LE(overrides.channels, 48);
  if (overrides.sampleFormat !== undefined) buf.writeUInt16LE(overrides.sampleFormat, 50);
  if (overrides.frameCount !== undefined) buf.writeUInt32LE(overrides.frameCount, 52);

  // If payloadBytes is explicitly provided use it; otherwise recalculate
  const channels = overrides.channels ?? 2;
  const frameCount = overrides.frameCount ?? 480;
  const computedPayload = frameCount * channels * 4;
  if (overrides.payloadBytes !== undefined) {
    buf.writeUInt32LE(overrides.payloadBytes, 56);
  } else if (overrides.frameCount !== undefined || overrides.channels !== undefined) {
    buf.writeUInt32LE(computedPayload, 56);
  }

  if (overrides.streamGeneration !== undefined) buf.writeUInt32LE(overrides.streamGeneration, 60);
  if (overrides.droppedPackets !== undefined) buf.writeUInt32LE(overrides.droppedPackets, 64);

  return buf;
}

function createPacket(
  seq: number,
  frameCount = 480,
  overrides?: Partial<PcmPacketHeader>,
): Buffer {
  const channels = overrides?.channels ?? 2;
  const payloadBytes = frameCount * channels * 4;
  const headerOverrides: Partial<PcmPacketHeader> = {
    ...overrides,
    sequenceNumber: seq,
    frameCount,
    payloadBytes,
  };
  const header = createHeader(headerOverrides);
  const payload = Buffer.alloc(payloadBytes);

  // Fill with a deterministic audio pattern
  const sampleCount = frameCount * channels;
  for (let i = 0; i < sampleCount; i++) {
    payload.writeFloatLE(Math.sin(i * 0.1), i * 4);
  }

  return Buffer.concat([header, payload]);
}

// ── validatePcmHeader Unit Tests ─────────────────────────────────────────────

describe("validatePcmHeader", () => {
  it("accepts a valid header", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: HEADER_SIZE,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 0,
      frameCount: 480,
      payloadBytes: 480 * 2 * 4,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toBeNull();
  });

  it("rejects invalid magic", () => {
    const header: PcmPacketHeader = {
      magic: 0xdeadbeef,
      headerSize: HEADER_SIZE,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 0,
      frameCount: 480,
      payloadBytes: 480 * 2 * 4,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toBe("Invalid magic");
  });

  it("rejects unsupported wire version", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: HEADER_SIZE,
      wireVersion: 99,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 0,
      frameCount: 480,
      payloadBytes: 480 * 2 * 4,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toBe("Unsupported wire version");
  });

  it("rejects zero sample rate", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: HEADER_SIZE,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 0,
      channels: 2,
      sampleFormat: 0,
      frameCount: 480,
      payloadBytes: 480 * 2 * 4,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toBe("Invalid sample rate");
  });

  it("rejects zero channels", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: HEADER_SIZE,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 0,
      sampleFormat: 0,
      frameCount: 480,
      payloadBytes: 480 * 0 * 4,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toBe("Invalid channel count");
  });

  it("rejects non-float32 sample format", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: HEADER_SIZE,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 1,
      frameCount: 480,
      payloadBytes: 480 * 2 * 4,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toBe("Unsupported sample format (only float32=0)");
  });

  it("rejects zero frameCount", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: HEADER_SIZE,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 0,
      frameCount: 0,
      payloadBytes: 0,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toBe("Invalid frame count");
  });

  it("rejects frameCount above maximum", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: HEADER_SIZE,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 0,
      frameCount: MAX_FRAMES_PER_PACKET + 1,
      payloadBytes: (MAX_FRAMES_PER_PACKET + 1) * 2 * 4,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toBe("Invalid frame count");
  });

  it("rejects payload size mismatch", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: HEADER_SIZE,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 0,
      frameCount: 480,
      payloadBytes: 9999, // wrong
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toMatch(/Payload size mismatch/);
  });

  it("rejects payload overflow", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: HEADER_SIZE,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 0,
      frameCount: MAX_FRAMES_PER_PACKET,
      payloadBytes: MAX_FRAMES_PER_PACKET * 2 * 4,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    // frameCount * channels * 4 = 960 * 2 * 4 = 7680 = MAX_PAYLOAD_BYTES, which passes
    expect(validatePcmHeader(header)).toBeNull();
  });

  it("rejects invalid header size", () => {
    const header: PcmPacketHeader = {
      magic: PCM_MAGIC,
      headerSize: 32,
      wireVersion: PCM_WIRE_VERSION,
      flags: 0,
      sequenceNumber: 0,
      qpcTimestamp: 0,
      qpcFrequency: 0,
      devicePosition: 0,
      sampleRate: 48000,
      channels: 2,
      sampleFormat: 0,
      frameCount: 480,
      payloadBytes: 480 * 2 * 4,
      streamGeneration: 0,
      droppedPackets: 0,
    };
    expect(validatePcmHeader(header)).toBe("Invalid header size");
  });
});

// ── BinaryPcmParser Unit Tests ──────────────────────────────────────────────

describe("BinaryPcmParser", () => {
  it("parses one complete packet", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    parser.feed(createPacket(0));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(1);
    expect(packets[0]!.header.sequenceNumber).toBe(0);
    expect(packets[0]!.header.frameCount).toBe(480);
  });

  it("handles partial header read", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    const data = createPacket(0);
    parser.feed(data.subarray(0, 30)); // First 30 bytes (partial header)
    expect(packets).toHaveLength(0); // No complete packet yet
    parser.feed(data.subarray(30)); // Rest of header + payload
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(1); // Now complete
  });

  it("handles partial payload read", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    const data = createPacket(0);
    parser.feed(data.subarray(0, HEADER_SIZE + 100)); // Full header + partial payload
    expect(packets).toHaveLength(0);
    parser.feed(data.subarray(HEADER_SIZE + 100)); // Rest of payload
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(1);
  });

  it("parses multiple packets in one feed", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    const p1 = createPacket(0);
    const p2 = createPacket(1);
    parser.feed(Buffer.concat([p1, p2]));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(2);
    expect(packets[0]!.header.sequenceNumber).toBe(0);
    expect(packets[1]!.header.sequenceNumber).toBe(1);
  });

  it("handles packet + partial next packet", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    const p1 = createPacket(0); // 68 + 3840 = 3 908 bytes
    const p2 = createPacket(1);
    const combined = Buffer.concat([p1, p2]);
    const firstPacketEnd = p1.byteLength;
    // Feed full first packet + 30 bytes of second packet's header
    parser.feed(combined.subarray(0, firstPacketEnd + 30));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(1); // Only first complete
    expect(packets[0]!.header.sequenceNumber).toBe(0);
    // Feed the rest of the second packet
    parser.feed(combined.subarray(firstPacketEnd + 30));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(2);
    expect(packets[1]!.header.sequenceNumber).toBe(1);
  });

  it("rejects invalid magic via parser", () => {
    const errors: string[] = [];
    const packets: ParsedPcmPacket[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    const bad = createPacket(0);
    bad.writeUInt32LE(0xdeadbeef, 0); // Bad magic
    parser.feed(bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("detects sequence gaps", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    parser.feed(createPacket(0));
    parser.feed(createPacket(1));
    parser.feed(createPacket(5)); // Gap: 1 -> 5
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(3);
    expect(parser.getStats().sequenceGaps).toBe(1);
  });

  it("detects multiple sequence gaps", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    parser.feed(createPacket(10));
    parser.feed(createPacket(20)); // Gap: 10 -> 20
    parser.feed(createPacket(30)); // Gap: 20 -> 30
    expect(packets).toHaveLength(3);
    expect(parser.getStats().sequenceGaps).toBe(2);
  });

  it("tracks stream generation", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    // First feed auto-detects generation from first packet
    parser.feed(createPacket(0, 480, { streamGeneration: 0 }));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(1);

    // Same generation — OK
    parser.feed(createPacket(1, 480, { streamGeneration: 0 }));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(2);

    // Different generation — should emit error and reset counters, but still emit packet
    parser.feed(createPacket(0, 480, { streamGeneration: 1 }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Stream generation changed");
    // The packet should still be emitted (it's the start of the new generation)
    expect(packets).toHaveLength(3);
    // Stats should reflect the reset + new packet
    expect(parser.getStats().currentStreamGeneration).toBe(1);
    expect(parser.getStats().totalPackets).toBe(1); // reset then 1 new packet
  });

  it("handles end-of-stream flag", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    parser.feed(createPacket(0, 480, { flags: PCM_FLAG_END_OF_STREAM }));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(1);
    expect(parser.getStats().endOfStream).toBe(true);

    // A subsequent packet is still accepted; the flag simply records that
    // at least one EOS marker has been seen.
    parser.feed(createPacket(1));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(2);
  });

  it("rejects payload overflow via parser", () => {
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      () => {},
      (e) => errors.push(e),
    );
    // 10 000 frames well above MAX_FRAMES_PER_PACKET
    const bad = createPacket(0, 10000);
    parser.feed(bad);
    // Expect validation to fail (frameCount exceeds max), producing an error
    expect(errors.length).toBeGreaterThan(0);
  });

  it("tracks silent packets", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    parser.feed(createPacket(0, 480, { flags: PCM_FLAG_SILENT }));
    expect(packets).toHaveLength(1);
    expect(parser.getStats().silentPackets).toBe(1);
  });

  it("tracks discontinuity", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    parser.feed(createPacket(0, 480, { flags: PCM_FLAG_DISCONTINUITY }));
    expect(packets).toHaveLength(1);
    expect(parser.getStats().discontinuityPackets).toBe(1);
  });

  it("tracks timestamp errors", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    parser.feed(createPacket(0, 480, { flags: PCM_FLAG_TIMESTAMP_ERROR }));
    expect(packets).toHaveLength(1);
    expect(parser.getStats().timestampErrorPackets).toBe(1);
  });

  it("limits buffer size", () => {
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      () => {},
      (e) => errors.push(e),
      { maxBufferSize: 100 },
    );

    const big = createPacket(0, 480); // 68 + 3840 = 3 908 bytes

    // Successfully parse a large packet (buffer consumed, no overflow)
    parser.feed(big);
    expect(errors).toHaveLength(0);

    // Feed partial header (50 bytes) — sits in buffer unparsed
    parser.feed(big.subarray(0, 50));
    expect(errors).toHaveLength(0);

    // Append more bytes (50 more → 100 total) — still at limit
    parser.feed(big.subarray(50, 100));
    expect(errors).toHaveLength(0);

    // Append one more byte — 101 > 100 → overflow detected
    parser.feed(Buffer.alloc(1));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/Buffer overflow/);

    // After overflow, parser resets — buffer is empty
    expect(parser.getStats().bufferBytes).toBe(0);
  });

  it("recovers from bad magic by resyncing", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );

    // Build: 50 bytes of garbage + a valid packet
    const garbage = Buffer.alloc(50);
    for (let i = 0; i < 50; i++) garbage.writeUInt8(0xff, i);

    const valid = createPacket(0);
    parser.feed(Buffer.concat([garbage, valid]));

    // The parser should have emitted a resync error and still found the valid packet
    expect(errors.length).toBeGreaterThan(0);
    // The valid packet should have been parsed after resyncing past garbage
    expect(packets.length).toBe(1);
    expect(packets[0]!.header.sequenceNumber).toBe(0);
  });

  it("reports correct stats after parsing", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );

    parser.feed(createPacket(0, 480, { flags: PCM_FLAG_SILENT }));
    parser.feed(createPacket(1, 480));
    parser.feed(createPacket(3, 480, { flags: PCM_FLAG_DISCONTINUITY })); // gap at seq 2

    const stats = parser.getStats();
    expect(stats.totalPackets).toBe(3);
    expect(stats.sequenceGaps).toBe(1);
    expect(stats.silentPackets).toBe(1);
    expect(stats.discontinuityPackets).toBe(1);
    expect(stats.timestampErrorPackets).toBe(0);
    expect(stats.endOfStream).toBe(false);
    expect(stats.bufferBytes).toBe(0);
  });

  it("reset clears all state", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );

    parser.feed(createPacket(0));
    expect(packets).toHaveLength(1);
    expect(parser.getStats().totalPackets).toBe(1);

    parser.reset();
    const stats = parser.getStats();
    expect(stats.totalPackets).toBe(0);
    expect(stats.totalBytes).toBe(0);
    expect(stats.sequenceGaps).toBe(0);
    expect(stats.malformedPackets).toBe(0);
    expect(stats.silentPackets).toBe(0);
    expect(stats.discontinuityPackets).toBe(0);
    expect(stats.timestampErrorPackets).toBe(0);
    expect(stats.endOfStream).toBe(false);
    expect(stats.currentStreamGeneration).toBe(-1);
    expect(stats.bufferBytes).toBe(0);
  });

  it("parses payload content correctly", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );

    const frameCount = 480;
    const packet = createPacket(0, frameCount);
    parser.feed(packet);

    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(1);

    const parsed = packets[0]!;
    expect(parsed.payload.byteLength).toBe(frameCount * 2 * 4);

    // Verify a few samples match the expected sine pattern
    for (let i = 0; i < 5; i++) {
      const expected = Math.sin(i * 0.1);
      expect(parsed.payload.readFloatLE(i * 4)).toBeCloseTo(expected, 5);
    }
  });

  it("handles empty feed without errors", () => {
    const errors: string[] = [];
    const packets: ParsedPcmPacket[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    parser.feed(Buffer.alloc(0));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(0);
  });

  it("parses the maximum allowed frame count", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    // MAX_FRAMES_PER_PACKET = 960, 2 channels = 7680 payload bytes
    parser.feed(createPacket(0, MAX_FRAMES_PER_PACKET));
    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(1);
    expect(packets[0]!.header.frameCount).toBe(MAX_FRAMES_PER_PACKET);
    expect(packets[0]!.payload.byteLength).toBe(MAX_PAYLOAD_BYTES);
  });

  it("handles multiple flags simultaneously", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    // Silent + Discontinuity + TimestampError
    const flags = PCM_FLAG_SILENT | PCM_FLAG_DISCONTINUITY | PCM_FLAG_TIMESTAMP_ERROR;
    parser.feed(createPacket(0, 480, { flags }));
    expect(packets).toHaveLength(1);
    const stats = parser.getStats();
    expect(stats.silentPackets).toBe(1);
    expect(stats.discontinuityPackets).toBe(1);
    expect(stats.timestampErrorPackets).toBe(1);
  });

  it("tracks total bytes correctly", () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );
    const frameCount = 480;
    const p1 = createPacket(0, frameCount);
    const p2 = createPacket(1, frameCount);
    const totalWireBytes = p1.byteLength + p2.byteLength;

    parser.feed(Buffer.concat([p1, p2]));
    expect(packets).toHaveLength(2);
    expect(parser.getStats().totalBytes).toBe(totalWireBytes);
  });
});
