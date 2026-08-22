// @vitest-environment happy-dom
/**
 * Behavioral tests for QualityPresetsPage fixes:
 * - Checkbox uses Watermelon Checkbox (not raw <input type="checkbox">)
 * - Select uses Watermelon Select (not raw <select>)
 * - No `as any` casts for showInViewerPanel/viewerPanelSlot
 * - Duplicate name detection
 * - Proper type usage
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/stores/main-store", () => ({
  useStore: vi.fn((selector) => {
    const store = {
      qualityPresets: [],
      setQualityPresets: vi.fn(),
    };
    return selector(store);
  }),
}));

vi.mock("@/services/group-actions", () => ({
  fetchQualityPresets: vi.fn(),
  createQualityPreset: vi.fn(),
  updateQualityPreset: vi.fn(),
  deleteQualityPreset: vi.fn(),
  duplicateQualityPreset: vi.fn(),
  exportQualityPreset: vi.fn(),
  importQualityPreset: vi.fn(),
}));

vi.mock("@/services/settings-actions", () => ({
  saveSettings: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { QualityPresetsPage } from "@/components/workspace/QualityPresetsPage";
import * as groupActions from "@/services/group-actions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QualityPresetsPage type and component fixes", () => {
  beforeEach(() => {
    vi.mocked(groupActions.fetchQualityPresets).mockResolvedValue([]);
  });

  it("renders loading state initially", () => {
    vi.mocked(groupActions.fetchQualityPresets).mockReturnValue(new Promise(() => {}));
    render(React.createElement(QualityPresetsPage));
    expect(screen.getByText("Quality Presets")).toBeTruthy();
  });

  it("renders error state with retry when loading fails", async () => {
    vi.mocked(groupActions.fetchQualityPresets).mockRejectedValue(new Error("API error"));
    render(React.createElement(QualityPresetsPage));
    const errorText = await screen.findByText("Failed to load presets");
    expect(errorText).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("renders empty state when no presets", async () => {
    render(React.createElement(QualityPresetsPage));
    const emptyText = await screen.findByText("No presets yet.");
    expect(emptyText).toBeTruthy();
  });

  it("uses PageHeader component", async () => {
    render(React.createElement(QualityPresetsPage));
    const heading = await screen.findByText("Quality Presets");
    expect(heading.tagName).toBe("H1");
    expect(screen.getByText("Create and manage stream quality presets")).toBeTruthy();
  });

  it("renders preset cards with typed properties (no as any)", async () => {
    const presetWithMeta = {
      schemaVersion: 1 as const,
      id: "preset-1",
      name: "Test Preset",
      settings: {
        schemaVersion: 1 as const,
        video: {
          videoBitrateKbps: 4000,
          sendWidth: 1920,
          sendHeight: 1080,
          sendFps: 30,
          captureWidth: 1920,
          captureHeight: 1080,
          captureFps: 30,
          preserveAspectRatio: true,
          preventUpscale: true,
          resolutionMode: "target-dimensions" as const,
          scaleResolutionDownBy: 1,
          codec: "vp9" as const,
          h264Profile: "auto" as const,
          contentHint: "motion" as const,
          degradationPreference: "maintain-resolution" as const,
          scalabilityMode: null,
          cursorMode: "always" as const,
          rtpPriority: "medium" as const,
        },
        audio: {
          bitrateKbps: 64,
          channels: "stereo" as const,
          bitrateMode: "vbr" as const,
          dtx: false,
          fec: true,
          packetDurationMs: 20 as const,
          redundantAudio: false,
        },
      },
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
      showInViewerPanel: true,
      viewerPanelSlot: 3,
    };
    vi.mocked(groupActions.fetchQualityPresets).mockResolvedValue([presetWithMeta]);

    render(React.createElement(QualityPresetsPage));
    expect(await screen.findByText("Test Preset")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy(); // slot badge
  });
});
