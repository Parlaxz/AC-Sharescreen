#!/usr/bin/env node
/**
 * set-release-version.mjs
 *
 * Deterministically sets the application version for a release build.
 *
 * Usage:
 *   node scripts/set-release-version.mjs 0.1.1
 *
 * The argument must be a valid semantic version WITHOUT the leading "v".
 * Updates:
 *   - Root package.json version
 *   - apps/desktop/package.json version
 *
 * Exits with code 0 on success, nonzero on failure.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function main() {
  const version = process.argv[2];

  if (!version) {
    console.error("ERROR: Missing version argument.");
    console.error("Usage: node scripts/set-release-version.mjs <semver>");
    console.error("Example: node scripts/set-release-version.mjs 0.1.1");
    process.exit(1);
  }

  if (!SEMVER_RE.test(version)) {
    console.error(`ERROR: Invalid version "${version}". Must be a valid semantic version like 0.1.1`);
    process.exit(1);
  }

  // Update root package.json
  const rootPkgPath = path.join(ROOT, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
  rootPkg.version = version;
  fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, "\t") + "\n", "utf-8");
  console.log(`  root package.json → ${version}`);

  // Update desktop package.json
  const desktopPkgPath = path.join(ROOT, "apps", "desktop", "package.json");
  const desktopPkg = JSON.parse(fs.readFileSync(desktopPkgPath, "utf-8"));
  desktopPkg.version = version;
  fs.writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, "  ") + "\n", "utf-8");
  console.log(`  apps/desktop/package.json → ${version}`);

  // Verify consistency
  const rootCheck = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
  const desktopCheck = JSON.parse(fs.readFileSync(desktopPkgPath, "utf-8"));

  if (rootCheck.version !== version) {
    console.error(`ERROR: Root package.json version mismatch. Expected ${version}, got ${rootCheck.version}`);
    process.exit(1);
  }

  if (desktopCheck.version !== version) {
    console.error(`ERROR: Desktop package.json version mismatch. Expected ${version}, got ${desktopCheck.version}`);
    process.exit(1);
  }

  if (rootCheck.version !== desktopCheck.version) {
    console.error(`ERROR: Package versions do not match: root=${rootCheck.version} desktop=${desktopCheck.version}`);
    process.exit(1);
  }

  console.log(`\nVersion set to ${version} — all packages match.`);
}

main();
