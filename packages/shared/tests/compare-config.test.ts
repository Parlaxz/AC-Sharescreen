import { describe, it, expect } from "vitest";
import {
  COMPARE_VARIANTS,
  COMPARE_VARIANT_A,
  COMPARE_VARIANT_B,
  COMPARE_WIPE_MODES,
  CompareVariantIdSchema,
  CompareWipeModeSchema,
  isValidCompareVariantId,
  COMPARE_SETTINGS_B_KEY,
  COMPARE_UI_STATE_KEY,
  type CompareVariantId,
  type CompareWipeMode,
  type ViewerCompareState,
} from "@screenlink/shared";

describe("CompareConfig — variant IDs", () => {
  it("exports exactly A and B as variants", () => {
    expect(COMPARE_VARIANTS).toEqual(["A", "B"]);
    expect(COMPARE_VARIANT_A).toBe("A");
    expect(COMPARE_VARIANT_B).toBe("B");
  });

  it("CompareVariantIdSchema accepts A and B", () => {
    expect(CompareVariantIdSchema.parse("A")).toBe("A");
    expect(CompareVariantIdSchema.parse("B")).toBe("B");
  });

  it("CompareVariantIdSchema rejects invalid variant IDs", () => {
    expect(() => CompareVariantIdSchema.parse("C")).toThrow();
    expect(() => CompareVariantIdSchema.parse("a")).toThrow();
    expect(() => CompareVariantIdSchema.parse("")).toThrow();
    expect(() => CompareVariantIdSchema.parse("AB")).toThrow();
    expect(() => CompareVariantIdSchema.parse(1)).toThrow();
    expect(() => CompareVariantIdSchema.parse(null)).toThrow();
  });

  it("isValidCompareVariantId returns true for A and B", () => {
    expect(isValidCompareVariantId("A")).toBe(true);
    expect(isValidCompareVariantId("B")).toBe(true);
  });

  it("isValidCompareVariantId returns false for anything else", () => {
    expect(isValidCompareVariantId("C")).toBe(false);
    expect(isValidCompareVariantId("a")).toBe(false);
    expect(isValidCompareVariantId("")).toBe(false);
    expect(isValidCompareVariantId(null as unknown as string)).toBe(false);
    expect(isValidCompareVariantId(undefined as unknown as string)).toBe(false);
  });
});

describe("CompareConfig — wipe modes (viewer-only)", () => {
  it("exports wipe modes", () => {
    expect(COMPARE_WIPE_MODES).toContain("vertical-wipe");
    expect(COMPARE_WIPE_MODES).toContain("side-a");
    expect(COMPARE_WIPE_MODES).toContain("side-b");
  });

  it("CompareWipeModeSchema accepts valid modes", () => {
    expect(CompareWipeModeSchema.parse("vertical-wipe")).toBe("vertical-wipe");
    expect(CompareWipeModeSchema.parse("side-a")).toBe("side-a");
    expect(CompareWipeModeSchema.parse("side-b")).toBe("side-b");
  });

  it("CompareWipeModeSchema rejects invalid modes", () => {
    expect(() => CompareWipeModeSchema.parse("side-by-side")).toThrow();
    expect(() => CompareWipeModeSchema.parse("split")).toThrow();
  });
});

describe("CompareConfig — persistence keys", () => {
  it("exports settings B persistence key", () => {
    expect(COMPARE_SETTINGS_B_KEY).toBe("screenlink:viewer-image-enhancement-b");
  });

  it("exports UI state persistence key", () => {
    expect(COMPARE_UI_STATE_KEY).toBe("screenlink:compare-ui-state");
  });
});

describe("CompareConfig — ViewerCompareState shape", () => {
  it("ViewerCompareState has required fields", () => {
    const state: ViewerCompareState = {
      active: true,
      wipeMode: "vertical-wipe",
      dividerPosition: 0.5,
    };
    expect(state.active).toBe(true);
    expect(state.wipeMode).toBe("vertical-wipe");
    expect(state.dividerPosition).toBe(0.5);
  });

  it("dividerPosition ranges 0-1", () => {
    const valid: ViewerCompareState = {
      active: true,
      wipeMode: "vertical-wipe",
      dividerPosition: 0,
    };
    expect(valid.dividerPosition).toBe(0);
    valid.dividerPosition = 1;
    expect(valid.dividerPosition).toBe(1);
  });

  it("supports all wipe modes", () => {
    const sideA: ViewerCompareState = {
      active: true, wipeMode: "side-a", dividerPosition: 1,
    };
    const sideB: ViewerCompareState = {
      active: true, wipeMode: "side-b", dividerPosition: 0,
    };
    expect(sideA.wipeMode).toBe("side-a");
    expect(sideB.wipeMode).toBe("side-b");
  });

  it("inactive state does not require valid dividerPosition", () => {
    const inactive: ViewerCompareState = {
      active: false,
      wipeMode: "vertical-wipe",
      dividerPosition: 0.5,
    };
    // inactive compare means the divider is irrelevant
    expect(inactive.active).toBe(false);
  });
});
