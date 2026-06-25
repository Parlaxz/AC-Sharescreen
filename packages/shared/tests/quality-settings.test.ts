import { describe, it, expect } from "vitest";
import {
  createDefaultGroupQualitySettings,
  createDefaultVideoQualitySettings,
  createDefaultAudioEncodingSettings,
  createDefaultHostQualityLimits,
  extractViewerRequestFromPreset,
  validateGroupSettings,
  GroupQualitySettingsSchema,
  HostQualityLimitsSchema,
  ViewerQualityRequestSchema,
  VideoQualitySettingsSchema,
  AudioEncodingSettingsSchema,
} from "@screenlink/shared";
import type {
  GroupQualitySettings,
  HostQualityLimits,
} from "@screenlink/shared";

describe("QualitySettings", () => {
  it("createDefaultVideoQualitySettings returns valid defaults", () => {
    const v = createDefaultVideoQualitySettings();
    expect(v.videoBitrateKbps).toBe(650);
    expect(v.sendWidth).toBe(854);
    expect(v.sendHeight).toBe(480);
    expect(v.sendFps).toBe(15);
    expect(v.captureWidth).toBe(854);
    expect(v.captureHeight).toBe(480);
    expect(v.captureFps).toBe(15);
    expect(v.preserveAspectRatio).toBe(true);
    expect(v.preventUpscale).toBe(true);
    expect(v.resolutionMode).toBe("target-dimensions");
    expect(v.scaleResolutionDownBy).toBe(1);
    expect(v.codec).toBe("vp9");
    expect(v.h264Profile).toBe("auto");
    expect(v.contentHint).toBe("detail");
    expect(v.degradationPreference).toBe("maintain-resolution");
    expect(v.scalabilityMode).toBeNull();
    expect(v.cursorMode).toBe("always");
    expect(v.rtpPriority).toBe("medium");
    expect(VideoQualitySettingsSchema.safeParse(v).success).toBe(true);
  });

  it("createDefaultAudioEncodingSettings returns valid defaults", () => {
    const a = createDefaultAudioEncodingSettings();
    expect(a.bitrateKbps).toBe(64);
    expect(a.channels).toBe("stereo");
    expect(a.bitrateMode).toBe("vbr");
    expect(a.dtx).toBe(false);
    expect(a.fec).toBe(true);
    expect(a.packetDurationMs).toBe(20);
    expect(a.redundantAudio).toBe(false);
    expect(AudioEncodingSettingsSchema.safeParse(a).success).toBe(true);
  });

  it("createDefaultGroupQualitySettings returns valid defaults", () => {
    const s = createDefaultGroupQualitySettings();
    expect(s.schemaVersion).toBe(1);
    expect(s.video.videoBitrateKbps).toBe(650);
    expect(s.video.sendWidth).toBe(854);
    expect(s.video.sendHeight).toBe(480);
    expect(s.video.sendFps).toBe(15);
    expect(s.video.degradationPreference).toBe("maintain-resolution");
    expect(s.audio.bitrateKbps).toBe(64);
    expect(s.audio.channels).toBe("stereo");
    expect(GroupQualitySettingsSchema.safeParse(s).success).toBe(true);
  });

  it("createDefaultHostQualityLimits returns valid defaults", () => {
    const l = createDefaultHostQualityLimits();
    expect(l.maxVideoBitrateKbps).toBe(5000);
    expect(l.maxWidth).toBe(1920);
    expect(l.maxHeight).toBe(1080);
    expect(l.maxFps).toBe(60);
    expect(l.allowViewerQualityRequests).toBe(true);
    expect(HostQualityLimitsSchema.safeParse(l).success).toBe(true);
  });

  it("extractViewerRequestFromPreset only copies whitelist fields", () => {
    const preset: GroupQualitySettings = {
      schemaVersion: 1,
      video: {
        videoBitrateKbps: 2500,
        sendWidth: 1920,
        sendHeight: 1080,
        sendFps: 60,
        captureWidth: 1920,
        captureHeight: 1080,
        captureFps: 60,
        preserveAspectRatio: true,
        preventUpscale: true,
        resolutionMode: "target-dimensions",
        scaleResolutionDownBy: 1,
        codec: "vp9",
        h264Profile: "auto",
        contentHint: "motion",
        degradationPreference: "maintain-framerate",
        scalabilityMode: null,
        cursorMode: "always",
        rtpPriority: "medium",
      },
      audio: {
        bitrateKbps: 128,
        channels: "stereo",
        bitrateMode: "vbr",
        dtx: false,
        fec: true,
        packetDurationMs: 20,
        redundantAudio: false,
      },
    };
    const req = extractViewerRequestFromPreset(preset, "session-1", 5);
    expect(req.videoBitrateKbps).toBe(2500);
    expect(req.maxWidth).toBe(1920);
    expect(req.maxHeight).toBe(1080);
    expect(req.maxFps).toBe(60);
    expect(req.degradationPreference).toBe("maintain-framerate");
    expect(req.streamSessionId).toBe("session-1");
    expect(req.revision).toBe(5);
    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(req.requestedAt).toBeGreaterThan(0);
    expect(ViewerQualityRequestSchema.safeParse(req).success).toBe(true);

    // Verify by JSON serialization: no forbidden keys present
    const json = JSON.stringify(req);
    expect(json).toContain("streamSessionId");
    expect(json).toContain("requestId");
    expect(json).toContain("revision");
    expect(json).toContain("videoBitrateKbps");
    expect(json).toContain("maxWidth");
    expect(json).toContain("maxHeight");
    expect(json).toContain("maxFps");
    expect(json).toContain("degradationPreference");
    expect(json).toContain("requestedAt");
    // Forbidden: codec, audio fields, capture fields, cursorMode, rtpPriority, etc.
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.codec).toBeUndefined();
    expect(parsed.bitrateKbps).toBeUndefined();
    expect(parsed.channels).toBeUndefined();
    expect(parsed.captureWidth).toBeUndefined();
    expect(parsed.captureHeight).toBeUndefined();
    expect(parsed.cursorMode).toBeUndefined();
    expect(parsed.rtpPriority).toBeUndefined();
    expect(parsed.sendWidth).toBeUndefined();
    expect(parsed.sendHeight).toBeUndefined();
    expect(parsed.sendFps).toBeUndefined();
  });

  it("extractViewerRequestFromPreset generates unique requestId per call", () => {
    const preset = createDefaultGroupQualitySettings();
    const r1 = extractViewerRequestFromPreset(preset, "s1", 1);
    const r2 = extractViewerRequestFromPreset(preset, "s1", 1);
    expect(r1.requestId).not.toBe(r2.requestId);
  });

  it("extractViewerRequestFromPreset throws when preset is missing whitelisted fields", () => {
    // Create a preset with video missing a required extractable field
    const preset = createDefaultGroupQualitySettings();
    const badVideo = { ...preset.video };
    delete (badVideo as Record<string, unknown>).videoBitrateKbps;
    const badPreset: GroupQualitySettings = {
      ...preset,
      video: badVideo,
    };
    expect(() =>
      extractViewerRequestFromPreset(badPreset, "s1", 1),
    ).toThrow("Missing extractable field");
  });

  it("validateGroupSettings passes when settings within ranges and limits", () => {
    const settings = createDefaultGroupQualitySettings();
    const limits = createDefaultHostQualityLimits();
    const result = validateGroupSettings(settings, limits);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.clampReasons).toEqual([]);
  });

  it("validateGroupSettings clamps bitrate to host limit", () => {
    const settings: GroupQualitySettings = {
      ...createDefaultGroupQualitySettings(),
      video: {
        ...createDefaultGroupQualitySettings().video,
        videoBitrateKbps: 100_000,
      },
    };
    const limits: HostQualityLimits = {
      ...createDefaultHostQualityLimits(),
      maxVideoBitrateKbps: 10_000,
    };
    const result = validateGroupSettings(settings, limits);
    expect(result.ok).toBe(false);
    expect(result.clampReasons.length).toBeGreaterThan(0);
    expect(result.clampReasons.some((r) => r.includes("videoBitrateKbps clamped"))).toBe(true);
  });

  it("validateGroupSettings clamps dimensions to ranges", () => {
    const settings: GroupQualitySettings = {
      ...createDefaultGroupQualitySettings(),
      video: {
        ...createDefaultGroupQualitySettings().video,
        sendWidth: 9999,
        sendFps: 999,
      },
    };
    const limits = createDefaultHostQualityLimits();
    const result = validateGroupSettings(settings, limits);
    expect(result.ok).toBe(false);
    expect(result.clampReasons.some((r) => r.includes("sendWidth clamped"))).toBe(true);
    expect(result.clampReasons.some((r) => r.includes("sendFps clamped"))).toBe(true);
  });

  it("validateGroupSettings clamps to host limits", () => {
    const settings: GroupQualitySettings = {
      ...createDefaultGroupQualitySettings(),
      video: {
        ...createDefaultGroupQualitySettings().video,
        sendWidth: 3840,
        sendHeight: 2160,
        sendFps: 120,
      },
    };
    const limits: HostQualityLimits = {
      maxVideoBitrateKbps: 5000,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 60,
      allowViewerQualityRequests: true,
    };
    const result = validateGroupSettings(settings, limits);
    expect(result.ok).toBe(false);
    expect(result.clampReasons.some((r) => r.includes("to host limit"))).toBe(true);
  });
});
