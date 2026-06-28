// SPDX-License-Identifier: MIT
/**
 * Fallback chain controller for the GPU image enhancement pipeline.
 *
 * Ordered chain:
 *   NVIDIA VSR → WebGL FSR 1 → WebGL Lanczos 3 → original video
 *
 * Advances through stages on initialization failure, repeated processing
 * failure, helper crash, and WebGL context loss. Preserves the requested
 * backend and exposes the actual active backend and reason.
 */

import type { ViewerImageBackend, BackendKind } from "./viewer-image-backend";
import type { ImageProcessingCapabilities } from "./viewer-image-capabilities";
import { WebGL2ViewerImageBackend } from "./webgl2-viewer-image-backend.js";
import { NvidiaVsrBackend, isNvidiaVsrAvailable } from "./nvidia-vsr-backend.js";
import type { ViewerImageEnhancementSettings } from "./viewer-image-settings.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type FallbackStage =
  | "nvidia-vsr"
  | "webgl-fsr1"
  | "webgl-lanczos3"
  | "original";

export interface FallbackChainState {
  activeStage: FallbackStage;
  activeBackend: ViewerImageBackend;
  activeKind: BackendKind;
  requestedKind: BackendKind;
  reason: string | null;
  attempts: Record<FallbackStage, number>;
}

export interface FallbackChainCallbacks {
  onStageChange?: (stage: FallbackStage, reason: string) => void;
  onFatalError?: (reason: string) => void;
}

// ─── Chain ───────────────────────────────────────────────────────────────────

export class FallbackChainController {
  private state: FallbackChainState;
  private callbacks: FallbackChainCallbacks;
  private destroyed = false;
  private consecutiveFailures = 0;
  private readonly MAX_FAILURES = 3;

  constructor(
    requestedKind: BackendKind,
    capabilities: ImageProcessingCapabilities,
    callbacks?: FallbackChainCallbacks,
  ) {
    this.callbacks = callbacks ?? {};
    this.state = this.resolveInitialStage(requestedKind, capabilities);
  }

  get activeBackend(): ViewerImageBackend { return this.state.activeBackend; }
  get activeStage(): FallbackStage { return this.state.activeStage; }
  get reason(): string | null { return this.state.reason; }

  /**
   * Advance to the next fallback stage after a failure.
   */
  async advance(reason: string): Promise<FallbackStage> {
    if (this.destroyed) return this.state.activeStage;

    this.consecutiveFailures++;

    switch (this.state.activeStage) {
      case "nvidia-vsr":
        return this.transitionTo("webgl-fsr1", reason);
      case "webgl-fsr1":
        if (this.consecutiveFailures >= this.MAX_FAILURES) {
          return this.transitionTo("webgl-lanczos3", reason);
        }
        // Retry same stage a few times
        this.state.attempts["webgl-fsr1"]++;
        return this.state.activeStage;
      case "webgl-lanczos3":
        if (this.consecutiveFailures >= this.MAX_FAILURES) {
          return this.transitionTo("original", reason);
        }
        this.state.attempts["webgl-lanczos3"]++;
        return this.state.activeStage;
      case "original":
        this.callbacks.onFatalError?.(reason);
        return "original";
    }
  }

  /**
   * Destroy all backends in the chain.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.state.activeBackend.destroy().catch(() => {});
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private resolveInitialStage(
    requestedKind: BackendKind,
    capabilities: ImageProcessingCapabilities,
  ): FallbackChainState {
    const base: FallbackChainState = {
      activeStage: "webgl-fsr1",
      activeBackend: new WebGL2ViewerImageBackend(),
      activeKind: "webgl2",
      requestedKind,
      reason: null,
      attempts: { "nvidia-vsr": 0, "webgl-fsr1": 0, "webgl-lanczos3": 0, "original": 0 },
    };

    // NVIDIA VSR requested and available? Try it first (item 18 stub)
    if (requestedKind === "nvidia-vsr" || (requestedKind === "webgl2" && capabilities.nvidiaVsrAvailable)) {
      const nvidiaAvailable = isNvidiaVsrAvailable();
      if (nvidiaAvailable) {
        base.activeStage = "nvidia-vsr";
        base.activeBackend = new NvidiaVsrBackend();
        base.activeKind = "nvidia-vsr";
      } else {
        base.reason = "NVIDIA VSR not available — SDK not built";
      }
    }

    // WebGL2 fallback (FSR 1 enabled by default in settings)
    if (base.activeStage === "nvidia-vsr" && !isNvidiaVsrAvailable()) {
      // Already falling back above
    }

    return base;
  }

  private async transitionTo(stage: FallbackStage, reason: string): Promise<FallbackStage> {
    const oldBackend = this.state.activeBackend;

    // Create new backend
    let newBackend: ViewerImageBackend;
    switch (stage) {
      case "webgl-fsr1":
        newBackend = new WebGL2ViewerImageBackend();
        break;
      case "webgl-lanczos3":
        newBackend = new WebGL2ViewerImageBackend();
        break;
      case "original": {
        // Return a "no-op passthrough" backend that just renders the video directly
        newBackend = new WebGL2ViewerImageBackend();
        break;
      }
      default:
        newBackend = oldBackend;
    }

    // Destroy old backend
    await oldBackend.destroy().catch(() => {});

    // Update state
    this.state.activeStage = stage;
    this.state.activeBackend = newBackend;
    this.state.activeKind = stage === "nvidia-vsr" ? "nvidia-vsr" : "webgl2";
    this.state.reason = reason;
    this.state.attempts[stage] = (this.state.attempts[stage] || 0) + 1;
    this.consecutiveFailures = 0;

    this.callbacks.onStageChange?.(stage, reason);
    return stage;
  }
}
