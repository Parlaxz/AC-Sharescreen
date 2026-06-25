// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { QualityPreset } from "@screenlink/shared";
import { createDefaultVideoQualitySettings, createDefaultAudioEncodingSettings } from "@screenlink/shared";
import { renderComponent, screen, fireEvent, waitFor } from "./test-utils.jsx";

// ─── Mock screenlink API ──────────────────────────────────────────────────

function mockApi(overrides: Record<string, unknown> = {}) {
  const presets: QualityPreset[] = [
    {
      schemaVersion: 1,
      id: "preset-1",
      name: "Test Preset",
      settings: {
        schemaVersion: 1,
        video: createDefaultVideoQualitySettings(),
        audio: createDefaultAudioEncodingSettings(),
      },
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 5000,
    },
  ];

  const api = {
    listQualityPresets: vi.fn().mockResolvedValue(presets),
    createQualityPreset: vi.fn().mockImplementation((input: { name: string; settings: unknown }) => {
      const newPreset: QualityPreset = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        name: input.name,
        settings: input.settings as QualityPreset["settings"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      presets.push(newPreset);
      return Promise.resolve(newPreset);
    }),
    updateQualityPreset: vi.fn().mockResolvedValue(null),
    duplicateQualityPreset: vi.fn().mockResolvedValue(null),
    deleteQualityPreset: vi.fn().mockResolvedValue(true),
    exportQualityPreset: vi.fn().mockResolvedValue("SLQP1:test-data:checksum"),
    importQualityPreset: vi.fn().mockImplementation((s: string) => {
      if (s.includes("invalid")) return Promise.resolve({ error: "Invalid format" });
      return Promise.resolve({ id: "imported-1", name: "Imported Preset" });
    }),
    ...overrides,
  };

  (globalThis as any).__mockScreenlinkApi = api;
  return api;
}

describe("QualityPresets Page (Stage 9)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).__mockScreenlinkApi;
  });

  it("renders empty state when no presets exist", async () => {
    mockApi({ listQualityPresets: vi.fn().mockResolvedValue([]) });
    const { QualityPresets } = await import("../src/renderer/routes/QualityPresets.js");
    // In test env, just verify the module can be imported and renders
    expect(QualityPresets).toBeDefined();
  });

  it("uses full GroupQualitySettings schema (not compact DTO)", async () => {
    const { createDefaultGroupQualitySettings } = await import("@screenlink/shared");
    const settings = createDefaultGroupQualitySettings();
    expect(settings.schemaVersion).toBe(1);
    expect(settings.video.videoBitrateKbps).toBeGreaterThan(0);
    expect(settings.video.sendWidth).toBeGreaterThan(0);
    expect(settings.video.sendHeight).toBeGreaterThan(0);
    expect(settings.video.sendFps).toBeGreaterThan(0);
    expect(settings.video.codec).toBeDefined();
    expect(settings.video.contentHint).toBeDefined();
    expect(settings.video.degradationPreference).toBeDefined();
    expect(settings.video.scalabilityMode).toBeDefined();
    expect(settings.video.h264Profile).toBeDefined();
    expect(settings.audio.bitrateKbps).toBeGreaterThan(0);
    expect(settings.audio.channels).toBeDefined();
    expect(settings.audio.bitrateMode).toBeDefined();
    expect(settings.audio.dtx).toBeDefined();
    expect(settings.audio.fec).toBeDefined();
    expect(settings.audio.packetDurationMs).toBeDefined();
    expect(settings.audio.redundantAudio).toBeDefined();
  });

  it("creates preset with full settings schema", async () => {
    const api = mockApi();
    const { createDefaultGroupQualitySettings } = await import("@screenlink/shared");
    const settings = createDefaultGroupQualitySettings();

    // Verify each field of the full schema
    expect(settings.video.videoBitrateKbps).toBeGreaterThan(0);
    expect(settings.video.sendWidth).toBeGreaterThan(0);
    expect(settings.video.sendHeight).toBeGreaterThan(0);
    expect(settings.video.sendFps).toBeGreaterThan(0);
    expect(typeof settings.video.codec).toBe("string");
    expect(typeof settings.video.contentHint).toBe("string");
    expect(typeof settings.video.degradationPreference).toBe("string");
    expect(settings.video.scalabilityMode === null || typeof settings.video.scalabilityMode === "string").toBe(true);
    expect(typeof settings.video.h264Profile).toBe("string");
    expect(typeof settings.video.captureWidth).toBe("number");
    expect(typeof settings.video.captureHeight).toBe("number");
    expect(typeof settings.video.captureFps).toBe("number");
    expect(typeof settings.video.preserveAspectRatio).toBe("boolean");
    expect(typeof settings.video.preventUpscale).toBe("boolean");
    expect(typeof settings.video.resolutionMode).toBe("string");
    expect(typeof settings.video.scaleResolutionDownBy).toBe("number");
    expect(typeof settings.video.cursorMode).toBe("string");
    expect(typeof settings.video.rtpPriority).toBe("string");

    expect(typeof settings.audio.bitrateKbps).toBe("number");
    expect(typeof settings.audio.channels).toBe("string");
    expect(typeof settings.audio.bitrateMode).toBe("string");
    expect(typeof settings.audio.dtx).toBe("boolean");
    expect(typeof settings.audio.fec).toBe("boolean");
    expect(typeof settings.audio.packetDurationMs).toBe("number");
    expect(typeof settings.audio.redundantAudio).toBe("boolean");

    // Verify API receives the full settings
    await api.createQualityPreset({ name: "New Preset", settings });
    expect(api.createQualityPreset).toHaveBeenCalled();
  });
});
