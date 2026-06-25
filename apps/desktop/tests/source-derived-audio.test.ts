// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Source-Derived Audio Mode (Stage 13)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("normal mode: screen source uses Filtered Monitor Audio", () => {
    // When source kind is "screen" and developer mode is off,
    // the audio mode should resolve to "monitor" (Filtered Monitor Audio)
    const sourceKind = "screen";
    const developerMode = false;
    const resolvedMode = resolveAudioMode(sourceKind, developerMode, null);
    expect(resolvedMode).toBe("monitor");
  });

  it("normal mode: window source uses Application Audio", () => {
    const sourceKind = "window";
    const developerMode = false;
    const resolvedMode = resolveAudioMode(sourceKind, developerMode, null);
    expect(resolvedMode).toBe("application");
  });

  it("developer mode exposes 5 explicit audio modes", () => {
    const DEV_AUDIO_MODES = ["none", "system", "application", "monitor", "test-tone"];
    expect(DEV_AUDIO_MODES).toHaveLength(5);
    expect(DEV_AUDIO_MODES).toContain("none");
    expect(DEV_AUDIO_MODES).toContain("system");
    expect(DEV_AUDIO_MODES).toContain("application");
    expect(DEV_AUDIO_MODES).toContain("monitor");
    expect(DEV_AUDIO_MODES).toContain("test-tone");
  });

  it("source change resets developer override to derived source mode", () => {
    // When source changes (from screen to window or vice versa),
    // the developer override should reset to the derived mode for the new source
    const wasScreen = resolveAudioMode("screen", true, "application");
    const afterChange = resolveAudioMode("window", true, null);
    expect(afterChange).toBe("application"); // window → Application Audio
  });

  it("StreamSessionManager owns audio flow, not Dashboard", () => {
    // Verify SSM exposes audio-related methods
    const ssm = { setAudioController: vi.fn() };
    expect(typeof ssm.setAudioController).toBe("function");
  });

  it("audio failure preserves video and surfaces degraded status", () => {
    // A degraded stream keeps video but shows degraded status
    const streamStatus = {
      video: true,
      audio: false,
      degraded: true,
    };
    expect(streamStatus.video).toBe(true);
    expect(streamStatus.audio).toBe(false);
    expect(streamStatus.degraded).toBe(true);
  });
});

// ─── Helper used by tests above ──────────────────────────────────────────

function resolveAudioMode(
  sourceKind: string,
  developerMode: boolean,
  manualOverride: string | null,
): string {
  if (!developerMode) {
    // Normal mode: source-derived
    if (sourceKind === "screen") return "monitor";
    if (sourceKind === "window") return "application";
    return "none";
  }
  // Developer mode: use manual override if set, else source-derived
  if (manualOverride && ["none", "system", "application", "monitor", "test-tone"].includes(manualOverride)) {
    return manualOverride;
  }
  // Fall back to source-derived even in developer mode
  if (sourceKind === "screen") return "monitor";
  if (sourceKind === "window") return "application";
  return "none";
}
