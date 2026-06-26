// @vitest-environment node
/**
 * no-fake-update-strings.test.mjs
 *
 * Guards against the bug this fix was created to eliminate: fake
 * placeholder strings inside the renderer or main code that would
 * pretend an update is available.
 *
 * Search the entire repository (excluding build artifacts, node_modules,
 * and test files themselves) for any of the known fake placeholders.
 * None of them may remain in source files.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const FORBIDDEN_STRINGS = [
  "1.1.0",                              // fake version
  "Improved WebRTC",                    // fake release note fragment
  "New system audio pipeline",          // fake release note fragment
  "Performance improvements for 4K",    // fake release note fragment
  "Download & install",                 // fake button label
];

const SCAN_DIRS = ["apps", "packages", "scripts"];
const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  ".vite",
  "build",
  "release",
  "coverage",
  ".git",
  "tests",
]);
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
]);

function walk(dir) {
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry)) continue;
        stack.push(full);
      } else if (stat.isFile()) {
        const ext = path.extname(entry);
        if (SOURCE_EXTENSIONS.has(ext)) {
          results.push(full);
        }
      }
    }
  }
  return results;
}

describe("no fake update strings remain in the repository", () => {
  for (const forbidden of FORBIDDEN_STRINGS) {
    it(`does not contain "${forbidden}" in any non-test source file`, () => {
      const offenders = [];
      for (const dir of SCAN_DIRS) {
        const full = path.join(REPO_ROOT, dir);
        for (const file of walk(full)) {
          const text = readFileSync(file, "utf-8");
          if (text.includes(forbidden)) {
            offenders.push(path.relative(REPO_ROOT, file));
          }
        }
      }
      expect(offenders, `forbidden string "${forbidden}" was found in: ${offenders.join(", ")}`).toEqual([]);
    });
  }
});

describe("no React component hardcodes the application version", () => {
  // No src/renderer/**/*.tsx file may contain a literal "0.x.y" version
  // string used as a UI display. The UI must always show
  // status.currentVersion or app.getVersion().
  // Excluded: audit-shim.ts (test fixture), tests/, files where 0.x.y is
  // a version range or comparable threshold (none today, but safe).
  const VERSION_LITERAL = /["']0\.\d+\.\d+["']/;
  const EXCLUDE_FILES = new Set([
    "audit-shim.ts",
  ]);

  it("does not contain hardcoded version literals in renderer components", () => {
    const offenders = [];
    const rendererDir = path.join(REPO_ROOT, "apps", "desktop", "src", "renderer");
    for (const file of walk(rendererDir)) {
      const base = path.basename(file);
      if (EXCLUDE_FILES.has(base)) continue;
      if (file.endsWith(".test.tsx") || file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf-8");
      if (VERSION_LITERAL.test(text)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(
      offenders,
      `hardcoded version literal found in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
