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
import { RendererInputSlots } from "./renderer-input-slots";

type NativeVideoConfig = {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  processingMode: "vsr" | "high-bitrate" | "denoise" | "deblur";
  qualityLevel: "low" | "medium" | "high" | "ultra";
  pixelFormat: "rgba8";
};

/**
 * Timing fields that the main process may include in a frame response.
 * These are extracted from the native frame header (μs→ms conversion) and
 * main-process IPC timing, then carried through to the renderer.
 *
 * Convention: `undefined` = measurement not available (never convert to 0).
 * `0` = real measured zero (e.g. zero-copy GPU→GPU path).
 */
type NativeFrameTimingFields = {
  /** Main-process input handling duration (ms) */
  mainInputHandlingMs?: number;
  /** Main-process request-write duration (ms) */
  requestWriteMs?: number;
  /** Main-process response-wait duration (ms) */
  responseWaitMs?: number;
  /** Main-process response-payload-read duration (ms) */
  responsePayloadReadMs?: number;
  /** Main-process handler total duration (ms) */
  mainHandlerTotalMs?: number;
  /** Native input-receive stage (μs→ms) */
  nativeInputReceiveMs?: number;
  /** Native upload stage (μs→ms) */
  nativeUploadMs?: number;
  /** Native effect stage (μs→ms) */
  nativeEffectMs?: number;
  /** Native download stage (μs→ms) */
  nativeDownloadMs?: number;
  /** Native pre-write total (μs→ms) — sum of upload+effect+download */
  nativePreWriteTotalMs?: number;
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
  /** True when the native presenter handled the frame (no pixel data returned). */
  _metadataOnly?: boolean;
} & NativeFrameTimingFields;

/**
 * Safe numeric extraction from an unknown message field.
 * Returns `undefined` for null/undefined/non-finite values, preserving the
 * distinction between unavailable and zero.
 *
 * Exported for testing.
 */
export function toNum(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Decode timing fields from a raw frame response message.
 * The main process includes these as JSON properties on the MessagePort
 * response (both shared-slot and fallback paths).
 *
 * Exported for testing.
 */
export function decodeNativeFrameTiming(
  msg: Record<string, unknown>,
): NativeFrameTimingFields {
  return {
    mainInputHandlingMs: toNum(msg.mainInputHandlingMs),
    requestWriteMs: toNum(msg.requestWriteMs),
    responseWaitMs: toNum(msg.responseWaitMs),
    responsePayloadReadMs: toNum(msg.responsePayloadReadMs),
    mainHandlerTotalMs: toNum(msg.mainHandlerTotalMs),
    nativeInputReceiveMs: toNum(msg.nativeInputReceiveMs),
    nativeUploadMs: toNum(msg.nativeUploadMs),
    nativeEffectMs: toNum(msg.nativeEffectMs),
    nativeDownloadMs: toNum(msg.nativeDownloadMs),
    nativePreWriteTotalMs: toNum(msg.nativePreWriteTotalMs),
  };
}

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

  /** Get enhancement diagnostics from the native helper (native timing, helper state) */
  videoHelperGetDiagnostics?: () => Promise<Record<string, unknown> | null>;

  /** Phase 5: Request a dedicated MessagePort for zero-copy frame transfer */
  requestFramePort?: () => Promise<{ success: boolean }>;
  /** Phase 6: Request a frame port bound to a specific clientId lease */
  requestFramePortForClient?: (clientId: string) => Promise<{ success: boolean; error?: string }>;

  // Slice 5: Renderer-owned shared input slot registration
  rendererSlotsRegister?: (slots: SharedArrayBuffer[]) => Promise<{ success: boolean }>;
  rendererSlotsRelease?: () => Promise<{ success: boolean }>;

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
  capturePath: "none",
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

const CAPTURE_FRAME_WAIT_TIMEOUT_MS = 250;

export class NvidiaVsrBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "nvidia-vsr";
  /** Stable monotonically increasing instance identifier */
  readonly instanceId: number = nextMonotonicId();

  constructor(
    private readonly options: {
      preferDomPresentation?: boolean;
    } = {},
  ) {}

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

  // Slice 5: Renderer-owned shared input slots for zero-copy frame transport
  private inputSlots: RendererInputSlots | null = null;
  private inputSlotsGeneration: number = -1;
  private sharedSlotsUnavailable = false;

  // Slice 5: Capture path tracking
  private capturePath: "video-frame" | "rqvc-canvas" | "none" = "none";
  private videoFrameCaptureActive = false;

  // ── Persistent capture resources (avoid per-frame setup) ──────────────
  // Reusable capture buffer — reallocated only on dimension change
  private captureBuffer: Uint8Array | null = null;
  private captureBufferWidth = 0;
  private captureBufferHeight = 0;

  // MediaStreamTrackProcessor is available in Chrome/Electron 120+
  // We store the processor and track reader for cleanup
  private mediaStreamTrackProcessor: any | null = null;
  private mediaStreamTrackReader: ReadableStreamDefaultReader | null = null;

  // Source track identity for detecting track changes
  private captureTrack: MediaStreamTrack | null = null;
  private captureGeneration = 0;

  // Background capture pump state
  private capturePumpPromise: Promise<void> | null = null;
  private nextCapturedFrameResolver: (() => void) | null = null;

  // Retained VideoFrame for latest-frame semantics.
  // At most one retained captured frame; newer replaces older (old closed).
  private retainedVideoFrame: VideoFrame | null = null;

  // requestVideoFrameCallback handle for cleanup
  private rqvcHandle: number | null = null;

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

  // ── Slice 5: Capture paths ────────────────────────────────────────────

  /**
   * Ensure persistent capture resources (processor + reader) are created
   * for the current source track. Detects track changes and invalidates
   * old resources. Creates/cancels one MediaStreamTrackProcessor + one
   * reader per source generation.
   *
   * Uses the video's srcObject (existing MediaStream track) directly —
   * does NOT call video.captureStream() per frame.
   */
  private ensureCaptureResources(
    video: HTMLVideoElement,
  ): ReadableStreamDefaultReader | null {
    if (typeof VideoFrame === "undefined") return null;

    const stream = video.srcObject as MediaStream | null;
    if (!stream) return null;

    const track = stream.getVideoTracks()?.[0];
    if (!track) return null;

    // Track identity: detect whether the source track changed
    if (this.captureTrack !== track) {
      // Track changed — tear down old resources
      this.releaseCaptureResources();
      this.captureTrack = track;
      this.captureGeneration += 1;
    }

    // If processor already exists and matches current track, reuse it
    if (this.mediaStreamTrackProcessor && this.mediaStreamTrackReader) {
      return this.mediaStreamTrackReader;
    }

    // Create new processor + reader for this track
    try {
      const TProcessor = (self as any).MediaStreamTrackProcessor;
      if (!TProcessor) return null;

      const processor = new TProcessor({ track });
      const reader = processor.readable.getReader();

      this.mediaStreamTrackProcessor = processor;
      this.mediaStreamTrackReader = reader;
      this.videoFrameCaptureActive = true;
      this.capturePumpPromise = this.pumpCapturedFrames(reader, this.captureGeneration);

      return reader;
    } catch {
      return null;
    }
  }

  private async pumpCapturedFrames(
    reader: ReadableStreamDefaultReader,
    generation: number,
  ): Promise<void> {
    try {
      while (
        !this.destroyed &&
        generation === this.captureGeneration &&
        this.mediaStreamTrackReader === reader
      ) {
        const readResult = await reader.read();

        if (readResult.done || !readResult.value) {
          break;
        }

        const frame = readResult.value as VideoFrame;

        if (
          this.destroyed ||
          generation !== this.captureGeneration ||
          this.mediaStreamTrackReader !== reader
        ) {
          frame.close();
          break;
        }

        if (this.retainedVideoFrame) {
          try {
            this.retainedVideoFrame.close();
          } catch {
            // ignore
          }
          this.stats = {
            ...this.stats,
            coalescedCount: (this.stats.coalescedCount ?? 0) + 1,
          };
        }

        this.retainedVideoFrame = frame;
        const notify = this.nextCapturedFrameResolver;
        this.nextCapturedFrameResolver = null;
        notify?.();
      }
    } catch {
      // Let caller fall back to canvas or recreate capture resources later.
    } finally {
      if (generation === this.captureGeneration && this.mediaStreamTrackReader === reader) {
        this.mediaStreamTrackReader = null;
        this.mediaStreamTrackProcessor = null;
        this.capturePumpPromise = null;
        this.videoFrameCaptureActive = false;
        const notify = this.nextCapturedFrameResolver;
        this.nextCapturedFrameResolver = null;
        notify?.();
      }
    }
  }

  private async takeLatestCapturedFrame(
    generation: number,
  ): Promise<VideoFrame | null> {
    if (this.retainedVideoFrame) {
      const frame = this.retainedVideoFrame;
      this.retainedVideoFrame = null;
      return frame;
    }

    if (
      generation !== this.captureGeneration ||
      !this.mediaStreamTrackReader ||
      this.destroyed
    ) {
      return null;
    }

    const waitOutcome = await new Promise<"frame" | "timeout">((resolve) => {
      const resolver = () => resolve("frame");
      this.nextCapturedFrameResolver = resolver;

      const timeout = setTimeout(() => {
        if (this.nextCapturedFrameResolver === resolver) {
          this.nextCapturedFrameResolver = null;
        }
        resolve("timeout");
      }, CAPTURE_FRAME_WAIT_TIMEOUT_MS);

      const wrappedResolver = () => {
        clearTimeout(timeout);
        resolve("frame");
      };

      this.nextCapturedFrameResolver = wrappedResolver;
    });

    if (waitOutcome !== "frame") {
      return null;
    }

    if (
      generation !== this.captureGeneration ||
      this.destroyed ||
      !this.retainedVideoFrame
    ) {
      return null;
    }

    const frame = this.retainedVideoFrame;
    this.retainedVideoFrame = null;
    return frame;
  }

  /**
   * Release capture resources (processor + reader).
   * Cancels the reader and clears references.
   * Also closes any retained VideoFrame.
   */
  private releaseCaptureResources(): void {
    this.captureGeneration += 1;

    // Close retained VideoFrame exactly once
    if (this.retainedVideoFrame) {
      try {
        this.retainedVideoFrame.close();
      } catch {
        // ignore
      }
      this.retainedVideoFrame = null;
    }

    // Cancel reader
    if (this.mediaStreamTrackReader) {
      this.mediaStreamTrackReader.cancel().catch(() => {});
      try {
        (this.mediaStreamTrackReader as ReadableStreamDefaultReader & { releaseLock?: () => void }).releaseLock?.();
      } catch {
        // ignore
      }
      this.mediaStreamTrackReader = null;
    }
    this.mediaStreamTrackProcessor = null;
    this.capturePumpPromise = null;
    this.videoFrameCaptureActive = false;
    this.captureTrack = null;

    const notify = this.nextCapturedFrameResolver;
    this.nextCapturedFrameResolver = null;
    notify?.();
  }

  /**
   * Capture a single frame using persistent MediaStreamTrackProcessor + reader.
   *
   * Uses the existing received track from video.srcObject as MediaStream.
   * Does NOT call video.captureStream() per frame.
   * Creates/cancels one processor + one reader per source generation.
   * Reuses the RGBA capture buffer (reallocates only on dimension change).
   *
   * Latest-frame semantics:
   * - One active reader.read() at a time.
   * - If a newer captured frame arrives while one is pending, the older
   *   retained frame is closed and replaced.
   * - No FIFO backlog.
   */
  private async captureFrameViaVideoFrameCopy(
    video: HTMLVideoElement,
  ): Promise<{ frameData: Uint8Array; inputWidth: number; inputHeight: number; timing: { captureStart: number; copyToEnd: number } } | null> {
    if (typeof VideoFrame === "undefined") return null;

    const captureStart = performance.now();

    // Ensure persistent capture resources exist for the current source track
    const reader = this.ensureCaptureResources(video);
    if (!reader) return null;
    const captureGeneration = this.captureGeneration;

    try {
      const videoFrame = await this.takeLatestCapturedFrame(captureGeneration);

      if (!videoFrame) {
        return null;
      }

      const fmt = videoFrame.format;
      const w = videoFrame.displayWidth;
      const h = videoFrame.displayHeight;

      // Only support RGBA format (or convert)
      if (fmt !== "RGBA" && fmt !== "RGBX") {
        videoFrame.close();
        return null;
      }

      // Reuse capture buffer; reallocate only on dimension change
      const neededSize = w * h * 4;
      if (!this.captureBuffer || this.captureBuffer.byteLength < neededSize ||
          this.captureBufferWidth !== w || this.captureBufferHeight !== h) {
        this.captureBuffer = new Uint8Array(neededSize);
        this.captureBufferWidth = w;
        this.captureBufferHeight = h;
      }

      // Copy frame data into reusable buffer
      await videoFrame.copyTo(this.captureBuffer);
      videoFrame.close();

      const copyToEnd = performance.now();

      this.videoFrameCaptureActive = true;
      this.capturePath = "video-frame";

      return {
        frameData: this.captureBuffer,
        inputWidth: w,
        inputHeight: h,
        timing: { captureStart, copyToEnd },
      };
    } catch (err) {
      // VideoFrame read failed — will fall back to rqvc+canvas
      return null;
    }
  }

  /**
   * Capture a frame using requestVideoFrameCallback + canvas readback.
   * This is the fallback path, explicitly labeled as such.
   */
  private async captureFrameViaRqvcCanvas(
    video: HTMLVideoElement,
    inputWidth: number,
    inputHeight: number,
  ): Promise<{ frameData: Uint8Array; timing: { drawImageMs: number; getImageDataMs: number; totalMs: number } } | null> {
    if (
      !this.captureCanvas ||
      !this.captureContext
    ) return null;

    const frameStart = performance.now();

    // Ensure capture canvas is sized correctly
    if (
      this.captureCanvas.width !== inputWidth ||
      this.captureCanvas.height !== inputHeight
    ) {
      this.captureCanvas.width = inputWidth;
      this.captureCanvas.height = inputHeight;
    }

    // ── Phase A1: drawImage ──────────────────────────────────────────
    const drawImageStart = performance.now();

    try {
      this.captureContext.drawImage(
        video,
        0,
        0,
        inputWidth,
        inputHeight,
      );
    } catch {
      return null;
    }

    const afterDrawImage = performance.now();
    const drawImageMs = afterDrawImage - drawImageStart;

    // ── Phase A2: getImageData ───────────────────────────────────────
    const source = this.captureContext.getImageData(
      0,
      0,
      inputWidth,
      inputHeight,
    );
    const afterGetImageData = performance.now();
    const getImageDataMs = afterGetImageData - afterDrawImage;

    // ── Phase A3: buffer preparation ─────────────────────────────────
    const frameData = new Uint8Array(
      source.data.buffer,
      source.data.byteOffset,
      source.data.byteLength,
    );

    this.capturePath = "rqvc-canvas";

    return {
      frameData,
      timing: {
        drawImageMs,
        getImageDataMs,
        totalMs: performance.now() - frameStart,
      },
    };
  }

  // ── Shared-slot submission helpers (Slice 5) ───────────────────────────

  /**
   * Initialize and register renderer-owned shared input slots.
   * Called once per generation during initial configuration.
   */
  private async ensureInputSlots(generation: number): Promise<boolean> {
    // PERF: Once SharedArrayBuffer is known unavailable, skip entirely.
    // Avoids per-frame retry loop that floods the console with "SharedArrayBuffer
    // not available" warnings and creates unnecessary RendererInputSlots instances.
    if (this.sharedSlotsUnavailable) return false;

    // Already created for this generation
    if (this.inputSlots && this.inputSlotsGeneration === generation && this.inputSlots.isCreated) {
      return this.inputSlots.isRegistered;
    }

    // Release old slots if generation changed
    if (this.inputSlots && this.inputSlotsGeneration !== generation) {
      const api = getVideoApi();
      if (api?.rendererSlotsRelease) {
        await this.inputSlots.release(() => api.rendererSlotsRelease!());
      }
      this.inputSlots.destroy();
      this.inputSlots = null;
    }

    const api = getVideoApi();
    if (!api?.rendererSlotsRegister || !api.rendererSlotsRelease) {
      return false; // slots not supported by this runtime
    }

    // Create and register
    const slots = new RendererInputSlots();
    if (!slots.create()) {
      this.sharedSlotsUnavailable = true;
      this.inputSlots = null;
      return false;
    }

    const registered = await slots.register(
      (bufs) => api.rendererSlotsRegister!(bufs),
    );

    if (!registered) {
      slots.destroy();
      this.inputSlots = null;
      return false;
    }

    this.inputSlots = slots;
    this.inputSlotsGeneration = generation;

    lifecycleLog("NvidiaBackend", "inputSlotsReady", {
      instanceId: this.instanceId,
      generation,
    });

    return true;
  }

  /**
   * Submit a frame via the MessagePort using the optimized shared-slot path.
   * Per-frame payload is metadata-only (~32 bytes) — the pixel data is
   * written directly to the shared slot by the renderer.
   */
  private submitFrameViaSharedSlot(
    generation: number,
    frameSequence: number,
    frameData: Uint8Array,
    inputWidth: number,
    inputHeight: number,
  ): Promise<NativeFrameResult | null> {
    return new Promise((resolve) => {
      const port = this.framePort;
      if (!port || !this.inputSlots || !this.inputSlots.isRegistered) {
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
        const raw = evt.data as Record<string, unknown>;
        const msg = raw as {
          generation?: number;
          sequence?: number;
          width?: number;
          height?: number;
          error?: string;
          _metadataOnly?: boolean;
        };

        if (msg.error) {
          settled = true;
          clearTimeout(timeout);
          port.onmessage = null;
          console.error("[nvidia-vsr] Shared-slot processing error:", msg.error);
          resolve(null);
          return;
        }

        settled = true;
        clearTimeout(timeout);
        port.onmessage = null;

        // Decode native timing fields from the message
        const timing = decodeNativeFrameTiming(raw);

        // Metadata-only response: native presenter handled the frame
        // Pixels are empty — renderer skips WebGL texture upload
        if (msg._metadataOnly) {
          resolve({
            generation,
            sequence: frameSequence,
            pixels: new Uint8Array(0),
            width: msg.width ?? 0,
            height: msg.height ?? 0,
            configurationId: toNum(raw.configurationId),
            appliedQualityLevel: toNum(raw.appliedQualityLevel),
            _metadataOnly: true,
            ...timing,
          });
          return;
        }

        // Full response with pixel data
        const rawPixels = raw.pixels;
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
          configurationId: toNum(raw.configurationId),
          appliedQualityLevel: toNum(raw.appliedQualityLevel),
          ...timing,
        });
      };

      // Write pixel data to the shared slot
      const slotIndex = this.inputSlots.nextSlot();
      const wrote = this.inputSlots.writeSlot(
        slotIndex,
        generation,
        frameSequence,
        inputWidth,
        inputHeight,
        frameData,
      );

      if (!wrote) {
        clearTimeout(timeout);
        port.onmessage = null;
        resolve(null);
        return;
      }

      // Send metadata-only message (no frameData)
      port.postMessage({
        clientId: this.clientId,
        generation,
        frameSequence,
        slotIndex,
        inputWidth,
        inputHeight,
        // Deliberately no frameData — main process reads from shared slot
      });
    });
  }

  /**
   * Submit a frame via the MessagePort using structured-cloned binary data.
   * Uses exact-buffer path: if frameData covers entire backing ArrayBuffer,
   * use that exact buffer with structured clone and no slice.
   * If partial view, create exactly one right-sized copy.
   *
   * This is the explicit fallback path when shared slots are unavailable.
   */
  private async submitFrameViaPort(
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
        const raw = evt.data as Record<string, unknown>;
        const msg = raw as {
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

        // Decode native timing fields from the message
        const timing = decodeNativeFrameTiming(raw);

        // Pixels arrive as Uint8Array (structured clone, not transferred)
        const rawPixels = raw.pixels;
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
          configurationId: toNum(raw.configurationId),
          appliedQualityLevel: toNum(raw.appliedQualityLevel),
          ...timing,
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
          // Explicit fallback — structured clone path
          _fallbackPath: true,
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
        capturePath: "none",
      };

      // Try to activate native presenter (GPU-resident display path)
      // This is best-effort — failure here just means we fall back to WebGL
      this.nativePresenterActive = false;
      this.nativePresenterSupported = !this.options.preferDomPresentation && Boolean(api?.nativePresenterAttach && api?.nativePresenterDetach);
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

      // ── Phase 6: Correlated frame identity ─────────────────────────────
      const generation = metadata?.generation ?? this.generation;
      const frameSequence = metadata?.frameSequence ?? 0;

      // ── Frame capture ──────────────────────────────────────────────────
      const frameStart = performance.now();

      // Slice 5: Try VideoFrame/MediaStreamTrackProcessor/copyTo first
      let frameData: Uint8Array;
      let captureReadbackMs = 0;
      let drawImageMs = 0;
      let getImageDataMs = 0;
      let inputBufferPreparationMs = 0;
      let usedCapturePath: "video-frame" | "rqvc-canvas" = "rqvc-canvas";

      const vfResult = await this.captureFrameViaVideoFrameCopy(video);

      if (vfResult) {
        frameData = vfResult.frameData;
        const actualInputWidth = vfResult.inputWidth;
        const actualInputHeight = vfResult.inputHeight;

        // Only adjust input dimensions if VideoFrame gave different values
        // (shouldn't normally happen, but handle it)
        if (actualInputWidth !== inputWidth || actualInputHeight !== inputHeight) {
          // Log discrepancy but use original for consistency
        }

        inputBufferPreparationMs = 0; // copyTo is direct
        captureReadbackMs = vfResult.timing.copyToEnd - vfResult.timing.captureStart;
        usedCapturePath = "video-frame";
        this.capturePath = "video-frame";
      } else {
        // ── Fallback: canvas readback ─────────────────────────────────────
        if (
          this.captureCanvas.width !== inputWidth ||
          this.captureCanvas.height !== inputHeight
        ) {
          this.captureCanvas.width = inputWidth;
          this.captureCanvas.height = inputHeight;
        }

        // ── Renderer timing: Phase A1 — drawImage ────────────────────────
        const drawImageStart = performance.now();

        this.captureContext.drawImage(
          video,
          0,
          0,
          inputWidth,
          inputHeight,
        );

        const afterDrawImage = performance.now();
        drawImageMs = afterDrawImage - drawImageStart;

        // ── Renderer timing: Phase A2 — getImageData ─────────────────────
        const source = this.captureContext.getImageData(
          0,
          0,
          inputWidth,
          inputHeight,
        );

        const afterGetImageData = performance.now();
        getImageDataMs = afterGetImageData - afterDrawImage;

        // ── Renderer timing: Phase A3 — input buffer preparation ─────────
        frameData = new Uint8Array(
          source.data.buffer,
          source.data.byteOffset,
          source.data.byteLength,
        );

        const afterBufferPrep = performance.now();
        inputBufferPreparationMs = afterBufferPrep - afterGetImageData;
        captureReadbackMs = drawImageMs + getImageDataMs;
        usedCapturePath = "rqvc-canvas";
        this.capturePath = "rqvc-canvas";
      }

      const api = getVideoApi();

      if (!api?.videoHelperSubmitFrame) {
        return { success: false };
      }

      // Ensure shared input slots are ready for this generation
      const sharedSlotsAvailable = await this.ensureInputSlots(generation);

      // ── Renderer timing: Phase B — native transport (renderer-observed) ──
      let result: NativeFrameResult | null = null;

      if (this.framePort || await this.acquireClientAndPort()) {
        if (sharedSlotsAvailable) {
          // Optimized path: metadata-only via shared slots
          result = await this.submitFrameViaSharedSlot(
            generation,
            frameSequence,
            frameData,
            inputWidth,
            inputHeight,
          );
        } else {
          // Fallback path: structured clone via MessagePort
          result = await this.submitFrameViaPort(
            generation,
            frameSequence,
            frameData,
            inputWidth,
            inputHeight,
          );
        }
      } else {
        // Fall back to invoke-based submission (legacy path)
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
      const rendererToResultMs = afterResult - (frameStart + captureReadbackMs + inputBufferPreparationMs);

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

      // ── Metadata-only / Native presenter path (no pixel data) ────────
      // When the native presenter is active (GPU-resident display), or when
      // the shared-slot path indicates metadata-only completion, the native
      // helper presents the frame directly to a D3D11 swapchain overlay window.
      // No pixel data is returned — we skip texture upload entirely.
      const noPixels = !result.pixels || result.pixels.byteLength === 0;

      if (noPixels && (this.nativePresenterActive || result._metadataOnly)) {
        // Frame was presented natively — no WebGL texture upload needed.
        // GPU time and native per-stage timings are NOT available in this path.
        const rendererTotalMs = performance.now() - frameStart;

        this.stats = {
          inputWidth,
          inputHeight,
          outputWidth: result.width || output.width,
          outputHeight: result.height || output.height,
          enhancedScalingActive: true,
          lastGpuTimeMs: null,
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
          capturePath: usedCapturePath,
        };

        // Build timing breakdown with truthful values:
        // - textureUploadMs = 0 (no WebGL upload in this path; that's truthful)
        // - displayUploadMs removed (was duplicating textureUploadMs)
        // - nativeTransportProcessingMs only when native timing available
        // - nativeDownloadMs undefined (GPU→GPU path; no CPU download)
        const nativePreWrite = result.nativePreWriteTotalMs;

        return {
          success: true,
          gpuTimeMs: undefined,
          outputWidth: result.width || output.width,
          outputHeight: result.height || output.height,
          totalLatencyMs: rendererTotalMs,
          configurationId: result.configurationId ?? this.expectedConfigurationId,
          canonicalQualityLevel: this.currentQualityLevel,
          timingBreakdown: {
            captureReadbackMs,
            drawImageMs,
            getImageDataMs,
            inputBufferPreparationMs,
            rendererToResultMs,
            textureUploadMs: 0,
            rendererTotalMs,
            // nativeTransportProcessingMs: only when native timing available
            ...(nativePreWrite !== undefined ? { nativeTransportProcessingMs: nativePreWrite } : {}),
            // displayUploadMs removed: no duplicate in this path either
            // Native per-stage timings from result (if available from frame header)
            nativeInputReceiveMs: result.nativeInputReceiveMs,
            nativeUploadMs: result.nativeUploadMs,
            nativeEffectMs: result.nativeEffectMs,
            nativeDownloadMs: undefined,
            nativePreWriteTotalMs: nativePreWrite,
          },
        };
      }

      // If native presenter is active but pixel data was returned, it means
      // the GPU-to-GPU path failed and we fell back to CPU download.
      // Continue with normal WebGL texture upload below.

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

      // Renderer total: full frame processing time
      const rendererTotalMs = afterDisplay - frameStart;

      // Native per-stage timings from result (from frame header)
      const nativePreWriteTotalMs = result.nativePreWriteTotalMs;

      // lastGpuTimeMs / gpuTimeMs: represent actual native GPU/effect/pre-write work
      // when available (nativePreWriteTotalMs), NOT the full renderer round-trip.
      const nativeGpuTimeMs = nativePreWriteTotalMs ?? null;

      // nativeTransportProcessingMs: only set when native timing is available.
      // Do NOT fall back to rendererToResultMs (that would mislabel renderer-observed
      // wait time as native-only processing).
      const nativeTransportMs = nativePreWriteTotalMs;

      this.stats = {
        inputWidth,
        inputHeight,
        outputWidth: result.width,
        outputHeight: result.height,
        enhancedScalingActive:
          result.width > inputWidth || result.height > inputHeight,
        lastGpuTimeMs: nativeGpuTimeMs,
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
        capturePath: usedCapturePath,
      };

      return {
        success: true,
        gpuTimeMs: nativeGpuTimeMs ?? undefined,
        outputWidth: result.width,
        outputHeight: result.height,
        totalLatencyMs: rendererTotalMs,
        configurationId: result.configurationId ?? this.expectedConfigurationId,
        canonicalQualityLevel: this.currentQualityLevel,
        timingBreakdown: {
          captureReadbackMs,
          drawImageMs,
          getImageDataMs,
          inputBufferPreparationMs,
          rendererToResultMs,
          textureUploadMs,
          rendererTotalMs,
          // nativeTransportProcessingMs: only when native timing available;
          // do NOT fallback to rendererToResultMs (avoids mislabeling)
          ...(nativeTransportMs !== undefined ? { nativeTransportProcessingMs: nativeTransportMs } : {}),
          // displayUploadMs removed: it duplicated textureUploadMs;
          // textureUploadMs above IS the display upload step in the WebGL path.
          // Main-process per-frame timings (truthful labels, from result)
          mainInputHandlingMs: result.mainInputHandlingMs,
          requestWriteMs: result.requestWriteMs,
          responseWaitMs: result.responseWaitMs,
          mainHandlerTotalMs: result.mainHandlerTotalMs,
          // Native per-stage timings (only knowable-before-write, from result)
          nativeInputReceiveMs: result.nativeInputReceiveMs,
          nativeUploadMs: result.nativeUploadMs,
          nativeEffectMs: result.nativeEffectMs,
          nativeDownloadMs: result.nativeDownloadMs,
          nativePreWriteTotalMs: result.nativePreWriteTotalMs,
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
      capturePath: this.capturePath,
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

    // Slice 5: Clean up shared input slots
    if (this.inputSlots) {
      const slotsApi = getVideoApi();
      if (slotsApi?.rendererSlotsRelease && this.inputSlots.isRegistered) {
        this.inputSlots.release(() => slotsApi.rendererSlotsRelease!()).catch(() => {});
      }
      this.inputSlots.destroy();
      this.inputSlots = null;
    }
    this.inputSlotsGeneration = -1;
    this.sharedSlotsUnavailable = false;

    // Release persistent capture resources (cancels reader, closes retained frame)
    this.releaseCaptureResources();

    // Free reusable capture buffer
    this.captureBuffer = null;
    this.captureBufferWidth = 0;
    this.captureBufferHeight = 0;

    // Cancel pending requestVideoFrameCallback
    if (this.rqvcHandle !== null) {
      // No cancel API needed; just null the handle
      this.rqvcHandle = null;
    }

    this.capturePath = "none";

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
