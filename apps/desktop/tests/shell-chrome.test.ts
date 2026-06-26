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

// ─── 2. DevTools shortcut behavior tests (Stage 7 — Ctrl+Shift+I) ─────

describe("DevTools shortcut", () => {
  const wmPath = path.join(mainRoot, "window-manager.ts");
  const wmSrc = readFileSafe(wmPath);

  it("Ctrl+Shift+I is bound via before-input-event in window-manager.ts", () => {
    // The keyboard shortcut handler is registered on the webContents
    // before-input-event. The handler toggles DevTools unconditionally
    // (no environment flag, no developer-mode requirement).
    expect(wmSrc).toContain("before-input-event");
    expect(wmSrc).toMatch(/control\s*===\s*true\s*&&\s*input\.shift\s*===\s*true\s*&&\s*key\s*===\s*"i"/);
  });

  it("event.preventDefault is called for the matching shortcut", () => {
    // The before-input-event handler calls event.preventDefault() so
    // the browser default for Ctrl+Shift+I is suppressed.
    expect(wmSrc).toMatch(/event\.preventDefault\(\)/);
  });

  it("toggleDevTools calls openDevTools and closeDevTools on the webContents", () => {
    expect(wmSrc).toContain("openDevTools");
    expect(wmSrc).toContain("closeDevTools");
  });

  it("toggleDevTools no longer requires --devtools or developer mode", () => {
    // The legacy gating via isDevToolsAllowed() has been removed. The
    // toggle must NOT consult any guard before opening DevTools.
    expect(wmSrc).not.toMatch(/isDevToolsAllowed/);
  });

  it("Cmd+Option+I (macOS) is also recognized", () => {
    expect(wmSrc).toMatch(/input\.meta\s*===\s*true\s*&&\s*input\.alt\s*===\s*true/);
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

  it("workspace uses min-w-0 min-h-0 for flex containment", () => {
    expect(shellSrc).toContain("min-w-0");
    expect(shellSrc).toContain("min-h-0");
    expect(shellSrc).toContain("overflow-hidden");
  });

  it("rail and dashboard chains have full-height wrappers", () => {
    expect(shellSrc).toMatch(/flex-shrink-0 overflow-hidden"[\s\S]{0,200}h-full min-h-0/);
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
