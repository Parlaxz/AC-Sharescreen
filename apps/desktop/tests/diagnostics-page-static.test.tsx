// @vitest-environment node
/**
 * Static guardrail tests for DiagnosticsPage.
 *
 * Verifies:
 * - Uses ScreenLink design tokens (text-text-primary, text-text-secondary, etc.)
 * - No hardcoded fake version strings
 * - Uses aria-controls on disclosure buttons
 * - No inline hex color values
 * - Uses showVideoHelper state (not showWebrtc)
 * - Uses readRecentLogs from screenlink API
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIAGNOSTICS_PAGE = path.resolve(
  __dirname,
  "../src/renderer/components/workspace/DiagnosticsPage.tsx",
);

const source = fs.readFileSync(DIAGNOSTICS_PAGE, "utf-8");

describe("DiagnosticsPage - Design tokens", () => {
  it("uses ScreenLink token text-text-primary for primary text", () => {
    expect(source).toContain("text-text-primary");
  });

  it("uses ScreenLink token text-text-secondary for secondary text", () => {
    expect(source).toContain("text-text-secondary");
  });

  it("uses ScreenLink token text-text-muted for muted text", () => {
    expect(source).toContain("text-text-muted");
  });

  it("does not hardcode hex color values outside of allowed patterns", () => {
    const hexColors = source.match(/#[0-9a-fA-F]{3,8}/g) || [];
    const suspicious = hexColors.filter((h) => {
      const line = source.split("\n").find((l) => l.includes(h));
      return line && !line.trim().startsWith("*") && !line.includes("url(");
    });
    expect(suspicious.length).toBe(0);
  });
});

describe("DiagnosticsPage - No fake hardcoded data", () => {
  it("does not contain the fake version string '1.0.0'", () => {
    expect(source).not.toContain('"1.0.0"');
    expect(source).not.toContain("'1.0.0'");
    expect(source).not.toContain("`1.0.0`");
  });

  it("does not contain 'Windows 11 23H2' hardcoded OS string", () => {
    expect(source).not.toContain("Windows 11");
    expect(source).not.toContain("23H2");
  });

  it("does not contain hardcoded hostname strings", () => {
    expect(source).not.toContain("desktop-win11");
  });

  it("does not have useState initialized with fake data values", () => {
    expect(source).not.toMatch(/useState\(\s*["']1\.\d+\.\d+/);
  });
});

describe("DiagnosticsPage - Accessibility", () => {
  it("uses aria-controls on disclosure buttons", () => {
    expect(source).toContain("aria-controls");
  });

  it("uses aria-expanded on disclosure buttons", () => {
    expect(source).toContain("aria-expanded");
  });
});

describe("DiagnosticsPage - Loads real data", () => {
  it("calls getAppInfo from the screenlink API", () => {
    expect(source).toMatch(/getAppInfo\b/);
  });

  it("calls getAudioState from the screenlink API", () => {
    expect(source).toMatch(/getAudioState\b/);
  });

  it("calls getPipelineSnapshot from the screenlink API", () => {
    expect(source).toMatch(/getPipelineSnapshot\b/);
  });

  it("calls readRecentLogs from the screenlink API", () => {
    expect(source).toMatch(/readRecentLogs\b/);
  });
});

describe("DiagnosticsPage - Clipboard uses IPC", () => {
  it("uses clipboardWriteText IPC for copy actions", () => {
    expect(source).toMatch(/clipboardWriteText\b/);
  });

  it("does NOT use navigator.clipboard.writeText", () => {
    expect(source).not.toContain("navigator.clipboard.writeText");
  });
});

describe("DiagnosticsPage - State name: showVideoHelper", () => {
  it("uses showVideoHelper state variable", () => {
    expect(source).toContain("showVideoHelper");
  });

  it("does NOT use the old misleading showWebrtc name", () => {
    expect(source).not.toContain("showWebrtc");
  });
});
