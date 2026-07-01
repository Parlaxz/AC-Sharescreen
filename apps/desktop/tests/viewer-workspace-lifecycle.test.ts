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

  it("serializes viewer lifecycle through a module-level queue instead of clearing a destroy promise early", () => {
    expect(viewerWorkspaceSrc).toContain("let viewerLifecycle: Promise<void> = Promise.resolve()");
    expect(viewerWorkspaceSrc).toContain("function queueViewerLifecycle(");
    expect(viewerWorkspaceSrc).toContain("viewerLifecycle.then(operation, operation)");
    expect(viewerWorkspaceSrc).not.toContain("_globalDestroyPromise = null");
  });

  it("tracks an effect-owned session so stale cleanup cannot destroy a newer session", () => {
    expect(viewerWorkspaceSrc).toContain("let ownedSession: ViewerSession | null = null");
    expect(viewerWorkspaceSrc).toContain("const session = ownedSession");
    expect(viewerWorkspaceSrc).toContain("ownedSession = null");
    expect(viewerWorkspaceSrc).not.toContain("const s = sessionRef.current");
  });

  it("guards session callbacks and async start failures by active session identity", () => {
    expect(viewerWorkspaceSrc).toMatch(/session\.onStateChange = \(state: ViewerSessionState\) => \{[\s\S]*if \(sessionRef\.current !== session\) return;/);
    expect(viewerWorkspaceSrc).toMatch(/session\.onPauseStateChange = \(pauseState: ViewerPauseState\) => \{[\s\S]*if \(sessionRef\.current !== session\) return;/);
    expect(viewerWorkspaceSrc).toMatch(/session\.onPosterFrameChange = \(poster: string \| null\) => \{[\s\S]*if \(sessionRef\.current !== session\) return;/);
    expect(viewerWorkspaceSrc).toMatch(/session\.onError = \(error: string\) => \{[\s\S]*if \(sessionRef\.current !== session\) return;/);
    expect(viewerWorkspaceSrc).toMatch(/\.catch\(\(err: unknown\) => \{[\s\S]*if \(sessionRef\.current !== session\) return;/);
  });

  it("renders active viewing status from local session state and keeps error detail in dedicated local state", () => {
    expect(viewerWorkspaceSrc).toContain("const [viewerError, setViewerError] = useState<string | null>(null)");
    expect(viewerWorkspaceSrc).toContain("const displayStatus = sessionStateToViewStatus(sessionState)");
    expect(viewerWorkspaceSrc).not.toContain("const displayStatus = viewStatus || sessionStateToViewStatus(sessionState)");
    expect(viewerWorkspaceSrc).toContain("viewerError && (");
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
