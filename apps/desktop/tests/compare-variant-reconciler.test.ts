// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyChange,
  CompareVariantReconciler,
  type ReconcileRequest,
} from "../src/renderer/services/compare-variant-reconciler.js";
import type { CompareSessionManager, VariantStartConfig } from "../src/renderer/services/compare-session-manager.js";
import type { CompareVariantId } from "@screenlink/shared";

// ─── Mock CSM ───────────────────────────────────────────────────────────────

interface MockPublisher {
  applyVideoSenderSettings: ReturnType<typeof vi.fn>;
}

function createMockPublisherManager(): MockPublisher {
  return {
    applyVideoSenderSettings: vi.fn().mockResolvedValue({
      results: [],
      overall: "all-succeeded" as const,
    }),
  };
}

interface MockCSMState {
  configs: Record<string, VariantStartConfig>;
  publishers: Record<string, MockPublisher>;
}

function makeCSMState(): MockCSMState {
  return {
    configs: {
      A: { targetWidth: 1920, targetHeight: 1080, targetFps: 30, videoBitrateKbps: 2000, codec: "vp9" },
      B: { targetWidth: 854, targetHeight: 480, targetFps: 15, videoBitrateKbps: 650, codec: "vp9" },
    },
    publishers: {
      A: createMockPublisherManager(),
      B: createMockPublisherManager(),
    },
  };
}

function createMockCSM(state: MockCSMState, overrides: Record<string, unknown> = {}): CompareSessionManager {
  return {
    isActive: vi.fn().mockReturnValue(true),
    getVariantConfig: vi.fn((vid: CompareVariantId) => state.configs[vid] ?? null),
    getVariantConfigs: vi.fn(() => ({ ...state.configs })),
    updateVariantConfig: vi.fn((vid: CompareVariantId, cfg: Partial<VariantStartConfig>) => {
      if (state.configs[vid]) {
        state.configs[vid] = { ...state.configs[vid], ...cfg };
      }
    }),
    getVariantPublication: vi.fn((vid: CompareVariantId) => {
      const pm = state.publishers[vid];
      if (!pm) return null;
      return {
        variantId: vid,
        mediaSessionId: `ms-${vid}`,
        logicalStreamId: "logical-1",
        publisherManager: pm,
        vdoConfig: { streamId: `vdo-${vid}`, password: "secret" },
      };
    }),
    rebuildVariant: vi.fn().mockResolvedValue(undefined),
    getVariantMediaSessionId: vi.fn((vid: CompareVariantId) => `ms-${vid}`),
    currentGroupId: "group-1",
    currentLogicalStreamId: "logical-1",
    broadcastToGroup: vi.fn().mockResolvedValue(undefined),
    state: "active",
    ...overrides,
  } as unknown as CompareSessionManager;
}

// ─── Classification Tests ───────────────────────────────────────────────────

describe("classifyChange", () => {
  it("classifies targetWidth as output-track", () => {
    const result = classifyChange("A", "targetWidth", 1920, 1280);
    expect(result.classification).toBe("output-track");
    expect(result.field).toBe("targetWidth");
    expect(result.variantId).toBe("A");
  });

  it("classifies targetHeight as output-track", () => {
    const result = classifyChange("B", "targetHeight", 1080, 720);
    expect(result.classification).toBe("output-track");
  });

  it("classifies targetFps as output-track", () => {
    const result = classifyChange("A", "targetFps", 30, 60);
    expect(result.classification).toBe("output-track");
  });

  it("classifies videoBitrateKbps as sender-parameter", () => {
    const result = classifyChange("A", "videoBitrateKbps", 2000, 4000);
    expect(result.classification).toBe("sender-parameter");
  });

  it("classifies codec as sender-parameter", () => {
    const result = classifyChange("B", "codec", "vp9", "h264");
    expect(result.classification).toBe("sender-parameter");
  });

  it("classifies unknown fields as none", () => {
    const result = classifyChange("A", "unknownField", null, "value");
    expect(result.classification).toBe("none");
  });

  it("preserves from/to values in the result", () => {
    const result = classifyChange("A", "videoBitrateKbps", 1000, 2000);
    expect(result.from).toBe(1000);
    expect(result.to).toBe(2000);
  });

  it("classifies all three output-track fields", () => {
    for (const field of ["targetWidth", "targetHeight", "targetFps"]) {
      const result = classifyChange("A", field, undefined, 123);
      expect(result.classification).toBe("output-track");
    }
  });
});

// ─── Reconciler Tests ───────────────────────────────────────────────────────

describe("CompareVariantReconciler", () => {
  let state: MockCSMState;
  let csm: CompareSessionManager;
  let reconciler: CompareVariantReconciler;

  beforeEach(() => {
    state = makeCSMState();
    csm = createMockCSM(state);
    reconciler = new CompareVariantReconciler(csm);
  });

  describe("canReconcile", () => {
    it("returns true when CSM is active and both variants have configs", () => {
      const request: ReconcileRequest = {
        variantA: { videoBitrateKbps: 3000 },
      };
      expect(reconciler.canReconcile(request)).toBe(true);
    });

    it("returns false when CSM is not active", () => {
      const s = makeCSMState();
      const inactiveCSM = createMockCSM(s, { isActive: vi.fn().mockReturnValue(false) });
      const r = new CompareVariantReconciler(inactiveCSM);
      expect(r.canReconcile({ variantA: { videoBitrateKbps: 3000 } })).toBe(false);
    });

    it("returns false when request has no changes", () => {
      expect(reconciler.canReconcile({})).toBe(false);
    });

    it("returns false when a variant has no config", () => {
      const s = makeCSMState();
      s.configs.A = undefined as unknown as VariantStartConfig;
      const emptyCSM = createMockCSM(s);
      const r = new CompareVariantReconciler(emptyCSM);
      expect(r.canReconcile({ variantA: { videoBitrateKbps: 3000 } })).toBe(false);
    });
  });

  describe("reconcile", () => {
    it("rejects when not reconcilable (returns applied=false)", async () => {
      const s = makeCSMState();
      const inactiveCSM = createMockCSM(s, { isActive: vi.fn().mockReturnValue(false) });
      const r = new CompareVariantReconciler(inactiveCSM);
      const result = await r.reconcile({ variantA: { videoBitrateKbps: 3000 } });
      expect(result.applied).toBe(false);
      expect(result.inFlight).toBe(false);
    });

    it("rejects with inFlight=true when previous reconcile is still in-flight", async () => {
      // First call: start a reconcile that doesn't resolve immediately
      const s = makeCSMState();
      const slowCSM = createMockCSM(s, {
        rebuildVariant: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
      });
      const r = new CompareVariantReconciler(slowCSM);

      // Start first reconcile (don't await)
      const firstPromise = r.reconcile({
        variantA: { targetWidth: 640, targetHeight: 360 },
      });

      // Second reconcile should see in-flight
      const result = await r.reconcile({
        variantA: { videoBitrateKbps: 3000 },
      });
      expect(result.applied).toBe(false);
      expect(result.inFlight).toBe(true);

      // Cleanup
      (slowCSM as any).rebuildVariant.mockReset();
    });

    it("succeeds for sender-parameter changes (bitrate)", async () => {
      const result = await reconciler.reconcile({
        variantA: { videoBitrateKbps: 3000 },
      });
      expect(result.applied).toBe(true);
      expect(result.inFlight).toBe(false);
      expect(result.variantA.changed).toBe(true);
      expect(result.variantA.actions).toContain("sender-parameter");

      // Should have called applyVideoSenderSettings on the shared publisher mock
      expect(state.publishers.A.applyVideoSenderSettings).toHaveBeenCalledWith({
        maxBitrate: 3000,
        maxFramerate: 30,
      });
    });

    it("calls rebuildVariant for output-track changes", async () => {
      const result = await reconciler.reconcile({
        variantA: { targetWidth: 640, targetHeight: 360 },
      });
      expect(result.applied).toBe(true);
      expect(result.variantA.actions).toContain("output-track");
      expect(csm.rebuildVariant).toHaveBeenCalledWith("A", {
        targetWidth: 640,
        targetHeight: 360,
      });
    });

    it("handles both variants independently", async () => {
      const result = await reconciler.reconcile({
        variantA: { videoBitrateKbps: 4000 },
        variantB: { targetFps: 30 },
      });
      expect(result.applied).toBe(true);
      expect(result.variantA.changed).toBe(true);
      expect(result.variantB.changed).toBe(true);
      expect(result.variantA.actions).toContain("sender-parameter");
      expect(result.variantB.actions).toContain("output-track");
    });

    it("returns 'none' actions for unchanged no-op fields", async () => {
      const result = await reconciler.reconcile({
        variantA: { sourceName: "test" as unknown as undefined },
      });
      // sourceName is not a recognized field, so it classifies as "none"
      expect(result.variantA.changed).toBe(false);
      expect(result.variantA.actions).toEqual([]);
    });

    it("propagates errors from rebuildVariant", async () => {
      const s = makeCSMState();
      const errorCSM = createMockCSM(s, {
        rebuildVariant: vi.fn().mockRejectedValue(new Error("pipeline failure")),
      });
      const r = new CompareVariantReconciler(errorCSM);
      const result = await r.reconcile({
        variantA: { targetWidth: 640 },
      });
      expect(result.applied).toBe(false);
      expect(result.variantA.error).toMatch(/pipeline failure/);
    });

    it("updates stored config after successful reconcile", async () => {
      await reconciler.reconcile({
        variantA: { videoBitrateKbps: 5000 },
      });
      expect(csm.updateVariantConfig).toHaveBeenCalledWith("A", {
        videoBitrateKbps: 5000,
      });
    });

    it("broadcasts compare.variant.updated for changed variants", async () => {
      await reconciler.reconcile({
        variantA: { videoBitrateKbps: 3000 },
        variantB: { videoBitrateKbps: 1000 },
      });
      expect(csm.broadcastToGroup).toHaveBeenCalled();
      const callArg = (csm.broadcastToGroup as any).mock.calls[0][0];
      expect(callArg.type).toBe("compare.variant.updated");
    });
  });

  describe("getAppliedConfig", () => {
    it("returns variant config from CSM", () => {
      const cfg = reconciler.getAppliedConfig("A");
      expect(cfg).toEqual({
        targetWidth: 1920,
        targetHeight: 1080,
        targetFps: 30,
        videoBitrateKbps: 2000,
        codec: "vp9",
      });
    });

    it("returns null for non-existent variant", () => {
      const s = makeCSMState();
      s.configs.A = undefined as unknown as VariantStartConfig;
      const emptyCSM = createMockCSM(s);
      const r = new CompareVariantReconciler(emptyCSM);
      expect(r.getAppliedConfig("A")).toBeNull();
    });
  });
});
