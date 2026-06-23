import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { BinaryPcmParser, ParsedPcmPacket } from './BinaryPcmParser.js';
import { PcmBridge, PcmBridgeDiagnostics } from './PcmBridge.js';
import {
  ControlClient,
  HelperCapabilities,
  HelperDiagnostics,
  HelperState,
} from './ControlClient.js';

// Diagnostic log file for audio startup debugging (ESM-compatible path)
import { fileURLToPath } from 'url';
const _dirname = path.dirname(fileURLToPath(import.meta.url));
const DIAG_LOG = path.join(_dirname, '..', '..', 'audio-diag.log');
function diag(msg: string): void {
  try {
    fs.appendFileSync(DIAG_LOG, `${new Date().toISOString().slice(11, 23)} ${msg}\n`);
  } catch { /* best effort */ }
}

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

// ── Pipeline Diagnostics ──

export interface PcmPipelineSnapshot {
  synthPacketsProduced?: number;
  synthBytesProduced?: number;
  capturePacketsProduced?: number;
  captureBytesProduced?: number;
  sourcePacketsEnqueued?: number;
  sourcePacketsDequeued?: number;
  pcmPipeWriteAttempts?: number;
  pcmPipeWriteSuccesses?: number;
  pcmPipeBytesWritten?: number;
  pcmPipeWriteFailures?: number;
  electronSocketChunksReceived: number;
  electronSocketBytesReceived: number;
  parserFramesParsed: number;
  parserBytesParsed: number;
  parserInvalidHeaders: number;
  parserBufferedBytes: number;
  endpointPacketsCaptured?: number;
  endpointNonZeroPackets?: number;
  endpointSilentPackets?: number;
  mixerFeedPackets?: number;
  mixerOutputPackets?: number;
  mixerNonZeroOutputPackets?: number;
  onCaptureAccepted?: boolean;
  onCaptureRejectedState?: string;
  bridge: PcmBridgeDiagnostics;
  helperState: HelperStateEnum;
  helperUptimeMs: number;
  streamGeneration: number;
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
  private currentSourceType: 'synthetic' | 'process' | 'application' | 'monitor' | 'system' | null = null;
  private stats: AudioHelperStats;
  private lastError_: string | null = null;
  private restartCount: number = 0;
  private readonly maxRestarts = 3;
  private readonly baseRestartCooldownMs = 5000;
  private get restartCooldownMs(): number {
    // Exponential backoff: 5s, 10s, 20s
    return this.baseRestartCooldownMs * Math.pow(2, Math.min(this.restartCount, 3));
  }

  private onPacketCallback: ((packet: ParsedPcmPacket) => void) | null = null;
  private onStatsCallback: ((stats: AudioHelperStats) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;

  private diagnosticsInterval: ReturnType<typeof setInterval> | null = null;
  private shuttingDown_: boolean = false;
  readonly pcmBridge: PcmBridge = new PcmBridge();
  private diagSocketChunks = 0;
  private diagSocketBytes = 0;

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
      const helperPath = this.config.helperPath;
      diag(`Spawning helper: ${helperPath}`);
      console.log(`[AudioHelper] Spawning helper: ${helperPath}`);
      await this.spawnHelper();

      // Verify helper is alive
      if (this.helper && this.helper.exitCode !== null) {
        const msg = `Helper exited during startup with code ${this.helper.exitCode}`;
        diag(`FAIL: ${msg}`);
        console.error(`[AudioHelper] ${msg}`);
        throw new Error(msg);
      }
      diag(`Helper spawned, PID=${this.helper?.pid}`);
      console.log(`[AudioHelper] Helper spawned, PID: ${this.helper?.pid}`);

      // 2. Connect to control named pipe
      diag(`Connecting to control pipe...`);
      console.log(`[AudioHelper] Connecting to control pipe: ${this.ctrlPipeName}`);
      this.control = new ControlClient(this.ctrlPipeName, this.sessionId, this.authToken);
      await this.control.connect(5000);
      diag(`Control pipe connected`);
      console.log('[AudioHelper] Control pipe connected');

      // 3. Perform handshake
      this.state = 'handshaking';
      diag(`Sending hello...`);
      console.log('[AudioHelper] Sending hello...');
      const helloResp = await this.control.hello();
      if (!helloResp.success) {
        throw new Error(`Handshake failed: ${helloResp.error ?? 'unknown'}`);
      }
      diag(`Hello handshake complete`);
      console.log(`[AudioHelper] Hello handshake complete, helper version: ${helloResp.result?.helperVersion}`);

      // 4. Connect PCM named pipe
      diag(`Connecting PCM pipe...`);
      console.log(`[AudioHelper] Connecting PCM pipe...`);
      await this.connectPcmPipe();
      diag(`PCM pipe connected`);
      console.log(`[AudioHelper] PCM pipe connected`);

      // 5. Start diagnostics polling
      this.state = 'ready';
      this.startDiagnostics();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diag(`FAIL: ${msg}`);
      this.state = 'error';
      this.lastError_ = msg;
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
    // Send diagnostic canary to verify MessagePort is alive
    this.pcmBridge.sendCanary?.();
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

  async startEndpointLoopback(): Promise<number> {
    this.ensureReady();
    const result = await this.control!.startEndpointLoopback();
    const gen = result.streamGeneration;
    if (!Number.isSafeInteger(gen)) {
      throw new Error(`Invalid streamGeneration from endpoint loopback: ${gen}`);
    }
    this.streamGeneration = gen;
    this.currentSourceType = 'system';
    this.state = 'capturing';
    this.parser?.reset();
    this.pcmBridge.forwardReset(gen);
    this.pcmBridge.sendCanary?.();
    return gen;
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
  }): Promise<{ success: boolean; streamGeneration?: number; error?: string }> {
    this.ensureReady();
    const result = await this.control!.startApplicationAudio(options);
    const gen = Number(result.streamGeneration);
    if (!Number.isSafeInteger(gen)) throw new Error(`Invalid streamGeneration: ${gen}`);
    this.streamGeneration = gen;
    this.currentSourceType = 'application';
    this.state = 'capturing';
    this.parser?.reset();
    this.pcmBridge.forwardReset(gen);
    this.pcmBridge.sendCanary?.();
    return { success: true, streamGeneration: gen };
  }

  async startFilteredMonitorCapture(options: {
    excludeDiscord?: boolean;
    excludeScreenLink?: boolean;
  }): Promise<{ success: boolean; streamGeneration: number; error?: string }> {
    this.ensureReady();
    const resp = await this.control!.sendRequest('startFilteredMonitorAudio', {
      excludeDiscord: options.excludeDiscord ?? true,
      excludeScreenLink: options.excludeScreenLink ?? true,
      screenLinkPid: process.pid,
    });
    const gen = Number(resp.result?.streamGeneration);
    if (!Number.isSafeInteger(gen)) throw new Error(`Invalid gen: ${gen}`);
    this.streamGeneration = gen;
    this.currentSourceType = 'monitor';
    this.state = 'capturing';
    this.parser?.reset();
    this.pcmBridge.forwardReset(gen);
    this.pcmBridge.sendCanary?.();
    return { success: true, streamGeneration: gen };
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

  async getPipelineSnapshot(): Promise<PcmPipelineSnapshot> {
    let helperDiag: HelperDiagnostics | null = null;
    try {
      if (this.state === 'ready' || this.state === 'capturing') {
        helperDiag = await this.control!.getDiagnostics();
      }
    } catch { /* best effort */ }

    return {
      synthPacketsProduced: helperDiag
        ? ((helperDiag as any).synthPacketsProduced ?? helperDiag.capturePacketsProduced ?? undefined)
        : undefined,
      synthBytesProduced: helperDiag
        ? ((helperDiag as any).synthBytesProduced ?? helperDiag.captureBytesProduced ?? undefined)
        : undefined,
      capturePacketsProduced: helperDiag
        ? (helperDiag.capturePacketsProduced ?? (helperDiag as any).synthPacketsProduced ?? undefined)
        : undefined,
      captureBytesProduced: helperDiag
        ? (helperDiag.captureBytesProduced ?? (helperDiag as any).synthBytesProduced ?? undefined)
        : undefined,
      sourcePacketsEnqueued: helperDiag ? (helperDiag as any).sourcePacketsEnqueued ?? undefined : undefined,
      pcmPipeWriteAttempts: helperDiag ? (helperDiag as any).pcmPipeWriteAttempts ?? undefined : undefined,
      pcmPipeWriteSuccesses: helperDiag ? (helperDiag as any).pcmPipeWriteSuccesses ?? undefined : undefined,
      pcmPipeWriteFailures: helperDiag ? (helperDiag as any).pcmPipeWriteFailures ?? undefined : undefined,
      endpointPacketsCaptured: helperDiag?.endpointPacketsCaptured ?? undefined,
      endpointNonZeroPackets: helperDiag?.endpointNonZeroPackets ?? undefined,
      endpointSilentPackets: helperDiag?.endpointSilentPackets ?? undefined,
      mixerFeedPackets: helperDiag?.mixerFeedPackets ?? undefined,
      mixerOutputPackets: helperDiag?.mixerOutputPackets ?? undefined,
      mixerNonZeroOutputPackets: helperDiag?.mixerNonZeroOutputPackets ?? undefined,
      onCaptureAccepted: helperDiag?.onCaptureAccepted ?? undefined,
      onCaptureRejectedState: helperDiag?.onCaptureRejectedState ?? undefined,
      electronSocketChunksReceived: this.diagSocketChunks,
      electronSocketBytesReceived: this.diagSocketBytes,
      parserFramesParsed: this.parser?.getStats().totalPackets ?? 0,
      parserBytesParsed: this.parser?.getStats().totalBytes ?? 0,
      parserInvalidHeaders: this.parser?.getStats().malformedPackets ?? 0,
      parserBufferedBytes: this.parser?.getStats().bufferBytes ?? 0,
      bridge: this.pcmBridge.getDiagnostics(),
      helperState: this.state,
      helperUptimeMs: this.stats.helperUptimeMs,
      streamGeneration: this.streamGeneration,
    };
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

    // Consume stdout/stderr to prevent pipe backpressure from hanging the helper.
    // Log stderr for crash diagnostics; discard stdout (helper uses control pipe for data).
    if (this.helper.stdout) {
      this.helper.stdout.on('data', () => {
        // Drain stdout — helper shouldn't write here, but consume to prevent backpressure
      });
    }
    if (this.helper.stderr) {
      let stderrBuffer = '';
      this.helper.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        // Log each line as it arrives for real-time diagnostics
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? ''; // Keep incomplete last line
        for (const line of lines) {
          if (line.trim()) {
            diag(`[helper stderr] ${line}`);
          }
        }
      });
      this.helper.stderr.on('end', () => {
        if (stderrBuffer.trim()) {
          diag(`[helper stderr] ${stderrBuffer.trim()}`);
        }
      });
    }

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
      let attempts = 0;

      const tryConnect = () => {
        const elapsed = Date.now() - start;
        attempts++;
        if (elapsed > timeoutMs) {
          diag(`PCM CONNECT TIMEOUT after ${elapsed}ms (${attempts} attempts)`);
          reject(new Error(`Timeout connecting to PCM pipe after ${elapsed}ms`));
          return;
        }

        const socket = net.connect(this.pcmPipeName);

        const onError = () => {
          socket.destroy();
          diag(`PCM connect attempt ${attempts} failed at ${elapsed}ms`);
          setTimeout(tryConnect, 200);
        };

        socket.once('connect', () => {
          socket.removeListener('error', onError);
          diag(`PCM pipe connected at ${elapsed}ms`);
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
      this.diagSocketChunks++;
      this.diagSocketBytes += chunk.byteLength;
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

    // Decode common Windows exit codes for diagnostics
    let exitDetail = `code=${code} signal=${signal}`;
    if (code !== null) {
      if (code === 0xC0000374) exitDetail += ' (HEAP_CORRUPTION)';
      else if (code === 0xC0000005) exitDetail += ' (ACCESS_VIOLATION)';
      else if (code === 0xC0000409) exitDetail += ' (STACK_BUFFER_OVERRUN)';
      else if (code === 0x40010004) exitDetail += ' (DEBUG_ASSERTION_FAILURE)';
      else if (code === 1) exitDetail += ' (GENERIC_FAILURE)';
    }
    this.lastError_ = `Helper exited: ${exitDetail}`;
    diag(`Helper exit: ${exitDetail}`);
    console.error(`[AudioHelper] ${this.lastError_}`);

    // Don't restart if we're shutting down
    if (this.shuttingDown_) return;

    if (wasRunning && this.restartCount < this.maxRestarts) {
      this.restartCount++;
      this.stats.helperRestarts = this.restartCount;
      diag(`Scheduling restart attempt ${this.restartCount}/${this.maxRestarts} in ${this.restartCooldownMs}ms`);
      setTimeout(() => this.attemptRestart(), this.restartCooldownMs);
    } else if (this.restartCount >= this.maxRestarts) {
      diag(`Max restart attempts (${this.maxRestarts}) reached — giving up`);
      this.onErrorCallback?.(`Helper crashed ${this.maxRestarts} times, not restarting: ${this.lastError_}`);
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
