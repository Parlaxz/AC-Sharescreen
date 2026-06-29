// SPDX-License-Identifier: MIT
/**
 * Coordinates frame scheduling and backend lifecycle for the GPU image
 * enhancement pipeline. Bridges the raw WebGL2 backend with React lifecycle.
 */

import type { ViewerImageBackend, BackendKind } from "./viewer-image-backend";
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
  backend: BackendKind;
  framesProcessed: number;
  scalingAlgorithm: ScalingAlgorithm;
  easuTargetWidth: number;
  easuTargetHeight: number;
  finalBicubicActive: boolean;
  fsrFinalScaler: FsrFinalScaler | null;
  rcasActive: boolean;
  activePasses: string[];
  backpressureDrops: number;
  generation: number;

  // ─── Phase 1: Truthful live statistics ─────────────────────────────────
  /** Count of frames successfully displayed */
  framesDisplayed: number;
  /** Rolling completed frames-per-second over last ~2s interval */
  completedFps: number;
  /** Time to capture + readback pixels from video element (ms) */
  captureReadbackTimeMs: number | null;
  /** Native transport + processing time (ms) */
  nativeTransportProcessingTimeMs: number | null;
  /** Time to upload processed pixels to display texture (ms) */
  displayUploadTimeMs: number | null;
  /** Total latency from capture to displayed frame (ms) */
  totalEnhancedFrameLatencyMs: number | null;
  /** Native output resolution from the enhancer */
  nativeOutputWidth: number;
  nativeOutputHeight: number;
  /** Canonical NVIDIA QualityLevel (integer) when backend is nvidia-vsr */
  nativeQualityLevel: number | null;
  /** Number of frames dropped due to scheduler backpressure */
  schedulerDrops: number;
  /** Number of native processing failures */
  nativeFailures: number;
}

// ─── Processor ───────────────────────────────────────────────────────────────

export class ViewerImageProcessor {
  private backend: ViewerImageBackend;
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

  // Async backpressure
  private frameInFlight = false;
  private pendingFrame = false;

  // Generation tracking
  private generation = 0;
  private frameSequence = 0;

  // Source dimension tracking (for onSourceResize)
  private lastSourceWidth = 0;
  private lastSourceHeight = 0;

  // Stats
  private framesProcessed = 0;
  private lastStatsTime = 0;

  // Phase 1: Truthful statistics
  private framesDisplayed = 0;
  private completedFps = 0;
  private completedTimestamps: number[] = [];
  private captureReadbackTotalMs = 0;
  private captureReadbackCount = 0;
  private nativeTransportProcessingTotalMs = 0;
  private nativeTransportProcessingCount = 0;
  private displayUploadTotalMs = 0;
  private displayUploadCount = 0;
  private totalLatencySumMs = 0;
  private totalLatencyCount = 0;
  private schedulerDropCount = 0;
  private nativeFailureCount = 0;
  private lastNativeOutputWidth = 0;
  private lastNativeOutputHeight = 0;

  constructor(
    canvas: HTMLCanvasElement,
    videoElement: HTMLVideoElement,
    backend: ViewerImageBackend,
  ) {
    this.canvas = canvas;
    this.videoElement = videoElement;
    this.backend = backend;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start processing with the given settings.
   * Initialises the backend and begins the render loop.
   * Returns a promise that resolves when initialisation completes
   * (or rejects on failure, which is also reported through onError).
   */
  async start(settings: ViewerImageEnhancementSettings): Promise<void> {
    try {
      await this.startAsync(settings);
    } catch (err) {
      this.emitError(
        err instanceof Error
          ? err.message
          : "Backend initialization failed",
      );
      throw err;
    }
  }

  private async startAsync(
    settings: ViewerImageEnhancementSettings,
  ): Promise<void> {
    // Idempotent: if already running or paused, do nothing
    if (this.state === "running" || this.state === "paused") {
      return;
    }

    if (this.state === "destroyed") {
      this.emitError("Cannot start a destroyed processor");
      return;
    }

    this.settings = { ...settings };
    this.framesProcessed = 0;
    this.firstFrameFired = false;
    this.lastMediaTime = -1;
    this.rafLastTime = -1;

    // Bump generation and reset frame sequencing
    this.generation++;
    this.frameSequence = 0;
    this.frameInFlight = false;
    this.pendingFrame = false;

    const result = await this.backend.initialize(this.canvas);
    if (!result.success) {
      this.state = "error";
      this.callbacks.onStateChange?.("error");
      this.callbacks.onError?.(
        result.reason ?? "Backend initialization failed",
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
   * Swap the active backend at runtime.
   * Awaits old backend destruction before initialising the new one (audit item 39).
   */
  async setBackend(backend: ViewerImageBackend): Promise<void> {
    const needsRestart =
      this.state === "running" ||
      this.state === "error" ||
      this.state === "paused";
    if (needsRestart) {
      this.cancelFrame();
    }

    // Await old backend destruction before proceeding
    await this.backend.destroy().catch(() => {});
    this.backend = backend;
    // Reset state to idle so that start() can re-initialize
    this.state = "idle";
    this.frameInFlight = false;
    this.pendingFrame = false;
    this.generation++;
    this.frameSequence = 0;

    if (needsRestart && this.settings) {
      await this.startAsync(this.settings);
    }
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
   * Idempotent: safe to call multiple times or before start().
   */
  async destroy(): Promise<void> {
    if (this.state === "destroyed") return;
    this.cancelFrame();
    try {
      await this.backend.destroy();
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
    const backendStats =
      this.state === "running" ? this.backend.getStats() : null;

    const algorithm =
      this.settings?.webglScalingAlgorithm ?? "native";

    return {
      inputWidth: backendStats?.inputWidth ?? 0,
      inputHeight: backendStats?.inputHeight ?? 0,
      outputWidth: backendStats?.outputWidth ?? 0,
      outputHeight: backendStats?.outputHeight ?? 0,
      processingTimeMs: backendStats?.lastGpuTimeMs ?? null,
      enhancedScalingActive: backendStats?.enhancedScalingActive ?? false,
      backend: backendStats?.backend ?? "unavailable",
      framesProcessed: this.framesProcessed,
      scalingAlgorithm: algorithm,
      easuTargetWidth: backendStats?.easuTargetWidth ?? 0,
      easuTargetHeight: backendStats?.easuTargetHeight ?? 0,
      finalBicubicActive: backendStats?.finalBicubicActive ?? false,
      fsrFinalScaler: backendStats?.fsrFinalScaler ?? null,
      rcasActive: backendStats?.rcasActive ?? false,
      activePasses: backendStats?.activePasses ?? [],
      backpressureDrops: backendStats?.backpressureDrops ?? 0,
      generation: this.generation,

      // Phase 1: Truthful live statistics
      framesDisplayed: this.framesDisplayed,
      completedFps: this.completedFps,
      captureReadbackTimeMs: this.captureReadbackCount > 0
        ? this.captureReadbackTotalMs / this.captureReadbackCount
        : null,
      nativeTransportProcessingTimeMs: this.nativeTransportProcessingCount > 0
        ? this.nativeTransportProcessingTotalMs / this.nativeTransportProcessingCount
        : null,
      displayUploadTimeMs: this.displayUploadCount > 0
        ? this.displayUploadTotalMs / this.displayUploadCount
        : null,
      totalEnhancedFrameLatencyMs: this.totalLatencyCount > 0
        ? this.totalLatencySumMs / this.totalLatencyCount
        : null,
      nativeOutputWidth: this.lastNativeOutputWidth || (backendStats?.outputWidth ?? 0),
      nativeOutputHeight: this.lastNativeOutputHeight || (backendStats?.outputHeight ?? 0),
      nativeQualityLevel: backendStats?.nativeQualityLevel ?? null,
      schedulerDrops: this.schedulerDropCount,
      nativeFailures: this.nativeFailureCount,
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

    // Backpressure: if a frame is currently being processed async, mark
    // the newest available frame as pending and drop this invocation.
    if (this.frameInFlight) {
      this.pendingFrame = true;
      return;
    }

    this.beginFrameProcessing();
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

    // Backpressure: if a frame is currently being processed async, mark
    // the newest available frame as pending and drop this invocation.
    if (this.frameInFlight) {
      this.pendingFrame = true;
      this.rafHandle = requestAnimationFrame(this.onRafFrame);
      return;
    }

    this.beginFrameProcessing();
    this.rafHandle = requestAnimationFrame(this.onRafFrame);
  };

  // ─── Async frame processing ────────────────────────────────────────────

  private beginFrameProcessing(): void {
    this.frameInFlight = true;
    this.processCurrentFrameAsync().finally(() => {
      this.frameInFlight = false;
      if (this.pendingFrame) {
        // Another frame arrived while we were busy — process the latest
        this.pendingFrame = false;
        this.beginFrameProcessing();
      } else if (this.state === "running") {
        this.scheduleFrame();
      }
    });
  }

  private async processCurrentFrameAsync(): Promise<void> {
    const seq = ++this.frameSequence;
    const gen = this.generation;

    // Notify backend when source dimensions change (so native config re-evaluates)
    const vw = this.videoElement.videoWidth;
    const vh = this.videoElement.videoHeight;
    if (vw > 0 && vh > 0 && (vw !== this.lastSourceWidth || vh !== this.lastSourceHeight)) {
      this.lastSourceWidth = vw;
      this.lastSourceHeight = vh;
      this.backend.onSourceResize?.(vw, vh);
    }

    const result = await this.backend.processFrame(this.videoElement, {
      generation: gen,
      frameSequence: seq,
    });

    // Ignore results from stale generations (backend swap or restart)
    if (gen !== this.generation) return;

    // Transient frames (video not ready yet) — skip silently
    if (result.transient) return;

    // Backpressure drops from the backend — skip
    if (result.backpressureDrop) return;

    if (!result.success) {
      // Don't count failures in the processed count
      this.framesProcessed--;
      this.nativeFailureCount++;
      this.callbacks.onError?.("Frame processing failed");
      // Transition to error state so the parent can fall back to native video
      this.state = "error";
      this.cancelFrame();
      this.callbacks.onStateChange?.("error");
      return;
    }

    this.framesProcessed++;
    this.framesDisplayed++;

    // Track completed FPS over rolling interval
    const now = performance.now();
    this.completedTimestamps.push(now);
    // Keep only timestamps within last 2s window
    const cutoff = now - 2000;
    while (this.completedTimestamps.length > 0 && this.completedTimestamps[0]! < cutoff) {
      this.completedTimestamps.shift();
    }
    this.completedFps = this.completedTimestamps.length / 2;

    // Track timing breakdowns from backend
    if (result.timingBreakdown) {
      const tb = result.timingBreakdown;
      if (tb.captureReadbackMs != null) {
        this.captureReadbackTotalMs += tb.captureReadbackMs;
        this.captureReadbackCount++;
      }
      if (tb.nativeTransportProcessingMs != null) {
        this.nativeTransportProcessingTotalMs += tb.nativeTransportProcessingMs;
        this.nativeTransportProcessingCount++;
      }
      if (tb.displayUploadMs != null) {
        this.displayUploadTotalMs += tb.displayUploadMs;
        this.displayUploadCount++;
      }
    }

    if (result.totalLatencyMs != null) {
      this.totalLatencySumMs += result.totalLatencyMs;
      this.totalLatencyCount++;
    }

    // Fire first-frame callback once
    if (!this.firstFrameFired) {
      this.firstFrameFired = true;
      this.callbacks.onFirstFrame?.();
    }

    // Throttle stats updates to every 500 ms
    const statsNow = performance.now();
    if (statsNow - this.lastStatsTime > 500) {
      this.lastStatsTime = statsNow;
      this.callbacks.onStatsUpdate?.(this.getStats());
    }
  }

  // ─── Legacy sync wrapper (deprecated, for backward-compat testing) ──────

  /**
   * @deprecated Synchronous fire-and-forget wrapper. Only kept for existing
   *             test patterns that call processCurrentFrame() directly.
   *             New code should use the async pipeline via beginFrameProcessing.
   */
  private processCurrentFrame(): void {
    this.processCurrentFrameAsync().catch(() => {});
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
