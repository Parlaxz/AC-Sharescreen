// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/renderer/stores/main-store.js";

const mockGetRuntime = vi.fn();

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: mockGetRuntime,
}));

describe("share coordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.getState().reset();
    useStore.getState().setSelectedGroupId("group-1");
  });

  it("starts a share through StreamSessionManager and syncs store state", async () => {
    const startStream = vi.fn().mockResolvedValue(undefined);
    mockGetRuntime.mockReturnValue({
      getStreamSessionManager: () => ({
        startStream,
        getActualCaptureDimensions: () => ({ width: 1920, height: 1080, fps: 30 }),
        isAudioDegraded: true,
      }),
    });

    const { startShare } = await import("../src/renderer/services/share-coordinator.js");

    await startShare({
      groupId: "group-1",
      source: {
        id: "screen:1",
        name: "Display 1",
        kind: "screen",
        displayId: "display-1",
        fingerprint: null,
      },
    });

    expect(startStream).toHaveBeenCalledWith({
      groupId: "group-1",
      source: {
        id: "screen:1",
        name: "Display 1",
        kind: "screen",
        displayId: "display-1",
        fingerprint: null,
      },
    });

    const state = useStore.getState();
    expect(state.isSharing).toBe(true);
    expect(state.localShareState).toBe("sharing");
    expect(state.captureWidth).toBe(1920);
    expect(state.captureHeight).toBe(1080);
    expect(state.captureFps).toBe(30);
    expect(state.isDegraded).toBe(true);
  });

  it("rejects starting when no group is provided", async () => {
    const { startShare } = await import("../src/renderer/services/share-coordinator.js");

    await expect(
      startShare({
        groupId: "",
        source: {
          id: "screen:1",
          name: "Display 1",
          kind: "screen",
          displayId: "display-1",
          fingerprint: null,
        },
      }),
    ).rejects.toThrow(/group id/i);

    expect(useStore.getState().localShareState).toBe("error");
    expect(useStore.getState().isSharing).toBe(false);
  });

  it("rejects starting when runtime is unavailable", async () => {
    mockGetRuntime.mockReturnValue(null);
    const { startShare } = await import("../src/renderer/services/share-coordinator.js");

    await expect(
      startShare({
        groupId: "group-1",
        source: {
          id: "window:1",
          name: "App Window",
          kind: "window",
          displayId: null,
          fingerprint: null,
        },
      }),
    ).rejects.toThrow("Phase3 runtime not available");

    expect(useStore.getState().localShareState).toBe("error");
  });

  it("stops a share through StreamSessionManager and clears local state", async () => {
    useStore.setState({
      isSharing: true,
      localShareState: "sharing",
      isDegraded: true,
    });
    const stopStream = vi.fn().mockResolvedValue(undefined);
    mockGetRuntime.mockReturnValue({
      getStreamSessionManager: () => ({ stopStream }),
    });
    const { stopShare } = await import("../src/renderer/services/share-coordinator.js");

    await stopShare();

    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(useStore.getState().isSharing).toBe(false);
    expect(useStore.getState().localShareState).toBe("idle");
    expect(useStore.getState().isDegraded).toBe(false);
  });

  it("resets store when runtime is unavailable during stop", async () => {
    useStore.setState({
      isSharing: true,
      localShareState: "sharing",
      isDegraded: true,
    });
    mockGetRuntime.mockReturnValue(null);
    const { stopShare } = await import("../src/renderer/services/share-coordinator.js");

    await stopShare();

    expect(useStore.getState().isSharing).toBe(false);
    expect(useStore.getState().localShareState).toBe("idle");
    expect(useStore.getState().isDegraded).toBe(false);
  });
});
