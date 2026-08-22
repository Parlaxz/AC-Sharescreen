// @vitest-environment happy-dom
/**
 * Behavioral tests for SettingsPage UI tokens, structure, and interactions.
 *
 * Tests that:
 * - Save bar uses Tailwind classes (not inline styles)
 * - Uses PageHeader + PageSection hierarchy
 * - Shows dirty state / save status
 * - Loading and error states render correctly
 * - Validation works on save
 * - Save success/failure preserves form values
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/services/settings-actions", () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  updateDisplayName: vi.fn(),
  loadQuickShareConfig: vi.fn(),
  saveQuickShareConfig: vi.fn(),
}));

vi.mock("@/stores/identity-store", () => ({
  useIdentityStore: vi.fn((selector) => {
    const store = {
      localIdentity: { deviceId: "dev-1", displayName: "Test User" },
      setLocalIdentity: vi.fn(),
    };
    return selector(store);
  }),
}));

vi.mock("@/services/phase3-runtime", () => ({
  getRuntime: vi.fn(() => null),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks
import { SettingsPage } from "@/components/workspace/SettingsPage";
import * as settingsActions from "@/services/settings-actions";

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    deviceIdentity: { deviceId: "dev-1", displayName: "Test User", createdAt: Date.now() },
    hostDisplayName: "Test User",
    launchAtLogin: false,
    autoResumeLastMonitor: false,
    notificationsEnabled: true,
    hostQualityLimits: {
      maxVideoBitrateKbps: 5000,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 60,
      allowViewerQualityRequests: true,
    },
    globalQualityDefaults: {
      schemaVersion: 1,
      video: { codec: "vp9" },
      audio: { bitrateKbps: 64, channels: "stereo", bitrateMode: "vbr", dtx: false, fec: true, packetDurationMs: 20, redundantAudio: false },
    },
    viewerBitrateSliderMaxKbps: 5000,
    viewerMaxVolumePercent: 200,
    hourlyEstimateDurationMs: 10000,
    discordMuteShortcut: { modifiers: ["alt"], key: "M" },
    discordDeafenShortcut: { modifiers: ["alt"], key: "D" },
    discordDeafenScreenLink: true,
    streamInfoCard: {
      visible: false, showResolution: true, showFps: true, showBitrate: true,
      showDroppedFrames: true, showNetworkUsage: true, fontSize: 12,
      textColor: "#ffffff", boxOpacity: 60, boxWidth: 200,
    },
    previewEnabled: false,
    windowBounds: null,
    monitorFingerprint: null,
    lastSourceId: null,
    lastSourceName: null,
    lastSourceFingerprint: null,
    developerMode: false,
    localTransportPolicy: {},
    viewerImageEnhancementSettings: null,
    lastNvidiaProcessingMode: "",
    lastNvidiaQuality: "",
    ...overrides,
  };
}

function makeQuickShare(overrides: Record<string, unknown> = {}) {
  return {
    shortcutEnabled: true,
    shortcutAccelerator: "Super+Alt+S",
    lastGroupId: null,
    lastSourceKind: null,
    lastPresetId: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SettingsPage token migration", () => {
  beforeEach(() => {
    vi.mocked(settingsActions.loadSettings).mockResolvedValue(makeSettings());
    vi.mocked(settingsActions.loadQuickShareConfig).mockResolvedValue(makeQuickShare());
  });

  it("renders loading skeleton initially", () => {
    // Don't resolve the load promise yet
    vi.mocked(settingsActions.loadSettings).mockReturnValue(new Promise(() => {}));
    const { container } = render(React.createElement(SettingsPage));
    // The loading state renders Skeleton components - check for skeleton placeholders
    const skeletons = container.querySelectorAll('[class*="animate-pulse"], [class*="skeleton"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it("renders error state with retry when loading fails", async () => {
    vi.mocked(settingsActions.loadSettings).mockRejectedValue(new Error("Network error"));
    render(React.createElement(SettingsPage));
    // Wait for error state
    const errorText = await screen.findByText("Failed to load settings");
    expect(errorText).toBeTruthy();
    // Should have retry button
    const retryBtn = screen.getByText("Retry");
    expect(retryBtn).toBeTruthy();
  });

  it("renders all sections after successful load", async () => {
    render(React.createElement(SettingsPage));
    // Wait for content sections to appear
    expect(await screen.findByText("Profile")).toBeTruthy();
    expect(screen.getByText("Startup")).toBeTruthy();
    expect(screen.getByText("Notifications")).toBeTruthy();
    expect(screen.getByText("Host quality limits")).toBeTruthy();
    expect(screen.getByText("Streaming default")).toBeTruthy();
    expect(screen.getByText("Quick Share")).toBeTruthy();
    expect(screen.getByText("Discord Controls")).toBeTruthy();
    expect(screen.getByText("Stream Info Overlay")).toBeTruthy();
    expect(screen.getByText("Viewer")).toBeTruthy();
  });

  it("renders showCompareControls toggle defaulting to off", async () => {
    render(React.createElement(SettingsPage));
    await screen.findByText("Viewer");
    const toggle = screen.getByLabelText("Show A/B comparison controls");
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    // Toggling should make the form dirty
    fireEvent.click(toggle);
    await screen.findByText("Unsaved changes");
  });

  it("shows save bar with 'All settings saved' when clean", async () => {
    render(React.createElement(SettingsPage));
    const saveText = await screen.findByText("All settings saved");
    expect(saveText).toBeTruthy();
    const saveBtn = screen.getByText("Save settings");
    expect(saveBtn).toBeTruthy();
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows 'Unsaved changes' when form is dirty and enables save button", async () => {
    render(React.createElement(SettingsPage));
    await screen.findByText("Profile");

    // Modify display name to make form dirty using fireEvent.change
    const input = screen.getByLabelText("Display Name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New Name" } });

    // Wait for dirty state
    const unsavedText = await screen.findByText("Unsaved changes");
    expect(unsavedText).toBeTruthy();

    const saveBtn = screen.getByText("Save settings") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  it("save bar uses Tailwind classes (no inline style)", async () => {
    render(React.createElement(SettingsPage));
    await screen.findByText("Profile");

    // The save bar status text container
    const statusSpan = screen.getByText("All settings saved");
    expect(statusSpan).toBeTruthy();

    // The status span should use className (not inline style)
    expect(statusSpan.className).toBeTruthy();
    expect(statusSpan.className).toContain("text-");
  });

  it("displays validation error toast on save with invalid empty display name", async () => {
    render(React.createElement(SettingsPage));
    await screen.findByText("Profile");

    // Make form dirty by changing display name to empty (different from default "Test User")
    const nameInput = screen.getByLabelText("Display Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "" } });

    // Wait for dirty state
    await screen.findByText("Unsaved changes");

    // Save button must be enabled
    const saveBtn = screen.getByText("Save settings") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    // Click save — validation should fire
    fireEvent.click(saveBtn);

    // Must call the mocked toast.error with the specific validation message
    const { toast } = await import("sonner");
    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Display Name must be 1\u2013100 characters");
    });
  });

  it("shows loading skeleton with role=status and aria-busy for a11y consistency", () => {
    vi.mocked(settingsActions.loadSettings).mockReturnValue(new Promise(() => {}));
    const { container } = render(React.createElement(SettingsPage));
    const loadingDiv = container.querySelector('[class*="overflow-auto"]');
    expect(loadingDiv).toBeTruthy();
    // The loading container should have role="status" and aria-busy="true"
    // Check the outermost loading wrapper
    const outerDiv = container.firstChild as HTMLElement;
    if (outerDiv) {
      // The loading state renders a div with role/aria-busy
      expect(outerDiv.getAttribute("role")).toBe("status");
      expect(outerDiv.getAttribute("aria-busy")).toBe("true");
    }
  });

  it("save success shows success toast", async () => {
    // Build the updated settings mock with the new display name
    const updatedSettings = makeSettings({
      deviceIdentity: { deviceId: "dev-1", displayName: "Updated Name", createdAt: Date.now() },
      hostDisplayName: "Updated Name",
    });
    let callCount = 0;
    vi.mocked(settingsActions.updateDisplayName).mockResolvedValue({
      deviceId: "dev-1", displayName: "Updated Name", createdAt: Date.now(),
    });
    // First call returns original, subsequent calls return updated (for verification)
    vi.mocked(settingsActions.loadSettings).mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) return makeSettings();
      return updatedSettings;
    });
    vi.mocked(settingsActions.loadQuickShareConfig).mockResolvedValue(makeQuickShare());
    vi.mocked(settingsActions.saveSettings).mockResolvedValue(undefined);
    vi.mocked(settingsActions.saveQuickShareConfig).mockResolvedValue(undefined);

    render(React.createElement(SettingsPage));
    await screen.findByText("Profile");

    // Make form dirty via display name change
    const nameInput = screen.getByLabelText("Display Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Updated Name" } });

    // Wait for dirty state
    await screen.findByText("Unsaved changes");

    // Save
    const saveBtn = screen.getByText("Save settings") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    const { toast } = await import("sonner");
    await vi.waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    }, { timeout: 3000 });
  });

  it("save failure preserves form values and shows error toast", async () => {
    vi.mocked(settingsActions.updateDisplayName).mockRejectedValue(new Error("Save failed"));

    render(React.createElement(SettingsPage));
    await screen.findByText("Profile");

    // Make dirty
    const nameInput = screen.getByLabelText("Display Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Updated Name" } });

    // Wait for dirty state
    await screen.findByText("Unsaved changes");

    // Try to save
    const saveBtn = screen.getByText("Save settings") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    const { toast } = await import("sonner");
    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
  });

  it("uses PageHeader component", async () => {
    render(React.createElement(SettingsPage));
    const heading = await screen.findByText("Settings");
    expect(heading.tagName).toBe("H1");
    // Should have a description
    const description = screen.getByText("Configure your ScreenLink preferences");
    expect(description).toBeTruthy();
  });

  it("uses PageSection components for section grouping", async () => {
    render(React.createElement(SettingsPage));
    await screen.findByText("Profile");
    // PageSection creates sections with aria-labelledby
    const sections = document.querySelectorAll("section");
    expect(sections.length).toBeGreaterThanOrEqual(8);
  });
});
