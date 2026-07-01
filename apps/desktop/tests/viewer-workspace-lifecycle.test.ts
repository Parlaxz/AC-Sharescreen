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
    expect(viewerWorkspaceSrc).toContain("bindVideoElement(el)");
    expect(viewerWorkspaceSrc).not.toMatch(/useEffect\(\(\) => \{[\s\S]*bindVideoElement\(videoRef\.current\)[\s\S]*sessionState/);
  });

  it("serializes destroy promises across remounts", () => {
    expect(viewerWorkspaceSrc).toContain("let _globalDestroyPromise: Promise<void> | null = null");
    expect(viewerWorkspaceSrc).toContain("if (_globalDestroyPromise)");
    expect(viewerWorkspaceSrc).toContain("_globalDestroyPromise = destroyPromise");
  });

  it("renders a single persistent native <video> element across connecting/reconnecting/degraded/watching", () => {
    // After unification, only one <video> element should exist in the
    // template (ended and error states are separate early-return branches).
    const videoTags = viewerWorkspaceSrc.match(/<video\s/g) ?? [];
    expect(videoTags).toHaveLength(1);
  });

  it("videoRefCallback passes null to bindVideoElement on unmount", () => {
    // The callback ref must always call bindVideoElement(el),
    // including when el is null (unmount/unbind).
    expect(viewerWorkspaceSrc).toMatch(
      /sessionRef\.current\?\.bindVideoElement\(el\)/,
    );
  });

  it("does not hide raw video before enhancement produces a frame", () => {
    // The visibility condition must include enhancementActive as a gate,
    // not rely solely on enhancementSettings.enabled.
    expect(viewerWorkspaceSrc).toMatch(
      /enhancementActive.*enhancementSettings\.enabled/,
    );
  });

  it("status UI for connecting/reconnecting/degraded are conditional overlays not separate branches", () => {
    // Connecting state must NOT be an early return that omits the video element.
    expect(viewerWorkspaceSrc).not.toMatch(
      /if \(displayStatus === "connecting"\) \{[\s\S]{0,200}return \(/,
    );
    // Reconnecting state must NOT be an early return with its own <video>.
    expect(viewerWorkspaceSrc).not.toMatch(
      /if \(displayStatus === "reconnecting"\) \{[\s\S]{0,200}return \(/,
    );
    // Connecting overlay must exist as conditional JSX.
    expect(viewerWorkspaceSrc).toMatch(
      /\{displayStatus === "connecting" && \(/,
    );
    // Reconnecting overlay must exist as conditional JSX.
    expect(viewerWorkspaceSrc).toMatch(
      /\{displayStatus === "reconnecting" && \(/,
    );
  });

  it("resets enhancementActive at start of a new viewer session", () => {
    expect(viewerWorkspaceSrc).toContain("setEnhancementActive(false)");
  });
});
