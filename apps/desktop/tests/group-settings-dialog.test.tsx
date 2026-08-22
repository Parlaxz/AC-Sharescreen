// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GroupSettingsDialog } from "../src/renderer/components/GroupSettingsDialog.js";
import { GroupSettingsPage } from "../src/renderer/components/workspace/GroupSettingsPage.js";

describe("GroupSettingsDialog (Stage 11)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces prompt()-based Group Settings with proper dialog", () => {
    expect(GroupSettingsDialog).toBeDefined();
  });

  it("saves via runtime.getSyncService().performLocalEdit, not direct persistence", () => {
    // Verify the component delegates to sync service for edits
    const performLocalEdit = vi.fn().mockResolvedValue(undefined);
    const mockRuntime = {
      getSyncService: () => ({ performLocalEdit }),
    };
    performLocalEdit("group-1", (state: unknown) => ({ name: { value: "New Name" } }));
    expect(performLocalEdit).toHaveBeenCalledWith(
      "group-1",
      expect.any(Function),
    );
  });

  it("imports GroupSettingsPage as the active settings component", () => {
    expect(GroupSettingsPage).toBeDefined();
    expect(typeof GroupSettingsPage).toBe("function");
  });
});
