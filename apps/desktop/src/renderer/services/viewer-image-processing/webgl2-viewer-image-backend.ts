// SPDX-License-Identifier: MIT
/**
 * WebGL2 rendering backend for the ScreenLink GPU image enhancement pipeline.
 *
 * Multi-pass pipeline (new design, schema v2):
 *   1. Upload pass                — copy video frame to source texture
 *   2. Compression Cleanup        — edge-aware luma/chroma cleanup (optional, source res)
 *   3a. EASU scaling              — AMD EASU 12-tap upscaler to intermediate target (optional)
 *   3b. Bicubic scaling           — final Catmull-Rom 4x4 upsample to display res (optional)
 *   3c. Native draw               — hardware bilinear scaling (optional, algorithm=native)
 *   4. Sharpen pass               — CAS sharpening + noise protection (optional, display res)
 *   5. Deband + dither            — spatial gradient debanding with proportional dither (optional, display res)
 *   6. Final blit                 — centered contained blit to canvas with letterbox
 *
 * Pipeline order:
 *   Source → [CompressionCleanup] → [EASU to intermediate] → [Bicubic final] →
 *   [Sharpen with noise protection] → [Deband + dither] → Display
 *
 * When scalingAlgorithm is:
 *   - native:  skip EASU and bicubic, draw source directly (with hardware bilinear if needed)
 *   - bicubic: skip EASU, bicubic source → display
 *   - fsr1-easu: EASU source → intermediate, then bicubic intermediate → display (if needed)
 *
 * All GPU resources are reused across frames. No per-frame allocations.
 * No per-frame shader compilation or texture/FBO creation.
 */

import type { ViewerImageEnhancementSettings, ScalingAlgorithm, FsrTargetScale, FsrFinalScaler, EasuTargetResult } from "./viewer-image-settings";
import {
  createShader,
  createProgram,
  createTexture,
  createFramebuffer,
  deleteProgram,
  deleteTexture,
  deleteFramebuffer,
} from "./webgl2-resources";
import { computeEasuTarget } from "./viewer-image-settings";

// Vite ?raw imports for shader source strings
import fullscreenVert from "./shaders/fullscreen.vert.glsl?raw";
import cleanupFrag from "./shaders/cleanup.frag.glsl?raw";
import debandFrag from "./shaders/deband.frag.glsl?raw";
import easuFrag from "./shaders/easu.frag.glsl?raw";
import bicubicFrag from "./shaders/bicubic.frag.glsl?raw";
import lanczosFrag from "./shaders/lanczos.frag.glsl?raw";
import sharpenFrag from "./shaders/sharpen.frag.glsl?raw";
import rcasFrag from "./shaders/rcas.frag.glsl?raw";

// ─── Inline passthrough fragment shader for final blit ───────────────────────

const PASSTHROUGH_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_sourceTexture;
void main() {
  fragColor = texture(u_sourceTexture, v_texCoord);
}`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BackendInitResult {
  success: boolean;
  reason?: string;
}

export interface FrameProcessResult {
  success: boolean;
  gpuTimeMs?: number;
  /** true when the frame was skipped due to transient conditions (e.g. video not ready yet).
   *  Callers should NOT treat this as a permanent failure or trigger fallback. */
  transient?: boolean;
}

export interface BackendStats {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  enhancedScalingActive: boolean;
  lastGpuTimeMs: number | null;
  contextLossCount: number;
  backend: "webgl2" | "unavailable";
  scalingAlgorithm: ScalingAlgorithm;
  easuTargetWidth: number;
  easuTargetHeight: number;
  finalBicubicActive: boolean;
  fsrFinalScaler: FsrFinalScaler | null;
  rcasActive: boolean;
  activePasses: string[];
}

interface DisjointTimerQueryWebGL2 {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

// Maximum dimension to prevent GPU overload (4K ceiling)
const MAX_OUTPUT_DIMENSION = 3840;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute a centered, aspect-ratio-contained render rect within an output canvas.
 * Returns { x, y, w, h } in pixel coordinates.
 */
function computeContainedRect(
  sourceW: number,
  sourceH: number,
  outW: number,
  outH: number,
): { x: number; y: number; w: number; h: number } {
  if (sourceW <= 0 || sourceH <= 0 || outW <= 0 || outH <= 0) {
    return { x: 0, y: 0, w: outW, h: outH };
  }

  const srcAspect = sourceW / sourceH;
  const outAspect = outW / outH;

  let renderW: number;
  let renderH: number;

  if (srcAspect > outAspect) {
    // Source is wider — constrained by width
    renderW = outW;
    renderH = outW / srcAspect;
  } else {
    // Source is taller or equal — constrained by height
    renderH = outH;
    renderW = outH * srcAspect;
  }

  // Floor to integer pixels
  renderW = Math.floor(renderW);
  renderH = Math.floor(renderH);

  const x = Math.floor((outW - renderW) / 2);
  const y = Math.floor((outH - renderH) / 2);

  return { x, y, w: renderW, h: renderH };
}

/**
 * Pre-compute FSR 1 EASU constants from source and output dimensions.
 * These are derived from the official AMD FSR implementation.
 */
function computeEasuConstants(
  sourceW: number,
  sourceH: number,
  outputW: number,
  outputH: number,
): [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
] {
  const sourceInvX = 1.0 / sourceW;
  const sourceInvY = 1.0 / sourceH;
  const scaleX = sourceW / outputW;
  const scaleY = sourceH / outputH;

  // Matches AMD FsrEasuCon() using input viewport == source texture size.
  return [
    scaleX,
    scaleY,
    0.5 * scaleX - 0.5,
    0.5 * scaleY - 0.5,
    sourceInvX,
    sourceInvY,
    sourceInvX,
    -sourceInvY,
    -sourceInvX,
    2.0 * sourceInvY,
    sourceInvX,
    2.0 * sourceInvY,
    0.0,
    4.0 * sourceInvY,
    0.0,
    0.0,
  ];
}

// ─── Backend ─────────────────────────────────────────────────────────────────

export class WebGL2ViewerImageBackend {
  // Core GL state
  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private contextLossCount = 0;
  private initialized = false;

  // Texture / FBO resources
  private sourceTexture: WebGLTexture | null = null;
  private cleanupTexture: WebGLTexture | null = null;
  private cleanupFBO: WebGLFramebuffer | null = null;
  private lastCleanupWidth = 0;
  private lastCleanupHeight = 0;
  private debandTexture: WebGLTexture | null = null;
  private debandFBO: WebGLFramebuffer | null = null;
  private lastDebandWidth = 0;
  private lastDebandHeight = 0;
  private scaleTexture: WebGLTexture | null = null;
  private scaleFBO: WebGLFramebuffer | null = null;
  private lastScaleWidth = 0;
  private lastScaleHeight = 0;
  // EASU intermediate target (renamed from bicubicTexture)
  private easuTexture: WebGLTexture | null = null;
  private easuFBO: WebGLFramebuffer | null = null;
  private lastEasuTargetWidth = 0;
  private lastEasuTargetHeight = 0;
  private outputTexture: WebGLTexture | null = null;
  private outputFBO: WebGLFramebuffer | null = null;
  private lastOutputWidth = 0;
  private lastOutputHeight = 0;

  // Shader programs
  private fullscreenProgram: WebGLProgram | null = null;
  private cleanupProgram: WebGLProgram | null = null;
  private debandProgram: WebGLProgram | null = null;
  private easuProgram: WebGLProgram | null = null;
  private bicubicProgram: WebGLProgram | null = null;
  private lanczosProgram: WebGLProgram | null = null;
  private sharpenProgram: WebGLProgram | null = null;
  private rcasProgram: WebGLProgram | null = null;

  // Cached uniform locations
  private cleanupUniforms: Record<string, WebGLUniformLocation | null> = {};
  private debandUniforms: Record<string, WebGLUniformLocation | null> = {};
  private easuUniforms: Record<string, WebGLUniformLocation | null> = {};
  private bicubicUniforms: Record<string, WebGLUniformLocation | null> = {};
  private lanczosUniforms: Record<string, WebGLUniformLocation | null> = {};
  private sharpenUniforms: Record<string, WebGLUniformLocation | null> = {};
  private rcasUniforms: Record<string, WebGLUniformLocation | null> = {};
  private fullscreenUniforms: Record<string, WebGLUniformLocation | null> = {};

  // Dimensions
  private inputWidth = 0;
  private inputHeight = 0;
  private outputWidth = 0;
  private outputHeight = 0;
  private renderX = 0;
  private renderY = 0;
  private renderWidth = 0;
  private renderHeight = 0;

  // Settings
  private settings: ViewerImageEnhancementSettings = {
    enabled: false,
    scalingAlgorithm: "native",
    fsrTargetScale: "auto",
    fsrFinalScaler: "bicubic",
    sharpeningStrength: 0.25,
    noiseProtection: 0.0,
    compressionCleanup: 0.0,
    debanding: 0.0,
    _schemaVersion: 3,
  };

  // Cached EASU constants (recomputed when dimensions change)
  private lastEasuSourceW = -1;
  private lastEasuSourceH = -1;
  private lastEasuOutputW = -1;
  private lastEasuOutputH = -1;
  private easuConstants: Float32Array = new Float32Array(16);

  // Cached EASU target (recomputed when dimensions or fsrTargetScale change)
  private lastEasuTargetSourceW = -1;
  private lastEasuTargetSourceH = -1;
  private lastEasuTargetFinalW = -1;
  private lastEasuTargetFinalH = -1;
  private lastEasuTargetScale: FsrTargetScale | null = null;
  private easuTargetResult: ReturnType<typeof computeEasuTarget> | null = null;

  // GPU timers (EXT_disjoint_timer_query_webgl2)
  private timerExt: DisjointTimerQueryWebGL2 | null = null;
  private timerQueries: WebGLQuery[] = [];
  private activeTimerIndex = 0;
  private lastGpuTimeMs: number | null = null;
  private pendingTimerAvailable = false;

  // Fallback CPU timing
  private frameStartTime = 0;
  private lastCpuTimeMs: number | null = null;

  // Source texture tracking
  private sourceWidth = 0;
  private sourceHeight = 0;

  // Context loss handler references (for cleanup)
  private _onContextLost: ((e: Event) => void) | null = null;
  private _onContextRestored: (() => void) | null = null;

  constructor() {
    // Nothing to initialise — call initialize(canvas) to set up GL
  }

  // ─── Initialisation ────────────────────────────────────────────────────

  initialize(canvas: HTMLCanvasElement): BackendInitResult {
    try {
      this.canvas = canvas;

      const gl = canvas.getContext("webgl2", {
        premultipliedAlpha: false,
        alpha: false,
        preserveDrawingBuffer: false,
        antialias: false,
        depth: false,
        stencil: false,
      });

      if (!gl) {
        return {
          success: false,
          reason:
            "WebGL2 not available — browser does not support WebGL2 context",
        };
      }

      this.gl = gl;

      // Create VAO for fullscreen tri (no vertex buffers — uses gl_VertexID)
      const vao = gl.createVertexArray();
      if (!vao) {
        this.destroy();
        return { success: false, reason: "Failed to create vertex array" };
      }
      gl.bindVertexArray(vao);
      this.vao = vao;

      // Compile all shader programs
      this.fullscreenProgram = createProgram(gl, fullscreenVert, PASSTHROUGH_FRAG_SRC);
      this.cleanupProgram = createProgram(gl, fullscreenVert, cleanupFrag);
      this.debandProgram = createProgram(gl, fullscreenVert, debandFrag);
      this.easuProgram = createProgram(gl, fullscreenVert, easuFrag);
      this.bicubicProgram = createProgram(gl, fullscreenVert, bicubicFrag);
      this.lanczosProgram = createProgram(gl, fullscreenVert, lanczosFrag);
      this.sharpenProgram = createProgram(gl, fullscreenVert, sharpenFrag);
      this.rcasProgram = createProgram(gl, fullscreenVert, rcasFrag);

      // Cache uniform locations
      this.cacheUniforms(gl);

      // Set up timer query extension
      this.timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      if (this.timerExt) {
        try {
          const q1 = gl.createQuery();
          const q2 = gl.createQuery();
          if (q1 && q2) {
            this.timerQueries = [q1, q2];
          }
        } catch {
          // GPU timing unavailable — continue without timer queries
          this.timerQueries = [];
        }
      }

      // Context loss handling
      this._onContextLost = (e: Event) => {
        e.preventDefault();
        this.handleContextLost();
      };
      this._onContextRestored = () => {
        this.handleContextRestored();
      };
      canvas.addEventListener("webglcontextlost", this._onContextLost);
      canvas.addEventListener(
        "webglcontextrestored",
        this._onContextRestored,
      );

      this.initialized = true;
      return { success: true };
    } catch (err) {
      this.destroy();
      return {
        success: false,
        reason:
          err instanceof Error
            ? `WebGL2 initialisation error: ${err.message}`
            : "Unknown WebGL2 initialisation error",
      };
    }
  }

  // ─── Settings ──────────────────────────────────────────────────────────

  updateSettings(settings: ViewerImageEnhancementSettings): void {
    this.settings = { ...settings };
  }

  // ─── Resizing ──────────────────────────────────────────────────────────

  /**
   * Resize the output canvas and reallocate output/upscale FBOs.
   * Called when the container DOM element changes size.
   */
  resizeOutput(width: number, height: number, dpr: number): void {
    const gl = this.gl;
    if (!gl) return;

    const pixelWidth = Math.floor(width * dpr);
    const pixelHeight = Math.floor(height * dpr);
    const cappedWidth = Math.min(pixelWidth, MAX_OUTPUT_DIMENSION);
    const cappedHeight = Math.min(pixelHeight, MAX_OUTPUT_DIMENSION);

    if (
      cappedWidth === this.outputWidth &&
      cappedHeight === this.outputHeight
    ) {
      // No change — just update canvas style size
      if (this.canvas) {
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
      }
      return;
    }

    this.outputWidth = cappedWidth;
    this.outputHeight = cappedHeight;

    // Update canvas backing store
    if (this.canvas) {
      this.canvas.width = cappedWidth;
      this.canvas.height = cappedHeight;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }

    // Reallocate output FBO (always needed)
    this.allocateOutputFBO(gl);

    // Reallocate scale FBO (will be sized properly on next frame)
    this.allocateScaleFBO(gl);
  }

  /**
   * Called when the source video element changes dimensions.
   * Textures are lazily recreated on the next processFrame call.
   */
  onSourceResize(sourceWidth: number, sourceHeight: number): void {
    this.inputWidth = sourceWidth;
    this.inputHeight = sourceHeight;
    // Textures are recreated on next processFrame
  }

  // ─── Frame processing ──────────────────────────────────────────────────

  processFrame(videoElement: HTMLVideoElement): FrameProcessResult {
    const gl = this.gl;
    if (!gl) {
      return { success: false };
    }

    const startTime = performance.now();

    try {
      // Detect source dimension changes
      const vw = videoElement.videoWidth;
      const vh = videoElement.videoHeight;
      if (vw === 0 || vh === 0) {
        // Video not ready yet — transient, not a failure
        return { success: false, gpuTimeMs: 0, transient: true };
      }

      if (vw !== this.inputWidth || vh !== this.inputHeight) {
        this.inputWidth = vw;
        this.inputHeight = vh;
        this.recreateSourceTexture(gl);
      }

      // Ensure source texture exists (first frame or after recreation)
      if (!this.sourceTexture) {
        this.sourceWidth = vw;
        this.sourceHeight = vh;
        this.sourceTexture = this.createSourceTexture(gl, vw, vh);
      }

      // Guard: skip if video element hasn't decoded a usable frame yet
      if (videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return { success: false, gpuTimeMs: 0, transient: true };
      }

      // --- Compute aspect-ratio contained render rect ---
      const rect = computeContainedRect(
        this.inputWidth,
        this.inputHeight,
        this.outputWidth,
        this.outputHeight,
      );
      this.renderX = rect.x;
      this.renderY = rect.y;
      this.renderWidth = rect.w;
      this.renderHeight = rect.h;

      // --- Step 1: Upload video frame to source texture ---
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        videoElement,
      );

      // --- Determine pipeline passes ---
      const algorithm = this.settings.scalingAlgorithm;
      const needsCleanup = this.settings.compressionCleanup > 0;
      const needsDeband = this.settings.debanding > 0;
      const needsSharpen = this.settings.sharpeningStrength > 0;
      // Only upscale if render viewport is larger than source in at least one dimension
      const needsUpscale = this.renderWidth > 0 && this.renderHeight > 0 &&
        (this.renderWidth > this.inputWidth || this.renderHeight > this.inputHeight);
      const isFsr = algorithm === "fsr1-easu" && needsUpscale;
      const isBicubic = algorithm === "bicubic" && needsUpscale;
      const isLanczos = algorithm === "lanczos" && needsUpscale;
      const isNative = algorithm === "native" || !needsUpscale;
      const fsrFinalScaler: FsrFinalScaler | null = isFsr ? this.settings.fsrFinalScaler : null;

      // --- Compute EASU target if FSR is active ---
      let easuTarget: EasuTargetResult | null = null;
      if (isFsr) {
        easuTarget = this.computeCachedEasuTarget(
          this.inputWidth,
          this.inputHeight,
          this.renderWidth,
          this.renderHeight,
          this.settings.fsrTargetScale,
        );
      }
      const needsEasu = isFsr && easuTarget !== null;
      const needsFinalScaler = isBicubic || isLanczos || (isFsr && easuTarget !== null && easuTarget.needsFinalScaler);
      // Native draw: when algorithm is native and source dims differ from render dims
      const needsNativeDraw = isNative &&
        (this.renderWidth !== this.inputWidth || this.renderHeight !== this.inputHeight);
      // RCAS replaces custom sharpen when FSR is active; custom sharpen only for non-FSR
      const needsRcas = isFsr && needsSharpen;
      const needsCustomSharpen = !isFsr && needsSharpen;

      // --- Start GPU timer if available ---
      this.beginTimer(gl);

      // Source for current stage starts as sourceTexture
      let currentSource: WebGLTexture = this.sourceTexture;
      let currentSourceW = this.inputWidth;
      let currentSourceH = this.inputHeight;

      // --- Step 2: Compression Cleanup pass (if needed, at source resolution) ---
      if (needsCleanup) {
        this.ensureCleanupResources(gl);
        if (this.cleanupFBO && this.cleanupTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.cleanupFBO);
          gl.viewport(0, 0, this.inputWidth, this.inputHeight);
          gl.useProgram(this.cleanupProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, currentSource);
          gl.uniform1i(this.cleanupUniforms.u_sourceTexture, 0);
          gl.uniform1f(
            this.cleanupUniforms.u_compressionCleanup,
            this.settings.compressionCleanup,
          );
          gl.uniform2f(
            this.cleanupUniforms.u_texSize,
            currentSourceW,
            currentSourceH,
          );
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.cleanupTexture;
        }
      }

      // --- Step 3a: EASU to chosen target (if algorithm is FSR) ---
      if (needsEasu && easuTarget) {
        this.ensureEasuResources(gl, easuTarget.easuW, easuTarget.easuH);
        if (this.easuFBO && this.easuTexture) {
          // Compute EASU constants for source → EASU target dimensions
          this.ensureEasuConstants(
            currentSourceW, currentSourceH,
            easuTarget.easuW, easuTarget.easuH,
          );

          gl.bindFramebuffer(gl.FRAMEBUFFER, this.easuFBO);
          gl.viewport(0, 0, easuTarget.easuW, easuTarget.easuH);
          gl.useProgram(this.easuProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, currentSource);
          gl.uniform1i(this.easuUniforms.u_sourceTexture, 0);
          gl.uniform2f(
            this.easuUniforms.u_sourceSize,
            currentSourceW,
            currentSourceH,
          );
          gl.uniform2f(
            this.easuUniforms.u_outputSize,
            easuTarget.easuW,
            easuTarget.easuH,
          );
          gl.uniform4fv(this.easuUniforms.u_easuCon0, this.easuConstants.subarray(0, 4));
          gl.uniform4fv(this.easuUniforms.u_easuCon1, this.easuConstants.subarray(4, 8));
          gl.uniform4fv(this.easuUniforms.u_easuCon2, this.easuConstants.subarray(8, 12));
          gl.uniform4fv(this.easuUniforms.u_easuCon3, this.easuConstants.subarray(12, 16));
          // Internal anti-ringing for EASU: 0.25
          gl.uniform1f(this.easuUniforms.u_antiRinging, 0.25);
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.easuTexture;
          currentSourceW = easuTarget.easuW;
          currentSourceH = easuTarget.easuH;
        }
      }

      // --- Step 3b: Final scaler (bicubic or lanczos) ---
      // Applies when:
      //   - algorithm is "bicubic" (scales source → display)
      //   - algorithm is "lanczos" (scales source → display)
      //   - FSR EASU target < display resolution (final stretch)
      if (needsFinalScaler) {
        // Determine which scaler to use
        const useLanczos = isLanczos || (isFsr && fsrFinalScaler === "lanczos");
        const scalerProgram = useLanczos ? this.lanczosProgram : this.bicubicProgram;
        const scalerUniforms = useLanczos ? this.lanczosUniforms : this.bicubicUniforms;
        const antiRinging = useLanczos ? 0.4 : 0.35;

        this.ensureScaleResources(gl);
        if (this.scaleFBO && this.scaleTexture && scalerProgram) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.scaleFBO);
          gl.viewport(0, 0, this.renderWidth, this.renderHeight);
          gl.useProgram(scalerProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, currentSource);
          gl.uniform1i(scalerUniforms.u_sourceTexture, 0);
          gl.uniform2f(
            scalerUniforms.u_sourceSize,
            currentSourceW,
            currentSourceH,
          );
          gl.uniform2f(
            scalerUniforms.u_outputSize,
            this.renderWidth,
            this.renderHeight,
          );
          gl.uniform1f(scalerUniforms.u_antiRinging, antiRinging);
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.scaleTexture;
          currentSourceW = this.renderWidth;
          currentSourceH = this.renderHeight;
        }
      }

      // --- Step 3c: Native hardware draw (if algorithm is native and dimensions differ) ---
      if (needsNativeDraw) {
        this.ensureScaleResources(gl);
        if (this.scaleFBO && this.scaleTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.scaleFBO);
          gl.viewport(0, 0, this.renderWidth, this.renderHeight);
          gl.useProgram(this.fullscreenProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, currentSource);
          gl.uniform1i(this.fullscreenUniforms.u_sourceTexture, 0);
          // Hardware bilinear filtering
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.scaleTexture;
          currentSourceW = this.renderWidth;
          currentSourceH = this.renderHeight;
        }
      }

      // --- Step 4a: RCAS sharpening (FSR path, at display resolution) ---
      if (needsRcas && this.renderWidth > 0 && this.renderHeight > 0) {
        this.ensureOutputResources(gl);
        if (this.outputFBO && this.outputTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputFBO);
          gl.viewport(0, 0, this.renderWidth, this.renderHeight);
          gl.useProgram(this.rcasProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, currentSource);
          gl.uniform1i(this.rcasUniforms.u_sourceTexture, 0);
          gl.uniform1f(
            this.rcasUniforms.u_sharpness,
            this.settings.sharpeningStrength,
          );
          gl.uniform2f(
            this.rcasUniforms.u_texSize,
            currentSourceW,
            currentSourceH,
          );
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.outputTexture;
        }
      }

      // --- Step 4b: Custom sharpen pass (non-FSR path, at display resolution) ---
      if (needsCustomSharpen && this.renderWidth > 0 && this.renderHeight > 0) {
        this.ensureOutputResources(gl);
        if (this.outputFBO && this.outputTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputFBO);
          gl.viewport(0, 0, this.renderWidth, this.renderHeight);
          gl.useProgram(this.sharpenProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, currentSource);
          gl.uniform1i(this.sharpenUniforms.u_sourceTexture, 0);
          gl.uniform1f(
            this.sharpenUniforms.u_sharpeningStrength,
            this.settings.sharpeningStrength,
          );
          gl.uniform1f(
            this.sharpenUniforms.u_noiseProtection,
            this.settings.noiseProtection,
          );
          gl.uniform2f(
            this.sharpenUniforms.u_texSize,
            currentSourceW,
            currentSourceH,
          );
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.outputTexture;
        }
      }

      // --- Step 5: Debanding at display resolution (optional, AFTER sharpen) ---
      if (needsDeband && this.renderWidth > 0 && this.renderHeight > 0) {
        // Reallocate deband resources at display resolution (not source resolution)
        const debandW = this.renderWidth;
        const debandH = this.renderHeight;
        this.ensureDebandResources(gl, debandW, debandH);
        if (this.debandFBO && this.debandTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.debandFBO);
          gl.viewport(0, 0, debandW, debandH);
          gl.useProgram(this.debandProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, currentSource);
          gl.uniform1i(this.debandUniforms.u_sourceTexture, 0);
          gl.uniform1f(
            this.debandUniforms.u_debandStrength,
            this.settings.debanding,
          );
          gl.uniform2f(
            this.debandUniforms.u_texSize,
            debandW,
            debandH,
          );
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.debandTexture;
        }
      }

      // --- Step 6: Final blit to canvas (centered contained) ---
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // Clear entire canvas
      gl.viewport(0, 0, this.outputWidth, this.outputHeight);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Render to centered contained rect only
      gl.viewport(this.renderX, this.renderY, this.renderWidth, this.renderHeight);
      gl.useProgram(this.fullscreenProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, currentSource);

      // Linear filtering for the final blit
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      gl.uniform1i(this.fullscreenUniforms.u_sourceTexture, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Restore texture filtering to LINEAR for next frame's source upload
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      // --- End GPU timer ---
      this.endTimer(gl);

      // Read previous timer result (non-blocking)
      this.readTimerResult();

      const elapsed = performance.now() - startTime;
      this.lastCpuTimeMs = elapsed;

      return {
        success: true,
        gpuTimeMs: this.lastGpuTimeMs ?? elapsed,
      };
    } catch (err) {
      // On any GPU error, attempt fallback native blit
      this.lastGpuTimeMs = null;
      console.warn("[WebGL2Backend] Frame processing error:", err);

      // Attempt native fallback blit
      try {
        if (gl && this.sourceTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, this.outputWidth, this.outputHeight);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.useProgram(this.fullscreenProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.uniform1i(this.fullscreenUniforms.u_sourceTexture, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
      } catch {
        // Fallback also failed — nothing more we can do
      }

      return {
        success: false,
      };
    }
  }

  // ─── Stats ─────────────────────────────────────────────────────────────

  getStats(): BackendStats {
    const hasInput = this.inputWidth > 0 && this.inputHeight > 0;
    const isUpscaling = hasInput &&
      (this.renderWidth > this.inputWidth ||
        this.renderHeight > this.inputHeight);
    const algorithm = this.settings.scalingAlgorithm;
    const needsSharpen = this.settings.sharpeningStrength > 0;
    const needsCleanup = this.settings.compressionCleanup > 0;
    const needsDeband = this.settings.debanding > 0;
    const needsUpscale = isUpscaling;

    const isFsr = algorithm === "fsr1-easu" && needsUpscale;
    const isBicubic = algorithm === "bicubic" && needsUpscale;
    const isLanczos = algorithm === "lanczos" && needsUpscale;
    const fsrFinalScaler: FsrFinalScaler | null = isFsr ? this.settings.fsrFinalScaler : null;

    // Compute current EASU target dimensions for stats
    let easuTargetWidth = 0;
    let easuTargetHeight = 0;
    let finalScalerActive = false;
    let needsEasuForStats = false;

    if (algorithm === "fsr1-easu" && isUpscaling) {
      const target = this.computeCachedEasuTarget(
        this.inputWidth,
        this.inputHeight,
        this.renderWidth,
        this.renderHeight,
        this.settings.fsrTargetScale,
      );
      if (target) {
        easuTargetWidth = target.easuW;
        easuTargetHeight = target.easuH;
        finalScalerActive = target.needsFinalScaler;
        needsEasuForStats = true;
      }
    } else if (isBicubic || isLanczos) {
      // Standalone bicubic/lanczos always scales source → display directly
      finalScalerActive = true;
    }

    const needsRcas = isFsr && needsSharpen;
    const needsCustomSharpen = !isFsr && needsSharpen;

    // Determine the scaler name for the final scaler pass
    let finalScalerName = "Bicubic";
    if (isLanczos) {
      finalScalerName = "Lanczos";
    } else if (isBicubic) {
      finalScalerName = "Bicubic";
    } else if (isFsr && fsrFinalScaler === "lanczos") {
      finalScalerName = "Lanczos";
    } else if (isFsr) {
      finalScalerName = "Bicubic";
    }

    // Build active passes chain
    const passes: string[] = [];
    if (needsCleanup) passes.push("Cleanup");
    if (needsEasuForStats) {
      passes.push(`EASU ${this.inputWidth}×${this.inputHeight}→${easuTargetWidth}×${easuTargetHeight}`);
    }
    if (finalScalerActive) {
      const scalerSourceW = easuTargetWidth > 0 ? easuTargetWidth : this.inputWidth;
      const scalerSourceH = easuTargetHeight > 0 ? easuTargetHeight : this.inputHeight;
      passes.push(`${finalScalerName} ${scalerSourceW}×${scalerSourceH}→${this.renderWidth}×${this.renderHeight}`);
    }
    if (needsRcas) passes.push("RCAS");
    if (needsCustomSharpen) passes.push("Sharpen");
    if (needsDeband) passes.push("Deband");

    return {
      inputWidth: this.inputWidth,
      inputHeight: this.inputHeight,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      enhancedScalingActive:
        isUpscaling && algorithm !== "native",
      lastGpuTimeMs: this.lastGpuTimeMs,
      contextLossCount: this.contextLossCount,
      backend: this.gl ? "webgl2" : "unavailable",
      scalingAlgorithm: algorithm,
      easuTargetWidth,
      easuTargetHeight,
      finalBicubicActive: finalScalerActive,
      fsrFinalScaler,
      rcasActive: needsRcas,
      activePasses: passes,
    };
  }

  // ─── Context loss / restoration ────────────────────────────────────────

  handleContextLost(): void {
    this.contextLossCount++;
    this.gl = null;
    this.releaseResources();
  }

  handleContextRestored(): void {
    // Full re-initialisation required — caller should re-call initialize(canvas)
    this.initialized = false;
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────

  destroy(): void {
    if (this._onContextLost && this.canvas) {
      this.canvas.removeEventListener(
        "webglcontextlost",
        this._onContextLost,
      );
    }
    if (this._onContextRestored && this.canvas) {
      this.canvas.removeEventListener(
        "webglcontextrestored",
        this._onContextRestored,
      );
    }
    this._onContextLost = null;
    this._onContextRestored = null;

    this.releaseResources();
    this.gl = null;
    this.canvas = null;
    this.initialized = false;
  }

  // ─── Private: Resource allocation ──────────────────────────────────────

  private recreateSourceTexture(gl: WebGL2RenderingContext): void {
    deleteTexture(gl, this.sourceTexture);
    this.sourceTexture = null;
  }

  private createSourceTexture(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ): WebGLTexture {
    const tex = createTexture(gl, width, height);
    this.sourceWidth = width;
    this.sourceHeight = height;
    return tex;
  }

  private ensureCleanupResources(gl: WebGL2RenderingContext): void {
    if (this.inputWidth <= 0 || this.inputHeight <= 0) return;
    if (
      this.cleanupTexture &&
      this.cleanupFBO &&
      this.inputWidth === this.lastCleanupWidth &&
      this.inputHeight === this.lastCleanupHeight
    ) {
      return;
    }

    deleteTexture(gl, this.cleanupTexture);
    deleteFramebuffer(gl, this.cleanupFBO);

    this.lastCleanupWidth = this.inputWidth;
    this.lastCleanupHeight = this.inputHeight;
    this.cleanupTexture = createTexture(gl, this.inputWidth, this.inputHeight);
    this.cleanupFBO = createFramebuffer(gl, this.cleanupTexture);
  }

  private ensureScaleResources(gl: WebGL2RenderingContext): void {
    if (this.renderWidth <= 0 || this.renderHeight <= 0) return;
    // Use render dimensions for scale FBO (aspect-ratio contained)
    const scaleW = this.renderWidth;
    const scaleH = this.renderHeight;
    if (
      this.scaleTexture &&
      this.scaleFBO &&
      scaleW === this.lastScaleWidth &&
      scaleH === this.lastScaleHeight
    ) {
      return;
    }

    deleteTexture(gl, this.scaleTexture);
    deleteFramebuffer(gl, this.scaleFBO);

    this.lastScaleWidth = scaleW;
    this.lastScaleHeight = scaleH;
    this.scaleTexture = createTexture(gl, scaleW, scaleH);
    this.scaleFBO = createFramebuffer(gl, this.scaleTexture);
  }

  private ensureOutputResources(gl: WebGL2RenderingContext): void {
    if (this.renderWidth <= 0 || this.renderHeight <= 0) return;
    const outW = this.renderWidth;
    const outH = this.renderHeight;

    if (
      this.outputTexture &&
      this.outputFBO &&
      outW === this.lastOutputWidth &&
      outH === this.lastOutputHeight
    ) {
      return;
    }

    deleteTexture(gl, this.outputTexture);
    deleteFramebuffer(gl, this.outputFBO);

    this.lastOutputWidth = outW;
    this.lastOutputHeight = outH;
    this.outputTexture = createTexture(gl, outW, outH);
    this.outputFBO = createFramebuffer(gl, this.outputTexture);
  }

  private ensureDebandResources(gl: WebGL2RenderingContext, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    if (
      this.debandTexture &&
      this.debandFBO &&
      w === this.lastDebandWidth &&
      h === this.lastDebandHeight
    ) {
      return;
    }

    deleteTexture(gl, this.debandTexture);
    deleteFramebuffer(gl, this.debandFBO);

    this.lastDebandWidth = w;
    this.lastDebandHeight = h;
    this.debandTexture = createTexture(gl, w, h);
    this.debandFBO = createFramebuffer(gl, this.debandTexture);
  }

  /**
   * Allocate or reuse EASU texture/FBO at the given target dimensions
   * (which may be smaller than render dimensions).
   */
  private ensureEasuResources(gl: WebGL2RenderingContext, easuW: number, easuH: number): void {
    if (easuW <= 0 || easuH <= 0) return;
    if (
      this.easuTexture &&
      this.easuFBO &&
      easuW === this.lastEasuTargetWidth &&
      easuH === this.lastEasuTargetHeight
    ) {
      return;
    }

    deleteTexture(gl, this.easuTexture);
    deleteFramebuffer(gl, this.easuFBO);

    this.lastEasuTargetWidth = easuW;
    this.lastEasuTargetHeight = easuH;
    this.easuTexture = createTexture(gl, easuW, easuH);
    this.easuFBO = createFramebuffer(gl, this.easuTexture);
  }

  private allocateOutputFBO(gl: WebGL2RenderingContext): void {
    // Output FBO is now sized to render dimensions
    // We don't allocate here — ensureOutputResources handles it
  }

  private allocateScaleFBO(gl: WebGL2RenderingContext): void {
    // Scale FBO is sized to render dimensions on next processFrame
  }

  /**
   * Compute and cache the EASU target dimensions based on current settings.
   */
  private computeCachedEasuTarget(
    sourceW: number,
    sourceH: number,
    finalW: number,
    finalH: number,
    scale: FsrTargetScale,
  ): EasuTargetResult | null {
    if (
      sourceW === this.lastEasuTargetSourceW &&
      sourceH === this.lastEasuTargetSourceH &&
      finalW === this.lastEasuTargetFinalW &&
      finalH === this.lastEasuTargetFinalH &&
      scale === this.lastEasuTargetScale &&
      this.easuTargetResult
    ) {
      return this.easuTargetResult;
    }

    const result = computeEasuTarget(sourceW, sourceH, finalW, finalH, scale);
    this.easuTargetResult = result;
    this.lastEasuTargetSourceW = sourceW;
    this.lastEasuTargetSourceH = sourceH;
    this.lastEasuTargetFinalW = finalW;
    this.lastEasuTargetFinalH = finalH;
    this.lastEasuTargetScale = scale;

    return result;
  }

  private ensureEasuConstants(
    sourceW: number,
    sourceH: number,
    outW: number,
    outH: number,
  ): void {
    if (
      sourceW === this.lastEasuSourceW &&
      sourceH === this.lastEasuSourceH &&
      outW === this.lastEasuOutputW &&
      outH === this.lastEasuOutputH
    ) {
      return; // Already computed
    }

    const consts = computeEasuConstants(sourceW, sourceH, outW, outH);
    this.easuConstants = new Float32Array(consts);
    this.lastEasuSourceW = sourceW;
    this.lastEasuSourceH = sourceH;
    this.lastEasuOutputW = outW;
    this.lastEasuOutputH = outH;
  }

  // ─── Private: Uniform caching ──────────────────────────────────────────

  private cacheUniforms(gl: WebGL2RenderingContext): void {
    if (this.cleanupProgram) {
      this.cleanupUniforms = {
        u_sourceTexture: gl.getUniformLocation(
          this.cleanupProgram,
          "u_sourceTexture",
        ),
        u_compressionCleanup: gl.getUniformLocation(
          this.cleanupProgram,
          "u_compressionCleanup",
        ),
        u_texSize: gl.getUniformLocation(this.cleanupProgram, "u_texSize"),
      };
    }

    if (this.debandProgram) {
      this.debandUniforms = {
        u_sourceTexture: gl.getUniformLocation(
          this.debandProgram,
          "u_sourceTexture",
        ),
        u_debandStrength: gl.getUniformLocation(
          this.debandProgram,
          "u_debandStrength",
        ),
        u_texSize: gl.getUniformLocation(this.debandProgram, "u_texSize"),
      };
    }

    const cacheScalingUniforms = (
      program: WebGLProgram | null,
    ): Record<string, WebGLUniformLocation | null> => {
      if (!program) return {};
      return {
        u_sourceTexture: gl.getUniformLocation(program, "u_sourceTexture"),
        u_sourceSize: gl.getUniformLocation(program, "u_sourceSize"),
        u_outputSize: gl.getUniformLocation(program, "u_outputSize"),
        u_antiRinging: gl.getUniformLocation(program, "u_antiRinging"),
      };
    };

    this.bicubicUniforms = cacheScalingUniforms(this.bicubicProgram);
    this.lanczosUniforms = cacheScalingUniforms(this.lanczosProgram);

    if (this.easuProgram) {
      this.easuUniforms = {
        u_sourceTexture: gl.getUniformLocation(
          this.easuProgram,
          "u_sourceTexture",
        ),
        u_sourceSize: gl.getUniformLocation(this.easuProgram, "u_sourceSize"),
        u_outputSize: gl.getUniformLocation(this.easuProgram, "u_outputSize"),
        u_antiRinging: gl.getUniformLocation(
          this.easuProgram,
          "u_antiRinging",
        ),
        u_easuCon0: gl.getUniformLocation(this.easuProgram, "u_easuCon0"),
        u_easuCon1: gl.getUniformLocation(this.easuProgram, "u_easuCon1"),
        u_easuCon2: gl.getUniformLocation(this.easuProgram, "u_easuCon2"),
        u_easuCon3: gl.getUniformLocation(this.easuProgram, "u_easuCon3"),
      };
    }

    if (this.sharpenProgram) {
      this.sharpenUniforms = {
        u_sourceTexture: gl.getUniformLocation(
          this.sharpenProgram,
          "u_sourceTexture",
        ),
        u_sharpeningStrength: gl.getUniformLocation(
          this.sharpenProgram,
          "u_sharpeningStrength",
        ),
        u_noiseProtection: gl.getUniformLocation(
          this.sharpenProgram,
          "u_noiseProtection",
        ),
        u_texSize: gl.getUniformLocation(this.sharpenProgram, "u_texSize"),
      };
    }

    if (this.rcasProgram) {
      this.rcasUniforms = {
        u_sourceTexture: gl.getUniformLocation(
          this.rcasProgram,
          "u_sourceTexture",
        ),
        u_sharpness: gl.getUniformLocation(this.rcasProgram, "u_sharpness"),
        u_texSize: gl.getUniformLocation(this.rcasProgram, "u_texSize"),
      };
    }

    if (this.fullscreenProgram) {
      this.fullscreenUniforms = {
        u_sourceTexture: gl.getUniformLocation(
          this.fullscreenProgram,
          "u_sourceTexture",
        ),
      };
    }
  }

  // ─── Private: GPU timing ───────────────────────────────────────────────

  private beginTimer(gl: WebGL2RenderingContext): void {
    if (!this.timerExt || this.timerQueries.length < 2) return;
    try {
      const query = this.timerQueries[this.activeTimerIndex];
      gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, query);
    } catch {
      this.timerExt = null;
      this.timerQueries = [];
    }
  }

  private endTimer(gl: WebGL2RenderingContext): void {
    if (!this.timerExt || this.timerQueries.length < 2) return;
    try {
      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    } catch {
      this.timerExt = null;
      this.timerQueries = [];
    }
  }

  private readTimerResult(): void {
    if (!this.timerExt || this.timerQueries.length < 2) return;
    const gl = this.gl;
    if (!gl) return;

    try {
      const prevIndex = this.activeTimerIndex === 0 ? 1 : 0;
      const prevQuery = this.timerQueries[prevIndex];

      if (this.pendingTimerAvailable) {
        const available = gl.getQueryParameter(
          prevQuery,
          gl.QUERY_RESULT_AVAILABLE,
        );
        if (available) {
          const disjoint =
            gl.getParameter(this.timerExt.GPU_DISJOINT_EXT) ?? false;
          if (!disjoint) {
            const timeNs = gl.getQueryParameter(
              prevQuery,
              gl.QUERY_RESULT,
            ) as number;
            this.lastGpuTimeMs = timeNs / 1_000_000;
          }
          this.pendingTimerAvailable = false;
        }
      }

      this.pendingTimerAvailable = true;
      this.activeTimerIndex = prevIndex;
    } catch {
      this.timerExt = null;
      this.timerQueries = [];
    }
  }

  // ─── Private: Resource teardown ────────────────────────────────────────

  private releaseResources(): void {
    const gl = this.gl;
    if (!gl) {
      this.sourceTexture = null;
      this.cleanupTexture = null;
      this.cleanupFBO = null;
      this.lastCleanupWidth = 0;
      this.lastCleanupHeight = 0;
      this.debandTexture = null;
      this.debandFBO = null;
      this.lastDebandWidth = 0;
      this.lastDebandHeight = 0;
      this.scaleTexture = null;
      this.scaleFBO = null;
      this.lastScaleWidth = 0;
      this.lastScaleHeight = 0;
      this.easuTexture = null;
      this.easuFBO = null;
      this.lastEasuTargetWidth = 0;
      this.lastEasuTargetHeight = 0;
      this.outputTexture = null;
      this.outputFBO = null;
      this.lastOutputWidth = 0;
      this.lastOutputHeight = 0;
      this.fullscreenProgram = null;
      this.cleanupProgram = null;
      this.debandProgram = null;
      this.easuProgram = null;
      this.bicubicProgram = null;
      this.lanczosProgram = null;
      this.sharpenProgram = null;
      this.rcasProgram = null;
      this.vao = null;
      this.timerQueries = [];
      return;
    }

    deleteTexture(gl, this.sourceTexture);
    deleteTexture(gl, this.cleanupTexture);
    deleteFramebuffer(gl, this.cleanupFBO);
    deleteTexture(gl, this.debandTexture);
    deleteFramebuffer(gl, this.debandFBO);
    deleteTexture(gl, this.scaleTexture);
    deleteFramebuffer(gl, this.scaleFBO);
    deleteTexture(gl, this.easuTexture);
    deleteFramebuffer(gl, this.easuFBO);
    deleteTexture(gl, this.outputTexture);
    deleteFramebuffer(gl, this.outputFBO);
    deleteProgram(gl, this.fullscreenProgram);
    deleteProgram(gl, this.cleanupProgram);
    deleteProgram(gl, this.debandProgram);
    deleteProgram(gl, this.easuProgram);
    deleteProgram(gl, this.bicubicProgram);
    deleteProgram(gl, this.lanczosProgram);
    deleteProgram(gl, this.sharpenProgram);
    deleteProgram(gl, this.rcasProgram);

    if (this.vao) {
      gl.deleteVertexArray(this.vao);
    }

    for (const q of this.timerQueries) {
      if (q) gl.deleteQuery(q);
    }

    this.sourceTexture = null;
    this.cleanupTexture = null;
    this.cleanupFBO = null;
    this.lastCleanupWidth = 0;
    this.lastCleanupHeight = 0;
    this.debandTexture = null;
    this.debandFBO = null;
    this.lastDebandWidth = 0;
    this.lastDebandHeight = 0;
    this.scaleTexture = null;
    this.scaleFBO = null;
    this.lastScaleWidth = 0;
    this.lastScaleHeight = 0;
    this.easuTexture = null;
    this.easuFBO = null;
    this.lastEasuTargetWidth = 0;
    this.lastEasuTargetHeight = 0;
    this.outputTexture = null;
    this.outputFBO = null;
    this.lastOutputWidth = 0;
    this.lastOutputHeight = 0;
    this.fullscreenProgram = null;
    this.cleanupProgram = null;
    this.debandProgram = null;
    this.easuProgram = null;
    this.bicubicProgram = null;
    this.lanczosProgram = null;
    this.sharpenProgram = null;
    this.rcasProgram = null;
    this.vao = null;
    this.timerQueries = [];
    this.activeTimerIndex = 0;
    this.pendingTimerAvailable = false;
    this.lastGpuTimeMs = null;
  }
}
