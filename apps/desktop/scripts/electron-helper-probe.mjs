#!/usr/bin/env node
/**
 * Minimal Electron probe for the native audio helper.
 * No React, Vite, renderer, or BrowserWindow.
 *
 * Usage: npx electron apps/desktop/scripts/electron-helper-probe.mjs
 *
 * Logs every step to both console and apps/desktop/electron-probe.log
 */

import { spawn, execSync } from 'child_process';
import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.resolve(__dirname, '..', 'electron-probe.log');
const HELPER = path.resolve(__dirname, '..', '..', '..', 'native', 'audio-helper', 'build', 'Release', 'screenlink-audio-helper.exe');

function log(msg) {
  const line = `${Date.now()} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

function sha256(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256');
    hash.update(buf);
    return hash.digest('hex');
  } catch { return 'error'; }
}

async function main() {
  log('=== ELECTRON HELPER PROBE ===');
  log(`Node  : ${process.version}`);
  log(`Electron: ${process.versions?.electron || '??'}`);
  log(`execPath: ${process.execPath}`);
  log(`helper : ${HELPER}`);

  // Verify helper binary
  try {
    const stat = fs.statSync(HELPER);
    log(`helper exists: size=${stat.size} mtime=${stat.mtime.toISOString()}`);
    log(`helper sha256: ${sha256(HELPER)}`);
  } catch (e) {
    log(`HELPER NOT FOUND: ${e.message}`);
    process.exit(1);
  }

  // helper --version
  log('--- helper --version ---');
  const verOut = execSync(`"${HELPER}" --version`, { encoding: 'utf-8', timeout: 5000 });
  log(`version output: ${verOut.trim()}`);
  log(`serviceProtocolVersion check: ${verOut.includes('0.3.0') ? 'PASS (0.3.0)' : 'FAIL'}`);

  // Generate session
  const sessionId = crypto.randomBytes(16).toString('hex');
  const authToken = crypto.randomBytes(16).toString('hex');
  const ctrlPipe = `\\\\.\\pipe\\probe-${sessionId}-ctrl`;
  const pcmPipe = `\\\\.\\pipe\\probe-${sessionId}-pcm`;

  log(`sessionId: ${sessionId}`);
  log(`ctrlPipe : ${ctrlPipe}`);
  log(`pcmPipe  : ${pcmPipe}`);

  // Spawn helper
  log('--- spawning helper ---');
  const helper = spawn(HELPER, [
    '--serve', '--control-pipe', ctrlPipe, '--pcm-pipe', pcmPipe,
    '--session-id', sessionId, '--auth-token', authToken, '--parent-pid', String(process.pid),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  log(`helper PID: ${helper.pid}`);

  let helperExit = null;
  let helperStderr = '';
  helper.on('exit', (code, sig) => { helperExit = { code, sig }; log(`helper EXIT code=${code} sig=${sig}`); });
  helper.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) log(`helper STDERR: ${s.slice(0, 200)}`); });

  // Wait briefly
  await new Promise(r => setTimeout(r, 1500));

  if (helperExit !== null) {
    log(`HELPER EXITED BEFORE CONNECT — aborting`);
    process.exit(1);
  }

  // Connect control pipe via net.Socket
  log('--- connecting control pipe ---');
  const socket = new net.Socket();
  let socketData = '';
  let dataReceived = false;

  socket.on('data', (chunk) => {
    dataReceived = true;
    const text = chunk.toString('utf8');
    socketData += text;
    log(`socket DATA len=${chunk.length} escaped=${text.replace(/\r/g,'\\r').replace(/\n/g,'\\n').slice(0,300)}`);
  });

  socket.on('error', (err) => { log(`socket ERROR: ${err.message}`); });
  socket.on('close', () => { log('socket CLOSE'); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { log('socket CONNECT TIMEOUT'); reject(new Error('timeout')); }, 5000);
    socket.connect(ctrlPipe, () => {
      clearTimeout(timer);
      log('socket CONNECTED');
      resolve();
    });
    socket.once('error', reject);
  }).catch(err => {
    log(`CONNECT FAILED: ${err.message}`);
    helper.kill();
    process.exit(1);
  });

  // Send hello
  log('--- sending hello ---');
  const req = JSON.stringify({
    protocolVersion: '0.3.0', requestId: 1,
    sessionId, authToken, command: 'hello', payload: {},
  }) + '\n';

  log(`write len=${req.length} content=${req.replace(/\n/g,'\\n').trim().slice(0,150)}`);

  await new Promise((resolve, reject) => {
    socket.write(req, (err) => {
      if (err) { log(`WRITE ERROR: ${err.message}`); reject(err); }
      else { log('WRITE CALLBACK OK'); resolve(); }
    });
  });

  // Wait for response or timeout
  log('--- waiting for response ---');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Report
  log('--- result ---');
  log(`dataReceived: ${dataReceived}`);
  log(`socketData length: ${socketData.length}`);
  log(`socketData: ${socketData.replace(/\r/g,'\\r').replace(/\n/g,'\\n').slice(0,500)}`);

  if (socketData.includes('"success"')) {
    log('PASS: Valid JSON response received');
  } else {
    log('FAIL: No valid JSON response');
  }

  // Cleanup
  log('--- cleanup ---');
  socket.destroy();
  helper.kill();
  await new Promise(r => setTimeout(r, 500));
  log(`helper exit after kill: ${helperExit === null ? 'expected' : `code=${helperExit.code}`}`);
  log('=== PROBE COMPLETE ===');
  process.exit(socketData.includes('"success"') ? 0 : 1);
}

main().catch(err => {
  log(`UNHANDLED ERROR: ${err.message}`);
  process.exit(1);
});
