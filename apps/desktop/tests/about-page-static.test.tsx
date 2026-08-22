// @vitest-environment node
/**
 * Static guardrail tests for About page.
 *
 * Verifies:
 * - Uses PageHeader component
 * - Uses PageSection components
 * - No href="#" placeholders
 * - External links use openExternal IPC
 * - Uses ScreenLink design tokens
 * - No hardcoded version strings (React, Zustand)
 * - Only real appInfo/update data or neutral labels
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ABOUT_PAGE = path.resolve(
  __dirname,
  "../src/renderer/routes/About.tsx",
);

const source = fs.readFileSync(ABOUT_PAGE, "utf-8");

describe("About - Uses PageHeader", () => {
  it("imports or declares a PageHeader component", () => {
    expect(source).toMatch(/PageHeader/);
  });

  it("renders a PageHeader component with a title prop", () => {
    expect(source).toMatch(/<PageHeader\s/);
    expect(source).toMatch(/title\s*=\s*["']/);
  });
});

describe("About - Uses PageSection", () => {
  it("imports or declares a PageSection component", () => {
    expect(source).toMatch(/PageSection/);
  });

  it("uses PageSection components for content grouping", () => {
    const matches = source.match(/<PageSection/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("About - No href=# placeholders", () => {
  it("does NOT contain any href='#' links", () => {
    const hrefHashMatches = source.match(/href\s*=\s*["']#["']/g);
    expect(hrefHashMatches).toBeNull();
  });
});

describe("About - External links use openExternal", () => {
  it("external link onClick handlers call openExternal", () => {
    expect(source).toMatch(/openExternal/);
  });

  it("does not comment out openExternal calls", () => {
    expect(source).not.toMatch(/\/\/\s*In production:\s*api\.openExternal/);
  });
});

describe("About - Real app info from API", () => {
  it("calls getAppInfo from the screenlink API", () => {
    expect(source).toMatch(/getAppInfo\b/);
  });

  it("calls getUpdateStatus from the screenlink API", () => {
    expect(source).toMatch(/getUpdateStatus\b/);
  });
});

describe("About - No hardcoded version strings", () => {
  it('does not contain hardcoded React version "19"', () => {
    // Only real appInfo/update data should be shown; hardcoded React is not real data
    expect(source).not.toMatch(/React.*["']19["']/);
    expect(source).not.toMatch(/["']19["'].*React/);
  });

  it('does not contain hardcoded Zustand version "5"', () => {
    expect(source).not.toMatch(/Zustand.*["']5["']/);
    expect(source).not.toMatch(/["']5["'].*Zustand/);
  });

  it("only shows version labels derived from appInfo or updateStatus", () => {
    // The version info rows should reference appInfo properties or updateStatus
    const versionRefs = source.match(/appInfo\?\.\w+/g) || [];
    const updateRefs = source.match(/updateStatus\?\.\w+/g) || [];
    // At least one reference to appInfo or updateStatus for version data
    expect(versionRefs.length + updateRefs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("About - Design tokens", () => {
  it("uses ScreenLink token text-text-primary", () => {
    expect(source).toContain("text-text-primary");
  });

  it("uses ScreenLink token text-text-secondary", () => {
    expect(source).toContain("text-text-secondary");
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

describe("About - Semantic links", () => {
  it("uses anchor tags for external links that have href='http...'", () => {
    const httpHrefs = source.match(/href\s*=\s*["']https?:\/\//g);
    expect(httpHrefs).not.toBeNull();
    expect(httpHrefs!.length).toBeGreaterThanOrEqual(1);
  });
});
