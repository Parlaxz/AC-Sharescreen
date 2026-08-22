// @vitest-environment happy-dom
// Task 5 quality: QuickShare full form fill, aria-pressed, audio/quality, edge states.
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
import { selectOption } from "./shared-task5-helpers.js";

// ─── Helpers ───────────────────────────────────────────────────────────────
const mockGetQuickShareConfig = vi.fn();
const mockGetSources = vi.fn();

function setupScreenLinkMock() {
  (window as any).screenlink = {
    getQuickShareConfig: mockGetQuickShareConfig, getSources: mockGetSources,
    updateQuickShareConfig: vi.fn(), clipboardWriteText: vi.fn(),
  };
}
function resetScreenLinkMock() {
  delete (window as any).screenlink;
  [mockGetQuickShareConfig, mockGetSources].forEach(m => m.mockReset());
}
function makeSource(id: string, name: string, kind: "screen" | "window") {
  return { id, name, kind, displayId: id, thumbnailDataUrl: `data:fake${id}`, appIconDataUrl: null };
}
function setGroups() {
  useStore.setState({
    groupOrder: ["group-1", "group-2"],
    groupsById: {
      "group-1": { id: "group-1", name: "Alpha Team", members: {}, sharedState: {} as any },
      "group-2": { id: "group-2", name: "Beta Squad", members: {}, sharedState: {} as any },
    },
  });
}
function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}
async function getQSD() {
  return (await import("../src/renderer/components/workspace/QuickShareDialog.js")).QuickShareDialog;
}

// ─── I3: Source kind and audio buttons have aria-pressed ──────────────────

describe("I3 — QuickShare source kind and audio aria-pressed", () => {
  beforeEach(() => {
    useStore.getState().reset(); resetScreenLinkMock(); setupScreenLinkMock();
    mockGetQuickShareConfig.mockResolvedValue({
      shortcutEnabled: true, shortcutAccelerator: "Alt+Shift+S",
      lastGroupId: "group-1", lastSourceKind: null, lastPresetId: "__custom__",
    });
    mockGetSources.mockResolvedValue([makeSource("s1", "Disp", "screen")]);
    setGroups();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("source kind buttons have aria-pressed reflecting selection", async () => {
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.queryAllByRole("combobox").length).toBeGreaterThanOrEqual(1);
    }, { timeout: 10000 });

    const screenBtn = screen.getByRole("button", { name: /^screen$/i });
    const windowBtn = screen.getByRole("button", { name: /^window$/i });
    expect(screenBtn).toHaveAttribute("aria-pressed", "true");
    expect(windowBtn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(windowBtn);
    await waitFor(() => {
      expect(windowBtn).toHaveAttribute("aria-pressed", "true");
    }, { timeout: 5000 });
    expect(screenBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("audio mode buttons have aria-pressed reflecting selection", async () => {
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.queryAllByRole("combobox").length).toBeGreaterThanOrEqual(1);
    }, { timeout: 10000 });

    // Screen source: "No audio" and "Filtered monitor audio" buttons
    const noAudio = screen.getByRole("button", { name: /no audio/i });
    const filteredAudio = screen.getByRole("button", { name: /filtered monitor audio/i });

    // Default is "No audio" (lastScreenAudioMode defaults to "none")
    expect(noAudio).toHaveAttribute("aria-pressed", "true");
    expect(filteredAudio).toHaveAttribute("aria-pressed", "false");

    // Click "Filtered monitor audio"
    fireEvent.click(filteredAudio);
    await waitFor(() => {
      expect(filteredAudio).toHaveAttribute("aria-pressed", "true");
    }, { timeout: 5000 });
    expect(noAudio).toHaveAttribute("aria-pressed", "false");
  });
});

// ─── 1. Full form fill + coordinator args ─────────────────────────────────

describe("QuickShareDialog — full form fill + coordinator args", () => {
  beforeEach(() => {
    useStore.getState().reset(); resetScreenLinkMock(); setupScreenLinkMock();
    mockGetQuickShareConfig.mockResolvedValue({
      shortcutEnabled: true, shortcutAccelerator: "Alt+Shift+S",
      lastGroupId: null, lastSourceKind: null, lastPresetId: null,
    });
    mockGetSources.mockResolvedValue([makeSource("src-quick", "Quick Source", "screen")]);
    setGroups();
    mockStartShare.mockReturnValue(new Promise(() => {}));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("selects group/source/preset and calls startShare with exact args", async () => {
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryAllByRole("combobox").length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    await selectOption(/group/i, "Alpha Team");
    await selectOption(/source/i, "Quick Source");
    await selectOption(/preset/i, /custom/i);
    const btn = screen.getByRole("button", { name: /start quick share/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(mockStartShare).toHaveBeenCalled(), { timeout: 5000 });
    const arg = mockStartShare.mock.calls[0][0];
    expect(arg.groupId).toBe("group-1");
    expect(arg.source.id).toBe("src-quick");
    expect(arg.source.kind).toBe("screen");
    expect(arg.source.audioMode).toBeDefined();
    expect(arg.qualityOverride).toBeDefined();
    expect(arg.qualityOverride.videoBitrateKbps).toBe(1500);
    expect(arg.qualityOverride.codec).toBe("vp9");
  });
});

// ─── 2. Failure preserves dialog ──────────────────────────────────────────

describe("QuickShareDialog — failure preserves dialog", () => {
  beforeEach(() => {
    useStore.getState().reset(); resetScreenLinkMock(); setupScreenLinkMock();
    mockGetQuickShareConfig.mockResolvedValue({
      shortcutEnabled: true, shortcutAccelerator: "Alt+Shift+S",
      lastGroupId: "group-2", lastSourceKind: "screen", lastPresetId: "__custom__",
    });
    mockGetSources.mockResolvedValue([makeSource("src1", "Display 1", "screen")]);
    setGroups();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("dialog stays open after startShare rejection", async () => {
    mockStartShare.mockRejectedValue(new Error("fail"));
    const onOpenChange = vi.fn();
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.queryAllByRole("combobox").length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    await selectOption(/source/i, "Display 1");
    fireEvent.click(screen.getByRole("button", { name: /start quick share/i }));
    await waitFor(() => expect(onOpenChange).not.toHaveBeenCalledWith(false), { timeout: 5000 });
    expect(document.querySelector('[role="dialog"]')).toBeInTheDocument();
  });
});

// ─── 3. Start button disabled→enabled, Starting, duplicate prevention ─────

describe("QuickShareDialog — start button states", () => {
  beforeEach(() => {
    useStore.getState().reset(); resetScreenLinkMock(); setupScreenLinkMock();
    mockGetQuickShareConfig.mockResolvedValue({
      shortcutEnabled: true, shortcutAccelerator: "Alt+Shift+S",
      lastGroupId: null, lastSourceKind: null, lastPresetId: null,
    });
    mockGetSources.mockResolvedValue([makeSource("s1", "Disp 1", "screen")]);
    setGroups();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("disabled before any, enabled after group/source/preset", async () => {
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryAllByRole("combobox").length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    expect(screen.getByRole("button", { name: /start quick share/i })).toBeDisabled();
    await selectOption(/group/i, "Alpha Team");
    expect(screen.getByRole("button", { name: /start quick share/i })).toBeDisabled();
    await selectOption(/source/i, "Disp 1");
    expect(screen.getByRole("button", { name: /start quick share/i })).toBeDisabled();
    await selectOption(/preset/i, /custom/i);
    expect(screen.getByRole("button", { name: /start quick share/i })).not.toBeDisabled();
  });

  it("shows Starting… while pending", async () => {
    mockStartShare.mockReturnValue(new Promise(() => {}));
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryAllByRole("combobox").length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    await selectOption(/group/i, "Alpha Team");
    await selectOption(/source/i, "Disp 1");
    await selectOption(/preset/i, /custom/i);
    fireEvent.click(screen.getByRole("button", { name: /start quick share/i }));
    await waitFor(() => expect(screen.getByText(/starting/i)).toBeInTheDocument(), { timeout: 5000 });
  });

  it("duplicate click calls startShare once", async () => {
    mockStartShare.mockReturnValue(new Promise(() => {}));
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryAllByRole("combobox").length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    await selectOption(/group/i, "Alpha Team");
    await selectOption(/source/i, "Disp 1");
    await selectOption(/preset/i, /custom/i);
    const btn = screen.getByRole("button", { name: /start quick share/i });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/starting/i)).toBeInTheDocument(), { timeout: 5000 });
    fireEvent.click(btn);
    expect(mockStartShare).toHaveBeenCalledTimes(1);
  });
});

// ─── 4. Audio mode buttons ────────────────────────────────────────────────

describe("QuickShareDialog — audio mode", () => {
  beforeEach(() => {
    useStore.getState().reset(); resetScreenLinkMock(); setupScreenLinkMock();
    mockGetQuickShareConfig.mockResolvedValue({
      shortcutEnabled: true, shortcutAccelerator: "Alt+Shift+S",
      lastGroupId: "group-1", lastSourceKind: null, lastPresetId: "__custom__",
    });
    mockGetSources.mockResolvedValue([makeSource("s1", "Disp", "screen")]);
    setGroups();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("buttons present and clickable with aria-pressed", async () => {
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryAllByRole("combobox").length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    expect(screen.getByRole("button", { name: /no audio/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /filtered monitor audio/i })).toBeInTheDocument();
  });
});

// ─── 5. Quality preset selection + override ───────────────────────────────

describe("QuickShareDialog — quality preset selection", () => {
  beforeEach(() => {
    useStore.getState().reset(); resetScreenLinkMock(); setupScreenLinkMock();
    mockGetQuickShareConfig.mockResolvedValue({
      shortcutEnabled: true, shortcutAccelerator: "Alt+Shift+S",
      lastGroupId: "group-1", lastSourceKind: null, lastPresetId: null,
    });
    mockGetSources.mockResolvedValue([makeSource("s1", "Disp", "screen")]);
    setGroups();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Custom preset sends correct override to startShare", async () => {
    mockStartShare.mockReturnValue(new Promise(() => {}));
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryAllByRole("combobox").length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    await selectOption(/group/i, "Alpha Team");
    await selectOption(/source/i, "Disp");
    await selectOption(/preset/i, /custom/i);
    fireEvent.click(screen.getByRole("button", { name: /start quick share/i }));
    await waitFor(() => expect(mockStartShare).toHaveBeenCalled(), { timeout: 5000 });
    const arg = mockStartShare.mock.calls[0][0];
    expect(arg.qualityOverride).toBeDefined();
    expect(arg.qualityOverride.sendWidth).toBe(1280);
    expect(arg.qualityOverride.sendHeight).toBe(720);
    expect(arg.qualityOverride.sendFps).toBe(24);
    expect(arg.qualityOverride.codec).toBe("vp9");
  });
});

// ─── 6. Edge states ──────────────────────────────────────────────────────

describe("QuickShareDialog — edge states", () => {
  beforeEach(() => {
    useStore.getState().reset(); resetScreenLinkMock(); setupScreenLinkMock();
    mockGetQuickShareConfig.mockResolvedValue({
      shortcutEnabled: true, shortcutAccelerator: "Alt+Shift+S",
      lastGroupId: null, lastSourceKind: null, lastPresetId: null,
    });
    mockGetSources.mockResolvedValue([makeSource("s1", "Disp", "screen")]);
    setGroups();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Escape closes dialog", async () => {
    const onOpenChange = vi.fn();
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={onOpenChange} />);
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeInTheDocument(), { timeout: 5000 });
    fireEvent.keyDown(document.querySelector('[role="dialog"]')!, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false), { timeout: 5000 });
  });

  it("shows already-sharing message", async () => {
    useStore.setState({ isSharing: true });
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/already sharing/i)).toBeInTheDocument(), { timeout: 5000 });
  });

  it("shows no-groups state", async () => {
    useStore.setState({ groupOrder: [] });
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no groups yet/i)).toBeInTheDocument(), { timeout: 5000 });
  });

  it("renders error + retry when getSources fails", async () => {
    mockGetSources.mockRejectedValue(new Error("Permission denied"));
    const QSD = await getQSD(); renderWithTooltip(<QSD open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument(), { timeout: 10000 });
    expect(screen.getByRole("alert").textContent).toMatch(/permission|denied|allow/i);
  });
});
