/*
 * ScreenLink UI/Functionality Audit Harness
 *
 * Drives the renderer in a Chromium browser via Playwright.
 * Captures console errors, page errors, layout issues, and screenshots.
 *
 * Usage:
 *   cd apps/desktop
 *   node audit-renderer.mjs
 *
 * Output:
 *   apps/desktop/audit-output/screenshots/<route>.png
 *   apps/desktop/audit-output/report.json
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const BASE_URL = "http://127.0.0.1:5173";
const OUTPUT_DIR = "C:\\Users\\parla\\OneDrive\\Desktop\\Development\\AC-Sharescreen\\apps\\desktop\\audit-output";

const ROUTES = [
  { name: "dashboard", url: "/" },
  { name: "source-picker", url: "/?page=source-picker" },
  { name: "groups", url: "/?page=groups" },
  { name: "quality-presets", url: "/?page=quality-presets" },
  { name: "settings", url: "/?page=settings" },
  { name: "diagnostics", url: "/?page=diagnostics" },
  { name: "about", url: "/?page=about" },
  { name: "component-gallery", url: "/?gallery=1" },
];

const PAGE_PARAM_TO_STORE = {
  dashboard: "dashboard",
  "source-picker": "source-picker",
  groups: "groups",
  "quality-presets": "quality-presets",
  settings: "settings",
  diagnostics: "diagnostics",
  about: "about",
};

async function setupPage(page, url) {
  const errors = [];
  const warnings = [];
  page.on("console", (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (t === "error") errors.push(text);
    if (t === "warning") warnings.push(text);
  });

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}`));

  const failedRequests = [];
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1200);

  return { errors, warnings, pageErrors, failedRequests };
}

async function detectLayoutIssues(page) {
  const issues = [];

  const hasHorizontalOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
  });
  if (hasHorizontalOverflow) {
    issues.push("horizontal-overflow: document is wider than viewport");
  }

  const overflowingEls = await page.evaluate(() => {
    const vw = window.innerWidth;
    const all = document.querySelectorAll("*");
    const offenders = [];
    for (const el of Array.from(all)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 4 || r.left < -4)) {
        const tag = el.tagName.toLowerCase();
        const cls = (el.className && typeof el.className === "string")
          ? el.className.split(" ").slice(0, 3).join(".")
          : "";
        const txt = (el.textContent || "").trim().slice(0, 40);
        offenders.push(`${tag}.${cls} @ [${Math.round(r.left)},${Math.round(r.right)}] "${txt}"`);
        if (offenders.length > 5) break;
      }
    }
    return offenders;
  });
  for (const el of overflowingEls) {
    issues.push(`element-overflow: ${el}`);
  }

  const bodyBg = await page.evaluate(() => {
    return window.getComputedStyle(document.body).backgroundColor;
  });
  if (!bodyBg || bodyBg === "rgba(0, 0, 0, 0)") {
    issues.push(`body-background: ${bodyBg || "transparent"} — may be unset`);
  }

  const hasShell = await page.evaluate(() => {
    const els = document.querySelectorAll("[class*='bg-canvas'], [class*='bg-rail'], [class*='bg-surface']");
    return els.length > 0;
  });
  if (!hasShell) {
    issues.push("shell-missing: no bg-canvas / bg-rail / bg-surface elements found");
  }

  // Check the root has children (the App rendered)
  const rootHasContent = await page.evaluate(() => {
    const root = document.getElementById("root");
    return !!(root && root.children.length > 0);
  });
  if (!rootHasContent) {
    issues.push("root-empty: #root has no children — React app did not mount");
  }

  return issues;
}

async function auditRoute(browser, name, url, screenshotDir) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const baseUrl = `${BASE_URL}/audit.html`;
  const fullUrl = url === "/"
    ? baseUrl
    : url.startsWith("/?")
      ? `${baseUrl}${url.slice(1)}`
      : `${baseUrl}?${url.slice(1)}`;

  const { errors, warnings, pageErrors, failedRequests } = await setupPage(page, fullUrl);

  const pageName = name === "dashboard" ? null : PAGE_PARAM_TO_STORE[name];
  if (pageName) {
    await page.evaluate((target) => {
      const ev = new CustomEvent("screenlink:audit-navigate", { detail: { page: target } });
      window.dispatchEvent(ev);
    }, pageName).catch(() => {});
    await page.waitForTimeout(500);
  }

  if (name === "dashboard") {
    await page.evaluate(() => {
      const now = Date.now();
      const ev = new CustomEvent("screenlink:audit-seed", {
        detail: {
          groups: [
            {
              id: "group-alpha",
              name: "Project Alpha",
              members: {
                "device-1": { deviceId: "device-1", displayName: "Alice" },
                "device-2": { deviceId: "device-2", displayName: "Bob" },
              },
            },
            {
              id: "group-beta",
              name: "Team Beta",
              members: {
                "device-1": { deviceId: "device-1", displayName: "Alice" },
                "device-3": { deviceId: "device-3", displayName: "Charlie" },
              },
            },
          ],
          streams: {
            "group-alpha": [
              {
                logicalStreamId: "stream-1",
                mediaSessionId: "media-1",
                groupId: "group-alpha",
                hostDeviceId: "device-2",
                hostDisplayName: "Bob",
                sourceKind: "screen",
                sourceName: "Primary Monitor",
                startedAt: now - 3500000,
                appliedSettingsRevision: 5,
                heartbeatSequence: 100,
                replacesSessionId: null,
              },
            ],
          },
        },
      });
      window.dispatchEvent(ev);
    });
    await page.waitForTimeout(600);
  }

  const screenshotPath = join(screenshotDir, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const layoutIssues = await detectLayoutIssues(page);

  const visibleText = await page.evaluate(() => {
    return (document.body.innerText || "").slice(0, 1500);
  });

  const elementsCount = await page.evaluate(() => document.querySelectorAll("*").length);

  await context.close();

  const filteredErrors = errors.filter((e) => {
    if (e.includes("[vite]")) return false;
    if (e.includes("ResizeObserver")) return false;
    if (e.includes("Audit shim installed")) return false;
    if (e.includes("Audit] navigated")) return false;
    if (e.includes("Audit] seeded")) return false;
    return true;
  });

  const filteredFailedRequests = failedRequests.filter((r) => {
    if (r.includes("/vendor/vdoninja-sdk")) return false;
    return true;
  });

  return {
    name,
    url: fullUrl,
    screenshot: screenshotPath,
    consoleErrors: filteredErrors,
    consoleWarnings: warnings,
    pageErrors,
    failedRequests: filteredFailedRequests,
    layoutIssues,
    elementsCount,
    visibleText,
  };
}

async function main() {
  const startedAt = new Date();
  console.log(`[audit] starting at ${startedAt.toISOString()}`);

  const probe = await fetch(`${BASE_URL}/audit.html`).catch(() => null);
  if (!probe || !probe.ok) {
    console.error(`[audit] Vite is not responding at ${BASE_URL}`);
    process.exit(1);
  }
  console.log(`[audit] Vite is up at ${BASE_URL}`);

  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }
  const screenshotDir = join(OUTPUT_DIR, "screenshots");
  if (!existsSync(screenshotDir)) {
    await mkdir(screenshotDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });

  const routes = [];
  for (const r of ROUTES) {
    console.log(`[audit] auditing ${r.name} (${r.url})`);
    try {
      const audit = await auditRoute(browser, r.name, r.url, screenshotDir);
      routes.push(audit);
      const errCount = audit.consoleErrors.length + audit.pageErrors.length;
      const layoutCount = audit.layoutIssues.length;
      console.log(
        `  -> ${audit.elementsCount} elements, ${errCount} errors, ${layoutCount} layout issues`,
      );
    } catch (err) {
      console.error(`[audit] failed to audit ${r.name}:`, err);
      routes.push({
        name: r.name,
        url: r.url,
        screenshot: "(failed)",
        consoleErrors: [`audit-script-error: ${String(err)}`],
        consoleWarnings: [],
        pageErrors: [],
        failedRequests: [],
        layoutIssues: [],
        elementsCount: 0,
        visibleText: "",
      });
    }
  }

  await browser.close();

  const finishedAt = new Date();

  const allErrors = routes.flatMap((r) => r.consoleErrors);
  const allPageErrors = routes.flatMap((r) => r.pageErrors);
  const allLayout = routes.flatMap((r) => r.layoutIssues);
  const errorCounts = new Map();
  for (const e of allErrors) {
    const key = e.split("\n")[0].slice(0, 120);
    errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
  }
  const mostCommonErrors = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([message, count]) => ({ message, count }));

  const report = {
    baseUrl: BASE_URL,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalDurationMs: finishedAt.getTime() - startedAt.getTime(),
    routes,
    summary: {
      totalRoutes: routes.length,
      totalConsoleErrors: allErrors.length,
      totalPageErrors: allPageErrors.length,
      totalLayoutIssues: allLayout.length,
      mostCommonErrors,
    },
  };

  await writeFile(join(OUTPUT_DIR, "report.json"), JSON.stringify(report, null, 2));

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ScreenLink UI/Functionality Audit Report");
  console.log("═══════════════════════════════════════════════════════════════\n");
  for (const r of routes) {
    console.log(`■ ${r.name}`);
    console.log(`  URL: ${r.url}`);
    console.log(`  Screenshot: ${r.screenshot}`);
    console.log(`  Elements: ${r.elementsCount}`);
    if (r.consoleErrors.length === 0 && r.pageErrors.length === 0 && r.layoutIssues.length === 0) {
      console.log(`  Status: CLEAN`);
    } else {
      if (r.consoleErrors.length > 0) {
        console.log(`  Console errors: ${r.consoleErrors.length}`);
        for (const e of r.consoleErrors.slice(0, 5)) {
          console.log(`    - ${e.split("\n")[0].slice(0, 120)}`);
        }
        if (r.consoleErrors.length > 5) {
          console.log(`    ... and ${r.consoleErrors.length - 5} more`);
        }
      }
      if (r.pageErrors.length > 0) {
        console.log(`  Page errors: ${r.pageErrors.length}`);
        for (const e of r.pageErrors) console.log(`    - ${e}`);
      }
      if (r.layoutIssues.length > 0) {
        console.log(`  Layout issues: ${r.layoutIssues.length}`);
        for (const l of r.layoutIssues) console.log(`    - ${l}`);
      }
    }
    if (r.visibleText) {
      const firstLines = r.visibleText.split("\n").slice(0, 6).join(" | ").slice(0, 200);
      console.log(`  Text: ${firstLines}`);
    }
    console.log();
  }
  console.log("───────────────────────────────────────────────────────────────");
  console.log("  Top error patterns:");
  if (mostCommonErrors.length === 0) {
    console.log("    (none)");
  } else {
    for (const { message, count } of mostCommonErrors) {
      console.log(`    [x${count}] ${message}`);
    }
  }
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  Total: ${report.summary.totalConsoleErrors} console errors, ` +
    `${report.summary.totalPageErrors} page errors, ` +
    `${report.summary.totalLayoutIssues} layout issues`);
  console.log(`  Duration: ${(report.totalDurationMs / 1000).toFixed(1)}s`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`\nDetailed report: ${join(OUTPUT_DIR, "report.json")}`);
  console.log(`Screenshots: ${screenshotDir}`);
}

main().catch((err) => {
  console.error("[audit] fatal:", err);
  process.exit(1);
});
