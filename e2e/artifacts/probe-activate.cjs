// Spawn target, ACTIVATE it via shell, then enumerate from separate process.
const { spawn } = require("child_process");
const { execFileSync } = require("child_process");

const EXE = "apps/desktop/node_modules/electron/dist/electron.exe";
const child = spawn(EXE, ["e2e/artifacts/probe-window.mjs"], { stdio: ["ignore", "pipe", "pipe"] });

setTimeout(() => {
  // Activate the window (foreground it) like a real user would.
  try {
    execFileSync("powershell", ["-NoProfile", "-Command",
      `$sig='using System;using System.Runtime.InteropServices;public class AW{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);}';` +
      `Add-Type -TypeDefinition $sig;` +
      `$p=Get-Process -Id ${child.pid};` +
      `[AW]::ShowWindow($p.MainWindowHandle,9)|Out-Null;` +
      `[AW]::SetForegroundWindow($p.MainWindowHandle)|Out-Null;` +
      `Start-Sleep -Milliseconds 500;` +
      `'activated'`],
      { encoding: "utf8" });
  } catch (e) { console.log("activate failed:", e.message.slice(0, 200)); }

  const out = execFileSync(EXE, ["e2e/artifacts/probe-capture.mjs"], { encoding: "utf8" });
  const start = out.indexOf("{");
  console.log(out.slice(start));
  child.kill();
  process.exit(0);
}, 4000);
