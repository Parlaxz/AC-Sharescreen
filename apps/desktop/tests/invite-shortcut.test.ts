// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.fn();
const unregister = vi.fn();
const isRegistered = vi.fn();

vi.mock("electron", () => ({
  globalShortcut: {
    register,
    unregister,
    isRegistered,
  },
}));

function restoreWindow() {
  delete (globalThis as any).window;
}

function mockApi(api: Record<string, unknown>) {
  Object.defineProperty(globalThis, "window", {
    value: { screenlink: api },
    writable: true,
    configurable: true,
  });
}

describe("Invite copy helper", () => {
  beforeEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  it("calls getGroupInvite and clipboardWriteText with the returned link", async () => {
    const getGroupInvite = vi.fn().mockResolvedValue({
      link: "screenlink://group-abc?payload=xyz",
    });
    const clipboardWriteText = vi
      .fn()
      .mockResolvedValue({ success: true, length: 30 });
    mockApi({ getGroupInvite, clipboardWriteText });

    const { copyGroupInvite } = await import(
      "../src/renderer/services/invite-copy.js"
    );
    const result = await copyGroupInvite("group-abc", {
      getGroupInvite,
      clipboardWriteText,
    });

    expect(getGroupInvite).toHaveBeenCalledWith("group-abc");
    expect(clipboardWriteText).toHaveBeenCalledWith(
      "screenlink://group-abc?payload=xyz",
    );
    expect(result.success).toBe(true);
    expect(result.link).toBe("screenlink://group-abc?payload=xyz");
  });

  it("rejects fabricated screenlink.app/invite URLs", async () => {
    const getGroupInvite = vi.fn().mockResolvedValue(null);
    const clipboardWriteText = vi.fn();
    mockApi({ getGroupInvite, clipboardWriteText });

    const { copyGroupInvite } = await import(
      "../src/renderer/services/invite-copy.js"
    );
    const result = await copyGroupInvite("group-abc", {
      getGroupInvite,
      clipboardWriteText,
    });

    expect(result.success).toBe(false);
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(
      String(result.link ?? "").includes("https://screenlink.app/invite/"),
    ).toBe(false);
  });

  it("reports an actionable error when clipboard write fails", async () => {
    const getGroupInvite = vi
      .fn()
      .mockResolvedValue({ link: "screenlink://group-abc" });
    const clipboardWriteText = vi
      .fn()
      .mockRejectedValue(new Error("denied"));
    mockApi({ getGroupInvite, clipboardWriteText });

    const { copyGroupInvite } = await import(
      "../src/renderer/services/invite-copy.js"
    );
    const result = await copyGroupInvite("group-abc", {
      getGroupInvite,
      clipboardWriteText,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/denied/);
  });
});

describe("QuickShareShortcutManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    register.mockReturnValue(true);
    isRegistered.mockReturnValue(false);
  });

  it("changing A to B unregisters A exactly", async () => {
    const { QuickShareShortcutManager } = await import(
      "../src/main/quick-share-shortcut-manager.js"
    );
    const mgr = new QuickShareShortcutManager(() => null as any, {
      getQuickShareEnabled: () => true,
      getQuickShareAccelerator: () => "Alt+Shift+S",
    });
    mgr.register();
    expect(register).toHaveBeenLastCalledWith("Alt+Shift+S", expect.any(Function));

    mgr.updateConfig(true, "Ctrl+Shift+Q");
    // The exact previous value must be unregistered before the new
    // value is registered.
    expect(unregister).toHaveBeenCalledWith("Alt+Shift+S");
    expect(register).toHaveBeenLastCalledWith("Ctrl+Shift+Q", expect.any(Function));
  });

  it("disabling unregisters the active accelerator", async () => {
    const { QuickShareShortcutManager } = await import(
      "../src/main/quick-share-shortcut-manager.js"
    );
    const mgr = new QuickShareShortcutManager(() => null as any, {
      getQuickShareEnabled: () => true,
      getQuickShareAccelerator: () => "Alt+Shift+X",
    });
    mgr.register();
    mgr.updateConfig(false, "Alt+Shift+X");
    expect(unregister).toHaveBeenCalledWith("Alt+Shift+X");
  });

  it("failed registration clears internal state", async () => {
    const { QuickShareShortcutManager } = await import(
      "../src/main/quick-share-shortcut-manager.js"
    );
    register.mockReturnValueOnce(false);
    isRegistered.mockReturnValueOnce(false);

    const mgr = new QuickShareShortcutManager(() => null as any, {
      getQuickShareEnabled: () => true,
      getQuickShareAccelerator: () => "Alt+Shift+Z",
    });
    const result = mgr.register();
    expect(result.success).toBe(false);
    expect(mgr.getStatus().registered).toBe(false);
    expect(mgr.getStatus().registeredAccelerator).toBeNull();
  });

  it("destroy unregisters the active accelerator", async () => {
    const { QuickShareShortcutManager } = await import(
      "../src/main/quick-share-shortcut-manager.js"
    );
    const mgr = new QuickShareShortcutManager(() => null as any, {
      getQuickShareEnabled: () => true,
      getQuickShareAccelerator: () => "Alt+Shift+D",
    });
    mgr.register();
    mgr.destroy();
    expect(unregister).toHaveBeenCalledWith("Alt+Shift+D");
    expect(mgr.getStatus().registeredAccelerator).toBeNull();
  });
});
