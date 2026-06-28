// SPDX-License-Identifier: MIT
/**
 * Factory for creating the appropriate image processing backend based on
 * settings and runtime capabilities.
 *
 * WebGL2 is the only available backend.
 */

import type { ViewerImageEnhancementSettings } from "./viewer-image-settings";
import type { ViewerImageBackend, BackendKind } from "./viewer-image-backend";
import { WebGL2ViewerImageBackend } from "./webgl2-viewer-image-backend";
import {
  getImageProcessingCapabilities,
  type ImageProcessingCapabilities,
} from "./viewer-image-capabilities";

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
 * @param settings - Current user settings (uses `processingBackend` field)
 * @param capabilities - Optional injected capabilities; auto-detected if omitted
 */
export function createImageProcessingBackend(
  settings: ViewerImageEnhancementSettings,
  capabilities?: ImageProcessingCapabilities,
): BackendSelectionResult {
  const caps = capabilities ?? getImageProcessingCapabilities();
  const requested: BackendSelection =
    (settings.processingBackend as BackendSelection) ?? "webgl2";

  if (caps.webgl2Available) {
    return {
      backend: new WebGL2ViewerImageBackend(),
      requested,
      effective: "webgl2",
    };
  }

  // No available backend
  throw new Error("No image processing backend available");
}
