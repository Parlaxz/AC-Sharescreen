// SPDX-License-Identifier: MIT
/**
 * WebGL2 rendering backend for the ScreenLink GPU image enhancement pipeline.
 *
 * Multi-pass pipeline:
 *   1. Upload pass  — copy video frame to source texture
 *   2. Cleanup pass — compression smoothing / chroma cleanup (optional, source res)
 *   3. Upscale pass — scaling algorithm (optional, render res)
 *   4. Sharpen pass — CAS sharpening (optional, render res)
 *   5. Final copy   — centered contained blit to canvas with letterbox clearing
 *
 * All GPU resources are reused across frames. No per-frame allocations.
 * No per-frame shader compilation or texture/FBO creation.
 */

import type { ViewerImageEnhancementSettings, ScalingAlgorithm } from "./viewer-image-settings";
import {
  createShader,
  createProgram,
  createTexture,
  createFramebuffer,
  deleteProgram,
  deleteTexture,
  deleteFramebuffer,
} from "./webgl2-resources";

// Vite ?raw imports for shader source strings
import fullscreenVert from "./shaders/fullscreen.vert.glsl?raw";
import cleanupFrag from "./shaders/cleanup.frag.glsl?raw";
import easuFrag from "./shaders/easu.frag.glsl?raw";
import sharpenFrag from "./shaders/sharpen.frag.glsl?raw";
import nearestFrag from "./shaders/nearest.frag.glsl?raw";
import bicubicFrag from "./shaders/bicubic.frag.glsl?raw";
import lanczosFrag from "./shaders/lanczos.frag.glsl?raw";

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
  private scaleTexture: WebGLTexture | null = null;
  private scaleFBO: WebGLFramebuffer | null = null;
  private lastScaleWidth = 0;
  private lastScaleHeight = 0;
  private outputTexture: WebGLTexture | null = null;
  private outputFBO: WebGLFramebuffer | null = null;
  private lastOutputWidth = 0;
  private lastOutputHeight = 0;

  // Shader programs
  private fullscreenProgram: WebGLProgram | null = null;
  private cleanupProgram: WebGLProgram | null = null;
  private easuProgram: WebGLProgram | null = null;
  private sharpenProgram: WebGLProgram | null = null;
  private nearestProgram: WebGLProgram | null = null;
  private bicubicProgram: WebGLProgram | null = null;
  private lanczosProgram: WebGLProgram | null = null;

  // Cached uniform locations
  private cleanupUniforms: Record<string, WebGLUniformLocation | null> = {};
  private easuUniforms: Record<string, WebGLUniformLocation | null> = {};
  private sharpenUniforms: Record<string, WebGLUniformLocation | null> = {};
  private nearestUniforms: Record<string, WebGLUniformLocation | null> = {};
  private bicubicUniforms: Record<string, WebGLUniformLocation | null> = {};
  private lanczosUniforms: Record<string, WebGLUniformLocation | null> = {};
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
    sharpeningStrength: 0.14,
    chromaContribution: 0.2,
    artifactClamp: 0.55,
    textureNoiseSharpening: 0.08,
    antiRinging: 0.45,
    chromaCleanup: 0.35,
    compressionSmoothing: 0.25,
  };

  // Cached EASU constants (recomputed when dimensions change)
  private lastEasuSourceW = -1;
  private lastEasuSourceH = -1;
  private lastEasuOutputW = -1;
  private lastEasuOutputH = -1;
  private easuConstants: Float32Array = new Float32Array(16);

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
      this.easuProgram = createProgram(gl, fullscreenVert, easuFrag);
      this.sharpenProgram = createProgram(gl, fullscreenVert, sharpenFrag);
      this.nearestProgram = createProgram(gl, fullscreenVert, nearestFrag);
      this.bicubicProgram = createProgram(gl, fullscreenVert, bicubicFrag);
      this.lanczosProgram = createProgram(gl, fullscreenVert, lanczosFrag);

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
      const needsCleanup =
        this.settings.compressionSmoothing > 0 || this.settings.chromaCleanup > 0;
      // Only upscale if render viewport is larger than source in at least one dimension
      const needsUpscale = algorithm !== "native" && algorithm !== "bilinear" &&
        this.renderWidth > 0 && this.renderHeight > 0 &&
        (this.renderWidth > this.inputWidth || this.renderHeight > this.inputHeight);
      // Native/bilinear: use hardware texture sampling (no separate scaling pass needed)
      const needsNativeDraw = algorithm === "native" || algorithm === "bilinear" || !needsUpscale;
      const needsSharpen = this.settings.sharpeningStrength > 0;
      const needsScalePass = needsUpscale && !needsNativeDraw;

      // --- Start GPU timer if available ---
      this.beginTimer(gl);

      // Source for current stage starts as sourceTexture
      let currentSource: WebGLTexture = this.sourceTexture;
      let currentSourceW = this.inputWidth;
      let currentSourceH = this.inputHeight;

      // --- Step 2: Cleanup pass (if needed, at source resolution) ---
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
            this.cleanupUniforms.u_chromaCleanup,
            this.settings.chromaCleanup,
          );
          gl.uniform1f(
            this.cleanupUniforms.u_compressionSmoothing,
            this.settings.compressionSmoothing,
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

      // --- Step 3: Scaling pass (if needed, to render resolution) ---
      if (needsScalePass) {
        this.ensureScaleResources(gl);
        if (this.scaleFBO && this.scaleTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.scaleFBO);
          gl.viewport(0, 0, this.renderWidth, this.renderHeight);

          // Select program based on algorithm
          let program: WebGLProgram | null;
          let uniforms: Record<string, WebGLUniformLocation | null>;
          switch (algorithm) {
            case "nearest":
              program = this.nearestProgram;
              uniforms = this.nearestUniforms;
              break;
            case "bicubic":
              program = this.bicubicProgram;
              uniforms = this.bicubicUniforms;
              break;
            case "lanczos":
              program = this.lanczosProgram;
              uniforms = this.lanczosUniforms;
              break;
            case "fsr1-easu":
            default:
              program = this.easuProgram;
              uniforms = this.easuUniforms;
              // Update EASU constants if dimensions changed
              this.ensureEasuConstants(
                currentSourceW, currentSourceH,
                this.renderWidth, this.renderHeight,
              );
              break;
          }

          if (program) {
            gl.useProgram(program);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, currentSource);
            gl.uniform1i(uniforms.u_sourceTexture, 0);
            gl.uniform2f(
              uniforms.u_sourceSize,
              currentSourceW,
              currentSourceH,
            );
            gl.uniform2f(
              uniforms.u_outputSize,
              this.renderWidth,
              this.renderHeight,
            );

            // Upload EASU-specific constants
            if (algorithm === "fsr1-easu") {
              gl.uniform4fv(uniforms.u_easuCon0, this.easuConstants.subarray(0, 4));
              gl.uniform4fv(uniforms.u_easuCon1, this.easuConstants.subarray(4, 8));
              gl.uniform4fv(uniforms.u_easuCon2, this.easuConstants.subarray(8, 12));
              gl.uniform4fv(uniforms.u_easuCon3, this.easuConstants.subarray(12, 16));
            }

            // For overshooting scalers, pass anti-ringing
            if (algorithm === "bicubic" || algorithm === "lanczos" || algorithm === "fsr1-easu") {
              gl.uniform1f(
                uniforms.u_antiRinging,
                this.settings.antiRinging,
              );
            }

            gl.drawArrays(gl.TRIANGLES, 0, 3);

            currentSource = this.scaleTexture;
            currentSourceW = this.renderWidth;
            currentSourceH = this.renderHeight;
          }
        }
      }

      // --- Step 3b: If no scaling pass but we need to draw to render resolution (native/bilinear via hardware) ---
      if (needsNativeDraw && this.renderWidth > 0 && this.renderHeight > 0 &&
          (this.renderWidth !== this.inputWidth || this.renderHeight !== this.inputHeight)) {
        // Need to use the output FBO (or just the blit) to render at render resolution
        // We route through the scale FBO for consistency — render source to scale FBO with native filtering
        this.ensureScaleResources(gl);
        if (this.scaleFBO && this.scaleTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.scaleFBO);
          gl.viewport(0, 0, this.renderWidth, this.renderHeight);
          gl.useProgram(this.fullscreenProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, currentSource);
          gl.uniform1i(this.fullscreenUniforms.u_sourceTexture, 0);

          // Set texture filtering based on algorithm
          gl.bindTexture(gl.TEXTURE_2D, currentSource);
          if (algorithm === "nearest") {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          } else {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          }

          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.scaleTexture;
          currentSourceW = this.renderWidth;
          currentSourceH = this.renderHeight;
        }
      }

      // --- Step 4: Sharpen pass (if needed, at render resolution) ---
      if (needsSharpen && this.renderWidth > 0 && this.renderHeight > 0) {
        // Ensure output FBO is sized to render dimensions
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
            this.sharpenUniforms.u_chromaContribution,
            this.settings.chromaContribution,
          );
          gl.uniform1f(
            this.sharpenUniforms.u_artifactClamp,
            this.settings.artifactClamp,
          );
          gl.uniform1f(
            this.sharpenUniforms.u_textureNoiseSharpening,
            this.settings.textureNoiseSharpening,
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

      // --- Step 5: Final blit to canvas (centered contained) ---
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

      // Ensure linear filtering for the final blit texture (which is at render resolution)
      // but may need point for nearest
      if (algorithm === "nearest" && needsNativeDraw) {
        // Already set above
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }

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

    return {
      inputWidth: this.inputWidth,
      inputHeight: this.inputHeight,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      enhancedScalingActive:
        isUpscaling && algorithm !== "native" && algorithm !== "bilinear",
      lastGpuTimeMs: this.lastGpuTimeMs,
      contextLossCount: this.contextLossCount,
      backend: this.gl ? "webgl2" : "unavailable",
      scalingAlgorithm: algorithm,
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

  private allocateOutputFBO(gl: WebGL2RenderingContext): void {
    // Output FBO is now sized to render dimensions
    // We don't allocate here — ensureOutputResources handles it
  }

  private allocateScaleFBO(gl: WebGL2RenderingContext): void {
    // Scale FBO is sized to render dimensions on next processFrame
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
        u_chromaCleanup: gl.getUniformLocation(
          this.cleanupProgram,
          "u_chromaCleanup",
        ),
        u_compressionSmoothing: gl.getUniformLocation(
          this.cleanupProgram,
          "u_compressionSmoothing",
        ),
        u_texSize: gl.getUniformLocation(this.cleanupProgram, "u_texSize"),
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

    this.nearestUniforms = cacheScalingUniforms(this.nearestProgram);
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
        u_chromaContribution: gl.getUniformLocation(
          this.sharpenProgram,
          "u_chromaContribution",
        ),
        u_artifactClamp: gl.getUniformLocation(
          this.sharpenProgram,
          "u_artifactClamp",
        ),
        u_textureNoiseSharpening: gl.getUniformLocation(
          this.sharpenProgram,
          "u_textureNoiseSharpening",
        ),
        u_texSize: gl.getUniformLocation(this.sharpenProgram, "u_texSize"),
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
      this.scaleTexture = null;
      this.scaleFBO = null;
      this.lastScaleWidth = 0;
      this.lastScaleHeight = 0;
      this.outputTexture = null;
      this.outputFBO = null;
      this.lastOutputWidth = 0;
      this.lastOutputHeight = 0;
      this.fullscreenProgram = null;
      this.cleanupProgram = null;
      this.easuProgram = null;
      this.sharpenProgram = null;
      this.nearestProgram = null;
      this.bicubicProgram = null;
      this.lanczosProgram = null;
      this.vao = null;
      this.timerQueries = [];
      return;
    }

    deleteTexture(gl, this.sourceTexture);
    deleteTexture(gl, this.cleanupTexture);
    deleteFramebuffer(gl, this.cleanupFBO);
    deleteTexture(gl, this.scaleTexture);
    deleteFramebuffer(gl, this.scaleFBO);
    deleteTexture(gl, this.outputTexture);
    deleteFramebuffer(gl, this.outputFBO);
    deleteProgram(gl, this.fullscreenProgram);
    deleteProgram(gl, this.cleanupProgram);
    deleteProgram(gl, this.easuProgram);
    deleteProgram(gl, this.sharpenProgram);
    deleteProgram(gl, this.nearestProgram);
    deleteProgram(gl, this.bicubicProgram);
    deleteProgram(gl, this.lanczosProgram);

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
    this.scaleTexture = null;
    this.scaleFBO = null;
    this.lastScaleWidth = 0;
    this.lastScaleHeight = 0;
    this.outputTexture = null;
    this.outputFBO = null;
    this.lastOutputWidth = 0;
    this.lastOutputHeight = 0;
    this.fullscreenProgram = null;
    this.cleanupProgram = null;
    this.easuProgram = null;
    this.sharpenProgram = null;
    this.nearestProgram = null;
    this.bicubicProgram = null;
    this.lanczosProgram = null;
    this.vao = null;
    this.timerQueries = [];
    this.activeTimerIndex = 0;
    this.pendingTimerAvailable = false;
    this.lastGpuTimeMs = null;
  }
}
