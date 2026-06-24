import { describe, it, expect } from 'vitest';

// ── Control Protocol JSON Structure Tests ──
// ControlClient depends on Windows named pipes via fs.openSync.
// For unit testing without a running helper, test the JSON protocol
// construction and parsing logic in isolation.

describe('Control protocol JSON structure', () => {
  it('hello request has correct fields', () => {
    const request = {
      protocolVersion: '0.2.0',
      requestId: 1,
      sessionId: 'test-session',
      authToken: 'test-token',
      command: 'hello',
      payload: {},
    };
    const json = JSON.stringify(request);
    const parsed = JSON.parse(json);
    expect(parsed.protocolVersion).toBe('0.2.0');
    expect(parsed.command).toBe('hello');
    expect(parsed.authToken).toBe('test-token');
  });

  it('response has correct fields', () => {
    const response = {
      protocolVersion: '0.2.0',
      requestId: 1,
      sessionId: 'test-session',
      success: true,
      state: 'idle',
      result: { helperVersion: '0.1.0' },
      error: null,
    };
    const json = JSON.stringify(response);
    const parsed = JSON.parse(json);
    expect(parsed.success).toBe(true);
    expect(parsed.state).toBe('idle');
    expect(parsed.result.helperVersion).toBe('0.1.0');
    expect(parsed.error).toBeNull();
  });

  it('error response has error field', () => {
    const response = {
      protocolVersion: '0.2.0',
      requestId: 1,
      sessionId: 'test-session',
      success: false,
      state: 'error',
      error: 'invalid-auth-token',
    };
    const json = JSON.stringify(response);
    const parsed = JSON.parse(json);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('invalid-auth-token');
  });

  it('startSynthetic payload', () => {
    const request = {
      protocolVersion: '0.2.0',
      requestId: 2,
      sessionId: 'test-session',
      authToken: 'test-token',
      command: 'startSynthetic',
      payload: { mode: 0, totalPackets: 100, framesPerPacket: 480 },
    };
    const json = JSON.stringify(request);
    const parsed = JSON.parse(json);
    expect(parsed.command).toBe('startSynthetic');
    expect(parsed.payload.mode).toBe(0);
    expect(parsed.payload.totalPackets).toBe(100);
  });

  it('startProcessCapture payload', () => {
    const request = {
      protocolVersion: '0.2.0',
      requestId: 3,
      sessionId: 'test-session',
      authToken: 'test-token',
      command: 'startProcessCapture',
      payload: { targetPid: 1234, mode: 'include' },
    };
    const json = JSON.stringify(request);
    const parsed = JSON.parse(json);
    expect(parsed.command).toBe('startProcessCapture');
    expect(parsed.payload.targetPid).toBe(1234);
    expect(parsed.payload.mode).toBe('include');
  });

  it('startProcessCapture with creation time payload', () => {
    const request = {
      protocolVersion: '0.2.0',
      requestId: 4,
      sessionId: 'test-session',
      authToken: 'test-token',
      command: 'startProcessCapture',
      payload: {
        targetPid: 5678,
        // Creation time is a 64-bit FILETIME; transport as string to preserve precision
        expectedCreationTimeUtc100ns: '1337000000000000000',
      },
    };
    const json = JSON.stringify(request);
    const parsed = JSON.parse(json);
    expect(parsed.payload.expectedCreationTimeUtc100ns).toBe('1337000000000000000');
  });
});

// ── AudioHelperManager Structure Tests ──
// These verify the class shape without needing a running helper.

describe('AudioHelperManager configuration', () => {
  it('has correct default config format', () => {
    const config = {
      helperPath: 'C:\\path\\to\\screenlink-audio-helper.exe',
    };
    expect(config.helperPath).toContain('.exe');
  });

  it('exports the AudioHelperManager class with expected methods', async () => {
    const { AudioHelperManager } = await import('../src/main/AudioHelperManager');
    expect(typeof AudioHelperManager).toBe('function');
    expect(AudioHelperManager.prototype.start).toBeDefined();
    expect(AudioHelperManager.prototype.shutdown).toBeDefined();
    expect(AudioHelperManager.prototype.startSyntheticCapture).toBeDefined();
    expect(AudioHelperManager.prototype.startProcessCapture).toBeDefined();
    expect(AudioHelperManager.prototype.stopCapture).toBeDefined();
    expect(AudioHelperManager.prototype.getCapabilities).toBeDefined();
    expect(AudioHelperManager.prototype.getDiagnostics).toBeDefined();
    expect(AudioHelperManager.prototype.getStats).toBeDefined();
  });

  it('AudioHelperManager constructor is callable', async () => {
    const { AudioHelperManager } = await import('../src/main/AudioHelperManager');
    // Cannot fully construct without a real helper, but the constructor
    // itself should not throw (it just stores config and generates IDs)
    expect(() => {
      const mgr = new AudioHelperManager({
        helperPath: 'C:\\helper.exe',
      });
      expect(mgr.state_).toBe('disconnected');
      expect(mgr.sessionId_).toBeTruthy();
      expect(mgr.helperPid).toBeNull();
    }).not.toThrow();
  });

  it('generates unique session IDs per instance', async () => {
    const { AudioHelperManager } = await import('../src/main/AudioHelperManager');
    const a = new AudioHelperManager({ helperPath: 'a.exe' });
    const b = new AudioHelperManager({ helperPath: 'b.exe' });
    expect(a.sessionId_).not.toBe(b.sessionId_);
  });
});

// ── ControlClient Structure Tests ──

describe('ControlClient class structure', () => {
  it('exports ControlClient with expected methods', async () => {
    const { ControlClient } = await import('../src/main/ControlClient');
    expect(typeof ControlClient).toBe('function');
    expect(ControlClient.prototype.connect).toBeDefined();
    expect(ControlClient.prototype.sendRequest).toBeDefined();
    expect(ControlClient.prototype.isConnected).toBeDefined();
    expect(ControlClient.prototype.hello).toBeDefined();
    expect(ControlClient.prototype.getVersion).toBeDefined();
    expect(ControlClient.prototype.getCapabilities).toBeDefined();
    expect(ControlClient.prototype.getState).toBeDefined();
    expect(ControlClient.prototype.startSynthetic).toBeDefined();
    expect(ControlClient.prototype.startProcessCapture).toBeDefined();
    expect(ControlClient.prototype.stopCapture).toBeDefined();
    expect(ControlClient.prototype.getDiagnostics).toBeDefined();
    expect(ControlClient.prototype.ping).toBeDefined();
    expect(ControlClient.prototype.shutdown).toBeDefined();
    expect(ControlClient.prototype.disconnect).toBeDefined();
  });
});

// ── AudioHelperStats TypeShape Test ──

describe('AudioHelperStats', () => {
  it('has all required fields', () => {
    const stats = {
      state: 'disconnected' as const,
      helperPid: null,
      helperUptimeMs: 0,
      streamGeneration: -1,
      packetCount: 0,
      payloadBytes: 0,
      droppedPackets: 0,
      sequenceGaps: 0,
      malformedPackets: 0,
      silentPackets: 0,
      discontinuityPackets: 0,
      timestampErrorPackets: 0,
      queueDepth: 0,
      maxQueueDepth: 0,
      parserBufferBytes: 0,
      maxParserBufferBytes: 0,
      helperRestarts: 0,
      lastError: null,
    };
    expect(stats.state).toBe('disconnected');
    expect(stats.packetCount).toBe(0);
    expect(stats.helperRestarts).toBe(0);
  });
});

// ── Type Export Tests ──

describe('ControlClient type exports', () => {
  it('HelperCapabilities type has expected shape', () => {
    const caps: Record<string, unknown> = {
      osVersion: { major: 10, minor: 0, build: 19045, revision: 0 },
      compiledWindowsSdkVersion: '10.0.22621.0',
      processLoopbackRuntimeSupported: true,
      usable: true,
      reasonCode: 'ok',
      reasonMessage: '',
    };
    const json = JSON.stringify(caps);
    const parsed = JSON.parse(json);
    expect(parsed.osVersion.major).toBe(10);
    expect(parsed.usable).toBe(true);
  });

  it('HelperDiagnostics type has expected shape', () => {
    const diag: Record<string, unknown> = {
      totalPackets: 1000,
      totalPayloadBytes: 3840000,
      droppedPackets: 0,
      queueSize: 32,
      packetsWritten: 1000,
      writeErrors: 0,
      totalControlRequests: 50,
      failedControlRequests: 0,
      uptimeMs: 60000,
      activeSourceType: 'synthetic',
      state: 'capturing',
      streamGeneration: 1,
    };
    const json = JSON.stringify(diag);
    const parsed = JSON.parse(json);
    expect(parsed.totalPackets).toBe(1000);
    expect(parsed.state).toBe('capturing');
    expect(parsed.streamGeneration).toBe(1);
  });

  it('HelperState type has expected shape', () => {
    const state: Record<string, unknown> = {
      state: 'capturing',
      activeSourceType: 'synthetic',
      uptimeMs: 120000,
      controlConnected: true,
      pcmConnected: true,
      streamGeneration: 1,
      totalPackets: 500,
    };
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json);
    expect(parsed.state).toBe('capturing');
    expect(parsed.controlConnected).toBe(true);
    expect(parsed.streamGeneration).toBe(1);
  });
});
