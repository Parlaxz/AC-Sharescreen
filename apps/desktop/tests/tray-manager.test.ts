import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock electron before importing the module under test ──
const mockNativeImage = {
  isEmpty: vi.fn().mockReturnValue(false),
};

vi.mock("electron", () => ({
  app: { isPackaged: false },
  nativeImage: {
    createFromPath: vi.fn(() => mockNativeImage),
    createEmpty: vi.fn(() => ({ isEmpty: () => true })),
  },
  Tray: vi.fn(() => ({
    setToolTip: vi.fn(),
    on: vi.fn(),
    setContextMenu: vi.fn(),
    destroy: vi.fn(),
  })),
  Menu: { buildFromTemplate: vi.fn() },
}));

// Import after mock is hoisted
import path from "path";
import { getTrayIconPath, TrayManager } from "../src/main/tray-manager.js";
import type { TrayMenuActions } from "../src/main/tray-manager.js";

// ── Helpers ──

function stubActions(): TrayMenuActions {
  return {
    onOpen: vi.fn(),
    onQuit: vi.fn(),
    onShareScreen: vi.fn(),
    onShareWindow: vi.fn(),
    onQuickShare: vi.fn(),
    onStopSharing: vi.fn(),
    onStopWatching: vi.fn(),
    onToggleLaunchAtLogin: vi.fn(),
    onToggleAutoResume: vi.fn(),
    onShowDiagnostics: vi.fn(),
  };
}

// ── Tests ──

describe("getTrayIconPath", () => {
  it("returns a path ending with tray-icon.png", () => {
    const result = getTrayIconPath(false);
    expect(result.endsWith("tray-icon.png")).toBe(true);
  });

  it("returns a path containing assets when isPackaged is false", () => {
    const result = getTrayIconPath(false);
    // The dev path should pass through the assets directory
    expect(result).toMatch(/assets/);
  });

  it("returns a path based on process.resourcesPath when isPackaged is true", () => {
    // process.resourcesPath is set by Electron at runtime; simulate it
    const originalResourcesPath = (process as any).resourcesPath;
    (process as any).resourcesPath = "/mock/resources";
    try {
      const result = getTrayIconPath(true);
      // Use path.join for platform-appropriate separator (\\ on win32, / elsewhere)
      expect(result).toBe(path.join("/mock/resources", "tray-icon.png"));
    } finally {
      (process as any).resourcesPath = originalResourcesPath;
    }
  });

  it("handles packaged path when resourcesPath has trailing separator", () => {
    const originalResourcesPath = (process as any).resourcesPath;
    (process as any).resourcesPath = "/mock/resources/";
    try {
      const result = getTrayIconPath(true);
      // path.join normalizes separators, so no double slash
      expect(result).toBe(path.join("/mock/resources/", "tray-icon.png"));
      expect(result).not.toContain("//");
    } finally {
      (process as any).resourcesPath = originalResourcesPath;
    }
  });
});

describe("TrayManager.create", () => {
  beforeEach(() => {
    mockNativeImage.isEmpty.mockReset();
  });

  it("calls isEmpty on the created icon", () => {
    const manager = new TrayManager(stubActions());
    manager.create();
    expect(mockNativeImage.isEmpty).toHaveBeenCalled();
  });

  it("logs an error when the icon is empty", () => {
    mockNativeImage.isEmpty.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const manager = new TrayManager(stubActions());
    manager.create();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[tray-manager]"),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("tray-icon.png"),
    );

    consoleSpy.mockRestore();
  });

  it("does not log an error when the icon is valid", () => {
    mockNativeImage.isEmpty.mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const manager = new TrayManager(stubActions());
    manager.create();

    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
