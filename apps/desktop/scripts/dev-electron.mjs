#!/usr/bin/env node
import { spawn, execSync } from "child_process";
import { createServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function log(msg) {
  console.log(`[dev] ${msg}`);
}

async function main() {
  // 1. Start Vite dev server
  log("Starting Vite dev server...");
  const server = await createServer({
    configFile: path.join(root, "vite.config.ts"),
    root,
    server: { port: 5173, strictPort: true, open: false },
  });
  await server.listen();
  log("Vite running at http://localhost:5173");

  // 2. Compile main + preload TS if needed
  const mainOut = path.join(root, "dist/main/main.js");
  const preloadOut = path.join(root, "dist/preload/index.js");

  if (!fs.existsSync(mainOut) || !fs.existsSync(preloadOut)) {
    log("Compiling TypeScript...");
    execSync("npx tsc -p tsconfig.main.json --outDir dist/main", { cwd: root, stdio: "inherit" });
    execSync("npx tsc -p tsconfig.preload.json --outDir dist/preload", { cwd: root, stdio: "inherit" });
    log("TypeScript compiled.");
  } else {
    log("Using existing compiled output.");
  }

  // 3. Find electron binary
  const electronBin = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const electronCmd = path.join(root, "node_modules", ".bin", "electron.cmd");

  let electronPath;
  if (fs.existsSync(electronBin)) {
    electronPath = electronBin;
  } else if (fs.existsSync(electronCmd)) {
    electronPath = electronCmd;
  } else {
    // Try resolving via npx
    electronPath = "npx";
  }

  log(`Launching Electron...`);

  // 4. Launch Electron
  const isNpx = electronPath === "npx";
  const electronProc = isNpx
    ? spawn("npx.cmd", ["electron", "dist/main/main.js"], {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          NODE_ENV: "development",
        },
        shell: true,
      })
    : spawn(electronPath, [path.join(root, "dist/main/main.js")], {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          NODE_ENV: "development",
        },
      });

  electronProc.on("error", (err) => {
    console.error("Failed to launch Electron:", err.message);
    log("Try running: cd apps/desktop && npx vite --port 5173");
    log("Then in another terminal: cd apps/desktop && npx electron dist/main/main.js");
  });

  electronProc.on("exit", (code) => {
    log(`Electron exited (code: ${code})`);
    server.close();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
