#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const SDK_PKG = "@vdoninja/sdk";
const SDK_VERSION = "1.3.18";
const SDK_FILE = "vdoninja-sdk.min.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "node_modules", SDK_PKG, SDK_FILE);

if (!fs.existsSync(SOURCE)) {
  console.error(`SDK not found at ${SOURCE}. Run "pnpm install" first.`);
  process.exit(1);
}

// Verify version from package.json
const pkgJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules", SDK_PKG, "package.json"), "utf-8")
);
if (pkgJson.version !== SDK_VERSION) {
  console.error(`Expected SDK version ${SDK_VERSION}, got ${pkgJson.version}`);
  process.exit(1);
}

const TARGETS = [
  path.join(ROOT, "apps", "desktop", "public", "vendor", `vdoninja-sdk-${SDK_VERSION}.min.js`),
  path.join(ROOT, "apps", "viewer", "public", "vendor", `vdoninja-sdk-${SDK_VERSION}.min.js`),
];

// Also copy LICENSE-SDK-EXCEPTION and AGPL-3.0.txt
const SDK_DIR = path.join(ROOT, "node_modules", SDK_PKG);
const LICENSE_SRC = path.join(SDK_DIR, "LICENSE-SDK-EXCEPTION");
const AGPL_SRC = path.join(SDK_DIR, "LICENSE");

for (const target of TARGETS) {
  const vendorDir = path.dirname(target);
  
  // Copy SDK
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.copyFileSync(SOURCE, target);
  console.log(`Copied SDK to ${target}`);
  
  // Copy licenses
  if (fs.existsSync(LICENSE_SRC)) {
    fs.copyFileSync(LICENSE_SRC, path.join(vendorDir, "LICENSE-SDK-EXCEPTION"));
    console.log(`Copied SDK exception to ${vendorDir}`);
  }
  if (fs.existsSync(AGPL_SRC)) {
    fs.copyFileSync(AGPL_SRC, path.join(vendorDir, "AGPL-3.0.txt"));
    console.log(`Copied AGPL license to ${vendorDir}`);
  }
}

// Compute SHA-256
const content = fs.readFileSync(SOURCE);
const hash = createHash("sha256").update(content).digest("hex");
console.log(`\nSDK SHA-256: ${hash}`);
console.log("SDK copied successfully.");
