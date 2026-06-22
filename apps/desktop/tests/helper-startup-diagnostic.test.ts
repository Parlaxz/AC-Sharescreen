import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';

const HELPER_PATH = path.join(
  __dirname, '..', '..', '..',
  'native', 'audio-helper', 'build', 'Release',
  'screenlink-audio-helper.exe',
);

function helperExists(): boolean {
  try { fs.accessSync(HELPER_PATH); return true; } catch { return false; }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('helper startup diagnostic', () => {
  if (!helperExists()) { it('skipped', () => {}); return; }

  const sessionId = crypto.randomBytes(16).toString('hex');
  const authToken = crypto.randomBytes(16).toString('hex');
  const ctrlPipe = `\\\\.\\pipe\\diag-${sessionId}-ctrl`;
  const pcmPipe = `\\\\.\\pipe\\diag-${sessionId}-pcm`;

  let helper: any = null;
  let helperExit: number | null = null;

  beforeAll(() => {
    const { spawn } = require('child_process');
    helper = spawn(HELPER_PATH, [
      '--serve', '--control-pipe', ctrlPipe, '--pcm-pipe', pcmPipe,
      '--session-id', sessionId, '--auth-token', authToken,
      '--parent-pid', String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    helper.on('exit', (code: number) => { helperExit = code; });
  }, 10000);

  it('helper process is alive after spawn', async () => {
    await delay(1000);
    expect(helper.killed).toBe(false);
    expect(helperExit).toBeNull();
    expect(helper.pid).toBeGreaterThan(0);
  });

  it('control pipe connects via net.Socket (same as new ControlClient)', async () => {
    const start = Date.now();
    const maxWait = 5000;
    let socket: any = null;

    while (Date.now() - start < maxWait) {
      try {
        socket = await new Promise((resolve, reject) => {
          const s = net.connect(ctrlPipe, () => {
            s.removeListener('error', reject);
            resolve(s);
          });
          s.once('error', () => {
            s.destroy();
            reject(new Error('connect failed'));
          });
        });
        break;
      } catch {
        await delay(200);
      }
    }

    expect(socket).not.toBeNull();

    // Send hello
    const req = JSON.stringify({
      protocolVersion: '0.3.0', requestId: 1,
      sessionId, authToken, command: 'hello', payload: {},
    }) + '\n';

    console.log('[diag] Writing hello request...');
    socket.write(req);

    // Read response with timeout
    const response = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Response timeout')), 5000);
      let buf = '';
      socket.on('data', (data: Buffer) => {
        buf += data.toString();
        if (buf.includes('\n')) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      socket.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    });

    console.log('[diag] Got response:', response.trim().slice(0, 100));

    const parsed = JSON.parse(response.trim());
    expect(parsed.success).toBe(true);
    expect(parsed.state).toBe('idle');
    console.log('[diag] Hello succeeded, response state:', parsed.state);

    socket.destroy();
  });

  afterAll(async () => {
    if (helper && !helper.killed) helper.kill();
    await delay(500);
  });
});
