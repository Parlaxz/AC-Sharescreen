import { describe, it, expect } from "vitest";
import { calculateEffectiveQuality } from "@screenlink/shared";
import type {
  GroupQualitySettings,
  HostQualityLimits,
  ViewerQualityRequest,
} from "@screenlink/shared";
import {
  createDefaultGroupQualitySettings,
  createDefaultHostQualityLimits,
  RANGES,
} from "@screenlink/shared";

// ─── Helpers ────────────────────────────────────────────────────────────────

function group(overrides?: Partial<GroupQualitySettings["video"]>): GroupQualitySettings {
  return {
    ...createDefaultGroupQualitySettings(),
    video: { ...createDefaultGroupQualitySettings().video, ...overrides },
  };
}

function host(overrides?: Partial<HostQualityLimits>): HostQualityLimits {
  return { ...createDefaultHostQualityLimits(), ...overrides };
}

function viewerReq(overrides?: Partial<ViewerQualityRequest>): ViewerQualityRequest {
  return {
    streamSessionId: "session-1",
    requestId: "req-1",
    revision: 1,
    videoBitrateKbps: 2000,
    maxWidth: 1280,
    maxHeight: 720,
    maxFps: 30,
    degradationPreference: "balanced",
    requestedAt: Date.now(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("calculateEffectiveQuality (shared pure resolver)", () => {
  // ── Group defaults ─────────────────────────────────────────────────────
  describe("group defaults (no viewer request)", () => {
    it("returns group default values when no viewer request is provided", () => {
      const g = group();
      const h = host();
      const result = calculateEffectiveQuality(g, h, null, { width: 1920, height: 1080 });

      expect(result.requested).toBeNull();
      expect(result.effective.videoBitrateKbps).toBe(g.video.videoBitrateKbps);
      expect(result.effective.maxFps).toBe(g.video.sendFps);
      expect(result.effective.degradationPreference).toBe(g.video.degradationPreference);
    });

    it("applies scaleResolutionDownBy when using group defaults", () => {
      const g = group({ sendWidth: 1920, sendHeight: 1080, scaleResolutionDownBy: 2 });
      const result = calculateEffectiveQuality(g, host(), null, { width: 1920, height: 1080 });

      expect(result.effective.maxWidth).toBe(960);
      expect(result.effective.maxHeight).toBe(540);
    });

    it("scaleResolutionDownBy=1 produces same width/height", () => {
      const g = group({ sendWidth: 854, sendHeight: 480, scaleResolutionDownBy: 1 });
      const result = calculateEffectiveQuality(g, host(), null, { width: 854, height: 480 });

      expect(result.effective.maxWidth).toBe(854);
      expect(result.effective.maxHeight).toBe(480);
    });
  });

  // ── Host limits ────────────────────────────────────────────────────────
  describe("host limits clamping", () => {
    it("clamps bitrate to host limit", () => {
      const g = group({ videoBitrateKbps: 10000 });
      const h = host({ maxVideoBitrateKbps: 3000 });
      const result = calculateEffectiveQuality(g, h, null, { width: 1920, height: 1080 });

      expect(result.effective.videoBitrateKbps).toBe(3000);
      expect(result.clampReasons).toEqual(
        expect.arrayContaining([expect.stringMatching(/Bitrate clamped.*host limit 3000/)])
      );
    });

    it("clamps width/height to host limits", () => {
      const g = group({ sendWidth: 3840, sendHeight: 2160 });
      const h = host({ maxWidth: 1920, maxHeight: 1080 });
      const result = calculateEffectiveQuality(g, h, null, { width: 3840, height: 2160 });

      expect(result.effective.maxWidth).toBe(1920);
      expect(result.effective.maxHeight).toBe(1080);
    });

    it("clamps FPS to host limit", () => {
      const g = group({ sendFps: 120 });
      const h = host({ maxFps: 30 });
      const result = calculateEffectiveQuality(g, h, null, { width: 1920, height: 1080 });

      expect(result.effective.maxFps).toBe(30);
    });
  });

  // ── Viewer request ─────────────────────────────────────────────────────
  describe("viewer request override", () => {
    it("uses viewer request when host allows viewer quality requests", () => {
      const g = group();
      const h = host({ allowViewerQualityRequests: true });
      const req = viewerReq({ videoBitrateKbps: 300 });
      const result = calculateEffectiveQuality(g, h, req, { width: 1920, height: 1080 });

      expect(result.requested).not.toBeNull();
      expect(result.requested!.videoBitrateKbps).toBe(300);
      expect(result.effective.videoBitrateKbps).toBe(300);
    });

    it("rejects viewer request when allowViewerQualityRequests is false", () => {
      const g = group();
      const h = host({ allowViewerQualityRequests: false });
      const req = viewerReq({ videoBitrateKbps: 300 });
      const result = calculateEffectiveQuality(g, h, req, { width: 1920, height: 1080 });

      expect(result.requested).toBeNull();
      expect(result.effective.videoBitrateKbps).toBe(g.video.videoBitrateKbps);
    });

    it("does not apply group scaleResolutionDownBy when viewer dimensions are honored", () => {
      const g = group({ scaleResolutionDownBy: 4, sendWidth: 1920, sendHeight: 1080 });
      const h = host({ allowViewerQualityRequests: true });
      const req = viewerReq({ maxWidth: 1280, maxHeight: 720 });
      const result = calculateEffectiveQuality(g, h, req, { width: 1920, height: 1080 });

      // Viewer requested dimensions should be final, not scaled by group scaleResolutionDownBy
      expect(result.effective.maxWidth).toBe(1280);
      expect(result.effective.maxHeight).toBe(720);
    });
  });

  // ── Clamping / reasons ─────────────────────────────────────────────────
  describe("clamping reasons", () => {
    it("produces empty clampReasons when no clamping occurs", () => {
      const g = group();
      const h = host();
      const result = calculateEffectiveQuality(g, h, null, { width: 1920, height: 1080 });

      expect(result.clampReasons).toEqual([]);
    });

    it("reports multiple clamp reasons when multiple values exceed limits", () => {
      // sendWidth 7680 is range-clamped to 3840 (range max) which equals host maxWidth 3840,
      // so only 2 host-limit clamp reasons: bitrate and fps. Height is at default 480.
      const g = group({ videoBitrateKbps: 50000, sendWidth: 7680, sendFps: 120 });
      const h = host({ maxVideoBitrateKbps: 10000, maxWidth: 3840, maxFps: 30 });
      const result = calculateEffectiveQuality(g, h, null, { width: 7680, height: 4320 });

      expect(result.clampReasons.length).toBeGreaterThanOrEqual(2);
      expect(result.clampReasons.some((r) => r.includes("Bitrate"))).toBe(true);
      expect(result.clampReasons.some((r) => r.includes("FPS"))).toBe(true);
    });
  });

  // ── Source capability constraints / preventUpscale ─────────────────────
  describe("source capability constraints (preventUpscale)", () => {
    it("clamps width/height to source when preventUpscale is true", () => {
      const g = group({ preventUpscale: true });
      const h = host({ allowViewerQualityRequests: true });
      const req = viewerReq({ maxWidth: 3840, maxHeight: 2160 });
      const result = calculateEffectiveQuality(g, h, req, { width: 1280, height: 720 });

      expect(result.effective.maxWidth).toBe(1280);
      expect(result.effective.maxHeight).toBe(720);
      expect(result.clampReasons.some((r) => r.includes("preventUpscale"))).toBe(true);
    });

    it("does not clamp when source is larger than requested", () => {
      const g = group({ preventUpscale: true });
      const h = host({ allowViewerQualityRequests: true });
      const req = viewerReq({ maxWidth: 854, maxHeight: 480 });
      const result = calculateEffectiveQuality(g, h, req, { width: 1920, height: 1080 });

      expect(result.effective.maxWidth).toBe(854);
      expect(result.effective.maxHeight).toBe(480);
      expect(result.clampReasons.filter((r) => r.includes("preventUpscale"))).toHaveLength(0);
    });

    it("does not prevent upscale when preventUpscale is false", () => {
      // Host limits must be high enough not to clamp the viewer's request here.
      const g = group({ preventUpscale: false });
      const h = host({ allowViewerQualityRequests: true, maxWidth: 3840, maxHeight: 2160 });
      const req = viewerReq({ maxWidth: 3840, maxHeight: 2160 });
      const result = calculateEffectiveQuality(g, h, req, { width: 1280, height: 720 });

      // Without preventUpscale, viewer's larger request passes through (range and host clamped)
      expect(result.effective.maxWidth).toBe(3840);
      expect(result.effective.maxHeight).toBe(2160);
    });

    it("source smaller than host limit applies preventUpscale clamping", () => {
      const g = group({ sendWidth: 1920, sendHeight: 1080, preventUpscale: true });
      const h = host({ maxWidth: 3840, maxHeight: 2160 });
      const result = calculateEffectiveQuality(g, h, null, { width: 640, height: 480 });

      // Group defaults are 1920x1080 but source is 640x480 and preventUpscale is on
      expect(result.effective.maxWidth).toBe(640);
      expect(result.effective.maxHeight).toBe(480);
    });
  });

  // ── Deterministic output ───────────────────────────────────────────────
  describe("deterministic output", () => {
    it("same inputs produce identical outputs", () => {
      const g = group({ videoBitrateKbps: 1500, sendWidth: 1280, sendHeight: 720, sendFps: 30 });
      const h = host({ maxVideoBitrateKbps: 5000, maxWidth: 1920, maxHeight: 1080, maxFps: 60 });
      const req = viewerReq({ videoBitrateKbps: 2000, maxWidth: 1920, maxHeight: 1080, maxFps: 30 });

      const r1 = calculateEffectiveQuality(g, h, req, { width: 1920, height: 1080 });
      const r2 = calculateEffectiveQuality(g, h, req, { width: 1920, height: 1080 });

      expect(r1).toEqual(r2);
    });

    it("no random or Date-dependent fields in output", () => {
      const result = calculateEffectiveQuality(group(), host(), null, { width: 1920, height: 1080 });
      // The output type does not include timestamps or random IDs
      const keys = Object.keys(result.effective);
      expect(keys).toEqual(["videoBitrateKbps", "maxWidth", "maxHeight", "maxFps", "degradationPreference"]);
    });
  });

  // ── Schema range clamping ──────────────────────────────────────────────
  describe("schema range clamping", () => {
    it("clamps bitrate to range min", () => {
      const g = group({ videoBitrateKbps: 10 });
      const result = calculateEffectiveQuality(g, host(), null, { width: 1920, height: 1080 });
      expect(result.effective.videoBitrateKbps).toBe(RANGES.videoBitrateKbps.min);
    });

    it("clamps bitrate to range max", () => {
      // Host limit must be higher than range max so range clamping wins.
      const g = group({ videoBitrateKbps: 999999 });
      const h = host({ maxVideoBitrateKbps: 99999 });
      const result = calculateEffectiveQuality(g, h, null, { width: 1920, height: 1080 });
      expect(result.effective.videoBitrateKbps).toBe(RANGES.videoBitrateKbps.max);
    });

    it("clamps width to range bounds", () => {
      const g = group({ sendWidth: 10 });
      const result = calculateEffectiveQuality(g, host(), null, { width: 1920, height: 1080 });
      expect(result.effective.maxWidth).toBe(RANGES.sendWidth.min);
    });

    it("clamps FPS to range bounds", () => {
      const g = group({ sendFps: 999 });
      const result = calculateEffectiveQuality(g, host(), null, { width: 1920, height: 1080 });
      expect(result.effective.maxFps).toBe(RANGES.sendFps.max);
    });
  });
});
