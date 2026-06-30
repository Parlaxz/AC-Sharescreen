// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const shellPath = path.resolve(__dirname, "../src/renderer/components/layout/AppShell.tsx");
const viewerWorkspacePath = path.resolve(__dirname, "../src/renderer/components/workspace/ViewerWorkspace.tsx");

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

describe("viewer workspace lifecycle wiring", () => {
  const shellSrc = readFileSafe(shellPath);
  const viewerWorkspaceSrc = readFileSafe(viewerWorkspacePath);

  it("keeps exactly one ViewerWorkspace mounted while viewing across page switches", () => {
    const matches = shellSrc.match(/<ViewerWorkspace\s*\/>/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("retry path reinitializes runtime and recreates a missing session", () => {
    expect(viewerWorkspaceSrc).toContain("ensureAppRuntimeInitialized");
    expect(viewerWorkspaceSrc).toMatch(/if \(sessionRef\.current\) \{[\s\S]*retry\(\);[\s\S]*\} else \{[\s\S]*startViewerSession\(/);
  });
});
