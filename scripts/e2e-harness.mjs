// ScreenLink E2E harness — drives real packaged-mode Electron instances over CDP.
// Usage: imported by e2e scenarios. See e2e-full-flow.mjs.
import { spawn } from "node:child_process";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
const ELECTRON = path.join(DESKTOP, "node_modules", "electron", "dist", "electron.exe");
const MAIN_JS = path.join(DESKTOP, "dist", "main", "main.js");

export const log = (...m) => console.log("[e2e]", ...m);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchInstance(profile, cdpPort) {
  const proc = spawn(
    ELECTRON,
    [
      "--remote-debugging-port=" + cdpPort,
      "--dev-profile=" + profile,
      "--multi-instance",
      MAIN_JS,
    ],
    {
      cwd: DESKTOP,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  proc.stderr.on("data", (d) => process.stdout.write(`[${profile}-err] ${d}`));
  proc.stdout.on("data", () => {});
  // Wait for CDP to come up.
  await waitFor(() => fetchJson(`http://127.0.0.1:${cdpPort}/json/list`), 20_000, 500);
  log(`instance ${profile} up on CDP ${cdpPort}`);
  return proc;
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

export async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${lastErr ? ` (last: ${lastErr.message})` : ""}`);
}

// ── Raw CDP connection ──────────────────────────────────────────────────────
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  static async connect(pageWsUrl) {
    const ws = new WebSocket(pageWsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("Eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    }
    return r.result?.value ?? null;
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export async function attachToPage(cdpPort, urlIncludes = "") {
  const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const page = targets.find((t) => t.type === "page" && t.url.includes(urlIncludes));
  if (!page) throw new Error(`No page target matching "${urlIncludes}" on ${cdpPort}`);
  return Cdp.connect(page.webSocketDebuggerUrl);
}

// ── UI helpers (evaluated inside the renderer) ──────────────────────────────
const CLICK_BY_TEXT = `
(text) => {
  const els = [...document.querySelectorAll('button, [role="button"], a, [onclick], input[type="submit"]')];
  const el = els.find((e) => (e.innerText || "").trim().startsWith(text));
  if (!el) return false;
  el.click();
  return true;
}
`;

const HAS_TEXT = `(text) => document.body.innerText.includes(text)`;

const QUERY_TEXT = `
(sel) => {
  const el = document.querySelector(sel);
  return el ? (el.value !== undefined ? el.value : el.innerText) : null;
}
`;

export function ui(cdp) {
  return {
    eval: (expr) => cdp.eval(expr),
    hasText: (text) => cdp.eval(`(${HAS_TEXT})(${JSON.stringify(text)})`),
    clickText: async (text) => {
      const ok = await cdp.eval(`(${CLICK_BY_TEXT})(${JSON.stringify(text)})`);
      if (!ok) throw new Error(`clickText: no button "${text}"`);
      return true;
    },
    waitForText: (text, timeoutMs = 10_000) =>
      waitFor(async () => {
        const has = await cdp.eval(`(${HAS_TEXT})(${JSON.stringify(text)})`);
        if (!has) throw new Error(`text not found: ${text}`);
        return true;
      }, timeoutMs),
    set_input_value: (index, value) =>
      cdp.eval(`
        (function () {
          const inputs = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
          const el = inputs[${index}];
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `),
    screenshot: async (file) => {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs");
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      return file;
    },
  };
}
