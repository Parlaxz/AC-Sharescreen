// @vitest-environment happy-dom
/**
 * Tests for the backend factory selection logic.
 *
 * The factory uses constructor-injected capabilities (the optional second
 * parameter) so tests can control what backends are considered "available"
 * without relying on the real browser WebGL2 / IPC probes.
 */
import { describe, it, expect, vi } from "vitest";
import { createImageProcessingBackend } from "@/services/viewer-image-processing/viewer-image-backend-factory";
import type { ImageProcessingCapabilities } from "@/services/viewer-image-processing/viewer-image-capabilities";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "@/services/viewer-image-processing/viewer-image-defaults";

// ─── Helpers ────────────────────────────────────────────────────────────────

const baseSettings: ViewerImageEnhancementSettings = {
  ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
  enabled: true,
};

/**
 * Build a predictable capabilities object, overriding specific fields.
 */
function makeCapabilities(
  overrides?: Partial<ImageProcessingCapabilities>,
): ImageProcessingCapabilities {
  return {
    backend: "webgl2",
    webgl2Available: true,
    webgl2MaxTextureSize: 4096,
    webgl2MaxRenderbufferSize: 4096,
    webgl2Extensions: [],
    requestVideoFrameCallbackAvailable: false,
    extDisjointTimerQueryAvailable: false,
    nvidiaVsrAvailable: false,
    nvidiaVsrReason: "NVIDIA VSR not available in test",
    adapterName: undefined,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createImageProcessingBackend", () => {
  it("creates WebGL2 backend when processingBackend is 'webgl2'", () => {
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "webgl2" },
      makeCapabilities(),
    );
    expect(result.backend.kind).toBe("webgl2");
    expect(result.effective).toBe("webgl2");
    expect(result.requested).toBe("webgl2");
  });

  it("creates WebGL2 backend when processingBackend is 'auto'", () => {
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "auto" },
      makeCapabilities({ nvidiaVsrAvailable: false }),
    );
    expect(result.backend.kind).toBe("webgl2");
    expect(result.effective).toBe("webgl2");
    expect(result.requested).toBe("webgl2"); // coerced to webgl2 since auto is same as webgl2
  });

  it("returns WebGL2 even when no backend detected (graceful fallback)", () => {
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "auto" },
      makeCapabilities({
        webgl2Available: false,
        nvidiaVsrAvailable: false,
      }),
    );
    // Factory always returns WebGL2 — the caller handles fallback
    expect(result.backend.kind).toBe("webgl2");
    expect(result.effective).toBe("webgl2");
  });

  it("accepts injected capabilities with WebGL2 backend", () => {
    const customCaps = makeCapabilities({ webgl2MaxTextureSize: 8192 });
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "webgl2" },
      customCaps,
    );
    expect(result.backend.kind).toBe("webgl2");
    expect(result.effective).toBe("webgl2");
    expect(result.requested).toBe("webgl2");
  });

  it("defaults to webgl2 when processingBackend is undefined", () => {
    const settings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      processingBackend: undefined,
    } as unknown as ViewerImageEnhancementSettings;

    const result = createImageProcessingBackend(settings, makeCapabilities());
    expect(result.backend.kind).toBe("webgl2");
    expect(result.effective).toBe("webgl2");
    expect(result.requested).toBe("webgl2");
  });
});
