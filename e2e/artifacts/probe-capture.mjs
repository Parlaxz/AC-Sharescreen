// Probe: does desktopCapturer see the E2E-FIXTURE window right now?
import { app, BrowserWindow, desktopCapturer } from "electron";

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 100 });
  await win.loadURL("about:blank");
  await new Promise((r) => setTimeout(r, 3000));
  const sources = await desktopCapturer.getSources({ types: ["window"], fetchWindowIcons: false });
  const titles = sources.map((s) => s.name);
  const fixtures = titles.filter((t) => t.includes("E2E-FIXTURE"));
  console.log(JSON.stringify({ total: titles.length, fixtures, all: titles }, null, 1));
  app.exit(0);
});
