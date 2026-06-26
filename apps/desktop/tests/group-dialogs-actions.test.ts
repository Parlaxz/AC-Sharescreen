// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useStore } from "../src/renderer/stores/main-store.js";

const mockGetRuntime = vi.fn();

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: mockGetRuntime,
}));

/**
 * Mock the preload window.screenlink API used by dialog actions.
 */
function mockPreloadApi(overrides: Record<string, unknown> = {}) {
  const api = {
    createGroup: vi.fn().mockResolvedValue({
      record: {
        groupId: "new-group-uuid",
        controlRoomId: "room-1",
        encryptedGroupSecret: "encrypted-placeholder",
        sharedState: {
          name: { value: "Test Group" },
          members: {},
        },
        lastClock: { wallTimeMs: 1, counter: 0, nodeId: "dev-1" },
        joinedAt: 1,
        notificationsEnabled: true,
      },
      invite: {},
      link: "invite-code-1",
    }),
    joinGroup: vi.fn().mockResolvedValue({
      groupId: "joined-group-uuid",
      controlRoomId: "room-2",
      encryptedGroupSecret: "encrypted-placeholder",
      sharedState: {
        name: { value: "Joined Group" },
        members: { "dev-1": { deviceId: "dev-1", displayName: "Me" } },
      },
      lastClock: { wallTimeMs: 1, counter: 0, nodeId: "dev-1" },
      joinedAt: 1,
      notificationsEnabled: true,
    }),
    getDeviceIdentity: vi.fn().mockResolvedValue({
      deviceId: "dev-1",
      displayName: "Me",
      createdAt: 1,
    }),
    getGroupConnectionConfig: vi.fn().mockResolvedValue({
      groupId: "new-group-uuid",
      controlRoomId: "room-1",
      groupSecret: "secret-1",
      nodeId: "dev-1",
    }),
    listQualityPresets: vi.fn().mockResolvedValue([
      { id: "p1", name: "Preset One", settings: {} },
      { id: "p2", name: "Preset Two", settings: {} },
    ]),
    ...overrides,
  };
  Object.defineProperty(globalThis, "window", {
    value: { screenlink: api },
    writable: true,
    configurable: true,
  });
  return api;
}

function restoreWindow() {
  delete (globalThis as any).window;
}

describe("Group dialog actions", () => {
  beforeEach(() => {
    useStore.getState().reset();
    mockGetRuntime.mockReturnValue({
      isDestroyed: () => false,
      addGroup: vi.fn().mockResolvedValue(undefined),
      removeGroup: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  // ── createGroup action ─────────────────────────────────────────

  it("creates a group via preload API and updates store on success", async () => {
    const runtime = { isDestroyed: () => false, addGroup: vi.fn().mockResolvedValue(undefined) };
    mockGetRuntime.mockReturnValue(runtime);
    const api = mockPreloadApi({
      getGroupConnectionConfig: vi.fn().mockResolvedValue({
        groupId: "new-group-uuid",
        controlRoomId: "room-1",
        groupSecret: "secret-1",
        nodeId: "dev-1",
      }),
    });
    const { createGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );

    const groupId = await createGroupAction("My New Group");

    expect(api.createGroup).toHaveBeenCalledWith({ groupName: "My New Group" });

    // Store should now have the new group
    const state = useStore.getState();
    expect(state.groupsById[groupId]).toBeDefined();
    expect(state.groupsById[groupId].name).toBe("Test Group");
    expect(state.groupOrder).toContain(groupId);
    expect(runtime.addGroup).toHaveBeenCalledTimes(1);
    // Should auto-select and navigate
    expect(state.selectedGroupId).toBe(groupId);
    expect(state.currentPage).toBe("overview");
  });

  it("createGroup rejects when API fails", async () => {
    mockPreloadApi({
      createGroup: vi.fn().mockRejectedValue(new Error("API error")),
    });
    const { createGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );

    await expect(createGroupAction("Fail Group")).rejects.toThrow("API error");
  });

  it("createGroup rejects when preload API is unavailable", async () => {
    // Don't set up window.screenlink
    restoreWindow();
    const { createGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );

    await expect(createGroupAction("No API")).rejects.toThrow(
      "screenlink API not available",
    );
  });

  // ── joinGroup action ───────────────────────────────────────────

  it("joins a group via preload API and updates store on success", async () => {
    const runtime = { isDestroyed: () => false, addGroup: vi.fn().mockResolvedValue(undefined) };
    mockGetRuntime.mockReturnValue(runtime);
    const api = mockPreloadApi({
      getGroupConnectionConfig: vi.fn().mockResolvedValue({
        groupId: "joined-group-uuid",
        controlRoomId: "room-2",
        groupSecret: "secret-2",
        nodeId: "dev-1",
      }),
    });
    const { joinGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );

    const groupId = await joinGroupAction("invite-code-abc");

    expect(api.joinGroup).toHaveBeenCalledWith({ link: "invite-code-abc" });

    const state = useStore.getState();
    expect(state.groupsById[groupId]).toBeDefined();
    expect(state.groupsById[groupId].name).toBe("Joined Group");
    expect(state.groupOrder).toContain(groupId);
    expect(runtime.addGroup).toHaveBeenCalledTimes(1);
    expect(state.selectedGroupId).toBe(groupId);
    expect(state.currentPage).toBe("overview");
  });

  it("joinGroup rejects when API fails", async () => {
    mockPreloadApi({
      joinGroup: vi.fn().mockRejectedValue(new Error("Invalid invite link")),
    });
    const { joinGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );

    await expect(
      joinGroupAction("invalid-link"),
    ).rejects.toThrow("Invalid invite link");
  });

  it("joinGroup rejects when preload API is unavailable", async () => {
    restoreWindow();
    const { joinGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );

    await expect(joinGroupAction("some-link")).rejects.toThrow(
      "screenlink API not available",
    );
  });

  // ── listQualityPresets action ───────────────────────────────────

  it("fetches quality presets via preload API", async () => {
    const api = mockPreloadApi();
    const { fetchQualityPresets } = await import(
      "../src/renderer/services/group-actions.js"
    );

    const presets = await fetchQualityPresets();

    expect(api.listQualityPresets).toHaveBeenCalled();
    expect(presets).toHaveLength(2);
    expect(presets[0].name).toBe("Preset One");
  });

  it("fetchQualityPresets rejects when API fails", async () => {
    mockPreloadApi({
      listQualityPresets: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const { fetchQualityPresets } = await import(
      "../src/renderer/services/group-actions.js"
    );

    await expect(fetchQualityPresets()).rejects.toThrow("DB error");
  });
});
