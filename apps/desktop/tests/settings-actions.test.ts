// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function mockPreloadApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getSettings: vi.fn().mockResolvedValue({
      version: 1,
      deviceIdentity: {
        deviceId: "dev-1",
        displayName: "Test User",
        createdAt: 1000,
      },
      hostDisplayName: "Test User",
      launchAtLogin: false,
      autoResumeLastMonitor: false,
      previewEnabled: true,
      windowBounds: null,
      monitorFingerprint: null,
      lastSourceId: null,
      lastSourceName: null,
      lastSourceFingerprint: null,
      developerMode: false,
      hostQualityLimits: {
        maxVideoBitrateKbps: 5000,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFps: 30,
        allowViewerQualityRequests: true,
      },
      globalQualityDefaults: {
        schemaVersion: 1,
        video: {
          videoBitrateKbps: 4000,
          sendWidth: 1920,
          sendHeight: 1080,
          sendFps: 30,
          captureWidth: 1920,
          captureHeight: 1080,
          captureFps: 30,
          preserveAspectRatio: true,
          preventUpscale: true,
          resolutionMode: "target-dimensions",
          scaleResolutionDownBy: 1,
          codec: "h264",
          h264Profile: "auto",
          contentHint: "detail",
          degradationPreference: "maintain-resolution",
          scalabilityMode: null,
          cursorMode: "always",
          rtpPriority: "medium",
        },
        audio: {
          bitrateKbps: 64,
          channels: "stereo",
          bitrateMode: "vbr",
          dtx: false,
          fec: true,
          packetDurationMs: 20,
          redundantAudio: false,
        },
      },
      notificationsEnabled: true,
      localTransportPolicy: {},
    }),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    updateDisplayName: vi.fn().mockResolvedValue({
      deviceId: "dev-1",
      displayName: "Updated Name",
      createdAt: 1000,
    }),
    setGroupNotifications: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  Object.defineProperty(globalThis, "window", {
    value: { screenlink: api },
    writable: true,
    configurable: true,
  });
  return api;
}

function restoreWindow() {
  delete (globalThis as any).window;
}

describe("Settings actions", () => {
  beforeEach(() => {
    // Clean window mock
    restoreWindow();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  // ── loadSettings ─────────────────────────────────────────────────

  it("loads settings from preload API", async () => {
    const api = mockPreloadApi();
    const { loadSettings } = await import(
      "../src/renderer/services/settings-actions.js"
    );

    const settings = await loadSettings();

    expect(api.getSettings).toHaveBeenCalled();
    expect(settings.version).toBe(1);
    expect(settings.deviceIdentity.displayName).toBe("Test User");
    expect(settings.hostQualityLimits.maxVideoBitrateKbps).toBe(5000);
  });

  it("loadSettings rejects when API fails", async () => {
    mockPreloadApi({
      getSettings: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const { loadSettings } = await import(
      "../src/renderer/services/settings-actions.js"
    );

    await expect(loadSettings()).rejects.toThrow("DB error");
  });

  it("loadSettings rejects when preload API is unavailable", async () => {
    const { loadSettings } = await import(
      "../src/renderer/services/settings-actions.js"
    );

    await expect(loadSettings()).rejects.toThrow("screenlink API not available");
  });

  // ── saveSettings ─────────────────────────────────────────────────

  it("saves partial settings via preload API", async () => {
    const api = mockPreloadApi();
    const { saveSettings } = await import(
      "../src/renderer/services/settings-actions.js"
    );

    await saveSettings({ launchAtLogin: true, autoResumeLastMonitor: true });

    expect(api.updateSettings).toHaveBeenCalledWith({
      launchAtLogin: true,
      autoResumeLastMonitor: true,
    });
  });

  it("saveSettings rejects when API fails", async () => {
    mockPreloadApi({
      updateSettings: vi.fn().mockRejectedValue(new Error("Save failed")),
    });
    const { saveSettings } = await import(
      "../src/renderer/services/settings-actions.js"
    );

    await expect(saveSettings({ launchAtLogin: true })).rejects.toThrow(
      "Save failed",
    );
  });

  // ── updateDisplayName ────────────────────────────────────────────

  it("updates display name via preload API", async () => {
    const api = mockPreloadApi();
    const { updateDisplayName } = await import(
      "../src/renderer/services/settings-actions.js"
    );

    const result = await updateDisplayName("New Name");

    expect(api.updateDisplayName).toHaveBeenCalledWith("New Name");
    expect(result.displayName).toBe("Updated Name");
  });

  it("updateDisplayName rejects when API fails", async () => {
    mockPreloadApi({
      updateDisplayName: vi.fn().mockRejectedValue(new Error("Name too long")),
    });
    const { updateDisplayName } = await import(
      "../src/renderer/services/settings-actions.js"
    );

    await expect(updateDisplayName("A very long name...")).rejects.toThrow(
      "Name too long",
    );
  });

  // ── setGroupNotifications ────────────────────────────────────────

  it("sets group notifications via preload API", async () => {
    const api = mockPreloadApi();
    const { setGroupNotifications } = await import(
      "../src/renderer/services/settings-actions.js"
    );

    await setGroupNotifications("group-1", false);

    expect(api.setGroupNotifications).toHaveBeenCalledWith("group-1", false);
  });
});

describe("Quality preset CRUD actions", () => {
  beforeEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  it("creates a quality preset via preload API", async () => {
    const api = mockPreloadApi({
      createQualityPreset: vi.fn().mockResolvedValue({
        id: "new-preset-uuid",
        name: "My Preset",
        settings: { videoBitrateKbps: 2000 },
      }),
      listQualityPresets: vi.fn().mockResolvedValue([]),
      updateQualityPreset: vi.fn().mockResolvedValue(null),
      deleteQualityPreset: vi.fn().mockResolvedValue(true),
      duplicateQualityPreset: vi.fn().mockResolvedValue({
        id: "dup-uuid",
        name: "My Preset (copy)",
        settings: {},
      }),
      exportQualityPreset: vi.fn().mockResolvedValue("SLQP1:exported-data"),
      importQualityPreset: vi.fn().mockResolvedValue({
        id: "import-uuid",
        name: "Imported Preset",
        settings: {},
      }),
    });
    const { createQualityPreset, fetchQualityPresets, updateQualityPreset, deleteQualityPreset, duplicateQualityPreset, exportQualityPreset, importQualityPreset } = await import(
      "../src/renderer/services/group-actions.js"
    );

    // create
    const created = await createQualityPreset({
      name: "My Preset",
      settings: { videoBitrateKbps: 2000 },
    });
    expect(api.createQualityPreset).toHaveBeenCalledWith({
      name: "My Preset",
      settings: { videoBitrateKbps: 2000 },
    });
    expect(created.id).toBe("new-preset-uuid");

    // fetch
    const presets = await fetchQualityPresets();
    expect(api.listQualityPresets).toHaveBeenCalled();
    expect(presets).toEqual([]);

    // update
    await updateQualityPreset("some-id", { name: "Renamed" });
    expect(api.updateQualityPreset).toHaveBeenCalledWith("some-id", {
      name: "Renamed",
    });

    // delete
    const deleted = await deleteQualityPreset("some-id");
    expect(api.deleteQualityPreset).toHaveBeenCalledWith("some-id");
    expect(deleted).toBe(true);

    // duplicate
    const dup = await duplicateQualityPreset("some-id", "Copy");
    expect(api.duplicateQualityPreset).toHaveBeenCalledWith("some-id", "Copy");
    expect(dup!.id).toBe("dup-uuid");

    // export
    const exported = await exportQualityPreset("some-id");
    expect(api.exportQualityPreset).toHaveBeenCalledWith("some-id");
    expect(exported).toBe("SLQP1:exported-data");

    // import
    const imported = await importQualityPreset("SLQP1:data");
    expect(api.importQualityPreset).toHaveBeenCalledWith("SLQP1:data");
    expect(imported.id).toBe("import-uuid");
  });

  it("preset operations reject when API fails", async () => {
    const api = mockPreloadApi({
      createQualityPreset: vi.fn().mockRejectedValue(new Error("Create failed")),
      updateQualityPreset: vi.fn().mockRejectedValue(new Error("Update failed")),
      deleteQualityPreset: vi.fn().mockRejectedValue(new Error("Delete failed")),
      duplicateQualityPreset: vi.fn().mockRejectedValue(new Error("Dup failed")),
      exportQualityPreset: vi.fn().mockRejectedValue(new Error("Export failed")),
      importQualityPreset: vi.fn().mockRejectedValue(new Error("Import failed")),
      listQualityPresets: vi.fn().mockRejectedValue(new Error("List failed")),
    });
    const { createQualityPreset, fetchQualityPresets, updateQualityPreset, deleteQualityPreset, duplicateQualityPreset, exportQualityPreset, importQualityPreset } = await import(
      "../src/renderer/services/group-actions.js"
    );

    await expect(
      createQualityPreset({ name: "X", settings: {} }),
    ).rejects.toThrow("Create failed");
    await expect(fetchQualityPresets()).rejects.toThrow("List failed");
    await expect(updateQualityPreset("x", {})).rejects.toThrow("Update failed");
    await expect(deleteQualityPreset("x")).rejects.toThrow("Delete failed");
    await expect(duplicateQualityPreset("x", "y")).rejects.toThrow("Dup failed");
    await expect(exportQualityPreset("x")).rejects.toThrow("Export failed");
    await expect(importQualityPreset("x")).rejects.toThrow("Import failed");
  });
});
