// SPDX-License-Identifier: MIT
/**
 * NVIDIA VSR backend stub for the GPU image enhancement pipeline.
 *
 * This backend communicates with the native video-enhancer process via
 * Electron IPC + VideoHelperManager. It extracts decoded video pixels,
 * sends them to the native enhancer, and receives processed pixels.
 *
 * When the NVIDIA SDK is not built (SCREENLINK_NVIDIA_VFX_ENABLED=OFF),
 * the native process returns a passthrough (input == output), so this
 * backend still works as a transport layer. The fallback chain controller
 * detects this and advances to WebGL2-based enhancement.
 */

import type { ViewerImageBackend, BackendKind, BackendInitResult, FrameProcessResult, BackendStats, FrameMetadata } from "./viewer-image-backend";
import type { ViewerImageEnhancementSettings, ScalingAlgorithm } from "./viewer-image-settings";

// ─── Capability check ────────────────────────────────────────────────────────

let cachedAvailable: boolean | null = null;

export function isNvidiaVsrAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  // Check if the preload API exposes the enhancer
  const api = (window as unknown as { screenlink?: { enhanceFrame?: unknown } }).screenlink;
  cachedAvailable = typeof (api?.enhanceFrame) === "function";
  return cachedAvailable;
}

export function resetNvidiaVsrCache(): void {
  cachedAvailable = null;
}

// ─── Backend ─────────────────────────────────────────────────────────────────

const EMPTY_STATS: BackendStats = {
  inputWidth: 0, inputHeight: 0, outputWidth: 0, outputHeight: 0,
  enhancedScalingActive: false, lastGpuTimeMs: null,
  backend: "unavailable", framesProcessed: 0, activePasses: [],
  backpressureDrops: 0,
};

export class NvidiaVsrBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "nvidia-vsr";
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private lastStats: BackendStats = { ...EMPTY_STATS };
  private initialized = false;
  private destroyed = false;
  private frameInFlight = false;
  private generation = 0;

  async initialize(canvas?: HTMLCanvasElement): Promise<BackendInitResult> {
    if (this.destroyed) return { success: false, reason: "Backend destroyed" };

    if (!isNvidiaVsrAvailable()) {
      return { success: false, reason: "NVIDIA VSR transport not available" };
    }

    this.canvas = canvas ?? null;
    if (this.canvas) {
      this.ctx = this.canvas.getContext("2d", {
        willReadFrequently: true,
        alpha: false,
      });
    }

    this.initialized = true;
    this.generation++;
    return { success: true };
  }

  updateSettings(settings: ViewerImageEnhancementSettings): void {
    // Settings are forwarded to native on each frame submission
    void settings;
  }

  async processFrame(
    video: HTMLVideoElement,
    metadata?: FrameMetadata,
  ): Promise<FrameProcessResult> {
    if (this.destroyed || !this.initialized) {
      return { success: false };
    }

    if (!this.canvas || !this.ctx) {
      return { success: false };
    }

    const api = (window as unknown as { screenlink?: { enhanceFrame?: (p: unknown) => Promise<unknown> } }).screenlink;
    if (!api?.enhanceFrame) {
      return { success: false };
    }

    // Check readiness
    if (video.readyState < 2) {
      return { transient: true, success: false };
    }

    // Skip duplicate frames if one is in flight
    if (this.frameInFlight) {
      this.lastStats.backpressureDrops++;
      return { backpressureDrop: true, success: false };
    }

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) {
      return { transient: true, success: false };
    }

    // Extract pixels from video via canvas
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(video, 0, 0, w, h);
    const imageData = this.ctx.getImageData(0, 0, w, h);

    this.frameInFlight = true;
    try {
      const result = await api.enhanceFrame({
        generation: metadata?.generation ?? this.generation,
        frameSequence: metadata?.frameSequence ?? 0,
        pixels: Array.from(imageData.data),
        width: w,
        height: h,
      }) as {
        generation: number;
        frameSequence: number;
        pixels: number[];
        width: number;
        height: number;
        processingTimeUs?: number;
      } | null;

      if (!result || result.pixels.length === 0) {
        this.frameInFlight = false;
        return { success: false };
      }

      // Upload processed pixels back to canvas
      const outW = result.width;
      const outH = result.height;
      this.canvas.width = outW;
      this.canvas.height = outH;
      // Clear and draw the processed pixels
      const outImageData = new ImageData(
        new Uint8ClampedArray(result.pixels),
        outW,
        outH,
      );
      // Need to create a temp canvas to convert ImageData → bitmap
      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = outW;
      tmpCanvas.height = outH;
      const tmpCtx = tmpCanvas.getContext("2d");
      if (tmpCtx) {
        tmpCtx.putImageData(outImageData, 0, 0);
        this.ctx.clearRect(0, 0, outW, outH);
        this.ctx.drawImage(tmpCanvas, 0, 0);
      }

      this.lastStats.framesProcessed++;
      this.lastStats.inputWidth = w;
      this.lastStats.inputHeight = h;
      this.lastStats.outputWidth = outW;
      this.lastStats.outputHeight = outH;
      this.lastStats.lastGpuTimeMs = (result.processingTimeUs ?? 0) / 1000;
      this.frameInFlight = false;
      return { success: true, gpuTimeMs: this.lastStats.lastGpuTimeMs ?? undefined };
    } catch {
      this.frameInFlight = false;
      return { success: false };
    }
  }

  resizeOutput(width: number, height: number, dpr: number): void {
    if (this.canvas) {
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
  }

  onSourceResize?(sourceWidth: number, sourceHeight: number): void {
    this.lastStats.inputWidth = sourceWidth;
    this.lastStats.inputHeight = sourceHeight;
  }

  getStats(): BackendStats {
    return {
      ...this.lastStats,
      backend: this.kind,
      enhancedScalingActive: this.initialized,
      activePasses: this.initialized ? ["nvidia-vsr-transport"] : [],
      scalingAlgorithm: undefined as unknown as ScalingAlgorithm,
      generation: this.generation,
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.initialized = false;
    this.canvas = null;
    this.ctx = null;
  }
}
