// PW-launched enumerator + node-spawned target window.
const { spawn } = require("child_process");
const { _electron } = require("@playwright/test");

const EXE = "apps/desktop/node_modules/electron/dist/electron.exe";
const child = spawn(EXE, ["e2e/artifacts/probe-window.mjs"], { stdio: ["ignore", "pipe", "pipe"] });

(async () => {
  await new Promise((r) => setTimeout(r, 4000));
  const app = await _electron.launch({
    executablePath: EXE,
    args: ["e2e/artifacts/probe-capture.mjs"],
  });
  await new Promise((r) => setTimeout(r, 3500));
  const titles = await app.evaluate(async ({ desktopCapturer }) => {
    const sources = await desktopCapturer.getSources({ types: ["window"] });
    return sources.map((s) => s.name);
  });
  console.log(JSON.stringify({ total: titles.length, seesTarget: titles.includes("PROBE-TEST-WINDOW"), all: titles }, null, 1));
  await app.close();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error("ERR", e); child.kill(); process.exit(1); });
