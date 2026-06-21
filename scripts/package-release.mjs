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

  // Build viewer
  console.log("Building viewer...");
  execSync("pnpm --filter @screenlink/viewer build", { cwd: ROOT, stdio: "inherit" });
  
  // Zip viewer
  const viewerZip = path.join(OUT, `screenlink-viewer-${version}.zip`);
  // Use PowerShell for zip
  execSync(`powershell Compress-Archive -Path "apps/viewer/dist/*" -DestinationPath "${viewerZip}" -Force`, { cwd: ROOT });
  
  // Build desktop
  console.log("\nBuilding desktop...");
  execSync("pnpm --filter @screenlink/desktop build", { cwd: ROOT, stdio: "inherit" });
  
  // Build worker
  console.log("\nBuilding worker...");
  execSync("pnpm --filter @screenlink/control-worker build", { cwd: ROOT, stdio: "inherit" });

  // Package worker
  const workerZip = path.join(OUT, `screenlink-worker-${version}.zip`);
  execSync(`powershell Compress-Archive -Path "apps/control-worker/dist/*" -DestinationPath "${workerZip}" -Force`, { cwd: ROOT });

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
  console.log(`  Viewer: ${viewerZip}`);
  console.log(`  Worker: ${workerZip}`);
  console.log(`  SHA-256: SHA256SUMS.txt`);
}

main().catch(console.error);
