import { describe, it, expect } from "vitest";
import {
  createDefaultGroupQualitySettings,
  createDefaultHostQualityLimits,
  extractViewerRequestFromPreset,
  validateGroupSettings,
  GroupQualitySettingsSchema,
  HostQualityLimitsSchema,
  ViewerQualityRequestSchema,
} from "@screenlink/shared";
import type {
  GroupQualitySettings,
  HostQualityLimits,
  DeviceCapabilities,
} from "@screenlink/shared";

describe("QualitySettings", () => {
  it("createDefaultGroupQualitySettings returns valid defaults", () => {
    const s = createDefaultGroupQualitySettings();
    expect(s.videoBitrateKbps).toBe(1800);
    expect(s.maxWidth).toBe(1280);
    expect(s.maxHeight).toBe(720);
    expect(s.maxFps).toBe(30);
    expect(s.degradationPreference).toBe("balanced");
    expect(s.contentHint).toBe("detail");
    expect(s.audioEnabled).toBe(true);
    expect(GroupQualitySettingsSchema.safeParse(s).success).toBe(true);
  });

  it("createDefaultHostQualityLimits returns valid defaults", () => {
    const l = createDefaultHostQualityLimits();
    expect(l.maxBitrateKbpsAbsolute).toBe(20_000);
    expect(l.maxWidthAbsolute).toBe(3840);
    expect(l.maxHeightAbsolute).toBe(2160);
    expect(l.maxFpsAbsolute).toBe(60);
    expect(l.allowedDegradationPreferences.length).toBe(3);
    expect(l.allowedContentHints.length).toBe(2);
    expect(l.audioAllowed).toBe(true);
    expect(HostQualityLimitsSchema.safeParse(l).success).toBe(true);
  });

  it("extractViewerRequestFromPreset only copies allowed fields", () => {
    const preset: GroupQualitySettings = {
      videoBitrateKbps: 2500,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 60,
      degradationPreference: "maintain-framerate",
      contentHint: "motion",
      audioEnabled: true,
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
    // contentHint and audioEnabled must NOT be in the result
    expect((req as Record<string, unknown>).contentHint).toBeUndefined();
    expect((req as Record<string, unknown>).audioEnabled).toBeUndefined();
    expect(ViewerQualityRequestSchema.safeParse(req).success).toBe(true);
  });

  it("extractViewerRequestFromPreset generates unique requestId per call", () => {
    const preset = createDefaultGroupQualitySettings();
    const r1 = extractViewerRequestFromPreset(preset, "s1", 1);
    const r2 = extractViewerRequestFromPreset(preset, "s1", 1);
    expect(r1.requestId).not.toBe(r2.requestId);
  });

  it("validateGroupSettings passes when settings within limits", () => {
    const settings = createDefaultGroupQualitySettings();
    const limits = createDefaultHostQualityLimits();
    const caps: DeviceCapabilities = {
      maxBitrateKbps: 50_000,
      maxWidth: 7680,
      maxHeight: 4320,
      maxFps: 120,
      supportedDegradationPreferences: ["maintain-resolution", "maintain-framerate", "balanced"],
      supportedContentHints: ["detail", "motion"],
      supportsAudio: true,
    };
    const result = validateGroupSettings(settings, limits, caps);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.clampReasons).toEqual([]);
  });

  it("validateGroupSettings clamps bitrate to host limit", () => {
    const settings: GroupQualitySettings = {
      ...createDefaultGroupQualitySettings(),
      videoBitrateKbps: 100_000,
    };
    const limits: HostQualityLimits = {
      ...createDefaultHostQualityLimits(),
      maxBitrateKbpsAbsolute: 10_000,
    };
    const caps: DeviceCapabilities = {
      maxBitrateKbps: 50_000,
      maxWidth: 7680,
      maxHeight: 4320,
      maxFps: 120,
      supportedDegradationPreferences: ["maintain-resolution", "maintain-framerate", "balanced"],
      supportedContentHints: ["detail", "motion"],
      supportsAudio: true,
    };
    const result = validateGroupSettings(settings, limits, caps);
    expect(result.ok).toBe(false);
    expect(result.clampReasons.length).toBeGreaterThan(0);
    expect(result.clampReasons[0]).toContain("videoBitrateKbps clamped");
  });

  it("validateGroupSettings clamps to device capabilities", () => {
    const settings = createDefaultGroupQualitySettings();
    const limits = createDefaultHostQualityLimits();
    const caps: DeviceCapabilities = {
      maxBitrateKbps: 500,
      maxWidth: 800,
      maxHeight: 600,
      maxFps: 15,
      supportedDegradationPreferences: ["balanced"],
      supportedContentHints: ["detail"],
      supportsAudio: false,
    };
    const result = validateGroupSettings(settings, limits, caps);
    expect(result.ok).toBe(false);
    expect(result.clampReasons.length).toBeGreaterThan(0);
  });

  it("validateGroupSettings handles audio disabled by host", () => {
    const settings = createDefaultGroupQualitySettings();
    const limits: HostQualityLimits = {
      ...createDefaultHostQualityLimits(),
      audioAllowed: false,
    };
    const caps: DeviceCapabilities = {
      maxBitrateKbps: 50_000,
      maxWidth: 7680,
      maxHeight: 4320,
      maxFps: 120,
      supportedDegradationPreferences: ["maintain-resolution", "maintain-framerate", "balanced"],
      supportedContentHints: ["detail", "motion"],
      supportsAudio: true,
    };
    const result = validateGroupSettings(settings, limits, caps);
    expect(result.clampReasons.some((r) => r.includes("audio disabled by host"))).toBe(true);
  });
});
