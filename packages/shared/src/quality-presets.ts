import { z } from "zod";
import { GroupQualitySettingsSchema, type GroupQualitySettings } from "./quality-settings.js";
import { canonicalJsonHash } from "./groups.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface QualityPreset {
  schemaVersion: 1;
  id: string;
  name: string;
  settings: GroupQualitySettings;
  createdAt: number;
  updatedAt: number;
  /** When true, this preset appears in the viewer settings panel for quick access */
  showInViewerPanel?: boolean;
  /** Unique slot number (1-9) for keyboard-triggered switching on the viewer page */
  viewerPanelSlot?: number | null;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

export const QualityPresetSchema: z.ZodType<QualityPreset> = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  settings: GroupQualitySettingsSchema,
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  showInViewerPanel: z.boolean().optional(),
  viewerPanelSlot: z.number().int().min(1).max(9).nullable().optional(),
});

export type QualityPresetParsed = z.infer<typeof QualityPresetSchema>;

// ─── Constants ─────────────────────────────────────────────────────────────

const EXPORT_PREFIX = "SLQP1:";

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Create a new QualityPreset with a random ID.
 */
export function createQualityPreset(input: {
  name: string;
  settings: GroupQualitySettings;
  now?: number;
  idFactory?: () => string;
  showInViewerPanel?: boolean;
  viewerPanelSlot?: number | null;
}): QualityPreset {
  const now = input.now ?? Date.now();
  const id = input.idFactory ? input.idFactory() : crypto.randomUUID();
  return {
    schemaVersion: 1,
    id,
    name: input.name,
    settings: input.settings,
    createdAt: now,
    updatedAt: now,
    ...(input.showInViewerPanel !== undefined ? { showInViewerPanel: input.showInViewerPanel } : {}),
    ...(input.viewerPanelSlot !== undefined ? { viewerPanelSlot: input.viewerPanelSlot } : {}),
  };
}

/**
 * Update an existing QualityPreset with a partial patch.
 */
export function updateQualityPreset(
  preset: QualityPreset,
  patch: { name?: string; settings?: GroupQualitySettings; now?: number; showInViewerPanel?: boolean; viewerPanelSlot?: number | null },
): QualityPreset {
  const now = patch.now ?? Date.now();
  return {
    ...preset,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
    ...(patch.showInViewerPanel !== undefined ? { showInViewerPanel: patch.showInViewerPanel } : {}),
    ...(patch.viewerPanelSlot !== undefined ? { viewerPanelSlot: patch.viewerPanelSlot } : {}),
    updatedAt: now,
  };
}

/**
 * Duplicate a QualityPreset with a new name and fresh ID/timestamps.
 */
export function duplicateQualityPreset(
  preset: QualityPreset,
  newName: string,
  now?: number,
): QualityPreset {
  const ts = now ?? Date.now();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: newName,
    settings: { ...preset.settings },
    createdAt: ts,
    updatedAt: ts,
  };
}

// ─── Export / Import ───────────────────────────────────────────────────────

/**
 * Export a QualityPreset to a shareable string.
 * Format: SLQP1:<BASE64URL-CANONICAL-JSON>:<SHA256-CHECKSUM>
 */
export async function exportQualityPreset(preset: QualityPreset): Promise<string> {
  const json = canonicalJsonStringify(preset);
  const checksum = await canonicalJsonHash(preset);
  const base64url = base64urlEncode(json);
  return `${EXPORT_PREFIX}${base64url}:${checksum}`;
}

/**
 * Parse an export string (without importing into a collection).
 * Returns the preset on success, or an error string on failure.
 */
export async function parseQualityPresetExport(
  exportString: string,
): Promise<{ preset: QualityPreset } | { error: string }> {
  if (!exportString.startsWith(EXPORT_PREFIX)) {
    return { error: "Invalid export format: missing prefix" };
  }

  const afterPrefix = exportString.slice(EXPORT_PREFIX.length);
  const colonIndex = afterPrefix.lastIndexOf(":");
  if (colonIndex < 0) {
    return { error: "Invalid export format: missing checksum" };
  }

  const encodedJson = afterPrefix.slice(0, colonIndex);
  const expectedChecksum = afterPrefix.slice(colonIndex + 1);

  if (!encodedJson || !expectedChecksum) {
    return { error: "Invalid export format: empty body or checksum" };
  }

  let json: string;
  try {
    json = base64urlDecode(encodedJson);
  } catch {
    return { error: "Invalid export format: base64url decode failed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "Invalid export format: JSON parse failed" };
  }

  // Verify checksum
  const computedChecksum = await canonicalJsonHash(parsed);
  if (computedChecksum !== expectedChecksum) {
    return { error: `Checksum mismatch: expected ${expectedChecksum}, got ${computedChecksum}` };
  }

  const result = QualityPresetSchema.safeParse(parsed);
  if (!result.success) {
    return { error: `Invalid preset: ${result.error.message}` };
  }

  return { preset: result.data };
}

/**
 * Import a quality preset from an export string.
 * If the name collides with an existing name, it is suffixed with " (Imported)"
 * and a numeric suffix if needed.
 */
export async function importQualityPreset(
  exportString: string,
  existingNames: string[],
  now?: number,
): Promise<{ preset: QualityPreset } | { error: string }> {
  const parseResult = await parseQualityPresetExport(exportString);
  if ("error" in parseResult) {
    return parseResult;
  }

  const ts = now ?? Date.now();
  const existingSet = new Set(existingNames);

  let name = parseResult.preset.name;
  if (existingSet.has(name)) {
    let suffix = "";
    let attempt = 0;
    while (existingSet.has(`${name}${suffix}`)) {
      attempt++;
      suffix = attempt === 1 ? " (Imported)" : ` (Imported ${attempt})`;
    }
    name = `${name}${suffix}`;
  }

  const preset: QualityPreset = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    settings: { ...parseResult.preset.settings },
    createdAt: ts,
    updatedAt: ts,
  };

  return { preset };
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

function base64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): string {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
