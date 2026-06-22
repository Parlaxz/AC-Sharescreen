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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────────

const HELPER_PATH = path.resolve(
  __dirname, '..', '..', '..',
  'native', 'audio-helper', 'build', 'Release',
  'screenlink-audio-helper.exe',
);

const RUN_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const REPORT_INTERVAL_MS = 60 * 1000;   // Report every 60 seconds
const PCM_READ_TIMEOUT_MS = 3000;       // Read timeout before declaring end of stream
const PCM_MAGIC = 0x50434D21;
const HEADER_SIZE = 68;

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
let pcmFd;
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

async function waitForPipe(pipePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return fs.openSync(pipePath, 'r+');
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Timeout waiting for pipe: ${pipePath}`);
}

function sendRequest(fd, request) {
  fs.writeSync(fd, JSON.stringify(request) + '\n');
  const buf = Buffer.alloc(65536);
  const bytes = fs.readSync(fd, buf, 0, buf.length, null);
  return JSON.parse(buf.toString('utf-8', 0, bytes));
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
  ctrlFd = await waitForPipe(ctrlPipe, 5000);
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

  // 5. Start synthetic capture (mode 0 = continuous tone, unlimited packets)
  log('Starting synthetic capture (continuous tone)...');
  const startResp = sendRequest(ctrlFd, {
    protocolVersion: '0.2.0', requestId: requestId++, sessionId, authToken,
    command: 'startSynthetic', payload: { mode: 0, totalPackets: 0 },
  });
  if (!startResp.success) throw new Error(`startSynthetic failed: ${startResp.error}`);
  streamGen = startResp.result.streamGeneration;
  log(`Synthetic capture started, stream generation: ${streamGen}`);

  // 6. Connect PCM pipe
  log('Connecting PCM pipe...');
  pcmFd = await waitForPipe(pcmPipe, 5000);
  log('PCM pipe connected');

  // 7. Read packets for the duration
  const readBuf = Buffer.alloc(65536);
  let parserBuffer = Buffer.alloc(0);
  const testStart = Date.now();
  let lastReadTime = Date.now();
  let readStalls = 0;

  log(`Reading PCM for ${RUN_DURATION_MS / 60000} minutes...`);
  log('='.repeat(60));

  const pcmReadLoop = async () => {
    while (Date.now() - testStart < RUN_DURATION_MS && !helperExited) {
      try {
        // Check if pipe is still readable (non-blocking check)
        const bytesRead = fs.readSync(pcmFd, readBuf, 0, readBuf.length, null);
        if (bytesRead === 0) {
          // Empty read (EOF)
          if (Date.now() - lastReadTime > PCM_READ_TIMEOUT_MS) {
            log('PCM pipe EOF — no data for timeout period');
            break;
          }
          continue;
        }

        lastReadTime = Date.now();

        // Feed into parser buffer
        parserBuffer = Buffer.concat([parserBuffer, readBuf.subarray(0, bytesRead)]);

        // Guard against unbounded buffer growth
        if (parserBuffer.length > 1_048_576) {
          log('WARN: Parser buffer exceeded 1MB — resetting');
          parserBuffer = Buffer.alloc(0);
          totalMalformed++;
          continue;
        }

        // Parse packets from buffer
        while (parserBuffer.length >= HEADER_SIZE) {
          const magic = parserBuffer.readUInt32LE(0);
          if (magic !== PCM_MAGIC) {
            // Scan forward for magic
            let found = false;
            for (let i = 1; i < parserBuffer.length - 3; i++) {
              if (parserBuffer.readUInt32LE(i) === PCM_MAGIC) {
                parserBuffer = parserBuffer.subarray(i);
                found = true;
                totalMalformed++;
                break;
              }
            }
            if (!found) {
              parserBuffer = Buffer.alloc(0);
              break;
            }
            continue;
          }

          // Read header size
          const headerSize = parserBuffer.readUInt16LE(4);
          if (headerSize < HEADER_SIZE) {
            parserBuffer = parserBuffer.subarray(1);
            totalMalformed++;
            continue;
          }

          if (parserBuffer.length < headerSize) break; // Need more data

          const frameCount = parserBuffer.readUInt32LE(52);
          const channels = parserBuffer.readUInt16LE(48);
          const payloadBytes = parserBuffer.readUInt32LE(56);
          const expectedPayload = frameCount * channels * 4;

          if (payloadBytes !== expectedPayload || payloadBytes > 7680) {
            parserBuffer = parserBuffer.subarray(1);
            totalMalformed++;
            continue;
          }

          if (parserBuffer.length < headerSize + payloadBytes) break; // Need more data

          // Valid packet — extract header fields
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

          // Check stream generation
          if (streamGeneration !== streamGen) {
            log(`ERROR: Stream generation mismatch: expected ${streamGen}, got ${streamGeneration}`);
          }

          // Remove consumed bytes
          parserBuffer = parserBuffer.subarray(headerSize + payloadBytes);
        }
      } catch (err) {
        if (err.code === 'EOF' || err.code === 'EPIPE') {
          log('PCM pipe disconnected');
          break;
        }
        // Transient error — retry
        await new Promise(r => setTimeout(r, 100));
      }

      // Periodic reporting
      const elapsed = Date.now() - testStart;
      const reportElapsed = Date.now() - (testStart + Math.floor(elapsed / REPORT_INTERVAL_MS) * REPORT_INTERVAL_MS);
      if (reportElapsed >= REPORT_INTERVAL_MS || totalPackets === 0 || totalPackets % 10000 === 0) {
        // Only do full reports on the minute
      }
    }
  };

  // Periodic reporting loop (runs concurrently)
  const reportInterval = setInterval(() => {
    const elapsed = Date.now() - testStart;
    if (elapsed < 1000) return;
    const rate = totalPackets / (elapsed / 1000);
    const pct = Math.min(100, (elapsed / RUN_DURATION_MS) * 100).toFixed(1);
    const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

    log(`[${pct}%] Packets: ${totalPackets} (${rate.toFixed(0)}/s), ` +
        `Bytes: ${(totalBytes / 1024 / 1024).toFixed(2)}MB, ` +
        `Gaps: ${totalGaps}, Malformed: ${totalMalformed}, ` +
        `Queue: ${maxQueue}, Mem: ${memMb}MB`);

    // Get diagnostics from helper
    if (ctrlFd) {
      try {
        const diagResp = sendRequest(ctrlFd, {
          protocolVersion: '0.2.0', requestId: requestId++, sessionId, authToken,
          command: 'getDiagnostics', payload: {},
        });
        if (diagResp.success && diagResp.result) {
          maxQueue = Math.max(maxQueue, diagResp.result.queueSize || 0);
          const qs = diagResp.result.queueSize;
          const dp = diagResp.result.droppedPackets;
          if (qs > 64) log(`WARN: Queue depth high: ${qs}`);
          if (dp > 0) log(`WARN: Dropped packets: ${dp}`);
        }
      } catch (e) {
        log(`Diagnostics request failed: ${e.message}`);
      }
    }
  }, REPORT_INTERVAL_MS);

  // Run the PCM read loop
  await pcmReadLoop();

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
  try { fs.closeSync(pcmFd); } catch {}

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
  try { if (pcmFd) fs.closeSync(pcmFd); } catch {}
  if (helper && !helper.killed) {
    try { helper.kill(); } catch {}
  }
  process.exit(1);
});
