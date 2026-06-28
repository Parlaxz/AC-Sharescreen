// SPDX-License-Identifier: MIT
/**
 * Factory for creating the appropriate image processing backend based on
 * settings and runtime capabilities.
 *
 * Currently only WebGL2 is available. NVIDIA VSR backend requires SDK build.
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

export type BackendSelection = "auto" | "webgl2";

export interface BackendSelectionResult {
  backend: ViewerImageBackend;
  requested: BackendSelection;
  effective: BackendKind;
  fallbackReason?: string;
}

/**
 * Create the appropriate image processing backend based on settings and
 * capabilities.
 *
 * Falls back to WebGL2 when NVIDIA VSR is unavailable (sdk-not-built).
 */
export function createImageProcessingBackend(
  settings: ViewerImageEnhancementSettings,
  capabilities?: ImageProcessingCapabilities,
): BackendSelectionResult {
  const caps = capabilities ?? getImageProcessingCapabilities();

  // Check NVIDIA capability store — force WebGL2 if unable
  const nvidiaCaps = getNvidiaCapabilitySnapshot();
  if (!nvidiaCaps.probed) {
    // Trigger async probe — next factory call will see result
    void probeNvidiaCapability();
  }

  return {
    backend: new WebGL2ViewerImageBackend(),
    requested: "webgl2",
    effective: "webgl2",
    fallbackReason: nvidiaCaps.probed ? nvidiaCaps.reason || "nvidia-unavailable" : undefined,
  };
}
