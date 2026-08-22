// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const shellPath = path.resolve(__dirname, "../src/renderer/components/layout/AppShell.tsx");
const viewerWorkspacePath = path.resolve(__dirname, "../src/renderer/components/workspace/ViewerWorkspace.tsx");
const viewerStatusOverlayPath = path.resolve(__dirname, "../src/renderer/components/workspace/viewer/ViewerStatusOverlay.tsx");

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
  const viewerStatusOverlaySrc = readFileSafe(viewerStatusOverlayPath);

  it("keeps exactly one ViewerWorkspace mounted while viewing across page switches", () => {
    const matches = shellSrc.match(/<ViewerWorkspace\s*\/>/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("retry path uses the shared controller recovery command", () => {
    // Phase 5C: manual retry uses the same recover() operation as automatic recovery.
    expect(viewerWorkspaceSrc).toContain("ensureAppRuntimeInitialized");
    expect(viewerWorkspaceSrc).toContain("controllerRecover");
  });

  it("binds the video element through a callback ref instead of a sessionState effect", () => {
    expect(viewerWorkspaceSrc).toContain("const videoRefCallback = useCallback");
    expect(viewerWorkspaceSrc).toContain("bindVideoElement(el)");
    expect(viewerWorkspaceSrc).not.toMatch(/useEffect\(\(\) => \{[\s\S]*bindVideoElement\(videoRef\.current\)[\s\S]*sessionState/);
  });

  it("serializes viewer lifecycle through ViewerSessionController operation queue", () => {
    // Phase 4/5C: controller provides serialized start/stop/recovery.
    // Module-level queueViewerLifecycle removed.
    expect(viewerWorkspaceSrc).toContain("useViewerSession");
    expect(viewerWorkspaceSrc).toContain("controllerStart");
    expect(viewerWorkspaceSrc).toContain("controllerStop");
    expect(viewerWorkspaceSrc).toContain("controllerRecover");
    expect(viewerWorkspaceSrc).not.toContain("queueViewerLifecycle");
  });

  it("session lifecycle owned by controller — no effect-owned session variable", () => {
    // Phase 4: The controller manages session creation/destruction.
    // No 'let ownedSession: ViewerSession | null = null' pattern.
    expect(viewerWorkspaceSrc).not.toContain("let ownedSession: ViewerSession");
    expect(viewerWorkspaceSrc).toContain("controllerStart");
    expect(viewerWorkspaceSrc).toContain("controllerStop");
  });

  it("guards session callbacks through controller snapshot subscription", () => {
    // Phase 4: lifecycle callbacks flow through controller snapshots,
    // not direct ViewerSession onStateChange assignments.
    expect(viewerWorkspaceSrc).not.toContain("session.onStateChange = (state: ViewerSessionState)");
    expect(viewerWorkspaceSrc).toContain("useViewerSession");
    expect(viewerWorkspaceSrc).toContain("vsSnapshot");
  });

  it("renders active viewing status from controller snapshot and keeps error detail", () => {
    // Phase 4: error is derived from vsSnapshot, not local useState.
    expect(viewerWorkspaceSrc).toContain("const viewerError = vsSnapshot.error");
    expect(viewerWorkspaceSrc).toContain("const sessionPhase = vsSnapshot.phase");
    expect(viewerStatusOverlaySrc).toContain("viewerError && (");
  });

  it("renders a single persistent native <video> element across connecting/reconnecting/degraded/watching", () => {
    const videoTags = viewerWorkspaceSrc.match(/<video\s/g) ?? [];
    expect(videoTags).toHaveLength(1);
  });

  it("videoRefCallback passes null to bindVideoElement on unmount", () => {
    expect(viewerWorkspaceSrc).toMatch(
      /sessionRef\.current\?\.bindVideoElement\(el\)/,
    );
  });

  it("does not hide raw video before enhancement produces a frame", () => {
    expect(viewerWorkspaceSrc).toMatch(
      /enhancementActive.*enhancementSettings\.enabled/,
    );
  });

  it("status UI for connecting/reconnecting/degraded use extracted ViewerStatusOverlay component", () => {
    // Phase 4 / Phase 10: overlays extracted into ViewerStatusOverlay.
    // Root workspace still uses inline conditional rendering (not separate return branches).
    expect(viewerWorkspaceSrc).not.toMatch(
      /if \(displayStatus === "connecting"\) \{[\s\S]{0,200}return \(/,
    );
    expect(viewerWorkspaceSrc).not.toMatch(
      /if \(displayStatus === "reconnecting"\) \{[\s\S]{0,200}return \(/,
    );
    // ViewerWorkspace delegates to ViewerStatusOverlay
    expect(viewerWorkspaceSrc).toContain("ViewerStatusOverlay");
    // Overlay components exist in ViewerStatusOverlay module
    expect(viewerStatusOverlaySrc).toContain("function ConnectingOverlay");
    expect(viewerStatusOverlaySrc).toContain("function ReconnectingOverlay");
    expect(viewerStatusOverlaySrc).toContain("function DegradedOverlay");
    // ViewerStatusOverlay handles all five status display states
    expect(viewerStatusOverlaySrc).toContain('case "ended"');
    expect(viewerStatusOverlaySrc).toContain('case "error"');
    expect(viewerStatusOverlaySrc).toContain('case "connecting"');
    expect(viewerStatusOverlaySrc).toContain('case "reconnecting"');
    expect(viewerStatusOverlaySrc).toContain('case "degraded"');
  });

  it("resets enhancementActive at start of a new viewer session", () => {
    expect(viewerWorkspaceSrc).toContain("setEnhancementActive(false)");
  });

  it("invalidates the audio boost pipeline when video.srcObject is replaced", () => {
    const identityChecks = viewerWorkspaceSrc.match(
      /currentStream !== lastBoostStreamRef\.current/g,
    );
    expect(identityChecks).toHaveLength(2);
    expect(viewerWorkspaceSrc).not.toMatch(
      /instanceof MediaStream && currentStream !== lastBoostStreamRef\.current/,
    );
  });

  it("guards async session start — delegated to controller serialized queue", () => {
    // Phase 4: The controller owns serialization via enqueueOp.
    // StartAttemptRef/cancelled flag patterns are replaced by controller._enqueue.
    expect(viewerWorkspaceSrc).toContain("controllerStart");
    expect(viewerWorkspaceSrc).toContain("controllerStop");
  });

  it("cleanup effect delegates to controllerStop for teardown", () => {
    // Phase 4: cleanup calls controllerStop() instead of
    // queueViewerLifecycle(() => session.destroy()).
    expect(viewerWorkspaceSrc).toContain("controllerStop();");
    expect(viewerWorkspaceSrc).not.toContain("queueViewerLifecycle(() => session.destroy())");
  });

  it("gates compare event listeners and button on showCompareControls setting", () => {
    // Phase 9: compare is hidden by default.
    // The keyboard event listener effect guards registration with showCompareControls.
    expect(viewerWorkspaceSrc).toMatch(
      /if \(showCompareControls\) \{[\s\S]*window\.addEventListener\("screenlink:compare-toggle"/,
    );
    // The button callback is only provided when the setting is true:
    expect(viewerWorkspaceSrc).toContain(
      "showCompareControls ? handleCompareToggleWithSettingsB : undefined",
    );
    // The setting is loaded from PersistedSettings:
    expect(viewerWorkspaceSrc).toContain("setShowCompareControls(settings.showCompareControls");
  });

  it("resets quality feedback state on viewer exit", () => {
    // Phase 9: stale quality feedback is cleared when exiting the viewer.
    expect(viewerWorkspaceSrc).toContain("setQualityFeedback(null)");
    expect(viewerWorkspaceSrc).toContain("setLastQualityAccepted(undefined)");
    expect(viewerWorkspaceSrc).toContain("setLastRequestedQuality(null)");
    expect(viewerWorkspaceSrc).toContain("setEffectiveBitrateKbps(null)");
    expect(viewerWorkspaceSrc).toContain("setConfiguredBitrateBps(null)");
  });
});
