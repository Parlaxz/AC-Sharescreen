/**
 * Regression tests for the canonical AudioMode validator/normalizer.
 *
 * These tests expect a single authoritative `normalizeAudioMode` function in
 * @screenlink/shared that:
 *   - accepts the five valid AudioMode literals unchanged
 *   - normalizes any invalid persisted value to 'none'
 *   - respects Windows build availability constraints
 *
 * The function does not exist yet (SCREENLINK-XXX), so this file fails to
 * load — that is the expected regression behaviour until the implementation
 * is added.
 */

import { describe, it, expect } from 'vitest';
import {
  /** @remarks This export does NOT exist yet — causes the file to fail. */
  normalizeAudioMode,
  getAudioModeInfo,
  type AudioMode,
  type AudioCapabilityResult,
} from '@screenlink/shared';

// ---------------------------------------------------------------------------
// normalizeAudioMode contract
// ---------------------------------------------------------------------------

describe('normalizeAudioMode — valid modes', () => {
  it('is a function', () => {
    expect(typeof normalizeAudioMode).toBe('function');
  });

  it('passes "none" through unchanged', () => {
    expect(normalizeAudioMode('none')).toBe('none');
  });

  it('passes "system" through unchanged', () => {
    expect(normalizeAudioMode('system')).toBe('system');
  });

  it('passes "application" through unchanged', () => {
    expect(normalizeAudioMode('application')).toBe('application');
  });

  it('passes "monitor" through unchanged', () => {
    expect(normalizeAudioMode('monitor')).toBe('monitor');
  });

  it('passes "test-tone" through unchanged', () => {
    expect(normalizeAudioMode('test-tone')).toBe('test-tone');
  });
});

describe('normalizeAudioMode — invalid persisted values', () => {
  it('normalizes empty string to "none"', () => {
    expect(normalizeAudioMode('')).toBe('none');
  });

  it('normalizes unknown string to "none"', () => {
    expect(normalizeAudioMode('unknown')).toBe('none');
  });

  it('normalizes null to "none"', () => {
    expect(normalizeAudioMode(null as unknown as string)).toBe('none');
  });

  it('normalizes undefined to "none"', () => {
    expect(normalizeAudioMode(undefined as unknown as string)).toBe('none');
  });

  it('normalizes "all" to "none"', () => {
    expect(normalizeAudioMode('all')).toBe('none');
  });

  it('normalizes "mic" to "none"', () => {
    expect(normalizeAudioMode('mic')).toBe('none');
  });

  it('normalizes case-mismatched "System" to "none"', () => {
    // Persisted values are case-sensitive; only lowercase literals are valid.
    expect(normalizeAudioMode('System')).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Build-19045 availability contract (uses existing getAudioModeInfo)
// ---------------------------------------------------------------------------

describe('getAudioModeInfo — Windows build 19045 availability', () => {
  const build19045Caps: AudioCapabilityResult = {
    protocolVersion: '0.1.0',
    helperVersion: '0.1.0',
    architecture: 'x64',
    operatingSystem: 'Windows',
    osVersion: { major: 10, minor: 0, build: 19045, revision: 0 },
    detectionMethod: 'RtlGetVersion',
    detectionSucceeded: true,
    compiledWindowsSdkVersion: '10.0.22000.0',
    processLoopbackHeadersAvailable: true,
    processLoopbackRuntimeSupported: false,
    applicationLoopbackSupported: false,
    endpointLoopbackSupported: true,
    usable: false,
    is64BitProcess: true,
    is64BitOperatingSystem: true,
    reasonCode: 'unsupported-windows-build',
    reasonMessage: 'Build 19045 is below 20348',
    status: 'ok',
  };

  const modes = getAudioModeInfo(build19045Caps);
  const modeMap = new Map(modes.map((m) => [m.mode, m]));

  it('"none" is always supported on build 19045', () => {
    expect(modeMap.get('none')!.supported).toBe(true);
  });

  it('"system" is supported on build 19045 (endpoint loopback)', () => {
    expect(modeMap.get('system')!.supported).toBe(true);
  });

  it('"test-tone" is always supported on build 19045', () => {
    expect(modeMap.get('test-tone')!.supported).toBe(true);
  });

  it('"application" is NOT supported on build 19045 (requires 20348+)', () => {
    expect(modeMap.get('application')!.supported).toBe(false);
  });

  it('"monitor" is NOT supported on build 19045 (requires 20348+)', () => {
    expect(modeMap.get('monitor')!.supported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// System audio description contract
// ---------------------------------------------------------------------------

describe('getAudioModeInfo — system audio description', () => {
  const dummyCaps: AudioCapabilityResult = {
    protocolVersion: '0.1.0',
    helperVersion: '0.1.0',
    architecture: 'x64',
    operatingSystem: 'Windows',
    osVersion: { major: 10, minor: 0, build: 20348, revision: 0 },
    detectionMethod: 'RtlGetVersion',
    detectionSucceeded: true,
    compiledWindowsSdkVersion: '10.0.22000.0',
    processLoopbackHeadersAvailable: true,
    processLoopbackRuntimeSupported: true,
    applicationLoopbackSupported: true,
    endpointLoopbackSupported: true,
    usable: true,
    is64BitProcess: true,
    is64BitOperatingSystem: true,
    reasonCode: 'ok',
    reasonMessage: 'All audio features supported.',
    status: 'ok',
  };

  const modes = getAudioModeInfo(dummyCaps);
  const systemInfo = modes.find((m) => m.mode === 'system');

  it('system audio description matches the exact canonical string', () => {
    expect(systemInfo?.description).toBe(
      'Shares all sound played through your default Windows output device.',
    );
  });
});
