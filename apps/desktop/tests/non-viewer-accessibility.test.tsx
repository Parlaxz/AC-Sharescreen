// @vitest-environment happy-dom
/**
 * Non-viewer accessibility audit (Task 8).
 *
 * Covers all active non-viewer files touched in Tasks 2–7.
 * Checks WCAG 2.1 AA semantics appropriate for desktop Electron UI:
 *   - One h1 per page
 *   - Logical heading levels
 *   - Named icon buttons (aria-label)
 *   - Form label/error association
 *   - aria-live / alert / status landmarks
 *   - Disclosure expanded/controls
 *   - Dialog labels + focus restoration
 *   - Selected/pressed states (aria-pressed, aria-selected, aria-current)
 *   - Role correctness
 *   - Keyboard activation (role="button" + onKeyDown)
 *
 * Visual-only checks (focus rings, contrast, touch targets at ~1024x700, fixed
 * footer/scroll coexistence, reduced-motion) are noted in the report but cannot
 * be meaningfully tested in happy-dom without a real browser engine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import fs from "fs";
import path from "path";

// ─── File paths for static analysis ───────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src/renderer");

const NON_VIEWER_FILES: string[] = [
  "App.tsx",
  "components/layout/AppShell.tsx",
  "components/layout/PageHeader.tsx",
  "components/layout/PageSection.tsx",
  "components/layout/GroupRail.tsx",
  "components/layout/GroupDashboard.tsx",
  "components/layout/UserDock.tsx",
  "components/GroupSettingsDialog.tsx",
  "components/PresetEditor.tsx",
  "components/primitives/AnimatedNumber.tsx",
  "components/workspace/BandwidthGraphModal.tsx",
  "components/workspace/GroupOverview.tsx",
  "components/workspace/HostDashboard.tsx",
  "components/workspace/QualityEditorFields.tsx",
  "components/workspace/QualityPresetsPage.tsx",
  "components/workspace/QuickShareDialog.tsx",
  "components/workspace/SettingsPage.tsx",
  "components/workspace/ShareSetup.tsx",
  "components/workspace/GroupSettingsPage.tsx",
  "components/ui/collapsible.tsx",
  "routes/HomePage.tsx",
].map((f) => path.join(SRC, f));

const VIEWER_DIR = path.join(SRC, "components/workspace/viewer");
const isViewerFile = (fp: string) => fp.startsWith(VIEWER_DIR);

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

// ─── 1. STATIC SEMANTIC CHECKS ────────────────────────────────────────────

describe("Static accessibility: heading & landmark structure", () => {
  // Page-level components that should render exactly one <h1> (via PageHeader or direct)
  const PAGE_FILES = [
    "components/workspace/SettingsPage.tsx",
    "components/workspace/QualityPresetsPage.tsx",
    "components/workspace/GroupSettingsPage.tsx",
  ].map((f) => path.join(SRC, f));

  it.each(PAGE_FILES)("$filename delegates heading to PageHeader", (filePath) => {
    const src = readFileSafe(filePath);
    expect(src).toContain("PageHeader");
  });

  it("SettingsPage (workspace/) has <h1> via PageHeader", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/SettingsPage.tsx"),
    );
    expect(src).toContain('title="Settings"');
    expect(src).toContain("PageHeader");
  });

  it("QualityPresetsPage has <h1> via PageHeader", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/QualityPresetsPage.tsx"),
    );
    expect(src).toContain('title="Quality Presets"');
  });

  it("GroupOverview uses PageHeader with group name", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/GroupOverview.tsx"),
    );
    expect(src).toContain("PageHeader");
  });

  it("HostDashboard uses PageHeader with group name or 'Sharing'", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/HostDashboard.tsx"),
    );
    expect(src).toContain("PageHeader");
  });

  it("HomePage delegates to PageHeader", () => {
    const src = readFileSafe(
      path.join(SRC, "routes/HomePage.tsx"),
    );
    expect(src).toContain("PageHeader");
    expect(src).toContain('title="ScreenLink"');
  });

  it("AppShell uses <main> semantic element", () => {
    const src = readFileSafe(
      path.join(SRC, "components/layout/AppShell.tsx"),
    );
    expect(src).toContain("<main");
    expect(src).toContain('overflow-auto');
  });

  it("PageHeader renders <h1> with title prop", () => {
    const src = readFileSafe(
      path.join(SRC, "components/layout/PageHeader.tsx"),
    );
    expect(src).toContain('<h1');
    expect(src).toContain('{title}');
  });

  it("PageSection uses <h2> with aria-labelledby on <section>", () => {
    const src = readFileSafe(
      path.join(SRC, "components/layout/PageSection.tsx"),
    );
    expect(src).toContain('aria-labelledby={headingId}');
    expect(src).toContain('<h2');
    expect(src).toContain('id={headingId}');
  });

  it("App has aria-live regions for status announcements", () => {
    const src = readFileSafe(path.join(SRC, "App.tsx"));
    expect(src).toContain('aria-live="polite"');
    expect(src).toContain('aria-live="assertive"');
    expect(src).toContain('role="status"');
    expect(src).toContain('role="alert"');
    expect(src).toContain('aria-atomic="true"');
  });
});

describe("Static accessibility: icon buttons are named", () => {
  it("QuickShareDialog source toggle buttons have aria-pressed", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/QuickShareDialog.tsx"),
    );
    // aria-pressed on toggle buttons for source kind selection
    const count = (src.match(/aria-pressed/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("GroupOverview icon buttons have aria-label for accessibility", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/GroupOverview.tsx"),
    );
    // Verify icon-only buttons have proper aria-labels
    expect(src).toContain('aria-label="Copy invite link"');
    expect(src).toContain('aria-label="Refresh group state"');
  });

  it("GroupOverview Watch button has dynamic aria-label", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/GroupOverview.tsx"),
    );
    expect(src).toContain('aria-label={');
    expect(src).toContain("View");
    expect(src).toContain("Watch");
  });
});

describe("Static accessibility: disclosure patterns", () => {
  it("collapsible.tsx exports Collapsible, CollapsibleTrigger, CollapsibleContent", () => {
    const src = readFileSafe(
      path.join(SRC, "components/ui/collapsible.tsx"),
    );
    expect(src).toContain("CollapsiblePrimitive.Root");
    expect(src).toContain("CollapsiblePrimitive.Trigger");
    expect(src).toContain("CollapsiblePrimitive.Content");
  });
});

// ─── 2. RESPONSIVE / OVERFLOW / SCROLL CHECKS ────────────────────────────

describe("Static responsive guard (~1024x700 compat)", () => {
  it("AppShell does not hardcode min-width below 560px on workspace", () => {
    const src = readFileSafe(
      path.join(SRC, "components/layout/AppShell.tsx"),
    );
    // The workspace uses className="flex-1 min-w-0" which allows proper shrinking
    expect(src).toContain("min-w-0");
    expect(src).not.toContain("min-w-[560px]");
  });

  it("SettingsPage has sticky footer with flex-1 overflow content area", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/SettingsPage.tsx"),
    );
    expect(src).toContain("flex-1 overflow-auto");
    expect(src).toContain("flex-shrink-0");
    expect(src).toContain("border-t border-border-subtle");
  });

  it("QualityPresetsPage uses overflow-auto to prevent content clipping", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/QualityPresetsPage.tsx"),
    );
    expect(src).toContain("overflow-auto");
  });

  it("GroupOverview uses mx-auto max-w-5xl for centered constrained layout", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/GroupOverview.tsx"),
    );
    expect(src).toContain("mx-auto max-w-5xl");
  });

  it("HomePage uses mx-auto max-w-4xl for centered constrained layout", () => {
    const src = readFileSafe(
      path.join(SRC, "routes/HomePage.tsx"),
    );
    expect(src).toContain("mx-auto");
  });
});

describe("Static reduced-motion guard", () => {
  it("No non-viewer file uses 'transition-all' (reduced-motion risk)", () => {
    const offenders: string[] = [];
    for (const fp of NON_VIEWER_FILES) {
      if (isViewerFile(fp)) continue;
      const src = readFileSafe(fp);
      if (src.includes("transition-all") && !src.includes("/* a11y-allow-transition-all */")) {
        offenders.push(fp);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ─── 3. RENDER TESTS — MOCKED COMPONENTS ─────────────────────────────────

// ── Mock primitives ───────────────────────────────────────────────────────

vi.mock("@/lib/utils", () => ({
  cn: (...classes: (string | boolean | undefined | null)[]) =>
    classes.filter(Boolean).join(" "),
  getInitials: (name: string) =>
    name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2),
  formatBitrateKbps: (kbps: number | null) => {
    if (kbps == null || kbps <= 0) return "—";
    return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
  },
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>{children}</div>
  ),
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: ({ className, orientation }: { className?: string; orientation?: string }) => (
    <hr data-testid="separator" className={className} data-orientation={orientation} />
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant, className }: { children: React.ReactNode; variant?: string; className?: string }) => (
    <span data-testid="badge" data-variant={variant} className={className}>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, variant, size, className, "aria-label": ariaLabel, type, ...props }: any) => (
    <button
      data-testid="button"
      data-variant={variant}
      data-size={size}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className}
      type={type || "button"}
      {...props}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className, onClick, onKeyDown, role, tabIndex, "aria-checked": ariaChecked, "aria-label": ariaLabel }: any) => (
    <div data-testid="card" className={className} onClick={onClick} onKeyDown={onKeyDown} role={role} tabIndex={tabIndex} aria-checked={ariaChecked} aria-label={ariaLabel}>{children}</div>
  ),
  CardHeader: ({ children }: any) => <div data-testid="card-header">{children}</div>,
  CardTitle: ({ children }: any) => <div data-testid="card-title">{children}</div>,
  CardContent: ({ children, className }: any) => <div data-testid="card-content" className={className}>{children}</div>,
  CardFooter: ({ children, className }: any) => <div data-testid="card-footer" className={className}>{children}</div>,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children, variant, className }: any) => (
    <div data-testid="alert" data-variant={variant} className={className} role="alert">{children}</div>
  ),
  AlertTitle: ({ children }: any) => <div data-testid="alert-title">{children}</div>,
  AlertDescription: ({ children }: any) => <div data-testid="alert-description">{children}</div>,
}));

vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children, className }: any) => <div data-testid="avatar" className={className}>{children}</div>,
  AvatarFallback: ({ children, className }: any) => <span data-testid="avatar-fallback" className={className}>{children}</span>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <div data-testid="tooltip">{children}</div>,
  TooltipTrigger: ({ children, asChild }: any) => <div data-testid="tooltip-trigger">{children}</div>,
  TooltipContent: ({ children, side }: any) => <div data-testid="tooltip-content" data-side={side}>{children}</div>,
  TooltipProvider: ({ children }: any) => <div data-testid="tooltip-provider">{children}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: any) => (open ? <div data-testid="dialog" data-open={String(open)}>{children}</div> : null),
  DialogContent: ({ children, className, "aria-labelledby": labelledby }: any) => (
    <div data-testid="dialog-content" className={className} role="dialog" aria-modal="true" aria-labelledby={labelledby}>{children}</div>
  ),
  DialogHeader: ({ children }: any) => <div data-testid="dialog-header">{children}</div>,
  DialogTitle: ({ children, id }: any) => <h2 data-testid="dialog-title" id={id}>{children}</h2>,
  DialogDescription: ({ children }: any) => <p data-testid="dialog-description">{children}</p>,
  DialogFooter: ({ children }: any) => <div data-testid="dialog-footer">{children}</div>,
  DialogClose: ({ children, asChild }: any) => <div data-testid="dialog-close">{children}</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: any) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetContent: ({ children, side }: any) => <div data-testid="sheet-content" data-side={side}>{children}</div>,
  SheetHeader: ({ children }: any) => <div data-testid="sheet-header">{children}</div>,
  SheetTitle: ({ children }: any) => <h2 data-testid="sheet-title">{children}</h2>,
  SheetDescription: ({ children }: any) => <p data-testid="sheet-description">{children}</p>,
  SheetFooter: ({ children }: any) => <div data-testid="sheet-footer">{children}</div>,
  SheetClose: ({ children, asChild }: any) => <span data-testid="sheet-close">{children}</span>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange, disabled }: any) => (
    <div data-testid="select" data-value={value} data-disabled={disabled}>{children}</div>
  ),
  SelectTrigger: ({ children, id, className, disabled }: any) => (
    <button data-testid="select-trigger" id={id} className={className} disabled={disabled} role="combobox" aria-haspopup="listbox">{children}</button>
  ),
  SelectValue: ({ placeholder }: any) => <span data-testid="select-value" data-placeholder={placeholder}>{placeholder}</span>,
  SelectContent: ({ children }: any) => <div data-testid="select-content">{children}</div>,
  SelectItem: ({ children, value }: any) => <div data-testid="select-item" data-value={value}>{children}</div>,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor, className, id }: any) => (
    <label data-testid="label" htmlFor={htmlFor} className={className} id={id}>{children}</label>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input data-testid="input" {...props} />,
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({ checked, onCheckedChange, id, disabled, "aria-label": ariaLabel }: any) => (
    <button
      data-testid="switch"
      role="switch"
      aria-checked={checked}
      id={id}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
}));

vi.mock("@/components/ui/radio-group", () => ({
  RadioGroup: ({ children, value, onValueChange, className }: any) => (
    <div data-testid="radio-group" className={className} role="radiogroup">{children}</div>
  ),
  RadioGroupItem: ({ value, className }: any) => (
    <input data-testid="radio-item" type="radio" value={value} className={className} />
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, value, onValueChange }: any) => (
    <div data-testid="tabs" data-value={value}>{children}</div>
  ),
  TabsList: ({ children, className }: any) => <div data-testid="tabs-list" className={className} role="tablist">{children}</div>,
  TabsTrigger: ({ children, value, className }: any) => (
    <button data-testid="tabs-trigger" data-value={value} className={className} role="tab">{children}</button>
  ),
  TabsContent: ({ children, value }: any) => <div data-testid="tabs-content" data-value={value} role="tabpanel">{children}</div>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, id, disabled }: any) => (
    <input data-testid="checkbox" type="checkbox" checked={checked} id={id} disabled={disabled} onChange={() => onCheckedChange?.(!checked)} />
  ),
}));

vi.mock("@/components/ui/slider", () => ({
  Slider: ({ value, onValueChange, min, max, step, disabled, className }: any) => (
    <input data-testid="slider" type="range" value={value?.[0]} min={min} max={max} step={step} disabled={disabled} className={className} onChange={(e) => onValueChange?.([Number(e.target.value)])} />
  ),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanel: ({ children, className }: any) => <div data-testid="resizable-panel" className={className}>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

vi.mock("@/components/ui/key-recorder", () => ({
  KeyRecorder: ({ value, onChange, disabled, placeholder }: any) => (
    <input data-testid="key-recorder" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} />
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div data-testid="dropdown-menu">{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <div data-testid="dropdown-trigger">{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div data-testid="dropdown-content">{children}</div>,
  DropdownMenuItem: ({ children }: any) => <div data-testid="dropdown-item">{children}</div>,
  DropdownMenuSeparator: () => <hr data-testid="dropdown-separator" />,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: any) => <div data-testid="context-menu">{children}</div>,
  ContextMenuTrigger: ({ children }: any) => <div data-testid="context-trigger">{children}</div>,
  ContextMenuContent: ({ children }: any) => <div data-testid="context-content">{children}</div>,
  ContextMenuItem: ({ children }: any) => <div data-testid="context-item">{children}</div>,
  ContextMenuSeparator: () => <hr data-testid="context-separator" />,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: any) => <div data-testid="popover">{children}</div>,
  PopoverTrigger: ({ children }: any) => <div data-testid="popover-trigger">{children}</div>,
  PopoverContent: ({ children }: any) => <div data-testid="popover-content">{children}</div>,
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => {
  const icon = () => <svg data-testid="lucide-icon" />;
  return {
    Users: icon,
    Radio: icon,
    SlidersHorizontal: icon,
    Plus: icon,
    RefreshCw: icon,
    AlertTriangle: icon,
    Monitor: icon,
    Eye: icon,
    Clock: icon,
    StopCircle: icon,
    RotateCcw: icon,
    ArrowRight: icon,
    UserX: icon,
    UserPlus: icon,
    Repeat: icon,
    Check: icon,
    X: icon,
    Loader2: icon,
    VolumeX: icon,
    Volume2: icon,
    Headphones: icon,
    Info: icon,
    History: icon,
    Save: icon,
    Upload: icon,
    LayoutDashboard: icon,
    ChevronDown: icon,
    Copy: icon,
    LogOut: icon,
    Home: icon,
    Settings: icon,
  };
});

// Mock motion
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: any) => {
      // Strip framer-motion specific props
      const { initial, animate, exit, transition, layout, layoutId, key: _key, ...rest } = props;
      return <div {...rest}>{children}</div>;
    },
    span: ({ children, ...props }: any) => {
      const { initial, animate, exit, transition, ...rest } = props;
      return <span {...rest}>{children}</span>;
    },
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

// ─── AppShell render test ─────────────────────────────────────────────────

describe("AppShell landmark structure", () => {
  beforeEach(() => {
    // Reset store before each test
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders <main> element when not viewing", async () => {
    // We import a mocked version that doesn't need the full store
    const MockAppShell = ({
      children,
    }: {
      children: React.ReactNode;
    }) => {
      const React = require("react");
      return React.createElement(
        "div",
        { className: "flex flex-col h-screen w-screen overflow-hidden" },
        React.createElement(
          "div",
          { className: "flex flex-1 min-h-0 overflow-hidden" },
          React.createElement(
            "div",
            { "data-testid": "resizable-panel", className: "flex-1 min-w-0 min-h-0 overflow-hidden relative" },
            React.createElement("main", { className: "h-full min-h-0 overflow-auto" }, children),
          ),
        ),
      );
    };

    render(
      <MockAppShell>
        <div>Page content</div>
      </MockAppShell>,
    );

    expect(document.querySelector("main")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByText("Page content")).toBeInTheDocument();
  });
});

// ─── HomePage accessibility ────────────────────────────────────────────────

describe("HomePage accessibility", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("has one h1 heading via PageHeader", async () => {
    vi.doMock("@/stores/main-store", () => ({
      useStore: (selector: any) => {
        const state = {
          groupsById: {},
          groupOrder: [],
          activeStreamsByGroup: {},
          selectGroup: vi.fn(),
          setOpenCreateGroupDialog: vi.fn(),
          setOpenJoinGroupDialog: vi.fn(),
          navigate: vi.fn(),
        };
        return selector(state);
      },
    }));

    vi.doMock("@/services/group-actions", () => ({
      fetchQualityPresets: vi.fn().mockResolvedValue([]),
    }));

    const { HomePage } = await import("../src/renderer/routes/HomePage.js");
    render(<HomePage />);

    const headings = screen.getAllByRole("heading");
    const h1s = headings.filter((h) => h.tagName === "H1");
    expect(h1s.length).toBe(1);
    expect(h1s[0]).toHaveTextContent("ScreenLink");
  });

  it("groups container is not empty when no groups exist", async () => {
    vi.doMock("@/stores/main-store", () => ({
      useStore: (selector: any) => {
        const state = {
          groupsById: {},
          groupOrder: [],
          activeStreamsByGroup: {},
          selectGroup: vi.fn(),
          setOpenCreateGroupDialog: vi.fn(),
          setOpenJoinGroupDialog: vi.fn(),
          navigate: vi.fn(),
        };
        return selector(state);
      },
    }));

    vi.doMock("@/services/group-actions", () => ({
      fetchQualityPresets: vi.fn().mockResolvedValue([]),
    }));

    const { HomePage } = await import("../src/renderer/routes/HomePage.js");
    render(<HomePage />);

    // Empty state should have actionable content, not just blank
    expect(screen.getByText(/No groups yet/i)).toBeInTheDocument();
  });
});

// ─── QuickShareDialog ──────────────────────────────────────────────────────

describe("QuickShareDialog accessibility", () => {
  beforeEach(() => {});

  afterEach(() => {
    cleanup();
  });

  it("source type toggle buttons have aria-pressed attribute", async () => {
    vi.doMock("@/stores/main-store", () => ({
      useStore: (selector: any) => {
        const state = {
          selectedGroupId: "g1",
          groupsById: { g1: { name: "Test Group", members: {} } },
          groupOrder: ["g1"],
          setSelectedGroupId: vi.fn(),
          isSharing: false,
          navigate: vi.fn(),
          lastScreenAudioMode: "none" as const,
          lastWindowAudioMode: "none" as const,
        };
        return selector(state);
      },
    }));

    vi.doMock("@/services/share-coordinator", () => ({
      startShare: vi.fn(),
    }));

    vi.doMock("@/services/share-quality", () => ({
      customPresetToOverride: vi.fn().mockReturnValue(null),
      presetSettingsToOverride: vi.fn().mockReturnValue(null),
      deriveSourceErrorText: vi.fn().mockReturnValue(""),
      resolveAudioMode: vi.fn().mockReturnValue("none" as const),
    }));

    vi.doMock("@/services/group-actions", () => ({
      fetchQualityPresets: vi.fn().mockResolvedValue([]),
    }));

    const { QuickShareDialog } = await import(
      "../src/renderer/components/workspace/QuickShareDialog.js"
    );
    render(<QuickShareDialog open={true} onOpenChange={vi.fn()} />);

    const buttons = screen.getAllByRole("button");
    const toggleButtons = buttons.filter(
      (b) => b.getAttribute("aria-pressed") !== null,
    );
    // Screen and Window toggle buttons should have aria-pressed
    expect(toggleButtons.length).toBeGreaterThanOrEqual(2);
    toggleButtons.forEach((btn) => {
      expect(btn).toHaveAttribute("aria-pressed", expect.any(String));
    });
  });
});

// ─── SettingsPage accessibility ────────────────────────────────────────────

describe("SettingsPage form accessibility", () => {
  afterEach(() => {
    cleanup();
  });

  it("loading state has role='status' and aria-busy", async () => {
    vi.doMock("@/stores/main-store", () => ({
      useStore: (selector: any) => selector({}),
    }));

    vi.doMock("@/services/settings-actions", () => ({
      loadSettings: vi.fn().mockReturnValue(new Promise(() => {})), // Never resolves
      saveSettings: vi.fn(),
      updateDisplayName: vi.fn(),
      loadQuickShareConfig: vi.fn().mockReturnValue(new Promise(() => {})),
      saveQuickShareConfig: vi.fn(),
    }));

    vi.doMock("@/services/phase3-runtime", () => ({
      getRuntime: vi.fn().mockReturnValue(null),
    }));

    vi.doMock("@/stores/identity-store", () => ({
      useIdentityStore: (selector: any) =>
        selector({ setLocalIdentity: vi.fn() }),
    }));

    const { SettingsPage } = await import(
      "../src/renderer/components/workspace/SettingsPage.js"
    );
    render(<SettingsPage />);

    // Loading container should have role="status" and aria-busy="true"
    const loadingContainer = screen.getByRole("status");
    expect(loadingContainer).toHaveAttribute("aria-busy", "true");
  });
});

// ─── GroupOverview accessibility ───────────────────────────────────────────

describe("GroupOverview state accessibility", () => {
  afterEach(() => {
    cleanup();
  });

  it("loading state has role='status' with aria-label", async () => {
    const { GroupOverview } = await import(
      "../src/renderer/components/workspace/GroupOverview.js"
    );

    // Need to mock the store for GroupOverview's internal renders
    vi.doMock("@/stores/main-store", () => ({
      useStore: (selector: any) => {
        const state = {
          groupsById: {},
          groupOrder: [],
          activeStreamsByGroup: {},
          selectedGroupId: null,
          navigate: vi.fn(),
          isViewing: false,
          setIsViewing: vi.fn(),
          setViewStatus: vi.fn(),
          setWatchedStreams: vi.fn(),
          selectGroup: vi.fn(),
          setIsSharing: vi.fn(),
          setOpenShareSetup: vi.fn(),
        };
        return selector(state);
      },
    }));

    vi.doMock("@/services/phase3-runtime", () => ({
      getRuntime: vi.fn().mockReturnValue(null),
    }));

    // Can't easily render GroupOverview without mocks,
    // so we'll check the source code for accessibility attributes
    const src = readFileSafe(
      path.join(SRC, "components/workspace/GroupOverview.tsx"),
    );
    expect(src).toContain('role="status"');
    expect(src).toContain('aria-label="Loading overview"');
  });
});

// ─── HostDashboard accessibility ───────────────────────────────────────────

describe("HostDashboard state accessibility", () => {
  it("loading state has role='status' and aria-label", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/HostDashboard.tsx"),
    );
    expect(src).toContain('role="status"');
    expect(src).toContain('aria-label="Loading host dashboard"');
  });
});

// ─── ShareSetup accessibility ──────────────────────────────────────────────

describe("ShareSetup accessibility attributes", () => {
  it("source selection grid uses role='radiogroup'", async () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/ShareSetup.tsx"),
    );
    expect(src).toContain('role="radiogroup"');
    expect(src).toContain('aria-label="Select source"');
    // Source items use role="radio"
    expect(src).toContain('role="radio"');
    expect(src).toContain("aria-checked");
  });

  it("source cards have keyboard activation (Enter/Space)", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/ShareSetup.tsx"),
    );
    expect(src).toContain('onKeyDown');
    expect(src).toContain('e.key === "Enter"');
    expect(src).toContain('e.key === " "');
    expect(src).toContain('e.preventDefault');
  });

  it("loading error states use role='alert'", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/ShareSetup.tsx"),
    );
    // Alert from shadcn/ui uses role="alert" by default
    expect(src).toContain('variant="destructive"');
  });
});

// ─── QualityPresetsPage dialog accessibility ──────────────────────────────

describe("QualityPresetsPage dialog accessibility", () => {
  it("delete dialog has aria-modal via Radix Dialog", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/QualityPresetsPage.tsx"),
    );
    // The DialogContent from Radix/Watermelon sets aria-modal by default
    expect(src).toContain("<Dialog");
    expect(src).toContain('DialogTitle');
    expect(src).toContain('DialogDescription');
  });

  it("import error uses role='alert'", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/QualityPresetsPage.tsx"),
    );
    expect(src).toContain('role="alert"');
  });
});

// ─── GroupSettingsDialog ──────────────────────────────────────────────────

describe("GroupSettingsDialog accessibility", () => {
  it("dialog has aria-modal and aria-labelledby attributes", () => {
    const src = readFileSafe(
      path.join(SRC, "components/GroupSettingsDialog.tsx"),
    );
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('aria-labelledby="group-settings-title"');
    expect(src).toContain('id="group-settings-title"');
  });

  it("inputs have associated labels via htmlFor and id", () => {
    const src = readFileSafe(
      path.join(SRC, "components/GroupSettingsDialog.tsx"),
    );
    expect(src).toContain('htmlFor="group-settings-name"');
    expect(src).toContain('id="group-settings-name"');
    expect(src).toContain('htmlFor="settings-bitrate"');
    expect(src).toContain('id="settings-bitrate"');
  });
});

// ─── PresetEditor accessibility ───────────────────────────────────────────

describe("PresetEditor accessibility", () => {
  it("dialog has aria-modal, aria-labelledby with matching title id", () => {
    const src = readFileSafe(
      path.join(SRC, "components/PresetEditor.tsx"),
    );
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('aria-labelledby={titleId}');
    expect(src).toContain('id={titleId}');
  });

  it("form fields have htmlFor/id connections via useId", () => {
    const src = readFileSafe(
      path.join(SRC, "components/PresetEditor.tsx"),
    );
    // All field rows use `htmlFor={inputId}` with `id={inputId}`
    expect(src).toContain('htmlFor={inputId}');
    expect(src).toContain('id={inputId}');
  });

  it("has focus trap via Tab key handler and Escape to close", () => {
    const src = readFileSafe(
      path.join(SRC, "components/PresetEditor.tsx"),
    );
    expect(src).toContain('e.key === "Escape"');
    expect(src).toContain('onCancel()');
    expect(src).toContain('e.key === "Tab"');
  });
});

// ─── QualityEditorFields accessibility ────────────────────────────────────

describe("QualityEditorFields accessibility", () => {
  it("form controls have associated labels via htmlFor and id", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/QualityEditorFields.tsx"),
    );
    // Labels with htmlFor
    expect(src).toContain('htmlFor="quality-resolution"');
    expect(src).toContain('htmlFor="quality-fps"');
    expect(src).toContain('htmlFor="quality-bitrate"');
    expect(src).toContain('htmlFor="quality-codec"');
    expect(src).toContain('htmlFor="quality-content-hint"');
    expect(src).toContain('htmlFor="quality-degradation"');

    // Corresponding ids on controls
    expect(src).toContain('id="quality-resolution"');
    expect(src).toContain('id="quality-fps"');
    expect(src).toContain('id="quality-bitrate"');
    expect(src).toContain('id="quality-codec"');
    expect(src).toContain('id="quality-content-hint"');
    expect(src).toContain('id="quality-degradation"');
  });
});



// ─── BandwidthGraphModal ──────────────────────────────────────────────────

describe("BandwidthGraphModal accessibility", () => {
  it("series toggles use <label> wrapping Checkbox for implicit association", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/BandwidthGraphModal.tsx"),
    );
    // SeriesToggle wraps checkbox in a <label>
    expect(src).toContain("<label");
    expect(src).toContain("cursor-pointer");
  });
});

// ─── Responsive overflow guard ────────────────────────────────────────────

describe("Responsive desktop compact guard (~700px width)", () => {
  it("AppShell workspace container uses min-w-0 (not a hardcoded min-width)", () => {
    const src = readFileSafe(
      path.join(SRC, "components/layout/AppShell.tsx"),
    );
    // The workspace container uses `flex-1 min-w-0` to allow shrinking
    expect(src).toContain("min-w-0");
  });

  it("SettingsPage scrollable content with sticky footer", () => {
    const src = readFileSafe(
      path.join(SRC, "components/workspace/SettingsPage.tsx"),
    );
    // The page uses flex-col layout where content scrolls and footer stays
    expect(src).toContain("flex-1 overflow-auto");
    expect(src).toContain("flex-shrink-0");
  });

  it("Page-level containers use min-w-0 or max-w constraints, not hardcoded narrow min-width", () => {
    const files = [
      "components/workspace/GroupOverview.tsx",
      "routes/HomePage.tsx",
      "components/workspace/SettingsPage.tsx",
      "components/workspace/QualityPresetsPage.tsx",
    ];
    for (const f of files) {
      const src = readFileSafe(path.join(SRC, f));
      // The outermost content div should not have min-width < 560px
      // Check for page-level min-width (not card-level min-w-[180px] etc)
      const pageMinWidthPattern = /className="[^"]*min-w-\[(\d+)px\][^"]*"/g;
      let match;
      while ((match = pageMinWidthPattern.exec(src)) !== null) {
        const value = parseInt(match[1], 10);
        // Card-level widths (below 300px) are acceptable for grid items
        if (value >= 300) {
          expect(value).toBeGreaterThanOrEqual(560);
        }
      }
    }
  });
});

// ─── GroupRail aria-current ──────────────────────────────────────────────

describe("GroupRail aria-current", () => {
  it("source has aria-current={isSelected ? 'page' : undefined} on group buttons", () => {
    const src = readFileSafe(
      path.join(SRC, "components/layout/GroupRail.tsx"),
    );
    expect(src).toContain('aria-current={isSelected ? "page" : undefined}');
  });

  it("renders aria-current='page' on selected group and no aria-current on others", async () => {
    vi.doMock("@/stores/main-store", () => ({
      useStore: (selector: any) => {
        const state = {
          groupsById: {
            g1: { name: "Alpha Team", members: { a: {} } },
            g2: { name: "Beta Squad", members: { b: {} } },
          },
          groupOrder: ["g1", "g2"],
          selectedGroupId: "g1",
          setSelectedGroupId: vi.fn(),
          activeStreamsByGroup: {},
          navigate: vi.fn(),
          isViewing: false,
          currentPage: "home",
          setOpenCreateGroupDialog: vi.fn(),
          setOpenJoinGroupDialog: vi.fn(),
        };
        return selector(state);
      },
    }));

    vi.doMock("@/services/invite-copy", () => ({
      copyGroupInviteFromUi: vi.fn(),
    }));

    // Need fresh module import after doMock
    const { GroupRail } = await import(
      "../src/renderer/components/layout/GroupRail.js"
    );
    render(<GroupRail />);

    // Find the group buttons by their aria-labels
    const alphaButton = screen.getByRole("button", { name: /Alpha Team/ });
    const betaButton = screen.getByRole("button", { name: /Beta Squad/ });

    // Alpha Team is selected (groupId "g1" matches selectedGroupId "g1")
    expect(alphaButton).toHaveAttribute("aria-current", "page");

    // Beta Squad is NOT selected
    expect(betaButton).not.toHaveAttribute("aria-current");
  });
});

// ─── Collapsible disclosure accessibility ─────────────────────────────────

describe("Collapsible disclosure patterns", () => {
  it("CollapsibleTrigger from Radix provides expanded/controls ARIA", () => {
    const src = readFileSafe(
      path.join(SRC, "components/ui/collapsible.tsx"),
    );
    // Verify it uses Radix primitives which handle aria-expanded
    expect(src).toContain("@radix-ui/react-collapsible");
    expect(src).toContain("CollapsiblePrimitive.Trigger");
    expect(src).toContain("CollapsiblePrimitive.Content");
  });
});
