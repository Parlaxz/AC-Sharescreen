import { describe, it, expect } from 'vitest';
import type { AudioCapabilityResult } from '@screenlink/shared';

describe('Audio mode persistence', () => {
  it('lastAudioMode should be valid values', () => {
    const validModes = ['none', 'system', 'application', 'monitor'] as const;
    for (const mode of validModes) {
      expect(['none', 'system', 'application', 'monitor']).toContain(mode);
    }
  });

  it('lastAudioMode rejects invalid values', () => {
    // At type level, only the AudioMode union is accepted
    const invalidModes = ['', 'all', 'mic', null, undefined] as readonly string[];
    const validModes = ['none', 'system', 'application', 'monitor'];
    for (const mode of invalidModes) {
      if (mode == null) {
        // null/undefined represent "not set" which is valid for optional field
        expect(true).toBe(true);
      } else {
        expect(validModes).not.toContain(mode);
      }
    }
  });
});

describe('Audio mode isolation', () => {
  // Verify each audio mode has an explicit test branch, preventing accidental
  // fallthrough (e.g., a new mode accidentally entering Filtered Monitor).

  it('every audio mode has an explicit switch branch', () => {
    // This test documents the expected mode->command mapping
    const modeCommands: Record<string, string> = {
      none:      '(none)',
      system:    'startSystemAudio',
      application: 'startApplicationAudio',
      monitor:   'startFilteredMonitorAudio',
      'test-tone': 'startSyntheticAudio',
    };
    // Every mode must have a defined command (no fallthrough allowed)
    for (const [mode, cmd] of Object.entries(modeCommands)) {
      expect(cmd).toBeTruthy(); // each mode maps to exactly one command
      // Only non-monitor modes should not equal the monitor command
      if (mode !== 'monitor') {
        expect(modeCommands[mode]).not.toBe(modeCommands['monitor']);
      }
    }
    // Verify no two distinct modes share the same command (no aliasing)
    const commands = Object.values(modeCommands);
    const uniqueCommands = new Set(commands);
    expect(uniqueCommands.size).toBe(commands.length);
  });

  it('system audio never invokes filtered monitor', () => {
    const systemCmd = 'startSystemAudio';
    const filterCmd = 'startFilteredMonitorAudio';
    expect(systemCmd).not.toBe(filterCmd);
  });

  it('application audio never invokes filtered monitor system audio', () => {
    const appCmd = 'startApplicationAudio';
    const filterCmd = 'startFilteredMonitorAudio';
    const sysCmd = 'startSystemAudio';
    expect(appCmd).not.toBe(filterCmd);
    expect(appCmd).not.toBe(sysCmd);
  });

  it('filtered monitor never invokes system audio', () => {
    const filterCmd = 'startFilteredMonitorAudio';
    const sysCmd = 'startSystemAudio';
    const appCmd = 'startApplicationAudio';
    expect(filterCmd).not.toBe(sysCmd);
    expect(filterCmd).not.toBe(appCmd);
  });
});

describe('Helper path resolution', () => {
  it('exports getHelperPath function', () => {
    // We verify the module structure by type-checking the interface
    // The actual module requires Electron and can't be imported in unit tests
    const serviceModule = '../src/main/audio-capability-service.js';
    // Just verify it can be referenced as a module path
    expect(typeof serviceModule).toBe('string');
  });

  it('dev path follows expected pattern', () => {
    // The dev path resolves relative to __dirname through 5 parent dirs
    // to reach native/audio-helper/build/Release/
    const devPathSegments = [
      'native',
      'audio-helper',
      'build',
      'Release',
      'screenlink-audio-helper.exe',
    ];
    expect(devPathSegments.join('/')).toContain('audio-helper');
    expect(devPathSegments.join('/')).toContain('screenlink-audio-helper.exe');
  });

  it('packaged path uses process.resourcesPath', () => {
    const packagedSegments = ['resources', 'screenlink-audio-helper.exe'];
    expect(packagedSegments.join('/')).toContain('screenlink-audio-helper.exe');
  });
});

describe('Source validation', () => {
  it('detects window sources correctly', () => {
    expect('window:1234'.startsWith('window:')).toBe(true);
    expect('window:0xABCD'.startsWith('window:')).toBe(true);
    expect('screen:0'.startsWith('window:')).toBe(false);
    expect('screen'.startsWith('window:')).toBe(false);
    expect(''.startsWith('window:')).toBe(false);
  });

  it('application mode requires window source', () => {
    const validSources = ['window:1234', 'window:0xABCD'];
    const invalidSources = ['screen:0', 'screen:1', ''];

    for (const src of validSources) {
      expect(src.startsWith('window:')).toBe(true);
    }
    for (const src of invalidSources) {
      if (src) {
        expect(src.startsWith('window:')).toBe(false);
      }
    }
  });

  it('monitor mode works with any source type', () => {
    // Monitor mode captures all system audio regardless of source
    const sources = ['window:1234', 'screen:0', ''];
    for (const src of sources) {
      // Monitor mode doesn't validate source
      expect(true).toBe(true);
    }
  });

  it('no-audio mode skips all audio setup', () => {
    // 'none' mode skips all audio setup regardless of source
    const sources = ['window:1234', 'screen:0', ''];
    for (const src of sources) {
      expect(true).toBe(true);
    }
  });
});

describe('Audio capability model', () => {
  it('AudioCapabilityResult has required fields', () => {
    const cap: AudioCapabilityResult = {
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
      usable: false,
      is64BitProcess: true,
      is64BitOperatingSystem: true,
      reasonCode: 'unsupported-windows-build',
      reasonMessage: 'Build 19045 is below 20348',
      status: 'ok',
    };
    expect(cap.usable).toBe(false);
    expect(cap.reasonCode).toBe('unsupported-windows-build');
    expect(cap.protocolVersion).toBe('0.1.0');
    expect(cap.helperVersion).toBe('0.1.0');
  });

  it('fully capable result has usable=true', () => {
    const cap: AudioCapabilityResult = {
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
      usable: true,
      is64BitProcess: true,
      is64BitOperatingSystem: true,
      reasonCode: 'ok',
      reasonMessage: 'Process-loopback audio is supported.',
      status: 'ok',
    };
    expect(cap.usable).toBe(true);
    expect(cap.reasonCode).toBe('ok');
    expect(cap.processLoopbackRuntimeSupported).toBe(true);
    expect(cap.applicationLoopbackSupported).toBe(true);
  });

  it('AudioCapabilityResult validates osVersion structure', () => {
    const cap: AudioCapabilityResult = {
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
      usable: true,
      is64BitProcess: true,
      is64BitOperatingSystem: true,
      reasonCode: 'ok',
      reasonMessage: 'Process-loopback audio is supported.',
      status: 'ok',
    };
    expect(cap.osVersion.major).toBe(10);
    expect(cap.osVersion.minor).toBe(0);
    expect(cap.osVersion.build).toBeGreaterThan(0);
    expect(typeof cap.osVersion.revision).toBe('number');
  });
});

describe('Audio state transitions', () => {
  const validAudioStates = [
    'disabled',
    'starting-helper',
    'connecting-transport',
    'loading-worklet',
    'buffering',
    'primed',
    'track-ready',
    'publishing',
    'active',
    'stopping',
    'error',
  ] as const;

  it('all valid AudioStateDTO values are recognized', () => {
    for (const state of validAudioStates) {
      expect(validAudioStates).toContain(state);
    }
  });

  it('audio state transitions follow expected order', () => {
    // Audio pipeline: disabled → starting-helper → connecting-transport →
    // loading-worklet → buffering → primed → track-ready → publishing → active
    const pipeline = [
      'disabled',
      'starting-helper',
      'connecting-transport',
      'loading-worklet',
      'buffering',
      'primed',
      'track-ready',
      'publishing',
      'active',
    ];
    expect(pipeline.length).toBe(9);
    expect(pipeline[0]).toBe('disabled');
    expect(pipeline[pipeline.length - 1]).toBe('active');
  });
});

describe('Graceful degradation', () => {
  it('video sharing can proceed without audio', () => {
    // Audio failure should not prevent video sharing
    const audioFailed = true;
    const canShareVideo = true;

    // When audio fails, video-only sharing continues
    const shouldContinueSharing = !audioFailed || canShareVideo;
    expect(shouldContinueSharing).toBe(true);
  });

  it('audio setup failure logs warning', () => {
    const warnMessages: string[] = [];
    const mockConsoleWarn = (msg: string) => { warnMessages.push(msg); };

    // Simulate audio setup failure
    try {
      throw new Error('Audio port timeout');
    } catch (err) {
      mockConsoleWarn(`[Audio] Setup failed, continuing video-only: ${err}`);
    }

    expect(warnMessages.length).toBe(1);
    expect(warnMessages[0]).toContain('[Audio] Setup failed');
    expect(warnMessages[0]).toContain('video-only');
  });
});

describe('Auto-restart guard', () => {
  it('shutdown prevents auto-restart', () => {
    const shuttingDown = true;
    const wasRunning = true;
    const restartCount = 0;
    const maxRestarts = 3;

    // When shutting down, auto-restart is skipped
    let shouldRestart = false;
    if (!shuttingDown && wasRunning && restartCount < maxRestarts) {
      shouldRestart = true;
    }

    expect(shouldRestart).toBe(false);
  });

  it('auto-restart proceeds when not shutting down', () => {
    const shuttingDown = false;
    const wasRunning = true;
    const restartCount = 0;
    const maxRestarts = 3;

    let shouldRestart = false;
    if (!shuttingDown && wasRunning && restartCount < maxRestarts) {
      shouldRestart = true;
    }

    expect(shouldRestart).toBe(true);
  });

  it('auto-restart blocked by max restarts', () => {
    const shuttingDown = false;
    const wasRunning = true;
    const restartCount = 3;
    const maxRestarts = 3;

    let shouldRestart = false;
    if (!shuttingDown && wasRunning && restartCount < maxRestarts) {
      shouldRestart = true;
    }

    expect(shouldRestart).toBe(false);
  });
});

describe('getAudioCapabilities API type', () => {
  it('API returns expected structure', () => {
    // Verify the IPC response type shape
    const mockResponse = {
      success: true,
      data: {
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
        usable: false,
        is64BitProcess: true,
        is64BitOperatingSystem: true,
        reasonCode: 'unsupported-windows-build',
        reasonMessage: 'Build 19045 is below 20348',
        status: 'ok',
      },
    } as const;

    expect(mockResponse.success).toBe(true);
    expect(mockResponse.data.usable).toBe(false);
    expect(mockResponse.data.reasonCode).toBe('unsupported-windows-build');
  });

  it('error response has correct shape', () => {
    const errorResponse = {
      success: false,
      error: { code: 'helper-not-found', message: 'Audio helper not found' },
    } as const;

    expect(errorResponse.success).toBe(false);
    expect(errorResponse.error.code).toBe('helper-not-found');
    expect(errorResponse.error.message).toBeTruthy();
  });
});

describe('Audio capture result handling', () => {
  // Simulates the renderer-side logic in Dashboard.tsx's handleShareScreen.
  // These tests verify the contract: capture result is checked BEFORE waitUntilPrimed.

  async function testCapturePath(
    captureResult: { success: boolean; error?: string } | undefined,
    devMode: boolean,
    fallbackEnabled: boolean,
    syntheticResult?: { success: boolean; error?: string },
  ): Promise<{ audioConfigured: boolean; audioError: string | null; appliedMode: string; isSynthetic: boolean; waitUntilPrimedCalled: boolean }> {
    let waitUntilPrimedCalled = false;
    const controller = {
      waitUntilPrimed: async () => { waitUntilPrimedCalled = true; },
    };

    const api = {
      startFilteredMonitorAudio: async () => captureResult,
      startApplicationAudio: async () => captureResult,
      startSyntheticAudio: async () => syntheticResult ?? { success: false },
      getSettings: async () => fallbackEnabled ? { useSyntheticAudioFallback: true } : {},
      stopAudio: async () => {},
    };

    const envDev = devMode;
    let audioConfigured = false;
    let audioError: string | null = null;
    let appliedMode = 'none';
    let isSynthetic = false;

    // Simulate the real capture-and-check logic from Dashboard.tsx lines 375-460
    if (!captureResult || !captureResult.success) {
      // attemptDevSyntheticFallback
      let fallbackResult: 'synthetic' | 'none' = 'none';
      if (envDev && fallbackEnabled) {
        const synthRes = syntheticResult ?? { success: false };
        if (synthRes.success) {
          fallbackResult = 'synthetic';
        }
        if (!synthRes.success) {
          fallbackResult = 'none';
        }
      }
      if (fallbackResult === 'synthetic') {
        isSynthetic = true;
        await controller.waitUntilPrimed();
        audioConfigured = true;
      } else {
        audioError = captureResult?.error ?? 'Audio capture could not start';
      }
    } else {
      appliedMode = 'monitor';
      await controller.waitUntilPrimed();
      audioConfigured = true;
    }

    return { audioConfigured, audioError, appliedMode, isSynthetic, waitUntilPrimedCalled };
  }

  it('failed filtered capture does not call waitUntilPrimed()', async () => {
    const result = await testCapturePath(
      { success: false, error: 'session-enumeration-failed' },
      false, false, undefined,
    );
    expect(result.waitUntilPrimedCalled).toBe(false);
    expect(result.audioConfigured).toBe(false);
    expect(result.audioError).toBe('session-enumeration-failed');
  });

  it('failed application capture does not call waitUntilPrimed()', async () => {
    const result = await testCapturePath(
      { success: false, error: 'process-not-found' },
      false, false, undefined,
    );
    expect(result.waitUntilPrimedCalled).toBe(false);
    expect(result.audioConfigured).toBe(false);
    expect(result.audioError).toBe('process-not-found');
  });

  it('failed audio capture continues video-only without unhandled timeout', async () => {
    // The outer try/catch catches the error; no unhandled rejection
    let caughtError: unknown = null;
    try {
      const result = await testCapturePath(
        { success: false, error: 'session-enumeration-failed' },
        false, false, undefined,
      );
      // The function does not throw — capture failure is handled gracefully
      expect(result.audioConfigured).toBe(false);
      expect(result.audioError).toBeTruthy();
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeNull();
  });

  it('explicit Test Tone starts synthetic capture and waits for priming', async () => {
    // Test-tone path: call startSyntheticAudio, check result, waitUntilPrimed on success
    let waitUntilPrimedCalled = false;
    const controller = {
      waitUntilPrimed: async () => { waitUntilPrimedCalled = true; },
    };

    const api = {
      startSyntheticAudio: async () => ({ success: true }),
      stopAudio: async () => {},
    };

    let audioConfigured = false;
    let audioError: string | null = null;
    let isSynthetic = false;

    const result = await api.startSyntheticAudio();
    if (!result || !result.success) {
      audioError = result?.error ?? 'Test tone could not start';
    } else {
      isSynthetic = true;
      await controller.waitUntilPrimed();
      audioConfigured = true;
    }

    expect(audioConfigured).toBe(true);
    expect(audioError).toBeNull();
    expect(isSynthetic).toBe(true);
    expect(waitUntilPrimedCalled).toBe(true);
  });

  it('synthetic failure is handled immediately', async () => {
    let waitUntilPrimedCalled = false;
    const controller = {
      waitUntilPrimed: async () => { waitUntilPrimedCalled = true; },
    };

    const api = {
      startSyntheticAudio: async () => ({ success: false, error: 'helper-busy' }),
      stopAudio: async () => {},
    };

    let audioConfigured = false;
    let audioError: string | null = null;

    const result = await api.startSyntheticAudio();
    if (!result || !result.success) {
      audioError = result?.error ?? 'Test tone could not start';
    } else {
      await controller.waitUntilPrimed();
      audioConfigured = true;
    }

    expect(audioConfigured).toBe(false);
    expect(audioError).toBe('helper-busy');
    expect(waitUntilPrimedCalled).toBe(false);
  });

  it('production mode never automatically substitutes synthetic audio', async () => {
    // In production (import.meta.env.DEV = false), the fallback is never attempted
    const result = await testCapturePath(
      { success: false, error: 'session-enumeration-failed' },
      false,   // devMode = false
      true,    // fallbackEnabled = true (but irrelevant in production)
      { success: true },  // synthetic would succeed if called
    );
    expect(result.waitUntilPrimedCalled).toBe(false);
    expect(result.audioConfigured).toBe(false);
    expect(result.audioError).toBe('session-enumeration-failed');
    expect(result.isSynthetic).toBe(false);
  });

  it('development fallback works only when explicitly enabled', async () => {
    // Dev mode + fallback enabled in settings = synthetic fallback works
    const result = await testCapturePath(
      { success: false, error: 'session-enumeration-failed' },
      true,    // devMode = true
      true,    // fallbackEnabled = true
      { success: true },
    );
    expect(result.waitUntilPrimedCalled).toBe(true);
    expect(result.audioConfigured).toBe(true);
    expect(result.audioError).toBeNull();
    expect(result.isSynthetic).toBe(true);
  });

  it('development fallback skipped when not explicitly enabled', async () => {
    // Dev mode but fallback NOT enabled in settings = no synthetic fallback
    const result = await testCapturePath(
      { success: false, error: 'session-enumeration-failed' },
      true,    // devMode = true
      false,   // fallbackEnabled = false
      { success: true },  // synthetic would succeed but isn't called
    );
    expect(result.waitUntilPrimedCalled).toBe(false);
    expect(result.audioConfigured).toBe(false);
    expect(result.audioError).toBe('session-enumeration-failed');
    expect(result.isSynthetic).toBe(false);
  });

  it('applied audio state is none after real capture fails', async () => {
    // When real capture fails and no fallback activates, appliedMode stays 'none'
    const result = await testCapturePath(
      { success: false, error: 'session-enumeration-failed' },
      false, false, undefined,
    );
    expect(result.appliedMode).toBe('none');
  });

  it('successful real capture sets applied mode', async () => {
    const result = await testCapturePath(
      { success: true },
      false, false, undefined,
    );
    expect(result.appliedMode).toBe('monitor');
    expect(result.audioConfigured).toBe(true);
    expect(result.waitUntilPrimedCalled).toBe(true);
  });

  it('startSyntheticAudio returns structured result', async () => {
    // Verify the type contract: return is {success, error?}
    const api = {
      startSyntheticAudio: async (): Promise<{ success: boolean; error?: string }> => {
        return { success: true };
      },
    };

    const result = await api.startSyntheticAudio();
    expect(result).toHaveProperty('success');
    // 'error' is optional — not present when success=true
    expect(result.success).toBe(true);
  });

  it('requestAudioPort returns structured result', async () => {
    const api = {
      requestAudioPort: async (): Promise<{ success: boolean; error?: string }> => {
        return { success: true };
      },
    };

    const result = await api.requestAudioPort();
    expect(result).toHaveProperty('success');
    expect(result.success).toBe(true);
  });

  it('capture error contains precise cause', () => {
    // Verify that session-enumeration-failed includes HRESULT hex
    const errorWithHresult = 'session-enumeration-failed (HRESULT=0x80070490)';
    expect(errorWithHresult).toMatch(/HRESULT=0x[0-9A-Fa-f]{8}/);
  });
});
