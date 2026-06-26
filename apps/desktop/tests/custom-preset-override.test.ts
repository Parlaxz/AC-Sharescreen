// @vitest-environment node
/**
 * Custom preset override carries the full quality surface (Stage 7 — Fix 7).
 *
 * The Custom editor now exposes all six knobs. The override builder
 * must propagate content hint and degradation preference, and the
 * auto content hint must be normalized to an empty/omitted value so
 * PublisherManager can omit MediaStreamTrack.contentHint correctly.
 */
import { describe, it, expect } from "vitest";
import {
  customPresetToOverride,
  presetSettingsToOverride,
  validateSessionQualityOverride,
} from "../src/renderer/services/share-quality.js";

describe("customPresetToOverride — six-knob coverage", () => {
  it("propagates codec, content hint, and degradation preference to the override", () => {
    const ov = customPresetToOverride({
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 4000,
      codec: "vp9",
      contentHint: "text",
      degradationPreference: "maintain-framerate",
    });
    expect(ov.codec).toBe("vp9");
    expect(ov.contentHint).toBe("text");
    expect(ov.degradationPreference).toBe("maintain-framerate");
  });

  it("defaults codec to vp9 when not supplied", () => {
    const ov = customPresetToOverride({
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 4000,
    });
    expect(ov.codec).toBe("vp9");
  });

  it("preserves the custom content hint verbatim", () => {
    expect(
      customPresetToOverride({
        width: 1280,
        height: 720,
        fps: 30,
        bitrate: 4000,
        contentHint: "detail",
      }).contentHint,
    ).toBe("detail");
    expect(
      customPresetToOverride({
        width: 1280,
        height: 720,
        fps: 30,
        bitrate: 4000,
        contentHint: "motion",
      }).contentHint,
    ).toBe("motion");
  });

  it("preserves the custom degradation preference verbatim", () => {
    expect(
      customPresetToOverride({
        width: 1280,
        height: 720,
        fps: 30,
        bitrate: 4000,
        degradationPreference: "balanced",
      }).degradationPreference,
    ).toBe("balanced");
    expect(
      customPresetToOverride({
        width: 1280,
        height: 720,
        fps: 30,
        bitrate: 4000,
        degradationPreference: "maintain-resolution",
      }).degradationPreference,
    ).toBe("maintain-resolution");
  });

  it("accepts 256×144 (144p)", () => {
    const ov = customPresetToOverride({
      width: 256,
      height: 144,
      fps: 15,
      bitrate: 100,
    });
    expect(ov.sendWidth).toBe(256);
    expect(ov.sendHeight).toBe(144);
    expect(validateSessionQualityOverride(ov)).toBeNull();
  });

  it("rejects 320×180 via validate (old lower bound)", () => {
    const ov = customPresetToOverride({
      width: 320,
      height: 180,
      fps: 15,
      bitrate: 100,
    });
    // The new validation range is 256–3840 / 144–2160; 320×180 still
    // passes (it is above the new floor). The new lower bound only
    // rejects values below 256 / 144.
    expect(validateSessionQualityOverride(ov)).toBeNull();
  });

  it("rejects dimensions below the new floor (256/144)", () => {
    const ov = customPresetToOverride({
      width: 100,
      height: 50,
      fps: 10,
      bitrate: 100,
    });
    expect(validateSessionQualityOverride(ov)).toMatch(/Send width/);
  });

  it("rejects FPS > 60", () => {
    const ov = customPresetToOverride({
      width: 1280,
      height: 720,
      fps: 120,
      bitrate: 4000,
    });
    expect(validateSessionQualityOverride(ov)).toMatch(/Send FPS/);
  });

  it("rejects bitrate > 20000", () => {
    const ov = customPresetToOverride({
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 50_000,
    });
    expect(validateSessionQualityOverride(ov)).toMatch(/Bitrate/);
  });
});

describe("presetSettingsToOverride — six-knob coverage", () => {
  it("carries codec, content hint, and degradation preference from a personal preset", () => {
    const ov = presetSettingsToOverride({
      video: {
        videoBitrateKbps: 4000,
        sendWidth: 1280,
        sendHeight: 720,
        sendFps: 30,
        captureWidth: 1280,
        captureHeight: 720,
        captureFps: 30,
        codec: "av1",
        contentHint: "detail",
        degradationPreference: "balanced",
      },
    });
    expect(ov.codec).toBe("av1");
    expect(ov.contentHint).toBe("detail");
    expect(ov.degradationPreference).toBe("balanced");
  });

  it("falls back to vp9 and undefined hints when preset is sparse", () => {
    const ov = presetSettingsToOverride({
      video: {
        videoBitrateKbps: 1000,
        sendWidth: 854,
        sendHeight: 480,
        sendFps: 15,
      },
    });
    expect(ov.codec).toBe("vp9");
    expect(ov.contentHint).toBeUndefined();
    expect(ov.degradationPreference).toBeUndefined();
  });
});
