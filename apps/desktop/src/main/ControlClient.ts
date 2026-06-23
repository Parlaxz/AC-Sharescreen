import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ── Diagnostic trace file (2 levels up from dist/main/ → apps/desktop/) ──
const _ccDir = path.dirname(fileURLToPath(import.meta.url));
const CC_TRACE = path.join(_ccDir, '..', '..', 'control-trace.log');
let ccSeq = 0;
function ccTrace(msg: string): void {
  const seq = ++ccSeq;
  const ts = Date.now();
  try {
    fs.appendFileSync(CC_TRACE, `${ts} [CC#${seq}] ${msg}\n`);
  } catch { /* best effort */ }
}

// ── Types ──

export interface ControlRequest {
  protocolVersion: string;
  requestId: number;
  sessionId: string;
  authToken: string;
  command: string;
  payload: Record<string, unknown>;
}

export interface ControlResponse {
  protocolVersion: string;
  requestId: number;
  sessionId: string;
  success: boolean;
  state: string;
  result?: Record<string, unknown>;
  error?: string | null;
}

export interface HelperCapabilities {
  osVersion: { major: number; minor: number; build: number; revision: number };
  compiledWindowsSdkVersion: string;
  processLoopbackRuntimeSupported: boolean;
  usable: boolean;
  reasonCode: string;
  reasonMessage: string;
}

export interface HelperState {
  state: string;
  activeSourceType: string;
  uptimeMs: number;
  controlConnected: boolean;
  pcmConnected: boolean;
  streamGeneration: number;
  totalPackets: number;
}

export interface HelperDiagnostics {
  totalPackets: number;
  totalPayloadBytes: number;
  droppedPackets: number;
  queueSize: number;
  packetsWritten: number;
  writeErrors: number;
  totalControlRequests: number;
  failedControlRequests: number;
  uptimeMs: number;
  activeSourceType: string;
  state: string;
  streamGeneration: number;
}

// ── ControlClient ──

export class ControlClient {
  readonly id: string;
  private pipePath: string;
  private sessionId: string;
  private authToken: string;
  private requestId: number = 0;
  private socket: net.Socket | null = null;
  private connected: boolean = false;
  private buffer: string = '';
  private pendingRequests = new Map<
    number,
    { resolve: (resp: ControlResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  readonly REQUEST_TIMEOUT_MS = 5000;

  constructor(pipeName: string, sessionId: string, authToken: string) {
    this.pipePath = pipeName;
    this.sessionId = sessionId;
    this.authToken = authToken;
    this.id = `cc_${Math.random().toString(36).slice(2, 8)}`;
    ccTrace(`[${this.id}] CREATED pipe=${pipeName}`);
  }

  async connect(timeoutMs: number = 5000): Promise<void> {
    ccTrace(`[${this.id}] connect() entered`);

    return new Promise<void>((resolve, reject) => {
      const start = Date.now();
      let retryCount = 0;

      const tryConnect = () => {
        const elapsed = Date.now() - start;
        ccTrace(`[${this.id}] tryConnect #${++retryCount} elapsed=${elapsed}ms`);
        if (elapsed > timeoutMs) {
          ccTrace(`[${this.id}] CONNECT TIMEOUT after ${elapsed}ms`);
          reject(new Error(`Timeout connecting to control pipe: ${this.pipePath}`));
          return;
        }

        // 1. Create socket BEFORE calling connect (listen before connect per spec)
        const socket = new net.Socket();

        // 2. Attach listeners BEFORE connect
        socket.on('data', (data: Buffer) => {
          ccTrace(`[${this.id}] DATA len=${data.length} raw=${data.toString('utf8').replace(/\r/g,'\\r').replace(/\n/g,'\\n').slice(0,200)}`);
          this.buffer += data.toString('utf-8');
          this.processBuffer();
        });

        socket.on('close', () => {
          ccTrace(`[${this.id}] CLOSE`);
          if (this.socket === socket) {
            this.socket = null;
            this.connected = false;
          }
          for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Control pipe closed'));
          }
          this.pendingRequests.clear();
        });

        socket.on('error', (err: Error) => {
          ccTrace(`[${this.id}] ERROR ${err.message}`);
          // Don't reject here — close will fire after error
        });

        // 3. Connect
        ccTrace(`[${this.id}] net.connect...`);
        socket.connect(this.pipePath, () => {
          const connectedAt = Date.now() - start;
          ccTrace(`[${this.id}] CONNECTED at ${connectedAt}ms local=${socket.localAddress||''} remote=${socket.remoteAddress||''}`);
          this.socket = socket;
          this.connected = true;
          resolve();
        });

        // 4. Error during connection attempt (before connect fires)
        socket.once('error', (err: Error) => {
          if (!this.connected) {
            ccTrace(`[${this.id}] connect ERROR ${err.message} — will retry`);
            socket.destroy();
            setTimeout(tryConnect, 200);
          }
        });
      };

      tryConnect();
    });
  }

  private processBuffer(): void {
    if (this.buffer.length > 1048576) {
      ccTrace(`[${this.id}] BUFFER OVERFLOW 1MB, clearing`);
      this.buffer = '';
      return;
    }

    // Line-delimited JSON
    while (this.buffer.includes('\n')) {
      const nl = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      if (this.tryDispatchResponse(line)) continue;
    }

    // Also try raw accumulated buffer (no \n case)
    if (this.buffer.length > 0 && this.pendingRequests.size > 0) {
      this.tryDispatchResponse(this.buffer.trim());
    }
  }

  private tryDispatchResponse(text: string): boolean {
    try {
      const response: ControlResponse = JSON.parse(text);
      
      // The helper always responds with requestId: 0 (SimpleJson limitation).
      // Match by exact requestId first, then fall back to the sole pending
      // request when requestId is 0 (safe because the protocol is serial).
      let pending = this.pendingRequests.get(response.requestId);
      if (!pending && response.requestId === 0 && this.pendingRequests.size === 1) {
        const soleEntry = this.pendingRequests.entries().next();
        if (!soleEntry.done) {
          pending = soleEntry.value[1];
          ccTrace(`[${this.id}] FALLBACK routing requestId 0 → pending ${soleEntry.value[0]}`);
        }
      }
      
      if (pending) {
        clearTimeout(pending.timer);
        // Delete by actual pending key (not response.requestId which may be 0)
        for (const [key, val] of this.pendingRequests) {
          if (val === pending) {
            this.pendingRequests.delete(key);
            break;
          }
        }
        ccTrace(`[${this.id}] DISPATCH reqId=${response.requestId} success=${response.success} state=${response.state}`);
        // Clear buffer only if we consumed the exact text
        if (this.buffer === text || this.buffer.startsWith(text)) {
          this.buffer = '';
        }
        pending.resolve(response);
        return true;
      } else {
        ccTrace(`[${this.id}] UNMATCHED response reqId=${response.requestId} (pending keys=[${[...this.pendingRequests.keys()].join(',')}])`);
      }
    } catch {
      // Not JSON yet
    }
    return false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendRequest(command: string, payload: Record<string, unknown> = {}): Promise<ControlResponse> {
    const mark = Date.now();
    if (!this.socket || !this.connected) {
      ccTrace(`[${this.id}] sendRequest("${command}") FAILED — not connected`);
      throw new Error('Not connected to control pipe');
    }

    const requestId = ++this.requestId;
    const request: ControlRequest = {
      protocolVersion: '0.2.0',
      requestId,
      sessionId: this.sessionId,
      authToken: this.authToken,
      command,
      payload,
    };
    const requestStr = JSON.stringify(request) + '\n';

    ccTrace(`[${this.id}] SEND "${command}" reqId=${requestId} len=${requestStr.length}`);

    // CRITICAL: register pending handler BEFORE write to avoid race
    return new Promise<ControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        ccTrace(`[${this.id}] TIMEOUT "${command}" reqId=${requestId} after ${Date.now() - mark}ms`);
        this.pendingRequests.delete(requestId);
        reject(new Error(`Response timeout for command "${command}"`));
      }, this.REQUEST_TIMEOUT_MS);

      // Register first
      this.pendingRequests.set(requestId, { resolve, reject, timer });

      // Then write
      try {
        const sock = this.socket!;
        sock.write(requestStr, (err?: Error | null) => {
          if (err) {
            ccTrace(`[${this.id}] WRITE CALLBACK ERROR "${command}" reqId=${requestId}: ${err.message}`);
            clearTimeout(timer);
            this.pendingRequests.delete(requestId);
            reject(err);
          } else {
            ccTrace(`[${this.id}] WRITE OK "${command}" reqId=${requestId} (write callback)`);
          }
        });
      } catch (err) {
        ccTrace(`[${this.id}] WRITE EXCEPTION "${command}" reqId=${requestId}: ${err}`);
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── Convenience Methods ──

  async hello(): Promise<ControlResponse> { return this.sendRequest('hello'); }
  async getVersion(): Promise<ControlResponse> { return this.sendRequest('getVersion'); }

  async getCapabilities(): Promise<HelperCapabilities> {
    const resp = await this.sendRequest('getCapabilities');
    if (!resp.success || !resp.result) throw new Error(`getCapabilities failed: ${resp.error ?? 'unknown'}`);
    return resp.result as unknown as HelperCapabilities;
  }

  async getState(): Promise<HelperState> {
    const resp = await this.sendRequest('getState');
    if (!resp.success || !resp.result) throw new Error(`getState failed: ${resp.error ?? 'unknown'}`);
    return resp.result as unknown as HelperState;
  }

  async startSynthetic(payload: { mode?: number; durationMs?: number; totalPackets?: number; framesPerPacket?: number } = {}): Promise<{ streamGeneration: number }> {
    const resp = await this.sendRequest('startSynthetic', payload as Record<string, unknown>);
    if (!resp.success || !resp.result) throw new Error(`startSynthetic failed: ${resp.error ?? 'unknown'}`);
    return { streamGeneration: resp.result.streamGeneration as number };
  }

  async startProcessCapture(payload: { targetPid: number; expectedCreationTimeUtc100ns?: number; mode?: 'include' | 'exclude' }): Promise<{ streamGeneration: number }> {
    const resp = await this.sendRequest('startProcessCapture', payload as Record<string, unknown>);
    if (!resp.success || !resp.result) throw new Error(`startProcessCapture failed: ${resp.error ?? 'unknown'}`);
    return { streamGeneration: resp.result.streamGeneration as number };
  }

  async resolveSource(payload: { sourceId: string }): Promise<Record<string, unknown>> {
    const resp = await this.sendRequest('resolveSource', payload as Record<string, unknown>);
    if (!resp.success) throw new Error(`resolveSource failed: ${resp.error ?? 'unknown'}`);
    return (resp.result ?? { found: false, error: 'empty result' }) as Record<string, unknown>;
  }

  async startApplicationAudio(payload: { targetPid: number; expectedCreationTimeUtc100ns?: number }): Promise<Record<string, unknown>> {
    const resp = await this.sendRequest('startApplicationAudio', payload as Record<string, unknown>);
    if (!resp.success || !resp.result) throw new Error(`startApplicationAudio failed: ${resp.error ?? 'unknown'}`);
    return resp.result as Record<string, unknown>;
  }

  async startEndpointLoopback(): Promise<{ streamGeneration: number }> {
    return this.sendRequest('startEndpointLoopback');
  }

  async stopCapture(): Promise<ControlResponse> { return this.sendRequest('stopCapture'); }

  async getDiagnostics(): Promise<HelperDiagnostics> {
    const resp = await this.sendRequest('getDiagnostics');
    if (!resp.success || !resp.result) throw new Error(`getDiagnostics failed: ${resp.error ?? 'unknown'}`);
    return resp.result as unknown as HelperDiagnostics;
  }

  async ping(): Promise<ControlResponse> { return this.sendRequest('ping'); }
  async shutdown(): Promise<ControlResponse> { return this.sendRequest('shutdown'); }

  disconnect(): void {
    ccTrace(`[${this.id}] disconnect()`);
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.connected = false;
    this.buffer = '';
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Control client disconnected'));
    }
    this.pendingRequests.clear();
  }
}
