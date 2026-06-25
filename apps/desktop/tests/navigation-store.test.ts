// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import {
  useStore,
  type Page,
  type GroupNavPage,
} from "../src/renderer/stores/main-store.js";

describe("Navigation store model", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("initializes with home as the default page", () => {
    const state = useStore.getState();
    expect(state.currentPage).toBe("home");
  });

  it("navigate sets currentPage", () => {
    useStore.getState().navigate("overview");
    expect(useStore.getState().currentPage).toBe("overview");
  });

  it("navigate to home does not clear selectedGroupId", () => {
    useStore.getState().setSelectedGroupId("group-1");
    useStore.getState().navigate("home");
    expect(useStore.getState().selectedGroupId).toBe("group-1");
  });

  it("navigate to overview does not clear selectedGroupId", () => {
    useStore.getState().setSelectedGroupId("group-1");
    useStore.getState().navigate("overview");
    expect(useStore.getState().selectedGroupId).toBe("group-1");
  });

  it("setGroupNavPage only sets groupNavPage without changing currentPage", () => {
    useStore.getState().navigate("home");
    useStore.getState().setGroupNavPage("overview");
    const state = useStore.getState();
    expect(state.groupNavPage).toBe("overview");
    // The setGroupNavPage should NOT change currentPage
    expect(state.currentPage).toBe("home");
  });

  it("GroupNavPage type excludes active-shares and members", () => {
    const validPages: GroupNavPage[] = [
      "overview",
      "group-presets",
      "group-settings",
    ];
    expect(validPages).toHaveLength(3);
    for (const page of validPages) {
      useStore.getState().setGroupNavPage(page);
      expect(useStore.getState().groupNavPage).toBe(page);
    }
  });

  it("currentPage supports all required page values", () => {
    const pages: Page[] = [
      "home",
      "overview",
      "host",
      "viewer",
      "share-setup",
      "group-presets",
      "group-settings",
      "user-settings",
      "diagnostics",
      "about",
    ];
    for (const page of pages) {
      useStore.getState().navigate(page);
      expect(useStore.getState().currentPage).toBe(page);
    }
  });

  it("user-settings and group-settings are distinct page values", () => {
    useStore.getState().navigate("user-settings");
    expect(useStore.getState().currentPage).toBe("user-settings");

    useStore.getState().navigate("group-settings");
    expect(useStore.getState().currentPage).toBe("group-settings");
    expect(useStore.getState().currentPage).not.toBe("user-settings");
  });

  // ── Create/Join group dialog state ───────────────────────────────

  it("openCreateGroupDialog starts as false", () => {
    expect(useStore.getState().openCreateGroupDialog).toBe(false);
  });

  it("setOpenCreateGroupDialog toggles state", () => {
    useStore.getState().setOpenCreateGroupDialog(true);
    expect(useStore.getState().openCreateGroupDialog).toBe(true);
    useStore.getState().setOpenCreateGroupDialog(false);
    expect(useStore.getState().openCreateGroupDialog).toBe(false);
  });

  it("openJoinGroupDialog starts as false", () => {
    expect(useStore.getState().openJoinGroupDialog).toBe(false);
  });

  it("setOpenJoinGroupDialog toggles state", () => {
    useStore.getState().setOpenJoinGroupDialog(true);
    expect(useStore.getState().openJoinGroupDialog).toBe(true);
    useStore.getState().setOpenJoinGroupDialog(false);
    expect(useStore.getState().openJoinGroupDialog).toBe(false);
  });

  it("both dialog states can be independently toggled", () => {
    useStore.getState().setOpenCreateGroupDialog(true);
    useStore.getState().setOpenJoinGroupDialog(true);
    expect(useStore.getState().openCreateGroupDialog).toBe(true);
    expect(useStore.getState().openJoinGroupDialog).toBe(true);
    useStore.getState().setOpenCreateGroupDialog(false);
    expect(useStore.getState().openCreateGroupDialog).toBe(false);
    expect(useStore.getState().openJoinGroupDialog).toBe(true);
  });

  it("homeNavigate opens home page", () => {
    useStore.getState().navigate("overview");
    useStore.getState().homeNavigate();
    expect(useStore.getState().currentPage).toBe("home");
  });

  it("homeNavigate does not clear selectedGroupId", () => {
    useStore.getState().setSelectedGroupId("group-1");
    useStore.getState().homeNavigate();
    expect(useStore.getState().selectedGroupId).toBe("group-1");
  });

  it("selectGroup opens overview for the given group", () => {
    useStore.getState().selectGroup("group-a");
    const state = useStore.getState();
    expect(state.selectedGroupId).toBe("group-a");
    expect(state.currentPage).toBe("overview");
  });

  it("selectedGroupId can be set independently from currentPage", () => {
    useStore.getState().navigate("home");
    useStore.getState().setSelectedGroupId("group-a");
    expect(useStore.getState().selectedGroupId).toBe("group-a");
    expect(useStore.getState().currentPage).toBe("home");

    useStore.getState().navigate("user-settings");
    expect(useStore.getState().selectedGroupId).toBe("group-a");
    expect(useStore.getState().currentPage).toBe("user-settings");
  });
});
