// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";

// ─── Helpers ────────────────────────────────────────────────────────────────

const rendererRoot = path.resolve(__dirname, "../src/renderer");
const mainRoot = path.resolve(__dirname, "../src/main");
const docsRoot = path.resolve(__dirname, "../../../docs");

/** Read all files matching a pattern under a root, excluding node_modules and tests. */
function globSync(pattern: string, root: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(full);
      } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
        if (e.name.endsWith(".test.ts") || e.name.endsWith(".test.tsx")) continue;
        results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

// ─── 1. Forbidden dashboard block imports ─────────────────────────────────

describe("Dashboard block prohibition", () => {
  const rendererFiles = globSync("**/*.{ts,tsx}", rendererRoot);

  it("no renderer file imports any Watermelon dashboard block", () => {
    const forbiddenPatterns = [
      "admin-page",
      "analytics-page",
      "settings-page",
      "dashboard-page",
      "watermelon/dashboard",
      "watermelon/blocks",
    ];

    const violations: string[] = [];
    for (const file of rendererFiles) {
      const content = readFileSafe(file);
      for (const pattern of forbiddenPatterns) {
        // Check import lines only
        const lines = content.split("\n").filter((l) => l.includes("import"));
        for (const line of lines) {
          if (line.toLowerCase().includes(pattern.toLowerCase())) {
            violations.push(`${path.relative(rendererRoot, file)}: ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      console.log("Dashboard block violations found:", violations);
    }
    expect(violations).toEqual([]);
  });
});

// ─── 2. Competing UI library imports ──────────────────────────────────────

describe("Competing UI library prohibition", () => {
  const rendererFiles = globSync("**/*.{ts,tsx}", rendererRoot);

  it("no renderer file imports from competing UI libraries", () => {
    const competingLibs = [
      "@mui",
      "@material-ui",
      "react-bootstrap",
      "antd",
      "@chakra-ui",
      "@shopify/polaris",
      "semantic-ui-react",
      "@fluentui/react",
      "reactstrap",
      "blueprintjs",
    ];

    const violations: string[] = [];
    for (const file of rendererFiles) {
      const content = readFileSafe(file);
      const lines = content.split("\n").filter((l) => l.includes("import") || l.includes("require"));
      for (const lib of competingLibs) {
        for (const line of lines) {
          if (line.includes(lib)) {
            violations.push(`${path.relative(rendererRoot, file)}: ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      console.log("Competing UI library violations:", violations);
    }
    expect(violations).toEqual([]);
  });

  it("only expected UI packages are in dependencies", () => {
    // This test verifies known Watermelon dependency pattern
    const rendererImports = new Set<string>();
    for (const file of rendererFiles) {
      const content = readFileSafe(file);
      for (const line of content.split("\n")) {
        const match = line.match(/from\s+["']((?:@[^"']+\/[^"']+)|(?:[a-zA-Z][^"'\/]*[^"']))["']/);
        if (match) rendererImports.add(match[1]!);
      }
    }

    const allowedPatterns = [
      "@radix-ui/",
      "lucide-react",
      "motion",
      "sonner",
      "cmdk",
      "clsx",
      "tailwind-merge",
      "class-variance-authority",
      "zustand",
    ];

    const violations: string[] = [];
    for (const pkg of rendererImports) {
      if (pkg.startsWith("@/")) continue; // internal alias
      if (pkg.startsWith(".")) continue; // relative import
      if (pkg.startsWith("node:")) continue;
      const allowed = allowedPatterns.some((a) => pkg.startsWith(a));
      // Exempt @screenlink/* packages
      if (pkg.startsWith("@screenlink/")) continue;
      // Exempt react/dom types
      if (pkg === "react" || pkg === "react-dom" || pkg === "react/jsx-runtime") continue;
      if (!allowed) {
        violations.push(pkg);
      }
    }

    expect(violations).toEqual([]);
  });
});

// ─── 3. Ctrl+Shift+I DevTools toggle (Stage 7 — Fix 1) ─────────────────

describe("Ctrl+Shift+I DevTools toggle", () => {
  const windowManagerTs = readFileSafe(path.join(mainRoot, "window-manager.ts"));

  it("window-manager binds the Ctrl+Shift+I shortcut on before-input-event", () => {
    expect(windowManagerTs).toContain("before-input-event");
    expect(windowManagerTs).toMatch(/input\.control\s*===\s*true/);
    expect(windowManagerTs).toMatch(/input\.shift\s*===\s*true/);
  });

  it("event.preventDefault is called for the matching shortcut", () => {
    expect(windowManagerTs).toContain("event.preventDefault()");
  });

  it("DevTools open/close calls are present in the toggle path", () => {
    expect(windowManagerTs).toContain("openDevTools");
    expect(windowManagerTs).toContain("closeDevTools");
  });

  it("the legacy isDevToolsAllowed gate has been removed", () => {
    // Ctrl+Shift+I is the trigger; no environment flag / developer mode
    // is required to open DevTools.
    expect(windowManagerTs).not.toMatch(/isDevToolsAllowed/);
  });
});

// ─── 4. Documented provenance for new visible surfaces ────────────────────

describe("Documented provenance for visible surfaces", () => {
  const matrixPath = path.join(docsRoot, "watermelon-adoption-matrix.md");
  const acceptPath = path.join(docsRoot, "stage-3-7-acceptance.md");

  const matrix = readFileSafe(matrixPath);
  const accept = readFileSafe(acceptPath);

  // New surfaces introduced in this session
  const surfaces = [
    { name: "HomePage", docKeyword: "Home", label: "Home page" },
    { name: "CreateGroupDialog", docKeyword: "CreateGroup", label: "Create Group dialog" },
    { name: "JoinGroupDialog", docKeyword: "JoinGroup", label: "Join Group dialog" },
    { name: "GroupSettingsPage", docKeyword: "GroupSettings", label: "Group settings page" },
    { name: "QuickShareDialog", docKeyword: "QuickShare", label: "Quick Share dialog" },
    { name: "SettingsPage", docKeyword: "Settings", label: "Settings page" },
    { name: "QualityPresetsPage", docKeyword: "QualityPresets", label: "Quality Presets page" },
  ];

  for (const surface of surfaces) {
    it(`${surface.label} is documented in the Watermelon adoption matrix`, () => {
      const found = matrix.includes(surface.docKeyword) ||
        matrix.includes(surface.name) ||
        matrix.includes(surface.label);
      if (!found) {
        console.log(`Surface "${surface.label}" (${surface.name}) not found in adoption matrix`);
      }
      expect(found).toBe(true);
    });

    it(`${surface.label} is referenced in the Stage 3.7 acceptance doc`, () => {
      const found = accept.includes(surface.docKeyword) ||
        accept.includes(surface.name) ||
        accept.includes(surface.label);
      if (!found) {
        console.log(`Surface "${surface.label}" (${surface.name}) not found in acceptance doc`);
      }
      expect(found).toBe(true);
    });
  }
});
