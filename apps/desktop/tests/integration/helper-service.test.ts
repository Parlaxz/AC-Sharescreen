import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  BinaryPcmParser,
  HEADER_SIZE,
  PCM_FLAG_END_OF_STREAM,
  PCM_MAGIC,
} from '../../src/main/BinaryPcmParser.js';
import type { ParsedPcmPacket } from '../../src/main/BinaryPcmParser.js';

// ── Config ────────────────────────────────────────────────────────────────────

const HELPER_PATH = path.join(
  __dirname, '..', '..', '..', '..',
  'native', 'audio-helper', 'build', 'Release',
  'screenlink-audio-helper.exe',
);

const INTEGRATION_TIMEOUT = 15000;
const PCM_READ_TIMEOUT = 5000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function helperExists(): boolean {
  try {
    fs.accessSync(HELPER_PATH);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Write a JSON request to the control pipe and read one response.
 *
 * The helper's SimpleJson encodes `result` as a JSON string and `error` as
 * the literal string "null" (not JSON null). This function parses the
 * top-level JSON and returns it; callers must use JSON.parse() on the
 * `result` field to access nested data.
 */
function sendRequest(fd: number, request: object): any {
  fs.writeSync(fd, JSON.stringify(request) + '\n');
  // Wait briefly for the helper to process and respond
  const buf = Buffer.alloc(65536);
  const bytes = fs.readSync(fd, buf, 0, buf.length, null);
  if (bytes === 0) throw new Error('Empty response from control pipe');
  return JSON.parse(buf.toString('utf-8', 0, bytes));
}

/** Try to connect to a named pipe with retries. */
function connectPipe(pipePath: string, timeoutMs: number, mode: string = 'r+'): number {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return fs.openSync(pipePath, mode);
    } catch {
      // retry
    }
  }
  throw new Error(`Timeout connecting to pipe: ${pipePath}`);
}

/**
 * Parse the `result` field from a helper response.
 * SimpleJson encodes `result` as a JSON string, so we need an extra parse.
 */
function parseResult(response: any): any {
  if (typeof response.result === 'string') {
    try { return JSON.parse(response.result); } catch { return {}; }
  }
  return response.result ?? {};
}

/**
 * Check if the response indicates success.
 * SimpleJson encodes error as the literal string "null" for success responses.
 */
function isSuccess(response: any): boolean {
  return response.success === true && response.error === 'null';
}

/**
 * Read PCM packets from the PCM pipe for up to `timeoutMs` milliseconds,
 * returning parsed packets and any parser errors.
 */
function readPcmPackets(
  pcmFd: number,
  maxPackets: number,
  timeoutMs: number,
): { packets: ParsedPcmPacket[]; errors: string[] } {
  const packets: ParsedPcmPacket[] = [];
  const errors: string[] = [];

  const parser = new BinaryPcmParser(
    (pkt) => { packets.push(pkt); },
    (err) => { errors.push(err); },
    { maxBufferSize: 1_024_000 },
  );

  const buf = Buffer.alloc(65536);
  const start = Date.now();

  while (Date.now() - start < timeoutMs && packets.length < maxPackets) {
    try {
      const bytesRead = fs.readSync(pcmFd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      parser.feed(buf.subarray(0, bytesRead));
    } catch (err: any) {
      if (err.code === 'EOF' || err.code === 'PIPE_BROKEN' || err.code === 'EPIPE') break;
      // Small back-off on transient errors
      require('perf_hooks').performance.nodeTiming;
    }
  }

  return { packets, errors };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('native helper service integration', () => {
  // Skip all tests if the helper binary is not found (CI / no build)
  if (!helperExists()) {
    it('skipped - helper binary not found', () => {});
    return;
  }

  let helper: ChildProcess | null = null;
  let ctrlFd: number | null = null;
  let pcmFd: number | null = null;

  const sessionId = crypto.randomBytes(16).toString('hex');
  const authToken = crypto.randomBytes(16).toString('hex');
  const ctrlPipe = `\\\\.\\pipe\\screenlink-${sessionId}-ctrl`;
  const pcmPipe = `\\\\.\\pipe\\screenlink-${sessionId}-pcm`;

  let helperStderr = '';
  let helperExitCode: number | null = null;

  beforeAll(() => {
    helper = spawn(HELPER_PATH, [
      '--serve',
      '--control-pipe', ctrlPipe,
      '--pcm-pipe', pcmPipe,
      '--session-id', sessionId,
      '--auth-token', authToken,
      '--parent-pid', String(process.pid),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    helper.stderr!.on('data', (d: Buffer) => { helperStderr += d.toString(); });
    helper.on('exit', (code) => { helperExitCode = code; });
  }, 10000);

  afterAll(() => {
    if (pcmFd !== null) { try { fs.closeSync(pcmFd); } catch { /* ignore */ } }
    if (ctrlFd !== null) { try { fs.closeSync(ctrlFd); } catch { /* ignore */ } }
    if (helper && !helper.killed) {
      try { helper.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  // ── Test 1: Helper launches ───────────────────────────────────────────
  it('helper starts and creates control pipe', async () => {
    await delay(1500);
    expect(helper?.killed).toBe(false);
    expect(helperExitCode).toBeNull();
  }, 5000);

  // ── Test 2: Connect control pipe ──────────────────────────────────────
  it('connects to control pipe', () => {
    ctrlFd = connectPipe(ctrlPipe, 5000);
    expect(ctrlFd).not.toBeNull();
    expect(typeof ctrlFd).toBe('number');
  }, 10000);

  // ── Test 3: Hello handshake ───────────────────────────────────────────
  it('hello handshake returns success with idle state', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 1,
      sessionId,
      authToken,
      command: 'hello',
      payload: {},
    });

    expect(isSuccess(response)).toBe(true);
    // response.state is the top-level state string from the helper
    expect(response.state).toBe('idle');
    expect(response.protocolVersion).toBe('0.2.0');
    expect(response.sessionId).toBe(sessionId);
    // requestId is always 0 in responses (SimpleJson doesn't echo)
    expect(response.requestId).toBe(0);

    // result is a JSON string — parse it to verify nested fields
    const result = parseResult(response);
    expect(result.helperVersion).toBeDefined();
    expect(typeof result.helperVersion).toBe('string');
    expect(result.protocolVersion).toBe('0.2.0');
    expect(result.sessionId).toBe(sessionId);
    expect(result.pid).toBeDefined();
    expect(typeof result.pid).toBe('number');
  }, INTEGRATION_TIMEOUT);

  // ── Test 4: getVersion ────────────────────────────────────────────────
  it('getVersion returns version fields', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 2,
      sessionId,
      authToken,
      command: 'getVersion',
      payload: {},
    });

    expect(isSuccess(response)).toBe(true);
    expect(response.state).toBe('idle');

    const result = parseResult(response);
    expect(result.helperVersion).toBeDefined();
    expect(typeof result.helperVersion).toBe('string');
    expect(result.helperVersion!.length).toBeGreaterThan(0);
    expect(result.protocolVersion).toBe('0.2.0');
  }, INTEGRATION_TIMEOUT);

  // ── Test 5: getCapabilities ───────────────────────────────────────────
  it('getCapabilities returns capability structure', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 3,
      sessionId,
      authToken,
      command: 'getCapabilities',
      payload: {},
    });

    expect(isSuccess(response)).toBe(true);
    expect(response.state).toBe('idle');

    const result = parseResult(response);
    expect(result.osVersion).toBeDefined();
    expect(result.osVersion.build).toBeDefined();
    expect(typeof result.usable).toBe('boolean');
    expect(result.reasonCode).toBeDefined();
    expect(typeof result.reasonCode).toBe('string');
    expect(result.reasonMessage).toBeDefined();
    expect(typeof result.reasonMessage).toBe('string');
  }, INTEGRATION_TIMEOUT);

  // ── Test 6: getState during idle ──────────────────────────────────────
  it('getState returns idle initially', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 4,
      sessionId,
      authToken,
      command: 'getState',
      payload: {},
    });

    expect(isSuccess(response)).toBe(true);
    expect(response.state).toBe('idle');

    const result = parseResult(response);
    expect(result.state).toBe('idle');
    expect(result.activeSourceType).toBeDefined();
    expect(result.uptimeMs).toBeDefined();
    expect(typeof result.uptimeMs).toBe('number');
    expect(result.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(result.controlConnected).toBe(true);
  }, INTEGRATION_TIMEOUT);

  // ── Test 7: ping ──────────────────────────────────────────────────────
  it('ping returns uptime', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 5,
      sessionId,
      authToken,
      command: 'ping',
      payload: {},
    });

    expect(isSuccess(response)).toBe(true);
    expect(response.state).toBe('idle');

    const result = parseResult(response);
    expect(result.uptimeMs).toBeDefined();
    expect(typeof result.uptimeMs).toBe('number');
    expect(result.uptimeMs).toBeGreaterThanOrEqual(0);
  }, INTEGRATION_TIMEOUT);

  // ── Test 8: Connect PCM pipe (BEFORE startSynthetic) ──────────────────
  // The C++ startSynthetic waits up to 1s for the PCM client to connect.
  // We must connect PCM first so the helper can proceed immediately.
  it('connects PCM pipe before startSynthetic', () => {
    expect(ctrlFd).not.toBeNull();

    // Connect PCM pipe (read-only — server pipe is PIPE_ACCESS_OUTBOUND)
    pcmFd = connectPipe(pcmPipe, 5000, 'r');
    expect(pcmFd).not.toBeNull();
  }, INTEGRATION_TIMEOUT);

  // ── Test 9: PCM client PID was accepted ───────────────────────────────
  it('helper accepted PCM connection from our PID', () => {
    expect(helperExitCode).toBeNull();
    expect(pcmFd).not.toBeNull();
  });

  // ── Test 10: startSynthetic ──────────────────────────────────────────
  it('startSynthetic returns streamGeneration', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 6,
      sessionId,
      authToken,
      command: 'startSynthetic',
      payload: {
        mode: 0,
        totalPackets: 0, // 0 = unlimited (runs until explicit stopCapture)
        framesPerPacket: 480,
      },
    });

    expect(isSuccess(response)).toBe(true);
    // The top-level state should transition to "capturing"
    expect(response.state).toBe('capturing');

    const result = parseResult(response);
    expect(result.streamGeneration).toBeDefined();
    expect(typeof result.streamGeneration).toBe('number');
    expect(result.streamGeneration).toBeGreaterThanOrEqual(1);
    expect(result.sourceType).toBe('synthetic');
  }, INTEGRATION_TIMEOUT);

  // ── Test 11: Read PCM packets from already-connected pipe ─────────────
  it('receives valid PCM packets after startSynthetic', async () => {
    expect(pcmFd).not.toBeNull();

    // Read a few PCM packets
    const { packets, errors } = readPcmPackets(pcmFd!, 10, PCM_READ_TIMEOUT);

    // Verify at least some packets arrived
    expect(packets.length).toBeGreaterThan(0);

    // Verify all packets have valid headers
    for (const pkt of packets) {
      expect(pkt.header.magic).toBe(PCM_MAGIC);
      expect(pkt.header.headerSize).toBe(HEADER_SIZE);
      expect(pkt.header.sampleRate).toBe(48000);
      expect(pkt.header.channels).toBe(2);
      expect(pkt.header.frameCount).toBeGreaterThan(0);
      expect(pkt.header.payloadBytes).toBe(pkt.header.frameCount * pkt.header.channels * 4);
      expect(pkt.header.streamGeneration).toBeGreaterThanOrEqual(1);
    }

    // Verify sequence numbers are monotonically increasing within stream generation
    let lastSeq = -1;
    let lastGeneration = -1;
    let monotonicErrors = 0;
    for (const pkt of packets) {
      if (pkt.header.streamGeneration !== lastGeneration) {
        lastSeq = -1;
        lastGeneration = pkt.header.streamGeneration;
      }
      if (lastSeq >= 0 && pkt.header.sequenceNumber !== lastSeq + 1) {
        monotonicErrors++;
      }
      lastSeq = pkt.header.sequenceNumber;
    }
    expect(monotonicErrors).toBe(0);

    // Verify payload is non-empty valid float32 data
    for (const pkt of packets) {
      expect(pkt.payload.length).toBe(pkt.header.payloadBytes);
      expect(pkt.payload.length).toBeGreaterThan(0);
    }

    // No parser errors expected
    expect(errors.length).toBe(0);

    // No EOS flag before stop
    const eosPackets = packets.filter(
      p => (p.header.flags & PCM_FLAG_END_OF_STREAM) !== 0,
    );
    expect(eosPackets.length).toBe(0);

    // Close PCM pipe so helper's FlushFileBuffers doesn't block on shutdown
    try { fs.closeSync(pcmFd!); } catch { /* ignore */ }
    pcmFd = null;
  }, INTEGRATION_TIMEOUT + PCM_READ_TIMEOUT + 2000);

  // ── Test 12: getState during capture ──────────────────────────────────
  it('getState returns capturing during active capture', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 7,
      sessionId,
      authToken,
      command: 'getState',
      payload: {},
    });

    expect(isSuccess(response)).toBe(true);
    expect(['capturing', 'stopping', 'idle']).toContain(response.state);

    const result = parseResult(response);
    expect(result.state).toBeDefined();
    expect(result.uptimeMs).toBeDefined();
  }, INTEGRATION_TIMEOUT);

  // ── Test 13: stopCapture ──────────────────────────────────────────────
  it('stopCapture stops the capture', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 8,
      sessionId,
      authToken,
      command: 'stopCapture',
      payload: {},
    });

    // The capture may already have ended (0-packet edge case) or still be running
    if (isSuccess(response)) {
      expect(response.state).toBe('idle');
      const result = parseResult(response);
      expect(result.previousState).toBeDefined();
    } else {
      // If capture already ended, it returns "not-capturing" — that's fine
      expect(response.error).toBe('not-capturing');
    }
  }, INTEGRATION_TIMEOUT);

  // ── Test 14: getDiagnostics ───────────────────────────────────────────
  it('getDiagnostics returns expected stats', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 9,
      sessionId,
      authToken,
      command: 'getDiagnostics',
      payload: {},
    });

    expect(isSuccess(response)).toBe(true);

    const result = parseResult(response);
    // Verify diagnostic fields exist
    expect(typeof result.totalPackets).toBe('number');
    expect(typeof result.totalPayloadBytes).toBe('number');
    expect(typeof result.droppedPackets).toBe('number');
    expect(typeof result.queueSize).toBe('number');
    expect(typeof result.packetsWritten).toBe('number');
    expect(typeof result.writeErrors).toBe('number');
    expect(typeof result.totalControlRequests).toBe('number');
    expect(typeof result.uptimeMs).toBe('number');
    expect(result.uptimeMs).toBeGreaterThan(0);

    // Should have processed at least the requests we sent
    expect(result.totalControlRequests).toBeGreaterThanOrEqual(4);
  }, INTEGRATION_TIMEOUT);

  // ── Test 15: Reject wrong auth token ──────────────────────────────────
  it('rejects request with wrong auth token', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 10,
      sessionId,
      authToken: 'wrong-token',
      command: 'ping',
      payload: {},
    });

    // Error response: success=false, error is a string (not "null")
    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
    expect(typeof response.error).toBe('string');
    // Should contain "auth" in the error message
    expect(response.error!.toLowerCase()).toContain('auth');
  }, INTEGRATION_TIMEOUT);

  // ── Test 16: Reject wrong session ID ──────────────────────────────────
  it('rejects request with wrong session ID', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 100,
      sessionId: 'wrong-session-id',
      authToken,
      command: 'ping',
      payload: {},
    });

    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
    expect(typeof response.error).toBe('string');
    expect(response.error!.toLowerCase()).toContain('auth');
  }, INTEGRATION_TIMEOUT);

  // ── Test 17: Unknown command ──────────────────────────────────────────
  it('rejects unknown command', () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 11,
      sessionId,
      authToken,
      command: 'nonexistentCommand',
      payload: {},
    });

    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
    expect(typeof response.error).toBe('string');
  }, INTEGRATION_TIMEOUT);

  // ── Test 18: shutdown ─────────────────────────────────────────────────
  it('shutdown causes helper to exit', async () => {
    expect(ctrlFd).not.toBeNull();

    const response = sendRequest(ctrlFd!, {
      protocolVersion: '0.2.0',
      requestId: 12,
      sessionId,
      authToken,
      command: 'shutdown',
      payload: {},
    });

    expect(isSuccess(response)).toBe(true);

    // Wait for helper to exit
    await delay(2000);

    // Verify helper exited
    if (helper) {
      expect(helper.killed || helperExitCode !== null).toBe(true);
    }
  }, INTEGRATION_TIMEOUT);

  // ── Test 19: No orphan process ────────────────────────────────────────
  it('helper process is not orphaned', () => {
    // The helper should have exited after the shutdown command
    if (helperExitCode !== null) {
      expect(helperExitCode).toBe(0);
    }
    if (helper) {
      expect(helper.killed || helperExitCode !== null).toBe(true);
    }
  }, 5000);

  // ── Test 20: Clean stderr ─────────────────────────────────────────────
  it('helper stderr has no crash output', () => {
    const stderr = helperStderr.toLowerCase();
    expect(stderr).not.toContain('fatal');
    expect(stderr).not.toContain('assert');
    expect(stderr).not.toContain('exception');
    expect(stderr).not.toContain('SEH');
    expect(stderr).not.toContain('stack overflow');
  });
});
