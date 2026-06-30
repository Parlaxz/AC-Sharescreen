/**
 * CompareVariantReconciler — live per-variant reconciler for Easy Compare.
 *
 * Given a settings change (resolution, FPS, bitrate, codec), classifies the
 * change and dispatches the appropriate apply action (pipeline rebuild,
 * sender-parameter update, or no-op) with a single-in-flight guarantee.
 *
 * Owns no mutable state beyond the in-flight flag; the authoritative config
 * and publisher state live in CompareSessionManager.
 */

import type { CompareSessionManager, VariantStartConfig } from "./compare-session-manager.js";
import type { CompareVariantId } from "@screenlink/shared";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Classification of a single setting change.
 * - "viewer-only": Affects viewers only (e.g. quality cap), no sender change.
 * - "sender-parameter": Affects RTCRtpSender parameters (bitrate, codec).
 * - "output-track": Requires pipeline reinit (resolution, FPS change).
 * - "none": No effective change.
 */
export type ChangeClass =
  | "viewer-only"
  | "sender-parameter"
  | "output-track"
  | "none";

export interface ClassifiedChange {
  variantId: CompareVariantId;
  field: string;
  from: unknown;
  to: unknown;
  classification: ChangeClass;
}

/**
 * Partial config changes to reconcile. Only specified fields are applied;
 * unspecified fields retain their current values.
 */
export interface ReconcileRequest {
  variantA?: Partial<VariantStartConfig>;
  variantB?: Partial<VariantStartConfig>;
}

/**
 * Result of a reconcile attempt.
 * - `variantA` / `variantB`: per-variant outcome (whether anything changed,
 *   which action classes were taken, and any error).
 * - `applied`: false if the request was rejected (in-flight, inactive).
 * - `inFlight`: true while a previous reconcile is still applying.
 */
export interface VariantReconcileOutcome {
  changed: boolean;
  actions: ChangeClass[];
  error?: string;
}

export interface ReconcileResult {
  variantA: VariantReconcileOutcome;
  variantB: VariantReconcileOutcome;
  applied: boolean;
  inFlight: boolean;
}

// ─── Classifier ─────────────────────────────────────────────────────────────

/**
 * Classify a single field change into a ChangeClass.
 *
 * Classification rules:
 * - `targetWidth` / `targetHeight` / `targetFps` → "output-track"
 *   (pipeline reinit needed; resolution/FPS changes require a new canvas pipeline).
 * - `videoBitrateKbps` → "sender-parameter"
 *   (RTCRtpSender encoding parameters; hot-swappable without pipeline rebuild).
 * - `codec` → "sender-parameter"
 *   (codec preference; ideally hot-swappable via sender renegotiation;
 *    falls back to a publisher restart if sender-parameter apply is insufficient).
 * - All other fields → "none"
 */
export function classifyChange(
  variantId: CompareVariantId,
  field: string,
  from: unknown,
  to: unknown,
): ClassifiedChange {
  const OUTPUT_TRACK_FIELDS = new Set(["targetWidth", "targetHeight", "targetFps"]);
  const SENDER_PARAMETER_FIELDS = new Set(["videoBitrateKbps", "codec"]);

  let classification: ChangeClass;
  if (OUTPUT_TRACK_FIELDS.has(field)) {
    classification = "output-track";
  } else if (SENDER_PARAMETER_FIELDS.has(field)) {
    classification = "sender-parameter";
  } else {
    classification = "none";
  }

  return { variantId, field, from, to, classification };
}

// ─── Reconciler ─────────────────────────────────────────────────────────────

export class CompareVariantReconciler {
  private csm: CompareSessionManager;
  private _inFlight = false;

  constructor(csm: CompareSessionManager) {
    this.csm = csm;
  }

  /**
   * Returns true if ALL changes for both variants can be applied.
   * Checks:
   * - CompareSessionManager is active (both variants running)
   * - Both variant publishers exist and are in "sharing" state
   * - At least one variant has changes in the request
   */
  canReconcile(request: ReconcileRequest): boolean {
    if (!this.csm.isActive()) return false;

    // Must have at least some changes
    if (!request.variantA && !request.variantB) return false;

    // Both variants must have existing configs
    for (const vid of ["A", "B"] as const) {
      const cfg = this.csm.getVariantConfig(vid);
      if (!cfg) return false;
    }

    return true;
  }

  /**
   * Reconcile settings changes across one or both variants.
   *
   * Single-in-flight: if a previous reconcile is still applying, returns
   * immediately with `{ applied: false, inFlight: true }`.
   *
   * Apply logic per change class:
   * - "output-track": calls `csm.rebuildVariant()` (full pipeline + track swap).
   * - "sender-parameter": calls the variant's `PublisherManager.applyVideoSenderSettings()`.
   * - "viewer-only": no-op (handled by VDO from config metadata).
   *
   * After apply, updates stored configs and broadcasts `compare.variant.updated`.
   */
  async reconcile(request: ReconcileRequest): Promise<ReconcileResult> {
    // ── Pre-checks ───────────────────────────────────────────────────
    if (!this.canReconcile(request)) {
      return {
        variantA: { changed: false, actions: [] },
        variantB: { changed: false, actions: [] },
        applied: false,
        inFlight: false,
      };
    }

    if (this._inFlight) {
      return {
        variantA: { changed: false, actions: [] },
        variantB: { changed: false, actions: [] },
        applied: false,
        inFlight: true,
      };
    }

    this._inFlight = true;

    try {
      // ── Classify all changes per variant ─────────────────────────
      const classifiedA: ClassifiedChange[] = [];
      const classifiedB: ClassifiedChange[] = [];

      if (request.variantA) {
        const existing = this.csm.getVariantConfig("A");
        for (const [field, value] of Object.entries(request.variantA)) {
          const from = existing ? (existing as Record<string, unknown>)[field] : undefined;
          classifiedA.push(classifyChange("A", field, from, value));
        }
      }

      if (request.variantB) {
        const existing = this.csm.getVariantConfig("B");
        for (const [field, value] of Object.entries(request.variantB)) {
          const from = existing ? (existing as Record<string, unknown>)[field] : undefined;
          classifiedB.push(classifyChange("B", field, from, value));
        }
      }

      // ── Collect unique action classes per variant ────────────────
      const actionsA = new Set<ChangeClass>();
      const actionsB = new Set<ChangeClass>();
      for (const c of classifiedA) actionsA.add(c.classification);
      for (const c of classifiedB) actionsB.add(c.classification);

      const changedA = classifiedA.some((c) => c.classification !== "none");
      const changedB = classifiedB.some((c) => c.classification !== "none");

      // ── Apply changes ────────────────────────────────────────────
      const errors: string[] = [];

      // Output-track changes: rebuild pipeline + track swap
      if (actionsA.has("output-track") && request.variantA) {
        try {
          await this.csm.rebuildVariant("A", request.variantA);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`variantA: ${msg}`);
        }
      }

      if (actionsB.has("output-track") && request.variantB) {
        try {
          await this.csm.rebuildVariant("B", request.variantB);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`variantB: ${msg}`);
        }
      }

      // Sender-parameter changes: apply video sender settings
      if (actionsA.has("sender-parameter") && request.variantA) {
        try {
          const pm = this.getVariantPublisher("A");
          const currentConfig = this.csm.getVariantConfig("A");
          if (pm && currentConfig) {
            const bitrate = request.variantA.videoBitrateKbps ?? currentConfig.videoBitrateKbps;
            await pm.applyVideoSenderSettings({
              maxBitrate: bitrate,
              maxFramerate: request.variantA.targetFps ?? currentConfig.targetFps,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`variantA sender: ${msg}`);
        }
      }

      if (actionsB.has("sender-parameter") && request.variantB) {
        try {
          const pm = this.getVariantPublisher("B");
          const currentConfig = this.csm.getVariantConfig("B");
          if (pm && currentConfig) {
            const bitrate = request.variantB.videoBitrateKbps ?? currentConfig.videoBitrateKbps;
            await pm.applyVideoSenderSettings({
              maxBitrate: bitrate,
              maxFramerate: request.variantB.targetFps ?? currentConfig.targetFps,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`variantB sender: ${msg}`);
        }
      }

      // ── Update stored configs ────────────────────────────────────
      if (request.variantA) {
        this.csm.updateVariantConfig("A", request.variantA);
      }
      if (request.variantB) {
        this.csm.updateVariantConfig("B", request.variantB);
      }

      // ── Broadcast compare.variant.updated ────────────────────────
      await this.broadcastVariantUpdates(request);

      // ── Build result ─────────────────────────────────────────────
      const result: ReconcileResult = {
        variantA: {
          changed: changedA,
          actions: Array.from(actionsA).filter((a) => a !== "none"),
          error: errors.find((e) => e.startsWith("variantA")) ?? undefined,
        },
        variantB: {
          changed: changedB,
          actions: Array.from(actionsB).filter((a) => a !== "none"),
          error: errors.find((e) => e.startsWith("variantB")) ?? undefined,
        },
        applied: errors.length === 0,
        inFlight: false,
      };

      return result;
    } finally {
      this._inFlight = false;
    }
  }

  /**
   * Get the latest applied config for a variant.
   */
  getAppliedConfig(variantId: CompareVariantId): VariantStartConfig | null {
    return this.csm.getVariantConfig(variantId);
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Get the PublisherManager for a variant through the CSM's variant
   * publication lookup (requires active session).
   */
  private getVariantPublisher(variantId: CompareVariantId) {
    const pub = this.csm.getVariantPublication(variantId);
    return pub?.publisherManager ?? null;
  }

  /**
   * Broadcast `compare.variant.updated` for each variant that had changes.
   * Uses the CSM's broadcastToGroup helper.
   */
  private async broadcastVariantUpdates(request: ReconcileRequest): Promise<void> {
    const logicalStreamId = this.csm.currentLogicalStreamId;
    if (!logicalStreamId) return;

    const now = Date.now();

    const broadcastForVariant = async (
      variantId: CompareVariantId,
      config: VariantStartConfig,
      revision: number,
    ) => {
      const msId = this.csm.getVariantMediaSessionId(variantId);
      if (!msId) return;

      await this.csm.broadcastToGroup({
        type: "compare.variant.updated",
        logicalStreamId,
        mediaSessionId: msId,
        variantId,
        revision,
        configSnapshot: {
          resolutionWidth: config.targetWidth,
          resolutionHeight: config.targetHeight,
          fps: config.targetFps,
          videoBitrateKbps: config.videoBitrateKbps,
          sourceKind: "screen",
          sourceName: "",
        },
        appliedAt: now,
        status: "active",
      });
    };

    if (request.variantA) {
      const cfgA = this.csm.getVariantConfig("A");
      if (cfgA) {
        await broadcastForVariant("A", cfgA, 1);
      }
    }

    if (request.variantB) {
      const cfgB = this.csm.getVariantConfig("B");
      if (cfgB) {
        await broadcastForVariant("B", cfgB, 1);
      }
    }
  }
}
