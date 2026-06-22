// ── ScreenLink Audio Transport Stability Test ─────────────────────────────────
//
// Runs the real screenlink-audio-helper.exe in --serve mode for 30 minutes,
// continuously reading PCM packets from the named pipe, verifying header
// integrity, monotonic sequence numbers, and tracking error counts.
//
// Usage:
//   node apps/desktop/scripts/transport-stability.mjs
//
// Exit codes:
//   0  — All checks passed
//   1  — One or more checks failed

import { spawn } from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────────

const HELPER_PATH = path.resolve(
  __dirname, '..', '..', '..',
  'native', 'audio-helper', 'build', 'Release',
  'screenlink-audio-helper.exe',
);

const RUN_MINUTES = Math.max(0.1, parseFloat(process.argv[2] || '30'));
const RUN_DURATION_MS = Math.round(RUN_MINUTES * 60 * 1000);
const REPORT_INTERVAL_MS = Math.min(Math.max(Math.round(RUN_DURATION_MS / 4), 5000), 60000);
const PCM_STALL_TIMEOUT = 5000;
const PCM_MAGIC = 0x50434D21;
const HEADER_SIZE = 68;
const PCM_READ_TIMEOUT_MS = 3000;

// ── Stats ─────────────────────────────────────────────────────────────────────

let totalPackets = 0;
let totalBytes = 0;
let totalSilent = 0;
let totalDiscontinuity = 0;
let totalTimestampError = 0;
let totalMalformed = 0;
let totalGaps = 0;
let maxQueue = 0;
let lastSeq = -1;
let startMemory = 0;
let peakMemory = 0;
let lastReportPackets = 0;

// ── Process State ─────────────────────────────────────────────────────────────

let helper;
let ctrlFd;
let pcmSocket;
let streamGen = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  const time = new Date().toISOString().slice(11, 23);
  console.log(`[${time}] ${msg}`);
}

function helperExists() {
  try {
    fs.accessSync(HELPER_PATH);
    return true;
  } catch {
    return false;
  }
}

async function openControlPipe(pipePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return fs.openSync(pipePath, 'r+');
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Timeout waiting for control pipe: ${pipePath}`);
}

async function openPcmPipe(pipePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timeout connecting to PCM pipe: ${pipePath}`));
      }
      try {
        const socket = net.connect(pipePath, () => {
          resolve(socket);
        });
        socket.once('error', () => {
          socket.destroy();
          setTimeout(tryConnect, 200);
        });
      } catch {
        setTimeout(tryConnect, 200);
      }
    };
    tryConnect();
  });
}

function sendRequest(fd, request) {
  fs.writeSync(fd, JSON.stringify(request) + '\n');
  const buf = Buffer.alloc(65536);
  const bytes = fs.readSync(fd, buf, 0, buf.length, null);
  const resp = JSON.parse(buf.toString('utf-8', 0, bytes));
  // The SimpleJson helper encodes 'result' as a JSON string, not a nested object.
  // If result is a string, parse it as JSON.
  if (typeof resp.result === 'string') {
    try { resp.result = JSON.parse(resp.result); } catch {}
  }
  return resp;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!helperExists()) {
    console.error(`Helper binary not found: ${HELPER_PATH}`);
    console.error('Build the helper first: pnpm audio-helper:build');
    process.exit(1);
  }

  const sessionId = crypto.randomBytes(16).toString('hex');
  const authToken = crypto.randomBytes(16).toString('hex');
  const ctrlPipe = `\\\\.\\pipe\\screenlink-${sessionId}-ctrl`;
  const pcmPipe = `\\\\.\\pipe\\screenlink-${sessionId}-pcm`;

  let helperExited = false;
  let helperExitCode = null;
  let requestId = 1;

  log('='.repeat(60));
  log('SCREENLINK AUDIO TRANSPORT STABILITY TEST');
  log('='.repeat(60));
  log(`Session: ${sessionId}`);
  log(`Helper: ${HELPER_PATH}`);
  log(`Duration: ${RUN_DURATION_MS / 60000} minutes`);

  // 1. Start helper
  log('Starting helper...');
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

  helper.on('exit', (code) => {
    helperExited = true;
    helperExitCode = code;
    log(`Helper exited with code ${code}`);
  });

  helper.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) log(`[helper stderr] ${msg}`);
  });

  // 2. Connect control pipe
  log('Connecting control pipe...');
  ctrlFd = await openControlPipe(ctrlPipe, 5000);
  log('Control pipe connected');

  // 3. Send hello
  log('Sending hello...');
  const helloResp = sendRequest(ctrlFd, {
    protocolVersion: '0.2.0', requestId: requestId++, sessionId, authToken,
    command: 'hello', payload: {},
  });
  if (!helloResp.success) throw new Error(`Hello failed: ${helloResp.error}`);
  log(`Handshake complete (protocol: ${helloResp.protocolVersion})`);

  // 4. Get initial diagnostics for baseline
  const initDiag = sendRequest(ctrlFd, {
    protocolVersion: '0.2.0', requestId: requestId++, sessionId, authToken,
    command: 'getDiagnostics', payload: {},
  });
  log(`Initial diagnostics: totalControlRequests=${initDiag.result?.totalControlRequests ?? '?'}`);

  // 5. Connect PCM pipe FIRST (before startSynthetic)
  // The C++ helper waits up to 1s for PCM client before starting capture.
  // Connect PCM first so startSynthetic proceeds immediately.
  log('Connecting PCM pipe...');
  pcmSocket = await openPcmPipe(pcmPipe, 10000);
  pcmSocket.setNoDelay(true);
  log('PCM pipe connected');

  // 6. Start synthetic capture (mode 0 = continuous tone, unlimited packets)
  log('Starting synthetic capture (continuous tone)...');
  const startResp = sendRequest(ctrlFd, {
    protocolVersion: '0.2.0', requestId: requestId++, sessionId, authToken,
    command: 'startSynthetic', payload: { mode: 0, totalPackets: 0 },
  });
  if (!startResp.success) throw new Error(`startSynthetic failed: ${startResp.error}`);
  streamGen = startResp.result.streamGeneration;
  log(`Synthetic capture started, stream generation: ${streamGen}`);

  // 7. Read packets for the duration
  let parserBuffer = Buffer.alloc(0);
  let pcmDataResolve = null;
  const testStart = Date.now();
  const testDuration = RUN_DURATION_MS;
  let lastReadTime = Date.now();
  const PCM_STALL_TIMEOUT = 5000; // Consider connection stalled if no data for 5s

  log(`Reading PCM for ${RUN_MINUTES} minutes...`);
  log('='.repeat(60));

  // Set up async data handler
  pcmSocket.on('data', (chunk) => {
    lastReadTime = Date.now();
    parserBuffer = Buffer.concat([parserBuffer, chunk]);

    if (parserBuffer.length > 1_048_576) {
      log('WARN: Parser buffer exceeded 1MB — resetting');
      parserBuffer = Buffer.alloc(0);
      totalMalformed++;
      return;
    }

    // Parse packets
    while (parserBuffer.length >= HEADER_SIZE) {
      const magic = parserBuffer.readUInt32LE(0);
      if (magic !== PCM_MAGIC) {
        let found = false;
        for (let i = 1; i < parserBuffer.length - 3; i++) {
          if (parserBuffer.readUInt32LE(i) === PCM_MAGIC) {
            parserBuffer = parserBuffer.subarray(i);
            found = true;
            totalMalformed++;
            break;
          }
        }
        if (!found) { parserBuffer = Buffer.alloc(0); break; }
        continue;
      }

      const headerSize = parserBuffer.readUInt16LE(4);
      if (headerSize < HEADER_SIZE) { parserBuffer = parserBuffer.subarray(1); totalMalformed++; continue; }
      if (parserBuffer.length < headerSize) break;

      const frameCount = parserBuffer.readUInt32LE(52);
      const channels = parserBuffer.readUInt16LE(48);
      const payloadBytes = parserBuffer.readUInt32LE(56);
      const expectedPayload = frameCount * channels * 4;

      if (payloadBytes !== expectedPayload || payloadBytes > 7680) {
        parserBuffer = parserBuffer.subarray(1);
        totalMalformed++;
        continue;
      }

      if (parserBuffer.length < headerSize + payloadBytes) break;

      const flags = parserBuffer.readUInt32LE(8);
      const seq = Number(parserBuffer.readBigUInt64LE(12));
      const streamGeneration = parserBuffer.readUInt32LE(60);

      totalPackets++;
      totalBytes += headerSize + payloadBytes;

      if (flags & 1) totalSilent++;
      if (flags & 2) totalDiscontinuity++;
      if (flags & 4) totalTimestampError++;

      if (lastSeq >= 0 && seq !== lastSeq + 1) {
        totalGaps++;
        if (totalGaps <= 5) {
          log(`WARN: Sequence gap at packet ${totalPackets}: expected ${lastSeq + 1}, got ${seq}`);
        }
      }
      lastSeq = seq;

      if (streamGeneration !== streamGen) {
        log(`ERROR: Stream generation mismatch: expected ${streamGen}, got ${streamGeneration}`);
      }

      parserBuffer = parserBuffer.subarray(headerSize + payloadBytes);
    }

    if (pcmDataResolve) {
      pcmDataResolve();
      pcmDataResolve = null;
    }
  });

  pcmSocket.on('close', () => {
    log('PCM pipe closed');
  });

  pcmSocket.on('error', (err) => {
    if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
      log(`PCM socket error: ${err.code} - ${err.message}`);
    }
  });

  // Periodic reporting
  const reportInterval = setInterval(() => {
    const elapsed = Date.now() - testStart;
    if (elapsed < 1000) return;
    const rate = totalPackets / (elapsed / 1000);
    const pct = Math.min(100, (elapsed / testDuration) * 100).toFixed(1);
    const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

    log(`[${pct}%] Packets: ${totalPackets} (${rate.toFixed(0)}/s), ` +
        `Bytes: ${(totalBytes / 1024 / 1024).toFixed(2)}MB, ` +
        `Gaps: ${totalGaps}, Malformed: ${totalMalformed}, ` +
        `Queue: ${maxQueue}, Mem: ${memMb}MB`);

    if (ctrlFd) {
      try {
        const diagResp = sendRequest(ctrlFd, {
          protocolVersion: '0.2.0', requestId: requestId++, sessionId, authToken,
          command: 'getDiagnostics', payload: {},
        });
        if (diagResp.success && diagResp.result) {
          const qs = diagResp.result.queueSize || 0;
          const dp = diagResp.result.droppedPackets || 0;
          maxQueue = Math.max(maxQueue, qs);
          if (qs > 64) log(`WARN: Queue depth high: ${qs}`);
          if (dp > 0) log(`WARN: Dropped packets: ${dp}`);
        }
      } catch (e) {
        log(`Diagnostics request failed: ${e.message}`);
      }
    }
  }, REPORT_INTERVAL_MS);

  // Wait for test duration with periodic checks
  while (Date.now() - testStart < testDuration) {
    const remaining = testDuration - (Date.now() - testStart);
    if (remaining <= 0) break;
    
    // Wait for data or timeout
    await new Promise(resolve => {
      pcmDataResolve = resolve;
      setTimeout(resolve, 100);
    });

    // Check stall detection
    if (Date.now() - lastReadTime > PCM_STALL_TIMEOUT && totalPackets > 0) {
      log(`WARN: PCM data stalled for ${PCM_STALL_TIMEOUT}ms`);
      lastReadTime = Date.now(); // Reset to avoid repeated warnings
    }
  }

  clearInterval(reportInterval);

  // 8. Stop capture
  log('Stopping capture...');
  try {
    sendRequest(ctrlFd, {
      protocolVersion: '0.2.0', requestId: requestId++, sessionId, authToken,
      command: 'stopCapture', payload: {},
    });
  } catch (e) {
    log(`stopCapture failed: ${e.message}`);
  }

  // 9. Get final diagnostics
  log('Getting final diagnostics...');
  try {
    const finalDiag = sendRequest(ctrlFd, {
      protocolVersion: '0.2.0', requestId: requestId++, sessionId, authToken,
      command: 'getDiagnostics', payload: {},
    });
    log(`Final diagnostics: ${JSON.stringify(finalDiag.result, null, 2)}`);
  } catch (e) {
    log(`Final diagnostics failed: ${e.message}`);
  }

  // 10. Shutdown
  log('Shutting down helper...');
  try {
    sendRequest(ctrlFd, {
      protocolVersion: '0.2.0', requestId: requestId++, sessionId, authToken,
      command: 'shutdown', payload: {},
    });
  } catch (e) {
    log(`Shutdown request failed: ${e.message}`);
  }

  // 11. Cleanup
  log('Cleaning up...');
  try { fs.closeSync(ctrlFd); } catch {}
  try { pcmSocket.destroy(); } catch {}
  try { pcmSocket = null; } catch {}
  // Note: pcmSocket is already closed via the 'close' handler

  // Wait for helper to exit
  await new Promise(r => setTimeout(r, 2000));

  if (helper && !helper.killed) {
    try { helper.kill(); } catch {}
  }

  // 12. Report
  const elapsed = (Date.now() - testStart) / 1000;
  const rate = elapsed > 0 ? (totalPackets / elapsed).toFixed(1) : '0.0';
  const expectedPackets = Math.floor(elapsed / 0.01); // 10ms packets

  log('');
  log('='.repeat(60));
  log('STABILITY TEST RESULTS');
  log('='.repeat(60));
  log(`Duration: ${(elapsed / 60).toFixed(1)} minutes`);
  log(`Total packets: ${totalPackets}`);
  log(`Packet rate: ${rate} packets/s`);
  log(`Expected packets (approx): ${expectedPackets}`);
  log(`Total bytes: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  log(`Sequence gaps: ${totalGaps}`);
  log(`Malformed packets: ${totalMalformed}`);
  log(`Silent packets: ${totalSilent}`);
  log(`Discontinuity packets: ${totalDiscontinuity}`);
  log(`Timestamp error packets: ${totalTimestampError}`);
  log(`Peak queue depth: ${maxQueue}`);
  log(`Helper exited: ${helperExited}`);
  log(`Helper exit code: ${helperExitCode}`);
  log(`Packet loss rate: ${totalGaps > 0 ? ((totalGaps / Math.max(totalPackets, 1)) * 100).toFixed(4) : '0.0000'}%`);

  // Validate results
  let failed = false;

  if (totalMalformed > 0) {
    console.error(`ERROR: ${totalMalformed} malformed packets detected`);
    failed = true;
  }

  if (helperExited && helperExitCode !== 0) {
    console.error(`ERROR: Helper exited with code ${helperExitCode}`);
    failed = true;
  }

  if (totalPackets === 0) {
    console.error('ERROR: No packets received');
    failed = true;
  }

  if (totalGaps > totalPackets * 0.01) {
    // More than 1% gap rate is concerning
    console.error(`ERROR: Gap rate ${(totalGaps / totalPackets * 100).toFixed(2)}% exceeds 1% threshold`);
    failed = true;
  }

  if (failed) {
    console.error('\nStability test FAILED');
    process.exit(1);
  }

  log('\nStability test PASSED');
}

main().catch(err => {
  console.error('\nStability test FAILED:', err.message);
  // Cleanup
  try { if (ctrlFd) fs.closeSync(ctrlFd); } catch {}
  try { if (pcmSocket) pcmSocket.destroy(); } catch {}
  if (helper && !helper.killed) {
    try { helper.kill(); } catch {}
  }
  process.exit(1);
});
