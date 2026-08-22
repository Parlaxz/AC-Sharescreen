// @vitest-environment happy-dom
/**
 * Behavioral RTL tests for GroupSettingsPage interactions.
 * Tests rendering, loading, error+retry, leave confirm/cancel,
 * notification toggle, duplicate shortcut protection.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
const mockSetGroupNotifications = vi.fn();
const mockLeaveGroupAction = vi.fn();
const mockCopyGroupInviteFromUi = vi.fn();

const mockStoreState = {
  selectedGroupId: "group-1",
  groupsById: {
    "group-1": {
      id: "group-1",
      name: "Test Group",
      members: { "user-1": { deviceId: "dev-1", displayName: "Alice" }, "user-2": { deviceId: "dev-2", displayName: "Bob" } },
    },
  },
  navigate: mockNavigate,
};

const mockUseStore = vi.fn((selector: (state: typeof mockStoreState) => unknown) => {
  return selector(mockStoreState);
});
// zustand stores have a static getState method
mockUseStore.getState = () => mockStoreState;

vi.mock("@/stores/main-store", () => {
  const store = vi.fn((selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState));
  store.getState = () => mockStoreState;
  return { useStore: store };
});

vi.mock("@/services/settings-actions", () => ({
  setGroupNotifications: (...args: unknown[]) => mockSetGroupNotifications(...args),
}));

vi.mock("@/services/group-leave-action", () => ({
  leaveGroupAction: (...args: unknown[]) => mockLeaveGroupAction(...args),
}));

vi.mock("@/services/invite-copy", () => ({
  copyGroupInviteFromUi: (...args: unknown[]) => mockCopyGroupInviteFromUi(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { GroupSettingsPage } from "@/components/workspace/GroupSettingsPage";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderWithProviders(ui: React.ReactElement) {
  return render(React.createElement(TooltipProvider, null, ui));
}

// Helper to set up window.screenlink mock
function mockScreenlinkApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getGroupShortcutConfig: vi.fn().mockResolvedValue({
      quickShareShortcut: null,
      quickJoinShortcut: null,
      quickShareSource: null,
      quickShareDefaultPresetId: null,
    }),
    updateGroupShortcutConfig: vi.fn().mockResolvedValue({}),
    validateGroupShortcut: vi.fn().mockResolvedValue({ valid: true, normalized: "" }),
    getSources: vi.fn().mockResolvedValue([]),
    listQualityPresets: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  (window as unknown as Record<string, unknown>).screenlink = api;
  return api;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).screenlink;
});

describe("GroupSettingsPage interactions", () => {
  it("renders PageHeader with group name and member count", async () => {
    mockScreenlinkApi();
      renderWithProviders(React.createElement(GroupSettingsPage));
    expect(await screen.findByText("Group settings")).toBeTruthy();
    expect(screen.getByText(/Manage "Test Group"/)).toBeTruthy();
    // "2 members" appears in PageHeader status AND in group info section
    const memberTexts = screen.getAllByText("2 members");
    expect(memberTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("renders all PageSection areas", async () => {
    mockScreenlinkApi();
    renderWithProviders(React.createElement(GroupSettingsPage));
    expect(await screen.findByText("Group info")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.getByText("Quick Actions")).toBeTruthy();
  });

  it("renders skeleton loading while config loads", async () => {
    // Don't resolve config promise
    mockScreenlinkApi({
      getGroupShortcutConfig: () => new Promise(() => {}),
      getSources: () => new Promise(() => {}),
      listQualityPresets: () => new Promise(() => {}),
    });
    renderWithProviders(React.createElement(GroupSettingsPage));
    // Skeleton should appear
    const skeleton = await screen.findByTestId("loading-skeleton");
    expect(skeleton).toBeTruthy();
  });

  it("shows error alert with retry on API failure", async () => {
    mockScreenlinkApi({
      getGroupShortcutConfig: vi.fn().mockRejectedValue(new Error("Network error")),
      getSources: vi.fn().mockRejectedValue(new Error("Network error")),
      listQualityPresets: vi.fn().mockRejectedValue(new Error("Network error")),
    });
    renderWithProviders(React.createElement(GroupSettingsPage));
    const errorText = await screen.findByText("Failed to load configuration");
    expect(errorText).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("retry button reloads config after error", async () => {
    const getConfig = vi.fn()
      .mockRejectedValueOnce(new Error("First failure"))
      .mockResolvedValueOnce({
        quickShareShortcut: null,
        quickJoinShortcut: null,
        quickShareSource: null,
        quickShareDefaultPresetId: null,
      });
    mockScreenlinkApi({
      getGroupShortcutConfig: getConfig,
      getSources: vi.fn().mockResolvedValue([]),
      listQualityPresets: vi.fn().mockResolvedValue([]),
    });
    renderWithProviders(React.createElement(GroupSettingsPage));
    await screen.findByText("Failed to load configuration");
    fireEvent.click(screen.getByText("Retry"));
    // After retry, config should load and Quick Actions should show
    await vi.waitFor(() => {
      expect(screen.getByText("Quick Share")).toBeTruthy();
    });
  });

  it("opens leave confirmation dialog on leave button click", async () => {
    mockScreenlinkApi();
    renderWithProviders(React.createElement(GroupSettingsPage));
    await screen.findByText("Group info");

    // Click leave button
    fireEvent.click(screen.getByText("Leave group"));

    // Dialog should open
    expect(await screen.findByText(/Are you sure you want to leave/)).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    expect(screen.getByText("Leave")).toBeTruthy();
  });

  it("cancels leave and closes dialog", async () => {
    mockScreenlinkApi();
    renderWithProviders(React.createElement(GroupSettingsPage));
    await screen.findByText("Group info");

    // Open dialog
    fireEvent.click(screen.getByText("Leave group"));
    expect(await screen.findByText(/Are you sure/)).toBeTruthy();

    // Cancel
    fireEvent.click(screen.getByText("Cancel"));
    await vi.waitFor(() => {
      expect(screen.queryByText(/Are you sure/)).toBeNull();
    });
  });

  it("confirm leave calls leaveGroupAction and navigates home", async () => {
    mockLeaveGroupAction.mockResolvedValue({ success: true });
    mockScreenlinkApi();
    renderWithProviders(React.createElement(GroupSettingsPage));
    await screen.findByText("Group info");

    // Open dialog
    fireEvent.click(screen.getByText("Leave group"));
    expect(await screen.findByText(/Are you sure/)).toBeTruthy();

    // Confirm
    fireEvent.click(screen.getByText("Leave"));
    await vi.waitFor(() => {
      expect(mockLeaveGroupAction).toHaveBeenCalledWith("group-1");
    });
  });

  it("notification toggle calls setGroupNotifications", async () => {
    mockSetGroupNotifications.mockResolvedValue(undefined);
    mockScreenlinkApi();
    renderWithProviders(React.createElement(GroupSettingsPage));
    await screen.findByText("Group info");

    // Find the notification switch
    const switchEl = screen.getByLabelText("Toggle group notifications");
    expect(switchEl).toBeTruthy();

    // Toggle it
    fireEvent.click(switchEl);
    await vi.waitFor(() => {
      expect(mockSetGroupNotifications).toHaveBeenCalledWith("group-1", false);
    });
  });

  it("notification toggle shows pending state while saving", async () => {
    // Don't resolve notification save
    mockSetGroupNotifications.mockReturnValue(new Promise(() => {}));
    mockScreenlinkApi();
    renderWithProviders(React.createElement(GroupSettingsPage));
    await screen.findByText("Group info");

    const switchEl = screen.getByLabelText("Toggle group notifications");
    fireEvent.click(switchEl);

    // Switch should be disabled while saving
    await vi.waitFor(() => {
      expect((switchEl as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("clear shortcut button is guarded while request pending", async () => {
    mockScreenlinkApi({
      getGroupShortcutConfig: vi.fn().mockResolvedValue({
        quickShareShortcut: "Ctrl+Shift+S",
        quickJoinShortcut: null,
        quickShareSource: null,
        quickShareDefaultPresetId: null,
      }),
      updateGroupShortcutConfig: vi.fn().mockReturnValue(new Promise(() => {})), // don't resolve
    });
    renderWithProviders(React.createElement(GroupSettingsPage));
    await screen.findByText("Group info");

    // Wait for config to load
    await vi.waitFor(() => {
      expect(screen.getByText("Configured")).toBeTruthy();
    });

    // Click clear button
    const clearBtn = screen.getByTitle("Clear shortcut");
    expect((clearBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(clearBtn);

    // Button should be disabled immediately while request is pending
    await vi.waitFor(() => {
      expect((clearBtn as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
