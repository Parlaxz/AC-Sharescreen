// @vitest-environment happy-dom
/**
 * Behavioral RTL tests for QualityPresetsPage interactions.
 * Tests create/edit sheet, duplicate name validation, delete confirmation,
 * set-as-default, import/export where feasible.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockSetQualityPresets = vi.fn();

vi.mock("@/stores/main-store", () => ({
  useStore: vi.fn((selector) => {
    const store = {
      qualityPresets: [],
      setQualityPresets: mockSetQualityPresets,
    };
    return selector(store);
  }),
}));

const mockFetch = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockDuplicate = vi.fn();
const mockExport = vi.fn();
const mockImport = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("@/services/group-actions", () => ({
  fetchQualityPresets: (...args: unknown[]) => mockFetch(...args),
  createQualityPreset: (...args: unknown[]) => mockCreate(...args),
  updateQualityPreset: (...args: unknown[]) => mockUpdate(...args),
  deleteQualityPreset: (...args: unknown[]) => mockDelete(...args),
  duplicateQualityPreset: (...args: unknown[]) => mockDuplicate(...args),
  exportQualityPreset: (...args: unknown[]) => mockExport(...args),
  importQualityPreset: (...args: unknown[]) => mockImport(...args),
}));

vi.mock("@/services/settings-actions", () => ({
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { QualityPresetsPage } from "@/components/workspace/QualityPresetsPage";
import type { QualityPreset } from "@screenlink/shared";

function makePreset(overrides: Partial<QualityPreset> & { id: string; name: string }): QualityPreset {
  return {
    schemaVersion: 1 as const,
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
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QualityPresetsPage interactions", () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue([]);
  });

  it("renders PageHeader with title and description", async () => {
    render(React.createElement(QualityPresetsPage));
    expect(await screen.findByText("Quality Presets")).toBeTruthy();
    expect(screen.getByText("Create and manage stream quality presets")).toBeTruthy();
  });

  it("shows loading state with skeleton placeholders", async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { container } = render(React.createElement(QualityPresetsPage));
    const skeletons = container.querySelectorAll('[class*="animate-pulse"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
  });

  it("shows error alert with retry on API failure", async () => {
    mockFetch.mockRejectedValue(new Error("API error"));
    render(React.createElement(QualityPresetsPage));
    const errorText = await screen.findByText("Failed to load presets");
    expect(errorText).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("retry reloads after error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Fail")).mockResolvedValueOnce([]);
    render(React.createElement(QualityPresetsPage));
    await screen.findByText("Failed to load presets");
    fireEvent.click(screen.getByText("Retry"));
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("opens create sheet on New preset button", async () => {
    mockFetch.mockResolvedValue([]);
    render(React.createElement(QualityPresetsPage));
    await screen.findByText("Quality Presets");
    // Click the "New preset" button (there might be one in the Sheet header too, so target the first)
    const newPresetBtns = screen.getAllByText("New preset");
    fireEvent.click(newPresetBtns[0]);
    // Sheet should open — look for the sheet description
    expect(await screen.findByText("Configure quality settings for this preset.")).toBeTruthy();
  });

  it("validates duplicate name on save", async () => {
    mockFetch.mockResolvedValue([
      makePreset({ id: "p1", name: "Existing Preset" }),
    ]);
    render(React.createElement(QualityPresetsPage));
    await screen.findByText("Existing Preset");

    // Open create sheet
    const newPresetBtns = screen.getAllByText("New preset");
    fireEvent.click(newPresetBtns[0]);
    await screen.findByText("Configure quality settings for this preset.");

    // Type duplicate name
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Existing Preset" } });

    // Try to save - use getAllByText and find the one in the SheetFooter (not disabled)
    const saveBtns = screen.getAllByText("Save");
    const activeSave = saveBtns.find(b => !(b as HTMLButtonElement).disabled);
    if (activeSave) fireEvent.click(activeSave);

    // Should show duplicate error
    const { toast } = await import("sonner");
    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("already exists"),
      );
    });
    // Should NOT call create
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("opens edit sheet on existing preset", async () => {
    mockFetch.mockResolvedValue([
      makePreset({ id: "p1", name: "My Preset" }),
    ]);
    render(React.createElement(QualityPresetsPage));
    await screen.findByText("My Preset");

    // Click Edit
    const editBtns = screen.getAllByText("Edit");
    fireEvent.click(editBtns[0]);

    // Sheet should show Edit preset title
    expect(await screen.findByText("Edit preset")).toBeTruthy();
    // Name field should be filled
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.value).toBe("My Preset");
  });

  it("calls createQualityPreset on save with valid name", async () => {
    mockCreate.mockResolvedValue({
      id: "new-id", name: "New Preset", settings: {},
    });
    mockFetch.mockResolvedValue([]);
    render(React.createElement(QualityPresetsPage));
    await screen.findByText("Quality Presets");

    // Open create sheet
    const newPresetBtns = screen.getAllByText("New preset");
    fireEvent.click(newPresetBtns[0]);
    await screen.findByText("Configure quality settings for this preset.");

    // Type name
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "New Preset" } });

    // Save
    const saveBtns = screen.getAllByText("Save");
    const activeSave = saveBtns.find(b => !(b as HTMLButtonElement).disabled);
    if (activeSave) fireEvent.click(activeSave);

    await vi.waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  it("shows delete confirmation dialog", async () => {
    mockFetch.mockResolvedValue([
      makePreset({ id: "p1", name: "To Delete" }),
    ]);
    render(React.createElement(QualityPresetsPage));
    // Wait for the preset card to render (may need to wait for motion animation)
    await vi.waitFor(() => {
      expect(screen.getByText("To Delete")).toBeTruthy();
    });

    // Find the Delete button in the card footer (not in the Dialog)
    const deleteBtns = screen.getAllByText("Delete");
    // The card footer delete button is the first one (dialog delete is hidden until opened)
    fireEvent.click(deleteBtns[0]);

    // Dialog should open
    expect(await screen.findByText(/Are you sure you want to delete/)).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    // There will be two "Delete" texts now - card button and dialog button
    const allDeletes = screen.getAllByText("Delete");
    expect(allDeletes.length).toBeGreaterThanOrEqual(2);
  });

  it("cancels delete and closes dialog", async () => {
    mockFetch.mockResolvedValue([
      makePreset({ id: "p1", name: "To Delete" }),
    ]);
    mockDelete.mockResolvedValue(true);
    render(React.createElement(QualityPresetsPage));
    await vi.waitFor(() => {
      expect(screen.getByText("To Delete")).toBeTruthy();
    });

    // Click Delete
    fireEvent.click(screen.getAllByText("Delete")[0]);
    expect(await screen.findByText(/Are you sure/)).toBeTruthy();

    // Cancel
    fireEvent.click(screen.getByText("Cancel"));
    await vi.waitFor(() => {
      expect(screen.queryByText(/Are you sure/)).toBeNull();
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("confirms delete and calls deleteQualityPreset", async () => {
    mockFetch.mockResolvedValueOnce([
      makePreset({ id: "p1", name: "To Delete" }),
    ]);
    mockDelete.mockResolvedValue(true);
    mockFetch.mockResolvedValueOnce([]); // reload after delete
    render(React.createElement(QualityPresetsPage));
    await vi.waitFor(() => {
      expect(screen.getByText("To Delete")).toBeTruthy();
    });

    // Click Delete button on card
    fireEvent.click(screen.getAllByText("Delete")[0]);
    expect(await screen.findByText(/Are you sure/)).toBeTruthy();

    // Confirm delete - click the dialog's destructive Delete button
    const allDeletes = screen.getAllByText("Delete");
    // The last one should be the dialog confirm button (not disabled)
    const confirmBtn = allDeletes[allDeletes.length - 1];
    fireEvent.click(confirmBtn);

    await vi.waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("p1");
    });
  });

  it("set-as-default calls saveSettings", async () => {
    mockFetch.mockResolvedValue([
      makePreset({ id: "p1", name: "Default Preset" }),
    ]);
    mockSaveSettings.mockResolvedValue(undefined);
    render(React.createElement(QualityPresetsPage));
    await vi.waitFor(() => {
      expect(screen.getByText("Default Preset")).toBeTruthy();
    });

    // Click Set as default
    fireEvent.click(screen.getByText("Set as default"));

    await vi.waitFor(() => {
      expect(mockSaveSettings).toHaveBeenCalled();
    });
  });

  it("uses PageSection for content areas", async () => {
    mockFetch.mockResolvedValue([]);
    const { container } = render(React.createElement(QualityPresetsPage));
    await screen.findByText("Quality Presets");
    // Wait for rendering
    await vi.waitFor(() => {
      const sections = container.querySelectorAll("section");
      // Should have the preset list section title
      expect(sections.length).toBeGreaterThanOrEqual(1);
    });
  });
});
