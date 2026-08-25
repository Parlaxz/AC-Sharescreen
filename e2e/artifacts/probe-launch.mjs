// Launch fixture-style app via _electron.launch (same path as agents), then
// run desktopCapturer enumeration INSIDE it.
import { _electron as electron } from "@playwright/test";
import path from "node:path";

const exe = path.resolve("apps/desktop/node_modules/electron/dist/electron.exe");
const app = await electron.launch({
  executablePath: exe,
  args: [path.resolve("e2e/artifacts/probe-window.mjs")],
  cwd: path.resolve("."),
});
await new Promise((r) => setTimeout(r, 4000));
const win = await app.firstWindow();
const titles = await app.evaluate(async ({ desktopCapturer }) => {
  const sources = await desktopCapturer.getSources({ types: ["window"] });
  return sources.map((s) => s.name);
});
console.log(JSON.stringify({ total: titles.length, self: titles.filter((t) => t.includes("PROBE")), all: titles }, null, 1));
await app.close();
