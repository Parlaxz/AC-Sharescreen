// @vitest-environment happy-dom
/**
 * Tests for the NVIDIA VSR viewer image backend (stub).
 *
 * Currently the backend is a Phase 3 placeholder – all methods either
 * no-op or return `success: false`.  These tests verify the stub contract
 * so that when the real implementation lands the tests become canaries
 * for regressions.
 */
import { describe, expect, it } from "vitest";
import { NvidiaVsrViewerImageBackend } from "@/services/viewer-image-processing/nvidia-vsr-viewer-image-backend";
import type { ViewerImageEnhancementSettings } from "@/services/viewer-image-processing/viewer-image-settings";

// ─── Helpers ────────────────────────────────────────────────────────────────

const defaultSettings: ViewerImageEnhancementSettings = {
  enabled: true,
  processingBackend: "nvidia-vsr",
  webglScalingAlgorithm: "native",
  fsrTargetScale: "auto",
  fsrFinalScaler: "bicubic",
  nvidiaMode: "vsr",
  nvidiaQuality: "high",
  nvidiaOutput: "display",
  customOutputWidth: null,
  customOutputHeight: null,
  maintainAspectRatio: true,
  sharpeningStrength: 0,
  noiseProtection: 0,
  compressionCleanup: 0,
  debanding: 0,
  _schemaVersion: 4,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("NvidiaVsrViewerImageBackend", () => {
  it("kind is 'nvidia-vsr'", () => {
    const backend = new NvidiaVsrViewerImageBackend();
    expect(backend.kind).toBe("nvidia-vsr");
  });

  it("initialize returns success: false", async () => {
    const backend = new NvidiaVsrViewerImageBackend();
    const result = await backend.initialize();
    expect(result.success).toBe(false);
    expect(result.reason).toBe("NVIDIA VSR backend not yet implemented");
  });

  it("processFrame returns success: false", async () => {
    const backend = new NvidiaVsrViewerImageBackend();
    const video = document.createElement("video");
    const result = await backend.processFrame(video);
    expect(result.success).toBe(false);
  });

  it("getStats includes backend: 'nvidia-vsr'", () => {
    const backend = new NvidiaVsrViewerImageBackend();
    const stats = backend.getStats();
    expect(stats.backend).toBe("nvidia-vsr");
  });

  it("getStats has zero input/output dimensions", () => {
    const backend = new NvidiaVsrViewerImageBackend();
    const stats = backend.getStats();
    expect(stats.inputWidth).toBe(0);
    expect(stats.inputHeight).toBe(0);
    expect(stats.outputWidth).toBe(0);
    expect(stats.outputHeight).toBe(0);
  });

  it("updateSettings does not throw", () => {
    const backend = new NvidiaVsrViewerImageBackend();
    expect(() => backend.updateSettings(defaultSettings)).not.toThrow();
  });

  it("resizeOutput does not throw", () => {
    const backend = new NvidiaVsrViewerImageBackend();
    expect(() => backend.resizeOutput(1920, 1080, 1)).not.toThrow();
  });

  it("destroy does not throw", async () => {
    const backend = new NvidiaVsrViewerImageBackend();
    await expect(backend.destroy()).resolves.toBeUndefined();
  });

  it("framesProcessed starts at 0", () => {
    const backend = new NvidiaVsrViewerImageBackend();
    expect(backend.getStats().framesProcessed).toBe(0);
  });
});
