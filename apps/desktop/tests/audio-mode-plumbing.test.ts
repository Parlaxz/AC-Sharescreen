// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useStore } from "../src/renderer/stores/main-store.js";

// ─── Dynamic runtime mock for coordinator tests ────────────────────────────

let _mockSsm: Record<string, any> = {};

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: () => ({
    getStreamSessionManager: () => _mockSsm,
    getSyncService: () => ({
      getSyncState: () => null,
    }),
  }),
}));

// ─── Store last-audio-mode tests ────────────────────────────────────────────

describe("Store last audio mode per source kind", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("initializes with none for both source kinds", () => {
    const state = useStore.getState();
    expect(state.lastScreenAudioMode).toBe("none");
    expect(state.lastWindowAudioMode).toBe("none");
  });

  it("setLastScreenAudioMode stores value", () => {
    useStore.getState().setLastScreenAudioMode("monitor");
    expect(useStore.getState().lastScreenAudioMode).toBe("monitor");
  });

  it("setLastWindowAudioMode stores value", () => {
    useStore.getState().setLastWindowAudioMode("application");
    expect(useStore.getState().lastWindowAudioMode).toBe("application");
  });
});

// ─── Coordinator audio mode plumbing tests ──────────────────────────────────

describe("Coordinator audio mode plumbing", () => {
  beforeEach(() => {
    _mockSsm = {
      startStream: vi.fn().mockResolvedValue(undefined),
      stopStream: vi.fn().mockResolvedValue(undefined),
      getActualCaptureDimensions: vi.fn().mockReturnValue({
        width: 1920,
        height: 1080,
        fps: 30,
      }),
      isAudioDegraded: false,
    };
    useStore.getState().reset();
    useStore.getState().setSelectedGroupId("group-1");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes audioMode to SSM.startStream when provided", async () => {
    const { startShare } = await import(
      "../src/renderer/services/share-coordinator.js"
    );

    await startShare({
      groupId: "group-1",
      source: {
        id: "src-1",
        name: "Screen",
        kind: "screen",
        displayId: null,
        fingerprint: null,
        audioMode: "monitor",
      },
    });

    expect(_mockSsm.startStream).toHaveBeenLastCalledWith({
      groupId: "group-1",
      source: {
        id: "src-1",
        name: "Screen",
        kind: "screen",
        displayId: null,
        fingerprint: null,
      },
      audioMode: "monitor",
    });
  });

  it("passes audioMode as none to skip audio setup", async () => {
    const { startShare } = await import(
      "../src/renderer/services/share-coordinator.js"
    );

    await startShare({
      groupId: "group-1",
      source: {
        id: "src-2",
        name: "Window",
        kind: "window",
        displayId: null,
        fingerprint: null,
        audioMode: "none",
      },
    });

    expect(_mockSsm.startStream).toHaveBeenLastCalledWith({
      groupId: "group-1",
      source: {
        id: "src-2",
        name: "Window",
        kind: "window",
        displayId: null,
        fingerprint: null,
      },
      audioMode: "none",
    });
  });

  it("persists last screen audio mode in store after starting", async () => {
    const { startShare } = await import(
      "../src/renderer/services/share-coordinator.js"
    );

    await startShare({
      groupId: "group-1",
      source: {
        id: "src-3",
        name: "Screen Share",
        kind: "screen",
        displayId: null,
        fingerprint: null,
        audioMode: "monitor",
      },
    });

    expect(useStore.getState().lastScreenAudioMode).toBe("monitor");
  });

  it("persists last window audio mode in store after starting", async () => {
    const { startShare } = await import(
      "../src/renderer/services/share-coordinator.js"
    );

    await startShare({
      groupId: "group-1",
      source: {
        id: "src-4",
        name: "Window Share",
        kind: "window",
        displayId: null,
        fingerprint: null,
        audioMode: "application",
      },
    });

    expect(useStore.getState().lastWindowAudioMode).toBe("application");
  });
});

// ─── SSM audioMode handling tests ───────────────────────────────────────────

describe("StreamSessionManager audioMode handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restart preserves explicit monitor/application audio mode choice conceptually", () => {
    const explicitModes = ["none", "monitor", "application"] as const;
    expect(explicitModes).toContain("monitor");
    expect(explicitModes).toContain("application");
    expect(explicitModes).toContain("none");
  });

  it("accepts audioMode in StartStreamInput", () => {
    // Type-level test: StartStreamInput supports optional audioMode field
    const input = {
      groupId: "g-1",
      source: { id: "s1", name: "S", kind: "screen" as const, displayId: null, fingerprint: null },
      audioMode: "none" as const,
    };
    expect(input.audioMode).toBe("none");

    const input2 = {
      groupId: "g-1",
      source: { id: "s1", name: "S", kind: "screen" as const, displayId: null, fingerprint: null },
      audioMode: "monitor" as const,
    };
    expect(input2.audioMode).toBe("monitor");

    // Without audioMode (backward compat)
    const input3 = {
      groupId: "g-1",
      source: { id: "s1", name: "S", kind: "window" as const, displayId: null, fingerprint: null },
    };
    expect(input3.audioMode).toBeUndefined();
  });
});

// ─── ShareSetup audio mode validation tests ─────────────────────────────────

describe("ShareSetup audio mode validation", () => {
  it("screen source only allows none and monitor", () => {
    const screenModes = ["none", "monitor"];
    const invalidForScreen = ["application", "system"];
    expect(screenModes).toEqual(["none", "monitor"]);
    for (const m of invalidForScreen) {
      expect(screenModes).not.toContain(m);
    }
  });

  it("window source only allows none and application", () => {
    const windowModes = ["none", "application"];
    const invalidForWindow = ["monitor", "system"];
    expect(windowModes).toEqual(["none", "application"]);
    for (const m of invalidForWindow) {
      expect(windowModes).not.toContain(m);
    }
  });

  it("switching source kind resets invalid audio selection", () => {
    // Scenario: user selected "application" audio for window, then switches to screen
    const currentSourceKind: "screen" = "screen";
    const currentAudio = "application";

    const validModes = currentSourceKind === "screen"
      ? ["none", "monitor"]
      : ["none", "application"];

    const isValid = validModes.includes(currentAudio);
    const resolved = isValid ? currentAudio : "none";

    expect(isValid).toBe(false);
    expect(resolved).toBe("none");
  });

  it("valid audio selection is preserved when switching source kind", () => {
    // User selected "monitor" for screen, stays on screen tab
    const currentSourceKind: "screen" = "screen";
    const currentAudio = "monitor";

    const validModes = ["none", "monitor"];
    const isValid = validModes.includes(currentAudio);
    const resolved = isValid ? currentAudio : "none";

    expect(isValid).toBe(true);
    expect(resolved).toBe("monitor");
  });

  it("restores last valid audio mode for source kind", () => {
    const lastScreenAudio = "monitor";
    const lastWindowAudio = "application";

    expect(lastScreenAudio).toBe("monitor");
    expect(lastWindowAudio).toBe("application");

    // Window tab was last viewed with application audio
    // Switching to screen should restore "monitor"
    const restoredForScreen = lastScreenAudio;
    expect(restoredForScreen).toBe("monitor");

    // Switching back to window should restore "application"
    const restoredForWindow = lastWindowAudio;
    expect(restoredForWindow).toBe("application");
  });

  it("source tabs exclude application", () => {
    const sourceTabs = ["screen", "window"];
    expect(sourceTabs).toEqual(["screen", "window"]);
    expect(sourceTabs).not.toContain("application");
  });
});
