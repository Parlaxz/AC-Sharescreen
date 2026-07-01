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

  it("binds the video element through a callback ref instead of a sessionState effect", () => {
    expect(viewerWorkspaceSrc).toContain("const videoRefCallback = useCallback");
    expect(viewerWorkspaceSrc).toContain("sessionRef.current.bindVideoElement(el)");
    expect(viewerWorkspaceSrc).not.toMatch(/useEffect\(\(\) => \{[\s\S]*bindVideoElement\(videoRef\.current\)[\s\S]*sessionState/);
  });

  it("serializes destroy promises across remounts", () => {
    expect(viewerWorkspaceSrc).toContain("let _globalDestroyPromise: Promise<void> | null = null");
    expect(viewerWorkspaceSrc).toContain("if (_globalDestroyPromise)");
    expect(viewerWorkspaceSrc).toContain("_globalDestroyPromise = destroyPromise");
  });
});
