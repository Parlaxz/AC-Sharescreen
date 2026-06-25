// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";

// ─── Helpers ────────────────────────────────────────────────────────────────

const mainRoot = path.resolve(__dirname, "../src/main");

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

// ─── 1. WindowManager config tests ───────────────────────────────────────

describe("WindowManager window configuration", () => {
  const wmPath = path.join(mainRoot, "window-manager.ts");
  const wmSrc = readFileSafe(wmPath);

  it("uses frame: false for custom title bar", () => {
    const hasFrameFalse = wmSrc.includes('frame: false');
    expect(hasFrameFalse).toBe(true);
  });

  it("uses autoHideMenuBar: true", () => {
    const hasAutoHide = wmSrc.includes('autoHideMenuBar: true');
    expect(hasAutoHide).toBe(true);
  });

  it("no native menu is set after creation", () => {
    // Should set application menu to null (hide native menu for frameless window)
    const setsMenuToNull = wmSrc.includes('setApplicationMenu(null)') || wmSrc.includes('setApplicationMenu ( null )');
    expect(setsMenuToNull).toBe(true);
  });
});

// ─── 2. DevTools gating tests ───────────────────────────────────────────

describe("DevTools gating", () => {
  const wmPath = path.join(mainRoot, "window-manager.ts");
  const wmSrc = readFileSafe(wmPath);

  it("openDevTools is guarded by SCREENLINK_OPEN_DEVTOOLS or --devtools", () => {
    const devToolsLine = wmSrc.split("\n").findIndex((l) => l.includes("openDevTools"));
    expect(devToolsLine).not.toBe(-1);

    // Check the guard context: should check env var or argv
    const lines = wmSrc.split("\n");
    const context = lines.slice(Math.max(0, devToolsLine - 5), devToolsLine + 2).join("\n");
    const hasGuard =
      context.includes("SCREENLINK_OPEN_DEVTOOLS") ||
      context.includes("--devtools") ||
      context.includes("devtools");
    expect(hasGuard).toBe(true);
  });

  it("openDevTools is not gated only by NODE_ENV or VITE_DEV_SERVER_URL", () => {
    const lines = wmSrc.split("\n");
    const devToolsLine = lines.findIndex((l) => l.includes("openDevTools"));
    expect(devToolsLine).not.toBe(-1);

    // The guard should NOT just be NODE_ENV === "development"
    const context = lines.slice(Math.max(0, devToolsLine - 5), devToolsLine + 2).join("\n");
    const onlyDevEnv = context.includes('NODE_ENV === "development"') && !context.includes("SCREENLINK_OPEN_DEVTOOLS") && !context.includes("--devtools");
    expect(onlyDevEnv).toBe(false);
  });
});

// ─── 3. AppShell full-height layout tests ───────────────────────────────

describe("AppShell full-height layout", () => {
  const shellPath = path.resolve(__dirname, "../src/renderer/components/layout/AppShell.tsx");
  const shellSrc = readFileSafe(shellPath);

  it("has h-screen on root", () => {
    expect(shellSrc).toContain("h-screen");
  });

  it("content row uses flex-1 min-h-0", () => {
    expect(shellSrc).toContain("flex-1");
    expect(shellSrc).toContain("min-h-0");
  });

  it("rail wrapper uses flex-shrink-0 overflow-hidden", () => {
    expect(shellSrc).toContain("flex-shrink-0");
    expect(shellSrc).toContain("overflow-hidden");
  });

  it("workspace uses min-w-{n} min-h-0 for flex containment", () => {
    expect(shellSrc).toContain("min-w-[");
    expect(shellSrc).toContain("min-h-0");
    expect(shellSrc).toContain("overflow-auto");
  });
});

// ─── 4. Context panel eligibility tests ────────────────────────────────

describe("Context panel eligibility", () => {
  const storePath = path.resolve(__dirname, "../src/renderer/stores/main-store.ts");
  const storeSrc = readFileSafe(storePath);
  const shellSrc = readFileSafe(path.resolve(__dirname, "../src/renderer/components/layout/AppShell.tsx"));

  it("showContextPanel initializes as false", () => {
    expect(storeSrc).toContain("showContextPanel: false");
  });

  it("context panel only shows when hosting or viewing", () => {
    // The AppShell should gate context panel on isSharing or isViewing
    const hasIsSharingGate = shellSrc.includes("isSharing") || shellSrc.includes("isViewing");
    expect(hasIsSharingGate).toBe(true);
  });
});

// ─── 5. TitleBar behavior tests ─────────────────────────────────────────

describe("TitleBar behavior", () => {
  const tbPath = path.resolve(__dirname, "../src/renderer/components/layout/TitleBar.tsx");
  const tbSrc = readFileSafe(tbPath);

  it("has double-click handler on drag region for maximize/restore", () => {
    const hasDblClick = tbSrc.includes("onDoubleClick") || tbSrc.includes("onDoubleClickCapture");
    expect(hasDblClick).toBe(true);
  });

  it("keeps Watermelon button tooltips for all window controls", () => {
    expect(tbSrc).toContain("Tooltip");
    expect(tbSrc).toContain("TooltipContent");
  });

  it("drag region has WebkitAppRegion set to drag", () => {
    expect(tbSrc).toContain("WebkitAppRegion");
    expect(tbSrc).toContain("drag");
  });
});

// ─── 6. Context panel placeholder removal test ──────────────────────────

describe("Context panel no placeholder tabs", () => {
  const cpPath = path.resolve(__dirname, "../src/renderer/components/layout/ContextPanel.tsx");
  const cpSrc = readFileSafe(cpPath);

  it("does not contain placeholder tab content — no 'will appear here' in tab sections", () => {
    // The single empty-state message is acceptable; tab-level placeholders are not.
    // Count occurrences: tab content placeholders (with tab-specific text) should be 0.
    const tabPlaceholderCount = [
      "Active viewers will appear here",
      "Group members will appear here",
      "Stream details",
      "Connection statistics",
      "Recent stream events",
    ].filter((p) => cpSrc.includes(p)).length;
    expect(tabPlaceholderCount).toBe(0);
  });

  it("has no fake/placeholder tabs — only tabs backed by real data", () => {
    // If tabs exist, each must have real data backing it
    const tabCount = (cpSrc.match(/id: "/g) || []).length;
    // Either zero tabs (hidden) or tabs with real data
    if (tabCount > 0) {
      // Check no tab content is purely placeholder
      const hasRealContent =
        cpSrc.includes("isSharing") ||
        cpSrc.includes("viewerCount") ||
        cpSrc.includes("activeStream");
      expect(hasRealContent).toBe(true);
    }
  });
});
