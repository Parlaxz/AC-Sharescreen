import { describe, it, expect } from 'vitest';
import { PcmRingBuffer } from '../src/renderer/audio/PcmRingBuffer';

describe('PcmRingBuffer', () => {
  it('writes and reads frames correctly', () => {
    const buf = new PcmRingBuffer(4800, 2); // 100ms at 48kHz
    const data = new Float32Array(960); // 480 frames stereo
    for (let i = 0; i < 960; i++) data[i] = Math.sin(i * 0.1);

    const written = buf.writeInterleaved(data);
    expect(written).toBe(480);

    const output = [new Float32Array(480), new Float32Array(480)];
    const read = buf.read(output, 480);
    expect(read).toBe(480);
    expect(output[0][0]).toBeCloseTo(Math.sin(0), 5);
  });

  it('returns 0 and zero-fills on underrun', () => {
    const buf = new PcmRingBuffer(4800, 2);
    const output = [new Float32Array(128), new Float32Array(128)];
    const read = buf.read(output, 128);
    expect(read).toBe(0);
    expect(output[0].every((s) => s === 0)).toBe(true);
    expect(output[1].every((s) => s === 0)).toBe(true);
    expect(buf.underrunFrames).toBe(128);
  });

  it('drops oldest frames on overrun', () => {
    const buf = new PcmRingBuffer(480, 2); // 10ms capacity
    const data = new Float32Array(960); // 480 frames
    data.fill(1.0);
    buf.writeInterleaved(data); // fills buffer

    const data2 = new Float32Array(960);
    data2.fill(2.0);
    const written = buf.writeInterleaved(data2); // should drop oldest and write newest
    expect(written).toBe(480);
    expect(buf.overrunFrames).toBeGreaterThan(0);
    expect(buf.framesAvailable).toBe(480); // still full after write

    // Read back — should be newest data (value 2.0), not oldest (value 1.0)
    const output = [new Float32Array(480), new Float32Array(480)];
    buf.read(output, 480);
    expect(output[0][0]).toBe(2.0);
  });

  it('handles wraparound correctly', () => {
    const buf = new PcmRingBuffer(960, 2); // 20ms at 48kHz
    // Write 480 frames, read 240, write 480 more (causes wraparound)
    const data1 = new Float32Array(960);
    data1.fill(1.0);
    buf.writeInterleaved(data1);

    const output1 = [new Float32Array(240), new Float32Array(240)];
    buf.read(output1, 240);
    expect(output1[0][0]).toBe(1.0);

    const data2 = new Float32Array(960);
    data2.fill(2.0);
    buf.writeInterleaved(data2);

    // Read remaining
    const output2 = [new Float32Array(960), new Float32Array(960)];
    const read = buf.read(output2, 960);
    // Should have 240 frames of 1.0 + up to 720 frames of 2.0 (limited by capacity)
    expect(read).toBeGreaterThan(0);
  });

  it('read returns planar channel arrays', () => {
    const buf = new PcmRingBuffer(4800, 2);
    // Write stereo: L=1, R=2, L=1, R=2, ...
    const data = new Float32Array(960);
    for (let i = 0; i < 480; i++) {
      data[i * 2] = 1.0; // Left
      data[i * 2 + 1] = 2.0; // Right
    }
    buf.writeInterleaved(data);

    const output = [new Float32Array(480), new Float32Array(480)];
    buf.read(output, 480);
    expect(output[0][0]).toBe(1.0); // Left
    expect(output[1][0]).toBe(2.0); // Right
  });

  it('reset clears state', () => {
    const buf = new PcmRingBuffer(4800, 2);
    const data = new Float32Array(960);
    buf.writeInterleaved(data);
    expect(buf.framesAvailable).toBe(480);
    buf.reset();
    expect(buf.framesAvailable).toBe(0);
    expect(buf.overrunFrames).toBe(0);
    expect(buf.underrunFrames).toBe(0);
  });

  it('write accepts fewer frames than buffer capacity', () => {
    const buf = new PcmRingBuffer(4800, 2);
    const data = new Float32Array(480); // 240 frames only
    data.fill(0.5);
    const written = buf.writeInterleaved(data);
    expect(written).toBe(240);
    expect(buf.framesAvailable).toBe(240);
  });

  it('read partial frames with zero-fill for remainder', () => {
    const buf = new PcmRingBuffer(4800, 2);
    const data = new Float32Array(960); // 480 frames
    data.fill(0.75);
    buf.writeInterleaved(data);

    // Request more than available
    const output = [new Float32Array(960), new Float32Array(960)];
    const read = buf.read(output, 960);
    expect(read).toBe(480);
    // First 480 should be 0.75
    expect(output[0][0]).toBe(0.75);
    expect(output[0][479]).toBe(0.75);
    // Remaining 480 should be 0
    expect(output[0][480]).toBe(0);
    expect(output[0][959]).toBe(0);
  });

  it('tracks total written and read counts', () => {
    const buf = new PcmRingBuffer(4800, 2);
    expect(buf.totalWritten).toBe(0);
    expect(buf.totalRead).toBe(0);

    const data = new Float32Array(960);
    data.fill(1.0);
    buf.writeInterleaved(data);
    expect(buf.totalWritten).toBe(480);

    const output = [new Float32Array(240), new Float32Array(240)];
    buf.read(output, 240);
    expect(buf.totalRead).toBe(240);

    buf.read(output, 240);
    expect(buf.totalRead).toBe(480);
  });

  it('handles sequential write-read cycles', () => {
    const buf = new PcmRingBuffer(4800, 2);

    // Write and read several packets
    for (let cycle = 0; cycle < 10; cycle++) {
      const data = new Float32Array(960);
      data.fill(cycle);
      buf.writeInterleaved(data);
      expect(buf.framesAvailable).toBe(480);

      const output = [new Float32Array(480), new Float32Array(480)];
      const read = buf.read(output, 480);
      expect(read).toBe(480);
      expect(output[0][0]).toBe(cycle);
    }
  });
});
