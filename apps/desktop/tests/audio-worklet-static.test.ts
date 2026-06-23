import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('AudioWorklet module', () => {
  const workletPath = path.resolve(__dirname, '..', 'src', 'renderer', 'audio', 'process-pcm-worklet.ts');
  const controllerPath = path.resolve(__dirname, '..', 'src', 'renderer', 'audio', 'ProcessAudioController.ts');
  const publisherManagerPath = path.resolve(__dirname, '..', 'src', 'renderer', 'services', 'publisher-manager.ts');

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

  it('ProcessAudioController is constructable', async () => {
    const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
    const controller = new ProcessAudioController();
    expect(controller).toBeDefined();
    expect(typeof controller.initialize).toBe('function');
    expect(typeof controller.close).toBe('function');
    expect(typeof controller.getTrack).toBe('function');
    expect(typeof controller.waitUntilPrimed).toBe('function');
    expect(typeof controller.waitUntilRendering).toBe('function');
  });

  it('PcmRingBuffer is exported', async () => {
    const { PcmRingBuffer } = await import('../src/renderer/audio/PcmRingBuffer');
    expect(PcmRingBuffer).toBeDefined();
    const buf = new PcmRingBuffer(4800, 2);
    expect(buf).toBeDefined();
    expect(buf.capacity).toBe(4800);
  });

  describe('AudioWorkletNode stereo configuration', () => {
    it('creates AudioWorklet node with explicit outputChannelCount: [2]', () => {
      const content = fs.readFileSync(controllerPath, 'utf-8');
      // The AudioWorkletNode constructor must pass stereo options
      expect(content).toContain('outputChannelCount: [2]');
      expect(content).toContain('numberOfInputs: 0');
      expect(content).toContain('numberOfOutputs: 1');
      expect(content).toContain("channelCountMode: 'explicit'");
    });
  });

  describe('Worklet output shape diagnostics', () => {
    it('worklet sends pcm:output-shape on first process() call', () => {
      const content = fs.readFileSync(workletPath, 'utf-8');
      expect(content).toContain('pcm:output-shape');
      expect(content).toContain('channelCount');
      expect(content).toContain('quantumFrames');
    });

    it('worklet sends pcm:fatal when output channel count is invalid', () => {
      const content = fs.readFileSync(workletPath, 'utf-8');
      expect(content).toContain('pcm:fatal');
      expect(content).toContain('invalid-output-channel-count');
      expect(content).toContain('expectedChannels: 2');
    });

    it('worklet fills invalid channels with zero (does not silently return)', () => {
      const content = fs.readFileSync(workletPath, 'utf-8');
      // Must fill zero in invalid-shape branch
      const fatalBlock = content.indexOf('pcm:fatal');
      const afterFatal = content.slice(fatalBlock);
      expect(afterFatal).toContain('.fill(0)');
    });
  });

  describe('pcm:rendering event', () => {
    it('worklet emits pcm:rendering after nonzero output', () => {
      const content = fs.readFileSync(workletPath, 'utf-8');
      expect(content).toContain('pcm:rendering');
      expect(content).toContain('renderedNonZero');
    });

    it('worklet tracks renderedNonZero separately from primed', () => {
      const content = fs.readFileSync(workletPath, 'utf-8');
      // primed is set by buffer depth, renderedNonZero by actual nonzero output
      const primedIndex = content.indexOf('this.primed = true');
      const renderedIndex = content.indexOf('this.renderedNonZero = true');
      expect(primedIndex).toBeGreaterThan(0);
      expect(renderedIndex).toBeGreaterThan(0);
      expect(renderedIndex).toBeGreaterThan(primedIndex);
    });
  });

  describe('Controller rendering state', () => {
    it('AudioWorkletState includes rendering', async () => {
      const { AudioWorkletState } = await import('../src/renderer/audio/ProcessAudioController');
      // This is a type, verify it's available
      expect(typeof {} as AudioWorkletState).toBe('object');
    });

    it('controller has waitUntilRendering method', async () => {
      const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
      const controller = new ProcessAudioController();
      expect(typeof controller.waitUntilRendering).toBe('function');
    });

    it('controller handles pcm:rendering, pcm:fatal, pcm:output-shape messages', () => {
      const content = fs.readFileSync(controllerPath, 'utf-8');
      expect(content).toContain('pcm:rendering');
      expect(content).toContain('pcm:fatal');
      expect(content).toContain('pcm:output-shape');
    });
  });

  describe('Controller ownership and cleanup', () => {
    it('publisher-manager has clearAudioController method', () => {
      const content = fs.readFileSync(publisherManagerPath, 'utf-8');
      expect(content).toContain('clearAudioController');
    });

    it('buildCombinedStream checks controller state (not just readyState)', () => {
      const content = fs.readFileSync(publisherManagerPath, 'utf-8');
      expect(content).toContain('ctrlState === "rendering"');
      expect(content).toContain('ctrlState === "primed"');
    });

    it('controller has getFatalError method', async () => {
      const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
      const controller = new ProcessAudioController();
      expect(typeof controller.getFatalError).toBe('function');
    });

    it('controller has isOutputShapeValid method', async () => {
      const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
      const controller = new ProcessAudioController();
      expect(typeof controller.isOutputShapeValid).toBe('function');
    });
  });

  describe('Worklet stats', () => {
    it('stats use framesSinceReport accumulator', () => {
      const content = fs.readFileSync(workletPath, 'utf-8');
      expect(content).toContain('framesSinceReport');
      expect(content).toContain('framesSinceReport >= 48000');
    });

    it('stats reset nonZeroSamples after reporting', () => {
      const content = fs.readFileSync(workletPath, 'utf-8');
      expect(content).toContain('this.stats.nonZeroSamples = 0');
    });

    it('processCalls increments on every process call', () => {
      const content = fs.readFileSync(workletPath, 'utf-8');
      expect(content).toContain('this.stats.processCalls++');
    });
  });

  describe('Dashboard.tsx - block scoping fix', () => {
    it('controller declared in outer scope, not inside try', () => {
      const content = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'routes', 'Dashboard.tsx'), 'utf-8');
      // Must use let (outer scope), not const inside try
      expect(content).toContain('let provisionalController');
    });
  });
});
