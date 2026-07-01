// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/renderer/stores/main-store.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockStopShare = vi.fn();

vi.mock("../src/renderer/services/share-coordinator.js", () => ({
  startShare: vi.fn(),
  stopShare: mockStopShare,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStream(overrides: Partial<StreamAnnouncement> = {}): StreamAnnouncement {
  return {
    logicalStreamId: "stream-1",
    mediaSessionId: "session-1",
    groupId: "group-1",
    hostDeviceId: "device-2",
    hostDisplayName: "Other User",
    sourceKind: "screen",
    sourceName: "Display 1",
    startedAt: 1000,
    appliedSettingsRevision: 1,
    heartbeatSequence: 1,
    replacesSessionId: null,
    ...overrides,
  };
}

// Avoid importing the TS type at module level to keep the mock hoisting clean.
type StreamAnnouncement = {
  logicalStreamId: string;
  mediaSessionId: string;
  groupId: string;
  hostDeviceId: string;
  hostDisplayName: string;
  sourceKind: string;
  sourceName: string;
  startedAt: number;
  appliedSettingsRevision: number;
  heartbeatSequence: number;
  replacesSessionId: string | null;
};

// ─── executeQuickShare toggle ────────────────────────────────────────────────

describe("executeQuickShare toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.getState().reset();
    useStore.setState({
      groupsById: {
        "group-1": { id: "group-1", name: "Test Group", members: {} },
      },
    });
  });

  it("calls stopShare when already sharing in the same group", async () => {
    useStore.setState({ isSharing: true, sharingGroupId: "group-1" });

    const { executeQuickShare } = await import(
      "../src/renderer/services/group-shortcut-service.js"
    );

    await executeQuickShare("group-1");

    expect(mockStopShare).toHaveBeenCalledTimes(1);
  });

  it("does NOT call stopShare when sharing in a different group", async () => {
    useStore.setState({ isSharing: true, sharingGroupId: "group-other" });

    const { executeQuickShare } = await import(
      "../src/renderer/services/group-shortcut-service.js"
    );

    await executeQuickShare("group-1");

    expect(mockStopShare).not.toHaveBeenCalled();
  });
});

// ─── executeQuickJoin toggle ─────────────────────────────────────────────────

describe("executeQuickJoin toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.getState().reset();
    useStore.setState({
      groupsById: {
        "group-1": { id: "group-1", name: "Test Group", members: {} },
      },
      activeStreamsByGroup: {
        "group-1": [makeStream()],
      },
    });
  });

  it("clears store state when already watching the selected stream", async () => {
    useStore.setState({
      isViewing: true,
      viewStatus: "connected",
      watchingTarget: {
        groupId: "group-1",
        logicalStreamId: "stream-1",
        mediaSessionId: "session-1",
        hostDeviceId: "device-2",
        hostName: "Other User",
        startedAt: 1000,
        sourceName: "Display 1",
        sourceKind: "screen",
      },
    });

    const { executeQuickJoin } = await import(
      "../src/renderer/services/group-shortcut-service.js"
    );

    await executeQuickJoin("group-1");

    const state = useStore.getState();
    expect(state.isViewing).toBe(false);
    expect(state.watchingTarget).toBeNull();
    expect(state.viewStatus).toBe("");
  });
});
