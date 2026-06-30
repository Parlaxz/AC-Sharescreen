// SPDX-License-Identifier: MIT

import type {
  ViewerImageBackend,
  BackendKind,
  BackendInitResult,
  FrameProcessResult,
  BackendStats,
  FrameMetadata,
} from "./viewer-image-backend";

import type {
  ViewerImageEnhancementSettings,
} from "./viewer-image-settings";

import { canonicalQualityLevel } from "@screenlink/shared";
import type { AppliedNvidiaConfig } from "@screenlink/shared";
import { nextMonotonicId, lifecycleLog } from "./lifecycle-id";

type NativeVideoConfig = {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  processingMode: "vsr" | "high-bitrate" | "denoise" | "deblur";
  qualityLevel: "low" | "medium" | "high" | "ultra";
  pixelFormat: "rgba8";
};

type NativeFrameResult = {
  generation: number;
  sequence?: number;
  frameSequence?: number;
  pixels: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  configurationId?: number;
  appliedQualityLevel?: number;
};

type ScreenLinkVideoApi = {
  probeNvidiaVsrCapability?: () => Promise<{
    available: boolean;
    reason: string;
  }>;

  videoHelperAcquireClient?: () => Promise<{ clientId: string }>;
  videoHelperReleaseClient?: (clientId: string) => Promise<{ success: boolean }>;

  videoHelperStart?: (
    config: NativeVideoConfig,
  ) => Promise<boolean | { success: boolean; appliedConfig?: import("@screenlink/shared").AppliedNvidiaConfig }>;

  videoHelperStop?: (
    shutdown?: boolean,
  ) => Promise<void>;

  videoHelperReconfigure?: (
    config: NativeVideoConfig,
  ) => Promise<boolean | { success: boolean; appliedConfig?: import("@screenlink/shared").AppliedNvidiaConfig }>;

  videoHelperSubmitFrame?: (
    generation: number,
    frameSequence: number,
    frameData: Uint8Array,
    inputWidth: number,
    inputHeight: number,
  ) => Promise<NativeFrameResult | null>;

  videoHelperFlush?: () => Promise<boolean>;

  /** Phase 5: Request a dedicated MessagePort for zero-copy frame transfer */
  requestFramePort?: () => Promise<{ success: boolean }>;
  /** Phase 6: Request a frame port bound to a specific clientId lease */
  requestFramePortForClient?: (clientId: string) => Promise<{ success: boolean; error?: string }>;

  // Native presenter operations
  nativePresenterAttach?: (width: number, height: number) => Promise<{ success: boolean }>;
  nativePresenterDetach?: () => Promise<{ success: boolean }>;
  nativePresenterUpdateBounds?: (x: number, y: number, width: number, height: number) => Promise<{ success: boolean }>;
  nativePresenterSetVisible?: (visible: boolean) => Promise<{ success: boolean }>;
  nativePresenterGetDiagnostics?: () => Promise<{ success: boolean; diagnostics?: import("@screenlink/shared").NativePresenterDiagnostics | null; error?: string }>;
};

const EMPTY_STATS: BackendStats = {
  inputWidth: 0,
  inputHeight: 0,
  outputWidth: 0,
  outputHeight: 0,
  enhancedScalingActive: false,
  lastGpuTimeMs: null,
  backend: "nvidia-vsr",
  framesProcessed: 0,
  activePasses: [],
  backpressureDrops: 0,
  processingAttempts: 0,
  completedAttempts: 0,
  displayedCount: 0,
  coalescedCount: 0,
  backendDrops: 0,
  staleGenerationResults: 0,
  failures: 0,
  configState: "idle",
  staleConfigDrops: 0,
};

const VERTEX_SHADER = `#version 300 es
out vec2 vUv;

void main() {
  vec2 p = vec2(
    float((gl_VertexID << 1) & 2),
    float(gl_VertexID & 2)
  );

  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uTexture;

in vec2 vUv;
out vec4 outputColor;

void main() {
  outputColor = texture(uTexture, vUv);
}
`;

function getVideoApi(): ScreenLinkVideoApi | undefined {
  return (
    window as unknown as {
      screenlink?: ScreenLinkVideoApi;
    }
  ).screenlink;
}

export function isNvidiaVsrAvailable(): boolean {
  const api = getVideoApi();

  return Boolean(
    api?.probeNvidiaVsrCapability &&
    api.videoHelperStart &&
    api.videoHelperSubmitFrame &&
    api.videoHelperFlush &&
    api.videoHelperStop,
  );
}

export function resetNvidiaVsrCache(): void {
  // Capability state is owned by nvidia-capability-store.
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);

  if (!shader) {
    throw new Error("Unable to create NVIDIA display shader");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message =
      gl.getShaderInfoLog(shader) ??
      "Unknown NVIDIA shader compilation error";

    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
): WebGLProgram {
  const vertexShader = compileShader(
    gl,
    gl.VERTEX_SHADER,
    VERTEX_SHADER,
  );

  const fragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    FRAGMENT_SHADER,
  );

  const program = gl.createProgram();

  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("Unable to create NVIDIA display program");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message =
      gl.getProgramInfoLog(program) ??
      "Unknown NVIDIA display-program link error";

    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
}

function normalizePixels(
  value: NativeFrameResult["pixels"],
  expectedLength?: number,
): Uint8Array {
  if (value instanceof Uint8Array) {
    // If exact Uint8Array with expected length, use directly
    if (expectedLength === undefined || value.byteLength === expectedLength) {
      return value;
    }
    // Otherwise create a right-sized copy
    return new Uint8Array(value);
  }

  if (value instanceof Uint8ClampedArray) {
    const result = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    if (expectedLength === undefined || result.byteLength === expectedLength) {
      return result;
    }
    return new Uint8Array(result);
  }

  return new Uint8Array();
}

function clampDimension(value: number): number {
  return Math.max(1, Math.min(4096, Math.round(value)));
}

export class NvidiaVsrBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "nvidia-vsr";
  /** Stable monotonically increasing instance identifier */
  readonly instanceId: number = nextMonotonicId();

  private canvas: HTMLCanvasElement | null = null;

  private captureCanvas: HTMLCanvasElement | null = null;
  private captureContext: CanvasRenderingContext2D | null = null;

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private texture: WebGLTexture | null = null;

  // Cached sampler uniform location (looked up once after program creation)
  private textureUniformLocation: WebGLUniformLocation | null = null;
  // Persistent texture dimensions for texSubImage2D optimization
  private textureWidth = 0;
  private textureHeight = 0;

  private settings: ViewerImageEnhancementSettings | null = null;

  private initialized = false;
  private destroyed = false;
  private frameInFlight = false;
  private helperStarted = false;

  // Phase 2: Requested/Applied config contract
  private requestedConfig: import("./viewer-image-settings").ViewerImageEnhancementSettings | null = null;
  private pendingConfig: Record<string, unknown> | null = null;
  private appliedConfig: AppliedNvidiaConfig | null = null;
  private configState: "idle" | "applying" | "applied" | "error" = "idle";

  private configKey: string | null = null;
  private generation = 0;

  private displayPixelWidth = 0;
  private displayPixelHeight = 0;

  private stats: BackendStats = {
    ...EMPTY_STATS,
  };

  private currentQualityLevel: number | null = null;

  // Phase 3: Config identity for stale-frame rejection
  private expectedConfigurationId = 0;
  private staleConfigDrops = 0;

  // Phase 5: MessagePort frame IPC with clientId lease
  private clientId: string | null = null;
  private framePort: MessagePort | null = null;
  private framePortRequested = false;
  private pendingFramePort: Promise<boolean> | null = null;

  // Native presenter support (GPU-resident display)
  private nativePresenterActive = false;
  private nativePresenterSupported = false;

  /**
   * Acquire a client lease and then the dedicated frame MessagePort.
   */
  private async acquireClientAndPort(): Promise<boolean> {
    const api = getVideoApi();

    // Acquire client lease
    if (!this.clientId && api?.videoHelperAcquireClient) {
      try {
        const { clientId } = await api.videoHelperAcquireClient();
        this.clientId = clientId;
        lifecycleLog("NvidiaBackend", "clientAcquired", {
          instanceId: this.instanceId,
          clientId,
        });
      } catch {
        return false;
      }
    }

    return this.acquireFramePort();
  }

  /**
   * Acquire the dedicated frame MessagePort from the main process,
   * associated with our clientId.
   */
  private async acquireFramePort(): Promise<boolean> {
    if (this.framePort) return true;
    if (this.framePortRequested && this.pendingFramePort) {
      return this.pendingFramePort;
    }

    const api = getVideoApi();
    if (!api?.requestFramePortForClient && !api?.requestFramePort) return false;

    this.framePortRequested = true;

    this.pendingFramePort = new Promise<boolean>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        console.warn("[nvidia-vsr] Frame port acquisition timed out");
        resolve(false);
      }, 5000);

      const onMessage = (evt: MessageEvent) => {
        if (settled) return;
        if (evt.data?.type !== "frame:port") return;
        settled = true;
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        const port = evt.ports?.[0];
        if (!port) {
          resolve(false);
          return;
        }
        this.framePort = port;
        port.start();
        lifecycleLog("NvidiaBackend", "framePortAcquired", {
          instanceId: this.instanceId,
          clientId: this.clientId,
        });
        resolve(true);
      };

      window.addEventListener("message", onMessage);

      // Trigger port creation in the main process (with clientId when available)
      const portPromise = this.clientId && api.requestFramePortForClient
        ? api.requestFramePortForClient(this.clientId)
        : api.requestFramePort!();

      portPromise.then((result) => {
        if (!result.success && !settled) {
          settled = true;
          clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          lifecycleLog("NvidiaBackend", "framePortFailed", {
            instanceId: this.instanceId,
            clientId: this.clientId,
          });
          resolve(false);
        }
      });
    });

    const ok = await this.pendingFramePort;
    this.pendingFramePort = null;
    return ok;
  }

  /**
   * Submit a frame via the MessagePort using structured-cloned binary data.
   * Uses exact-buffer path: if frameData covers entire backing ArrayBuffer,
   * use that exact buffer with structured clone and no slice.
   * If partial view, create exactly one right-sized copy.
   */
  private submitFrameViaPort(
    generation: number,
    frameSequence: number,
    frameData: Uint8Array,
    inputWidth: number,
    inputHeight: number,
  ): Promise<NativeFrameResult | null> {
    return new Promise((resolve) => {
      const port = this.framePort;
      if (!port) {
        resolve(null);
        return;
      }

      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, 5000);

      port.onmessage = (evt: MessageEvent) => {
        if (settled) return;
        const msg = evt.data as {
          generation?: number;
          sequence?: number;
          width?: number;
          height?: number;
          error?: string;
        };

        if (msg.error) {
          settled = true;
          clearTimeout(timeout);
          port.onmessage = null;

          console.error(
            "[nvidia-vsr] Frame port processing error:",
            msg.error,
          );

          resolve(null);
          return;
        }

        settled = true;
        clearTimeout(timeout);
        port.onmessage = null;

        // Pixels arrive as Uint8Array (structured clone, not transferred)
        const rawPixels = (msg as any).pixels;
        if (!rawPixels || !(rawPixels instanceof Uint8Array) || rawPixels.byteLength === 0) {
          resolve(null);
          return;
        }

        resolve({
          generation,
          sequence: frameSequence,
          pixels: rawPixels,
          width: msg.width ?? 0,
          height: msg.height ?? 0,
          configurationId: (msg as any).configurationId,
          appliedQualityLevel: (msg as any).appliedQualityLevel,
        });
      };

      // Exact-buffer path: if frameData covers entire backing ArrayBuffer, use exact buffer
      // with structured clone and no slice. No transfer list for pixel ArrayBuffer.
      const byteOff = frameData.byteOffset;
      const byteLen = frameData.byteLength;
      const backingBuf = frameData.buffer as ArrayBuffer;
      let buffer: ArrayBuffer;
      if (byteOff === 0 && byteLen === backingBuf.byteLength) {
        // Complete coverage — use exact backing buffer without slice
        buffer = backingBuf;
      } else {
        // Partial view — create exactly one right-sized copy
        buffer = backingBuf.slice(byteOff, byteOff + byteLen);
      }

      port.postMessage(
        {
          clientId: this.clientId,
          generation,
          frameSequence,
          inputWidth,
          inputHeight,
          frameData: buffer,
        });
    });
  }

  async initialize(
    canvas?: HTMLCanvasElement,
  ): Promise<BackendInitResult> {
    if (this.destroyed) {
      return {
        success: false,
        reason: "NVIDIA backend was destroyed",
      };
    }

    if (!canvas) {
      return {
        success: false,
        reason: "NVIDIA backend requires an output canvas",
      };
    }

    const api = getVideoApi();

    if (!isNvidiaVsrAvailable() || !api) {
      return {
        success: false,
        reason: "NVIDIA video-helper IPC is unavailable",
      };
    }

    try {
      const capability =
        await api.probeNvidiaVsrCapability?.();

      if (!capability?.available) {
        return {
          success: false,
          reason:
            capability?.reason ??
            "NVIDIA capability probe failed",
        };
      }

      this.canvas = canvas;

      this.captureCanvas =
        document.createElement("canvas");

      this.captureContext =
        this.captureCanvas.getContext("2d", {
          alpha: false,
          willReadFrequently: true,
        });

      if (!this.captureContext) {
        return {
          success: false,
          reason: "Unable to create frame-capture canvas",
        };
      }

      this.gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
      });

      if (!this.gl) {
        return {
          success: false,
          reason: "WebGL2 is unavailable for NVIDIA output display",
        };
      }

      this.program = createProgram(this.gl);

      // Cache sampler uniform location once after program creation
      this.textureUniformLocation =
        this.gl.getUniformLocation(this.program, "uTexture");

      this.vao = this.gl.createVertexArray();
      this.texture = this.gl.createTexture();

      if (!this.vao || !this.texture) {
        return {
          success: false,
          reason: "Unable to allocate NVIDIA display resources",
        };
      }

      this.gl.bindTexture(
        this.gl.TEXTURE_2D,
        this.texture,
      );

      this.gl.texParameteri(
        this.gl.TEXTURE_2D,
        this.gl.TEXTURE_MIN_FILTER,
        this.gl.LINEAR,
      );

      this.gl.texParameteri(
        this.gl.TEXTURE_2D,
        this.gl.TEXTURE_MAG_FILTER,
        this.gl.LINEAR,
      );

      this.gl.texParameteri(
        this.gl.TEXTURE_2D,
        this.gl.TEXTURE_WRAP_S,
        this.gl.CLAMP_TO_EDGE,
      );

      this.gl.texParameteri(
        this.gl.TEXTURE_2D,
        this.gl.TEXTURE_WRAP_T,
        this.gl.CLAMP_TO_EDGE,
      );

      this.gl.bindTexture(this.gl.TEXTURE_2D, null);

      this.textureWidth = 0;
      this.textureHeight = 0;

      this.generation += 1;
      this.initialized = true;

      this.stats = {
        ...EMPTY_STATS,
        generation: this.generation,
        nativeQualityLevel: this.currentQualityLevel,
      };

      // Try to activate native presenter (GPU-resident display path)
      // This is best-effort — failure here just means we fall back to WebGL
      this.nativePresenterActive = false;
      this.nativePresenterSupported = Boolean(api?.nativePresenterAttach && api?.nativePresenterDetach);
      if (this.nativePresenterSupported) {
        try {
          // Use full window size as initial surface; will be refined via resizeOutput
          const initWidth = this.displayPixelWidth || 1920;
          const initHeight = this.displayPixelHeight || 1080;
          const attachResult = await api.nativePresenterAttach!(initWidth, initHeight);
          this.nativePresenterActive = attachResult.success;
          if (this.nativePresenterActive) {
            lifecycleLog("NvidiaBackend", "natvPresActivated", {
              instanceId: this.instanceId,
              width: initWidth,
              height: initHeight,
            });
          }
        } catch (err) {
          this.nativePresenterActive = false;
          console.warn("[nvidia-vsr] Native presenter activation failed:", err);
        }
      }

      lifecycleLog("NvidiaBackend", "initialize", {
        instanceId: this.instanceId,
        generation: this.generation,
        nativePresenter: this.nativePresenterActive,
      });

      return { success: true };
    }
    catch (error) {
      // Release client lease on initialization failure
      this.releaseClient();
      return {
        success: false,
        reason:
          error instanceof Error
            ? error.message
            : "Unknown NVIDIA backend initialization error",
      };
    }
  }

  updateSettings(
    settings: ViewerImageEnhancementSettings,
  ): void {
    const previousConfiguration = this.settings
      ? JSON.stringify({
          mode: this.settings.nvidiaMode,
          quality: this.settings.nvidiaQuality,
          output: this.settings.nvidiaOutput,
          width: this.settings.customOutputWidth,
          height: this.settings.customOutputHeight,
          aspect: this.settings.maintainAspectRatio,
        })
      : null;

    this.settings = { ...settings };

    const nextConfiguration = JSON.stringify({
      mode: settings.nvidiaMode,
      quality: settings.nvidiaQuality,
      output: settings.nvidiaOutput,
      width: settings.customOutputWidth,
      height: settings.customOutputHeight,
      aspect: settings.maintainAspectRatio,
    });

    if (previousConfiguration !== nextConfiguration) {
      this.configKey = null;
    }
  }

  resizeOutput(
    width: number,
    height: number,
    _dpr: number,
  ): void {
    // Only update presentation CSS sizing; never reconfigure native output
    if (this.canvas) {
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }

    // Forward bounds to native presenter if active
    if (this.nativePresenterActive) {
      const api = getVideoApi();
      api?.nativePresenterUpdateBounds?.(0, 0, Math.round(width), Math.round(height)).catch(() => {});
    }
  }

  onSourceResize(
    sourceWidth: number,
    sourceHeight: number,
  ): void {
    // Only trigger reconfig when actual source resolution changes
    if (
      sourceWidth !== this.stats.inputWidth ||
      sourceHeight !== this.stats.inputHeight
    ) {
      this.configKey = null;
    }

    // Forward size to native presenter
    if (this.nativePresenterActive) {
      const api = getVideoApi();
      api?.nativePresenterUpdateBounds?.(
        0, 0,
        Math.round(sourceWidth * 2), // VSR doubles the resolution
        Math.round(sourceHeight * 2),
      ).catch(() => {});
    }
  }

  /**
   * Set native presenter visibility based on video element visibility.
   * Should be called when the viewer container becomes visible/hidden.
   */
  setPresenterVisible(visible: boolean): void {
    if (this.nativePresenterActive) {
      const api = getVideoApi();
      api?.nativePresenterSetVisible?.(visible).catch(() => {});
    }
  }

  // Remove unused display pixel tracking
  // displayPixelWidth and displayPixelHeight now unused

  async processFrame(
    video: HTMLVideoElement,
    metadata?: FrameMetadata,
  ): Promise<FrameProcessResult> {
    if (
      this.destroyed ||
      !this.initialized ||
      !this.canvas ||
      !this.captureCanvas ||
      !this.captureContext ||
      !this.gl ||
      !this.program ||
      !this.vao ||
      !this.texture
    ) {
      return { success: false };
    }

    if (video.readyState < 2) {
      return {
        success: false,
        transient: true,
      };
    }

    if (this.frameInFlight) {
      this.stats.backpressureDrops += 1;

      return {
        success: false,
        backpressureDrop: true,
      };
    }

    const inputWidth = video.videoWidth;
    const inputHeight = video.videoHeight;

    if (inputWidth <= 0 || inputHeight <= 0) {
      return {
        success: false,
        transient: true,
      };
    }

    const output = this.calculateOutputDimensions(
      inputWidth,
      inputHeight,
    );

    this.frameInFlight = true;

    try {
      const helperReady =
        await this.ensureHelperConfiguration(
          inputWidth,
          inputHeight,
          output.width,
          output.height,
        );

      if (!helperReady) {
        return { success: false };
      }

      if (
        this.captureCanvas.width !== inputWidth ||
        this.captureCanvas.height !== inputHeight
      ) {
        this.captureCanvas.width = inputWidth;
        this.captureCanvas.height = inputHeight;
      }

      // ── Phase 6: Correlated frame identity ─────────────────────────────
      const generation = metadata?.generation ?? this.generation;
      const frameSequence = metadata?.frameSequence ?? 0;

      // ── Renderer timing: Phase A1 — drawImage ──────────────────────────
      const frameStart = performance.now();

      this.captureContext.drawImage(
        video,
        0,
        0,
        inputWidth,
        inputHeight,
      );

      const afterDrawImage = performance.now();
      const drawImageMs = afterDrawImage - frameStart;

      // ── Renderer timing: Phase A2 — getImageData ───────────────────────
      const source = this.captureContext.getImageData(
        0,
        0,
        inputWidth,
        inputHeight,
      );

      const afterGetImageData = performance.now();
      const getImageDataMs = afterGetImageData - afterDrawImage;

      // ── Renderer timing: Phase A3 — input buffer preparation ──────────
      const frameData = new Uint8Array(
        source.data.buffer,
        source.data.byteOffset,
        source.data.byteLength,
      );

      const afterBufferPrep = performance.now();
      const inputBufferPreparationMs = afterBufferPrep - afterGetImageData;

      const api = getVideoApi();

      if (!api?.videoHelperSubmitFrame) {
        return { success: false };
      }

      // ── Renderer timing: Phase B — native transport (renderer-observed) ──
      let result: NativeFrameResult | null = null;

      if (this.framePort || await this.acquireClientAndPort()) {
        result = await this.submitFrameViaPort(
          generation,
          frameSequence,
          frameData,
          inputWidth,
          inputHeight,
        );
      } else {
        // Fall back to invoke-based submission
        result = await api.videoHelperSubmitFrame(
          generation,
          frameSequence,
          frameData,
          inputWidth,
          inputHeight,
        );
      }

      const afterResult = performance.now();
      // rendererToResultMs = renderer-observed round-trip wait for native result
      const rendererToResultMs = afterResult - afterBufferPrep;

      if (!result) {
        this.stats = {
          ...this.stats,
          failures: (this.stats.failures ?? 0) + 1,
          processingAttempts: (this.stats.processingAttempts ?? 0) + 1,
        };
        return { success: false };
      }

      const resultSequence =
        result.sequence ??
        result.frameSequence ??
        frameSequence;

      // Phase 3: Check generation/sequence match
      if (result.generation !== generation || resultSequence !== frameSequence) {
        this.stats = {
          ...this.stats,
          staleGenerationResults: (this.stats.staleGenerationResults ?? 0) + 1,
          processingAttempts: (this.stats.processingAttempts ?? 0) + 1,
        };
        return {
          success: false,
          transient: true,
        };
      }

      // Phase 3: Reject stale frames by configurationId
      // Counts as staleConfigDrops (NOT staleGenerationResults, which is for backend swaps)
      if (result.configurationId != null && result.configurationId > 0 &&
          result.configurationId !== this.expectedConfigurationId) {
        this.staleConfigDrops++;
        this.stats = {
          ...this.stats,
          staleConfigDrops: this.staleConfigDrops,
          processingAttempts: (this.stats.processingAttempts ?? 0) + 1,
        };
        return {
          success: false,
          transient: true,
        };
      }

      // ── Native presenter path (GPU-resident) ─────────────────────────
      // When the native presenter is active, the native helper presents the
      // frame directly to a D3D11 swapchain overlay window. No pixel data is
      // returned — we skip texture upload entirely.
      if (this.nativePresenterActive) {
        // Check if pixel data is empty (expected for presenter path)
        const noPixels = !result.pixels || result.pixels.byteLength === 0;

        if (noPixels) {
          // Frame was presented natively — no WebGL texture upload needed
          this.stats = {
            inputWidth,
            inputHeight,
            outputWidth: result.width || output.width,
            outputHeight: result.height || output.height,
            enhancedScalingActive: true,
            lastGpuTimeMs: 0,
            backend: "nvidia-vsr",
            framesProcessed: this.stats.framesProcessed + 1,
            activePasses: ["nvidia-vsr", "native-presenter"],
            backpressureDrops: this.stats.backpressureDrops,
            generation,
            nativeQualityLevel: this.currentQualityLevel,
            processingAttempts: (this.stats.processingAttempts ?? 0) + 1,
            completedAttempts: (this.stats.completedAttempts ?? 0) + 1,
            displayedCount: (this.stats.displayedCount ?? 0) + 1,
            coalescedCount: this.stats.coalescedCount ?? 0,
            backendDrops: this.stats.backpressureDrops,
            staleGenerationResults: this.stats.staleGenerationResults ?? 0,
            failures: this.stats.failures ?? 0,
          };

          return {
            success: true,
            gpuTimeMs: 0,
            totalLatencyMs: 0,
            timingBreakdown: {
              captureReadbackMs: drawImageMs + getImageDataMs,
              drawImageMs,
              getImageDataMs,
              inputBufferPreparationMs,
              rendererToResultMs,
              textureUploadMs: 0,
              rendererTotalMs: performance.now() - frameStart,
              nativeTransportProcessingMs: rendererToResultMs,
              displayUploadMs: 0,
              // Native presenter path: no CPU download
              nativeDownloadMs: 0,
              nativePreWriteTotalMs: rendererToResultMs,
            },
          };
        }

        // Presenter is active but pixel data was returned — this means the
        // GPU-to-GPU path failed and we fell back to the CPU download path.
        // Continue with normal WebGL texture upload.
      }

      // Safe frame byte-size validation before expectedBytes calculation
      if (result.width <= 0 || result.height <= 0 || result.width > 8192 || result.height > 8192) {
        this.stats = {
          ...this.stats,
          failures: (this.stats.failures ?? 0) + 1,
          processingAttempts: (this.stats.processingAttempts ?? 0) + 1,
        };
        return { success: false };
      }

      const expectedBytes = result.width * result.height * 4;
      // Guard against overflow: after dimension clamp above, this is safe for
      // 8192 * 8192 * 4 = 268,435,456 which fits in Number's safe integer range.
      if (expectedBytes > 8192 * 8192 * 4 || expectedBytes <= 0) {
        this.stats = {
          ...this.stats,
          failures: (this.stats.failures ?? 0) + 1,
          processingAttempts: (this.stats.processingAttempts ?? 0) + 1,
        };
        return { success: false };
      }

      const pixels = normalizePixels(result.pixels, expectedBytes);

      if (pixels.byteLength !== expectedBytes) {
        this.stats = {
          ...this.stats,
          failures: (this.stats.failures ?? 0) + 1,
          processingAttempts: (this.stats.processingAttempts ?? 0) + 1,
        };
        return { success: false };
      }

      // ── Renderer timing: Phase C — texture upload (texImage2D/texSubImage2D + drawArrays) ──
      const uploadStart = performance.now();
      this.renderOutput(pixels, result.width, result.height);
      const afterDisplay = performance.now();
      const textureUploadMs = afterDisplay - uploadStart;

      // Derived renderer-phase totals
      const captureReadbackMs = drawImageMs + getImageDataMs;
      const displayUploadMs = textureUploadMs;
      const rendererTotalMs = afterDisplay - frameStart;

      // Native transport+processing is carried as renderer-observed duration
      // (rendererToResultMs). No cross-process clock subtractions.
      // The native side separately tracks its own internal breakdown
      // (upload, effect, download) which arrives via diagnostics polling.

      this.stats = {
        inputWidth,
        inputHeight,
        outputWidth: result.width,
        outputHeight: result.height,
        enhancedScalingActive:
          result.width > inputWidth || result.height > inputHeight,
        lastGpuTimeMs: rendererToResultMs,
        backend: "nvidia-vsr",
        framesProcessed: this.stats.framesProcessed + 1,
        activePasses: ["nvidia-vsr"],
        backpressureDrops: this.stats.backpressureDrops,
        generation,
        nativeQualityLevel: this.currentQualityLevel,
        processingAttempts: (this.stats.processingAttempts ?? 0) + 1,
        completedAttempts: (this.stats.completedAttempts ?? 0) + 1,
        displayedCount: (this.stats.displayedCount ?? 0) + 1,
        coalescedCount: this.stats.coalescedCount ?? 0,
        backendDrops: this.stats.backpressureDrops,
        staleGenerationResults: this.stats.staleGenerationResults ?? 0,
        failures: this.stats.failures ?? 0,
      };

      // Main-process timings (from submitFrame result, if available)
      const mainInputHandlingMs = (result as any).mainInputHandlingMs;
      const requestWriteMs = (result as any).requestWriteMs;
      const responseWaitMs = (result as any).responseWaitMs;
      const responsePayloadReadMs = (result as any).responsePayloadReadMs;
      const mainHandlerTotalMs = (result as any).mainHandlerTotalMs;

      // Native per-stage timings from frame header (only knowable-before-write stages)
      const nativeInputReceiveMs = (result as any).nativeInputReceiveMs;
      const nativeUploadMs = (result as any).nativeUploadMs;
      const nativeEffectMs = (result as any).nativeEffectMs;
      const nativeDownloadMs = (result as any).nativeDownloadMs;
      // nativeOutputWriteMs is NOT exposed per-frame; only in aggregate diagnostics
      const nativePreWriteTotalMs = (result as any).nativePreWriteTotalMs;

      // nativeTransportProcessingMs: true native pre-write total (from header) or fallback to rendererToResultMs
      const trueNativeTransportMs = nativePreWriteTotalMs ?? rendererToResultMs;

      return {
        success: true,
        gpuTimeMs: rendererToResultMs,
        totalLatencyMs: afterDisplay - frameStart,
        timingBreakdown: {
          captureReadbackMs,
          drawImageMs,
          getImageDataMs,
          inputBufferPreparationMs,
          rendererToResultMs,
          textureUploadMs,
          rendererTotalMs,
          // Use true native pre-write total when available, not a duplicate of rendererToResultMs
          nativeTransportProcessingMs: trueNativeTransportMs,
          displayUploadMs,
          // Main-process per-frame timings (truthful labels)
          mainInputHandlingMs,
          requestWriteMs,
          responseWaitMs,
          mainHandlerTotalMs,
          // Native per-stage timings (only knowable-before-write)
          nativeInputReceiveMs,
          nativeUploadMs,
          nativeEffectMs,
          nativeDownloadMs,
          nativePreWriteTotalMs,
        },
      };
    }
    catch (error) {
      console.error(
        "[nvidia-vsr] Frame processing failed",
        error,
      );

      return { success: false };
    }
    finally {
      this.frameInFlight = false;
    }
  }

  getStats(): BackendStats {
    return {
      ...this.stats,
      backend: "nvidia-vsr",
      configState: this.configState,
      staleConfigDrops: this.staleConfigDrops,
      presentationPath: this.nativePresenterActive ? "native-presenter" : "webgl",
    };
  }

  async destroy(reason?: string): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    lifecycleLog("NvidiaBackend", "destroy", {
      instanceId: this.instanceId,
      reason: reason ?? "unspecified",
      clientId: this.clientId,
    });
    this.initialized = false;
    this.frameInFlight = false;
    this.configKey = null;

    const api = getVideoApi();

    // Detach native presenter (best-effort)
    if (this.nativePresenterActive) {
      api?.nativePresenterDetach?.().catch(() => {});
      this.nativePresenterActive = false;
      lifecycleLog("NvidiaBackend", "natvPresDetached", {
        instanceId: this.instanceId,
      });
    }

    // Release client lease (does NOT globally stop the helper)
    this.releaseClient();

    // Destroy GL resources
    if (this.gl) {
      if (this.texture) {
        this.gl.deleteTexture(this.texture);
      }

      if (this.vao) {
        this.gl.deleteVertexArray(this.vao);
      }

      if (this.program) {
        this.gl.deleteProgram(this.program);
      }
    }

    this.texture = null;
    this.textureUniformLocation = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.vao = null;
    this.program = null;
    this.gl = null;

    this.captureContext = null;
    this.captureCanvas = null;
    this.canvas = null;

    // Clean up frame port
    if (this.framePort) {
      this.framePort.onmessage = null;
      this.framePort.close();
      this.framePort = null;
    }
    this.framePortRequested = false;
    this.pendingFramePort = null;

    console.info(
      "[nvidia-vsr] Native backend destroyed",
    );
  }

  /**
   * Release the client lease obtained during initialization.
   * Idempotent. Does NOT globally stop the helper.
   */
  private releaseClient(): void {
    if (!this.clientId) return;
    const api = getVideoApi();
    const cid = this.clientId;
    this.clientId = null;
    api?.videoHelperReleaseClient?.(cid).catch(() => {});
    lifecycleLog("NvidiaBackend", "clientReleased", {
      instanceId: this.instanceId,
      clientId: cid,
    });
  }

  private calculateOutputDimensions(
    inputWidth: number,
    inputHeight: number,
  ): { width: number; height: number } {
    const mode = this.settings?.nvidiaMode ?? "vsr";

    if (mode === "denoise" || mode === "deblur") {
      return { width: inputWidth, height: inputHeight };
    }

    return { width: inputWidth * 2, height: inputHeight * 2 };
  }

  private async ensureHelperConfiguration(
    inputWidth: number,
    inputHeight: number,
    outputWidth: number,
    outputHeight: number,
  ): Promise<boolean> {
    const api = getVideoApi();

    if (
      !api?.videoHelperStart ||
      !api.videoHelperStop
    ) {
      return false;
    }

    const config: NativeVideoConfig = {
      inputWidth,
      inputHeight,
      outputWidth,
      outputHeight,
      processingMode:
        this.settings?.nvidiaMode ?? "vsr",
      qualityLevel:
        this.settings?.nvidiaQuality ?? "high",
      pixelFormat: "rgba8",
    };

    // Compute canonical QualityLevel via shared mapping
    const ql = canonicalQualityLevel(config.processingMode, config.qualityLevel);
    this.currentQualityLevel = ql >= 0 ? ql : 3; // default to VSR high (3)

    const nextConfigKey = JSON.stringify(config);

    // Same config: no action needed
    if (
      this.helperStarted &&
      this.configKey === nextConfigKey
    ) {
      return true;
    }

    // Phase 2: Track requested/pending/applied state
    this.requestedConfig = this.settings;
    this.pendingConfig = config as unknown as Record<string, unknown>;
    this.configState = "applying";

    // Capture the config key at start of apply for drift check
    const applyConfigKey = nextConfigKey;

    // Helper function to extract applied config from various return formats
    const parseResult = (result: unknown): { ok: boolean; appliedConfig?: AppliedNvidiaConfig } => {
      if (result === null || result === undefined) return { ok: false };
      // Structured result with success + appliedConfig
      if (typeof result === "object" && "success" in (result as any)) {
        const r = result as any;
        return { ok: r.success === true, appliedConfig: r.appliedConfig ?? undefined };
      }
      // Legacy boolean return
      return { ok: result === true };
    };

    // If already started, reconfigure in place
    if (this.helperStarted) {
      const reconfigureResult = await api.videoHelperReconfigure?.(config);
      const { ok: reconfigured, appliedConfig: reconfigureConfig } = parseResult(reconfigureResult);
      if (reconfigured) {
        // Phase 2: Post-IPC drift check — if a newer config was set while applying,
        // invalidate configKey so the next frame re-applies.
        if (this.configKey !== null && this.configKey !== applyConfigKey) {
          // A newer configuration was set during our apply — re-apply next frame
          this.configKey = null;
        } else {
          this.configKey = applyConfigKey;
        }
        if (reconfigureConfig) {
          this.appliedConfig = reconfigureConfig;
          this.currentQualityLevel = reconfigureConfig.appliedQualityLevel;
          this.expectedConfigurationId = reconfigureConfig.configurationId;
        }
        this.configState = "applied";
        return true;
      }
      // Reconfigure failed: flush and mark local state for main process to handle lifecycle
      console.warn("[nvidia-vsr] In-place reconfigure failed, flushing");
      await api.videoHelperFlush?.().catch(() => false);
      // Note: deliberately NOT calling videoHelperStop(true) from renderer on ordinary
      // failure — main process owns lifecycle management. Just mark local state stale.
      this.helperStarted = false;
      this.configKey = null;
      this.configState = "error";
    }

    // First start or restart after failed reconfigure
    const startResult = await api.videoHelperStart(config);
    const { ok: started, appliedConfig: startConfig } = parseResult(startResult);

    if (this.destroyed) {
      this.configState = "error";
      return false;
    }

    if (!started) {
      console.error(
        "[nvidia-vsr] Native helper startup failed:",
        JSON.stringify(config),
      );
      this.configState = "error";
      return false;
    }

    this.helperStarted = true;
    // Phase 2: Post-IPC drift check
    if (this.configKey !== null && this.configKey !== applyConfigKey) {
      this.configKey = null;
    } else {
      this.configKey = nextConfigKey;
    }
    if (startConfig) {
      this.appliedConfig = startConfig;
      this.currentQualityLevel = startConfig.appliedQualityLevel;
      this.expectedConfigurationId = startConfig.configurationId;
    }
    this.configState = "applied";

    console.info(
      "[nvidia-vsr] Native helper configured",
      config,
    );

    return true;
  }

  private renderOutput(
    pixels: Uint8Array,
    width: number,
    height: number,
  ): void {
    const canvas = this.canvas;
    const gl = this.gl;
    const program = this.program;
    const vao = this.vao;
    const texture = this.texture;

    if (
      !canvas ||
      !gl ||
      !program ||
      !vao ||
      !texture
    ) {
      throw new Error(
        "NVIDIA output resources are unavailable",
      );
    }

    if (
      canvas.width !== width ||
      canvas.height !== height
    ) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    gl.useProgram(program);
    gl.bindVertexArray(vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

    // Use texSubImage2D for same-size frames to avoid full reallocation;
    // use texImage2D on first frame or when dimensions change.
    if (this.textureWidth === width && this.textureHeight === height) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      this.textureWidth = width;
      this.textureHeight = height;
    }

    gl.uniform1i(this.textureUniformLocation ?? 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}