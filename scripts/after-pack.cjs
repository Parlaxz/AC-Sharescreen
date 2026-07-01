const path = require("node:path");
const fs = require("node:fs/promises");

exports.default = async function (context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName !== "win32") return;

  const resourcesDir = path.join(appOutDir, "resources");

  // ── Validate required helpers are present ────────────────────────────────
  const requiredResources = [
    "screenlink-audio-helper.exe",
    "screenlink-video-enhancer.exe",
    "tray-icon-blue.png",
    "tray-icon-green.png",
    "tray-icon-orange.png",
    "tray-icon-red.png",
  ];

  for (const resource of requiredResources) {
    const resourcePath = path.join(resourcesDir, resource);
    try {
      const stat = await fs.stat(resourcePath);
      if (!stat.isFile()) {
        console.error(`  ERROR: ${resource} exists but is not a file`);
        throw new Error(`Required resource ${resource} is not a file`);
      }
      console.log(`  verified ${resource} (${(stat.size / 1024).toFixed(0)} KB)`);
    } catch (err) {
      if (err.code === "ENOENT") {
        console.error(`  ERROR: Required resource ${resource} is missing from ${resourcesDir}`);
        throw new Error(`Required resource ${resource} not found after packaging`);
      }
      throw err;
    }
  }

  // ── Clean up unnecessary Chromium files ──────────────────────────────────
  const targets = [
    { pattern: "locales", keep: ["en-US.pak"] },
    "LICENSES.chromium.html",
    "vk_swiftshader.dll",
    "vk_swiftshader_icd.json",
    "vulkan-1.dll",
    "dxcompiler.dll",
    "dxil.dll",
  ];

  for (const t of targets) {
    if (typeof t === "string") {
      const p = path.join(appOutDir, t);
      try {
        await fs.unlink(p);
        console.log(`  removed ${t}`);
      } catch {
        // file not found, skip
      }
    } else if (t.pattern && Array.isArray(t.keep)) {
      const dir = path.join(appOutDir, t.pattern);
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          if (!t.keep.includes(entry)) {
            await fs.unlink(path.join(dir, entry));
          }
        }
        console.log(`  cleaned locales/ (kept: ${t.keep.join(", ")})`);
      } catch {
        // directory not found, skip
      }
    }
  }
};
