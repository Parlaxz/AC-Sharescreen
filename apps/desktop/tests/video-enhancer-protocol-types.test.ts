// @vitest-environment node
/**
 * Tests for the typed video-enhancer protocol interfaces.
 *
 * Validates:
 *   - VideoEnhancerDiagnosticsResponse shape and defaults
 *   - ConfigureNativeResponse shape and field access
 *   - Settings migration for NVIDIA enhancement fields
 */
import { describe, it, expect } from "vitest";

// ─── Import protocol types (compile-time check) ─────────────────────────────

import type {
  VideoEnhancerDiagnosticsResponse,
  ConfigureNativeResponse,
  VideoEnhancerStats,
  NativeBenchmarkConfig,
  NativeBenchmarkStatusResponse,
  NativeBenchmarkResultResponse,
} from "../src/main/video-enhancer-protocol";

// ─── Runtime validation via factory-style helpers ────────────────────────────

function makeDiagnostics(overrides?: Partial<VideoEnhancerDiagnosticsResponse>): VideoEnhancerDiagnosticsResponse {
  return {
    success: true,
    totalFramesSubmitted: 0,
    totalFramesCompleted: 0,
    totalFramesDropped: 0,
    totalProcessingErrors: 0,
    lastProcessingTimeUs: 0,
    maxProcessingTimeUs: 0,
    minProcessingTimeUs: 0,
    ...overrides,
  };
}

function makeConfigureResponse(overrides?: Partial<ConfigureNativeResponse>): ConfigureNativeResponse {
  return {
    success: true,
    ...overrides,
  };
}

describe("VideoEnhancerDiagnosticsResponse", () => {
  it("accepts a minimal valid object", () => {
    const d = makeDiagnostics();
    expect(d.success).toBe(true);
    expect(d.totalFramesSubmitted).toBe(0);
  });

  it("accepts optional native timing fields", () => {
    const d = makeDiagnostics({
      nativeInputReceiveUs: 100,
      nativeUploadUs: 200,
      nativeEffectUs: 500,
      nativeDownloadUs: 150,
      nativePreWriteTotalUs: 950,
      nativeOutputWriteUs: 50,
      uptimeMs: 12345,
      configurationId: 3,
      effectInstanceId: 1,
    });
    expect(d.nativeInputReceiveUs).toBe(100);
    expect(d.nativeEffectUs).toBe(500);
    expect(d.nativePreWriteTotalUs).toBe(950);
    expect(d.nativeOutputWriteUs).toBe(50);
    expect(d.uptimeMs).toBe(12345);
    expect(d.configurationId).toBe(3);
    expect(d.effectInstanceId).toBe(1);
  });

  it("accepts frames-processed counters", () => {
    const d = makeDiagnostics({
      totalFramesSubmitted: 1500,
      totalFramesCompleted: 1490,
      totalFramesDropped: 8,
      totalProcessingErrors: 2,
    });
    expect(d.totalFramesSubmitted).toBe(1500);
    expect(d.totalFramesCompleted).toBe(1490);
    expect(d.totalFramesDropped).toBe(8);
    expect(d.totalProcessingErrors).toBe(2);
  });

  it("accepts timing fields", () => {
    const d = makeDiagnostics({
      lastProcessingTimeUs: 4500,
      maxProcessingTimeUs: 12000,
      minProcessingTimeUs: 3200,
    });
    expect(d.lastProcessingTimeUs).toBe(4500);
    expect(d.maxProcessingTimeUs).toBe(12000);
    expect(d.minProcessingTimeUs).toBe(3200);
  });

  it("native stat fields are undefined when absent", () => {
    const d = makeDiagnostics();
    expect(d.nativeInputReceiveUs).toBeUndefined();
    expect(d.nativeUploadUs).toBeUndefined();
    expect(d.nativeEffectUs).toBeUndefined();
    expect(d.nativeDownloadUs).toBeUndefined();
    expect(d.nativePreWriteTotalUs).toBeUndefined();
    expect(d.nativeOutputWriteUs).toBeUndefined();
    expect(d.uptimeMs).toBeUndefined();
    expect(d.configurationId).toBeUndefined();
    expect(d.effectInstanceId).toBeUndefined();
  });
});

describe("ConfigureNativeResponse", () => {
  it("accepts minimal success response", () => {
    const r = makeConfigureResponse();
    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("accepts error response", () => {
    const r = makeConfigureResponse({ success: false, error: "Configuration rejected" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("Configuration rejected");
  });

  it("accepts full applied config fields", () => {
    const r = makeConfigureResponse({
      success: true,
      configurationId: 4,
      effectInstanceId: 2,
      appliedQualityLevel: 3,
      appliedMode: "vsr",
      appliedQuality: "high",
      requestedMode: "vsr",
      requestedQuality: "high",
      inputWidth: 1920,
      inputHeight: 1080,
      outputWidth: 3840,
      outputHeight: 2160,
      inputPixelFormat: "bgra8",
      effectLoadSucceeded: true,
      effectLoadCount: 1,
      configuredAt: Date.now(),
    });
    expect(r.configurationId).toBe(4);
    expect(r.effectInstanceId).toBe(2);
    expect(r.appliedQualityLevel).toBe(3);
    expect(r.appliedMode).toBe("vsr");
    expect(r.outputWidth).toBe(3840);
    expect(r.effectLoadSucceeded).toBe(true);
  });
});

describe("NativeBenchmarkConfig", () => {
  it("accepts a valid benchmark config", () => {
    const cfg: NativeBenchmarkConfig = {
      processingMode: "vsr",
      qualityLevel: "high",
      inputWidth: 1920,
      inputHeight: 1080,
      targetFrames: 100,
      frameTimeoutMs: 5000,
    };
    expect(cfg.processingMode).toBe("vsr");
    expect(cfg.qualityLevel).toBe("high");
    expect(cfg.targetFrames).toBe(100);
  });

  it("accepts all processing modes", () => {
    const modes: NativeBenchmarkConfig["processingMode"][] = ["vsr", "high-bitrate", "denoise", "deblur"];
    for (const mode of modes) {
      const cfg: NativeBenchmarkConfig = {
        processingMode: mode,
        qualityLevel: "medium",
        inputWidth: 1920,
        inputHeight: 1080,
        targetFrames: 50,
      };
      expect(cfg.processingMode).toBe(mode);
    }
  });

  it("frameTimeoutMs is optional", () => {
    const cfg: NativeBenchmarkConfig = {
      processingMode: "vsr",
      qualityLevel: "high",
      inputWidth: 1920,
      inputHeight: 1080,
      targetFrames: 100,
    };
    expect(cfg.frameTimeoutMs).toBeUndefined();
  });
});

describe("NativeBenchmarkStatusResponse", () => {
  it("accepts active benchmark state", () => {
    const status: NativeBenchmarkStatusResponse = {
      benchmarkActive: true,
      benchmarkTargetFrames: 100,
      benchmarkFramesCompleted: 42,
      benchmarkTotalTimeUs: 1_250_000,
      benchmarkAvgTimeUs: 29761,
    };
    expect(status.benchmarkActive).toBe(true);
    expect(status.benchmarkFramesCompleted).toBe(42);
    expect(status.benchmarkAvgTimeUs).toBe(29761);
  });

  it("accepts completed benchmark state", () => {
    const status: NativeBenchmarkStatusResponse = {
      benchmarkActive: false,
      benchmarkTargetFrames: 100,
      benchmarkFramesCompleted: 100,
      benchmarkTotalTimeUs: 3_000_000,
      benchmarkAvgTimeUs: 30000,
      benchmarkComplete: true,
    };
    expect(status.benchmarkActive).toBe(false);
    expect(status.benchmarkComplete).toBe(true);
  });

  it("optional fields are undefined when absent", () => {
    const status: NativeBenchmarkStatusResponse = {
      benchmarkActive: false,
      benchmarkTargetFrames: 0,
      benchmarkFramesCompleted: 0,
      benchmarkTotalTimeUs: 0,
    };
    expect(status.benchmarkAvgTimeUs).toBeUndefined();
    expect(status.benchmarkComplete).toBeUndefined();
  });
});

describe("NativeBenchmarkResultResponse", () => {
  it("accepts a full benchmark result", () => {
    const result: NativeBenchmarkResultResponse = {
      success: true,
      framesProcessed: 100,
      framesDropped: 0,
      framesFailed: 0,
      totalTimeUs: 3_000_000,
      avgTimeUs: 30000,
      minTimeUs: 25000,
      maxTimeUs: 45000,
      avgInputReceiveUs: 120,
      avgUploadUs: 500,
      avgEffectUs: 28000,
      avgDownloadUs: 800,
      avgOutputWriteUs: 180,
      avgFps: 33.33,
    };
    expect(result.success).toBe(true);
    expect(result.framesProcessed).toBe(100);
    expect(result.avgTimeUs).toBe(30000);
    expect(result.avgFps).toBeCloseTo(33.33, 1);
    expect(result.avgUploadUs).toBe(500);
    expect(result.avgEffectUs).toBe(28000);
  });

  it("accepts failed benchmark result", () => {
    const result: NativeBenchmarkResultResponse = {
      success: false,
      error: "Benchmark was cancelled",
      framesProcessed: 42,
      framesDropped: 3,
      framesFailed: 5,
      totalTimeUs: 1_200_000,
      avgTimeUs: 28571,
      minTimeUs: 0,
      maxTimeUs: 0,
      avgInputReceiveUs: 0,
      avgUploadUs: 0,
      avgEffectUs: 0,
      avgDownloadUs: 0,
      avgOutputWriteUs: 0,
      avgFps: 0,
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("Benchmark was cancelled");
    expect(result.framesDropped).toBe(3);
  });
});

describe("VideoEnhancerStats (legacy compat)", () => {
  it("accepts all legacy stats fields", () => {
    const stats: VideoEnhancerStats = {
      framesSubmitted: 100,
      framesCompleted: 95,
      framesDropped: 3,
      errors: 2,
      lastProcessingTimeMs: 4.5,
    };
    expect(stats.framesSubmitted).toBe(100);
    expect(stats.errors).toBe(2);
    expect(stats.lastProcessingTimeMs).toBe(4.5);
  });
});
