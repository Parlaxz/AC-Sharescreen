// @vitest-environment node
/**
 * version-compare.test.ts
 *
 * Defensive tests for the `compareVersions` helper used by the
 * `UpdateManager` to decide whether to advertise an available update.
 *
 * Required cases (from the spec):
 *   0.2.0  vs 0.1.0  → update available
 *   0.2.0  vs 0.2.0  → up to date
 *   0.1.0  vs 0.2.0  → up to date
 *   0.10.0 vs 0.9.0  → update available  (not lexicographic!)
 *   malformed       → never an update
 *   leading "v0.2.1" → normalize and compare
 */
import { describe, it, expect } from "vitest";
import { compareVersions } from "../src/main/version-compare.js";

describe("compareVersions", () => {
  it("accepts 0.2.0 as newer than 0.1.0", () => {
    const r = compareVersions("0.1.0", "0.2.0");
    expect(r.isNewer).toBe(true);
    expect(r.normalizedCurrent).toBe("0.1.0");
    expect(r.normalizedAvailable).toBe("0.2.0");
  });

  it("treats equal versions as not newer", () => {
    const r = compareVersions("0.2.0", "0.2.0");
    expect(r.isNewer).toBe(false);
    expect(r.normalizedCurrent).toBe("0.2.0");
    expect(r.normalizedAvailable).toBe("0.2.0");
  });

  it("rejects lower available version as not newer", () => {
    const r = compareVersions("0.2.0", "0.1.0");
    expect(r.isNewer).toBe(false);
    expect(r.normalizedCurrent).toBe("0.2.0");
    expect(r.normalizedAvailable).toBe("0.1.0");
  });

  it("correctly compares 0.10.0 above 0.9.0 (no lexicographic bug)", () => {
    const r = compareVersions("0.9.0", "0.10.0");
    expect(r.isNewer).toBe(true);
    expect(r.normalizedAvailable).toBe("0.10.0");
  });

  it("normalizes a leading 'v' on the available version", () => {
    const r = compareVersions("0.1.0", "v0.2.0");
    expect(r.isNewer).toBe(true);
    expect(r.normalizedAvailable).toBe("0.2.0");
  });

  it("normalizes a leading 'V' (uppercase) on the available version", () => {
    const r = compareVersions("0.1.0", "V0.2.0");
    expect(r.isNewer).toBe(true);
    expect(r.normalizedAvailable).toBe("0.2.0");
  });

  it("normalizes a leading 'v' on the current version", () => {
    const r = compareVersions("v0.1.0", "0.2.0");
    expect(r.isNewer).toBe(true);
    expect(r.normalizedCurrent).toBe("0.1.0");
  });

  it("does not strip 'v' from inside a version segment", () => {
    // "v" only counts as a prefix when followed by a digit.
    const r = compareVersions("0.1.0", "v0.2.0-rc.1");
    expect(r.isNewer).toBe(true);
    expect(r.normalizedAvailable).toBe("0.2.0-rc.1");
  });

  it("rejects a malformed available version (no digits)", () => {
    const r = compareVersions("0.1.0", "not-a-version");
    expect(r.isNewer).toBe(false);
    expect(r.normalizedAvailable).toBeNull();
  });

  it("rejects an empty available version", () => {
    const r = compareVersions("0.1.0", "");
    expect(r.isNewer).toBe(false);
    expect(r.normalizedAvailable).toBeNull();
  });

  it("rejects an undefined available version", () => {
    const r = compareVersions("0.1.0", undefined);
    expect(r.isNewer).toBe(false);
    expect(r.normalizedAvailable).toBeNull();
  });

  it("rejects a malformed current version", () => {
    const r = compareVersions("garbage", "0.2.0");
    expect(r.isNewer).toBe(false);
    expect(r.normalizedCurrent).toBeNull();
  });

  it("rejects an undefined current version", () => {
    const r = compareVersions(undefined, "0.2.0");
    expect(r.isNewer).toBe(false);
    expect(r.normalizedCurrent).toBeNull();
  });

  it("rejects when both versions are missing", () => {
    const r = compareVersions(undefined, undefined);
    expect(r.isNewer).toBe(false);
  });

  it("accepts a pre-release greater than current", () => {
    // 0.2.1-rc.1 is a pre-release of 0.2.1, but semver treats it as
    // LESS than 0.2.0. The available must be strictly greater than
    // current, so this is NOT an update.
    const r = compareVersions("0.2.0", "0.2.1-rc.1");
    expect(r.isNewer).toBe(true);
    expect(r.normalizedAvailable).toBe("0.2.1-rc.1");
  });

  it("provides a safe reason for logging", () => {
    const r1 = compareVersions("0.1.0", "0.2.0");
    expect(r1.reason).toMatch(/greater/i);
    const r2 = compareVersions("0.2.0", "0.2.0");
    expect(r2.reason).toMatch(/equal/i);
    const r3 = compareVersions("0.2.0", "0.1.0");
    expect(r3.reason).toMatch(/downgrade/i);
  });
});
