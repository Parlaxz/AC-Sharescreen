const path = require("node:path");
const fs = require("node:fs/promises");

exports.default = async function (context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName !== "win32") return;

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
