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
   * Submit a frame for processing via the frame named pipe.
   * Writes header + pixel data to the persistent frame pipe.
   */
  async submitFrame(
    generation: number,
    frameSequence: number,
    frameData: Uint8Array,
    inputWidth: number,
    inputHeight: number,
  ): Promise<boolean> {
    if (!this.controlSocket || !this.controlSocket.writable) return false;

    try {
      // Notify native that frame is available
      const ack = await this.sendCommand("frameAvailable", {});
      if (!ack || ack?.success !== true) return false;

      const config = this.lastConfig;
      const outW = config?.outputWidth ?? inputWidth;
      const outH = config?.outputHeight ?? inputHeight;
      const mode = config?.processingMode ?? "vsr";
      const qual = config?.qualityLevel ?? "high";

      const modeNum = mode === "vsr" ? 1 : mode === "high-bitrate" ? 2 : mode === "denoise" ? 3 : 4;
      const qualNum = qual === "low" ? 0 : qual === "medium" ? 1 : qual === "ultra" ? 3 : 2;

      // Connect frame pipe and write binary header + data
      const framePipe = `\\\\.\\pipe\\screenlink-video-${this.sessionId}-frame`;
      const sent = await this.sendFrameData(framePipe, {
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
        "--control-pipe", `\\\\.\\pipe\\${this.ctrlPipeName}`,
        "--frame-pipe", `\\\\.\\pipe\\screenlink-video-${this.sessionId}-frame`,
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

  private sendCommand(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const socket = this.controlSocket;
      if (!socket || !socket.writable) {
        resolve(null);
        return;
      }

      const request = {
        protocolVersion: VIDEO_ENHANCER_PROTOCOL_VERSION,
        sessionId: this.sessionId,
        authToken: this.authToken,
        command,
        payload,
      };

      const data = JSON.stringify(request) + "\n";

      let responseData = "";
      let settled = false;

      const onData = (chunk: Buffer) => {
        if (settled) return;
        responseData += chunk.toString();
        const newlineIdx = responseData.indexOf("\n");
        if (newlineIdx >= 0) {
          settled = true;
          socket.removeListener("data", onData);
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(responseData.substring(0, newlineIdx)));
          } catch {
            resolve(null);
          }
        }
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.removeListener("data", onData);
        resolve(null);
      }, 5000);

      socket.on("data", onData);

      try {
        socket.write(data, (err) => {
          if (err) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              socket.removeListener("data", onData);
              resolve(null);
            }
          }
        });
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          socket.removeListener("data", onData);
          resolve(null);
        }
      }
    });
  }

  // ─── Frame transport ────────────────────────────────────────────────

  private async sendFrameData(
    pipePath: string,
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
      const socket = new net.Socket();
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(false);
      }, 5000);

      socket.connect(pipePath, () => {
        if (settled) return;
        // Build binary header (64 bytes to match FrameHeader)
        const magic = Buffer.alloc(8);
        magic.writeBigUInt64LE(0x464C4156454D5246n);
        const headerSize = 64;
        const wireVersion = 1;

        const headerBuf = Buffer.alloc(headerSize);
        let offset = 0;
        magic.copy(headerBuf, offset); offset += 8;
        headerBuf.writeUInt32LE(headerSize, offset); offset += 4;
        headerBuf.writeUInt32LE(wireVersion, offset); offset += 4;
        headerBuf.writeUInt32LE(header.generation, offset); offset += 4;
        headerBuf.writeUInt32LE(header.frameSequence, offset); offset += 4;
        headerBuf.writeBigUInt64LE(header.capturedAtUs, offset); offset += 8;
        headerBuf.writeUInt32LE(header.inputWidth, offset); offset += 4;
        headerBuf.writeUInt32LE(header.inputHeight, offset); offset += 4;
        headerBuf.writeUInt32LE(header.inputStride, offset); offset += 4;
        headerBuf.writeUInt32LE(header.pixelFormat, offset); offset += 4;
        headerBuf.writeUInt32LE(header.requestedOutputWidth, offset); offset += 4;
        headerBuf.writeUInt32LE(header.requestedOutputHeight, offset); offset += 4;
        // slotIndex, payloadBytes, processingMode, qualityLevel, flags, resultCode
        headerBuf.writeUInt32LE(0, offset); offset += 4; // slotIndex
        headerBuf.writeUInt32LE(header.payloadBytes, offset); offset += 4; // payloadBytes
        headerBuf.writeUInt32LE(header.processingMode, offset); offset += 4;
        headerBuf.writeUInt32LE(header.qualityLevel, offset); offset += 4;
        headerBuf.writeUInt32LE(0, offset); offset += 4; // flags
        headerBuf.writeUInt32LE(0, offset); // resultCode

        // Write header + pixel data
        socket.write(headerBuf);
        socket.write(pixelData);

        // Read result header back
        let resultBuf = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          resultBuf = Buffer.concat([resultBuf, chunk]);
          if (resultBuf.length >= headerSize) {
            settled = true;
            clearTimeout(timeout);
            const resultCode = resultBuf.readUInt32LE(headerSize - 4); // last field
            socket.destroy();
            resolve(resultCode === 1);
          }
        });
      });

      socket.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(false);
      });
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
