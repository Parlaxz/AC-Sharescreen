// SPDX-License-Identifier: MIT
/**
 * NVIDIA RTX Video Super Resolution backend — STUB implementation.
 *
 * Phase 3 placeholder: implements the ViewerImageBackend interface but
 * returns `success: false` from initialize() until the native helper
 * (Phase 5 / Phase 7) is wired in.
 */

import type {
  ViewerImageBackend,
  BackendKind,
  BackendInitResult,
  FrameProcessResult,
  FrameMetadata,
  BackendStats,
} from "./viewer-image-backend";
import type { ViewerImageEnhancementSettings } from "./viewer-image-settings";

export class NvidiaVsrViewerImageBackend implements ViewerImageBackend {
  readonly kind: BackendKind = "nvidia-vsr";

  private settings: ViewerImageEnhancementSettings | null = null;
  private _framesProcessed = 0;
  private _backpressureDrops = 0;

  constructor() {
    // Native helper will be initialised lazily in Phase 5/7
  }

  async initialize(_canvas?: HTMLCanvasElement): Promise<BackendInitResult> {
    return {
      success: false,
      reason: "NVIDIA VSR backend not yet implemented",
    };
  }

  updateSettings(settings: ViewerImageEnhancementSettings): void {
    this.settings = { ...settings };
  }

  async processFrame(
    _video: HTMLVideoElement,
    _metadata?: FrameMetadata,
  ): Promise<FrameProcessResult> {
    return { success: false };
  }

  resizeOutput(_width: number, _height: number, _dpr: number): void {
    // No-op for stub
  }

  getStats(): BackendStats {
    return {
      inputWidth: 0,
      inputHeight: 0,
      outputWidth: 0,
      outputHeight: 0,
      enhancedScalingActive: false,
      lastGpuTimeMs: null,
      backend: "nvidia-vsr",
      framesProcessed: this._framesProcessed,
      activePasses: [],
      backpressureDrops: this._backpressureDrops,
    };
  }

  async destroy(): Promise<void> {
    // Cleanup will be added in Phase 5+
  }
}
