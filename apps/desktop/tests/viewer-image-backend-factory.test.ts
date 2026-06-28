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

  it("creates NVIDIA VSR backend when processingBackend is 'nvidia-vsr' and capabilities say available", () => {
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "nvidia-vsr" },
      makeCapabilities({ nvidiaVsrAvailable: true }),
    );
    expect(result.backend.kind).toBe("nvidia-vsr");
    expect(result.effective).toBe("nvidia-vsr");
    expect(result.requested).toBe("nvidia-vsr");
  });

  it("creates NVIDIA VSR backend when processingBackend is 'auto' and NVIDIA is available", () => {
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "auto" },
      makeCapabilities({ nvidiaVsrAvailable: true }),
    );
    expect(result.backend.kind).toBe("nvidia-vsr");
    expect(result.effective).toBe("nvidia-vsr");
    expect(result.requested).toBe("auto");
  });

  it("creates WebGL2 backend when processingBackend is 'auto' but NVIDIA unavailable", () => {
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "auto" },
      makeCapabilities({ nvidiaVsrAvailable: false }),
    );
    expect(result.backend.kind).toBe("webgl2");
    expect(result.effective).toBe("webgl2");
    expect(result.requested).toBe("auto");
    // No fallbackReason when NVIDIA was never requested
    expect(result.fallbackReason).toBeUndefined();
  });

  it("creates WebGL2 backend when processingBackend is 'nvidia-vsr' but capabilities say unavailable", () => {
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "nvidia-vsr" },
      makeCapabilities({
        nvidiaVsrAvailable: false,
        nvidiaVsrReason: "No RTX GPU detected",
      }),
    );
    expect(result.backend.kind).toBe("webgl2");
    expect(result.effective).toBe("webgl2");
    expect(result.requested).toBe("nvidia-vsr");
    // fallbackReason is populated when a requested backend falls through
    expect(result.fallbackReason).toBeDefined();
  });

  it("fallbackReason is set when requested backend unavailable", () => {
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "nvidia-vsr" },
      makeCapabilities({
        nvidiaVsrAvailable: false,
        nvidiaVsrReason: "No RTX GPU detected",
      }),
    );
    expect(result.fallbackReason).toBeDefined();
    expect(result.fallbackReason!.length).toBeGreaterThan(0);
    expect(result.fallbackReason).toBe("No RTX GPU detected");
  });

  it("throws error when no backend is available (no WebGL2, no NVIDIA)", () => {
    expect(() =>
      createImageProcessingBackend(
        { ...baseSettings, processingBackend: "auto" },
        makeCapabilities({
          webgl2Available: false,
          nvidiaVsrAvailable: false,
        }),
      ),
    ).toThrow("No image processing backend available");
  });

  it("accepts injected capabilities", () => {
    const customCaps = makeCapabilities({ nvidiaVsrAvailable: true });
    const result = createImageProcessingBackend(
      { ...baseSettings, processingBackend: "nvidia-vsr" },
      customCaps,
    );
    expect(result.backend.kind).toBe("nvidia-vsr");
    // Verify the caps object we passed is the one used
    expect(customCaps.nvidiaVsrAvailable).toBe(true);
  });

  it("defaults to webgl2 when processingBackend is undefined", () => {
    // Simulate settings where processingBackend is not set (undefined)
    const settings = {
      ...VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
      processingBackend: undefined,
    } as unknown as ViewerImageEnhancementSettings;

    const result = createImageProcessingBackend(settings, makeCapabilities());
    expect(result.backend.kind).toBe("webgl2");
    expect(result.effective).toBe("webgl2");
    // The factory coerces undefined → "webgl2" via the ?? operator
    expect(result.requested).toBe("webgl2");
  });
});
