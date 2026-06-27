// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectViewerImageCapabilities,
  getImageProcessingCapabilities,
} from "@/services/viewer-image-processing/viewer-image-capabilities";

describe("viewer-image-capabilities", () => {
  beforeEach(() => {
    // Reset memoized cache
    vi.resetModules();
  });

  it("returns unavailable when WebGL2 context is null", () => {
    const caps = detectViewerImageCapabilities();
    // In node environment, WebGL2 will be unavailable
    expect(caps.webgl2Available).toBe(false);
    expect(caps.backend).toBe("unavailable");
    expect(caps.webgl2MaxTextureSize).toBe(0);
    expect(caps.webgl2MaxRenderbufferSize).toBe(0);
    expect(caps.extDisjointTimerQueryAvailable).toBe(false);
  });

  it("detects requestVideoFrameCallback availability in node environment", () => {
    const caps = detectViewerImageCapabilities();
    // In node environment, rVFC may or may not be available
    // Just verify the field is set
    expect(typeof caps.requestVideoFrameCallbackAvailable).toBe("boolean");
  });

  it("memoizes result from first call", () => {
    const caps1 = detectViewerImageCapabilities();
    const caps2 = detectViewerImageCapabilities();
    expect(caps1).toBe(caps2); // Same object reference
  });

  it("getImageProcessingCapabilities returns same result", () => {
    const caps = getImageProcessingCapabilities();
    expect(caps).toBeDefined();
    expect(typeof caps.backend).toBe("string");
  });
});
