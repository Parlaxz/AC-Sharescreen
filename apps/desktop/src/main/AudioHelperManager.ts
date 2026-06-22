import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as net from 'net';
import { BinaryPcmParser, ParsedPcmPacket } from './BinaryPcmParser.js';
import { PcmBridge } from './PcmBridge.js';
import {
  ControlClient,
  HelperCapabilities,
  HelperDiagnostics,
  HelperState,
} from './ControlClient.js';

// ── Types ──

export interface AudioHelperConfig {
  helperPath: string;
  protocolVersion?: string;
}

export type HelperStateEnum =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'ready'
  | 'capturing'
  | 'stopping'
  | 'error';

export interface AudioHelperStats {
  state: HelperStateEnum;
  helperPid: number | null;
  helperUptimeMs: number;
  streamGeneration: number;
  packetCount: number;
  payloadBytes: number;
  droppedPackets: number;
  sequenceGaps: number;
  malformedPackets: number;
  silentPackets: number;
  discontinuityPackets: number;
  timestampErrorPackets: number;
  queueDepth: number;
  maxQueueDepth: number;
  parserBufferBytes: number;
  maxParserBufferBytes: number;
  helperRestarts: number;
  lastError: string | null;
}

// ── AudioHelperManager ──

/**
 * Lifecycle manager for the native screenlink-audio-helper process.
 *
 * Responsibilities:
 * - Spawn the helper with correct arguments (control pipe, PCM pipe, session ID)
 * - Connect to the control named pipe and perform handshake
 * - Connect to the PCM named pipe and feed data into BinaryPcmParser
 * - Expose high-level commands (startSynthetic, startProcessCapture, etc.)
 * - Monitor helper health via periodic diagnostics queries
 * - Automatic restart on unexpected exit (up to 3 retries with cooldown)
 */
export class AudioHelperManager {
  private config: AudioHelperConfig;
  private helper: ChildProcess | null = null;
  private control: ControlClient | null = null;
  private parser: BinaryPcmParser | null = null;
  private pcmSocket: net.Socket | null = null;

  private sessionId: string;
  private authToken: string;
  private ctrlPipeName: string;
  private pcmPipeName: string;

  private state: HelperStateEnum = 'disconnected';
  private streamGeneration: number = -1;
  private currentSourceType: 'synthetic' | 'process' | 'application' | 'monitor' | null = null;
  private stats: AudioHelperStats;
  private lastError_: string | null = null;
  private restartCount: number = 0;
  private readonly maxRestarts = 3;
  private readonly restartCooldownMs = 5000;

  private onPacketCallback: ((packet: ParsedPcmPacket) => void) | null = null;
  private onStatsCallback: ((stats: AudioHelperStats) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;

  private diagnosticsInterval: ReturnType<typeof setInterval> | null = null;
  private shuttingDown_: boolean = false;
  readonly pcmBridge: PcmBridge = new PcmBridge();

  constructor(config: AudioHelperConfig) {
    this.config = config;
    this.sessionId = this.generateId();
    this.authToken = this.generateId();
    this.ctrlPipeName = `\\\\.\\pipe\\screenlink-${this.sessionId}-ctrl`;
    this.pcmPipeName = `\\\\.\\pipe\\screenlink-${this.sessionId}-pcm`;
    this.stats = this.emptyStats();
  }

  // ── Public Accessors ──

  get state_(): HelperStateEnum {
    return this.state;
  }
  get sessionId_(): string {
    return this.sessionId;
  }
  get helperPid(): number | null {
    return this.helper?.pid ?? null;
  }
  get streamGeneration_(): number {
    return this.streamGeneration;
  }
  get sourceType(): string | null {
    return this.currentSourceType;
  }
  get lastError(): string | null {
    return this.lastError_;
  }

  // ── Callback Registration ──

  onPacket(cb: (packet: ParsedPcmPacket) => void): void {
    this.onPacketCallback = cb;
  }

  onStats(cb: (stats: AudioHelperStats) => void): void {
    this.onStatsCallback = cb;
  }

  onError(cb: (error: string) => void): void {
    this.onErrorCallback = cb;
  }

  // ── PCM Bridge ──

  attachPcmToWebContents(webContents: Electron.WebContents): void {
    this.pcmBridge.attachToWebContents(webContents);
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    if (this.state !== 'disconnected') {
      throw new Error(`Cannot start: state is ${this.state}`);
    }

    this.state = 'connecting';
    this.lastError_ = null;

    try {
      // 1. Spawn the helper process
      await this.spawnHelper();

      // 2. Connect to control named pipe
      this.control = new ControlClient(this.ctrlPipeName, this.sessionId, this.authToken);
      await this.control.connect(5000);

      // 3. Perform handshake
      this.state = 'handshaking';
      const helloResp = await this.control.hello();
      if (!helloResp.success) {
        throw new Error(`Handshake failed: ${helloResp.error ?? 'unknown'}`);
      }

      // 4. Connect PCM named pipe
      await this.connectPcmPipe();

      // 5. Start diagnostics polling
      this.state = 'ready';
      this.startDiagnostics();
    } catch (err) {
      this.state = 'error';
      this.lastError_ = err instanceof Error ? err.message : String(err);
      await this.cleanup();
      throw err;
    }
  }

  async startSyntheticCapture(
    options: {
      mode?: number;
      durationMs?: number;
      totalPackets?: number;
    } = {},
  ): Promise<number> {
    this.ensureReady();
    const result = await this.control!.startSynthetic(options);
    this.streamGeneration = result.streamGeneration;
    this.currentSourceType = 'synthetic';
    this.state = 'capturing';
    this.parser?.reset();
    this.pcmBridge.forwardReset(result.streamGeneration);
    return result.streamGeneration;
  }

  async startProcessCapture(options: {
    targetPid: number;
    expectedCreationTimeUtc100ns?: number;
    mode?: 'include' | 'exclude';
  }): Promise<number> {
    this.ensureReady();
    const result = await this.control!.startProcessCapture(options);
    this.streamGeneration = result.streamGeneration;
    this.currentSourceType = 'process';
    this.state = 'capturing';
    this.parser?.reset();
    this.pcmBridge.forwardReset(result.streamGeneration);
    return result.streamGeneration;
  }

  // ── Phase 2E: Audio sessions ──

  async resolveSource(sourceId: string): Promise<any> {
    this.ensureReady();
    return this.control!.resolveSource({ sourceId });
  }

  async enumerateAudioSessions(): Promise<any> {
    this.ensureReady();
    return this.control!.sendRequest('enumerateAudioSessions');
  }

  async startApplicationCapture(options: {
    targetPid: number;
    expectedCreationTimeUtc100ns: number;
  }): Promise<any> {
    this.ensureReady();
    const result = await this.control!.startApplicationAudio(options);
    this.streamGeneration = (result.streamGeneration as number) || this.streamGeneration;
    this.currentSourceType = 'application';
    return result;
  }

  async startFilteredMonitorCapture(options: {
    excludeDiscord?: boolean;
    excludeScreenLink?: boolean;
  }): Promise<any> {
    this.ensureReady();
    const resp = await this.control!.sendRequest('startFilteredMonitorAudio', {
      excludeDiscord: options.excludeDiscord ?? true,
      excludeScreenLink: options.excludeScreenLink ?? true,
      screenLinkPid: process.pid,
    });
    this.streamGeneration = (resp.result?.streamGeneration as number) || this.streamGeneration;
    this.currentSourceType = 'monitor';
    return resp;
  }

  async getMixerState(): Promise<any> {
    this.ensureReady();
    return this.control!.sendRequest('getMixerState');
  }

  async getMixerDiagnostics(): Promise<any> {
    this.ensureReady();
    return this.control!.sendRequest('getMixerDiagnostics');
  }

  async stopCapture(): Promise<void> {
    if (this.state !== 'capturing') return;
    this.state = 'stopping';
    try {
      await this.control!.stopCapture();
    } catch {
      /* ignore */
    }
    this.state = 'ready';
    this.currentSourceType = null;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown_ = true; // Prevent restart during shutdown
    try {
      if (this.state === 'capturing') {
        await this.stopCapture();
      }
      if (this.control?.isConnected()) {
        await this.control!.shutdown();
      }
    } catch {
      /* ignore */
    }
    await this.cleanup();
    this.state = 'disconnected';
    this.shuttingDown_ = false;
  }

  // ── Queries ──

  async getCapabilities(): Promise<HelperCapabilities> {
    this.ensureReady();
    return this.control!.getCapabilities();
  }

  async getHelperState(): Promise<HelperState> {
    this.ensureReady();
    return this.control!.getState();
  }

  async getDiagnostics(): Promise<HelperDiagnostics> {
    this.ensureReady();
    return this.control!.getDiagnostics();
  }

  getStats(): AudioHelperStats {
    return { ...this.stats };
  }

  // ── Private ──

  private ensureReady(): void {
    if (this.state !== 'ready' && this.state !== 'capturing') {
      throw new Error(`Helper not ready (state: ${this.state})`);
    }
  }

  private async spawnHelper(): Promise<void> {
    const args = [
      '--serve',
      '--control-pipe',
      this.ctrlPipeName,
      '--pcm-pipe',
      this.pcmPipeName,
      '--session-id',
      this.sessionId,
      '--auth-token',
      this.authToken,
      '--parent-pid',
      String(process.pid),
    ];

    this.helper = spawn(this.config.helperPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.helper.on('exit', (code, signal) => {
      this.handleHelperExit(code, signal);
    });

    this.helper.on('error', (err) => {
      this.handleHelperError(err);
    });

    // Wait briefly for the helper to start and create pipes
    await new Promise((r) => setTimeout(r, 500));

    // Verify helper is still alive — if it crashed during startup, fail fast
    if (this.helper && this.helper.exitCode !== null) {
      throw new Error(
        `Helper exited during startup with code ${this.helper.exitCode}`,
      );
    }
  }

  private async connectPcmPipe(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const timeoutMs = 5000;

      const tryConnect = () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Timeout connecting to PCM pipe'));
          return;
        }

        const socket = net.connect(this.pcmPipeName);

        const onError = () => {
          socket.destroy();
          setTimeout(tryConnect, 200);
        };

        socket.once('connect', () => {
          socket.removeListener('error', onError);
          this.pcmSocket = socket;
          this.setupPcmSocket(socket);
          resolve();
        });

        socket.once('error', onError);
      };
      tryConnect();
    });
  }

  private setupPcmSocket(socket: net.Socket): void {
    socket.setNoDelay(true);

    // Wire up the parser (same callback logic as before)
    this.parser = new BinaryPcmParser(
      (packet) => {
        // Update stats (same as existing code)
        this.stats.packetCount++;
        this.stats.payloadBytes += packet.header.payloadBytes;
        if (packet.header.flags & 1) this.stats.silentPackets++;
        if (packet.header.flags & 2) this.stats.discontinuityPackets++;
        if (packet.header.flags & 4) this.stats.timestampErrorPackets++;

        // Check stream generation
        if (this.streamGeneration >= 0 && packet.header.streamGeneration !== this.streamGeneration) {
          this.onErrorCallback?.(`Stream generation mismatch: expected ${this.streamGeneration}, got ${packet.header.streamGeneration}`);
          return;
        }

        this.pcmBridge.forwardPacket(packet);
        this.onPacketCallback?.(packet);
        this.emitStats();
      },
      (error) => {
        this.lastError_ = error;
        this.stats.malformedPackets++;
        this.onErrorCallback?.(error);
        this.emitStats();
      },
    );

    socket.on('data', (chunk: Buffer) => {
      try {
        this.parser!.feed(chunk);
        const s = this.parser!.getStats();
        this.stats.sequenceGaps = s.sequenceGaps;
        this.stats.malformedPackets = s.malformedPackets;
        this.stats.silentPackets = s.silentPackets;
        this.stats.discontinuityPackets = s.discontinuityPackets;
        this.stats.timestampErrorPackets = s.timestampErrorPackets;
        this.stats.parserBufferBytes = s.bufferBytes;
        this.stats.maxParserBufferBytes = s.maxBufferSize;
      } catch (err) {
        this.onErrorCallback?.(`PCM parse error: ${err}`);
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.lastError_ = err.message;
      this.stats.malformedPackets++;
      this.onErrorCallback?.(err.message);
    });

    socket.on('close', () => {
      this.pcmSocket = null;
    });
  }

  private startDiagnostics(): void {
    this.diagnosticsInterval = setInterval(async () => {
      try {
        const diag = await this.control!.getDiagnostics();
        this.stats.droppedPackets = diag.droppedPackets;
        this.stats.queueDepth = diag.queueSize;
        this.stats.maxQueueDepth = Math.max(this.stats.maxQueueDepth, diag.queueSize);
        this.emitStats();
      } catch {
        /* ignore polling errors */
      }
    }, 5000);
  }

  private emitStats(): void {
    if (this.helper) {
      this.stats.helperPid = this.helper.pid ?? null;
    }
    this.onStatsCallback?.(this.getStats());
  }

  private handleHelperExit(code: number | null, signal: string | null): void {
    const wasRunning = this.state !== 'disconnected';
    this.state = 'error';
    this.lastError_ = `Helper exited with code=${code} signal=${signal}`;

    // Don't restart if we're shutting down
    if (this.shuttingDown_) return;

    if (wasRunning && this.restartCount < this.maxRestarts) {
      this.restartCount++;
      this.stats.helperRestarts = this.restartCount;
      setTimeout(() => this.attemptRestart(), this.restartCooldownMs);
    }
  }

  private handleHelperError(err: Error): void {
    this.lastError_ = err.message;
    this.state = 'error';
    this.onErrorCallback?.(err.message);
  }

  private async attemptRestart(): Promise<void> {
    await this.cleanup();

    this.state = 'connecting';
    this.sessionId = this.generateId();
    this.authToken = this.generateId();
    this.ctrlPipeName = `\\\\.\\pipe\\screenlink-${this.sessionId}-ctrl`;
    this.pcmPipeName = `\\\\.\\pipe\\screenlink-${this.sessionId}-pcm`;

    try {
      await this.spawnHelper();
      this.control = new ControlClient(this.ctrlPipeName, this.sessionId, this.authToken);
      await this.control.connect(5000);
      await this.control.hello();
      await this.connectPcmPipe();
      this.state = 'ready';
      this.restartCount = 0;
    } catch {
      this.state = 'error';
    }
  }

  private async cleanup(): Promise<void> {
    this.pcmBridge.detach();

    if (this.diagnosticsInterval !== null) {
      clearInterval(this.diagnosticsInterval);
      this.diagnosticsInterval = null;
    }

    // Close PCM socket
    if (this.pcmSocket) {
      try {
        this.pcmSocket.destroy();
      } catch { /* ignore */ }
      this.pcmSocket = null;
    }

    // Disconnect control client
    this.control?.disconnect();
    this.control = null;
    this.parser = null;

    // Kill helper process
    if (this.helper && !this.helper.killed) {
      try {
        this.helper.kill();
      } catch {
        /* ignore */
      }
    }
    this.helper = null;
  }

  private generateId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private emptyStats(): AudioHelperStats {
    return {
      state: 'disconnected',
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
  }
}
