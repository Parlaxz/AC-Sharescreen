import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { VIDEO_ENHANCER_PROTOCOL_VERSION } from "./video-enhancer-protocol.js";
import type { VideoEnhancerConfig } from "./video-enhancer-protocol.js";
import { getVideoEnhancerHelperPath } from "./helper-path.js";

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Manager ─────────────────────────────────────────────────────────────────

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

  // Diagnostics interval
  private diagnosticsInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Lazy initialization
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Start the video-helper and establish control connection.
   */
  async start(config: VideoEnhancerConfig): Promise<boolean> {
    if (this.state === "ready" || this.state === "processing") return true;
    if (this.state === "connecting" || this.state === "handshaking") return false;

    return this.startHelper(config);
  }

  /**
   * Submit a frame for processing via the persistent frame pipe.
   * Writes header + pixel data to the already-connected pipe.
   */
  async submitFrame(
    generation: number,
    frameSequence: number,
    frameData: Uint8Array,
    inputWidth: number,
    inputHeight: number,
  ): Promise<boolean> {
    if (this.state !== "ready" && this.state !== "processing") return false;

    try {
      const config = this.lastConfig;
      const outW = config?.outputWidth ?? inputWidth;
      const outH = config?.outputHeight ?? inputHeight;
      const mode = config?.processingMode ?? "vsr";
      const qual = config?.qualityLevel ?? "high";
      const modeNum = mode === "vsr" ? 1 : mode === "high-bitrate" ? 2 : mode === "denoise" ? 3 : 4;
      const qualNum = qual === "low" ? 0 : qual === "medium" ? 1 : qual === "ultra" ? 3 : 2;

      // Ensure persistent frame pipe connection
      if (!this.framePipeConnected) {
        const connected = await this.connectFramePipe();
        if (!connected) return false;
      }

      const sent = await this.sendFrameData({
        generation,
        frameSequence,
        capturedAtUs: BigInt(Math.round(performance.now() * 1000)),
        inputWidth,
        inputHeight,
        inputStride: inputWidth * 4,
        pixelFormat: 1, // BGRA8
        requestedOutputWidth: outW,
        requestedOutputHeight: outH,
        processingMode: modeNum,
        qualityLevel: qualNum,
        payloadBytes: frameData.byteLength,
      }, frameData);

      return sent;
    } catch {
      return false;
    }
  }

  private framePipeClient: net.Socket | null = null;
  private framePipeConnected = false;
  private framePipeName = "";

  private connectFramePipe(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.framePipeClient) {
        this.framePipeClient.destroy();
        this.framePipeClient = null;
      }
      this.framePipeName = `screenlink-video-${this.sessionId}-frame`;
      const client = net.createConnection(`\\\\.\\pipe\\${this.framePipeName}`, () => {
        this.framePipeClient = client;
        this.framePipeConnected = true;
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

  /**
   * Stop processing and optionally shut down the helper.
   */
  async stop(shutdown = false): Promise<void> {
    this.shuttingDown_ = true;
    this.clearDiagnosticsInterval();
    this.clearRestartTimer();

    if (shutdown && this.controlSocket) {
      await this.sendCommand("shutdown", {}).catch(() => {});
    }

    await this.cleanup();
    this.state = "disconnected";
    this.callbacks.onStateChange?.("disconnected");
  }

  /**
   * Update processing configuration.
   */
  async reconfigure(config: VideoEnhancerConfig): Promise<boolean> {
    if (this.state !== "ready" && this.state !== "processing") return false;

    try {
      const response = await this.sendCommand("configure", {
        inputWidth: config.inputWidth,
        inputHeight: config.inputHeight,
        outputWidth: config.outputWidth,
        outputHeight: config.outputHeight,
        processingMode: config.processingMode,
        qualityLevel: config.qualityLevel,
        pixelFormat: config.pixelFormat,
      });
      if (response?.success === true) {
        this.lastConfig = { ...config };
      }
      return response?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * Flush any pending frames.
   */
  async flush(): Promise<boolean> {
    if (this.state !== "ready" && this.state !== "processing") return false;

    try {
      const response = await this.sendCommand("flush", {});
      return response?.success === true;
    } catch {
      return false;
    }
  }

  /**
   * Get diagnostics from the helper.
   */
  async getDiagnostics(): Promise<Record<string, unknown> | null> {
    try {
      return await this.sendCommand("stats", {});
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

  // ─── Private: Helper lifecycle ─────────────────────────────────────────

  private async startHelper(config: VideoEnhancerConfig): Promise<boolean> {
    this.lifecycleGeneration++;
    this.shuttingDown_ = false;

    const gen = this.lifecycleGeneration;

    try {
      const helperPath = getVideoEnhancerHelperPath();

      // Generate new session identity
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

      // Handle stderr for diagnostics
      this.helper.stderr?.on("data", (data: Buffer) => {
        console.error(`[VideoHelper] ${data.toString().trim()}`);
      });

      // Handle exit
      this.helper.on("exit", (code, signal) => {
        console.log(`[VideoHelper] Exited with code=${code} signal=${signal}`);
        this.handleHelperExit(gen, code ?? -1);
      });

      this.helper.on("error", (err) => {
        console.error(`[VideoHelper] Error: ${err.message}`);
        if (gen !== this.lifecycleGeneration) return;
        this.handleHelperError(err.message);
      });

      // Wait briefly for helper to create pipes
      await new Promise((r) => setTimeout(r, 500));

      // Connect control pipe
      const connected = await this.connectControlPipe(gen, 5000);
      if (!connected || gen !== this.lifecycleGeneration) {
        return false;
      }

      // Handshake
      const handshakeOk = await this.handshake(gen);
      if (!handshakeOk || gen !== this.lifecycleGeneration) {
        return false;
      }

      // Connect frame pipe persistently once we're ready
      if (gen === this.lifecycleGeneration) {
        this.framePipeName = `screenlink-video-${this.sessionId}-frame`;
        const fConnected = await this.connectFramePipe();
        if (!fConnected && gen === this.lifecycleGeneration) {
          this.handleHelperError("Frame pipe connection failed");
          return false;
        }
      }

      // Send configure
      await this.sendCommand("configure", {
        inputWidth: config.inputWidth,
        inputHeight: config.inputHeight,
        outputWidth: config.outputWidth,
        outputHeight: config.outputHeight,
        processingMode: config.processingMode,
        qualityLevel: config.qualityLevel,
        pixelFormat: config.pixelFormat,
      });

      this.state = "ready";
      this.restartAttempts = 0;
      this.lastConfig = { ...config };
      this.callbacks.onStateChange?.("ready");

      // Start diagnostics polling
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

        // Wire up shared data dispatcher for all command responses
        socket.on("data", this.controlDataHandler);

        // Wire up error handling for the connected socket
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
        // Connection refused — will be retried by caller if needed
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

  // ─── IPC communication ────────────────────────────────────────────────

  // Command queue: one active command at a time, FIFO
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
      socket.removeListener("data", this.controlDataHandler);
      this.commandInFlight = false;
      next.resolve(null);
      this.processQueue();
    }, 5000);

    // Store resolver for shared data dispatcher
    const pendingKey = next.id;
    this.pendingCommands.set(pendingKey, {
      resolve: next.resolve,
      timeout,
    });

    try {
      socket.write(data, (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.pendingCommands.delete(pendingKey);
          this.commandInFlight = false;
          next.resolve(null);
          this.processQueue();
        }
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        socket.removeListener("data", this.controlDataHandler);
        this.pendingCommands.delete(pendingKey);
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

      if (id && this.pendingCommands.has(id)) {
        const pending = this.pendingCommands.get(id)!;
        clearTimeout(pending.timeout);
        this.pendingCommands.delete(id);
        this.commandInFlight = false;
        pending.resolve(response);
        this.processQueue();
      } else {
        // Unmatched response — may be a late reply or diagnostic
      }
    } catch {
      // Malformed JSON — ignore
    }
  };

  private sendCommand(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.enqueueCommand(command, payload);
  }

  // ─── Frame transport ────────────────────────────────────────────────

  private async sendFrameData(
    header: {
      generation: number;
      frameSequence: number;
      capturedAtUs: bigint;
      inputWidth: number;
      inputHeight: number;
      inputStride: number;
      pixelFormat: number;
      requestedOutputWidth: number;
      requestedOutputHeight: number;
      processingMode: number;
      qualityLevel: number;
      payloadBytes: number;
    },
    pixelData: Uint8Array,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = this.framePipeClient;
      if (!socket || !socket.writable) { resolve(false); return; }

      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Don't destroy persistent pipe — just mark stale
        this.framePipeConnected = false;
        resolve(false);
      }, 5000);

      // Build binary header (80 bytes to match FrameHeader)
      const magic = Buffer.alloc(8);
      magic.writeBigUInt64LE(BigInt("0x464C4156454D5246"));
      const HEADER_SIZE = 80;
      const wireVersion = 1;

      const headerBuf = Buffer.alloc(HEADER_SIZE);
      let off = 0;
      magic.copy(headerBuf, off); off += 8;
      headerBuf.writeUInt32LE(HEADER_SIZE, off); off += 4;
      headerBuf.writeUInt32LE(wireVersion, off); off += 4;
      headerBuf.writeUInt32LE(header.generation, off); off += 4;
      headerBuf.writeUInt32LE(header.frameSequence, off); off += 4;
      headerBuf.writeBigUInt64LE(header.capturedAtUs, off); off += 8;
      headerBuf.writeUInt32LE(header.inputWidth, off); off += 4;
      headerBuf.writeUInt32LE(header.inputHeight, off); off += 4;
      headerBuf.writeUInt32LE(header.inputStride, off); off += 4;
      headerBuf.writeUInt32LE(header.pixelFormat, off); off += 4;
      headerBuf.writeUInt32LE(header.requestedOutputWidth, off); off += 4;
      headerBuf.writeUInt32LE(header.requestedOutputHeight, off); off += 4;
      headerBuf.writeUInt32LE(0, off); off += 4; // slotIndex
      headerBuf.writeUInt32LE(header.payloadBytes, off); off += 4;
      headerBuf.writeUInt32LE(header.processingMode, off); off += 4;
      headerBuf.writeUInt32LE(header.qualityLevel, off); off += 4;
      headerBuf.writeUInt32LE(0, off); off += 4; // flags
      headerBuf.writeUInt32LE(0, off); // resultCode (0 = pending)

      // Write header + pixel data
      const ok = socket.write(Buffer.concat([headerBuf, pixelData]));
      if (!ok) {
        // Backpressure — schedule drain and retry concept, but for now mark failure
        clearTimeout(timeout);
        settled = true;
        resolve(false);
        return;
      }

      // Read result header back (same size)
      let resultBuf = Buffer.alloc(0);
      const onResultData = (chunk: Buffer): void => {
        resultBuf = Buffer.concat([resultBuf, chunk]);
        if (resultBuf.length >= HEADER_SIZE) {
          settled = true;
          clearTimeout(timeout);
          socket.removeListener("data", onResultData);
          const resultCode = resultBuf.readUInt32LE(HEADER_SIZE - 4);
          resolve(resultCode === 1);
        }
      };
      socket.on("data", onResultData);
    });
  }

  // ─── Error handling and restart ────────────────────────────────────────

  private handleHelperExit(gen: number, _code: number): void {
    this.helper = null;
    this.controlSocket = null;

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
    if (this.restartAttempts >= this.maxRestarts) {
      this.callbacks.onError?.("Video helper reached max restart attempts");
      return;
    }

    this.restartAttempts++;
    const delay = Math.min(5000 * Math.pow(2, this.restartAttempts - 1), 20000);

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

  // ─── Diagnostics ───────────────────────────────────────────────────────

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

  // ─── Cleanup ───────────────────────────────────────────────────────────

  private async cleanup(): Promise<void> {
    this.clearDiagnosticsInterval();
    this.clearRestartTimer();

    this.controlSocket?.destroy();
    this.controlSocket = null;

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

        // Send graceful termination
        try {
          helper.kill("SIGTERM");
        } catch {
          // Process may already be dead
        }

        // Handle case where helper already exited
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
