// Probe: create a visible window titled PROBE-TEST-WINDOW and keep it alive.
import { app, BrowserWindow } from "electron";

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    x: 150,
    y: 150,
    title: "PROBE-TEST-WINDOW",
    show: true,
  });
  win.loadURL("data:text/html,<h1>probe</h1>");
  setInterval(() => {}, 10_000);
});
