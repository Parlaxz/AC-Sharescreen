#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "release");

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function main() {
  const version = process.env.npm_package_version || "0.1.0";
  fs.mkdirSync(OUT, { recursive: true });

  // Build workspace packages (current pnpm-workspace.yaml members:
  // apps/desktop, packages/shared, packages/vdo-adapter)
  console.log("Building shared package...");
  execSync("pnpm --filter @screenlink/shared build", { cwd: ROOT, stdio: "inherit" });

  console.log("\nBuilding vdo-adapter...");
  execSync("pnpm --filter @screenlink/vdo-adapter build", { cwd: ROOT, stdio: "inherit" });

  console.log("\nBuilding desktop...");
  execSync("pnpm --filter @screenlink/desktop build", { cwd: ROOT, stdio: "inherit" });

  // Generate checksums
  const checksums = [];
  for (const file of fs.readdirSync(OUT)) {
    const filePath = path.join(OUT, file);
    if (fs.statSync(filePath).isFile()) {
      checksums.push(`${sha256(filePath)}  ${file}`);
    }
  }

  fs.writeFileSync(path.join(OUT, "SHA256SUMS.txt"), checksums.join("\n") + "\n");

  console.log(`\nRelease packaged to ${OUT}`);
  console.log(`  SHA-256: SHA256SUMS.txt`);
}

main().catch(console.error);
