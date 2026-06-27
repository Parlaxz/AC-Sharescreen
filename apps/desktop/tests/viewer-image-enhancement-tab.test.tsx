// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ViewerSettingsPanel } from "@/components/workspace/viewer/ViewerSettingsPanel";
import { VIEWER_IMAGE_ENHANCEMENT_DEFAULTS } from "@/services/viewer-image-processing/viewer-image-defaults";

// Mock zustand store — ViewerSettingsPanel calls useStore to get qualityPresets
vi.mock("@/stores/main-store", () => ({
  useStore: vi.fn((selector: (state: { qualityPresets: unknown[] }) => unknown) =>
    selector({ qualityPresets: [] }),
  ),
}));

// Mock settings-actions — ViewerSettingsPanel calls loadSettings on mount
vi.mock("@/services/settings-actions", () => ({
  loadSettings: vi.fn().mockResolvedValue({}),
}));

describe("ViewerSettingsPanel Image Enhancements tab", () => {
  const defaultProps = {
    requestState: null,
    onRequestChange: () => {},
    enhancementSettings: VIEWER_IMAGE_ENHANCEMENT_DEFAULTS,
    onEnhancementChange: () => {},
    onEnhancementReset: () => {},
    children: <span data-testid="trigger">Trigger</span>,
  };

  it("renders without crashing", () => {
    render(<ViewerSettingsPanel {...defaultProps} />);
    expect(screen.getByTestId("trigger")).toBeDefined();
  });

  it("no Text/Balanced/Motion preset buttons exist", () => {
    const { container } = render(<ViewerSettingsPanel {...defaultProps} />);
    const html = container.innerHTML;
    expect(html).not.toContain("Text");
    expect(html).not.toContain("Balanced");
    expect(html).not.toContain("Motion");
    expect(html).not.toContain("Native");
    expect(html).not.toContain("Crisp");
    expect(html).not.toContain("Smooth");
    expect(html).not.toContain("Preset");
  });
});
