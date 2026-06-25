import { app } from "electron";
import path from "path";
import fs from "fs";
import {
  QualityPresetSchema,
  type QualityPreset,
  createQualityPreset,
  updateQualityPreset,
  duplicateQualityPreset,
  exportQualityPreset,
  parseQualityPresetExport,
  createDefaultVideoQualitySettings,
  createDefaultAudioEncodingSettings,
} from "@screenlink/shared";
import { z } from "zod";

const QualityPresetsFileSchema = z.object({
  schemaVersion: z.literal(1),
  presets: z.array(QualityPresetSchema),
});

type PresetsFile = z.infer<typeof QualityPresetsFileSchema>;

export class QualityPresetStore {
  private filePath: string;
  private backupPath: string;
  private presets: Map<string, QualityPreset>;

  constructor(basePath?: string) {
    const userData = basePath ?? app.getPath("userData");
    this.filePath = path.join(userData, "quality-presets.json");
    this.backupPath = path.join(userData, "quality-presets.json.bak");
    this.presets = this.load();
  }

  /**
   * Detect compact quality settings form (Phase 2/early Phase 3) and migrate
   * to the nested GroupQualitySettings schema with video/audio sub-objects.
   */
  private migrateCompactSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== "object") return settings;
    const obj = settings as Record<string, unknown>;
    // Compact form has videoBitrateKbps at the top level (not nested under "video")
    if ("videoBitrateKbps" in obj && typeof obj.videoBitrateKbps === "number" && !("schemaVersion" in obj)) {
      const video = createDefaultVideoQualitySettings();
      const audio = createDefaultAudioEncodingSettings();
      if (typeof obj.videoBitrateKbps === "number") video.videoBitrateKbps = obj.videoBitrateKbps as number;
      if (typeof obj.maxWidth === "number") video.sendWidth = obj.maxWidth as number;
      if (typeof obj.maxHeight === "number") video.sendHeight = obj.maxHeight as number;
      if (typeof obj.maxFps === "number") video.sendFps = obj.maxFps as number;
      if (typeof obj.captureWidth === "number") video.captureWidth = obj.captureWidth as number;
      if (typeof obj.captureHeight === "number") video.captureHeight = obj.captureHeight as number;
      if (typeof obj.captureFps === "number") video.captureFps = obj.captureFps as number;
      if (typeof obj.degradationPreference === "string") video.degradationPreference = obj.degradationPreference as never;
      if (typeof obj.contentHint === "string") video.contentHint = obj.contentHint as never;
      if (typeof obj.audioEnabled === "boolean") audio.fec = obj.audioEnabled as boolean;
      return { schemaVersion: 1 as const, video, audio };
    }
    return settings;
  }

  private load(): Map<string, QualityPreset> {
    const map = new Map<string, QualityPreset>();
    const tryRead = (filePath: string): QualityPreset[] | null => {
      if (!fs.existsSync(filePath)) return null;
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        // Phase 2/early Phase 3 migration: convert compact settings per preset
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.presets)) {
          let needsPersist = false;
          for (const preset of parsed.presets) {
            if (preset && typeof preset === "object" && "settings" in preset) {
              const migrated = this.migrateCompactSettings(preset.settings);
              if (migrated !== preset.settings) {
                preset.settings = migrated;
                needsPersist = true;
              }
            }
          }
          if (needsPersist) {
            try {
              const file: PresetsFile = { schemaVersion: 1 as const, presets: parsed.presets };
              fs.writeFileSync(this.filePath + ".tmp", JSON.stringify(file, null, 2), "utf-8");
              fs.renameSync(this.filePath + ".tmp", this.filePath);
            } catch {
              // best-effort
            }
          }
        }
        const result = QualityPresetsFileSchema.safeParse(parsed);
        if (result.success) return result.data.presets as QualityPreset[];
        return null;
      } catch {
        return null;
      }
    };

    let records = tryRead(this.filePath);
    if (!records) {
      records = tryRead(this.backupPath);
      if (records) {
        try {
          this.writeAtomic(records);
        } catch {
          // best-effort
        }
      }
    }
    if (!records) records = [];
    for (const r of records) {
      map.set(r.id, r);
    }
    return map;
  }

  private writeAtomic(presets: QualityPreset[]): void {
    const tmpPath = this.filePath + ".tmp";
    const file: PresetsFile = { schemaVersion: 1, presets };
    fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), "utf-8");
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath);
    }
    fs.renameSync(tmpPath, this.filePath);
  }

  private persist(): void {
    this.writeAtomic(Array.from(this.presets.values()));
  }

  list(): QualityPreset[] {
    return Array.from(this.presets.values());
  }

  get(id: string): QualityPreset | null {
    return this.presets.get(id) ?? null;
  }

  create(input: { name: string; settings: QualityPreset["settings"]; now?: number; idFactory?: () => string }): QualityPreset {
    const preset = createQualityPreset(input);
    this.presets.set(preset.id, preset);
    this.persist();
    return preset;
  }

  update(id: string, input: { name?: string; settings?: QualityPreset["settings"]; now?: number }): QualityPreset | null {
    const existing = this.presets.get(id);
    if (!existing) return null;
    const updated = updateQualityPreset(existing, input);
    this.presets.set(id, updated);
    this.persist();
    return updated;
  }

  duplicate(id: string, newName: string, now?: number): QualityPreset | null {
    const existing = this.presets.get(id);
    if (!existing) return null;
    const dup = duplicateQualityPreset(existing, newName, now);
    this.presets.set(dup.id, dup);
    this.persist();
    return dup;
  }

  delete(id: string): boolean {
    if (!this.presets.has(id)) return false;
    this.presets.delete(id);
    this.persist();
    return true;
  }

  async export(id: string): Promise<string | null> {
    const p = this.presets.get(id);
    if (!p) return null;
    return exportQualityPreset(p);
  }

  async import(exportString: string, now?: number): Promise<{ preset: QualityPreset; renamed: boolean } | { error: string }> {
    const parsed = await parseQualityPresetExport(exportString);
    if ("error" in parsed) return { error: parsed.error };
    const existingNames = new Set(Array.from(this.presets.values()).map((p) => p.name));
    let name = parsed.preset.name;
    let renamed = false;
    if (existingNames.has(name)) {
      let i = 1;
      const baseName = `${name} (Imported)`;
      name = baseName;
      while (existingNames.has(name)) {
        name = `${baseName} ${++i}`;
      }
      renamed = true;
    }
    const id = crypto.randomUUID();
    const nowMs = now ?? Date.now();
    const newPreset: QualityPreset = {
      schemaVersion: 1,
      id,
      name,
      settings: parsed.preset.settings,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    this.presets.set(id, newPreset);
    this.persist();
    return { preset: newPreset, renamed };
  }
}
