// SPDX-License-Identifier: MIT
/**
 * Coordinates frame scheduling and backend lifecycle for the GPU image
 * enhancement pipeline. Bridges the raw WebGL2 backend with React lifecycle.
 */

import { WebGL2ViewerImageBackend } from "./webgl2-viewer-image-backend";
import type { ViewerImageEnhancementSettings, ScalingAlgorithm, FsrFinalScaler } from "./viewer-image-settings";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProcessorState =
  | "idle"
  | "running"
  | "paused"
  | "error"
  | "destroyed";

export interface ProcessorCallbacks {
  onStateChange?: (state: ProcessorState) => void;
  onError?: (reason: string) => void;
  onFirstFrame?: () => void;
  onStatsUpdate?: (stats: ProcessorStats) => void;
}

export interface ProcessorStats {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  processingTimeMs: number | null;
  enhancedScalingActive: boolean;
  backend: string;
  framesProcessed: number;
  scalingAlgorithm: ScalingAlgorithm;
  easuTargetWidth: number;
  easuTargetHeight: number;
  finalBicubicActive: boolean;
  fsrFinalScaler: FsrFinalScaler | null;
  rcasActive: boolean;
  activePasses: string[];
}

// ─── Processor ───────────────────────────────────────────────────────────────

export class ViewerImageProcessor {
  private backend: WebGL2ViewerImageBackend;
  private canvas: HTMLCanvasElement;
  private videoElement: HTMLVideoElement;
  private state: ProcessorState = "idle";
  private settings: ViewerImageEnhancementSettings | null = null;
  private callbacks: ProcessorCallbacks = {};
  private firstFrameFired = false;

  // Frame scheduling
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private rafLastTime = -1;
  private lastMediaTime = -1;

  // Stats
  private framesProcessed = 0;
  private lastStatsTime = 0;

  constructor(canvas: HTMLCanvasElement, videoElement: HTMLVideoElement) {
    this.canvas = canvas;
    this.videoElement = videoElement;
    this.backend = new WebGL2ViewerImageBackend();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start processing with the given settings.
   * Initialises the WebGL2 backend and begins the render loop.
   */
  start(settings: ViewerImageEnhancementSettings): void {
    if (this.state === "destroyed") {
      this.emitError("Cannot start a destroyed processor");
      return;
    }

    this.settings = { ...settings };
    this.framesProcessed = 0;
    this.firstFrameFired = false;
    this.lastMediaTime = -1;
    this.rafLastTime = -1;

    const result = this.backend.initialize(this.canvas);
    if (!result.success) {
      this.state = "error";
      this.callbacks.onStateChange?.("error");
      this.callbacks.onError?.(
        result.reason ?? "WebGL2 backend initialization failed",
      );
      return;
    }

    // Apply initial settings to the backend
    this.backend.updateSettings(this.settings);
    // Initial resize to match container size
    this.syncCanvasSize();

    this.state = "running";
    this.callbacks.onStateChange?.("running");
    this.scheduleFrame();
  }

  /**
   * Update enhancement settings live without recreating the backend.
   */
  updateSettings(settings: ViewerImageEnhancementSettings): void {
    this.settings = { ...settings };
    if (this.state === "running" || this.state === "paused") {
      this.backend.updateSettings(this.settings);
    }
  }

  /**
   * Pause frame processing. GPU resources are kept alive.
   */
  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.cancelFrame();
    this.callbacks.onStateChange?.("paused");
  }

  /**
   * Resume frame processing after a pause.
   */
  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.callbacks.onStateChange?.("running");
    this.scheduleFrame();
  }

  /**
   * Notify the backend that the output container has resized.
   * Should be called from a ResizeObserver or layout effect.
   */
  resizeOutput(width: number, height: number): void {
    if (this.state === "destroyed") return;
    const dpr = window.devicePixelRatio || 1;
    try {
      this.backend.resizeOutput(width, height, dpr);
    } catch {
      // Silently ignore resize failures; next frame will re-check
    }
  }

  /**
   * Tear down the processor and release all GPU resources.
   */
  destroy(): void {
    this.cancelFrame();
    try {
      this.backend.destroy();
    } catch {
      // Swallow destroy errors
    }
    this.state = "destroyed";
    this.callbacks.onStateChange?.("destroyed");
    this.callbacks = {};
  }

  // ─── Accessors ─────────────────────────────────────────────────────────

  getState(): ProcessorState {
    return this.state;
  }

  getStats(): ProcessorStats {
    const backendStats = this.state === "running" ? this.backend.getStats() : null;

    return {
      inputWidth: backendStats?.inputWidth ?? 0,
      inputHeight: backendStats?.inputHeight ?? 0,
      outputWidth: backendStats?.outputWidth ?? 0,
      outputHeight: backendStats?.outputHeight ?? 0,
      processingTimeMs: backendStats?.lastGpuTimeMs ?? null,
      enhancedScalingActive: backendStats?.enhancedScalingActive ?? false,
      backend: backendStats?.backend ?? "unavailable",
      framesProcessed: this.framesProcessed,
      scalingAlgorithm: backendStats?.scalingAlgorithm ?? "native",
      easuTargetWidth: backendStats?.easuTargetWidth ?? 0,
      easuTargetHeight: backendStats?.easuTargetHeight ?? 0,
      finalBicubicActive: backendStats?.finalBicubicActive ?? false,
      fsrFinalScaler: backendStats?.fsrFinalScaler ?? null,
      rcasActive: backendStats?.rcasActive ?? false,
      activePasses: backendStats?.activePasses ?? [],
    };
  }

  setCallbacks(callbacks: ProcessorCallbacks): void {
    this.callbacks = callbacks;
  }

  // ─── Frame scheduling ──────────────────────────────────────────────────

  private scheduleFrame(): void {
    if (this.state !== "running") return;

    // Guard: never register more than one pending callback at a time
    if (this.rvfcHandle !== null) return;
    if (this.rafHandle !== null) return;

    if (
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback ===
        "function"
    ) {
      this.rvfcHandle = this.videoElement.requestVideoFrameCallback(
        this.onVideoFrame,
      );
    } else {
      // Fallback: rAF polling at display refresh rate
      this.rafHandle = requestAnimationFrame(this.onRafFrame);
      this.rafLastTime = this.videoElement.currentTime;
    }
  }

  private cancelFrame(): void {
    if (this.rvfcHandle !== null) {
      this.videoElement.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private onVideoFrame = (
    _now: DOMHighResTimeStamp,
    metadata: VideoFrameCallbackMetadata,
  ): void => {
    if (this.state !== "running") return;

    // Clear handle — this callback has consumed the pending registration
    this.rvfcHandle = null;

    // Only process if we got a genuinely new frame
    if (metadata.mediaTime === this.lastMediaTime) {
      this.scheduleFrame();
      return;
    }
    this.lastMediaTime = metadata.mediaTime;

    this.processCurrentFrame();
    this.scheduleFrame();
  };

  private onRafFrame = (): void => {
    if (this.state !== "running") return;

    // Clear handle — this callback has consumed the pending registration
    this.rafHandle = null;

    const currentTime = this.videoElement.currentTime;
    if (currentTime === this.rafLastTime) {
      this.rafHandle = requestAnimationFrame(this.onRafFrame);
      return;
    }
    this.rafLastTime = currentTime;

    this.processCurrentFrame();
    this.rafHandle = requestAnimationFrame(this.onRafFrame);
  };

  // ─── Frame processing ──────────────────────────────────────────────────

  private processCurrentFrame(): void {
    const result = this.backend.processFrame(this.videoElement);

    // Transient frames (video not ready yet) — skip silently, continue loop
    if (result.transient) {
      return;
    }

    this.framesProcessed++;

    if (!result.success) {
      this.callbacks.onError?.("Frame processing failed");
      // Transition to error state so the parent can fall back to native video
      this.state = "error";
      this.cancelFrame();
      this.callbacks.onStateChange?.("error");
      return;
    }

    // Fire first-frame callback once
    if (!this.firstFrameFired) {
      this.firstFrameFired = true;
      this.callbacks.onFirstFrame?.();
    }

    // Throttle stats updates to every 500 ms
    const now = performance.now();
    if (now - this.lastStatsTime > 500) {
      this.lastStatsTime = now;
      this.callbacks.onStatsUpdate?.(this.getStats());
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private syncCanvasSize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const { width, height } = parent.getBoundingClientRect();
    if (width > 0 && height > 0) {
      this.resizeOutput(width, height);
    }
  }

  private emitError(reason: string): void {
    this.callbacks.onError?.(reason);
  }
}
