import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { BrowserWindow, MessageChannelMain } from "electron";
import { VIDEO_ENHANCER_PROTOCOL_VERSION } from "./video-enhancer-protocol.js";
import type { VideoEnhancerConfig, VideoEnhancerConfigureResult, VideoEnhancerDiagnosticsResponse, ConfigureNativeResponse, NativeBenchmarkConfig, NativeBenchmarkStatusResponse, NativeBenchmarkResultResponse, ShmDropCounters } from "./video-enhancer-protocol.js";
import { createAppliedNvidiaConfig } from "@screenlink/shared";
import type { AppliedNvidiaConfig } from "@screenlink/shared";
import { getVideoEnhancerHelperPath } from "./helper-path.js";
import { SharedMemoryFrameRing, SlotState } from "./SharedMemoryFrameRing.js";

// --- Types ──────────────────────────────────────────────────────────

export type VideoHelperState =
  | "disconnected"
  | "connecting"
  | "handshaking"
  | "ready"
  | "processing"
  | "error";

export interface VideoHelperCallbacks {
  onStateChange?: (state: VideoHelperState) => void;
  onError?: (reason: string) => void;
  onFrameComplete?: (generation: number, frameSequence: number) => void;
}

// Frame response type
interface FrameResponse {
  generation: number;
  sequence: number;
  pixels: Uint8Array;
  width: number;
  height: number;
  configurationId?: number;
  appliedQualityLevel?: number;
  nativeInputReceiveMs?: number;
  nativeUploadMs?: number;
  nativeEffectMs?: number;
  nativeDownloadMs?: number;
  nativePreWriteTotalMs?: number;
}

// ─── Client lease ─────────────────────────────────────────────────────

interface ClientInfo {
  clientId: string;
  generation: number;
  framePort: Electron.MessagePortMain | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Manager lifecycle logging ────────────────────────────────────────

let _lifecycleLogging = true;

function helperLifecycleLog(event: string, details?: Record<string, unknown>): void {
  if (!_lifecycleLogging) return;
  if (details && Object.keys(details).length > 0) {
    console.log(`[lifecycle:VideoHelper] ${event}`, JSON.stringify(details));
  } else {
    console.log(`[lifecycle:VideoHelper] ${event}`);
  }
}

// ─── Frame pipe parser (one persistent instance per frame socket) ─────

const FRAME_MAGIC = 0x464C4156454D5246n;
const HEADER_SIZE = 104;

enum ParserState {
  Header = 0,
  Payload = 1,
}

interface PendingFrame {
  generation: number;
  frameSequence: number;
  resolve: (result: FrameResponse | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** @internal exported for testing only */
export class FramePipeParser {
  private state = ParserState.Header;
  private headerBuf = Buffer.alloc(0);
  private payloadBuf: Buffer | null = null;
  private payloadRead = 0;
  private pending: PendingFrame | null = null;
  private header: {
    generation: number;
    frameSequence: number;
    resultCode: number;
    payloadBytes: number;
    width: number;
    height: number;
    /** Reuses slotIndex field in wire header for configurationId */
    configurationId: number;
    /** Reuses flags field in wire header for appliedQualityLevel */
    appliedQualityLevel: number;
    nativeInputReceiveUs: number;
    nativeUploadUs: number;
    nativeEffectUs: number;
    nativeDownloadUs: number;
    nativeOutputWriteUs: number;
    nativeTotalUs: number;
  } | null = null;

  reset(): void {
    this.state = ParserState.Header;
    this.headerBuf = Buffer.alloc(0);
    this.payloadBuf = null;
    this.payloadRead = 0;
    this.header = null;
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.resolve(null);
      this.pending = null;
    }
  }

  /** Install a pending correlation before writing. */
  installPending(
    generation: number,
    frameSequence: number,
    resolve: (result: FrameResponse | null) => void,
    timeoutMs: number,
  ): { timeout: ReturnType<typeof setTimeout> } {
    if (this.pending) {
      // Should not happen — only one in-flight per parser
      clearTimeout(this.pending.timeout);
      this.pending.resolve(null);
    }
    const timeout = setTimeout(() => {
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        this.reset();
        p.resolve(null);
      }
    }, timeoutMs);
    this.pending = { generation, frameSequence, resolve, timeout };
    return { timeout };
  }

  /** Feed incoming chunk data. Returns FrameResponse when a complete result is parsed. */
  feed(chunk: Buffer): FrameResponse | null {
    if (this.state === ParserState.Header) {
      this.headerBuf = Buffer.concat([this.headerBuf, chunk]);

      while (this.headerBuf.length >= HEADER_SIZE) {
        const magic = this.headerBuf.readBigUInt64LE(0);
        if (magic !== FRAME_MAGIC) {
          // Invalid magic — reset
          this.reset();
          return null;
        }

        const resultCode = this.headerBuf.readUInt32LE(76);
        const payloadBytes = this.headerBuf.readUInt32LE(60);

        if (payloadBytes > 200 * 1024 * 1024) {
          // Too large — protocol error
          this.reset();
          return null;
        }

        this.header = {
          generation: this.headerBuf.readUInt32LE(16),
          frameSequence: this.headerBuf.readUInt32LE(20),
          resultCode,
          payloadBytes,
          width: this.headerBuf.readUInt32LE(32),
          height: this.headerBuf.readUInt32LE(36),
          configurationId: this.headerBuf.readUInt32LE(56),  // slotIndex field, reused
          appliedQualityLevel: this.headerBuf.readUInt32LE(72), // flags field, reused
          nativeInputReceiveUs: this.headerBuf.readUInt32LE(80),
          nativeUploadUs: this.headerBuf.readUInt32LE(84),
          nativeEffectUs: this.headerBuf.readUInt32LE(88),
          nativeDownloadUs: this.headerBuf.readUInt32LE(92),
          nativeOutputWriteUs: this.headerBuf.readUInt32LE(96),
          nativeTotalUs: this.headerBuf.readUInt32LE(100),
        };

        // Move past header
        const extra = this.headerBuf.length - HEADER_SIZE;
        this.headerBuf = this.headerBuf.subarray(HEADER_SIZE);

        if (this.header.resultCode !== 1) {
          // Error or pending
          const p = this.pending;
          this.pending = null;
          if (p) {
            clearTimeout(p.timeout);
            p.resolve(null);
          }
          this.reset();
          return null;
        }

        if (payloadBytes === 0) {
          // Empty payload
          const p = this.pending;
          this.pending = null;
          if (p) {
            clearTimeout(p.timeout);
            p.resolve(null);
          }
          this.reset();
          return null;
        }

        this.state = ParserState.Payload;
        this.payloadBuf = Buffer.alloc(payloadBytes);
        this.payloadRead = 0;

        // Copy any already-in-buffer payload bytes
        if (extra > 0) {
          const toCopy = Math.min(extra, payloadBytes);
          this.headerBuf.copy(this.payloadBuf, 0, 0, toCopy);
          this.payloadRead = toCopy;
          this.headerBuf = this.headerBuf.subarray(toCopy);
        }

        // Check if payload complete
        if (this.payloadRead >= payloadBytes) {
          // Capture leftover headerBuf data before emitResult() resets it
          const leftover = this.headerBuf.length > 0 ? this.headerBuf : null;
          const result = this.emitResult();
          // Re-feed any remaining bytes (next frame header) after reset
          if (leftover) {
            return this.feed(leftover) ?? result;
          }
          return result;
        }
      }
      return null;
    }

    // Payload state
    if (this.state === ParserState.Payload && this.payloadBuf && this.header) {
      const remaining = this.payloadBuf.length - this.payloadRead;
      const toCopy = Math.min(remaining, chunk.length);
      chunk.copy(this.payloadBuf, this.payloadRead, 0, toCopy);
      this.payloadRead += toCopy;
      const leftover = chunk.subarray(toCopy);

      if (this.payloadRead >= this.payloadBuf.length) {
        const result = this.emitResult();
        // If there's leftover data, recurse for potential multiple responses
        if (leftover.length > 0) {
          return this.feed(leftover) ?? result;
        }
        return result;
      }
    }

    return null;
  }

  private emitResult(): FrameResponse | null {
    if (!this.header || !this.payloadBuf) return null;

    const h = this.header;
    const p = this.pending;

    // Check generation/sequence match BEFORE clearing state
    if (p && (h.generation !== p.generation || h.frameSequence !== p.frameSequence)) {
      // Mismatch — stale or out-of-order response; resolve pending with null
      this.pending = null;
      if (p) {
        clearTimeout(p.timeout);
        p.resolve(null);
      }
      this.reset();
      return null;
    }

    // Build result BEFORE resetting state
    const result: FrameResponse = {
      generation: h.generation,
      sequence: h.frameSequence,
      pixels: this.payloadBuf,
      width: h.width,
      height: h.height,
      configurationId: h.configurationId > 0 ? h.configurationId : undefined,
      appliedQualityLevel: h.appliedQualityLevel > 0 ? h.appliedQualityLevel : undefined,
      nativeInputReceiveMs: h.nativeInputReceiveUs > 0 ? h.nativeInputReceiveUs / 1000 : undefined,
      nativeUploadMs: h.nativeUploadUs > 0 ? h.nativeUploadUs / 1000 : undefined,
      nativeEffectMs: h.nativeEffectUs > 0 ? h.nativeEffectUs / 1000 : undefined,
      nativeDownloadMs: h.nativeDownloadUs > 0 ? h.nativeDownloadUs / 1000 : undefined,
      nativePreWriteTotalMs: h.nativeTotalUs > 0 ? h.nativeTotalUs / 1000 : undefined,
    };

    // Clear pending before resetting
    this.pending = null;
    if (p) {
      clearTimeout(p.timeout);
      p.resolve(result);
    }
    // reset() clears headerBuf, payloadBuf, header; result still holds payloadBuf ref
    this.reset();
    return result;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }
}

// ─── Manager ─────────────────────────────────────────────────────────

export class VideoHelperManager {
  // Core state
  private helper: ChildProcess | null = null;
  private state: VideoHelperState = "disconnected";
  private callbacks: VideoHelperCallbacks = {};

  // Session identity
  private sessionId = "";
  private authToken = "";

  // Pipe names
  private ctrlPipeName = "";

  // Control client
  private controlSocket: net.Socket | null = null;

  // Lifecycle guards
  private lifecycleGeneration = 0;
  private shuttingDown_ = false;
  private restartAttempts = 0;
  private readonly maxRestarts = 3;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  // Last config for restart
  private lastConfig: VideoEnhancerConfig | null = null;

  // Phase 2: Applied config contract
  private appliedConfig: AppliedNvidiaConfig | null = null;
  private configurationId = 0;
  private effectInstanceId = 0;

  // All callers share one in-progress helper startup.
  private startPromise: Promise<boolean> | null = null;

  // Diagnostics interval
  private diagnosticsInterval: ReturnType<typeof setInterval> | null = null;

  // ── Client lease system ─────────────────────────────────────────────
  private clients = new Map<string, ClientInfo>();
  private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly IDLE_SHUTDOWN_MS = 2000;

  // ── Frame pipe ──────────────────────────────────────────────────────
  private framePipeClient: net.Socket | null = null;
  private framePipeConnected = false;
  private framePipeName = "";
  private frameParser: FramePipeParser | null = null;

  // ── Shared memory ring (file-backed, zero-copy transport) ──────────
  private shmRing: SharedMemoryFrameRing | null = null;
  private shmAvailable = false;
  // Slice 4: Async SHM completion tracking (bounded 3-slot, latest-frame-wins)
  private readonly kShmCompletionTimeoutMs = 8000;
  private pendingShmCompletions = new Map<number, {
    slotIndex: number;
    generation: number;
    frameSequence: number;
    resolve: (result: {
      generation: number;
      sequence: number;
      pixels: Uint8Array;
      width: number;
      height: number;
      configurationId?: number;
      appliedQualityLevel?: number;
      nativeInputReceiveMs?: number;
      nativeUploadMs?: number;
      nativeEffectMs?: number;
      nativeDownloadMs?: number;
      nativePreWriteTotalMs?: number;
    } | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Slice 4: Deterministic SHM drop counters
  private shmDropCounters: ShmDropCounters = {
    shmSlotBusyDrops: 0,
    shmCompletionTimeouts: 0,
    shmRestartDrops: 0,
    shmTotalSubmitted: 0,
    shmTotalCompleted: 0,
  };

  // ── Frame port management ────────────────────────────────────────────
  private framePorts = new Map<string, Electron.MessagePortMain>();

  constructor() {
    // Lazy initialization
  }

  // ── Client lease API ─────────────────────────────────────────────────

  /**
   * Acquire an opaque clientId for the renderer.
   * Extends/creates the idle shutdown timer.
   */
  acquireClient(): string {
    this.cancelIdleShutdown();
    const clientId = randomUUID();
    const client: ClientInfo = {
      clientId,
      generation: 0,
      framePort: null,
      idleTimer: null,
    };
    this.clients.set(clientId, client);
    helperLifecycleLog("clientAcquire", { clientId, activeClients: this.clients.size });
    return clientId;
  }

  /**
   * Release a client lease. Idempotent. Closes only that client's frame port.
   * Stops the helper only if the idle shutdown timer expires without reacquire.
   */
  releaseClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      helperLifecycleLog("clientRelease (stale)", { clientId });
      return; // Stale release — idempotent, cannot stop newer resources
    }

    // Close this client's frame port only
    this.closeClientFramePort(clientId);
    this.clients.delete(clientId);
    helperLifecycleLog("clientRelease", { clientId, activeClients: this.clients.size });

    // If no clients remain, start the idle shutdown grace period
    if (this.clients.size === 0) {
      this.startIdleShutdown();
    }
  }

  /**
   * Validate that a clientId is still active (has an active lease).
   */
  isClientActive(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  // ── Idle shutdown ───────────────────────────────────────────────────

  private startIdleShutdown(): void {
    this.cancelIdleShutdown();
    this.idleShutdownTimer = setTimeout(() => {
      helperLifecycleLog("idleShutdown", { lifecycleGeneration: this.lifecycleGeneration });
      this.stop(false).catch(() => {});
    }, this.IDLE_SHUTDOWN_MS);
  }

  private cancelIdleShutdown(): void {
    if (this.idleShutdownTimer) {
      clearTimeout(this.idleShutdownTimer);
      this.idleShutdownTimer = null;
    }
  }

  // ── Applied config access ────────────────────────────────────────────

  /** Get the latest applied configuration, or null if not yet configured. */
  getAppliedConfig(): AppliedNvidiaConfig | null {
    return this.appliedConfig;
  }

  /**
   * Parse the native configure response and build the internal AppliedNvidiaConfig.
   * Called after a successful native configure/start.
   */
  private buildAppliedConfig(
    config: VideoEnhancerConfig,
    nativeResponse: ConfigureNativeResponse,
    success: boolean,
  ): AppliedNvidiaConfig {
    const now = Date.now();
    // Prefer response fields when available (native side now returns them),
    // fall back to our own tracking for backward compat.
    const cfgId = typeof nativeResponse.configurationId === "number"
      ? nativeResponse.configurationId
      : this.configurationId;
    const effId = typeof nativeResponse.effectInstanceId === "number"
      ? nativeResponse.effectInstanceId
      : this.effectInstanceId;
    const ql = this.lastConfig
      ? this.lastConfig.qualityLevel
      : config.qualityLevel;
    const mode = this.lastConfig
      ? this.lastConfig.processingMode
      : config.processingMode;

    const qualNum: Record<string, number> = { low: 0, medium: 1, high: 2, ultra: 3 };
    const canonicalQlBase: Record<string, number> = { vsr: 1, denoise: 8, deblur: 12, "high-bitrate": 16 };
    const appliedQl = typeof nativeResponse.appliedQualityLevel === "number"
      ? nativeResponse.appliedQualityLevel
      : ((canonicalQlBase[mode] ?? 1) + (qualNum[ql] ?? 2));

    return createAppliedNvidiaConfig({
      configurationId: cfgId,
      effectInstanceId: effId,
      requestedMode: (typeof nativeResponse.requestedMode === "string" ? nativeResponse.requestedMode : config.processingMode),
      requestedQuality: (typeof nativeResponse.requestedQuality === "string" ? nativeResponse.requestedQuality : config.qualityLevel),
      appliedMode: (typeof nativeResponse.appliedMode === "string" ? nativeResponse.appliedMode : mode),
      appliedQuality: (typeof nativeResponse.appliedQuality === "string" ? nativeResponse.appliedQuality : ql),
      appliedQualityLevel: appliedQl,
      inputWidth: typeof nativeResponse.inputWidth === "number" ? nativeResponse.inputWidth : config.inputWidth,
      inputHeight: typeof nativeResponse.inputHeight === "number" ? nativeResponse.inputHeight : config.inputHeight,
      outputWidth: typeof nativeResponse.outputWidth === "number" ? nativeResponse.outputWidth : config.outputWidth,
      outputHeight: typeof nativeResponse.outputHeight === "number" ? nativeResponse.outputHeight : config.outputHeight,
      inputPixelFormat: typeof nativeResponse.inputPixelFormat === "string" ? nativeResponse.inputPixelFormat : config.pixelFormat,
      effectLoadSucceeded: success && (nativeResponse.effectLoadSucceeded !== false),
      effectLoadCount: typeof nativeResponse.effectLoadCount === "number"
        ? nativeResponse.effectLoadCount
        : (success ? 1 : 0),
      configuredAt: typeof nativeResponse.configuredAt === "number"
        ? nativeResponse.configuredAt
        : now,
    });
  }

  // ── Public API ──────────────────────────────────────────────────────

  async start(config: VideoEnhancerConfig): Promise<VideoEnhancerConfigureResult> {
    if (this.state === "ready" || this.state === "processing") {
      const current = this.lastConfig;

      const configurationMatches =
        current !== null &&
        current.inputWidth === config.inputWidth &&
        current.inputHeight === config.inputHeight &&
        current.outputWidth === config.outputWidth &&
        current.outputHeight === config.outputHeight &&
        current.processingMode === config.processingMode &&
        current.qualityLevel === config.qualityLevel &&
        current.pixelFormat === config.pixelFormat;

      if (configurationMatches) {
        helperLifecycleLog("start (idempotent)", {
          lifecycleGeneration: this.lifecycleGeneration,
        });
        return { success: true, appliedConfig: this.appliedConfig ?? undefined };
      }

      helperLifecycleLog("reconfigure via start", {
        lifecycleGeneration: this.lifecycleGeneration,
        inputWidth: config.inputWidth,
        inputHeight: config.inputHeight,
        processingMode: config.processingMode,
      });
      return this.reconfigure(config);
    }

    if (this.startPromise) {
      console.log(
        `[VideoHelper] Joining startup already in progress (${this.state})`,
      );
      const ok = await this.startPromise;
      return { success: ok, appliedConfig: ok ? (this.appliedConfig ?? undefined) : undefined };
    }

    const pendingStartup = this.startHelper(config);
    this.startPromise = pendingStartup;

    try {
      const ok = await pendingStartup;
      return { success: ok, appliedConfig: ok ? (this.appliedConfig ?? undefined) : undefined };
    }
    finally {
      if (this.startPromise === pendingStartup) {
        this.startPromise = null;
      }
    }
  }

  /**
   * Submit a frame for processing via the persistent frame pipe.
   * Serializes header as its own Buffer and writes header + pixel data
   * separately with backpressure handling.
   */
  async submitFrame(
    generation: number,
    frameSequence: number,
    frameData: Uint8Array,
    inputWidth: number,
    inputHeight: number,
  ): Promise<{
    generation: number;
    sequence: number;
    pixels: Uint8Array;
    width: number;
    height: number;
    mainInputHandlingMs?: number;
    requestWriteMs?: number;
    responseWaitMs?: number;
    mainHandlerTotalMs?: number;
    /** Phase 3: configurationId from output header (slotIndex field reused) */
    configurationId?: number;
    /** Phase 3: appliedQualityLevel from output header (flags field reused) */
    appliedQualityLevel?: number;
    nativeInputReceiveMs?: number;
    nativeUploadMs?: number;
    nativeEffectMs?: number;
    nativeDownloadMs?: number;
    nativePreWriteTotalMs?: number;
  } | null> {
    if (this.state !== "ready" && this.state !== "processing") return null;

    const mainStart = performance.now();

    try {
      const config = this.lastConfig;
      const outW = config?.outputWidth ?? inputWidth;
      const outH = config?.outputHeight ?? inputHeight;
      const mode = config?.processingMode ?? "vsr";
      const qual = config?.qualityLevel ?? "high";
      const modeNum = mode === "vsr" ? 1 : mode === "high-bitrate" ? 2 : mode === "denoise" ? 3 : 4;
      const qualNum = qual === "low" ? 0 : qual === "medium" ? 1 : qual === "ultra" ? 3 : 2;

      const afterInputHandling = performance.now();
      const mainInputHandlingMs = afterInputHandling - mainStart;

      // ── Shared memory ring path ────────────────────────────────────────
      if (this.shmAvailable && this.shmRing) {
        return this.submitFrameViaShm(
          generation, frameSequence, frameData,
          inputWidth, inputHeight,
          outW, outH, modeNum, qualNum,
          mainInputHandlingMs, mainStart,
        );
      }

      // ── Named-pipe fallback path ───────────────────────────────────────
      // Ensure persistent frame pipe connection
      if (!this.framePipeConnected) {
        const connected = await this.connectFramePipe();
        if (!connected) return null;
      }

      // Serialize header into its own Buffer (no Buffer.concat with pixel data)
      const headerBuf = Buffer.alloc(HEADER_SIZE);
      let off = 0;
      headerBuf.writeBigUInt64LE(BigInt("0x464C4156454D5246"), off); off += 8;
      headerBuf.writeUInt32LE(HEADER_SIZE, off); off += 4;
      headerBuf.writeUInt32LE(1, off); off += 4; // wireVersion
      headerBuf.writeUInt32LE(generation, off); off += 4;
      headerBuf.writeUInt32LE(frameSequence, off); off += 4;
      headerBuf.writeBigUInt64LE(BigInt(Math.round(performance.now() * 1000)), off); off += 8;
      headerBuf.writeUInt32LE(inputWidth, off); off += 4;
      headerBuf.writeUInt32LE(inputHeight, off); off += 4;
      headerBuf.writeUInt32LE(inputWidth * 4, off); off += 4; // inputStride
      headerBuf.writeUInt32LE(2, off); off += 4; // pixelFormat = RGBA8
      headerBuf.writeUInt32LE(outW, off); off += 4;
      headerBuf.writeUInt32LE(outH, off); off += 4;
      headerBuf.writeUInt32LE(0, off); off += 4; // slotIndex
      headerBuf.writeUInt32LE(frameData.byteLength, off); off += 4; // payloadBytes
      headerBuf.writeUInt32LE(modeNum, off); off += 4;
      headerBuf.writeUInt32LE(qualNum, off); off += 4;
      headerBuf.writeUInt32LE(0, off); off += 4; // flags
      headerBuf.writeUInt32LE(0, off); off += 4; // resultCode
      headerBuf.writeUInt32LE(0, off); off += 4; // nativeInputReceiveUs
      headerBuf.writeUInt32LE(0, off); off += 4; // nativeUploadUs
      headerBuf.writeUInt32LE(0, off); off += 4; // nativeEffectUs
      headerBuf.writeUInt32LE(0, off); off += 4; // nativeDownloadUs
      headerBuf.writeUInt32LE(0, off); off += 4; // nativeOutputWriteUs (always 0 in per-frame)
      headerBuf.writeUInt32LE(0, off);      // nativeTotalUs

      const socket = this.framePipeClient;
      if (!socket || !socket.writable) return null;

      // Create zero-copy Buffer view from frameData
      const pixelBuf = Buffer.from(frameData.buffer, frameData.byteOffset, frameData.byteLength);

      // Install pending correlation BEFORE writing, then write header + payload separately.
      // requestWriteMs measures actual write accept duration (header + payload write callbacks).
      // responseWaitMs measures from write completion to result arrival (native processing + pipe round-trip).
      const writeStart = performance.now();
      let writeEndTs = writeStart;

      const result = await new Promise<FrameResponse | null>((resolve) => {
        if (!this.frameParser) {
          resolve(null);
          return;
        }

        this.frameParser.installPending(generation, frameSequence, resolve, 5000);

        // Write header first, then payload. The pixel write callback records writeEndTs.
        socket!.write(headerBuf, (err) => {
          if (err) { resolve(null); return; }
          socket!.write(pixelBuf, (writeErr) => {
            writeEndTs = performance.now();
            if (writeErr) { resolve(null); return; }
            // Both writes accepted; result arrives asynchronously via parser
          });
        });
      });

      const afterResult = performance.now();
      const actualRequestWriteMs = writeEndTs - writeStart;
      const actualResponseWaitMs = afterResult - writeEndTs;
      const mainHandlerTotalMs = afterResult - mainStart;

      if (!result) return null;

      // Attach main-process timings
      return {
        generation: result.generation,
        sequence: result.sequence,
        pixels: result.pixels,
        width: result.width,
        height: result.height,
        mainInputHandlingMs,
        requestWriteMs: actualRequestWriteMs,
        responseWaitMs: actualResponseWaitMs,
        mainHandlerTotalMs,
        configurationId: result.configurationId,
        appliedQualityLevel: result.appliedQualityLevel,
        nativeInputReceiveMs: result.nativeInputReceiveMs,
        nativeUploadMs: result.nativeUploadMs,
        nativeEffectMs: result.nativeEffectMs,
        nativeDownloadMs: result.nativeDownloadMs,
        nativePreWriteTotalMs: result.nativePreWriteTotalMs,
      };
    } catch {
      return null;
    }
  }

  /**
   * Submit a frame via the shared memory ring (file-backed zero-copy).
   * Slice 4: Async bounded submission — writes to slot, sends `slotSubmit`
   * command, and returns a Promise that resolves when the native helper
   * sends a `slotCompleted` event.
   *
   * Up to 3 slots can be in-flight simultaneously (bounded by ring size).
   * If all slots are busy, the frame is dropped and `shmSlotBusyDrops` is
   * incremented.
   */
  private async submitFrameViaShm(
    generation: number,
    frameSequence: number,
    frameData: Uint8Array,
    inputWidth: number,
    inputHeight: number,
    outW: number,
    outH: number,
    modeNum: number,
    qualNum: number,
    mainInputHandlingMs: number,
    mainStart: number,
  ): Promise<{
    generation: number;
    sequence: number;
    pixels: Uint8Array;
    width: number;
    height: number;
    mainInputHandlingMs?: number;
    requestWriteMs?: number;
    responseWaitMs?: number;
    mainHandlerTotalMs?: number;
    configurationId?: number;
    appliedQualityLevel?: number;
    nativeInputReceiveMs?: number;
    nativeUploadMs?: number;
    nativeEffectMs?: number;
    nativeDownloadMs?: number;
    nativePreWriteTotalMs?: number;
  } | null> {
    const ring = this.shmRing;
    if (!ring) return null;

    // Find an empty slot
    let slotIndex = ring.findEmptySlot();
    if (slotIndex < 0) {
      // All 3 slots busy — increment drop counter and return null
      this.shmDropCounters.shmSlotBusyDrops++;
      return null;
    }

    const writeStart = performance.now();

    // Write input data to the slot (header + pixels)
    const writeOk = ring.writeInput(
      slotIndex,
      generation,
      frameSequence,
      inputWidth,
      inputHeight,
      inputWidth * 4,   // inputStride
      2,                // pixelFormat = RGBA8
      outW,
      outH,
      modeNum,
      qualNum,
      frameData,
    );
    if (!writeOk) return null;

    // Commit the slot: Empty → Submitted
    ring.writeControl(slotIndex, SlotState.Submitted);

    const afterWrite = performance.now();
    const requestWriteMs = afterWrite - writeStart;

    // Check that this slot doesn't already have a pending completion
    // (shouldn't happen if we found an empty slot, but guard anyway)
    if (this.pendingShmCompletions.has(slotIndex)) {
      ring.writeControl(slotIndex, SlotState.Empty);
      return null;
    }

    // Increment submitted counter
    this.shmDropCounters.shmTotalSubmitted++;

    // Create a pending completion entry — resolve when slotCompleted event arrives
    const result = await new Promise<{
      generation: number;
      sequence: number;
      pixels: Uint8Array;
      width: number;
      height: number;
      configurationId?: number;
      appliedQualityLevel?: number;
      nativeInputReceiveMs?: number;
      nativeUploadMs?: number;
      nativeEffectMs?: number;
      nativeDownloadMs?: number;
      nativePreWriteTotalMs?: number;
    } | null>((resolve) => {
      const timer = setTimeout(() => {
        // Timeout — remove pending entry, release slot, increment drop counter
        this.pendingShmCompletions.delete(slotIndex);
        this.shmDropCounters.shmCompletionTimeouts++;
        ring!.writeControl(slotIndex, SlotState.Empty);
        resolve(null);
      }, this.kShmCompletionTimeoutMs);

      this.pendingShmCompletions.set(slotIndex, {
        slotIndex,
        generation,
        frameSequence,
        resolve,
        timer,
      });

      // Send async slot submission (no response expected — completion arrives as event)
      this.sendCommand("slotSubmit", {
        slotIndex,
        generation,
        frameSequence,
      }).catch(() => {
        // If the command fails to send, clean up
        this.pendingShmCompletions.delete(slotIndex);
        clearTimeout(timer);
        ring!.writeControl(slotIndex, SlotState.Empty);
        resolve(null);
      });
    });

    const afterResponse = performance.now();
    const responseWaitMs = afterResponse - afterWrite;
    const mainHandlerTotalMs = afterResponse - mainStart;

    if (!result) return null;

    return {
      generation: result.generation,
      sequence: result.sequence,
      pixels: result.pixels,
      width: result.width,
      height: result.height,
      mainInputHandlingMs,
      requestWriteMs,
      responseWaitMs,
      mainHandlerTotalMs,
      configurationId: result.configurationId,
      appliedQualityLevel: result.appliedQualityLevel,
      nativeInputReceiveMs: result.nativeInputReceiveMs,
      nativeUploadMs: result.nativeUploadMs,
      nativeEffectMs: result.nativeEffectMs,
      nativeDownloadMs: result.nativeDownloadMs,
      nativePreWriteTotalMs: result.nativePreWriteTotalMs,
    };
  }

  /**
   * Reject all pending SHM completions (used during helper restart/shutdown).
   * All pending promises are resolved with null and slots are reset to Empty.
   * Increments shmRestartDrops for each rejected completion.
   */
  private rejectAllShmCompletions(reason: string): void {
    const count = this.pendingShmCompletions.size;
    if (count === 0) return;

    helperLifecycleLog("rejectShmCompletions", { reason, count });

    for (const [slotIndex, entry] of this.pendingShmCompletions) {
      clearTimeout(entry.timer);
      this.shmDropCounters.shmRestartDrops++;
      // Reset slot to Empty so it can be reused after restart
      if (this.shmRing) {
        this.shmRing.writeControl(slotIndex, SlotState.Empty);
      }
      entry.resolve(null);
    }
    this.pendingShmCompletions.clear();
  }

  // ── Renderer-owned shared input slots (Slice 5) ──────────────────────

  /**
   * References to renderer-created SharedArrayBuffer slots.
   * Registered once per generation; the renderer writes pixel data into
   * these slots directly, and per-frame frame-port messages carry only
   * metadata (slotIndex) rather than the full pixel buffer.
   */
  private rendererSlots: SharedArrayBuffer[] | null = null;

  /**
   * Register renderer-owned SharedArrayBuffer slots.
   * The renderer allocates 3 slots and registers them with the main process
   * once per generation. Per-frame submissions that include `slotIndex`
   * will read pixel data from these registered buffers instead of requiring
   * `frameData` in the port message.
   */
  registerRendererSlots(slots: SharedArrayBuffer[]): void {
    this.rendererSlots = slots;
    helperLifecycleLog("rendererSlotsRegister", {
      count: slots.length,
      byteSize: slots.reduce((s, b) => s + b.byteLength, 0),
    });
  }

  /**
   * Release renderer-owned shared slot references.
   */
  releaseRendererSlots(): void {
    this.rendererSlots = null;
    helperLifecycleLog("rendererSlotsRelease", {});
  }

  // ── Frame port management (clientId-gated) ─────────────────────────

  /**
   * Create a MessageChannel for zero-copy frame data transfer.
   * Associates the port with a clientId. If the client already has a port,
   * the old one is closed first.
   *
   * Supports two submission modes:
   *  1. Optimized path: renderer sends metadata-only (slotIndex) and the
   *     main process reads pixel data from registered SharedArrayBuffer slots.
   *  2. Fallback path: renderer sends full pixel data as structured clone
   *     (frameData ArrayBuffer). This is the explicit fallback when shared
   *     slots are unavailable.
   */
  createFramePort(clientId: string): Electron.MessagePortMain | null {
    const client = this.clients.get(clientId);
    if (!client) {
      helperLifecycleLog("framePortCreate (no client)", { clientId });
      return null;
    }

    // Close existing port for this client
    this.closeClientFramePort(clientId);

    helperLifecycleLog("framePortCreate", {
      clientId,
      lifecycleGeneration: this.lifecycleGeneration,
      state: this.state,
    });

    const { port1: rendererPort, port2: mainPort } = new MessageChannelMain();

    mainPort.on("message", async (evt: Electron.MessageEvent) => {
      const msg = evt.data as {
        clientId?: string;
        generation: number;
        frameSequence: number;
        inputWidth: number;
        inputHeight: number;
        // Fallback path: full pixel data as structured clone
        frameData?: ArrayBuffer;
        // Optimized path: slot index into registered SharedArrayBuffer
        slotIndex?: number;
      };

      // Validate message from this client only
      if (msg.clientId !== clientId) {
        mainPort.postMessage({ error: "Client ID mismatch" });
        return;
      }

      // Check if this client is still active
      if (!this.clients.has(clientId)) {
        mainPort.postMessage({ error: "Client released" });
        return;
      }

      if (
        typeof msg.generation !== "number" ||
        typeof msg.frameSequence !== "number" ||
        typeof msg.inputWidth !== "number" ||
        typeof msg.inputHeight !== "number"
      ) {
        mainPort.postMessage({ error: "Invalid frame message" });
        return;
      }

      // ── Shared-slot optimized path (no frameData in message) ──────────
      const rendererSlots = this.rendererSlots;
      const slotIndex = msg.slotIndex;
      const useSharedSlot =
        typeof slotIndex === "number" &&
        rendererSlots !== null &&
        slotIndex >= 0 &&
        slotIndex < rendererSlots.length &&
        !msg.frameData;

      if (useSharedSlot) {
        const sab = rendererSlots[slotIndex]!;

        // Validate slot header: check magic and read payloadBytes
        const headerBuf = Buffer.from(sab, 0, 104);
        const magic = headerBuf.readBigUInt64LE(0);
        if (magic !== 0x464C4156454D5246n) {
          mainPort.postMessage({ error: "Invalid slot magic" });
          return;
        }

        const payloadBytes = headerBuf.readUInt32LE(60);
        if (payloadBytes <= 0 || payloadBytes > 33_177_600) {
          mainPort.postMessage({ error: "Invalid slot payload size" });
          return;
        }

        // Read pixel data from the shared slot
        const pixelBuf = Buffer.alloc(payloadBytes);
        Buffer.from(sab, 104, payloadBytes).copy(pixelBuf, 0, 0, payloadBytes);

        try {
          const result = await this.submitFrame(
            msg.generation,
            msg.frameSequence,
            pixelBuf,
            msg.inputWidth,
            msg.inputHeight,
          );

          if (!result) {
            mainPort.postMessage({ error: "Native processing failed" });
            return;
          }

          // When native presentation succeeds, return metadata only
          // (pixels will be empty — renderer skips WebGL upload)
          mainPort.postMessage({
            generation: result.generation,
            sequence: result.sequence,
            width: result.width,
            height: result.height,
            pixels: result.pixels.byteLength > 0 ? new Uint8Array(result.pixels) : new Uint8Array(0),
            configurationId: result.configurationId,
            appliedQualityLevel: result.appliedQualityLevel,
            mainInputHandlingMs: result.mainInputHandlingMs,
            requestWriteMs: result.requestWriteMs,
            responseWaitMs: result.responseWaitMs,
            mainHandlerTotalMs: result.mainHandlerTotalMs,
            nativeInputReceiveMs: result.nativeInputReceiveMs,
            nativeUploadMs: result.nativeUploadMs,
            nativeEffectMs: result.nativeEffectMs,
            nativeDownloadMs: result.nativeDownloadMs,
            nativePreWriteTotalMs: result.nativePreWriteTotalMs,
            // Metadata-only flag for the renderer
            _metadataOnly: result.pixels.byteLength === 0,
          });
        } catch (err) {
          mainPort.postMessage({
            error: err instanceof Error ? err.message : "Frame processing error",
          });
        }
        return;
      }

      // ── Fallback structured-clone path ─────────────────────────────────
      const ab = msg.frameData;
      if (!ab || ab.byteLength === 0) {
        mainPort.postMessage({ error: "No frame data" });
        return;
      }

      const frameData = Buffer.from(ab);

      try {
        const result = await this.submitFrame(
          msg.generation,
          msg.frameSequence,
          frameData,
          msg.inputWidth,
          msg.inputHeight,
        );

        if (!result) {
          mainPort.postMessage({ error: "Native processing failed" });
          return;
        }

        // Send result back with truthful telemetry labels
        mainPort.postMessage({
          generation: result.generation,
          sequence: result.sequence,
          width: result.width,
          height: result.height,
          pixels: new Uint8Array(result.pixels),
          // Phase 3: Frame correlation
          configurationId: result.configurationId,
          appliedQualityLevel: result.appliedQualityLevel,
          // Main-process per-frame timings
          mainInputHandlingMs: result.mainInputHandlingMs,
          requestWriteMs: result.requestWriteMs,
          responseWaitMs: result.responseWaitMs,
          mainHandlerTotalMs: result.mainHandlerTotalMs,
          // Native pre-write timings (only knowable-before-write stages)
          nativeInputReceiveMs: result.nativeInputReceiveMs,
          nativeUploadMs: result.nativeUploadMs,
          nativeEffectMs: result.nativeEffectMs,
          nativeDownloadMs: result.nativeDownloadMs,
          nativePreWriteTotalMs: result.nativePreWriteTotalMs,
          _fallbackPath: true,
        });
      } catch (err) {
        mainPort.postMessage({
          error: err instanceof Error ? err.message : "Frame processing error",
        });
      }
    });

    mainPort.start();
    this.framePorts.set(clientId, mainPort);
    client.framePort = mainPort;

    return rendererPort;
  }

  /**
   * Close frame port for a specific client.
   */
  private closeClientFramePort(clientId: string): void {
    const port = this.framePorts.get(clientId);
    if (port) {
      helperLifecycleLog("framePortClose", { clientId });
      port.close();
      this.framePorts.delete(clientId);
    }
    const client = this.clients.get(clientId);
    if (client) {
      client.framePort = null;
    }
  }

  // ── Legacy stop / destroy ──────────────────────────────────────────

  async stop(shutdown = false): Promise<void> {
    this.lifecycleGeneration += 1;
    this.startPromise = null;
    this.shuttingDown_ = true;
    this.clearDiagnosticsInterval();
    this.clearRestartTimer();
    this.cancelIdleShutdown();

    helperLifecycleLog("helperStop", {
      lifecycleGeneration: this.lifecycleGeneration,
      shutdown,
      lastState: this.state,
    });

    if (shutdown && this.controlSocket) {
      await this.sendCommand("shutdown", {}).catch(() => {});
    }

    this.appliedConfig = null;
    await this.cleanup();
    this.state = "disconnected";
    this.callbacks.onStateChange?.("disconnected");
  }

  async reconfigure(config: VideoEnhancerConfig): Promise<VideoEnhancerConfigureResult> {
    if (this.state !== "ready" && this.state !== "processing") {
      return { success: false, error: "Helper not in ready/processing state" };
    }

    // No-op guard: check if config is identical
    if (this.lastConfig &&
        this.lastConfig.inputWidth === config.inputWidth &&
        this.lastConfig.inputHeight === config.inputHeight &&
        this.lastConfig.outputWidth === config.outputWidth &&
        this.lastConfig.outputHeight === config.outputHeight &&
        this.lastConfig.processingMode === config.processingMode &&
        this.lastConfig.qualityLevel === config.qualityLevel &&
        this.lastConfig.pixelFormat === config.pixelFormat) {
      helperLifecycleLog("reconfigure (idempotent)", {
        lifecycleGeneration: this.lifecycleGeneration,
      });
      return { success: true, appliedConfig: this.appliedConfig ?? undefined };
    }

    helperLifecycleLog("helperReconfigure", {
      lifecycleGeneration: this.lifecycleGeneration,
      inputWidth: config.inputWidth,
      inputHeight: config.inputHeight,
      processingMode: config.processingMode,
      qualityLevel: config.qualityLevel,
    });

    try {
      const raw = await this.sendCommand("configure", {
        inputWidth: config.inputWidth,
        inputHeight: config.inputHeight,
        outputWidth: config.outputWidth,
        outputHeight: config.outputHeight,
        processingMode: config.processingMode,
        qualityLevel: config.qualityLevel,
        pixelFormat: config.pixelFormat,
      });
      const response = (raw ?? {}) as unknown as ConfigureNativeResponse;
      if (response.success === true) {
        this.configurationId++;
        this.effectInstanceId++;
        this.lastConfig = { ...config };
        this.appliedConfig = this.buildAppliedConfig(config, response, true);
      }
      return {
        success: response.success === true,
        error: response.success === true ? undefined : (response.error ?? "Reconfigure failed"),
        appliedConfig: response.success === true ? (this.appliedConfig ?? undefined) : undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Reconfigure error" };
    }
  }

  async flush(): Promise<boolean> {
    if (this.state !== "ready" && this.state !== "processing") return false;

    try {
      const response = await this.sendCommand("flush", {});
      return response?.success === true;
    } catch {
      return false;
    }
  }

  // ── Native benchmark operations ───────────────────────────────────

  /**
   * Start a benchmark run in the native helper.
   * Configures the helper with the given parameters, then starts
   * collecting timing data across targetFrames.
   */
  async runBenchmark(config: NativeBenchmarkConfig): Promise<{ success: boolean; error?: string; targetFrames?: number }> {
    if (this.state !== "ready" && this.state !== "processing") {
      return { success: false, error: "Helper not ready" };
    }

    try {
      const response = await this.sendCommand("benchmarkRun", {
        processingMode: config.processingMode,
        qualityLevel: config.qualityLevel,
        inputWidth: config.inputWidth,
        inputHeight: config.inputHeight,
        targetFrames: config.targetFrames,
        frameTimeoutMs: config.frameTimeoutMs ?? 5000,
      });
      return {
        success: response?.success === true,
        error: response?.success === true ? undefined : ((response?.error as string) ?? "Benchmark run failed"),
        targetFrames: response?.targetFrames as number | undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Benchmark run error" };
    }
  }

  /**
   * Get the current benchmark status from the native helper.
   */
  async getBenchmarkStatus(): Promise<NativeBenchmarkStatusResponse | null> {
    try {
      const raw = await this.sendCommand("benchmarkStatus", {});
      if (!raw) return null;
      return {
        benchmarkActive: raw.benchmarkActive === true,
        benchmarkTargetFrames: Number(raw.benchmarkTargetFrames ?? 0),
        benchmarkFramesCompleted: Number(raw.benchmarkFramesCompleted ?? 0),
        benchmarkTotalTimeUs: Number(raw.benchmarkTotalTimeUs ?? 0),
        benchmarkAvgTimeUs: raw.benchmarkAvgTimeUs !== undefined ? Number(raw.benchmarkAvgTimeUs) : undefined,
        benchmarkComplete: raw.benchmarkComplete === true,
      };
    } catch {
      return null;
    }
  }

  /**
   * Cancel a running benchmark.
   */
  async cancelBenchmark(): Promise<boolean> {
    try {
      const response = await this.sendCommand("benchmarkCancel", {});
      return response?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * Get the aggregated results from a completed benchmark run.
   */
  async getBenchmarkResults(): Promise<NativeBenchmarkResultResponse | null> {
    try {
      const raw = await this.sendCommand("benchmarkGetResults", {});
      if (!raw || raw.success !== true) return null;
      return {
        success: raw.success === true,
        error: raw.error as string | undefined,
        framesProcessed: Number(raw.framesProcessed ?? 0),
        framesDropped: Number(raw.framesDropped ?? 0),
        framesFailed: Number(raw.framesFailed ?? 0),
        totalTimeUs: Number(raw.totalTimeUs ?? 0),
        avgTimeUs: Number(raw.avgTimeUs ?? 0),
        minTimeUs: Number(raw.minTimeUs ?? 0),
        maxTimeUs: Number(raw.maxTimeUs ?? 0),
        avgInputReceiveUs: Number(raw.avgInputReceiveUs ?? 0),
        avgUploadUs: Number(raw.avgUploadUs ?? 0),
        avgEffectUs: Number(raw.avgEffectUs ?? 0),
        avgDownloadUs: Number(raw.avgDownloadUs ?? 0),
        avgOutputWriteUs: Number(raw.avgOutputWriteUs ?? 0),
        avgFps: Number(raw.avgFps ?? 0),
      };
    } catch {
      return null;
    }
  }

  async getDiagnostics(): Promise<VideoEnhancerDiagnosticsResponse | null> {
    try {
      const raw = await this.sendCommand("stats", {});
      if (!raw) return null;
      return raw as unknown as VideoEnhancerDiagnosticsResponse;
    } catch {
      return null;
    }
  }

  /**
   * Get SHM drop counters (Slice 4).
   * Returns a snapshot of the deterministic drop counters for the
   * shared memory ring async submission path.
   */
  getShmDropCounters(): ShmDropCounters {
    return { ...this.shmDropCounters };
  }

  // ── Native presenter ──────────────────────────────────────────────────

  /**
   * Attach the native presenter window as a child of the given BrowserWindow.
   * The owner HWND is extracted from the BrowserWindow and forwarded to the
   * native helper process.
   */
  async attachPresenter(
    window: BrowserWindow,
    width: number,
    height: number,
  ): Promise<boolean> {
    if (this.state !== "ready" && this.state !== "processing") return false;

    const hwnd = window.getNativeWindowHandle();
    if (!hwnd || hwnd.byteLength === 0) {
      console.error("[VideoHelper] No native window handle available");
      return false;
    }

    // Convert Buffer to uint64 HWND value
    const hwndVal = hwnd.readBigUInt64LE(0);

    try {
      // Convert BigInt to number for JSON serialization (HWND is pointer-sized,
      // but on x64 Windows only the lower 48 bits are used for user-mode addresses)
      const hwndNum = Number(hwndVal);
      if (!Number.isSafeInteger(hwndNum)) {
        console.warn("[VideoHelper] HWND value exceeds safe integer range, may be truncated");
      }
      const response = await this.sendCommand("presenterAttach", {
        ownerHwnd: hwndNum,
        width,
        height,
      });
      const ok = response?.success === true;
      if (ok) {
        helperLifecycleLog("presenterAttach", {
          lifecycleGeneration: this.lifecycleGeneration,
          hwnd: hwndVal.toString(16),
          width,
          height,
        });
      }
      return ok;
    } catch (err) {
      console.error("[VideoHelper] presenterAttach failed:", err);
      return false;
    }
  }

  /**
   * Detach and destroy the native presenter.
   */
  async detachPresenter(): Promise<boolean> {
    try {
      const response = await this.sendCommand("presenterDetach", {});
      const ok = response?.success === true;
      if (ok) {
        helperLifecycleLog("presenterDetach", {
          lifecycleGeneration: this.lifecycleGeneration,
        });
      }
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Update the presenter surface position and size relative to its owner window.
   */
  async updatePresenterBounds(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<boolean> {
    try {
      const response = await this.sendCommand("presenterUpdateBounds", {
        x,
        y,
        width,
        height,
      });
      return response?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * Show or hide the presenter surface.
   */
  async setPresenterVisible(visible: boolean): Promise<boolean> {
    try {
      const response = await this.sendCommand("presenterSetVisible", {
        visible,
      });
      return response?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * Get presenter diagnostics.
   */
  async getPresenterDiagnostics(): Promise<import("./video-enhancer-protocol.js").NativePresenterDiagnostics | null> {
    try {
      const raw = await this.sendCommand("presenterGetDiagnostics", {});
      if (!raw || !raw.success) return null;
      return {
        active: raw.active === true,
        framesPresented: Number(raw.framesPresented ?? 0),
        framesDropped: Number(raw.framesDropped ?? 0),
        presentErrors: Number(raw.presentErrors ?? 0),
        lastPresentUs: Number(raw.lastPresentUs ?? 0),
        avgPresentUs: Number(raw.avgPresentUs ?? 0),
        maxPresentUs: Number(raw.maxPresentUs ?? 0),
        presenterResizes: Number(raw.presenterResizes ?? 0),
      };
    } catch {
      return null;
    }
  }

  setCallbacks(callbacks: VideoHelperCallbacks): void {
    this.callbacks = callbacks;
  }

  getState(): VideoHelperState {
    return this.state;
  }

  // ── Private: Helper lifecycle ──────────────────────────────────────

  private async startHelper(config: VideoEnhancerConfig): Promise<boolean> {
    this.lifecycleGeneration++;
    this.shuttingDown_ = false;

    const gen = this.lifecycleGeneration;

    helperLifecycleLog("helperStart", {
      lifecycleGeneration: gen,
      inputWidth: config.inputWidth,
      inputHeight: config.inputHeight,
      outputWidth: config.outputWidth,
      outputHeight: config.outputHeight,
      processingMode: config.processingMode,
      qualityLevel: config.qualityLevel,
    });

    try {
      const helperPath = getVideoEnhancerHelperPath();

      this.sessionId = randomUUID().replace(/-/g, "").substring(0, 32);
      this.authToken = randomUUID().replace(/-/g, "").substring(0, 32);
      this.ctrlPipeName = `screenlink-video-${this.sessionId}-ctrl`;

      const args = [
        "--serve",
        "--control-pipe", this.ctrlPipeName,
        "--frame-pipe", `screenlink-video-${this.sessionId}-frame`,
        "--session-id", this.sessionId,
        "--auth-token", this.authToken,
        "--parent-pid", String(process.pid),
      ];

      this.state = "connecting";
      this.callbacks.onStateChange?.("connecting");

      this.helper = spawn(helperPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.helper.stderr?.on("data", (data: Buffer) => {
        console.error(`[VideoHelper] ${data.toString().trim()}`);
      });

      this.helper.on("exit", (code, signal) => {
        console.log(`[VideoHelper] Exited with code=${code} signal=${signal}`);
        this.handleHelperExit(gen, code ?? -1);
      });

      this.helper.on("error", (err) => {
        console.error(`[VideoHelper] Error: ${err.message}`);
        if (gen !== this.lifecycleGeneration) return;
        this.handleHelperError(err.message);
      });

      await new Promise((r) => setTimeout(r, 500));

      const connected = await this.connectControlPipe(gen, 5000);
      if (!connected || gen !== this.lifecycleGeneration) {
        return false;
      }

      const handshakeOk = await this.handshake(gen);
      if (!handshakeOk || gen !== this.lifecycleGeneration) {
        return false;
      }

      // ── Detect shared memory ring availability ─────────────────────────
      if (gen === this.lifecycleGeneration) {
        const capsRaw = await this.sendCommand("capabilities", {});
        if (capsRaw && capsRaw.sharedMemoryAvailable === true) {
          const shmPath = capsRaw.sharedMemoryPath as string | undefined;
          if (shmPath && typeof shmPath === "string") {
            const validatorPath = shmPath;
            // Verify the file exists and is accessible before opening
            try {
              fs.accessSync(validatorPath, fs.constants.R_OK | fs.constants.W_OK);
              const ring = new SharedMemoryFrameRing();
              if (ring.open(validatorPath)) {
                this.shmRing = ring;
                this.shmAvailable = true;
                helperLifecycleLog("sharedMemoryReady", { path: validatorPath });
              } else {
                helperLifecycleLog("sharedMemoryOpenFailed", { path: validatorPath });
              }
            } catch {
              helperLifecycleLog("sharedMemoryAccessFailed", { path: shmPath });
            }
          }
        }
      }

      // Connect frame pipe persistently once we're ready
      // (still needed as fallback when shared memory is unavailable)
      if (gen === this.lifecycleGeneration) {
        this.framePipeName = `screenlink-video-${this.sessionId}-frame`;
        const fConnected = await this.connectFramePipe();
        if (!fConnected && gen === this.lifecycleGeneration) {
          this.handleHelperError("Frame pipe connection failed");
          return false;
        }
      }

      const configRaw = await this.sendCommand("configure", {
        inputWidth: config.inputWidth,
        inputHeight: config.inputHeight,
        outputWidth: config.outputWidth,
        outputHeight: config.outputHeight,
        processingMode: config.processingMode,
        qualityLevel: config.qualityLevel,
        pixelFormat: config.pixelFormat,
      });
      const configReply = (configRaw ?? {}) as unknown as ConfigureNativeResponse;
      if (configReply.success !== true || gen !== this.lifecycleGeneration) {
        this.handleHelperError("Configuration rejected by helper");
        return false;
      }

      // Build and retain applied config from native response
      this.configurationId++;
      this.effectInstanceId++;
      this.lastConfig = { ...config };
      this.appliedConfig = this.buildAppliedConfig(config, configReply, true);

      this.state = "ready";
      this.restartAttempts = 0;
      this.callbacks.onStateChange?.("ready");
      helperLifecycleLog("helperReady", {
        lifecycleGeneration: gen,
        sessionId: this.sessionId,
      });

      this.startDiagnosticsInterval();

      return true;
    } catch (err) {
      if (gen !== this.lifecycleGeneration) return false;
      this.handleHelperError(
        err instanceof Error ? err.message : "Failed to start helper",
      );
      return false;
    }
  }

  // ── Control pipe ───────────────────────────────────────────────────

  private async connectControlPipe(gen: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (gen === this.lifecycleGeneration) {
          this.handleHelperError("Control pipe connection timeout");
        }
        resolve(false);
      }, timeoutMs);

      socket.connect(`\\\\.\\pipe\\${this.ctrlPipeName}`, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (gen !== this.lifecycleGeneration) {
          socket.destroy();
          resolve(false);
          return;
        }
        this.controlSocket = socket;
        this.state = "handshaking";
        this.callbacks.onStateChange?.("handshaking");

        socket.on("data", this.controlDataHandler);

        socket.on("error", (err) => {
          console.error(`[VideoHelper] Control socket error: ${err.message}`);
          if (gen !== this.lifecycleGeneration) return;
          this.handleHelperError(`Control socket error: ${err.message}`);
        });

        socket.on("close", () => {
          console.log("[VideoHelper] Control socket closed");
          if (this.controlSocket === socket) {
            this.controlSocket = null;
          }
        });

        resolve(true);
      });

      socket.on("error", () => {
        if (settled) return;
      });
    });
  }

  private async handshake(gen: number): Promise<boolean> {
    try {
      const response = await this.sendCommand("hello", {
        protocolVersion: VIDEO_ENHANCER_PROTOCOL_VERSION,
        sessionId: this.sessionId,
        authToken: this.authToken,
      });
      const ok = response?.success === true;
      if (!ok && gen === this.lifecycleGeneration) {
        this.handleHelperError("Handshake failed");
      }
      return ok;
    } catch {
      if (gen === this.lifecycleGeneration) {
        this.handleHelperError("Handshake error");
      }
      return false;
    }
  }

  // ── IPC communication ──────────────────────────────────────────────

  private commandQueue: Array<{
    id: string;
    command: string;
    payload: Record<string, unknown>;
    resolve: (result: Record<string, unknown> | null) => void;
  }> = [];
  private commandInFlight = false;
  private responseBuffer = "";

  private enqueueCommand(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      this.commandQueue.push({
        id: randomUUID(),
        command,
        payload,
        resolve,
      });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.commandInFlight) return;
    const next = this.commandQueue.shift();
    if (!next) return;

    const socket = this.controlSocket;
    if (!socket || !socket.writable) {
      next.resolve(null);
      return;
    }

    this.commandInFlight = true;

    const request = {
      id: next.id,
      protocolVersion: VIDEO_ENHANCER_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      authToken: this.authToken,
      command: next.command,
      payload: next.payload,
    };

    const data = JSON.stringify(request) + "\n";

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.pendingCommands.delete(next.id);
      this.commandInFlight = false;
      next.resolve(null);
      this.processQueue();
    }, 5000);

    this.pendingCommands.set(next.id, {
      resolve: next.resolve,
      timeout,
    });

    try {
      socket.write(data, (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.pendingCommands.delete(next.id);
          this.commandInFlight = false;
          next.resolve(null);
          this.processQueue();
        }
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        this.pendingCommands.delete(next.id);
        this.commandInFlight = false;
        next.resolve(null);
        this.processQueue();
      }
    }
  }

  private pendingCommands = new Map<string, {
    resolve: (result: Record<string, unknown> | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  private controlDataHandler = (chunk: Buffer): void => {
    this.responseBuffer += chunk.toString();
    const newlineIdx = this.responseBuffer.indexOf("\n");
    if (newlineIdx < 0) return;

    const message = this.responseBuffer.substring(0, newlineIdx);
    this.responseBuffer = this.responseBuffer.substring(newlineIdx + 1);

    try {
      const response = JSON.parse(message);
      const id = response.id as string | undefined;
      const event = response.event as string | undefined;

      // Slice 4: Handle unsolicited completion events from native helper
      if (event === "slotCompleted") {
        this.handleShmSlotCompleted(response.payload);
        return;
      }

      if (id && this.pendingCommands.has(id)) {
        const pending = this.pendingCommands.get(id)!;
        clearTimeout(pending.timeout);
        this.pendingCommands.delete(id);
        this.commandInFlight = false;
        pending.resolve(response);
        this.processQueue();
      }
    } catch {
      // Malformed JSON — ignore
    }
  };

  /**
   * Handle a slotCompleted event from the native helper (Slice 4).
   * Reads the processed output from the SHM ring and resolves the
   * pending completion promise.
   */
  private handleShmSlotCompleted(payload: Record<string, unknown>): void {
    const slotIndex = payload.slotIndex as number | undefined;
    if (slotIndex === undefined || slotIndex < 0 || slotIndex >= 3) return;

    const entry = this.pendingShmCompletions.get(slotIndex);
    if (!entry) {
      // No pending completion for this slot — it may have timed out.
      // Release the slot regardless so it can be reused.
      this.shmRing?.writeControl(slotIndex, SlotState.Empty);
      return;
    }

    clearTimeout(entry.timer);
    this.pendingShmCompletions.delete(slotIndex);

    const ring = this.shmRing;
    if (!ring) {
      entry.resolve(null);
      return;
    }

    const success = payload.success === true;
    const resultCode = (payload.resultCode as number) ?? 0;

    if (!success || resultCode !== 1) {
      // Processing failed — release slot and resolve with null
      ring.writeControl(slotIndex, SlotState.Empty);
      entry.resolve(null);
      return;
    }

    // Read the processed output from the slot's output region
    const output = ring.readOutput(slotIndex);
    if (!output || output.resultCode !== 1) {
      ring.writeControl(slotIndex, SlotState.Empty);
      entry.resolve(null);
      return;
    }

    // Release the slot
    ring.writeControl(slotIndex, SlotState.Empty);

    // Increment completed counter
    this.shmDropCounters.shmTotalCompleted++;

    // Resolve with the result
    entry.resolve({
      generation: output.generation,
      sequence: output.frameSequence,
      pixels: output.pixels,
      width: output.width,
      height: output.height,
      configurationId: output.configurationId > 0 ? output.configurationId : undefined,
      appliedQualityLevel: output.appliedQualityLevel > 0 ? output.appliedQualityLevel : undefined,
      nativeInputReceiveMs: output.nativeInputReceiveUs > 0 ? output.nativeInputReceiveUs / 1000 : undefined,
      nativeUploadMs: output.nativeUploadUs > 0 ? output.nativeUploadUs / 1000 : undefined,
      nativeEffectMs: output.nativeEffectUs > 0 ? output.nativeEffectUs / 1000 : undefined,
      nativeDownloadMs: output.nativeDownloadUs > 0 ? output.nativeDownloadUs / 1000 : undefined,
      nativePreWriteTotalMs: output.nativeTotalUs > 0 ? output.nativeTotalUs / 1000 : undefined,
    });
  }

  private sendCommand(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.enqueueCommand(command, payload);
  }

  // ── Frame pipe ─────────────────────────────────────────────────────

  private connectFramePipe(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.framePipeClient) {
        this.framePipeClient.destroy();
        this.framePipeClient = null;
      }
      this.frameParser = new FramePipeParser();
      this.framePipeName = `screenlink-video-${this.sessionId}-frame`;
      const client = net.createConnection(`\\\\.\\pipe\\${this.framePipeName}`, () => {
        this.framePipeClient = client;
        this.framePipeConnected = true;

        // Wire up persistent frame-pipe data handler (one parser per socket)
        client.on("data", (chunk: Buffer) => {
          if (!this.frameParser) return;
          const result = this.frameParser.feed(chunk);
          if (result) {
            // Result is delivered via the installPending callback
            // The parser calls the pending resolve internally
          }
        });

        resolve(true);
      });
      client.on("error", () => {
        this.framePipeConnected = false;
        resolve(false);
      });
      client.setTimeout(5000, () => {
        client.destroy();
        this.framePipeConnected = false;
        resolve(false);
      });
    });
  }

  // ── Error handling and restart ─────────────────────────────────────

  private handleHelperExit(gen: number, code: number): void {
    this.helper = null;
    this.controlSocket = null;

    helperLifecycleLog("helperExit", {
      lifecycleGeneration: gen,
      exitCode: code,
      currentGeneration: this.lifecycleGeneration,
      shuttingDown: this.shuttingDown_,
    });

    if (gen !== this.lifecycleGeneration) return;
    if (this.shuttingDown_) return;

    this.attemptRestart(gen);
  }

  private handleHelperError(reason: string): void {
    if (this.shuttingDown_) return;

    this.state = "error";
    this.callbacks.onStateChange?.("error");
    this.callbacks.onError?.(reason);

    this.attemptRestart(this.lifecycleGeneration);
  }

  private attemptRestart(gen: number): void {
    if (gen !== this.lifecycleGeneration) return;
    this.clearRestartTimer();
    if (this.restartAttempts >= this.maxRestarts) {
      this.state = "disconnected";
      this.callbacks.onStateChange?.("disconnected");
      this.callbacks.onError?.("Video helper reached max restart attempts");
      return;
    }

    this.restartAttempts++;
    const delay = this.getRestartDelayMs(this.restartAttempts);

    this.restartTimer = setTimeout(() => {
      if (gen !== this.lifecycleGeneration) return;
      this.restartTimer = null;
      const config = this.lastConfig ?? {
        inputWidth: 1920,
        inputHeight: 1080,
        outputWidth: 1920,
        outputHeight: 1080,
        processingMode: "vsr" as const,
        qualityLevel: "high" as const,
        pixelFormat: "bgra8" as const,
      };
      this.startHelper(config).catch(() => {});
    }, delay);
  }

  private getRestartDelayMs(attemptNumber: number): number {
    switch (attemptNumber) {
      case 1:
        return 1000;
      case 2:
        return 4000;
      default:
        return 15000;
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────

  private startDiagnosticsInterval(): void {
    this.clearDiagnosticsInterval();
    this.diagnosticsInterval = setInterval(async () => {
      if (this.state === "ready" || this.state === "processing") {
        await this.getDiagnostics();
      }
    }, 5000);
  }

  private clearDiagnosticsInterval(): void {
    if (this.diagnosticsInterval) {
      clearInterval(this.diagnosticsInterval);
      this.diagnosticsInterval = null;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  private async cleanup(): Promise<void> {
    this.clearDiagnosticsInterval();
    this.clearRestartTimer();
    this.cancelIdleShutdown();

    // Close all client frame ports
    for (const [clientId] of this.framePorts) {
      this.closeClientFramePort(clientId);
    }
    this.clients.clear();

    // Destroy parser
    if (this.frameParser) {
      this.frameParser.reset();
      this.frameParser = null;
    }

    // Destroy frame pipe
    if (this.framePipeClient) {
      this.framePipeClient.removeAllListeners();
      this.framePipeClient.destroy();
      this.framePipeClient = null;
    }
    this.framePipeConnected = false;

    // Slice 4: Reject all pending SHM completions (helper restart)
    this.rejectAllShmCompletions("helper restart/shutdown");

    // Close shared memory ring
    if (this.shmRing) {
      this.shmRing.close();
      this.shmRing = null;
    }
    this.shmAvailable = false;

    // Destroy control socket
    this.controlSocket?.destroy();
    this.controlSocket = null;

    // Kill helper
    if (this.helper) {
      return new Promise((resolve) => {
        const helper = this.helper!;
        const killTimeout = setTimeout(() => {
          helper.kill("SIGKILL");
        }, 5000);

        const exitHandler = () => {
          clearTimeout(killTimeout);
          this.helper = null;
          resolve();
        };

        helper.on("exit", exitHandler);

        try {
          helper.kill("SIGTERM");
        } catch {
          // Process may already be dead
        }

        if (helper.exitCode !== null) {
          clearTimeout(killTimeout);
          this.helper = null;
          resolve();
        }
      });
    }
  }

  destroy(): void {
    this.shuttingDown_ = true;
    this.stop(true).catch(() => {});
  }
}
