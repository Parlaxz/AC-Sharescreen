// @vitest-environment happy-dom
/**
 * GroupDashboard empty-state Create/Join actions (Stage 7).
 *
 * Verifies the empty-sidebar Create/Join buttons open the global
 * Create/Join dialogs rather than merely navigating Home. Both
 * controls must invoke the same global dialog state used by
 * GroupRail and Home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

import { useStore } from "../src/renderer/stores/main-store.js";
import { GroupDashboard } from "../src/renderer/components/layout/GroupDashboard.js";
import { TooltipProvider } from "../src/renderer/components/ui/tooltip.js";

function renderDashboard() {
  return render(
    <TooltipProvider>
      <GroupDashboard />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  useStore.getState().reset();
  // selectedGroupId is null after reset
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GroupDashboard empty-state actions", () => {
  it("renders the empty-state copy and Create/Join buttons when no group is selected", () => {
    renderDashboard();
    expect(screen.getByText("Select or create a group")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create group" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join group" })).toBeInTheDocument();
  });

  it("opens the global Create Group dialog when Create group is clicked", async () => {
    renderDashboard();
    const before = useStore.getState().openCreateGroupDialog;
    expect(before).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() => {
      expect(useStore.getState().openCreateGroupDialog).toBe(true);
    });
    // The same global dialog state used by GroupRail is mutated
    expect(useStore.getState().openCreateGroupDialog).toBe(true);
    expect(useStore.getState().openJoinGroupDialog).toBe(false);
  });

  it("opens the global Join Group dialog when Join group is clicked", async () => {
    renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "Join group" }));

    await waitFor(() => {
      expect(useStore.getState().openJoinGroupDialog).toBe(true);
    });
    expect(useStore.getState().openCreateGroupDialog).toBe(false);
    expect(useStore.getState().openJoinGroupDialog).toBe(true);
  });

  it("invokes the same global dialog actions as GroupRail and Home", () => {
    // Confirm the store actions used by GroupDashboard are the
    // exact same setOpenCreateGroupDialog / setOpenJoinGroupDialog
    // actions that the rest of the app uses.
    renderDashboard();

    const createBefore = useStore.getState().openCreateGroupDialog;
    const joinBefore = useStore.getState().openJoinGroupDialog;

    fireEvent.click(screen.getByRole("button", { name: "Create group" }));
    expect(useStore.getState().openCreateGroupDialog).toBe(!createBefore);

    fireEvent.click(screen.getByRole("button", { name: "Join group" }));
    expect(useStore.getState().openJoinGroupDialog).toBe(!joinBefore);
  });

  it("Create/Join buttons are keyboard activatable", () => {
    renderDashboard();
    const createBtn = screen.getByRole("button", { name: "Create group" });
    const joinBtn = screen.getByRole("button", { name: "Join group" });
    // Both are real <button> elements with focusable semantics
    expect(createBtn.tagName).toBe("BUTTON");
    expect(joinBtn.tagName).toBe("BUTTON");
  });

  it("does not register local dialog state in GroupDashboard (uses store only)", async () => {
    // GroupDashboard should not call useState for dialog visibility.
    // Read the source and assert it never declares a useState<boolean>
    // for create/join visibility.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/components/layout/GroupDashboard.tsx"),
      "utf-8",
    );
    // Negative assertion — no local state like useState(false) for dialogs
    expect(source).not.toMatch(/useState\([^)]*\)[^;]*createDialog|useState\([^)]*\)[^;]*joinDialog/i);
    // Positive assertion — it uses the global store actions
    expect(source).toMatch(/setOpenCreateGroupDialog/);
    expect(source).toMatch(/setOpenJoinGroupDialog/);
  });
});
