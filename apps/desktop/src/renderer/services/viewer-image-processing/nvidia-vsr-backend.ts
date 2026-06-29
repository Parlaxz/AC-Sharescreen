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
};

type ScreenLinkVideoApi = {
  probeNvidiaVsrCapability?: () => Promise<{
    available: boolean;
    reason: string;
  }>;

  videoHelperStart?: (
    config: NativeVideoConfig,
  ) => Promise<boolean>;

  videoHelperStop?: (
    shutdown?: boolean,
  ) => Promise<void>;

  videoHelperReconfigure?: (
    config: NativeVideoConfig,
  ) => Promise<boolean>;

  videoHelperSubmitFrame?: (
    generation: number,
    frameSequence: number,
    frameData: Uint8Array,
    inputWidth: number,
    inputHeight: number,
  ) => Promise<NativeFrameResult | null>;

  videoHelperFlush?: () => Promise<boolean>;
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
): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof Uint8ClampedArray) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
  }

  return new Uint8Array();
}

function clampDimension(value: number): number {
  return Math.max(1, Math.min(4096, Math.round(value)));
}

export class NvidiaVsrBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "nvidia-vsr";

  private canvas: HTMLCanvasElement | null = null;

  private captureCanvas: HTMLCanvasElement | null = null;
  private captureContext: CanvasRenderingContext2D | null = null;

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private texture: WebGLTexture | null = null;

  private settings: ViewerImageEnhancementSettings | null = null;

  private initialized = false;
  private destroyed = false;
  private frameInFlight = false;
  private helperStarted = false;

  private configKey: string | null = null;
  private generation = 0;

  private displayPixelWidth = 0;
  private displayPixelHeight = 0;

  private stats: BackendStats = {
    ...EMPTY_STATS,
  };

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

      this.generation += 1;
      this.initialized = true;

      this.stats = {
        ...EMPTY_STATS,
        generation: this.generation,
      };

      console.info(
        "[nvidia-vsr] Native backend initialized",
      );

      return { success: true };
    }
    catch (error) {
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

      this.captureContext.drawImage(
        video,
        0,
        0,
        inputWidth,
        inputHeight,
      );

      const source =
        this.captureContext.getImageData(
          0,
          0,
          inputWidth,
          inputHeight,
        );

      const api = getVideoApi();

      if (!api?.videoHelperSubmitFrame) {
        return { success: false };
      }

      const generation =
        metadata?.generation ?? this.generation;

      const frameSequence =
        metadata?.frameSequence ?? 0;

      const startedAt = performance.now();

      const result =
        await api.videoHelperSubmitFrame(
          generation,
          frameSequence,
          new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength),
          inputWidth,
          inputHeight,
        );

      const elapsedMs =
        performance.now() - startedAt;

      if (!result) {
        console.error(
          "[nvidia-vsr] Native helper returned no frame",
        );

        return { success: false };
      }

      const resultSequence =
        result.sequence ??
        result.frameSequence ??
        frameSequence;

      if (
        result.generation !== generation ||
        resultSequence !== frameSequence
      ) {
        return {
          success: false,
          transient: true,
        };
      }

      const pixels = normalizePixels(result.pixels);

      const expectedBytes =
        result.width * result.height * 4;

      if (
        result.width <= 0 ||
        result.height <= 0 ||
        pixels.byteLength !== expectedBytes
      ) {
        console.error(
          "[nvidia-vsr] Invalid native output frame",
          {
            width: result.width,
            height: result.height,
            bytes: pixels.byteLength,
            expectedBytes,
          },
        );

        return { success: false };
      }

      this.renderOutput(
        pixels,
        result.width,
        result.height,
      );

      this.stats = {
        inputWidth,
        inputHeight,
        outputWidth: result.width,
        outputHeight: result.height,
        enhancedScalingActive:
          result.width > inputWidth ||
          result.height > inputHeight,
        lastGpuTimeMs: elapsedMs,
        backend: "nvidia-vsr",
        framesProcessed:
          this.stats.framesProcessed + 1,
        activePasses: ["nvidia-vsr"],
        backpressureDrops:
          this.stats.backpressureDrops,
        generation,
      };

      return {
        success: true,
        gpuTimeMs: elapsedMs,
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
    };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.initialized = false;
    this.frameInFlight = false;
    this.configKey = null;

    const api = getVideoApi();

    if (this.helperStarted) {
      await api?.videoHelperFlush?.().catch(() => false);
      await api?.videoHelperStop?.(true).catch(() => {});
    }

    this.helperStarted = false;

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
    this.vao = null;
    this.program = null;
    this.gl = null;

    this.captureContext = null;
    this.captureCanvas = null;
    this.canvas = null;

    console.info(
      "[nvidia-vsr] Native backend destroyed",
    );
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

    const nextConfigKey = JSON.stringify(config);

    // Same config: no action needed
    if (
      this.helperStarted &&
      this.configKey === nextConfigKey
    ) {
      return true;
    }

    // If already started, reconfigure in place
    if (this.helperStarted) {
      const reconfigured = await api.videoHelperReconfigure?.(config);
      if (reconfigured) {
        this.configKey = nextConfigKey;
        return true;
      }
      // Reconfigure failed: flush and restart
      console.warn("[nvidia-vsr] In-place reconfigure failed, restarting helper");
      await api.videoHelperFlush?.().catch(() => false);
      await api.videoHelperStop(true).catch(() => {});
      this.helperStarted = false;
      this.configKey = null;
    }

    // First start or restart after failed reconfigure
    const started = await api.videoHelperStart(config);

    if (this.destroyed) {
      return false;
    }

    if (!started) {
      console.error(
        "[nvidia-vsr] Native helper startup failed:",
        JSON.stringify(config),
      );
      return false;
    }

    this.helperStarted = true;
    this.configKey = nextConfigKey;

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

    const textureLocation =
      gl.getUniformLocation(program, "uTexture");

    gl.uniform1i(textureLocation, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}