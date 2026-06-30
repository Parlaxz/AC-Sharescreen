/**
 * CompareVariantTrackPipeline — canvas-based track pipeline for Easy Compare.
 *
 * Consumes a shared source video track and produces one output track at a
 * requested resolution/FPS using a hidden <video> + <canvas> + captureStream()
 * chain. The source track is never stopped by this pipeline; the caller owns
 * source lifecycle.
 *
 * Design:
 * - Hidden muted <video> element driven by the source track.
 * - <canvas> draws the video at the target resolution, preserving aspect ratio
 *   (letterboxing when aspect ratios differ).
 * - canvas.captureStream(targetFps) produces a deterministic output track.
 * - A generation counter prevents stale output from an older rebuild from
 *   replacing a newer one.
 */

// MediaStreamTrack is a global browser API — no import needed.

// ─── Types ─────────────────────────────────────────────────────────────────

export type PipelineState = "idle" | "active" | "degraded";

export interface PipelineSettings {
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
}

export interface PipelineReadback {
  state: PipelineState;
  settings: PipelineSettings;
  actualOutputWidth: number;
  actualOutputHeight: number;
  actualOutputFps: number;
  variantId: string;
}

// ─── Pipeline ──────────────────────────────────────────────────────────────

export class CompareVariantTrackPipeline {
  private _state: PipelineState = "idle";
  private _outputTrack: MediaStreamTrack | null = null;
  private _outputStream: MediaStream | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _canvasCtx: CanvasRenderingContext2D | null = null;
  private _video: HTMLVideoElement | null = null;
  private _rafId: number | null = null;
  private _generation = 0;
  private _settings: PipelineSettings;
  private _variantId: string;
  private _sourceTrack: MediaStreamTrack | null = null;
  private _actualOutputWidth = 0;
  private _actualOutputHeight = 0;
  private _actualOutputFps = 0;
  private _destroyed = false;

  constructor(settings: PipelineSettings, variantId: string) {
    this._settings = { ...settings };
    this._variantId = variantId;
  }

  // ── Public accessors ────────────────────────────────────────────────

  get state(): PipelineState {
    return this._state;
  }

  get variantId(): string {
    return this._variantId;
  }

  get settings(): PipelineSettings {
    return { ...this._settings };
  }

  get sourceTrack(): MediaStreamTrack | null {
    return this._sourceTrack;
  }

  // ── Initialize ──────────────────────────────────────────────────────

  /**
   * Initialize the pipeline with a source video track.
   * Creates the hidden <video>/<canvas> DOM elements, starts the rendering
   * loop, and returns the output track from canvas.captureStream().
   *
   * Throws if the pipeline is not in the idle state or has been destroyed.
   * On failure the pipeline transitions to "degraded".
   */
  async initialize(sourceTrack: MediaStreamTrack): Promise<MediaStreamTrack> {
    if (this._destroyed) {
      throw new Error("Pipeline is destroyed");
    }
    if (this._state !== "idle") {
      throw new Error(`Pipeline must be idle to initialize (current: ${this._state})`);
    }

    this._sourceTrack = sourceTrack;

    try {
      // 1. Create hidden <video> fed by the source track
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.style.display = "none";
      document.body.appendChild(video);
      this._video = video;

      // 2. Create <canvas> at the target output resolution
      const canvas = document.createElement("canvas");
      canvas.width = this._settings.targetWidth;
      canvas.height = this._settings.targetHeight;
      canvas.style.display = "none";
      document.body.appendChild(canvas);
      this._canvas = canvas;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Could not get 2D context from canvas");
      }
      this._canvasCtx = ctx;

      // 3. Wire source track to video element
      const sourceStream = typeof MediaStream !== "undefined"
        ? new MediaStream([sourceTrack])
        : null;
      if (sourceStream) {
        video.srcObject = sourceStream;
      }

      // 4. Wait for the video to start playing
      await video.play();

      // 5. Start canvas.captureStream at the target FPS
      this._outputStream = canvas.captureStream(this._settings.targetFps);
      const tracks = this._outputStream.getVideoTracks();
      if (tracks.length === 0) {
        throw new Error("canvas.captureStream produced no video track");
      }
      this._outputTrack = tracks[0];

      // 6. Start the rendering loop (draws video → canvas each frame)
      this._startRenderLoop();

      // 7. Commit active state
      this._state = "active";
      this._actualOutputWidth = this._settings.targetWidth;
      this._actualOutputHeight = this._settings.targetHeight;
      this._actualOutputFps = this._settings.targetFps;

      return this._outputTrack;
    } catch (err) {
      this._cleanupDOM();
      this._state = "degraded";
      throw err;
    }
  }

  // ── Replace source track ────────────────────────────────────────────

  /**
   * Replace the source track of an active pipeline.
   * Uses generation counter to prevent stale rebuild commits.
   *
   * Throws if the pipeline is not active or destroyed.
   */
  async replaceSource(newSourceTrack: MediaStreamTrack): Promise<MediaStreamTrack> {
    if (this._destroyed) {
      throw new Error("Pipeline is destroyed");
    }
    if (this._state !== "active" || !this._video) {
      throw new Error("Pipeline must be active to replace source");
    }

    this._generation++;
    const capturedGen = this._generation;

    // Replace the track on the video element
    const newStream = typeof MediaStream !== "undefined"
      ? new MediaStream([newSourceTrack])
      : null;
    if (newStream) {
      this._video.srcObject = newStream;
    }
    await this._video.play();

    // Wait for at least one frame to be available
    await this._waitForFrame(capturedGen);

    // Stale check: if another replacement already happened, discard this one
    if (capturedGen !== this._generation) {
      throw new Error("Replacement superseded by newer source");
    }

    this._sourceTrack = newSourceTrack;
    return this._outputTrack!;
  }

  // ── Accessors ───────────────────────────────────────────────────────

  /**
   * Get the current output video track.
   * Returns null before initialize() or after destroy().
   */
  getOutputTrack(): MediaStreamTrack | null {
    return this._outputTrack;
  }

  /**
   * Get a snapshot of the pipeline's current state for diagnostics.
   */
  getReadback(): PipelineReadback {
    return {
      state: this._state,
      settings: { ...this._settings },
      actualOutputWidth: this._actualOutputWidth,
      actualOutputHeight: this._actualOutputHeight,
      actualOutputFps: this._actualOutputFps,
      variantId: this._variantId,
    };
  }

  // ── Destroy ─────────────────────────────────────────────────────────

  /**
   * Destroy the pipeline. Stops the rendering loop, removes DOM elements,
   * and stops the output track. Does NOT stop the source track — the caller
   * owns source lifecycle.
   *
   * Idempotent — safe to call multiple times.
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._generation++;

    this._stopRenderLoop();

    // Stop the output stream tracks (NOT the source track)
    if (this._outputStream) {
      this._outputStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* best effort */ }
      });
      this._outputStream = null;
    }
    this._outputTrack = null;

    this._cleanupDOM();
    this._state = "idle";
  }

  // ── Private: render loop ────────────────────────────────────────────

  private _startRenderLoop(): void {
    const render = () => {
      if (this._destroyed || !this._video || !this._canvas || !this._canvasCtx) return;
      this._drawFrame();
      this._rafId = requestAnimationFrame(render);
    };
    this._rafId = requestAnimationFrame(render);
  }

  private _stopRenderLoop(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * Draw the current video frame onto the canvas, preserving aspect ratio.
   * Uses letterboxing (black bars) when the source aspect ratio differs from
   * the canvas aspect ratio.
   */
  private _drawFrame(): void {
    const video = this._video!;
    const canvas = this._canvas!;
    const ctx = this._canvasCtx!;

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (srcW === 0 || srcH === 0) return;

    const dstW = canvas.width;
    const dstH = canvas.height;

    // Calculate aspect-ratio-preserving draw rect
    const srcAspect = srcW / srcH;
    const dstAspect = dstW / dstH;

    let drawW: number;
    let drawH: number;
    let offsetX = 0;
    let offsetY = 0;

    if (srcAspect > dstAspect) {
      // Source is wider relative to canvas — fit to width, letterbox top/bottom
      drawW = dstW;
      drawH = dstW / srcAspect;
      offsetY = (dstH - drawH) / 2;
    } else {
      // Source is taller relative to canvas — fit to height, pillarbox left/right
      drawH = dstH;
      drawW = dstH * srcAspect;
      offsetX = (dstW - drawW) / 2;
    }

    ctx.clearRect(0, 0, dstW, dstH);
    ctx.drawImage(video, offsetX, offsetY, drawW, drawH);
  }

  // ── Private: DOM cleanup ────────────────────────────────────────────

  private _cleanupDOM(): void {
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    if (this._video && this._video.parentNode) {
      this._video.parentNode.removeChild(this._video);
    }
    if (this._video) {
      this._video.srcObject = null;
    }
    this._canvas = null;
    this._canvasCtx = null;
    this._video = null;
  }

  // ── Private: frame wait ─────────────────────────────────────────────

  /**
   * Wait until the video element has valid dimensions (at least one frame
   * decoded) or the generation changes.
   */
  private _waitForFrame(gen: number): Promise<void> {
    // Check synchronously first — avoids needing a RAF tick when the video
    // already has valid dimensions (common in replaceSource scenarios).
    if (this._destroyed || gen !== this._generation) return Promise.resolve();
    if (this._video && this._video.videoWidth > 0 && this._video.videoHeight > 0) {
      return Promise.resolve();
    }
    // Defer to RAF only if the video has no dimensions yet
    return new Promise((resolve) => {
      const check = () => {
        if (this._destroyed || gen !== this._generation) {
          resolve();
          return;
        }
        if (this._video && this._video.videoWidth > 0 && this._video.videoHeight > 0) {
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }
}
