import * as net from 'net';

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

/**
 * Async typed client for the native audio-helper control named pipe.
 * Uses net.Socket for non-blocking I/O with request/response matching by requestId.
 * Protocol: newline-delimited JSON over byte-mode named pipe.
 */
export class ControlClient {
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
  }

  async connect(timeoutMs: number = 5000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const start = Date.now();

      const tryConnect = () => {
        const elapsed = Date.now() - start;
        if (elapsed > timeoutMs) {
          console.log(`[ControlClient] Connect timeout after ${elapsed}ms`);
          reject(new Error(`Timeout connecting to control pipe: ${this.pipePath}`));
          return;
        }

        const socket = net.connect(this.pipePath);

        const onError = () => {
          socket.destroy();
          console.log(`[ControlClient] Connect retry at ${Date.now() - start}ms`);
          setTimeout(tryConnect, 200);
        };

        socket.once('connect', () => {
          socket.removeListener('error', onError);
          console.log(`[ControlClient] Connected at ${Date.now() - start}ms`);
          this.socket = socket;
          this.connected = true;
          this.setupSocket();
          resolve();
        });

        socket.once('error', onError);
      };

      tryConnect();
    });
  }

  private setupSocket(): void {
    const socket = this.socket!;

    socket.on('data', (data: Buffer) => {
      this.buffer += data.toString('utf-8');
      this.processBuffer();
    });

    socket.on('close', () => {
      this.socket = null;
      this.connected = false;
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Control pipe closed'));
      }
      this.pendingRequests.clear();
    });

    socket.on('error', () => {
      // Socket errors surface as 'close' after 'error'
    });
  }

  private processBuffer(): void {
    // Parse complete newline-delimited JSON responses from buffer
    while (this.buffer.includes('\n')) {
      const newlineIdx = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const response: ControlResponse = JSON.parse(line);
        const pending = this.pendingRequests.get(response.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(response.requestId);
          pending.resolve(response);
        }
        // Responses with unknown requestId are silently dropped
        // (e.g. leftover from a previous session generation)
      } catch {
        // Malformed JSON — skip this fragment
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendRequest(command: string, payload: Record<string, unknown> = {}): Promise<ControlResponse> {
    if (!this.socket || !this.connected) {
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

    console.log(`[ControlClient] Sending "${command}" (reqId=${requestId})`);

    return new Promise<ControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.log(`[ControlClient] TIMEOUT for "${command}" (reqId=${requestId})`);
        this.pendingRequests.delete(requestId);
        reject(new Error(`Response timeout for command "${command}"`));
      }, this.REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      try {
        this.socket!.write(requestStr);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── Convenience Methods ──

  async hello(): Promise<ControlResponse> {
    return this.sendRequest('hello');
  }

  async getVersion(): Promise<ControlResponse> {
    return this.sendRequest('getVersion');
  }

  async getCapabilities(): Promise<HelperCapabilities> {
    const resp = await this.sendRequest('getCapabilities');
    if (!resp.success || !resp.result) {
      throw new Error(`getCapabilities failed: ${resp.error ?? 'unknown'}`);
    }
    return resp.result as unknown as HelperCapabilities;
  }

  async getState(): Promise<HelperState> {
    const resp = await this.sendRequest('getState');
    if (!resp.success || !resp.result) {
      throw new Error(`getState failed: ${resp.error ?? 'unknown'}`);
    }
    return resp.result as unknown as HelperState;
  }

  async startSynthetic(payload: {
    mode?: number;
    durationMs?: number;
    totalPackets?: number;
    framesPerPacket?: number;
  } = {}): Promise<{ streamGeneration: number }> {
    const resp = await this.sendRequest('startSynthetic', payload as Record<string, unknown>);
    if (!resp.success || !resp.result) {
      throw new Error(`startSynthetic failed: ${resp.error ?? 'unknown'}`);
    }
    return { streamGeneration: resp.result.streamGeneration as number };
  }

  async startProcessCapture(payload: {
    targetPid: number;
    expectedCreationTimeUtc100ns?: number;
    mode?: 'include' | 'exclude';
  }): Promise<{ streamGeneration: number }> {
    const resp = await this.sendRequest('startProcessCapture', payload as Record<string, unknown>);
    if (!resp.success || !resp.result) {
      throw new Error(`startProcessCapture failed: ${resp.error ?? 'unknown'}`);
    }
    return { streamGeneration: resp.result.streamGeneration as number };
  }

  async resolveSource(payload: { sourceId: string }): Promise<Record<string, unknown>> {
    const resp = await this.sendRequest('resolveSource', payload as Record<string, unknown>);
    if (!resp.success) {
      throw new Error(`resolveSource failed: ${resp.error ?? 'unknown'}`);
    }
    return (resp.result ?? { found: false, error: 'empty result' }) as Record<string, unknown>;
  }

  async startApplicationAudio(payload: {
    targetPid: number;
    expectedCreationTimeUtc100ns?: number;
  }): Promise<Record<string, unknown>> {
    const resp = await this.sendRequest('startApplicationAudio', payload as Record<string, unknown>);
    if (!resp.success || !resp.result) {
      throw new Error(`startApplicationAudio failed: ${resp.error ?? 'unknown'}`);
    }
    return resp.result as Record<string, unknown>;
  }

  async stopCapture(): Promise<ControlResponse> {
    return this.sendRequest('stopCapture');
  }

  async getDiagnostics(): Promise<HelperDiagnostics> {
    const resp = await this.sendRequest('getDiagnostics');
    if (!resp.success || !resp.result) {
      throw new Error(`getDiagnostics failed: ${resp.error ?? 'unknown'}`);
    }
    return resp.result as unknown as HelperDiagnostics;
  }

  async ping(): Promise<ControlResponse> {
    return this.sendRequest('ping');
  }

  async shutdown(): Promise<ControlResponse> {
    return this.sendRequest('shutdown');
  }

  disconnect(): void {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch { /* ignore */ }
      this.socket = null;
    }
    this.connected = false;
    this.buffer = '';

    // Reject pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Control client disconnected'));
    }
    this.pendingRequests.clear();
  }
}
