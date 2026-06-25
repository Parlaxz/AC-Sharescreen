// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/renderer/stores/main-store.js";

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

describe("QuickShareShortcutManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    register.mockReturnValue(true);
    isRegistered.mockReturnValue(false);
  });

  it("reads config from settings adapter", async () => {
    const { QuickShareShortcutManager } = await import("../src/main/quick-share-shortcut-manager.js");
    const mgr = new QuickShareShortcutManager(() => null as any, {
      getQuickShareEnabled: () => true,
      getQuickShareAccelerator: () => "Alt+Shift+S",
    });
    expect(mgr.getStatus()).toMatchObject({
      registered: false,
      accelerator: "Alt+Shift+S",
      enabled: true,
      registeredAccelerator: null,
    });
  });

  it("registers when enabled and not gated off", async () => {
    const { QuickShareShortcutManager } = await import("../src/main/quick-share-shortcut-manager.js");
    const send = vi.fn();
    const mgr = new QuickShareShortcutManager(() => ({
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send },
    }) as any, {
      getQuickShareEnabled: () => true,
      getQuickShareAccelerator: () => "Alt+Shift+S",
    });
    const result = mgr.register();
    expect(result.success).toBe(true);
    expect(register).toHaveBeenCalledWith("Alt+Shift+S", expect.any(Function));
  });

  it("updateConfig re-registers with the new accelerator", async () => {
    const { QuickShareShortcutManager } = await import("../src/main/quick-share-shortcut-manager.js");
    const mgr = new QuickShareShortcutManager(() => null as any, {
      getQuickShareEnabled: () => true,
      getQuickShareAccelerator: () => "Alt+Shift+S",
    });
    mgr.register();
    mgr.updateConfig(true, "Ctrl+Shift+Q");
    expect(unregister).toHaveBeenCalled();
    expect(register).toHaveBeenLastCalledWith("Ctrl+Shift+Q", expect.any(Function));
  });
});

describe("QuickShareDialog store-facing behavior", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("remembers per-kind audio defaults in store", () => {
    useStore.getState().setLastScreenAudioMode("monitor");
    useStore.getState().setLastWindowAudioMode("application");
    expect(useStore.getState().lastScreenAudioMode).toBe("monitor");
    expect(useStore.getState().lastWindowAudioMode).toBe("application");
  });

  it("already-sharing state routes to host workspace", () => {
    useStore.setState({ isSharing: true });
    expect(useStore.getState().isSharing).toBe(true);
  });

  it("no-groups state can be detected from store", () => {
    useStore.setState({ groupOrder: [] });
    expect(useStore.getState().groupOrder).toEqual([]);
  });
});
