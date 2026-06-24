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
  StartFilteredMonitorResult,
  StartEndpointLoopbackResult,
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

type CleanupIntent = 'restart' | 'startup-failure' | 'normal-stop' | 'permanent-shutdown';

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
  // Phase 2G additions:
  filteredMonitorDiagnostics?: Record<string, unknown>;
  endpointDiagnostics?: Record<string, unknown>;
  // Helper binary provenance (logged at each pipeline snapshot)
  helperBinaryPath?: string;
  helperBinarySize?: number;
  helperBinaryMtime?: string;
  helperBinarySha256?: string;
  // Helper-reported build provenance (for mismatch detection)
  helperReportedCommit?: string;
  helperReportedDirty?: boolean;
  helperReportedProtocolVersion?: string;
  helperReportedBuildConfig?: string;
  expectedCommit?: string;
  provenanceMismatch?: string;
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

  // Phase 2G lifecycle management fields
  private restartTimer: NodeJS.Timeout | null = null;
  private connectionRetryTimer: NodeJS.Timeout | null = null;
  private pendingCleanup: CleanupIntent | null = null;
  private lifecycleGen: number = 0;
  private cleanupPromise: Promise<void> | null = null;
  private captureLifecycleGen: number = -1;

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
      // 1. Spawn the helper process — verify binary provenance
      const helperPath = this.config.helperPath;
      diag(`Spawning helper: ${helperPath}`);
      console.log(`[AudioHelper] Spawning helper: ${helperPath}`);
      try {
        const stats = fs.statSync(helperPath);
        console.log(`[AudioHelper] helper-binary path="${helperPath}" size=${stats.size} mtime=${stats.mtime.toISOString()}`);
        diag(`helper-binary size=${stats.size} mtime=${stats.mtime.toISOString()}`);
      } catch (e) {
        console.warn(`[AudioHelper] Cannot stat helper binary: ${e}`);
        diag(`Cannot stat helper binary: ${e}`);
      }
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
    this.captureLifecycleGen = this.lifecycleGen;
    this.pcmBridge.forwardReset(result.streamGeneration);
    // Send diagnostic canary to verify MessagePort is alive
    this.pcmBridge.sendCanary?.();
    return result.streamGeneration;
  }

  async startProcessCapture(options: {
    targetPid: number;
    expectedCreationTimeUtc100ns?: string;
    mode?: 'include' | 'exclude';
  }): Promise<number> {
    this.ensureReady();
    const result = await this.control!.startProcessCapture(options);
    this.streamGeneration = result.streamGeneration;
    this.currentSourceType = 'process';
    this.state = 'capturing';
    this.parser?.reset();
    this.captureLifecycleGen = this.lifecycleGen;
    this.pcmBridge.forwardReset(result.streamGeneration);
    return result.streamGeneration;
  }

  async startEndpointLoopback(): Promise<StartEndpointLoopbackResult> {
    this.ensureReady();
    const result = await this.control!.startEndpointLoopback();
    this.streamGeneration = result.streamGeneration;
    this.currentSourceType = 'system';
    this.state = 'capturing';
    this.parser?.reset();
    this.captureLifecycleGen = this.lifecycleGen;
    this.pcmBridge.forwardReset(result.streamGeneration);
    this.pcmBridge.sendCanary?.();
    return result;
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
    expectedCreationTimeUtc100ns: string;
  }): Promise<{ success: boolean; streamGeneration?: number; error?: string }> {
    this.ensureReady();
    const result = await this.control!.startApplicationAudio(options);
    const gen = Number(result.streamGeneration);
    if (!Number.isSafeInteger(gen)) throw new Error(`Invalid streamGeneration: ${gen}`);
    this.streamGeneration = gen;
    this.currentSourceType = 'application';
    this.state = 'capturing';
    this.parser?.reset();
    this.captureLifecycleGen = this.lifecycleGen;
    this.pcmBridge.forwardReset(gen);
    this.pcmBridge.sendCanary?.();
    return { success: true, streamGeneration: gen };
  }

  private buildScreenLinkIdentity(): Record<string, unknown> {
    const identity: Record<string, unknown> = {
      rootPid: process.pid,
      rootCreationTimeUtc100ns: undefined as unknown as string, // filled below
      productIdentifier: 'screenlink',
    };

    // Try to get current process creation time
    try {
      // On Windows, we can read /proc/pid equivalent via process module
      const creation = process.getCreationTime?.();
      if (creation) {
        // Convert Unix ms to Windows FILETIME 100ns ticks
        identity.rootCreationTimeUtc100ns = String(
          BigInt(Math.floor(creation * 10000)) + BigInt(116444736000000000)
        );
      }
    } catch { /* best effort */ }

    // Determine if packaged or development
    const isPackaged = !process.env.VITE_DEV_SERVER_URL && !process.env.ELECTRON_RUN_AS_NODE;
    const appPath = process.env.APP_PATH || process.cwd();

    if (isPackaged) {
      // Packaged: use resources/app path and app executable path
      identity.normalizedPackagedPath = process.execPath;
      try {
        const resourcesPath = require('path').resolve(process.execPath, '..', '..');
        identity.normalizedInstallationRoot = resourcesPath;
      } catch { /* best effort */ }
    } else {
      // Development: use the app root directory
      identity.normalizedDevAppRoot = appPath;
      // Entrypoint is the main script path
      try {
        identity.normalizedDevEntrypoint = require('path').resolve(__dirname, '..', 'main', 'main.js');
      } catch { /* best effort */ }
    }

    // Helper executable path
    try {
      identity.helperExePath = this.config.helperPath;
    } catch { /* best effort */ }

    return identity;
  }

  async startFilteredMonitorCapture(options: {
    excludeDiscord?: boolean;
    excludeScreenLink?: boolean;
  }): Promise<StartFilteredMonitorResult> {
    this.ensureReady();
    const identity = this.buildScreenLinkIdentity();
    const result = await this.control!.startFilteredMonitorAudio({
      excludeDiscord: options.excludeDiscord ?? true,
      excludeScreenLink: options.excludeScreenLink ?? true,
      screenLinkPid: process.pid,
      screenLinkIdentity: identity,
    });
    this.streamGeneration = result.streamGeneration;
    this.currentSourceType = 'monitor';
    this.state = 'capturing';
    this.parser?.reset();
    this.captureLifecycleGen = this.lifecycleGen;
    this.pcmBridge.forwardReset(result.streamGeneration);
    this.pcmBridge.sendCanary?.();
    return result;
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

    // Increment lifecycle gen to reject late PCM from old generation stream
    this.lifecycleGen++;

    try {
      await this.control!.stopCapture();
    } catch (err) {
      // Native stop failed — terminate helper and go to error
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError_ = `stopCapture failed: ${msg}`;
      this.state = 'error';
      this.helper?.kill();
      this.onErrorCallback?.(this.lastError_);
      throw err; // Surface the failure
    }

    // Native stop succeeded — transition to ready, clear source type
    this.state = 'ready';
    this.currentSourceType = null;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown_ = true; // Prevent restart during shutdown
    this.pendingCleanup = 'permanent-shutdown'; // Prevent any restart/reconnect

    // Cancel restart timer if set
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Cancel connection retry timer if set
    if (this.connectionRetryTimer !== null) {
      clearTimeout(this.connectionRetryTimer);
      this.connectionRetryTimer = null;
    }

    // Cancel diagnostics polling
    if (this.diagnosticsInterval !== null) {
      clearInterval(this.diagnosticsInterval);
      this.diagnosticsInterval = null;
    }

    // Increment lifecycle gen to reject delayed callbacks
    this.lifecycleGen++;

    try {
      if (this.state === 'capturing') {
        await this.stopCapture();
      }
      if (this.control?.isConnected()) {
        await this.control!.shutdown();
      }
    } catch (err) {
      // Surface but don't block shutdown
      this.lastError_ = err instanceof Error ? err.message : String(err);
    }
    await this.cleanup();
    this.state = 'disconnected';
    // Keep shuttingDown_ = true permanently to prevent unintended restarts
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

  async getEndpointDiagnostics(): Promise<any> {
    this.ensureReady();
    return this.control!.sendRequest('getEndpointDiagnostics');
  }

  async getPipelineSnapshot(): Promise<PcmPipelineSnapshot> {
    let helperDiag: HelperDiagnostics | null = null;
    try {
      if (this.state === 'ready' || this.state === 'capturing') {
        helperDiag = await this.control!.getDiagnostics();
      }
    } catch { /* best effort */ }

    // Collect helper binary provenance at runtime
    let helperPath = '';
    let helperSize = 0;
    let helperMtime = '';
    let helperSha256 = '';
    let helperReportedCommit: string | undefined;
    let helperReportedDirty: boolean | undefined;
    let helperReportedProtocolVersion: string | undefined;
    let helperReportedBuildConfig: string | undefined;
    let expectedCommit: string | undefined;
    let provenanceMismatch: string | undefined;

    try {
      const stats = fs.statSync(this.config.helperPath);
      helperPath = this.config.helperPath;
      helperSize = stats.size;
      helperMtime = stats.mtime.toISOString();
      // SHA-256 hash of the binary
      const hash = crypto.createHash('sha256');
      hash.update(fs.readFileSync(this.config.helperPath));
      helperSha256 = hash.digest('hex');
    } catch { /* best effort */ }

    // Extract helper-reported provenance from diagnostics
    const helperBuildInfo = (helperDiag as any)?.buildInfo;
    if (helperBuildInfo) {
      helperReportedCommit = helperBuildInfo.gitCommit;
      helperReportedDirty = helperBuildInfo.gitDirty === 'true';
      helperReportedProtocolVersion = helperBuildInfo.protocolVersion ?? (helperDiag as any)?.protocolVersion;
      helperReportedBuildConfig = helperBuildInfo.buildConfig;
    }

    // Build expected commit from (hypothetical) packaged metadata
    // In development, this is the current repo HEAD
    try {
      const { execSync } = await import('child_process');
      expectedCommit = execSync('git rev-parse --short HEAD', {
        cwd: path.resolve(_dirname, '..', '..', '..', '..'),
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
    } catch { /* best effort */ }

    if (helperReportedCommit && expectedCommit && helperReportedCommit !== 'unknown' && expectedCommit !== 'unknown') {
      if (helperReportedCommit !== expectedCommit) {
        provenanceMismatch = `helper-commit=${helperReportedCommit} expected=${expectedCommit}`;
        diag(`PROVENANCE MISMATCH: ${provenanceMismatch}`);
      }
    }

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
      filteredMonitorDiagnostics: helperDiag
        ? (helperDiag as any).filteredMonitorDiagnostics ?? undefined
        : undefined,
      endpointDiagnostics: helperDiag
        ? (helperDiag as any).endpointDiagnostics ?? undefined
        : undefined,
      // Helper binary provenance
      helperBinaryPath: helperPath,
      helperBinarySize: helperSize,
      helperBinaryMtime: helperMtime,
      helperBinarySha256: helperSha256,
      helperReportedCommit: helperReportedCommit,
      helperReportedDirty: helperReportedDirty,
      helperReportedProtocolVersion: helperReportedProtocolVersion,
      helperReportedBuildConfig: helperReportedBuildConfig,
      expectedCommit: expectedCommit,
      provenanceMismatch: provenanceMismatch,
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
      let settled = false;

      const tryConnect = () => {
        // If shutdown was requested, stop retrying
        if (this.shuttingDown_ || this.pendingCleanup === 'permanent-shutdown') {
          if (!settled) { settled = true; reject(new Error('Shutdown requested during PCM connect')); }
          return;
        }

        const elapsed = Date.now() - start;
        attempts++;
        if (elapsed > timeoutMs) {
          diag(`PCM CONNECT TIMEOUT after ${elapsed}ms (${attempts} attempts)`);
          if (!settled) { settled = true; reject(new Error(`Timeout connecting to PCM pipe after ${elapsed}ms`)); }
          return;
        }

        const socket = net.connect(this.pcmPipeName);

        const onError = () => {
          socket.destroy();
          diag(`PCM connect attempt ${attempts} failed at ${elapsed}ms`);
          this.connectionRetryTimer = setTimeout(tryConnect, 200);
        };

        socket.once('connect', () => {
          socket.removeListener('error', onError);
          diag(`PCM pipe connected at ${elapsed}ms`);
          this.pcmSocket = socket;
          this.setupPcmSocket(socket);
          if (!settled) { settled = true; resolve(); }
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
          // If lifecycleGen has advanced since capture started, this packet is from
          // a superseded generation — silently drop (expected after stopCapture)
          if (this.lifecycleGen !== this.captureLifecycleGen) {
            return;
          }
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

    // Don't restart if we're shutting down or permanent shutdown
    if (this.shuttingDown_ || this.pendingCleanup === 'permanent-shutdown') return;

    if (wasRunning && this.restartCount < this.maxRestarts) {
      this.restartCount++;
      this.stats.helperRestarts = this.restartCount;
      diag(`Scheduling restart attempt ${this.restartCount}/${this.maxRestarts} in ${this.restartCooldownMs}ms`);
      this.restartTimer = setTimeout(() => this.attemptRestart(), this.restartCooldownMs);
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
    // Re-check shutdown / permanent-shutdown state before restarting
    if (this.shuttingDown_ || this.pendingCleanup === 'permanent-shutdown') {
      diag('Restart cancelled — manager is shutting down');
      this.state = 'disconnected';
      return;
    }

    // Prevent concurrent restart attempts
    if (this.pendingCleanup === 'restart') {
      diag('Restart already in progress — skipping duplicate');
      return;
    }

    const gen = this.lifecycleGen;
    this.pendingCleanup = 'restart';

    // Clear the timer handle since it fired
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Clean up without setting shuttingDown_ (restart is intentional, not permanent shutdown)
    await this.cleanup(false);

    // Re-check lifecycleGen after async cleanup — abort if superseded
    if (this.lifecycleGen !== gen) {
      diag('Restart cancelled — lifecycleGen changed during cleanup');
      this.pendingCleanup = null;
      return;
    }

    // Re-check shutdown state after async cleanup
    if (this.shuttingDown_ || this.pendingCleanup === 'permanent-shutdown') {
      diag('Restart cancelled — shutdown requested during cleanup');
      this.state = 'disconnected';
      this.pendingCleanup = null;
      return;
    }

    this.state = 'connecting';
    this.sessionId = this.generateId();
    this.authToken = this.generateId();
    this.ctrlPipeName = `\\\\.\\pipe\\screenlink-${this.sessionId}-ctrl`;
    this.pcmPipeName = `\\\\.\\pipe\\screenlink-${this.sessionId}-pcm`;

    try {
      await this.spawnHelper();

      // Re-check lifecycleGen immediately before proceeding after spawn
      if (this.lifecycleGen !== gen) {
        diag('Restart cancelled — lifecycleGen changed after spawn');
        if (this.helper) {
          this.helper.kill();
          this.helper = null;
        }
        this.state = 'disconnected';
        this.pendingCleanup = null;
        return;
      }

      this.control = new ControlClient(this.ctrlPipeName, this.sessionId, this.authToken);
      await this.control.connect(5000);
      await this.control.hello();
      await this.connectPcmPipe();
      this.startDiagnostics();

      // Reset retry count only after handshake, PCM connection, AND diagnostics all succeed
      this.state = 'ready';
      this.restartCount = 0;
      this.pendingCleanup = null;
      diag(`Restart succeeded — helper is ready`);
    } catch (err) {
      this.state = 'error';
      this.lastError_ = err instanceof Error ? err.message : String(err);
      this.pendingCleanup = null; // Allow future restart attempts
    }
  }

  /**
   * Wait for the helper process to exit with a deadline.
   * Falls back to force kill if the process doesn't exit within the timeout.
   * Resolves only from observed exit event — does not treat helper.killed as proof of exit.
   * Does NOT null helper ownership — caller is responsible for that.
   */
  private async awaitHelperExit(deadlineMs: number = 5000): Promise<{success: boolean; exitCode: number | null; signal: string | null}> {
    if (!this.helper) {
      return { success: true, exitCode: null, signal: null };
    }

    const helper = this.helper;

    // If helper already exited before we set up the listener, return immediately
    if (helper.exitCode !== null) {
      return { success: true, exitCode: helper.exitCode, signal: helper.signalCode };
    }

    let timeoutHandle: NodeJS.Timeout | null = null;
    let sigkillTimeoutHandle: NodeJS.Timeout | null = null;

    const exitPromise = new Promise<{code: number | null; signal: string | null}>((resolve) => {
      helper.once('exit', (code, signal) => {
        // Clear any pending timeout handles in every path
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (sigkillTimeoutHandle !== null) clearTimeout(sigkillTimeoutHandle);
        resolve({ code, signal });
      });
    });

    try {
      // Send graceful termination signal
      if (helper.pid) {
        process.kill(helper.pid, 'SIGTERM');
      } else {
        helper.kill();
      }

      const timeoutPromise = new Promise<{code: number | null; signal: string | null}>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Helper exit timeout')), deadlineMs);
      });

      const result = await Promise.race([exitPromise, timeoutPromise]);
      diag('Helper exited gracefully');
      return { success: true, exitCode: result.code, signal: result.signal };
    } catch {
      // Timeout — force kill with SIGKILL
      diag('Helper exit timeout — sending SIGKILL');
      try {
        helper.kill('SIGKILL');
      } catch { /* ignore */ }

      // After SIGKILL, wait with a second bounded deadline
      const sigkillDeadline = 3000;
      const sigkillTimeoutPromise = new Promise<never>((_, reject) => {
        sigkillTimeoutHandle = setTimeout(() => reject(new Error('SIGKILL exit timeout')), sigkillDeadline);
      });

      try {
        const result = await Promise.race([exitPromise, sigkillTimeoutPromise]);
        if (sigkillTimeoutHandle !== null) clearTimeout(sigkillTimeoutHandle);
        diag('Helper exited after SIGKILL');
        return { success: true, exitCode: result.code, signal: result.signal };
      } catch {
        diag('WARNING: helper may still be running after SIGKILL timeout');
        return { success: false, exitCode: null, signal: 'SIGKILL' };
      }
    }
  }

  private async cleanup(setShuttingDown: boolean = true): Promise<void> {
    // Serialize cleanup — if one is already in progress, await it
    if (this.cleanupPromise !== null) {
      diag('cleanup already in progress — awaiting');
      await this.cleanupPromise;
      return;
    }

    const run = async (): Promise<void> => {
      this.pcmBridge.detach();

      if (this.diagnosticsInterval !== null) {
        clearInterval(this.diagnosticsInterval);
        this.diagnosticsInterval = null;
      }

      // Cancel any pending restart timer
      if (this.restartTimer !== null) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }

      // Cancel connection retry timer
      if (this.connectionRetryTimer !== null) {
        clearTimeout(this.connectionRetryTimer);
        this.connectionRetryTimer = null;
      }

      if (setShuttingDown) {
        this.restartCount = this.maxRestarts; // Prevent further automatic restarts
        this.shuttingDown_ = true;
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

      // Await helper exit with deadline (resolve only from observed exit event)
      if (this.helper) {
        await this.awaitHelperExit(5000);
      }
      this.helper = null;
    };

    this.cleanupPromise = run();
    try {
      await this.cleanupPromise;
    } finally {
      this.cleanupPromise = null;
    }
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
