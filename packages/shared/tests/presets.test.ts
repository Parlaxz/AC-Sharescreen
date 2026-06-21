import { describe, it, expect } from "vitest";
import {
  PRESETS,
  getPreset,
  getDefaultPreset,
  CUSTOM_RANGE,
} from "@screenlink/shared";

describe("Presets", () => {
  it("all 5 presets exist", () => {
    expect(PRESETS.length).toBe(5);
  });

  it("getPreset('egypt-data-saver') returns correct values", () => {
    const preset = getPreset("egypt-data-saver");
    expect(preset).toBeDefined();
    expect(preset!.id).toBe("egypt-data-saver");
    expect(preset!.width).toBe(854);
    expect(preset!.height).toBe(480);
    expect(preset!.captureFps).toBe(15);
    expect(preset!.videoCeilingKbps).toBe(650);
    expect(preset!.policyMaximumKbps).toBe(800);
    expect(preset!.audio).toBe(false);
    expect(preset!.contentHint).toBe("detail");
    expect(preset!.degradationPreference).toBe("maintain-resolution");
    expect(preset!.default).toBe(true);
  });

  it("getPreset('nonexistent') returns undefined", () => {
    expect(getPreset("nonexistent")).toBeUndefined();
  });

  it("getDefaultPreset() returns the default preset", () => {
    const preset = getDefaultPreset();
    expect(preset.id).toBe("egypt-data-saver");
    expect(preset.default).toBe(true);
  });

  it("all presets have IDs that are unique", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all presets have valid ranges within CUSTOM_RANGE", () => {
    for (const preset of PRESETS) {
      expect(preset.width).toBeGreaterThanOrEqual(CUSTOM_RANGE.width.min);
      expect(preset.width).toBeLessThanOrEqual(CUSTOM_RANGE.width.max);
      expect(preset.height).toBeGreaterThanOrEqual(CUSTOM_RANGE.height.min);
      expect(preset.height).toBeLessThanOrEqual(CUSTOM_RANGE.height.max);
      expect(preset.captureFps).toBeGreaterThanOrEqual(
        CUSTOM_RANGE.captureFps.min,
      );
      expect(preset.captureFps).toBeLessThanOrEqual(
        CUSTOM_RANGE.captureFps.max,
      );
      expect(preset.videoCeilingKbps).toBeGreaterThanOrEqual(
        CUSTOM_RANGE.videoCeilingKbps.min,
      );
      expect(preset.videoCeilingKbps).toBeLessThanOrEqual(
        CUSTOM_RANGE.videoCeilingKbps.max,
      );
    }
  });

  it("each preset has all required fields", () => {
    for (const preset of PRESETS) {
      expect(preset.id).toBeDefined();
      expect(typeof preset.width).toBe("number");
      expect(typeof preset.height).toBe("number");
      expect(typeof preset.captureFps).toBe("number");
      expect(typeof preset.videoCeilingKbps).toBe("number");
      expect(typeof preset.policyMaximumKbps).toBe("number");
      expect(typeof preset.audio).toBe("boolean");
      expect(["detail", "motion"]).toContain(preset.contentHint);
      expect(
        ["maintain-resolution", "maintain-framerate", "balanced"],
      ).toContain(preset.degradationPreference);
    }
  });
});
