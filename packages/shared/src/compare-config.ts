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

// ─── Viewer-Only Compare Wipe Mode ─────────────────────────────────────────

export const COMPARE_WIPE_MODES = ["vertical-wipe", "side-a", "side-b"] as const;

export type CompareWipeMode = (typeof COMPARE_WIPE_MODES)[number];

export const CompareWipeModeSchema = z.enum(COMPARE_WIPE_MODES);

// ─── Viewer Compare State ──────────────────────────────────────────────────

/**
 * Local viewer-only compare state.
 * The viewer maintains two sets of enhancement settings (A and B) and
 * toggles between them or shows a vertical wipe across the same video stream.
 * No host involvement, no protocol messages, one ViewerSession.
 */
export interface ViewerCompareState {
  /** Whether compare mode is currently active */
  active: boolean;
  /** Which wipe/presentation mode is active */
  wipeMode: CompareWipeMode;
  /** Position of the vertical divider (0–1, where 0.5 = center) */
  dividerPosition: number;
}

// ─── Persistence keys ──────────────────────────────────────────────────────

/** localStorage key for compare settings B (initialized from A on first use) */
export const COMPARE_SETTINGS_B_KEY = "screenlink:viewer-image-enhancement-b";

/** localStorage key for compare UI state */
export const COMPARE_UI_STATE_KEY = "screenlink:compare-ui-state";
