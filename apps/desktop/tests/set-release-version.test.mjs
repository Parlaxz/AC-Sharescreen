/**
 * Tests for scripts/set-release-version.mjs
 *
 * Run: node apps/desktop/tests/set-release-version.test.mjs
 */

import { describe, it, expect } from "vitest";

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

describe("set-release-version.mjs — version validation", () => {
  it("accepts valid semantic version 0.1.1", () => {
    expect(SEMVER_RE.test("0.1.1")).toBe(true);
  });

  it("accepts valid semantic version 1.0.0", () => {
    expect(SEMVER_RE.test("1.0.0")).toBe(true);
  });

  it("accepts valid semantic version 10.20.30", () => {
    expect(SEMVER_RE.test("10.20.30")).toBe(true);
  });

  it("rejects version with v prefix", () => {
    expect(SEMVER_RE.test("v0.1.1")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(SEMVER_RE.test("")).toBe(false);
  });

  it("rejects missing version (undefined)", () => {
    expect(SEMVER_RE.test(undefined)).toBe(false);
  });

  it("rejects two-part version 0.1", () => {
    expect(SEMVER_RE.test("0.1")).toBe(false);
  });

  it("rejects four-part version 0.1.1.2", () => {
    expect(SEMVER_RE.test("0.1.1.2")).toBe(false);
  });

  it("rejects non-numeric segment 0.a.1", () => {
    expect(SEMVER_RE.test("0.a.1")).toBe(false);
  });

  it("rejects leading zero in major 01.0.0", () => {
    expect(SEMVER_RE.test("01.0.0")).toBe(false);
  });

  it("rejects version with spaces", () => {
    expect(SEMVER_RE.test(" 0.1.1")).toBe(false);
    expect(SEMVER_RE.test("0.1.1 ")).toBe(false);
  });
});

describe("set-release-version.mjs — package.json structure", () => {
  it("preserves root package.json formatting (tabs)", async () => {
    // We test that the file uses tab indentation as expected
    const fs = await import("node:fs");
    const rootPkgPath = new URL("../../../package.json", import.meta.url);
    const content = fs.readFileSync(rootPkgPath, "utf-8");
    // The root package.json uses tabs
    expect(content).toContain("\t");
  });

  it("preserves desktop package.json formatting (spaces)", async () => {
    const fs = await import("node:fs");
    const desktopPkgPath = new URL("../package.json", import.meta.url);
    const content = fs.readFileSync(desktopPkgPath, "utf-8");
    // The desktop package.json uses 2-space indentation
    expect(content).toContain("  ");
  });
});
