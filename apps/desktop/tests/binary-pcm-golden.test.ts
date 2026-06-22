import { describe, it, expect } from 'vitest';
import {
  BinaryPcmParser,
  ParsedPcmPacket,
  HEADER_SIZE,
  PCM_MAGIC,
  PCM_WIRE_VERSION,
  PCM_FLAG_SYNTHETIC,
  PCM_FLAG_SILENT,
  PCM_FLAG_DISCONTINUITY,
  PCM_FLAG_TIMESTAMP_ERROR,
  PCM_FLAG_END_OF_STREAM,
  MAX_FRAMES_PER_PACKET,
  MAX_PAYLOAD_BYTES,
  validatePcmHeader,
} from '../src/main/BinaryPcmParser.js';

/**
 * Build a golden PCM packet header buffer from field values.
 * This is the canonical wire-format reference for cross-language testing.
 *
 * Header layout (68 bytes, little-endian):
 * Offset  Size  Field
 * 0       4     magic               uint32
 * 4       2     headerSize          uint16
 * 6       2     wireVersion         uint16
 * 8       4     flags               uint32
 * 12      8     sequenceNumber      uint64
 * 20      8     qpcTimestamp        uint64
 * 28      8     qpcFrequency        uint64
 * 36      8     devicePosition      uint64
 * 44      4     sampleRate          uint32
 * 48      2     channels            uint16
 * 50      2     sampleFormat        uint16
 * 52      4     frameCount          uint32
 * 56      4     payloadBytes        uint32
 * 60      4     streamGeneration    uint32
 * 64      4     droppedPackets      uint32
 * Total: 68 bytes
 */
function buildGoldenHeader(overrides?: Partial<Record<string, number>>): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE);
  buf.writeUInt32LE(PCM_MAGIC, 0);           // magic
  buf.writeUInt16LE(HEADER_SIZE, 4);         // headerSize
  buf.writeUInt16LE(PCM_WIRE_VERSION, 6);    // wireVersion
  buf.writeUInt32LE(PCM_FLAG_SYNTHETIC, 8);  // flags
  buf.writeUInt32LE(42, 12);                 // sequenceNumber low
  buf.writeUInt32LE(0, 16);                  // sequenceNumber high
  buf.writeUInt32LE(1000000, 20);            // qpcTimestamp low
  buf.writeUInt32LE(0, 24);                  // qpcTimestamp high
  buf.writeUInt32LE(10000000, 28);           // qpcFrequency low
  buf.writeUInt32LE(0, 32);                  // qpcFrequency high
  buf.writeUInt32LE(48000, 36);              // devicePosition low
  buf.writeUInt32LE(0, 40);                  // devicePosition high
  buf.writeUInt32LE(48000, 44);              // sampleRate
  buf.writeUInt16LE(2, 48);                  // channels
  buf.writeUInt16LE(0, 50);                  // sampleFormat (float32)
  buf.writeUInt32LE(480, 52);                // frameCount
  const payloadBytes = 480 * 2 * 4;          // 3840
  buf.writeUInt32LE(payloadBytes, 56);       // payloadBytes
  buf.writeUInt32LE(1, 60);                  // streamGeneration
  buf.writeUInt32LE(0, 64);                  // droppedPackets

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      const offsets: Record<string, number> = {
        magic: 0, headerSize: 4, wireVersion: 6, flags: 8,
        sequenceNumber: 12, qpcTimestamp: 20, qpcFrequency: 28,
        devicePosition: 36, sampleRate: 44, channels: 48,
        sampleFormat: 50, frameCount: 52, payloadBytes: 56,
        streamGeneration: 60, droppedPackets: 64,
      };
      const offset = offsets[key];
      if (offset === undefined) continue;

      // Determine write size by field name and offset
      if (key === 'channels' || key === 'sampleFormat') {
        buf.writeUInt16LE(value, offset);
      } else if (key === 'headerSize' || key === 'wireVersion') {
        buf.writeUInt16LE(value, offset);
      } else if (
        key === 'payloadBytes' || key === 'frameCount' || key === 'sampleRate' ||
        key === 'magic' || key === 'flags' || key === 'streamGeneration' ||
        key === 'droppedPackets'
      ) {
        buf.writeUInt32LE(value, offset);
      } else {
        // uint64 fields: sequenceNumber, qpcTimestamp, qpcFrequency, devicePosition
        buf.writeUInt32LE(value, offset);
        buf.writeUInt32LE(0, offset + 4);
      }
    }
  }

  return buf;
}

function buildGoldenPacket(
  seq = 0,
  frameCount = 480,
  flags = PCM_FLAG_SYNTHETIC,
  streamGeneration = 1,
): Buffer {
  const channels = 2;
  const payloadBytes = frameCount * channels * 4;
  const header = buildGoldenHeader({
    flags,
    sequenceNumber: seq,
    frameCount,
    payloadBytes,
    streamGeneration,
  });
  const payload = Buffer.alloc(payloadBytes);
  // Fill with deterministic 440Hz sine at 0.25 amplitude
  for (let f = 0; f < frameCount; f++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = 0.25 * Math.sin(2 * Math.PI * 440 * f / 48000);
      const offset = (f * channels + ch) * 4;
      payload.writeFloatLE(sample, offset);
    }
  }
  return Buffer.concat([header, payload]);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('PCM golden binary packet', () => {
  // ── Header layout verification ──

  it('HEADER_SIZE is 68 bytes', () => {
    expect(HEADER_SIZE).toBe(68);
  });

  it('golden header has correct magic', () => {
    const hdr = buildGoldenHeader();
    expect(hdr.readUInt32LE(0)).toBe(PCM_MAGIC);
  });

  it('golden header has correct headerSize field', () => {
    const hdr = buildGoldenHeader();
    expect(hdr.readUInt16LE(4)).toBe(68);
    expect(hdr.readUInt16LE(4)).toBe(HEADER_SIZE);
  });

  it('golden header field offsets match canonical layout', () => {
    const hdr = buildGoldenHeader();
    // Verify all field offsets
    // The C++ equivalent PcmPacketHeader must have identical layout

    // Offset 0: magic
    expect(hdr.readUInt32LE(0)).toBe(PCM_MAGIC);
    // Offset 4: headerSize
    expect(hdr.readUInt16LE(4)).toBe(68);
    // Offset 6: wireVersion
    expect(hdr.readUInt16LE(6)).toBe(1);
    // Offset 8: flags
    expect(hdr.readUInt32LE(8)).toBe(PCM_FLAG_SYNTHETIC);
    // Offset 12: sequenceNumber (uint64)
    expect(Number(hdr.readBigUInt64LE(12))).toBe(42);
    // Offset 20: qpcTimestamp (uint64)
    expect(Number(hdr.readBigUInt64LE(20))).toBe(1000000);
    // Offset 28: qpcFrequency (uint64)
    expect(Number(hdr.readBigUInt64LE(28))).toBe(10000000);
    // Offset 36: devicePosition (uint64)
    expect(Number(hdr.readBigUInt64LE(36))).toBe(48000);
    // Offset 44: sampleRate
    expect(hdr.readUInt32LE(44)).toBe(48000);
    // Offset 48: channels
    expect(hdr.readUInt16LE(48)).toBe(2);
    // Offset 50: sampleFormat
    expect(hdr.readUInt16LE(50)).toBe(0);
    // Offset 52: frameCount
    expect(hdr.readUInt32LE(52)).toBe(480);
    // Offset 56: payloadBytes
    expect(hdr.readUInt32LE(56)).toBe(480 * 2 * 4);
    // Offset 60: streamGeneration
    expect(hdr.readUInt32LE(60)).toBe(1);
    // Offset 64: droppedPackets
    expect(hdr.readUInt32LE(64)).toBe(0);
  });

  // ── BinaryPcmParser integration ──

  it('BinaryPcmParser parses golden packet correctly', () => {
    const packets: ParsedPcmPacket[] = [];
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      (e) => errors.push(e),
    );

    const golden = buildGoldenPacket(0, 480, PCM_FLAG_SYNTHETIC, 1);
    parser.feed(golden);

    expect(errors).toHaveLength(0);
    expect(packets).toHaveLength(1);
    expect(packets[0].header.magic).toBe(PCM_MAGIC);
    expect(packets[0].header.headerSize).toBe(68);
    expect(packets[0].header.wireVersion).toBe(1);
    expect(packets[0].header.flags).toBe(PCM_FLAG_SYNTHETIC);
    expect(packets[0].header.sequenceNumber).toBe(0);
    expect(packets[0].header.frameCount).toBe(480);
    expect(packets[0].header.channels).toBe(2);
    expect(packets[0].header.sampleFormat).toBe(0);
    expect(packets[0].header.sampleRate).toBe(48000);
    expect(packets[0].header.streamGeneration).toBe(1);
    expect(packets[0].header.droppedPackets).toBe(0);
    expect(packets[0].payload.length).toBe(480 * 2 * 4);
  });

  it('BinaryPcmParser validates all flag types', () => {
    for (const [flag] of [
      [PCM_FLAG_SILENT],
      [PCM_FLAG_DISCONTINUITY],
      [PCM_FLAG_TIMESTAMP_ERROR],
      [PCM_FLAG_SYNTHETIC],
      [PCM_FLAG_END_OF_STREAM],
    ] as const) {
      const packets: ParsedPcmPacket[] = [];
      const parser = new BinaryPcmParser(
        (p) => packets.push(p),
        () => {},
      );
      parser.feed(buildGoldenPacket(0, 480, flag, 1));
      expect(packets).toHaveLength(1);
      expect(packets[0].header.flags).toBe(flag);
    }
  });

  it('parser rejects invalid magic', () => {
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      () => {},
      (e) => errors.push(e),
    );
    const bad = buildGoldenHeader({ magic: 0xDEADBEEF });
    const payload = Buffer.alloc(480 * 2 * 4);
    parser.feed(Buffer.concat([bad, payload]));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('parser rejects payload overflow', () => {
    const errors: string[] = [];
    const parser = new BinaryPcmParser(
      () => {},
      (e) => errors.push(e),
    );
    const bad = buildGoldenPacket(0, 10000); // frameCount > MAX_FRAMES_PER_PACKET
    parser.feed(bad);
    // Should report an error for invalid frame count
    // (the parser validates header before extracting payload)
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('handles sequence of golden packets', () => {
    const packets: ParsedPcmPacket[] = [];
    const parser = new BinaryPcmParser(
      (p) => packets.push(p),
      () => {},
    );

    for (let i = 0; i < 5; i++) {
      parser.feed(buildGoldenPacket(i, 480, PCM_FLAG_SYNTHETIC, 1));
    }

    expect(packets).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(packets[i].header.sequenceNumber).toBe(i);
    }
  });

  // ── validatePcmHeader ──

  it('validatePcmHeader accepts valid header', () => {
    const hdr = buildGoldenHeader();
    const parsed = {
      magic: hdr.readUInt32LE(0),
      headerSize: hdr.readUInt16LE(4),
      wireVersion: hdr.readUInt16LE(6),
      flags: hdr.readUInt32LE(8),
      sequenceNumber: Number(hdr.readBigUInt64LE(12)),
      qpcTimestamp: Number(hdr.readBigUInt64LE(20)),
      qpcFrequency: Number(hdr.readBigUInt64LE(28)),
      devicePosition: Number(hdr.readBigUInt64LE(36)),
      sampleRate: hdr.readUInt32LE(44),
      channels: hdr.readUInt16LE(48),
      sampleFormat: hdr.readUInt16LE(50),
      frameCount: hdr.readUInt32LE(52),
      payloadBytes: hdr.readUInt32LE(56),
      streamGeneration: hdr.readUInt32LE(60),
      droppedPackets: hdr.readUInt32LE(64),
    };
    expect(validatePcmHeader(parsed)).toBeNull();
  });

  it('validatePcmHeader rejects bad magic', () => {
    const hdr = buildGoldenHeader({ magic: 0xBAD });
    expect(validatePcmHeader({
      magic: hdr.readUInt32LE(0),
      headerSize: hdr.readUInt16LE(4),
      wireVersion: hdr.readUInt16LE(6),
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
      streamGeneration: 1,
      droppedPackets: 0,
    })).not.toBeNull();
  });

  it('validatePcmHeader rejects zero sample rate', () => {
    expect(validatePcmHeader({
      magic: PCM_MAGIC, headerSize: 68, wireVersion: 1,
      flags: 0, sequenceNumber: 0, qpcTimestamp: 0, qpcFrequency: 10000000,
      devicePosition: 0, sampleRate: 0, channels: 2, sampleFormat: 0,
      frameCount: 480, payloadBytes: 480 * 2 * 4,
      streamGeneration: 1, droppedPackets: 0,
    })).not.toBeNull();
  });

  it('validatePcmHeader rejects zero channels', () => {
    expect(validatePcmHeader({
      magic: PCM_MAGIC, headerSize: 68, wireVersion: 1,
      flags: 0, sequenceNumber: 0, qpcTimestamp: 0, qpcFrequency: 10000000,
      devicePosition: 0, sampleRate: 48000, channels: 0, sampleFormat: 0,
      frameCount: 480, payloadBytes: 480 * 2 * 4,
      streamGeneration: 1, droppedPackets: 0,
    })).not.toBeNull();
  });

  it('validatePcmHeader rejects unsupported sample format', () => {
    expect(validatePcmHeader({
      magic: PCM_MAGIC, headerSize: 68, wireVersion: 1,
      flags: 0, sequenceNumber: 0, qpcTimestamp: 0, qpcFrequency: 10000000,
      devicePosition: 0, sampleRate: 48000, channels: 2, sampleFormat: 1,
      frameCount: 480, payloadBytes: 480 * 2 * 4,
      streamGeneration: 1, droppedPackets: 0,
    })).not.toBeNull();
  });

  it('validatePcmHeader rejects payload size mismatch', () => {
    expect(validatePcmHeader({
      magic: PCM_MAGIC, headerSize: 68, wireVersion: 1,
      flags: 0, sequenceNumber: 0, qpcTimestamp: 0, qpcFrequency: 10000000,
      devicePosition: 0, sampleRate: 48000, channels: 2, sampleFormat: 0,
      frameCount: 480, payloadBytes: 9999, // wrong
      streamGeneration: 1, droppedPackets: 0,
    })).not.toBeNull();
  });

  it('validatePcmHeader rejects header size mismatch', () => {
    expect(validatePcmHeader({
      magic: PCM_MAGIC, headerSize: 99, wireVersion: 1,
      flags: 0, sequenceNumber: 0, qpcTimestamp: 0, qpcFrequency: 10000000,
      devicePosition: 0, sampleRate: 48000, channels: 2, sampleFormat: 0,
      frameCount: 480, payloadBytes: 480 * 2 * 4,
      streamGeneration: 1, droppedPackets: 0,
    })).not.toBeNull();
  });

  it('validatePcmHeader rejects bad wire version', () => {
    expect(validatePcmHeader({
      magic: PCM_MAGIC, headerSize: 68, wireVersion: 99,
      flags: 0, sequenceNumber: 0, qpcTimestamp: 0, qpcFrequency: 10000000,
      devicePosition: 0, sampleRate: 48000, channels: 2, sampleFormat: 0,
      frameCount: 480, payloadBytes: 480 * 2 * 4,
      streamGeneration: 1, droppedPackets: 0,
    })).not.toBeNull();
  });
});

describe('C++ vs TS header agreement', () => {
  it('HEADER_SIZE matches C++ static_assert (68)', () => {
    expect(HEADER_SIZE).toBe(68);
  });

  it('PCM_MAGIC matches C++ kPcmMagic (0x50434D21)', () => {
    expect(PCM_MAGIC).toBe(0x50434D21);
  });

  it('PCM_WIRE_VERSION matches C++ kPcmWireVersion (1)', () => {
    expect(PCM_WIRE_VERSION).toBe(1);
  });

  it('flag constants match C++ values', () => {
    expect(PCM_FLAG_SILENT).toBe(1);
    expect(PCM_FLAG_DISCONTINUITY).toBe(2);
    expect(PCM_FLAG_TIMESTAMP_ERROR).toBe(4);
    expect(PCM_FLAG_SYNTHETIC).toBe(8);
    expect(PCM_FLAG_END_OF_STREAM).toBe(16);
  });

  it('MAX_FRAMES_PER_PACKET matches C++ (960)', () => {
    expect(MAX_FRAMES_PER_PACKET).toBe(960);
  });

  it('MAX_PAYLOAD_BYTES matches C++ (7680)', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(960 * 2 * 4);
  });
});
