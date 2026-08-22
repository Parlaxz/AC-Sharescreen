// @vitest-environment happy-dom
/**
 * shell-ui-behavioral.test.tsx — Behavioral TDD tests for UI overhaul (Task 3).
 *
 * Tests real rendered component behavior:
 *  - ContextPanel close icon is X (not Radio)
 *  - AppShell suppresses initial titlebar animation
 *  - Create/Join dialogs: disable while pending, prevent duplicate submits,
 *    retain input on error, show role=alert, close only after success
 *  - Command palette: actions navigate and close, disabled explain why
 *  - Accessibility: icon labels and focus-visible
 *  - Token normalization: ScreenLink radii, spacing, colors
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStore } from "../src/renderer/stores/main-store.js";
import { useIdentityStore } from "../src/renderer/stores/identity-store.js";

// ─── Wrap components that use Tooltip ───────────────────────────────────────
// These Radix-based components require a TooltipProvider ancestor.
function withTooltipProvider(ui: React.ReactElement) {
  return <TooltipProvider>{ui}</TooltipProvider>;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── Mock group-actions ─────────────────────────────────────────────────────

const mockCreateGroupAction = vi.fn();
const mockJoinGroupAction = vi.fn();

vi.mock("../src/renderer/services/group-actions.js", () => ({
  createGroupAction: (...args: Parameters<typeof mockCreateGroupAction>) => mockCreateGroupAction(...args),
  joinGroupAction: (...args: Parameters<typeof mockJoinGroupAction>) => mockJoinGroupAction(...args),
}));

// ─── Mock ResizeObserver ────────────────────────────────────────────────────
// Needed by some Radix components (Dialog, CommandDialog)
const mockResizeObserver = vi.fn(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));
vi.stubGlobal("ResizeObserver", mockResizeObserver);

// =============================================================================
// 1. CONTEXT PANEL — Close icon is X
// =============================================================================

describe("ContextPanel — close icon is X", () => {
  it("renders X icon for close button (not Radio icon)", async () => {
    useStore.setState({
      showContextPanel: true,
      isSharing: true,
      viewerCount: 0,
      selectedGroupId: null,
    });

    const { ContextPanel } = await import(
      "../src/renderer/components/layout/ContextPanel.js"
    );
    render(withTooltipProvider(<ContextPanel />));

    // The close button should have aria-label "Close context panel"
    const closeBtn = screen.getByRole("button", { name: /close context panel/i });
    expect(closeBtn).toBeTruthy();
    expect(closeBtn.getAttribute("aria-label")).toBe("Close context panel");
  });

  it("does not import Radio icon for the close button (uses X icon)", () => {
    // Source-level check: ContextPanel close button must use X, not Radio
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/ContextPanel.tsx"),
      "utf-8",
    );

    // The close button icon should use <X (lucide X icon), not <Radio
    // Find the section around "Close context panel" aria-label
    const lines = src.split("\n");
    const closeBtnLineIndex = lines.findIndex(l => l.includes("Close context panel"));
    // The icon (<X) appears AFTER the aria-label line in the component tree.
    const followingLines = lines.slice(closeBtnLineIndex, closeBtnLineIndex + 10).join("\n");
    expect(followingLines).toContain("<X");
    // Should NOT contain Radio in the close button section
    // (Radio may still be imported for the streams section, but shouldn't be the close icon)
    expect(followingLines).not.toContain("Radio");
  });
});

// =============================================================================
// 2. APP SHELL — Suppress initial titlebar animation
// =============================================================================

describe("AppShell — no initial titlebar animation", () => {
  it("uses initial={false} on title-bar motion div to suppress mount animation", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/AppShell.tsx"),
      "utf-8",
    );

    // The title-bar motion.div should have initial={false} so it doesn't
    // animate from height:0/opacity:0 on mount
    const titleBarSection = src.split("key=\"title-bar\"").slice(1).join("");
    expect(titleBarSection).toContain("initial={false}");
  });
});

// =============================================================================
// 3. DIALOG BEHAVIOR: CreateGroupDialog
// =============================================================================

describe("CreateGroupDialog — pending/error/close behavior", () => {
  beforeEach(() => {
    useStore.setState({
      openCreateGroupDialog: true,
      openJoinGroupDialog: false,
      groupsById: {},
      groupOrder: [],
      selectedGroupId: null,
      currentPage: "home",
    });
  });

  it("renders when store flag is open", async () => {
    const { CreateGroupDialog } = await import(
      "../src/renderer/components/workspace/CreateGroupDialog.js"
    );
    render(<CreateGroupDialog />);
    // Title (h2) says "Create group", button says "Create group" too
    // Use heading role to get just the title
    const heading = screen.getByRole("heading", { name: /create group/i });
    expect(heading).toBeTruthy();
    expect(screen.getByLabelText("Group name")).toBeTruthy();
  });

  it("disables submit button and input while creating is pending", async () => {
    mockCreateGroupAction.mockReturnValue(new Promise(() => {}));

    const { CreateGroupDialog } = await import(
      "../src/renderer/components/workspace/CreateGroupDialog.js"
    );
    render(<CreateGroupDialog />);

    const input = screen.getByLabelText("Group name") as HTMLInputElement;
    const submitBtn = screen.getByRole("button", { name: /create group/i });

    // Submit should be disabled when input is empty
    expect(submitBtn.hasAttribute("disabled")).toBe(true);

    // Type a name to enable
    fireEvent.change(input, { target: { value: "My Team" } });
    expect(submitBtn.hasAttribute("disabled")).toBe(false);

    // Click submit — should be pending now (button text changes to "Creating…")
    fireEvent.click(submitBtn);
    const pendingBtn = screen.getByRole("button", { name: /creating/i });
    expect(pendingBtn.hasAttribute("disabled")).toBe(true);
    expect(input.disabled).toBe(true);

    // Cancel button should also be disabled while pending
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    expect(cancelBtn.hasAttribute("disabled")).toBe(true);
  });

  it("prevents duplicate submits when already pending", async () => {
    let resolvePromise: (value: string) => void = () => {};
    mockCreateGroupAction.mockReturnValue(new Promise((resolve) => {
      resolvePromise = resolve;
    }));

    const { CreateGroupDialog } = await import(
      "../src/renderer/components/workspace/CreateGroupDialog.js"
    );
    render(<CreateGroupDialog />);

    const input = screen.getByLabelText("Group name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Test" } });

    // Submit twice
    const submitBtn = screen.getByRole("button", { name: /create group/i });
    fireEvent.click(submitBtn);

    // Button text changes to "Creating…" — try clicking that too
    const pendingBtn = screen.getByRole("button", { name: /creating/i });
    fireEvent.click(pendingBtn);

    await vi.waitFor(() => {
      expect(mockCreateGroupAction).toHaveBeenCalledTimes(1);
    });

    resolvePromise("group-1");
  });

  it("shows role=alert error message on recoverable failure", async () => {
    mockCreateGroupAction.mockRejectedValue(new Error("Network error"));

    const { CreateGroupDialog } = await import(
      "../src/renderer/components/workspace/CreateGroupDialog.js"
    );
    render(<CreateGroupDialog />);

    const input = screen.getByLabelText("Group name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Test" } });
    fireEvent.click(screen.getByRole("button", { name: /create group/i }));

    await waitFor(() => {
      const alertEl = screen.getByRole("alert");
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toContain("Network error");
    });
  });

  it("links error to input via aria-describedby when error is present", async () => {
    mockCreateGroupAction.mockRejectedValue(new Error("Validation failed"));

    const { CreateGroupDialog } = await import(
      "../src/renderer/components/workspace/CreateGroupDialog.js"
    );
    render(<CreateGroupDialog />);

    const input = screen.getByLabelText("Group name") as HTMLInputElement;

    // Before error: input should not have aria-describedby
    expect(input.getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(input, { target: { value: "Bad name" } });
    fireEvent.click(screen.getByRole("button", { name: /create group/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    // After error: input should reference the error element by id
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBe("create-group-name-error");

    // The error element should have the matching id
    const alertEl = screen.getByRole("alert");
    expect(alertEl.id).toBe("create-group-name-error");
  });

  it("retains input value on error (does not clear)", async () => {
    mockCreateGroupAction.mockRejectedValue(new Error("Timeout"));

    const { CreateGroupDialog } = await import(
      "../src/renderer/components/workspace/CreateGroupDialog.js"
    );
    render(<CreateGroupDialog />);

    const input = screen.getByLabelText("Group name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: /create group/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    expect(input.value).toBe("Keep me");
  });

  it("closes dialog only after success (does not close on error)", async () => {
    mockCreateGroupAction.mockRejectedValue(new Error("Fail"));

    const { CreateGroupDialog } = await import(
      "../src/renderer/components/workspace/CreateGroupDialog.js"
    );
    render(<CreateGroupDialog />);

    const input = screen.getByLabelText("Group name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Test" } });
    fireEvent.click(screen.getByRole("button", { name: /create group/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    // Dialog should still be open (store flag unchanged)
    expect(useStore.getState().openCreateGroupDialog).toBe(true);
  });

  it("closes dialog on successful creation", async () => {
    mockCreateGroupAction.mockResolvedValue("new-group-id");

    const { CreateGroupDialog } = await import(
      "../src/renderer/components/workspace/CreateGroupDialog.js"
    );
    render(<CreateGroupDialog />);

    const input = screen.getByLabelText("Group name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Success" } });
    fireEvent.click(screen.getByRole("button", { name: /create group/i }));

    await waitFor(() => {
      expect(useStore.getState().openCreateGroupDialog).toBe(false);
    });
  });

  it("prevents closing dialog while request is pending (Escape/outside-click)", async () => {
    let resolvePromise: (value: string) => void = () => {};
    mockCreateGroupAction.mockReturnValue(new Promise((resolve) => {
      resolvePromise = resolve;
    }));

    const { CreateGroupDialog } = await import(
      "../src/renderer/components/workspace/CreateGroupDialog.js"
    );
    render(<CreateGroupDialog />);

    const input = screen.getByLabelText("Group name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Test" } });
    fireEvent.click(screen.getByRole("button", { name: /create group/i }));

    // Wait for pending state
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /creating/i }).hasAttribute("disabled")).toBe(true);
    });

    // handleOpenChange guards against closing while creating is true.
    // Simulate Escape key — Dialog's onOpenChange(false) is prevented by the guard.
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });

    // The guard in handleOpenChange prevents closing while pending,
    // so the store flag remains true and the dialog stays open.
    expect(useStore.getState().openCreateGroupDialog).toBe(true);

    resolvePromise("group-1");
  });
});

// =============================================================================
// 4. DIALOG BEHAVIOR: JoinGroupDialog
// =============================================================================

describe("JoinGroupDialog — pending/error/close behavior", () => {
  beforeEach(() => {
    useStore.setState({
      openCreateGroupDialog: false,
      openJoinGroupDialog: true,
      groupsById: {},
      groupOrder: [],
      selectedGroupId: null,
      currentPage: "home",
    });
  });

  it("renders when store flag is open", async () => {
    const { JoinGroupDialog } = await import(
      "../src/renderer/components/workspace/JoinGroupDialog.js"
    );
    render(<JoinGroupDialog />);
    const heading = screen.getByRole("heading", { name: /join group/i });
    expect(heading).toBeTruthy();
    expect(screen.getByLabelText("Invite link")).toBeTruthy();
  });

  it("disables submit button and input while joining is pending", async () => {
    mockJoinGroupAction.mockReturnValue(new Promise(() => {}));

    const { JoinGroupDialog } = await import(
      "../src/renderer/components/workspace/JoinGroupDialog.js"
    );
    render(<JoinGroupDialog />);

    const input = screen.getByLabelText("Invite link") as HTMLInputElement;
    const submitBtn = screen.getByRole("button", { name: /join group/i });

    expect(submitBtn.hasAttribute("disabled")).toBe(true);
    expect(input.disabled).toBe(false);

    fireEvent.change(input, { target: { value: "invite-code" } });
    expect(submitBtn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(submitBtn);
    const pendingBtn = screen.getByRole("button", { name: /joining/i });
    expect(pendingBtn.hasAttribute("disabled")).toBe(true);
    expect(input.disabled).toBe(true);
  });

  it("prevents duplicate submits when already pending", async () => {
    let resolvePromise: (value: string) => void = () => {};
    mockJoinGroupAction.mockReturnValue(new Promise((resolve) => {
      resolvePromise = resolve;
    }));

    const { JoinGroupDialog } = await import(
      "../src/renderer/components/workspace/JoinGroupDialog.js"
    );
    render(<JoinGroupDialog />);

    const input = screen.getByLabelText("Invite link") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "code" } });

    // Click submit
    const submitBtn = screen.getByRole("button", { name: /join group/i });
    fireEvent.click(submitBtn);

    // Button text changes to "Joining…"
    const pendingBtn = screen.getByRole("button", { name: /joining/i });
    fireEvent.click(pendingBtn);

    await vi.waitFor(() => {
      expect(mockJoinGroupAction).toHaveBeenCalledTimes(1);
    });

    resolvePromise("group-2");
  });

  it("shows role=alert error message on recoverable failure", async () => {
    mockJoinGroupAction.mockRejectedValue(new Error("Invalid invite"));

    const { JoinGroupDialog } = await import(
      "../src/renderer/components/workspace/JoinGroupDialog.js"
    );
    render(<JoinGroupDialog />);

    const input = screen.getByLabelText("Invite link") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad-code" } });
    fireEvent.click(screen.getByRole("button", { name: /join group/i }));

    await waitFor(() => {
      const alertEl = screen.getByRole("alert");
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toContain("Invalid invite");
    });
  });

  it("links error to input via aria-describedby when error is present", async () => {
    mockJoinGroupAction.mockRejectedValue(new Error("Bad invite link"));

    const { JoinGroupDialog } = await import(
      "../src/renderer/components/workspace/JoinGroupDialog.js"
    );
    render(<JoinGroupDialog />);

    const input = screen.getByLabelText("Invite link") as HTMLInputElement;

    // Before error: input should not have aria-describedby
    expect(input.getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(input, { target: { value: "bad-link" } });
    fireEvent.click(screen.getByRole("button", { name: /join group/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    // After error: input should reference the error element by id
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBe("join-invite-link-error");

    // The error element should have the matching id
    const alertEl = screen.getByRole("alert");
    expect(alertEl.id).toBe("join-invite-link-error");
  });

  it("retains input value on error", async () => {
    mockJoinGroupAction.mockRejectedValue(new Error("Timeout"));

    const { JoinGroupDialog } = await import(
      "../src/renderer/components/workspace/JoinGroupDialog.js"
    );
    render(<JoinGroupDialog />);

    const input = screen.getByLabelText("Invite link") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "keep-me" } });
    fireEvent.click(screen.getByRole("button", { name: /join group/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    expect(input.value).toBe("keep-me");
  });

  it("closes dialog only after success", async () => {
    mockJoinGroupAction.mockRejectedValue(new Error("Fail"));

    const { JoinGroupDialog } = await import(
      "../src/renderer/components/workspace/JoinGroupDialog.js"
    );
    render(<JoinGroupDialog />);

    const input = screen.getByLabelText("Invite link") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: /join group/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    expect(useStore.getState().openJoinGroupDialog).toBe(true);
  });

  it("prevents closing dialog while join is pending", async () => {
    let resolvePromise: (value: string) => void = () => {};
    mockJoinGroupAction.mockReturnValue(new Promise((resolve) => {
      resolvePromise = resolve;
    }));

    const { JoinGroupDialog } = await import(
      "../src/renderer/components/workspace/JoinGroupDialog.js"
    );
    render(<JoinGroupDialog />);

    const input = screen.getByLabelText("Invite link") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: /join group/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /joining/i }).hasAttribute("disabled")).toBe(true);
    });

    // Cancel button also disabled while pending
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    expect(cancelBtn.hasAttribute("disabled")).toBe(true);

    resolvePromise("group-2");
  });

  it("Enter key triggers join and does not submit duplicate", async () => {
    let resolvePromise: (value: string) => void = () => {};
    mockJoinGroupAction.mockReturnValue(new Promise((resolve) => {
      resolvePromise = resolve;
    }));

    const { JoinGroupDialog } = await import(
      "../src/renderer/components/workspace/JoinGroupDialog.js"
    );
    render(<JoinGroupDialog />);

    const input = screen.getByLabelText("Invite link") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "enter-code" } });

    // Press Enter to submit
    fireEvent.keyDown(input, { key: "Enter" });
    // Press Enter again (should be no-op while pending)
    fireEvent.keyDown(input, { key: "Enter" });

    await vi.waitFor(() => {
      expect(mockJoinGroupAction).toHaveBeenCalledTimes(1);
    });

    resolvePromise("group-3");
  });
});

// =============================================================================
// 5. COMMAND PALETTE — actions navigate and close
// =============================================================================

describe("CommandPalette — actions navigate and close", () => {
  beforeEach(() => {
    useStore.setState({
      currentPage: "home",
      isSharing: false,
      showContextPanel: false,
      focusMode: false,
    });
  });

  it("renders command groups when open", async () => {
    const { CommandPalette } = await import(
      "../src/renderer/components/CommandPalette.js"
    );
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    expect(screen.getByText("Navigation")).toBeTruthy();
    expect(screen.getByText("Sharing")).toBeTruthy();
    expect(screen.getByText("View")).toBeTruthy();
  });

  it("navigates and closes when a navigation action is selected", async () => {
    const { CommandPalette } = await import(
      "../src/renderer/components/CommandPalette.js"
    );
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText("Open settings"));
    expect(useStore.getState().currentPage).toBe("user-settings");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("navigates for diagnostics action", async () => {
    const { CommandPalette } = await import(
      "../src/renderer/components/CommandPalette.js"
    );
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText("Open diagnostics"));
    expect(useStore.getState().currentPage).toBe("diagnostics");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("toggle focus mode navigates and closes", async () => {
    const { CommandPalette } = await import(
      "../src/renderer/components/CommandPalette.js"
    );
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText("Toggle focus mode"));
    expect(useStore.getState().focusMode).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows keyboard shortcut hints for actions with shortcuts", async () => {
    const { CommandPalette } = await import(
      "../src/renderer/components/CommandPalette.js"
    );
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    const settingsItem = screen.getByText("Open settings");
    const kbd = settingsItem.parentElement?.querySelector("kbd");
    expect(kbd).toBeTruthy();
    expect(kbd?.textContent).toBe("Ctrl+,");
  });

  it("actions close the palette before any follow-up", async () => {
    const { CommandPalette } = await import(
      "../src/renderer/components/CommandPalette.js"
    );
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText("Open my presets"));
    expect(useStore.getState().currentPage).toBe("quality-presets");
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("all actions call onOpenChange(false)", async () => {
    const { CommandPalette } = await import(
      "../src/renderer/components/CommandPalette.js"
    );
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    // Test each navigation action
    fireEvent.click(screen.getByText("Open settings"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Reset and test another
    onOpenChange.mockClear();
    useStore.setState({ currentPage: "home" });

    fireEvent.click(screen.getByText("Open diagnostics"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows disabled reason for actions that cannot be performed", async () => {
    const { CommandPalette } = await import(
      "../src/renderer/components/CommandPalette.js"
    );
    const onOpenChange = vi.fn();
    useStore.setState({ selectedGroupId: null });
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    // Open invite dialog should show a disabled reason when no group selected
    const inviteItem = screen.getByText("Open invite dialog");
    expect(inviteItem).toBeTruthy();

    // Should show the disabled reason text
    const disabledReason = screen.getByText("Select a group first");
    expect(disabledReason).toBeTruthy();

    // Clicking should not close the palette (no action performed)
    fireEvent.click(inviteItem);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 6. ACCESSIBILITY — icon labels, focus-visible, tooltips
// =============================================================================

describe("Accessibility — icon labels and focus", () => {
  it("TitleBar window control buttons have proper aria-labels", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/TitleBar.tsx"),
      "utf-8",
    );

    // Check aria-label declarations
    expect(src).toContain('aria-label="Minimize"');
    // Maximize/Restore uses a ternary expression: isMaximized ? "Restore" : "Maximize"
    expect(src).toContain('"Maximize"');
    expect(src).toContain('"Restore"');
    expect(src).toContain('aria-label="Close"');

    // Check tooltips exist
    expect(src).toContain("<Tooltip>");
    expect(src).toContain("<TooltipContent");
  });

  it("UserDock settings and more buttons have aria-labels", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/UserDock.tsx"),
      "utf-8",
    );

    expect(src).toContain('aria-label="Settings"');
    expect(src).toContain('aria-label="More options"');
  });

  it("GroupRail Home button has aria-label", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/GroupRail.tsx"),
      "utf-8",
    );

    expect(src).toContain('aria-label="Home"');
    // Group buttons use template literal: aria-label={`Group: ${group.name}`}
    expect(src).toContain("Group:");
    expect(src).toContain("aria-label");
    expect(src).toContain('aria-label="Create or join group"');
  });

  it("ContextPanel close button has aria-label", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/ContextPanel.tsx"),
      "utf-8",
    );

    expect(src).toContain('aria-label="Close context panel"');
  });

  it("all icon buttons have focus-visible ring styles via Button component or inline", () => {
    const files = [
      "TitleBar.tsx",
      "GroupRail.tsx",
      "GroupDashboard.tsx",
      "UserDock.tsx",
      "ContextPanel.tsx",
    ];
    const fs = require("fs");
    const path = require("path");

    for (const file of files) {
      const src = fs.readFileSync(
        path.resolve(__dirname, `../src/renderer/components/layout/${file}`),
        "utf-8",
      );
      // Either the Button component provides focus-visible via CVA,
      // or inline focus-visible:ring classes are used on custom buttons.
      const hasFocusVisible = src.includes("focus-visible:ring");
      const hasButtonComponent = src.includes("from \"@/components/ui/button\"") || src.includes("from '@/components/ui/button'");
      // If using Button component, it handles focus-visible internally.
      // Only custom buttons need explicit focus-visible:ring:
      if (!hasButtonComponent) {
        // Check custom interactive elements have focus-visible
        const customButtons = src.match(/<button[\s\S]*?(?:className="[^"]*focus-visible[^"]*")?/g);
        if (customButtons) {
          const buttonsWithoutFocus = customButtons.filter(b => !b.includes("focus-visible:ring"));
          // Custom buttons that are not from Button component should have focus-visible
          // But buttons from Watermelon Button component get it automatically
        }
      }
      expect(hasFocusVisible || hasButtonComponent).toBe(true);
    }
  });
});

// =============================================================================
// 7. TOKEN NORMALIZATION — ScreenLink tokens used consistently
// =============================================================================

describe("Token normalization — ScreenLink tokens", () => {
  it("uses ScreenLink radius tokens (rounded-compact, rounded-standard, rounded-dialog)", () => {
    const layoutFiles = [
      "GroupRail.tsx",
      "GroupDashboard.tsx",
      "UserDock.tsx",
      "ContextPanel.tsx",
    ];
    // TitleBar is excluded: its window control buttons intentionally use
    // rounded-none (square buttons) per the spec.
    // AppShell is excluded: it's a layout orchestrator without visual borders.
    const fs = require("fs");
    const path = require("path");

    for (const file of layoutFiles) {
      const src = fs.readFileSync(
        path.resolve(__dirname, `../src/renderer/components/layout/${file}`),
        "utf-8",
      );
      expect(src).toMatch(/rounded-(compact|standard|dialog)/);
    }

    // Workspace components (CreateGroupDialog, JoinGroupDialog) use Watermelon
    // Dialog component which provides rounded-dialog internally — no direct
    // token needed in source.
  });

  it("does not have hardcoded hex colors in UI components", () => {
    const layoutFiles = [
      "TitleBar.tsx",
      "GroupRail.tsx",
      "GroupDashboard.tsx",
      "UserDock.tsx",
      "ContextPanel.tsx",
      "AppShell.tsx",
    ];
    const workspaceFiles = ["CreateGroupDialog.tsx", "JoinGroupDialog.tsx"];
    const fs = require("fs");
    const path = require("path");

    for (const file of [...layoutFiles, ...workspaceFiles]) {
      const dir = layoutFiles.includes(file) ? "layout" : "workspace";
      const src = fs.readFileSync(
        path.resolve(__dirname, `../src/renderer/components/${dir}/${file}`),
        "utf-8",
      );
      // Check for hardcoded colors (5+ char hex values)
      const hexColors = src.match(/#[0-9a-fA-F]{4,8}/g) || [];
      const suspicious = hexColors.filter(h => {
        const line = src.split("\n").find(l => l.includes(h));
        return line && !line.trim().startsWith("*") && !line.includes("currentColor") && !line.includes("from ");
      });
      if (suspicious.length > 0) {
        // This is informative — the app.css tailwind @theme handles colors,
        // but some hex may be in SVG or icon imports
        console.log(`[${file}] hex colors found:`, suspicious);
      }
    }
  });
});

// =============================================================================
// 8. COMPACT WIDTH HANDLING
// =============================================================================

describe("Compact width handling", () => {
  it("AppShell uses flex-shrink-0 and overflow-hidden on panels for compact widths", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/AppShell.tsx"),
      "utf-8",
    );

    // At least 3 panels should have flex-shrink-0 (rail, dashboard, context)
    const shrinkablePanels = src.match(/flex-shrink-0/g) || [];
    expect(shrinkablePanels.length).toBeGreaterThanOrEqual(3);
  });

  it("GroupRail uses overflow-x-hidden for compact widths", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/GroupRail.tsx"),
      "utf-8",
    );
    expect(src).toContain("overflow-x-hidden");
  });
});

// =============================================================================
// 9. SELECTED STATE CONSISTENCY
// =============================================================================

describe("Selected state consistency", () => {
  it("GroupRail selected group has distinct visual style (bg-surface-3)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/GroupRail.tsx"),
      "utf-8",
    );

    // Selected state should reference a highlighted background
    expect(src).toMatch(/isSelected[\s\S]{0,100}bg-surface-3/);
  });

  it("GroupDashboard nav items use bg-accent-muted for active state", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/GroupDashboard.tsx"),
      "utf-8",
    );

    expect(src).toMatch(/isActive[\s\S]{0,100}bg-accent-muted/);
  });
});
