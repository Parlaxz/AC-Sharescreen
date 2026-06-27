// SPDX-License-Identifier: MIT
/**
 * WebGL2 rendering backend for the ScreenLink GPU image enhancement pipeline.
 *
 * Implements a multi-pass pipeline:
 *   1. Upload pass  — copy video frame to source texture
 *   2. Cleanup pass — deblocking / chroma cleanup (optional, source res)
 *   3. Upscale pass — EASU or bilinear upscale (optional, output res)
 *   4. Sharpen pass — CAS sharpening (optional, output res)
 *   5. Final copy   — render to canvas default framebuffer
 *
 * All GPU resources are reused across frames. No per-frame allocations.
 */

import type { ViewerImageEnhancementSettings } from "./viewer-image-settings";
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
}

// Maximum dimension to prevent GPU overload (4K ceiling)
const MAX_OUTPUT_DIMENSION = 3840;

// ─── Backend ─────────────────────────────────────────────────────────────────

export class WebGL2ViewerImageBackend {
  // Core GL state
  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private vao: WebGLVertexArrayOES | null = null;
  private contextLossCount = 0;
  private initialized = false;

  // Texture / FBO resources
  private sourceTexture: WebGLTexture | null = null;
  private cleanupTexture: WebGLTexture | null = null;
  private cleanupFBO: WebGLFramebuffer | null = null;
  private lastCleanupWidth = 0;
  private lastCleanupHeight = 0;
  private upscaleTexture: WebGLTexture | null = null;
  private upscaleFBO: WebGLFramebuffer | null = null;
  private outputTexture: WebGLTexture | null = null;
  private outputFBO: WebGLFramebuffer | null = null;

  // Shader programs
  private fullscreenProgram: WebGLProgram | null = null;
  private cleanupProgram: WebGLProgram | null = null;
  private easuProgram: WebGLProgram | null = null;
  private sharpenProgram: WebGLProgram | null = null;

  // Cached uniform locations
  private cleanupUniforms: Record<string, WebGLUniformLocation | null> = {};
  private easuUniforms: Record<string, WebGLUniformLocation | null> = {};
  private sharpenUniforms: Record<string, WebGLUniformLocation | null> = {};
  private fullscreenUniforms: Record<string, WebGLUniformLocation | null> = {};

  // Dimensions
  private inputWidth = 0;
  private inputHeight = 0;
  private outputWidth = 0;
  private outputHeight = 0;

  // Settings
  private settings: ViewerImageEnhancementSettings = {
    enabled: false,
    enhancedScaling: true,
    sharpeningStrength: 0.14,
    chromaContribution: 0.2,
    artifactClamp: 0.55,
    textureNoiseSharpening: 0.08,
    antiRinging: 0.45,
    chromaCleanup: 0.35,
    deblocking: 0.25,
  };

  // GPU timers (EXT_disjoint_timer_query_webgl2)
  private timerExt: EXTDisjointTimerQueryWebGL2 | null = null;
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

    // Reallocate upscale FBO if resolution differs from source
    this.allocateUpscaleFBO(gl);
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
        // Video not ready yet
        return { success: false, gpuTimeMs: 0 };
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
        return { success: false, gpuTimeMs: 0 };
      }

      // --- Step 1: Upload video frame to source texture ---
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
      const needsCleanup =
        this.settings.deblocking > 0 || this.settings.chromaCleanup > 0;
      const needsUpscale =
        this.settings.enhancedScaling &&
        (this.outputWidth > this.inputWidth ||
          this.outputHeight > this.inputHeight);
      const needsSharpen = this.settings.sharpeningStrength > 0;

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
            this.cleanupUniforms.u_deblocking,
            this.settings.deblocking,
          );
          gl.uniform2f(
            this.cleanupUniforms.u_texSize,
            currentSourceW,
            currentSourceH,
          );
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.cleanupTexture;
          // Dimensions stay the same (source res)
        }
      }

      // --- Step 3: Upscale pass (if needed, to output resolution) ---
      if (needsUpscale) {
        this.ensureUpscaleResources(gl);
        if (this.upscaleFBO && this.upscaleTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.upscaleFBO);
          gl.viewport(0, 0, this.outputWidth, this.outputHeight);
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
            this.outputWidth,
            this.outputHeight,
          );
          gl.uniform1f(
            this.easuUniforms.u_enhancedScaling,
            this.settings.enhancedScaling ? 1.0 : 0.0,
          );
          gl.uniform1f(
            this.easuUniforms.u_antiRinging,
            this.settings.antiRinging,
          );
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          currentSource = this.upscaleTexture;
          currentSourceW = this.outputWidth;
          currentSourceH = this.outputHeight;
        }
      }

      // --- Step 4: Sharpen pass (if needed, at output resolution) ---
      if (needsSharpen && this.outputWidth > 0 && this.outputHeight > 0) {
        this.ensureOutputResources(gl);
        if (this.outputFBO && this.outputTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputFBO);
          gl.viewport(0, 0, this.outputWidth, this.outputHeight);
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
          // Dimensions stay the same (output res)
        }
      }

      // --- Step 5: Final copy to canvas ---
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.outputWidth, this.outputHeight);
      gl.useProgram(this.fullscreenProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, currentSource);
      gl.uniform1i(this.fullscreenUniforms.u_sourceTexture, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

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
      // On any GPU error, mark backend as unavailable
      this.lastGpuTimeMs = null;
      console.warn("[WebGL2Backend] Frame processing error:", err);
      return {
        success: false,
      };
    }
  }

  // ─── Stats ─────────────────────────────────────────────────────────────

  getStats(): BackendStats {
    return {
      inputWidth: this.inputWidth,
      inputHeight: this.inputHeight,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      enhancedScalingActive:
        this.settings.enhancedScaling &&
        this.outputWidth > 0 &&
        this.inputWidth > 0 &&
        (this.outputWidth > this.inputWidth ||
          this.outputHeight > this.inputHeight),
      lastGpuTimeMs: this.lastGpuTimeMs,
      contextLossCount: this.contextLossCount,
      backend: this.gl ? "webgl2" : "unavailable",
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
      return; // Already valid
    }

    deleteTexture(gl, this.cleanupTexture);
    deleteFramebuffer(gl, this.cleanupFBO);

    this.lastCleanupWidth = this.inputWidth;
    this.lastCleanupHeight = this.inputHeight;
    this.cleanupTexture = createTexture(gl, this.inputWidth, this.inputHeight);
    this.cleanupFBO = createFramebuffer(gl, this.cleanupTexture);
  }

  private ensureUpscaleResources(gl: WebGL2RenderingContext): void {
    if (this.outputWidth <= 0 || this.outputHeight <= 0) return;
    if (
      this.upscaleTexture &&
      this.upscaleFBO &&
      this.outputWidth > 0 &&
      this.outputHeight > 0
    ) {
      // Check current dimensions match
      const bound =
        gl.getParameter(gl.TEXTURE_BINDING_2D) === this.upscaleTexture;
      if (!bound) {
        // Quick dimension check by binding and querying
        gl.bindTexture(gl.TEXTURE_2D, this.upscaleTexture);
        const w = gl.getTexLevelParameter(gl.TEXTURE_2D, 0, gl.TEXTURE_WIDTH);
        const h = gl.getTexLevelParameter(gl.TEXTURE_2D, 0, gl.TEXTURE_HEIGHT);
        if (w === this.outputWidth && h === this.outputHeight) return;
      } else {
        // Can rely on cached dimensions if we tracked them
        // For simplicity, just recreate if dimensions might have changed
        if (
          this.sourceWidth === this.outputWidth &&
          this.sourceHeight === this.outputHeight
        )
          return;
      }
    }

    deleteTexture(gl, this.upscaleTexture);
    deleteFramebuffer(gl, this.upscaleFBO);

    this.upscaleTexture = createTexture(gl, this.outputWidth, this.outputHeight);
    this.upscaleFBO = createFramebuffer(gl, this.upscaleTexture);
  }

  private ensureOutputResources(gl: WebGL2RenderingContext): void {
    // Guard: can't allocate resources with zero dimensions
    if (this.outputWidth <= 0 || this.outputHeight <= 0) return;

    if (
      this.outputTexture &&
      this.outputFBO
    ) {
      return; // Already allocated
    }

    deleteTexture(gl, this.outputTexture);
    deleteFramebuffer(gl, this.outputFBO);

    this.outputTexture = createTexture(gl, this.outputWidth, this.outputHeight);
    this.outputFBO = createFramebuffer(gl, this.outputTexture);
  }

  private allocateOutputFBO(gl: WebGL2RenderingContext): void {
    if (this.outputWidth <= 0 || this.outputHeight <= 0) return;
    deleteTexture(gl, this.outputTexture);
    deleteFramebuffer(gl, this.outputFBO);
    this.outputTexture = createTexture(gl, this.outputWidth, this.outputHeight);
    this.outputFBO = createFramebuffer(gl, this.outputTexture);
  }

  private allocateUpscaleFBO(gl: WebGL2RenderingContext): void {
    // Only allocate if upscale is needed (dimensions differ from source)
    if (this.outputWidth <= 0 || this.outputHeight <= 0) return;
    if (
      this.outputWidth !== this.inputWidth ||
      this.outputHeight !== this.inputHeight
    ) {
      deleteTexture(gl, this.upscaleTexture);
      deleteFramebuffer(gl, this.upscaleFBO);
      this.upscaleTexture = createTexture(
        gl,
        this.outputWidth,
        this.outputHeight,
      );
      this.upscaleFBO = createFramebuffer(gl, this.upscaleTexture);
    }
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
        u_deblocking: gl.getUniformLocation(
          this.cleanupProgram,
          "u_deblocking",
        ),
        u_texSize: gl.getUniformLocation(this.cleanupProgram, "u_texSize"),
      };
    }

    if (this.easuProgram) {
      this.easuUniforms = {
        u_sourceTexture: gl.getUniformLocation(
          this.easuProgram,
          "u_sourceTexture",
        ),
        u_sourceSize: gl.getUniformLocation(this.easuProgram, "u_sourceSize"),
        u_outputSize: gl.getUniformLocation(this.easuProgram, "u_outputSize"),
        u_enhancedScaling: gl.getUniformLocation(
          this.easuProgram,
          "u_enhancedScaling",
        ),
        u_antiRinging: gl.getUniformLocation(
          this.easuProgram,
          "u_antiRinging",
        ),
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
      this.timerExt.beginQueryEXT(this.timerExt.TIME_ELAPSED_EXT, query);
    } catch {
      this.timerExt = null;
      this.timerQueries = [];
    }
  }

  private endTimer(gl: WebGL2RenderingContext): void {
    if (!this.timerExt || this.timerQueries.length < 2) return;
    try {
      this.timerExt.endQueryEXT(this.timerExt.TIME_ELAPSED_EXT);
    } catch {
      this.timerExt = null;
      this.timerQueries = [];
    }
  }

  private readTimerResult(): void {
    if (!this.timerExt || this.timerQueries.length < 2) return;

    try {
      // Read the *previous* timer query result (non-blocking)
      const prevIndex = this.activeTimerIndex === 0 ? 1 : 0;
      const prevQuery = this.timerQueries[prevIndex];

      if (this.pendingTimerAvailable) {
        const available = this.timerExt.getQueryObjectEXT(
          prevQuery,
          this.timerExt.QUERY_RESULT_AVAILABLE_EXT,
        );
        if (available) {
          // Check for disjoint operation (e.g. GPU frequency change)
          const disjoint =
            this.gl?.getParameter(this.timerExt.GPU_DISJOINT_EXT) ?? false;
          if (!disjoint) {
            const timeNs = this.timerExt.getQueryObjectEXT(
              prevQuery,
              this.timerExt.QUERY_RESULT_EXT,
            ) as number;
            this.lastGpuTimeMs = timeNs / 1_000_000;
          }
          this.pendingTimerAvailable = false;
        }
      }

      // Mark current timer as pending for next frame
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
      // Null out references even without GL context
      this.sourceTexture = null;
      this.cleanupTexture = null;
      this.cleanupFBO = null;
      this.lastCleanupWidth = 0;
      this.lastCleanupHeight = 0;
      this.upscaleTexture = null;
      this.upscaleFBO = null;
      this.outputTexture = null;
      this.outputFBO = null;
      this.fullscreenProgram = null;
      this.cleanupProgram = null;
      this.easuProgram = null;
      this.sharpenProgram = null;
      this.vao = null;
      this.timerQueries = [];
      return;
    }

    deleteTexture(gl, this.sourceTexture);
    deleteTexture(gl, this.cleanupTexture);
    deleteFramebuffer(gl, this.cleanupFBO);
    deleteTexture(gl, this.upscaleTexture);
    deleteFramebuffer(gl, this.upscaleFBO);
    deleteTexture(gl, this.outputTexture);
    deleteFramebuffer(gl, this.outputFBO);
    deleteProgram(gl, this.fullscreenProgram);
    deleteProgram(gl, this.cleanupProgram);
    deleteProgram(gl, this.easuProgram);
    deleteProgram(gl, this.sharpenProgram);

    if (this.vao) {
      gl.deleteVertexArray(this.vao);
    }

    // Clean up timer queries (createQuery/deleteQuery are on WebGL2 context, not extension)
    for (const q of this.timerQueries) {
      if (q) gl.deleteQuery(q);
    }

    this.sourceTexture = null;
    this.cleanupTexture = null;
    this.cleanupFBO = null;
    this.upscaleTexture = null;
    this.upscaleFBO = null;
    this.outputTexture = null;
    this.outputFBO = null;
    this.fullscreenProgram = null;
    this.cleanupProgram = null;
    this.easuProgram = null;
    this.sharpenProgram = null;
    this.vao = null;
    this.timerQueries = [];
    this.activeTimerIndex = 0;
    this.pendingTimerAvailable = false;
    this.lastGpuTimeMs = null;
  }
}
