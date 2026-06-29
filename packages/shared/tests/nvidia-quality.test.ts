import { describe, it, expect } from "vitest";
import {
  canonicalQualityLevel,
  decomposeQualityLevel,
  isValidQualityLevel,
  nvidiaOutputDimensions,
  NVIDIA_PROCESSING_MODES,
  NVIDIA_QUALITIES,
} from "../src/nvidia-quality.js";

describe("canonicalQualityLevel", () => {
  // VSR: 1..4
  it("VSR low → 1", () => expect(canonicalQualityLevel("vsr", "low")).toBe(1));
  it("VSR medium → 2", () => expect(canonicalQualityLevel("vsr", "medium")).toBe(2));
  it("VSR high → 3", () => expect(canonicalQualityLevel("vsr", "high")).toBe(3));
  it("VSR ultra → 4", () => expect(canonicalQualityLevel("vsr", "ultra")).toBe(4));

  // Denoise: 8..11
  it("Denoise low → 8", () => expect(canonicalQualityLevel("denoise", "low")).toBe(8));
  it("Denoise medium → 9", () => expect(canonicalQualityLevel("denoise", "medium")).toBe(9));
  it("Denoise high → 10", () => expect(canonicalQualityLevel("denoise", "high")).toBe(10));
  it("Denoise ultra → 11", () => expect(canonicalQualityLevel("denoise", "ultra")).toBe(11));

  // Deblur: 12..15
  it("Deblur low → 12", () => expect(canonicalQualityLevel("deblur", "low")).toBe(12));
  it("Deblur medium → 13", () => expect(canonicalQualityLevel("deblur", "medium")).toBe(13));
  it("Deblur high → 14", () => expect(canonicalQualityLevel("deblur", "high")).toBe(14));
  it("Deblur ultra → 15", () => expect(canonicalQualityLevel("deblur", "ultra")).toBe(15));

  // High-Bitrate: 16..19
  it("High-Bitrate low → 16", () => expect(canonicalQualityLevel("high-bitrate", "low")).toBe(16));
  it("High-Bitrate medium → 17", () => expect(canonicalQualityLevel("high-bitrate", "medium")).toBe(17));
  it("High-Bitrate high → 18", () => expect(canonicalQualityLevel("high-bitrate", "high")).toBe(18));
  it("High-Bitrate ultra → 19", () => expect(canonicalQualityLevel("high-bitrate", "ultra")).toBe(19));

  it("invalid mode returns -1", () => {
    expect(canonicalQualityLevel("invalid", "high")).toBe(-1);
  });

  it("invalid quality returns -1", () => {
    expect(canonicalQualityLevel("vsr", "invalid")).toBe(-1);
  });

  it("both invalid returns -1", () => {
    expect(canonicalQualityLevel("invalid", "invalid")).toBe(-1);
  });
});

describe("decomposeQualityLevel", () => {
  it("decomposes VSR levels", () => {
    expect(decomposeQualityLevel(1)).toEqual({ mode: "vsr", quality: "low" });
    expect(decomposeQualityLevel(2)).toEqual({ mode: "vsr", quality: "medium" });
    expect(decomposeQualityLevel(3)).toEqual({ mode: "vsr", quality: "high" });
    expect(decomposeQualityLevel(4)).toEqual({ mode: "vsr", quality: "ultra" });
  });

  it("decomposes Denoise levels", () => {
    expect(decomposeQualityLevel(8)).toEqual({ mode: "denoise", quality: "low" });
    expect(decomposeQualityLevel(9)).toEqual({ mode: "denoise", quality: "medium" });
    expect(decomposeQualityLevel(10)).toEqual({ mode: "denoise", quality: "high" });
    expect(decomposeQualityLevel(11)).toEqual({ mode: "denoise", quality: "ultra" });
  });

  it("decomposes Deblur levels", () => {
    expect(decomposeQualityLevel(12)).toEqual({ mode: "deblur", quality: "low" });
    expect(decomposeQualityLevel(15)).toEqual({ mode: "deblur", quality: "ultra" });
  });

  it("decomposes High-Bitrate levels", () => {
    expect(decomposeQualityLevel(16)).toEqual({ mode: "high-bitrate", quality: "low" });
    expect(decomposeQualityLevel(19)).toEqual({ mode: "high-bitrate", quality: "ultra" });
  });

  it("returns null for invalid levels", () => {
    expect(decomposeQualityLevel(0)).toBeNull();
    expect(decomposeQualityLevel(5)).toBeNull();
    expect(decomposeQualityLevel(7)).toBeNull();
    expect(decomposeQualityLevel(20)).toBeNull();
    expect(decomposeQualityLevel(-1)).toBeNull();
  });
});

describe("isValidQualityLevel", () => {
  it("accepts 1..4", () => {
    expect(isValidQualityLevel(1)).toBe(true);
    expect(isValidQualityLevel(4)).toBe(true);
  });
  it("accepts 8..11", () => {
    expect(isValidQualityLevel(8)).toBe(true);
    expect(isValidQualityLevel(11)).toBe(true);
  });
  it("accepts 12..15", () => {
    expect(isValidQualityLevel(12)).toBe(true);
    expect(isValidQualityLevel(15)).toBe(true);
  });
  it("accepts 16..19", () => {
    expect(isValidQualityLevel(16)).toBe(true);
    expect(isValidQualityLevel(19)).toBe(true);
  });
  it("rejects out-of-range", () => {
    expect(isValidQualityLevel(0)).toBe(false);
    expect(isValidQualityLevel(5)).toBe(false);
    expect(isValidQualityLevel(7)).toBe(false);
    expect(isValidQualityLevel(20)).toBe(false);
  });
});

describe("nvidiaOutputDimensions", () => {
  it("VSR produces 2x output", () => {
    expect(nvidiaOutputDimensions("vsr", 853, 480)).toEqual({ width: 1706, height: 960 });
    expect(nvidiaOutputDimensions("vsr", 1920, 1080)).toEqual({ width: 3840, height: 2160 });
  });

  it("High-Bitrate produces 2x output", () => {
    expect(nvidiaOutputDimensions("high-bitrate", 853, 480)).toEqual({ width: 1706, height: 960 });
  });

  it("Denoise produces same resolution", () => {
    expect(nvidiaOutputDimensions("denoise", 853, 480)).toEqual({ width: 853, height: 480 });
    expect(nvidiaOutputDimensions("denoise", 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it("Deblur produces same resolution", () => {
    expect(nvidiaOutputDimensions("deblur", 1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it("output never depends on anything except mode and source dimensions", () => {
    const r1 = nvidiaOutputDimensions("vsr", 853, 480);
    const r2 = nvidiaOutputDimensions("vsr", 853, 480);
    expect(r1).toEqual(r2);
  });
});

describe("enums match canonical ranges", () => {
  it("all processing modes are defined", () => {
    expect(NVIDIA_PROCESSING_MODES).toEqual(["vsr", "high-bitrate", "denoise", "deblur"]);
  });

  it("all qualities are defined", () => {
    expect(NVIDIA_QUALITIES).toEqual(["low", "medium", "high", "ultra"]);
  });

  it("every mode+quality combination produces a valid level", () => {
    for (const mode of NVIDIA_PROCESSING_MODES) {
      for (const quality of NVIDIA_QUALITIES) {
        const level = canonicalQualityLevel(mode, quality);
        expect(isValidQualityLevel(level)).toBe(true);
        const decomposed = decomposeQualityLevel(level);
        expect(decomposed).not.toBeNull();
        expect(decomposed!.mode).toBe(mode);
        expect(decomposed!.quality).toBe(quality);
      }
    }
  });
});
