/**
 * Regression tests for:
 *   1) Deterministic renderer hydration / share preflight helper
 *   2) Main-process parity: AudioHelperManager, IPC handlers, ProcessAudioController
 *
 * These tests document the contract for upcoming fixes.  Several reference a
 * future module that does not exist yet – the resulting import failures are
 * the expected regression behaviour until the implementation lands.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Renderer hydration / share preflight helper
// ---------------------------------------------------------------------------
// These tests reference a future pure-helper module.  Because the module does
// not exist yet, each test that attempts to import it will fail with a
// MODULE_NOT_FOUND error – that is the expected regression.
// ---------------------------------------------------------------------------

const HYDRATION_HELPER_PATH = '../src/renderer/audio/audio-hydration-helper';

describe('Renderer hydration — audio mode restore', () => {
  it('initial saved supported mode is applied', async () => {
    const mod = await import(HYDRATION_HELPER_PATH);
    const result = mod.resolveInitialAudioMode('system', {
      none: true,
      system: true,
      application: true,
      monitor: true,
      'test-tone': true,
    });
    expect(result.resolved).toBe('system');
    expect(result.wasDowngraded).toBe(false);
  });

  it('unsupported saved application becomes none', async () => {
    const mod = await import(HYDRATION_HELPER_PATH);
    const result = mod.resolveInitialAudioMode('application', {
      none: true,
      system: true,
      application: false,
      monitor: false,
      'test-tone': true,
    });
    expect(result.resolved).toBe('none');
    expect(result.wasDowngraded).toBe(true);
  });

  it('unsupported saved monitor becomes none', async () => {
    const mod = await import(HYDRATION_HELPER_PATH);
    const result = mod.resolveInitialAudioMode('monitor', {
      none: true,
      system: true,
      application: false,
      monitor: false,
      'test-tone': true,
    });
    expect(result.resolved).toBe('none');
    expect(result.wasDowngraded).toBe(true);
  });

  it('explicit user-selected system is preserved against late hydration', async () => {
    const mod = await import(HYDRATION_HELPER_PATH);
    // Simulate: persisted mode is "none", but user explicitly picked "system"
    // before capabilities finished loading.  Late hydration must NOT override.
    const result = mod.resolveHydrationConflict({
      persistedMode: 'none',
      userSelectedMode: 'system' as string | null,
      capabilities: { system: true },
    });
    expect(result.final).toBe('system');
    expect(result.conflictResolved).toBe(true);
  });
});

describe('Share preflight helper', () => {
  it('throws audio-options-not-ready when not initialized', async () => {
    const mod = await import(HYDRATION_HELPER_PATH);
    expect(() =>
      mod.validateSharePreflight(null, 'system', { system: true }),
    ).toThrow('audio-options-not-ready');
  });

  it('throws requested-audio-mode-was-discarded:system when explicit system becomes none', async () => {
    const mod = await import(HYDRATION_HELPER_PATH);
    const audioOptions = { mode: 'system', available: { system: true } };
    // Simulate: capabilities later reported system as unavailable
    expect(() =>
      mod.validateSharePreflight(audioOptions, 'system', { system: false }),
    ).toThrow('requested-audio-mode-was-discarded:system');
  });

  it('rejects unsupported application with a clear reason', async () => {
    const mod = await import(HYDRATION_HELPER_PATH);
    expect(() =>
      mod.validateSharePreflight(
        { mode: 'application' },
        'application',
        { application: false, monitor: false },
      ),
    ).toThrow(/application.*not supported/i);
  });

  it('rejects unsupported monitor with a clear reason', async () => {
    const mod = await import(HYDRATION_HELPER_PATH);
    expect(() =>
      mod.validateSharePreflight(
        { mode: 'monitor' },
        'monitor',
        { application: false, monitor: false },
      ),
    ).toThrow(/monitor.*not supported/i);
  });

  it('allows supported system and includes availability metadata', async () => {
    const mod = await import(HYDRATION_HELPER_PATH);
    const result = mod.validateSharePreflight(
      { mode: 'system' },
      'system',
      { system: true },
    );
    expect(result.allowed).toBe(true);
    expect(result.metadata).toEqual({
      mode: 'system',
      available: { system: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Main-process parity — AudioHelperManager
// ---------------------------------------------------------------------------

const audioHelperManagerPath = path.resolve(
  __dirname,
  '..',
  'src',
  'main',
  'AudioHelperManager.ts',
);

describe('AudioHelperManager.startApplicationCapture', () => {
  const content = fs.readFileSync(audioHelperManagerPath, 'utf-8');
  // Locate the method body
  const methodStart = content.indexOf('async startApplicationCapture(');
  const methodBody = content.slice(methodStart, methodStart + 800);

  it('sets state to "capturing"', () => {
    expect(methodBody).toContain("this.state = 'capturing'");
  });

  it('resets parser via parser?.reset()', () => {
    expect(methodBody).toContain('this.parser?.reset()');
  });

  it('forwards bridge reset with streamGeneration', () => {
    expect(methodBody).toContain('this.pcmBridge.forwardReset(');
  });

  it('sends canary via pcmBridge.sendCanary?.()', () => {
    expect(methodBody).toContain('this.pcmBridge.sendCanary?.()');
  });
});

describe('AudioHelperManager.startFilteredMonitorCapture', () => {
  const content = fs.readFileSync(audioHelperManagerPath, 'utf-8');
  const methodStart = content.indexOf('async startFilteredMonitorCapture(');
  const methodBody = content.slice(methodStart, methodStart + 800);

  it('sets state to "capturing"', () => {
    expect(methodBody).toContain("this.state = 'capturing'");
  });

  it('resets parser via parser?.reset()', () => {
    expect(methodBody).toContain('this.parser?.reset()');
  });

  it('forwards bridge reset with streamGeneration', () => {
    expect(methodBody).toContain('this.pcmBridge.forwardReset(');
  });

  it('sends canary via pcmBridge.sendCanary?.()', () => {
    expect(methodBody).toContain('this.pcmBridge.sendCanary?.()');
  });
});

// ---------------------------------------------------------------------------
// Main-process parity — IPC handlers: normalise audio-start responses
// ---------------------------------------------------------------------------

const ipcHandlersPath = path.resolve(
  __dirname,
  '..',
  'src',
  'main',
  'ipc-handlers.ts',
);

describe('IPC handlers — audio start response normalisation', () => {
  const content = fs.readFileSync(ipcHandlersPath, 'utf-8');

  it('start-application-audio response includes "success"', () => {
    const handlerStart = content.indexOf("'start-application-audio'");
    const block = content.slice(handlerStart, handlerStart + 600);
    expect(block).toContain('success');
  });

  it('start-application-audio response includes "streamGeneration"', () => {
    const handlerStart = content.indexOf("'start-application-audio'");
    const block = content.slice(handlerStart, handlerStart + 1400);
    expect(block).toContain('streamGeneration');
  });

  it('start-filtered-monitor-audio response includes "success"', () => {
    const handlerStart = content.indexOf("'start-filtered-monitor-audio'");
    const block = content.slice(handlerStart, handlerStart + 600);
    expect(block).toContain('success');
  });

  it('start-filtered-monitor-audio response includes "streamGeneration"', () => {
    const handlerStart = content.indexOf("'start-filtered-monitor-audio'");
    const block = content.slice(handlerStart, handlerStart + 600);
    expect(block).toContain('streamGeneration');
  });

  it('start-system-audio response includes "success"', () => {
    const handlerStart = content.indexOf('"start-system-audio"');
    const block = content.slice(handlerStart, handlerStart + 400);
    expect(block).toContain('success');
  });

  it('start-system-audio response includes "streamGeneration"', () => {
    const handlerStart = content.indexOf('"start-system-audio"');
    const block = content.slice(handlerStart, handlerStart + 400);
    expect(block).toContain('streamGeneration');
  });
});

// ---------------------------------------------------------------------------
// Main-process parity — ProcessAudioController: streamGeneration from pcm:reset
// ---------------------------------------------------------------------------

const controllerPath = path.resolve(
  __dirname,
  '..',
  'src',
  'renderer',
  'audio',
  'ProcessAudioController.ts',
);

const dashboardPath = path.resolve(
  __dirname,
  '..',
  'src',
  'renderer',
  'routes',
  'Dashboard.tsx',
);

describe('ProcessAudioController — pcm:reset uses streamGeneration', () => {
  const content = fs.readFileSync(controllerPath, 'utf-8');
  const resetCaseStart = content.indexOf("case 'pcm:reset'");
  const resetBlock = content.slice(resetCaseStart, resetCaseStart + 300);

  it('pcm:reset handler reads msg.streamGeneration', () => {
    expect(resetBlock).toContain('msg.streamGeneration');
  });

  it('pcm:reset does NOT hardcode -1 for streamGeneration', () => {
    // The current implementation hardcodes this.currentStreamGeneration = -1.
    // The fix must use the generation carried in the message.
    expect(resetBlock).not.toContain('this.currentStreamGeneration = -1');
  });

  it('pcm:reset forwards streamGeneration to worklet', () => {
    expect(resetBlock).toContain('streamGeneration');
  });
});

describe('Dashboard share button regression', () => {
  const content = fs.readFileSync(dashboardPath, 'utf-8');

  it('does not permanently block Share Screen while localShareState is selecting-source', () => {
    expect(content).not.toContain("localShareState === 'selecting-source'");
  });

  it('resets localShareState before navigating to source-picker when no source is selected', () => {
    const handleStart = content.indexOf('const handleShareScreen = useCallback(async () => {');
    const handleBlock = content.slice(handleStart, handleStart + 900);
    expect(handleBlock).toContain('if (!sourceId)');
    expect(handleBlock).toContain('setLocalShareState("idle")');
    expect(handleBlock).toContain('navigate("source-picker" as Page)');
  });

  it('uses a static ProcessAudioController import instead of a runtime dynamic import', () => {
    expect(content).toContain('import { ProcessAudioController }');
    expect(content).not.toContain('await import("../audio/ProcessAudioController.js")');
  });
});
