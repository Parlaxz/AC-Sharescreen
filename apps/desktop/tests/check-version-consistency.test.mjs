// @vitest-environment node
/**
 * check-version-consistency.test.mjs
 *
 * Proves that the version-consistency script:
 *  - exits 0 when root and desktop versions match
 *  - exits 1 when they diverge
 *  - exits 1 when either is missing/malformed
 *  - accepts only valid semver values
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../../scripts/check-version-consistency.mjs");

function runWithVersions(rootVersion, desktopVersion) {
  // Create temp fixture with the layout the script expects
  const tmp = mkdtempSync(path.join(tmpdir(), "sl-vc-"));
  mkdirSync(path.join(tmp, "apps", "desktop"), { recursive: true });

  if (rootVersion !== null) {
    const rootPkg = { name: "screenlink", version: rootVersion };
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify(rootPkg, null, "\t") + "\n");
  } else {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "screenlink" }, null, "\t") + "\n");
  }

  if (desktopVersion !== null) {
    const desktopPkg = { name: "@screenlink/desktop", version: desktopVersion };
    writeFileSync(path.join(tmp, "apps", "desktop", "package.json"), JSON.stringify(desktopPkg, null, "  ") + "\n");
  } else {
    writeFileSync(path.join(tmp, "apps", "desktop", "package.json"), JSON.stringify({ name: "@screenlink/desktop" }, null, "  ") + "\n");
  }

  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: tmp,
      env: { ...process.env, SCREENLINK_ROOT: tmp },
      stdio: "pipe",
      encoding: "utf-8",
    });
    return { code: 0, stdout: out, stderr: "" };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : "",
      stderr: err.stderr ? err.stderr.toString() : "",
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("check-version-consistency.mjs", () => {
  it("passes when root and desktop versions match", () => {
    const r = runWithVersions("0.2.0", "0.2.0");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("0.2.0");
  });

  it("fails when root and desktop versions diverge", () => {
    const r = runWithVersions("0.1.0", "0.2.0");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/does not match/i);
  });

  it("fails when root version is missing", () => {
    const r = runWithVersions(null, "0.2.0");
    expect(r.code).toBe(1);
  });

  it("fails when desktop version is missing", () => {
    const r = runWithVersions("0.2.0", null);
    expect(r.code).toBe(1);
  });

  it("fails when versions are malformed (non-semver)", () => {
    const r = runWithVersions("garbage", "0.2.0");
    expect(r.code).toBe(1);
  });

  it("accepts multi-digit semver values", () => {
    const r = runWithVersions("10.20.30", "10.20.30");
    expect(r.code).toBe(0);
  });
});

describe("check-version-consistency.mjs — real repository state", () => {
  it("passes against the real root and desktop package.json files", () => {
    const rootPkgPath = path.resolve(__dirname, "../../../package.json");
    const desktopPkgPath = path.resolve(__dirname, "../package.json");
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8"));
    const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, "utf-8"));
    expect(rootPkg.version).toBe(desktopPkg.version);
    expect(rootPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
