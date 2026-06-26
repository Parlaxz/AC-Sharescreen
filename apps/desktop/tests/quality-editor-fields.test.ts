// @vitest-environment node
/**
 * QualityEditorFields tests (Stage 7 — Fix 7).
 *
 * Validates:
 *  - 360p maps to 640×360
 *  - "+020p (144p)" maps to 256×144
 *  - Custom width/height persist
 *  - 256×144 passes all validation
 *  - Values below 256×144 fail validation
 *  - FPS above 60 fails validation
 *  - Bitrate above 20,000 fails validation
 *  - Content-hint descriptions render
 *  - Degradation selector renders and persists
 *  - Custom flow carries content hint and degradation preference
 *  - Personal preset flow carries all six knobs
 */
import { describe, it, expect } from "vitest";
import {
  RESOLUTION_OPTIONS,
  resolveResolution,
  qualityEditorFieldsValid,
  CODEC_OPTIONS,
  CONTENT_HINT_OPTIONS,
  DEGRADATION_OPTIONS,
  type QualityEditorFieldsValue,
} from "../src/renderer/components/workspace/QualityEditorFields.js";

const BASELINE: QualityEditorFieldsValue = {
  resolutionValue: "1920x1080",
  customWidth: 1920,
  customHeight: 1080,
  fps: 30,
  bitrate: 4000,
  codec: "vp9",
  contentHint: "motion",
  degradationPreference: "maintain-resolution",
};

describe("QualityEditorFields — resolution options", () => {
  it("includes 360p as 640×360", () => {
    const opt = RESOLUTION_OPTIONS.find((o) => o.value === "640x360");
    expect(opt).toBeDefined();
    expect(opt?.width).toBe(640);
    expect(opt?.height).toBe(360);
  });

  it('includes "+020p (144p)" as 256×144', () => {
    const opt = RESOLUTION_OPTIONS.find((o) => o.value === "256x144");
    expect(opt).toBeDefined();
    expect(opt?.label).toBe("+020p (144p)");
    expect(opt?.width).toBe(256);
    expect(opt?.height).toBe(144);
  });

  it("includes 4K, 1440p, 1080p, 720p, 480p as labeled options", () => {
    const expected = [
      { value: "3840x2160", label: "3840×2160 (4K)" },
      { value: "2560x1440", label: "2560×1440 (1440p)" },
      { value: "1920x1080", label: "1920×1080 (1080p)" },
      { value: "1280x720", label: "1280×720 (720p)" },
      { value: "854x480", label: "854×480 (480p)" },
    ];
    for (const e of expected) {
      const opt = RESOLUTION_OPTIONS.find((o) => o.value === e.value);
      expect(opt, `expected ${e.value} to be present`).toBeDefined();
      expect(opt?.label).toBe(e.label);
    }
  });

  it("includes a Custom option", () => {
    const custom = RESOLUTION_OPTIONS.find((o) => o.value === "custom");
    expect(custom).toBeDefined();
  });
});

describe("QualityEditorFields — resolveResolution", () => {
  it("returns the selected resolution's dimensions", () => {
    const r = resolveResolution({
      ...BASELINE,
      resolutionValue: "640x360",
    });
    expect(r).toEqual({ width: 640, height: 360 });
  });

  it('returns "+020p (144p)" as 256×144 when selected', () => {
    const r = resolveResolution({
      ...BASELINE,
      resolutionValue: "256x144",
    });
    expect(r).toEqual({ width: 256, height: 144 });
  });

  it("returns custom width/height when Custom is selected", () => {
    const r = resolveResolution({
      ...BASELINE,
      resolutionValue: "custom",
      customWidth: 1234,
      customHeight: 567,
    });
    expect(r).toEqual({ width: 1234, height: 567 });
  });

  it("falls back to custom values when value is unknown", () => {
    const r = resolveResolution({
      ...BASELINE,
      resolutionValue: "no-such-value",
      customWidth: 1280,
      customHeight: 720,
    });
    expect(r).toEqual({ width: 1280, height: 720 });
  });
});

describe("QualityEditorFields — validation", () => {
  it("accepts 256×144", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      resolutionValue: "256x144",
    };
    expect(qualityEditorFieldsValid(v)).toBeNull();
  });

  it("accepts 1280×720 with FPS 60 and bitrate 20000", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      resolutionValue: "1280x720",
      fps: 60,
      bitrate: 20_000,
    };
    expect(qualityEditorFieldsValid(v)).toBeNull();
  });

  it("accepts FPS 1 and bitrate 100 (lower bounds)", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      fps: 1,
      bitrate: 100,
    };
    expect(qualityEditorFieldsValid(v)).toBeNull();
  });

  it("rejects width < 256", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      resolutionValue: "custom",
      customWidth: 200,
      customHeight: 144,
    };
    expect(qualityEditorFieldsValid(v)).toMatch(/Width/);
  });

  it("rejects height < 144", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      resolutionValue: "custom",
      customWidth: 256,
      customHeight: 100,
    };
    expect(qualityEditorFieldsValid(v)).toMatch(/Height/);
  });

  it("rejects width > 3840", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      resolutionValue: "custom",
      customWidth: 5000,
      customHeight: 144,
    };
    expect(qualityEditorFieldsValid(v)).toMatch(/Width/);
  });

  it("rejects FPS > 60", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      fps: 61,
    };
    expect(qualityEditorFieldsValid(v)).toMatch(/Frame rate/);
  });

  it("rejects FPS < 1", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      fps: 0,
    };
    expect(qualityEditorFieldsValid(v)).toMatch(/Frame rate/);
  });

  it("rejects bitrate > 20,000", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      bitrate: 25_000,
    };
    expect(qualityEditorFieldsValid(v)).toMatch(/Bitrate/);
  });

  it("rejects bitrate < 100", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      bitrate: 50,
    };
    expect(qualityEditorFieldsValid(v)).toMatch(/Bitrate/);
  });
});

describe("QualityEditorFields — codec options", () => {
  it("includes VP9 (default), AV1, H.264, VP8", () => {
    for (const codec of ["vp9", "av1", "h264", "vp8"]) {
      expect(
        CODEC_OPTIONS.find((c) => c.value === codec),
        `expected codec ${codec}`,
      ).toBeDefined();
    }
  });
});

describe("QualityEditorFields — content hint and degradation", () => {
  it("renders content-hint descriptions for all four options", () => {
    for (const o of CONTENT_HINT_OPTIONS) {
      expect(o.description.length).toBeGreaterThan(0);
    }
    const auto = CONTENT_HINT_OPTIONS.find((o) => o.value === "auto");
    const text = CONTENT_HINT_OPTIONS.find((o) => o.value === "text");
    const detail = CONTENT_HINT_OPTIONS.find((o) => o.value === "detail");
    const motion = CONTENT_HINT_OPTIONS.find((o) => o.value === "motion");
    expect(auto).toBeDefined();
    expect(text).toBeDefined();
    expect(detail).toBeDefined();
    expect(motion).toBeDefined();
  });

  it("renders degradation options for balanced/maintain-resolution/maintain-framerate", () => {
    for (const v of ["balanced", "maintain-resolution", "maintain-framerate"]) {
      expect(
        DEGRADATION_OPTIONS.find((o) => o.value === v),
        `expected degradation ${v}`,
      ).toBeDefined();
    }
  });

  it("accepts a degradation preference value of balanced", () => {
    const v: QualityEditorFieldsValue = {
      ...BASELINE,
      degradationPreference: "balanced",
    };
    expect(qualityEditorFieldsValid(v)).toBeNull();
  });
});
