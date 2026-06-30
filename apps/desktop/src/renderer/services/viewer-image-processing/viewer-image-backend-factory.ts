// SPDX-License-Identifier: MIT
/**
 * Factory for creating the appropriate image processing backend based on
 * settings and runtime capabilities.
 *
 * Supports the fallback chain:
 *   NVIDIA VSR → WebGL2 FSR1 → WebGL2 Lanczos3 → original video
 */

import type { ViewerImageEnhancementSettings } from "./viewer-image-settings";
import type { ViewerImageBackend, BackendKind } from "./viewer-image-backend";
import { WebGL2ViewerImageBackend } from "./webgl2-viewer-image-backend";
import {
  getImageProcessingCapabilities,
  type ImageProcessingCapabilities,
} from "./viewer-image-capabilities";
import {
  getNvidiaCapabilitySnapshot,
  probeNvidiaCapability,
} from "../nvidia-capability-store.js";
import { FallbackChainController, type FallbackChainOptions, type FallbackStage } from "./fallback-chain-controller.js";

export type BackendSelection = "auto" | "webgl2" | "nvidia-vsr";

export interface BackendSelectionResult {
  backend: ViewerImageBackend;
  requested: BackendSelection;
  effective: BackendKind;
  fallbackReason?: string;
  /** The fallback chain controller for runtime stage advancement (audit item 19) */
  chainController?: FallbackChainController;
}

/**
 * Create the appropriate image processing backend based on settings and
 * capabilities. Returns a fallback chain controller that can advance
 * through NVIDIA → WebGL2 FSR1 → WebGL2 Lanczos3 → original on failure.
 */
export function createImageProcessingBackend(
  settings: ViewerImageEnhancementSettings,
  capabilities?: ImageProcessingCapabilities,
  options?: FallbackChainOptions,
): BackendSelectionResult {
  const caps = capabilities ?? getImageProcessingCapabilities();

  // Check NVIDIA capability store
  const nvidiaCaps = getNvidiaCapabilitySnapshot();
  if (!nvidiaCaps.probed) {
    void probeNvidiaCapability();
  }

  const requested: BackendSelection =
    (settings.processingBackend as BackendSelection) ?? "webgl2";
  // Coerce "auto" → "webgl2" for display
  const displayRequested: BackendSelection = requested === "auto" ? "webgl2" : requested;

  // If NVIDIA requested and capability store says available, create chain
  if (requested === "nvidia-vsr" || (requested === "auto" && nvidiaCaps.probed && nvidiaCaps.available)) {
    const chain = new FallbackChainController("nvidia-vsr", caps, undefined, options);
    const fbReason = chain.reason ?? undefined;

    return {
      backend: chain.activeBackend,
      requested: displayRequested,
      effective: chain.activeStage === "nvidia-vsr" ? "nvidia-vsr" : "webgl2",
      fallbackReason: fbReason,
      chainController: chain,
    };
  }

  // Default: WebGL2
  return {
    backend: new WebGL2ViewerImageBackend(),
    requested: displayRequested,
    effective: "webgl2",
    fallbackReason: (requested as string) === "nvidia-vsr"
      ? (nvidiaCaps.probed ? nvidiaCaps.reason || "nvidia-unavailable" : "nvidia-vsr-not-probed")
      : undefined,
  };
}

/** Check if the NVIDIA VSR backend can be instantiated (SDK availability gate) */
export function isNvidiaBackendSelectable(): boolean {
  const caps = getNvidiaCapabilitySnapshot();
  return caps.probed && caps.available;
}
