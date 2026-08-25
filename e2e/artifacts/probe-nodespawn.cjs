// Spawn probe-window via Node (client.ts mechanics), then enumerate from a
// separate electron process, then report.
const { spawn } = require("child_process");
const { execFileSync } = require("child_process");

const EXE = "apps/desktop/node_modules/electron/dist/electron.exe";
const child = spawn(EXE, ["e2e/artifacts/probe-window.mjs"], { stdio: ["ignore", "pipe", "pipe"] });

setTimeout(() => {
  const out = execFileSync(EXE, ["e2e/artifacts/probe-capture.mjs"], { encoding: "utf8" });
  const start = out.indexOf("{");
  console.log("child pid:", child.pid);
  console.log(out.slice(start));
  child.kill();
  process.exit(0);
}, 5000);
