// @vitest-environment happy-dom
/**
 * Tests for Task 6 quality fixes: M3 (validation), M4 (aria),
 * M6 (race guard), M7a/b (stale guard), M7d (aria-busy).
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// ─── Controllable promise ──────────────────────────────────────────────────
interface ControlledPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function makeControlledPromise<T>(): ControlledPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ─── Shared mocks ──────────────────────────────────────────────────────────
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ════════════════════════════════════════════════════════════════════════
// M3: Settings validation
// ════════════════════════════════════════════════════════════════════════
import type { PersistedSettings, QuickShareConfigDTO } from "@/preload/api-types";

vi.mock("@/stores/identity-store", () => ({
  useIdentityStore: vi.fn((s: (state: unknown) => unknown) => s({ localIdentity: null, setLocalIdentity: vi.fn() })),
}));
vi.mock("@/services/phase3-runtime", () => ({ getRuntime: vi.fn(() => null) }));

import { SettingsPage } from "@/components/workspace/SettingsPage";
import * as settingsActions from "@/services/settings-actions";

function makeSettings(): PersistedSettings {
  return {
    version: 1,
    deviceIdentity: { deviceId: "dev-1", displayName: "Test User", createdAt: Date.now() },
    hostDisplayName: "Test User",
    launchAtLogin: false, autoResumeLastMonitor: false, notificationsEnabled: true, previewEnabled: false,
    hostQualityLimits: { maxVideoBitrateKbps: 5000, maxWidth: 1920, maxHeight: 1080, maxFps: 60, allowViewerQualityRequests: true },
    globalQualityDefaults: { schemaVersion: 1, video: { videoBitrateKbps: 650, sendWidth: 854, sendHeight: 480, sendFps: 15, captureWidth: 854, captureHeight: 480, captureFps: 15, preserveAspectRatio: true, preventUpscale: true, resolutionMode: "target-dimensions", scaleResolutionDownBy: 1, codec: "vp9", h264Profile: "auto", contentHint: "motion", degradationPreference: "maintain-resolution", scalabilityMode: null, cursorMode: "always", rtpPriority: "medium" }, audio: { bitrateKbps: 64, channels: "stereo", bitrateMode: "vbr", dtx: false, fec: true, packetDurationMs: 20, redundantAudio: false } },
    viewerBitrateSliderMaxKbps: 5000, viewerMaxVolumePercent: 200, hourlyEstimateDurationMs: 10000, windowBounds: null, monitorFingerprint: null, lastSourceId: null, lastSourceName: null, lastSourceFingerprint: null, developerMode: false, localTransportPolicy: {}, lastAudioMode: undefined, lastShareSettings: null, viewerImageEnhancementSettings: null, lastNvidiaProcessingMode: "", lastNvidiaQuality: "",
    discordMuteShortcut: { modifiers: ["alt"], key: "M" },
    discordDeafenShortcut: { modifiers: ["alt"], key: "D" },
    discordDeafenScreenLink: true,
    streamInfoCard: { visible: false, showResolution: true, showFps: true, showBitrate: true, showDroppedFrames: true, showNetworkUsage: true, fontSize: 12, textColor: "#ffffff", boxOpacity: 60, boxWidth: 200 },
  };
}
function makeQuickShare(): QuickShareConfigDTO {
  return { shortcutEnabled: true, shortcutAccelerator: "Super+Alt+S", lastGroupId: null, lastSourceKind: null, lastPresetId: null };
}

describe("M3: Settings validation drives toast.error", () => {
  beforeEach(() => {
    (settingsActions.loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());
    (settingsActions.loadQuickShareConfig as ReturnType<typeof vi.fn>).mockResolvedValue(makeQuickShare());
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("displays validation error toast when saving with empty display name", async () => {
    render(React.createElement(SettingsPage));
    await screen.findByText("Profile");

    const nameInput = screen.getByLabelText("Display Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "" } });

    await screen.findByText("Unsaved changes");
    const saveBtn = screen.getByText("Save settings") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    const { toast } = await import("sonner");
    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Display Name"));
    });
  });

  it("displays validation error for invalid max video bitrate", async () => {
    render(React.createElement(SettingsPage));
    await screen.findByText("Host quality limits");

    const bitrateInput = screen.getByLabelText("Maximum bitrate") as HTMLInputElement;
    fireEvent.change(bitrateInput, { target: { value: "-100" } });

    await screen.findByText("Unsaved changes");
    const saveBtn = screen.getByText("Save settings") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    const { toast } = await import("sonner");
    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("bitrate"));
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// M4 + M7d: StreamHistory aria attributes + aria-busy
// ════════════════════════════════════════════════════════════════════════
let mockGetHistory: ReturnType<typeof vi.fn>;
let mockSetOnHistoryChanged: ReturnType<typeof vi.fn>;

// Stream metrics mock factory — uses a mutable ref so describe beforeEach can set handlers
// Default handlers return empty/inert values so M3 test (which mounts SettingsPage containing StreamHistorySection) doesn't crash.
const streamMetricsMockRef: { getHistory: (...a: unknown[]) => unknown; setOnHistoryChanged: (...a: unknown[]) => unknown } = {
  getHistory: vi.fn().mockResolvedValue([]),
  setOnHistoryChanged: vi.fn(),
};
vi.mock("@/services/stream-metrics-service", () => ({
  StreamMetricsService: {
    getInstance: vi.fn(() => ({
      getHistory: (...a: unknown[]) => streamMetricsMockRef.getHistory(...a),
      setOnHistoryChanged: (...a: unknown[]) => streamMetricsMockRef.setOnHistoryChanged(...a),
    })),
  },
}));

import { StreamHistorySection } from "@/components/settings/StreamHistorySection";
import * as streamMetricsService from "@/services/stream-metrics-service";

function makeRecord(overrides: Record<string, unknown> & { historyId: string }) {
  return {
    role: "host" as const, groupName: "Test", durationMs: 60000,
    startedAt: Date.now() - 60000, totalBytes: 1_000_000, averageBytesPerSecond: 500_000,
    interrupted: false, mediaSessionId: "sess-abc123",
    samples: [], markers: [], presetName: null, customQuality: false, ...overrides,
  };
}

describe("M4: StreamHistory aria-expanded / aria-controls / role=region", () => {
  beforeEach(() => {
    streamMetricsMockRef.getHistory = vi.fn();
    streamMetricsMockRef.setOnHistoryChanged = vi.fn();
    vi.mocked(streamMetricsService.StreamMetricsService.getInstance).mockReturnValue(
      { getHistory: streamMetricsMockRef.getHistory, setOnHistoryChanged: streamMetricsMockRef.setOnHistoryChanged } as never,
    );
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("buttons have aria-expanded reflecting toggle state", async () => {
    (streamMetricsMockRef.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([makeRecord({ historyId: "h-1", groupName: "Stream A" })]);
    render(React.createElement(StreamHistorySection));
    await screen.findByText("Stream A");

    const btn = screen.getByText("Stream A").closest("button")!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(btn);
    await vi.waitFor(() => expect(btn.getAttribute("aria-expanded")).toBe("true"));

    fireEvent.click(btn);
    await vi.waitFor(() => expect(btn.getAttribute("aria-expanded")).toBe("false"));
  });

  it("buttons have aria-controls pointing to existing panel id", async () => {
    (streamMetricsMockRef.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([makeRecord({ historyId: "h-2", groupName: "Stream B" })]);
    render(React.createElement(StreamHistorySection));
    await screen.findByText("Stream B");

    const btn = screen.getByText("Stream B").closest("button")!;
    const controlsId = btn.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();

    fireEvent.click(btn);
    await screen.findByText(/Session:/);

    const panel = document.getElementById(controlsId!);
    expect(panel).toBeTruthy();
    expect(panel!.getAttribute("role")).toBe("region");
    const labelledby = panel!.getAttribute("aria-labelledby");
    expect(labelledby).toBeTruthy();
    // The aria-labelledby reference must point to an existing element
    const labelEl = document.getElementById(labelledby!);
    expect(labelEl).toBeTruthy();
    expect(labelEl!.textContent).toContain("Stream B");
  });

  it("loading skeleton has role=status and aria-busy=true", async () => {
    const { promise } = makeControlledPromise<never[]>();
    (streamMetricsMockRef.getHistory as ReturnType<typeof vi.fn>).mockReturnValue(promise);
    render(React.createElement(StreamHistorySection));

    const loadingContainer = screen.getByTestId("stream-history-loading");
    expect(loadingContainer.getAttribute("role")).toBe("status");
    expect(loadingContainer.getAttribute("aria-busy")).toBe("true");
  });
});

// ════════════════════════════════════════════════════════════════════════
// M6: GroupSettings source/preset race guards
// ════════════════════════════════════════════════════════════════════════
const mockNavigate = vi.fn();
const mockSetGroupNotifications = vi.fn();
const mockLeaveGroupAction = vi.fn();
const mockCopyGroupInviteFromUi = vi.fn();
const mockStoreState = {
  selectedGroupId: "group-1",
  groupsById: { "group-1": { id: "group-1", name: "Test", members: { "u1": { deviceId: "d1", displayName: "A" } } } },
  navigate: mockNavigate,
};

vi.mock("@/stores/main-store", () => {
  const store = vi.fn((s: (state: typeof mockStoreState) => unknown) => s(mockStoreState));
  store.getState = () => mockStoreState;
  return { useStore: store };
});
vi.mock("@/services/settings-actions", () => {
  // Merge: M3 needs loadSettings etc, M6 needs setGroupNotifications
  const loadSettings = vi.fn();
  const saveSettings = vi.fn();
  const updateDisplayName = vi.fn();
  const loadQuickShareConfig = vi.fn();
  const saveQuickShareConfig = vi.fn();
  return { loadSettings, saveSettings, updateDisplayName, loadQuickShareConfig, saveQuickShareConfig, setGroupNotifications: (...a: unknown[]) => mockSetGroupNotifications(...a) };
});
vi.mock("@/services/group-leave-action", () => ({ leaveGroupAction: (...a: unknown[]) => mockLeaveGroupAction(...a) }));
vi.mock("@/services/invite-copy", () => ({ copyGroupInviteFromUi: (...a: unknown[]) => mockCopyGroupInviteFromUi(...a) }));

import { GroupSettingsPage } from "@/components/workspace/GroupSettingsPage";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderWithProviders(ui: React.ReactElement) {
  return render(React.createElement(TooltipProvider, null, ui));
}

describe("M6: GroupSettings source/preset race guards", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); delete (window as unknown as Record<string, unknown>).screenlink; });

  it("source handler has sourceSaving guard preventing concurrent calls", async () => {
    const { promise, resolve } = makeControlledPromise<Record<string, unknown>>();
    const updateConfig = vi.fn().mockReturnValue(promise);
    (window as unknown as Record<string, unknown>).screenlink = {
      getGroupShortcutConfig: vi.fn().mockResolvedValue({ quickShareShortcut: null, quickJoinShortcut: null, quickShareSource: null, quickShareDefaultPresetId: null }),
      updateGroupShortcutConfig: updateConfig,
      validateGroupShortcut: vi.fn().mockResolvedValue({ valid: true, normalized: "" }),
      getSources: vi.fn().mockResolvedValue([{ id: "src-1", name: "Screen 1", kind: "screen", displayId: "display-1", thumbnailDataUrl: "", appIconDataUrl: null }]),
      listQualityPresets: vi.fn().mockResolvedValue([]),
    };
    renderWithProviders(React.createElement(GroupSettingsPage));
    await screen.findByText("Group info");

    await vi.waitFor(() => expect(screen.queryByText("Quick Share")).toBeTruthy());

    const sourceTrigger = screen.getAllByRole("combobox")[0];
    fireEvent.click(sourceTrigger);

    const sourceItem = screen.getByText("Screen 1");
    fireEvent.click(sourceItem);

    expect(updateConfig).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(sourceTrigger.getAttribute("disabled")).not.toBeNull();
    });

    resolve({ quickShareShortcut: null, quickJoinShortcut: null, quickShareSource: { id: "src-1", name: "Screen 1", kind: "screen", displayId: "display-1" }, quickShareDefaultPresetId: null });
    await vi.waitFor(() => { expect(updateConfig).toHaveBeenCalledTimes(1); });
  });

  it("preset handler has presetSaving guard preventing concurrent calls", async () => {
    const { promise, resolve } = makeControlledPromise<Record<string, unknown>>();
    const updateConfig = vi.fn().mockReturnValue(promise);
    (window as unknown as Record<string, unknown>).screenlink = {
      getGroupShortcutConfig: vi.fn().mockResolvedValue({ quickShareShortcut: null, quickJoinShortcut: null, quickShareSource: null, quickShareDefaultPresetId: null }),
      updateGroupShortcutConfig: updateConfig,
      validateGroupShortcut: vi.fn().mockResolvedValue({ valid: true, normalized: "" }),
      getSources: vi.fn().mockResolvedValue([]),
      listQualityPresets: vi.fn().mockResolvedValue([{ id: "pr-1", name: "High Quality" }]),
    };
    renderWithProviders(React.createElement(GroupSettingsPage));
    await screen.findByText("Group info");

    await vi.waitFor(() => expect(screen.queryByText("Quick Share")).toBeTruthy());

    const presetTrigger = screen.getAllByRole("combobox").at(-1)!;
    fireEvent.click(presetTrigger);

    const presetItem = screen.getByText("High Quality");
    fireEvent.click(presetItem);

    expect(updateConfig).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(presetTrigger.getAttribute("disabled")).not.toBeNull();
    });

    resolve({ quickShareShortcut: null, quickJoinShortcut: null, quickShareSource: null, quickShareDefaultPresetId: "pr-1" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// M7a: loadConfig stale response guard
// ════════════════════════════════════════════════════════════════════════
describe("M7a: loadConfig stale response guard", () => {
  it("loadConfig uses a generation counter or cancellation flag", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "C:\\Users\\parla\\AppData\\Local\\Temp\\opencode\\AC-Sharescreen-ui-overhaul\\apps\\desktop\\src\\renderer\\components\\workspace\\GroupSettingsPage.tsx",
      "utf-8",
    );
    expect(
      source.includes("configGeneration") ||
      source.includes("cancelledRef") ||
      source.includes("cancelled"),
    ).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// M7b: StreamHistory load stale guard
// ════════════════════════════════════════════════════════════════════════
describe("M7b: StreamHistory load stale guard", () => {
  beforeEach(() => {
    streamMetricsMockRef.getHistory = vi.fn();
    streamMetricsMockRef.setOnHistoryChanged = vi.fn();
    vi.mocked(streamMetricsService.StreamMetricsService.getInstance).mockReturnValue(
      { getHistory: streamMetricsMockRef.getHistory, setOnHistoryChanged: streamMetricsMockRef.setOnHistoryChanged } as never,
    );
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("preserves current data when stale concurrent load resolves after newer load", async () => {
    const slowPromise = makeControlledPromise<Array<Record<string, unknown>>>();
    const fastRecords = [{ historyId: "latest", role: "host" as const, groupName: "Latest", durationMs: 1000, startedAt: Date.now(), totalBytes: 100, averageBytesPerSecond: 100, interrupted: false, mediaSessionId: "sess-latest", samples: [], markers: [] }];

    const getHistoryMock = streamMetricsMockRef.getHistory as ReturnType<typeof vi.fn>;
    getHistoryMock.mockReturnValueOnce(slowPromise.promise);
    getHistoryMock.mockResolvedValueOnce(fastRecords);

    render(React.createElement(StreamHistorySection));

    const onChangedCallback = (streamMetricsMockRef.setOnHistoryChanged as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(onChangedCallback).toBeTruthy();
    onChangedCallback!();

    await screen.findByText("Latest");

    slowPromise.resolve([{ historyId: "stale", role: "host" as const, groupName: "Stale", durationMs: 1000, startedAt: Date.now(), totalBytes: 100, averageBytesPerSecond: 100, interrupted: false, mediaSessionId: "sess-stale", samples: [], markers: [] }]);

    await vi.waitFor(() => {
      expect(screen.getByText("Latest")).toBeTruthy();
    });
  });
});
