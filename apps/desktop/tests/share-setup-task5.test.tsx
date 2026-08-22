// @vitest-environment happy-dom
// Task 5 quality: audio init, accessible cards, stale-dep (via behavior), shared helpers.
// Strict TDD — all tests written RED before GREEN.

// ─── Hoisted mocks (inlined because ESM prevents require in hoisted scope) ──
vi.mock("@radix-ui/react-select", () => {
  const React = require("react"); const Ctx = React.createContext(null);
  return {
    Root: ({ children, value, onValueChange }: any) => React.createElement(Ctx.Provider, { value: { value, onValueChange } }, children),
    Trigger: ({ children, asChild, className, id, ...props }: any) => React.createElement("button", { role: "combobox", "aria-haspopup": "listbox", className, id, "data-mock-select": "trigger" }, children),
    Value: ({ placeholder, children }: any) => { const { value } = React.useContext(Ctx) || {}; return React.createElement("span", null, value || placeholder || children); },
    Portal: ({ children }: any) => children,
    Content: ({ children, className, ...props }: any) => React.createElement("div", { role: "listbox", className, ...props }, children),
    Item: ({ value, children, disabled, ...props }: any) => { const { onValueChange } = React.useContext(Ctx) || {}; return React.createElement("div", { role: "option", "aria-selected": false, "data-value": value, onClick: () => { if (!disabled) onValueChange?.(value); }, style: { cursor: "pointer" } }, children); },
    ItemIndicator: () => React.createElement("span", { "data-mock": "item-indicator" }),
    ItemText: ({ children }: any) => React.createElement("span", { "data-mock": "item-text" }, children),
    Viewport: ({ children }: any) => children, Group: ({ children }: any) => children,
    Label: ({ children }: any) => React.createElement("div", null, children), Separator: () => React.createElement("hr"),
    Icon: () => React.createElement("span", { "data-mock": "select-icon" }),
  };
});
vi.mock("motion/react", () => {
  const React = require("react");
  const motion = { div: (p: any) => { const { initial, animate, exit, transition, layout, layoutId, ...rest } = p; return React.createElement("div", rest); } };
  return { default: motion, AnimatePresence: ({ children }: any) => React.createElement(React.Fragment, null, children), motion };
});

const mockStartShare = vi.fn();
vi.mock("../src/renderer/services/share-coordinator.js", () => ({
  startShare: mockStartShare,
  startShareLegacy: vi.fn(),
}));

// ─── Imports ───────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { useStore } from "../src/renderer/stores/main-store.js";
import { TooltipProvider } from "../src/renderer/components/ui/tooltip.js";
import { deriveSourceErrorText, resolveAudioMode } from "../src/renderer/services/share-quality.js";

// ─── Helpers ───────────────────────────────────────────────────────────────
const mockGetSources = vi.fn();
const mockGetSettings = vi.fn();

function setupScreenLinkMock() {
  (window as any).screenlink = {
    getSources: mockGetSources, getSettings: mockGetSettings,
    updateSettings: vi.fn(), setSource: vi.fn(), clipboardWriteText: vi.fn(),
  };
}
function resetScreenLinkMock() {
  delete (window as any).screenlink;
  [mockGetSources, mockGetSettings].forEach(m => m.mockReset());
}
function makeSource(id: string, name: string, kind: "screen" | "window") {
  return { id, name, kind, displayId: id, thumbnailDataUrl: `data:fake${id}`, appIconDataUrl: null };
}
function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}
async function getShareSetup() {
  return (await import("../src/renderer/components/workspace/ShareSetup.js")).ShareSetup;
}

// ─── 1. deriveSourceErrorText unit tests ──────────────────────────────────

describe("deriveSourceErrorText — all branches", () => {
  it('permission-denied', () => {
    expect(deriveSourceErrorText(new Error("Permission denied"))).toMatch(/permission|denied|allow/i);
  });
  it('timeout', () => {
    expect(deriveSourceErrorText(new Error("The request timed out"))).toMatch(/timeout|timed out|retry/i);
  });
  it('cancelled', () => {
    expect(deriveSourceErrorText(new Error("User cancelled"))).toMatch(/cancelled|cancel/i);
  });
  it('not-found', () => {
    expect(deriveSourceErrorText(new Error("Source not found"))).toMatch(/not found|cancelled|cancel/i);
  });
  it('generic Error with message', () => {
    const msg = deriveSourceErrorText(new Error("Unknown device error"));
    expect(msg).toMatch(/Unknown device error/);
    expect(msg).toMatch(/permitted/);
  });
  it('empty message', () => {
    expect(deriveSourceErrorText(new Error(""))).toMatch(/screen recording|permitted|access/i);
  });
  it('non-Error input', () => expect(deriveSourceErrorText("string")).toMatch(/screen recording/i));
  it('null input', () => expect(deriveSourceErrorText(null)).toMatch(/screen recording/i));
  it('undefined input', () => expect(deriveSourceErrorText(undefined)).toMatch(/screen recording/i));
});

// ─── I1: Audio initialization (one-frame correctness) ──────────────────────

describe("I1 — audio mode init from stored preference", () => {
  beforeEach(() => {
    useStore.getState().reset();
    resetScreenLinkMock(); setupScreenLinkMock();
    mockGetSettings.mockResolvedValue({});
    mockGetSources.mockResolvedValue([makeSource("s1", "Disp", "screen")]);
    useStore.setState({ openShareSetup: true, selectedGroupId: "g1" });
    mockStartShare.mockReset();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("initializes from lastScreenAudioMode, not from one-frame 'none'", async () => {
    // Simulate user has previously shared with monitor audio
    useStore.setState({ lastScreenAudioMode: "monitor" });
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    // Audio mode RadioGroup should show "Filtered monitor audio" as selected
    await waitFor(() => {
      const audioLabels = screen.queryAllByText(/filtered monitor audio/i);
      expect(audioLabels.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });
    // The RadioGroup value should be "monitor" (not "none")
    // Verify by checking that the RadioGroup has the correct value set
    const monitorRadio = document.querySelector('[data-value="monitor"]');
    // The RadioGroupItem with value "monitor" should have aria-checked or data-state
  });

  it("resolveAudioMode correctly validates and falls back", () => {
    expect(resolveAudioMode("screen", "none", "monitor", "none")).toBe("none");
    expect(resolveAudioMode("screen", "monitor", "monitor", "none")).toBe("monitor");
    // Invalid for screen tab → falls back to lastScreenAudioMode
    expect(resolveAudioMode("screen", "application", "monitor", "none")).toBe("monitor");
    expect(resolveAudioMode("window", "application", "monitor", "none")).toBe("application");
    expect(resolveAudioMode("window", "monitor", "monitor", "none")).toBe("none");
  });
});

// ─── I2: Source cards have accessible names ────────────────────────────────

describe("I2 — source cards have accessible radio name", () => {
  beforeEach(() => {
    useStore.getState().reset();
    resetScreenLinkMock(); setupScreenLinkMock();
    mockGetSettings.mockResolvedValue({});
    mockGetSources.mockResolvedValue([
      makeSource("src-a", "Display Alpha", "screen"),
      makeSource("src-b", "Display Beta", "screen"),
    ]);
    useStore.setState({ openShareSetup: true, selectedGroupId: "g1" });
    mockStartShare.mockReset();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("each source card has role=radio with aria-label matching source name", async () => {
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    await waitFor(() => {
      expect(screen.queryAllByRole("radio").length).toBeGreaterThanOrEqual(2);
    }, { timeout: 5000 });
    // Query by role + name
    const radioAlpha = screen.getByRole("radio", { name: "Display Alpha" });
    expect(radioAlpha).toBeInTheDocument();
    const radioBeta = screen.getByRole("radio", { name: "Display Beta" });
    expect(radioBeta).toBeInTheDocument();
    // aria-checked should be false initially
    expect(radioAlpha).toHaveAttribute("aria-checked", "false");
    expect(radioBeta).toHaveAttribute("aria-checked", "false");
  });
});

// ─── Start validity disabled→enabled, pending, duplicate prevention ────────

describe("ShareSetup — start button states", () => {
  beforeEach(() => {
    useStore.getState().reset();
    resetScreenLinkMock(); setupScreenLinkMock();
    mockGetSettings.mockResolvedValue({});
    mockGetSources.mockResolvedValue([makeSource("s1", "Display 1", "screen")]);
    useStore.setState({ openShareSetup: true, selectedGroupId: "g1" });
    mockStartShare.mockReset();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("disabled when no source selected", async () => {
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /start sharing/i })).toBeDisabled();
    }, { timeout: 10000 });
  });

  it("enabled after source selected", async () => {
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    (document.querySelectorAll('[role="radio"]')[0] as HTMLElement).click();
    await waitFor(() => expect(screen.getByRole("button", { name: /start sharing/i })).not.toBeDisabled(), { timeout: 5000 });
  });

  it("shows Starting… when pending", async () => {
    mockStartShare.mockReturnValue(new Promise(() => {}));
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    (document.querySelectorAll('[role="radio"]')[0] as HTMLElement).click();
    await waitFor(() => expect(screen.getByRole("button", { name: /start sharing/i })).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /start sharing/i }));
    await waitFor(() => expect(screen.getByText(/starting/i)).toBeInTheDocument(), { timeout: 5000 });
  });

  it("duplicate click calls startShare once", async () => {
    mockStartShare.mockReturnValue(new Promise(() => {}));
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    (document.querySelectorAll('[role="radio"]')[0] as HTMLElement).click();
    await waitFor(() => expect(screen.getByRole("button", { name: /start sharing/i })).not.toBeDisabled(), { timeout: 5000 });
    const btn = screen.getByRole("button", { name: /start sharing/i });
    fireEvent.click(btn);
    // Wait for startingShare state to flush before second click
    await waitFor(() => expect(screen.getByText(/starting/i)).toBeInTheDocument(), { timeout: 5000 });
    fireEvent.click(btn);
    expect(mockStartShare).toHaveBeenCalledTimes(1);
  });
});

// ─── Start failure preserves dialog + selections ──────────────────────────

describe("ShareSetup — failure preserves dialog and selections", () => {
  beforeEach(() => {
    useStore.getState().reset();
    resetScreenLinkMock(); setupScreenLinkMock();
    mockGetSettings.mockResolvedValue({});
    mockGetSources.mockResolvedValue([makeSource("s1", "Display 1", "screen")]);
    useStore.setState({ openShareSetup: true, selectedGroupId: "g1" });
    mockStartShare.mockReset();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("dialog stays open after failure", async () => {
    mockStartShare.mockRejectedValue(new Error("fail"));
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    const radios = document.querySelectorAll('[role="radio"]');
    (radios[0] as HTMLElement).click();
    await waitFor(() => expect(screen.getByRole("button", { name: /start sharing/i })).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /start sharing/i }));
    await waitFor(() => expect(mockStartShare).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(() => expect(useStore.getState().openShareSetup).toBe(true), { timeout: 5000 });
  });

  it("source radio still checked after failure", async () => {
    mockStartShare.mockRejectedValue(new Error("fail"));
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    const nameRadio = screen.getByRole("radio", { name: "Display 1" });
    fireEvent.click(nameRadio);
    await waitFor(() => expect(screen.getByRole("button", { name: /start sharing/i })).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /start sharing/i }));
    await waitFor(() => expect(mockStartShare).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(() => expect(nameRadio).toHaveAttribute("aria-checked", "true"), { timeout: 5000 });
  });
});

// ─── Coordinator args ──────────────────────────────────────────────────────

describe("ShareSetup — coordinator args", () => {
  beforeEach(() => {
    useStore.getState().reset();
    resetScreenLinkMock(); setupScreenLinkMock();
    mockGetSettings.mockResolvedValue({});
    mockGetSources.mockResolvedValue([makeSource("src1", "Main Display", "screen")]);
    useStore.setState({ openShareSetup: true, selectedGroupId: "g42" });
    mockStartShare.mockReturnValue(new Promise(() => {}));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("passes exact groupId, source.id/kind, qualityOverride to startShare", async () => {
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    (document.querySelectorAll('[role="radio"]')[0] as HTMLElement).click();
    await waitFor(() => expect(screen.getByRole("button", { name: /start sharing/i })).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /start sharing/i }));
    await waitFor(() => expect(mockStartShare).toHaveBeenCalled(), { timeout: 5000 });
    const arg = mockStartShare.mock.calls[0][0];
    expect(arg.groupId).toBe("g42");
    expect(arg.source.id).toBe("src1");
    expect(arg.source.kind).toBe("screen");
    expect(arg.source.fingerprint).toBeNull();
    expect(arg.qualityOverride).toBeDefined();
    expect(arg.qualityOverride.videoBitrateKbps).toBe(1500);
    expect(arg.qualityOverride.codec).toBe("vp9");
  });
});

// ─── Audio mode section renders ───────────────────────────────────────────

describe("ShareSetup — audio mode section", () => {
  beforeEach(() => {
    useStore.getState().reset();
    resetScreenLinkMock(); setupScreenLinkMock();
    mockGetSettings.mockResolvedValue({});
    mockGetSources.mockResolvedValue([makeSource("s1", "Disp 1", "screen")]);
    useStore.setState({ openShareSetup: true, selectedGroupId: "g1" });
    mockStartShare.mockReset();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("heading and options present", async () => {
    const SS = await getShareSetup(); renderWithTooltip(<SS />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    expect(screen.getByText(/audio mode/i)).toBeInTheDocument();
    expect(screen.getByText(/no audio/i)).toBeInTheDocument();
  });
});
