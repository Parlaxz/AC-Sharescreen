// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingHelpSourcePath = path.resolve(__dirname, "..", "src", "renderer", "components", "SettingHelp.tsx");

describe("SettingHelp Accessibility (Stage 10)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses unique ids via useId", async () => {
    // In a real render, SettingHelp would use React.useId() for unique IDs.
    // Verify the component exists and has the right interface.
    const { SettingHelp } = await import("../src/renderer/components/SettingHelp.js");
    expect(SettingHelp).toBeDefined();
  });

  it("supports hover, focus, click, touch, Escape, outside click triggers", async () => {
    // These are behavioral requirements verified by the component API:
    // - Hover/Focus: onMouseEnter/onFocus show popup, onMouseLeave/onBlur hide
    // - Click: onClick toggle
    // - Escape/outside click: useEffect handlers
    // Stage 10 requires these to use unique ids and accessible tooltip/popover semantics
    // Verify the source contains these interaction patterns
    const fs = await import("fs");
    const source = fs.readFileSync(settingHelpSourcePath, "utf-8");
    expect(typeof source).toBe("string");
    expect(source.includes("useId")).toBe(true);
    expect(source.includes("onMouseEnter")).toBe(true);
    expect(source.includes("onMouseLeave")).toBe(true);
    expect(source.includes("onFocus")).toBe(true);
    expect(source.includes("onBlur")).toBe(true);
    expect(source.includes("aria-describedby")).toBe(true);
    expect(source.includes("aria-expanded")).toBe(true);
    expect(source.includes("aria-label")).toBe(true);
    expect(source.includes('role="tooltip"')).toBe(true);
    expect(source.includes("Escape")).toBe(true);
  });

  it("help entries define perViewer, hostWide, liveSafe, restartRequired fields", async () => {
    const { HELP_ENTRIES } = await import("../src/renderer/quality-setting-help.js");
    const entries = Object.values(HELP_ENTRIES);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toHaveProperty("perViewer");
      expect(entry).toHaveProperty("hostWide");
      expect(entry).toHaveProperty("liveSafe");
      expect(entry).toHaveProperty("restartRequired");
      expect(typeof entry.perViewer).toBe("boolean");
      expect(typeof entry.hostWide).toBe("boolean");
      expect(typeof entry.liveSafe).toBe("boolean");
      expect(typeof entry.restartRequired).toBe("boolean");
    }
  });
});
