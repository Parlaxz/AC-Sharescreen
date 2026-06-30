import { z } from "zod";

// ─── Variant IDs ───────────────────────────────────────────────────────────

export const COMPARE_VARIANT_A = "A" as const;
export const COMPARE_VARIANT_B = "B" as const;

export const COMPARE_VARIANTS = [COMPARE_VARIANT_A, COMPARE_VARIANT_B] as const;

export type CompareVariantId = (typeof COMPARE_VARIANTS)[number];

export const CompareVariantIdSchema = z.enum(COMPARE_VARIANTS);

/**
 * Runtime type guard for variant IDs.
 * Returns true only for the exact strings "A" and "B".
 */
export function isValidCompareVariantId(
  id: string | null | undefined,
): id is CompareVariantId {
  return id === COMPARE_VARIANT_A || id === COMPARE_VARIANT_B;
}

// ─── Compare Modes ─────────────────────────────────────────────────────────

export const COMPARE_MODES = ["side-by-side", "single"] as const;

export type CompareMode = (typeof COMPARE_MODES)[number];

export const CompareModeSchema = z.enum(COMPARE_MODES);

// ─── Protocol Version ──────────────────────────────────────────────────────

export const COMPARE_PROTOCOL_VERSION = 1;

// ─── Transport-safe config snapshot ───────────────────────────────────────
// This is a strict subset of GroupQualitySettings containing only the fields
// safe for transport over the group-control channel. No secrets (passwords,
// tokens, media credentials) are included.

export interface CompareConfigSnapshot {
  resolutionWidth: number;
  resolutionHeight: number;
  fps: number;
  videoBitrateKbps: number;
  sourceKind: string;
  sourceName: string;
}

export const CompareConfigSnapshotSchema: z.ZodType<CompareConfigSnapshot> =
  z.object({
    resolutionWidth: z.number().int().positive(),
    resolutionHeight: z.number().int().positive(),
    fps: z.number().int().positive(),
    videoBitrateKbps: z.number().int().nonnegative(),
    sourceKind: z.string().min(1),
    sourceName: z.string().min(1),
  }).strict();

export type CompareConfigSnapshotParsed = z.infer<
  typeof CompareConfigSnapshotSchema
>;

/**
 * Create a default CompareConfigSnapshot with sensible defaults.
 * Returns a fresh object each call (safe to mutate).
 */
export function createDefaultCompareConfigSnapshot(): CompareConfigSnapshot {
  return {
    resolutionWidth: 854,
    resolutionHeight: 480,
    fps: 15,
    videoBitrateKbps: 650,
    sourceKind: "screen",
    sourceName: "Screen",
  };
}

// ─── Variant Descriptor ────────────────────────────────────────────────────
// Used in stream.started compare metadata to describe each variant's session
// and configuration.

export interface VariantDescriptor {
  mediaSessionId?: string;
  configSnapshot?: CompareConfigSnapshot;
}

export const VariantDescriptorSchema: z.ZodType<VariantDescriptor> = z.object({
  mediaSessionId: z.string().optional(),
  configSnapshot: CompareConfigSnapshotSchema.optional(),
}).strict();
