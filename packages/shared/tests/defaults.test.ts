// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  defaultHostQualityLimits,
  defaultGlobalQualityDefaults,
  defaultStreamInfoCard,
  defaultQuickShareAccelerator,
  defaultDiscordMuteShortcut,
  defaultDiscordDeafenShortcut,
  defaultViewerBitrateSliderMaxKbps,
  defaultViewerMaxVolumePercent,
  defaultNvidiaProcessingMode,
  defaultNvidiaQuality,
  defaultHourlyEstimateDurationMs,
  defaultShowCompareControls,
  createDefaultVideoQualitySettings,
  createDefaultHostQualityLimits,
  createDefaultGroupQualitySettings,
  createDefaultAudioEncodingSettings,
  FALLBACK_VIDEO_BITRATE_KBPS,
  FALLBACK_SEND_WIDTH,
  FALLBACK_SEND_HEIGHT,
  FALLBACK_SEND_FPS,
  FALLBACK_CODEC,
  FALLBACK_CONTENT_HINT,
  FALLBACK_DEGRADATION_PREFERENCE,
} from "../src/index.js";

describe("Phase 3 default factories — shared authority", () => {
  it("defaultHostQualityLimits matches createDefaultHostQualityLimits", () => {
    expect(defaultHostQualityLimits()).toEqual(createDefaultHostQualityLimits());
  });

  it("defaultGlobalQualityDefaults matches createDefaultGroupQualitySettings", () => {
    expect(defaultGlobalQualityDefaults()).toEqual(createDefaultGroupQualitySettings());
  });

  it("StreamInfoCard factory produces expected values", () => {
    const sic = defaultStreamInfoCard();
    expect(sic.visible).toBe(false);
    expect(sic.showResolution).toBe(true);
    expect(sic.position).toBe("top-right");
    expect(sic.fontSize).toBe(12);
    expect(sic.boxWidth).toBe(200);
    expect(sic.boxOpacity).toBe(60);
  });

  it("Quick Share accelerator is Super+Alt+S", () => {
    expect(defaultQuickShareAccelerator()).toBe("Super+Alt+S");
  });

  it("Discord shortcuts match expected modifiers", () => {
    const mute = defaultDiscordMuteShortcut();
    expect(mute.modifiers).toEqual(["alt"]);
    expect(mute.key).toBe("M");

    const deafen = defaultDiscordDeafenShortcut();
    expect(deafen.modifiers).toEqual(["alt"]);
    expect(deafen.key).toBe("D");
  });

  it("NVIDIA defaults", () => {
    expect(defaultNvidiaProcessingMode()).toBe("vsr");
    expect(defaultNvidiaQuality()).toBe("high");
  });

  it("viewer defaults", () => {
    expect(defaultViewerBitrateSliderMaxKbps()).toBe(5000);
    expect(defaultViewerMaxVolumePercent()).toBe(200);
    expect(defaultHourlyEstimateDurationMs()).toBe(10_000);
  });

  it("defaultShowCompareControls is false", () => {
    expect(defaultShowCompareControls()).toBe(false);
  });

  it("FALLBACK_* scalars match createDefaultVideoQualitySettings", () => {
    const defaults = createDefaultVideoQualitySettings();
    expect(FALLBACK_VIDEO_BITRATE_KBPS).toBe(defaults.videoBitrateKbps);
    expect(FALLBACK_SEND_WIDTH).toBe(defaults.sendWidth);
    expect(FALLBACK_SEND_HEIGHT).toBe(defaults.sendHeight);
    expect(FALLBACK_SEND_FPS).toBe(defaults.sendFps);
  });

  it("Video quality factory delegates to FALLBACK_* constants", () => {
    const vq = createDefaultVideoQualitySettings();
    expect(vq.videoBitrateKbps).toBe(FALLBACK_VIDEO_BITRATE_KBPS);
    expect(vq.sendWidth).toBe(FALLBACK_SEND_WIDTH);
    expect(vq.sendHeight).toBe(FALLBACK_SEND_HEIGHT);
    expect(vq.sendFps).toBe(FALLBACK_SEND_FPS);
    expect(vq.codec).toBe(FALLBACK_CODEC);
    expect(vq.contentHint).toBe(FALLBACK_CONTENT_HINT);
    expect(vq.degradationPreference).toBe(FALLBACK_DEGRADATION_PREFERENCE);
  });

  it("Audio settings factory produces stereo VBR at 64kbps", () => {
    const audio = createDefaultAudioEncodingSettings();
    expect(audio.bitrateKbps).toBe(64);
    expect(audio.channels).toBe("stereo");
    expect(audio.bitrateMode).toBe("vbr");
    expect(audio.fec).toBe(true);
  });

  it("Group quality factory delegates to sub-factories", () => {
    const group = createDefaultGroupQualitySettings();
    expect(group.schemaVersion).toBe(1);
    expect(group.video).toEqual(createDefaultVideoQualitySettings());
    expect(group.audio).toEqual(createDefaultAudioEncodingSettings());
  });
});
