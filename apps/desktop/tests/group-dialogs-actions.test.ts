// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useStore } from "../src/renderer/stores/main-store.js";

/**
 * Mock the preload window.screenlink API used by dialog actions.
 */
function mockPreloadApi(overrides: Record<string, unknown> = {}) {
  const api = {
    createGroup: vi.fn().mockResolvedValue({
      groupId: "new-group-uuid",
      sharedState: {
        name: { value: "Test Group" },
        members: {},
      },
    }),
    joinGroup: vi.fn().mockResolvedValue({
      groupId: "joined-group-uuid",
      sharedState: {
        name: { value: "Joined Group" },
        members: { "dev-1": { deviceId: "dev-1", displayName: "Me" } },
      },
    }),
    listQualityPresets: vi.fn().mockResolvedValue([
      { id: "p1", name: "Balanced", settings: {} },
      { id: "p2", name: "Data Saver", settings: {} },
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
  });

  afterEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  // ── createGroup action ─────────────────────────────────────────

  it("creates a group via preload API and updates store on success", async () => {
    const api = mockPreloadApi();
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
    const api = mockPreloadApi();
    const { joinGroupAction } = await import(
      "../src/renderer/services/group-actions.js"
    );

    const groupId = await joinGroupAction("https://screenlink.app/invite/abc");

    expect(api.joinGroup).toHaveBeenCalledWith({ link: "https://screenlink.app/invite/abc" });

    const state = useStore.getState();
    expect(state.groupsById[groupId]).toBeDefined();
    expect(state.groupsById[groupId].name).toBe("Joined Group");
    expect(state.groupOrder).toContain(groupId);
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
    expect(presets[0].name).toBe("Balanced");
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
