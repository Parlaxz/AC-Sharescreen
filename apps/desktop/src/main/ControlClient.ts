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
 * Typed client for the native audio-helper control named pipe.
 *
 * Windows named pipes in message mode are accessed via `\\\\.\\pipe\\{name}` paths.
 * Node.js `fs` synchronous operations (`openSync`, `writeSync`, `readSync`,
 * `closeSync`) are used because message-mode named pipes are fundamentally
 * synchronous on Windows.
 */
export class ControlClient {
  private pipePath: string;
  private sessionId: string;
  private authToken: string;
  private requestId: number = 0;
  private fd: number | null = null;
  private connected: boolean = false;
  private buffer: string = '';

  constructor(pipeName: string, sessionId: string, authToken: string) {
    this.pipePath = pipeName;
    this.sessionId = sessionId;
    this.authToken = authToken;
  }

  async connect(timeoutMs: number = 5000): Promise<void> {
    const fs = await import('fs');
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        this.fd = fs.openSync(this.pipePath, 'r+');
        this.connected = true;
        return;
      } catch {
        // Pipe not ready yet, retry
        await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error(`Timeout connecting to control pipe: ${this.pipePath}`);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendRequest(command: string, payload: Record<string, unknown> = {}): Promise<ControlResponse> {
    if (!this.connected || this.fd === null) {
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

    const fs = await import('fs');
    const requestStr = JSON.stringify(request) + '\n';

    // Write request as a single message
    fs.writeSync(this.fd, requestStr);

    // Read response — accumulate until we have a complete JSON object
    const maxReadAttempts = 100;
    for (let i = 0; i < maxReadAttempts; i++) {
      const buf = Buffer.alloc(65536);
      try {
        const bytesRead = fs.readSync(this.fd, buf, 0, buf.length, null);
        if (bytesRead > 0) {
          this.buffer += buf.toString('utf-8', 0, bytesRead);

          // Try to parse a complete JSON response
          try {
            const response: ControlResponse = JSON.parse(this.buffer);
            this.buffer = '';
            if (response.requestId !== requestId) {
              throw new Error(
                `Request ID mismatch: expected ${requestId}, got ${response.requestId}`,
              );
            }
            return response;
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) {
              // Incomplete JSON — wait for more data
              continue;
            }
            throw parseErr;
          }
        }
      } catch {
        // No data yet or pipe error — retry
      }

      await new Promise(r => setTimeout(r, 10));
    }

    throw new Error('Timeout waiting for control response');
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
    if (this.fd !== null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs') as typeof import('fs');
        fs.closeSync(this.fd);
      } catch {
        /* ignore during cleanup */
      }
      this.fd = null;
    }
    this.connected = false;
    this.buffer = '';
  }
}
