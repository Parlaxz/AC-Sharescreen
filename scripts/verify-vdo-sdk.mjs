#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const SDK_PKG = "@vdoninja/sdk";
const SDK_FILE = "vdoninja-sdk.min.js";

const ORIGINAL = path.join(ROOT, "node_modules", SDK_PKG, SDK_FILE);
const COPIES = [
  path.join(ROOT, "apps", "desktop", "public", "vendor", "vdoninja-sdk-1.3.18.min.js"),
  path.join(ROOT, "apps", "viewer", "public", "vendor", "vdoninja-sdk-1.3.18.min.js"),
];

function sha256(filePath) {
  const content = fs.readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

if (!fs.existsSync(ORIGINAL)) {
  console.error(`Original SDK not found at ${ORIGINAL}`);
  process.exit(1);
}

const originalHash = sha256(ORIGINAL);
console.log(`Original SDK SHA-256: ${originalHash}`);

let allMatch = true;
for (const copy of COPIES) {
  if (!fs.existsSync(copy)) {
    console.error(`MISSING: ${copy}`);
    allMatch = false;
    continue;
  }
  
  const copyHash = sha256(copy);
  const match = copyHash === originalHash;
  console.log(`${match ? "OK" : "MISMATCH"}: ${path.relative(ROOT, copy)} (${copyHash})`);
  if (!match) allMatch = false;
}

if (allMatch) {
  console.log("\nAll SDK copies match. Verified.");
  process.exit(0);
} else {
  console.error("\nSDK verification FAILED!");
  process.exit(1);
}
