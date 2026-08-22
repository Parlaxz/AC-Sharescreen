// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const pageHeaderPath = path.resolve(
  __dirname,
  "../src/renderer/components/layout/PageHeader.tsx",
);
const pageSectionPath = path.resolve(
  __dirname,
  "../src/renderer/components/layout/PageSection.tsx",
);

const pageHeaderSrc = fs.readFileSync(pageHeaderPath, "utf-8");
const pageSectionSrc = fs.readFileSync(pageSectionPath, "utf-8");

// ─── PageHeader (static guardrails) ─────────────────────────────────────────

describe("PageHeader", () => {
  it("exports a named PageHeader function component", () => {
    expect(pageHeaderSrc).toContain("export function PageHeader");
  });

  it("uses ScreenLink token text-text-primary for title", () => {
    expect(pageHeaderSrc).toContain("text-text-primary");
  });

  it("uses ScreenLink token text-text-secondary for description", () => {
    expect(pageHeaderSrc).toContain("text-text-secondary");
  });

  it("uses ScreenLink token text-text-muted for eyebrow", () => {
    expect(pageHeaderSrc).toContain("text-text-muted");
  });

  it("accepts a title prop of type string", () => {
    expect(pageHeaderSrc).toMatch(/title:\s*string/);
  });

  it("accepts an optional description prop of type string", () => {
    expect(pageHeaderSrc).toMatch(/description\??:\s*string/);
  });

  it("accepts an optional eyebrow prop of type string", () => {
    expect(pageHeaderSrc).toMatch(/eyebrow\??:\s*string/);
  });

  it("accepts an optional status prop of ReactNode", () => {
    expect(pageHeaderSrc).toMatch(/status\??:\s*React\.ReactNode/);
  });

  it("accepts an optional actions prop of ReactNode", () => {
    expect(pageHeaderSrc).toMatch(/actions\??:\s*React\.ReactNode/);
  });

  it("does not hardcode hex color values", () => {
    const hexColors = pageHeaderSrc.match(/#[0-9a-fA-F]{3,8}/g) || [];
    const suspicious = hexColors.filter((h) => {
      const line = pageHeaderSrc.split("\n").find((l) => l.includes(h));
      return line && !line.trim().startsWith("*") && !line.includes("url(");
    });
    expect(suspicious.length).toBe(0);
  });
});

// ─── PageSection (static guardrails) ────────────────────────────────────────

describe("PageSection", () => {
  it("exports a named PageSection function component", () => {
    expect(pageSectionSrc).toContain("export function PageSection");
  });

  it("uses ScreenLink token text-text-primary for title", () => {
    expect(pageSectionSrc).toContain("text-text-primary");
  });

  it("uses ScreenLink token text-text-secondary for description", () => {
    expect(pageSectionSrc).toContain("text-text-secondary");
  });

  it("accepts a title prop of type string", () => {
    expect(pageSectionSrc).toMatch(/title:\s*string/);
  });

  it("accepts an optional description prop of type string", () => {
    expect(pageSectionSrc).toMatch(/description\??:\s*string/);
  });

  it("accepts an optional actions prop of ReactNode", () => {
    expect(pageSectionSrc).toMatch(/actions\??:\s*React\.ReactNode/);
  });

  it("accepts a children prop of ReactNode", () => {
    expect(pageSectionSrc).toMatch(/children:\s*React\.ReactNode/);
  });

  it("renders inside a <section> element", () => {
    expect(pageSectionSrc).toMatch(/<section/);
  });

  it("uses aria-labelledby on the section element", () => {
    expect(pageSectionSrc).toContain("aria-labelledby");
  });

  it("uses useId to generate a stable heading ID", () => {
    expect(pageSectionSrc).toContain("useId");
  });

  it("does not hardcode hex color values", () => {
    const hexColors = pageSectionSrc.match(/#[0-9a-fA-F]{3,8}/g) || [];
    const suspicious = hexColors.filter((h) => {
      const line = pageSectionSrc.split("\n").find((l) => l.includes(h));
      return line && !line.trim().startsWith("*") && !line.includes("url(");
    });
    expect(suspicious.length).toBe(0);
  });
});

// ─── DOM-level behavior tests ──────────────────────────────────────────────

describe("PageSection aria-labelledby association", () => {
  it("associates the heading id with the section via aria-labelledby", () => {
    // The aria-labelledby value must match the id on the heading element.
    // We verify this by checking that the same generated ID is used in both places.
    const headingIdMatches = pageSectionSrc.match(
      /id=\{([^}]+)\}[\s\S]*?aria-labelledby=\{([^}]+)\}/,
    );
    // aria-labelledby should reference the heading's id value
    if (headingIdMatches) {
      expect(headingIdMatches[1]).toBe(headingIdMatches[2]);
    } else {
      // Also check reverse order: aria-labelledby first, then id
      const reverseMatch = pageSectionSrc.match(
        /aria-labelledby=\{([^}]+)\}[\s\S]*?id=\{([^}]+)\}/,
      );
      expect(reverseMatch).not.toBeNull();
      expect(reverseMatch![1]).toBe(reverseMatch![2]);
    }
  });
});
