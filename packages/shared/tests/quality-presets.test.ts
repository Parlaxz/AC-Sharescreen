import { describe, it, expect } from "vitest";
import {
  createQualityPreset,
  updateQualityPreset,
  duplicateQualityPreset,
  exportQualityPreset,
  parseQualityPresetExport,
  importQualityPreset,
  createDefaultGroupQualitySettings,
  QualityPresetSchema,
} from "@screenlink/shared";
import type { GroupQualitySettings, QualityPreset } from "@screenlink/shared";

describe("QualityPresets", () => {
  const defaultSettings = createDefaultGroupQualitySettings();

  let idCounter = 0;
  function idFactory(): string {
    idCounter++;
    return `test-id-${idCounter}`;
  }

  it("createQualityPreset creates a valid preset", () => {
    const p = createQualityPreset({
      name: "My Preset",
      settings: defaultSettings,
      idFactory,
    });
    expect(p.schemaVersion).toBe(1);
    expect(p.name).toBe("My Preset");
    expect(p.settings).toEqual(defaultSettings);
    expect(p.createdAt).toBeGreaterThan(0);
    expect(p.updatedAt).toBe(p.createdAt);
    expect(QualityPresetSchema.safeParse(p).success).toBe(true);
  });

  it("createQualityPreset accepts now override", () => {
    const p = createQualityPreset({
      name: "Test",
      settings: defaultSettings,
      now: 50000,
      idFactory,
    });
    expect(p.createdAt).toBe(50000);
    expect(p.updatedAt).toBe(50000);
  });

  it("updateQualityPreset patches name and settings", () => {
    const p = createQualityPreset({
      name: "Original",
      settings: defaultSettings,
      idFactory,
    });
    const newSettings: GroupQualitySettings = {
      ...defaultSettings,
      videoBitrateKbps: 5000,
    };
    const updated = updateQualityPreset(p, {
      name: "Updated",
      settings: newSettings,
      now: 60000,
    });
    expect(updated.name).toBe("Updated");
    expect(updated.settings.videoBitrateKbps).toBe(5000);
    expect(updated.updatedAt).toBe(60000);
    expect(updated.createdAt).toBe(p.createdAt);
    expect(updated.id).toBe(p.id);
  });

  it("updateQualityPreset returns same object if no patch fields", () => {
    const p = createQualityPreset({
      name: "Test",
      settings: defaultSettings,
      idFactory,
    });
    const updated = updateQualityPreset(p, { now: 99999 });
    expect(updated.name).toBe(p.name);
    expect(updated.settings).toEqual(p.settings);
    expect(updated.updatedAt).toBe(99999);
  });

  it("duplicateQualityPreset copies settings with new name and timestamps", () => {
    const p = createQualityPreset({
      name: "Original",
      settings: defaultSettings,
      idFactory,
    });
    const dup = duplicateQualityPreset(p, "Copy", 70000);
    expect(dup.name).toBe("Copy");
    expect(dup.id).not.toBe(p.id);
    expect(dup.settings).toEqual(p.settings);
    expect(dup.createdAt).toBe(70000);
    expect(dup.updatedAt).toBe(70000);
  });

  it("exportQualityPreset produces valid export string", async () => {
    const p = createQualityPreset({
      name: "Export Test",
      settings: defaultSettings,
      idFactory,
    });
    const exported = await exportQualityPreset(p);
    expect(exported).toMatch(/^SLQP1:/);
    const parts = exported.split(":");
    expect(parts.length).toBe(3); // SLQP1, base64json, checksum
  });

  it("parseQualityPresetExport round-trips", async () => {
    const p = createQualityPreset({
      name: "Roundtrip",
      settings: defaultSettings,
      idFactory,
    });
    const exported = await exportQualityPreset(p);
    const result = await parseQualityPresetExport(exported);
    expect("preset" in result).toBe(true);
    if ("preset" in result) {
      expect(result.preset.name).toBe(p.name);
      expect(result.preset.settings).toEqual(p.settings);
    }
  });

  it("parseQualityPresetExport rejects invalid checksum", async () => {
    const p = createQualityPreset({
      name: "Checksum Test",
      settings: defaultSettings,
      idFactory,
    });
    const exported = await exportQualityPreset(p);
    const tampered = exported.slice(0, -8) + "deadbeef";
    const result = await parseQualityPresetExport(tampered);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Checksum mismatch");
    }
  });

  it("parseQualityPresetExport rejects malformed exports", async () => {
    const result1 = await parseQualityPresetExport("not-a-valid-format");
    expect("error" in result1).toBe(true);
    if ("error" in result1) {
      expect(result1.error).toContain("missing prefix");
    }

    const result2 = await parseQualityPresetExport("SLQP1:abc");
    expect("error" in result2).toBe(true);
  });

  it("importQualityPreset handles name collision", async () => {
    const p = createQualityPreset({
      name: "Collide",
      settings: defaultSettings,
      idFactory,
    });
    const exported = await exportQualityPreset(p);
    const result = await importQualityPreset(exported, ["Collide"], 80000);
    expect("preset" in result).toBe(true);
    if ("preset" in result) {
      expect(result.preset.name).toBe("Collide (Imported)");
    }
  });

  it("importQualityPreset suffixes increment on repeated collisions", async () => {
    const p = createQualityPreset({
      name: "Multi",
      settings: defaultSettings,
      idFactory,
    });
    const exported = await exportQualityPreset(p);
    const result1 = await importQualityPreset(exported, ["Multi"], 90000);
    const result2 = await importQualityPreset(exported, ["Multi", "Multi (Imported)"], 90001);
    expect("preset" in result1).toBe(true);
    expect("preset" in result2).toBe(true);
    if ("preset" in result1 && "preset" in result2) {
      expect(result1.preset.name).toBe("Multi (Imported)");
      expect(result2.preset.name).toBe("Multi (Imported 2)");
    }
  });

  it("importQualityPreset rejects invalid exports", async () => {
    const result = await importQualityPreset("garbage", [], 0);
    expect("error" in result).toBe(true);
  });
});
