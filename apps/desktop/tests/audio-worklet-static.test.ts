import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('AudioWorklet module', () => {
  const workletPath = path.resolve(__dirname, '..', 'src', 'renderer', 'audio', 'process-pcm-worklet.ts');

  it('worklet file exists', () => {
    expect(fs.existsSync(workletPath)).toBe(true);
  });

  it('worklet file contains registerProcessor call', () => {
    const content = fs.readFileSync(workletPath, 'utf-8');
    expect(content).toContain('registerProcessor');
    expect(content).toContain('process-pcm-worklet');
  });

  it('worklet file does not use ScriptProcessorNode', () => {
    const content = fs.readFileSync(workletPath, 'utf-8');
    expect(content).not.toContain('ScriptProcessorNode');
  });

  it('ProcessAudioController exports correct types', async () => {
    const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
    const controller = new ProcessAudioController();
    expect(controller).toBeDefined();
    expect(typeof controller.initialize).toBe('function');
    expect(typeof controller.close).toBe('function');
    expect(typeof controller.getTrack).toBe('function');
  });

  it('PcmRingBuffer is exported', async () => {
    const { PcmRingBuffer } = await import('../src/renderer/audio/PcmRingBuffer');
    expect(PcmRingBuffer).toBeDefined();
    const buf = new PcmRingBuffer(4800, 2);
    expect(buf).toBeDefined();
    expect(buf.capacity).toBe(4800);
  });
});
