import { describe, it, expect } from "vitest";
import {
  COMPARE_VARIANTS,
  COMPARE_VARIANT_A,
  COMPARE_VARIANT_B,
  COMPARE_MODES,
  COMPARE_PROTOCOL_VERSION,
  CompareVariantIdSchema,
  CompareModeSchema,
  CompareConfigSnapshotSchema,
  isValidCompareVariantId,
  createDefaultCompareConfigSnapshot,
  type CompareVariantId,
  type CompareMode,
  type CompareConfigSnapshot,
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

describe("CompareConfig — modes and version", () => {
  it("exports compare modes", () => {
    expect(COMPARE_MODES).toContain("side-by-side");
    expect(COMPARE_MODES).toContain("single");
  });

  it("CompareModeSchema accepts valid modes", () => {
    expect(CompareModeSchema.parse("side-by-side")).toBe("side-by-side");
    expect(CompareModeSchema.parse("single")).toBe("single");
  });

  it("CompareModeSchema rejects invalid modes", () => {
    expect(() => CompareModeSchema.parse("split")).toThrow();
  });

  it("exports protocol version", () => {
    expect(COMPARE_PROTOCOL_VERSION).toBe(1);
  });
});

describe("CompareConfig — config snapshot schema", () => {
  const validConfig: CompareConfigSnapshot = {
    resolutionWidth: 1920,
    resolutionHeight: 1080,
    fps: 30,
    videoBitrateKbps: 5000,
    sourceKind: "screen",
    sourceName: "Display 1",
  };

  it("accepts a valid config snapshot", () => {
    const result = CompareConfigSnapshotSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("rejects negative resolutionWidth", () => {
    const result = CompareConfigSnapshotSchema.safeParse({
      ...validConfig,
      resolutionWidth: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = CompareConfigSnapshotSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = CompareConfigSnapshotSchema.safeParse({
      ...validConfig,
      secretToken: "should-not-be-here",
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero fps", () => {
    const result = CompareConfigSnapshotSchema.safeParse({
      ...validConfig,
      fps: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative videoBitrateKbps", () => {
    const result = CompareConfigSnapshotSchema.safeParse({
      ...validConfig,
      videoBitrateKbps: -100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer resolution values", () => {
    const result = CompareConfigSnapshotSchema.safeParse({
      ...validConfig,
      resolutionWidth: 1920.5,
    });
    expect(result.success).toBe(false);
  });

  it("config snapshot contains no secrets shape", () => {
    // Verify the schema only allows fields that are safe for transport
    const allowedFields = new Set(Object.keys(CompareConfigSnapshotSchema.shape));
    expect(allowedFields.has("password")).toBe(false);
    expect(allowedFields.has("token")).toBe(false);
    expect(allowedFields.has("mediaJoinMetadata")).toBe(false);
    expect(allowedFields.has("streamId")).toBe(false);
    expect(allowedFields.has("bindingToken")).toBe(false);
  });
});

describe("CompareConfig — defaults", () => {
  it("createDefaultCompareConfigSnapshot returns a valid snapshot", () => {
    const config = createDefaultCompareConfigSnapshot();
    const result = CompareConfigSnapshotSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("default config has reasonable values", () => {
    const config = createDefaultCompareConfigSnapshot();
    expect(config.fps).toBeGreaterThan(0);
    expect(config.resolutionWidth).toBeGreaterThan(0);
    expect(config.videoBitrateKbps).toBeGreaterThan(0);
    expect(config.sourceKind).toBeTruthy();
    expect(config.sourceName).toBeTruthy();
  });

  it("multiple calls return independent copies", () => {
    const a = createDefaultCompareConfigSnapshot();
    const b = createDefaultCompareConfigSnapshot();
    expect(a).toEqual(b);
    a.resolutionWidth = 999;
    expect(b.resolutionWidth).not.toBe(999);
  });
});
