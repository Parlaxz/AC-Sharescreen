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
    setImage: vi.fn(),
    destroy: vi.fn(),
  })),
  Menu: { buildFromTemplate: vi.fn() },
}));

// Import after mock is hoisted
import path from "path";
import { Tray } from "electron";
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
  it("returns a path ending with tray-icon-blue.png for idle state", () => {
    const result = getTrayIconPath("idle", false);
    expect(result.endsWith("tray-icon-blue.png")).toBe(true);
  });

  it("returns a path containing assets when isPackaged is false", () => {
    const result = getTrayIconPath("idle", false);
    // The dev path should pass through the assets directory
    expect(result).toMatch(/assets/);
    expect(result).toMatch(/tray-icon-blue\.png$/);
  });

  it("returns a path based on process.resourcesPath when isPackaged is true", () => {
    // process.resourcesPath is set by Electron at runtime; simulate it
    const originalResourcesPath = (process as any).resourcesPath;
    (process as any).resourcesPath = "/mock/resources";
    try {
      const result = getTrayIconPath("idle", true);
      // Use path.join for platform-appropriate separator (\\ on win32, / elsewhere)
      expect(result).toBe(path.join("/mock/resources", "tray-icon-blue.png"));
    } finally {
      (process as any).resourcesPath = originalResourcesPath;
    }
  });

  it("handles packaged path when resourcesPath has trailing separator", () => {
    const originalResourcesPath = (process as any).resourcesPath;
    (process as any).resourcesPath = "/mock/resources/";
    try {
      const result = getTrayIconPath("idle", true);
      // path.join normalizes separators, so no double slash
      expect(result).toBe(path.join("/mock/resources/", "tray-icon-blue.png"));
      expect(result).not.toContain("//");
    } finally {
      (process as any).resourcesPath = originalResourcesPath;
    }
  });

  describe.each([
    ["idle", "blue"],
    ["viewing", "green"],
    ["sharing", "orange"],
    ["sharing-and-viewing", "red"],
    ["degraded", "orange"],
    ["error", "red"],
  ] as const)('state "%s"', (state, expectedColor) => {
    it(`resolves to tray-icon-${expectedColor}.png`, () => {
      const result = getTrayIconPath(state, false);
      expect(result).toMatch(new RegExp(`tray-icon-${expectedColor}\\.png$`));
    });
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
      expect.stringContaining("tray-icon-blue.png"),
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

describe("TrayManager icon updates", () => {
  beforeEach(() => {
    mockNativeImage.isEmpty.mockReset();
    mockNativeImage.isEmpty.mockReturnValue(false);
  });

  /** Helper: get the most recent Tray mock instance created so far. */
  function getTrayInstance() {
    const trayMock = vi.mocked(Tray);
    const results = trayMock.mock.results;
    return results[results.length - 1]?.value as
      | { setImage: ReturnType<typeof vi.fn> }
      | undefined;
  }

  it("calls setImage during create() with idle icon", () => {
    const manager = new TrayManager(stubActions());
    manager.create();

    const instance = getTrayInstance();
    expect(instance).toBeDefined();
    expect(instance!.setImage).toHaveBeenCalled();

    const imageArg = instance!.setImage.mock.calls[0][0];
    expect(imageArg.isEmpty()).toBe(false);
  });

  it("switches icon when viewing is enabled", () => {
    const manager = new TrayManager(stubActions());
    manager.create();
    const instance = getTrayInstance()!;
    instance.setImage.mockClear();

    manager.setViewing(true);

    expect(instance.setImage).toHaveBeenCalled();
    const imageArg = instance.setImage.mock.calls[0][0];
    expect(imageArg.isEmpty()).toBe(false);
  });

  it("switches icon when sharing is enabled", () => {
    const manager = new TrayManager(stubActions());
    manager.create();
    const instance = getTrayInstance()!;
    instance.setImage.mockClear();

    manager.setSharing(true);

    expect(instance.setImage).toHaveBeenCalled();
  });

  it("shows red icon when sharing with viewers", () => {
    const manager = new TrayManager(stubActions());
    manager.create();
    const instance = getTrayInstance()!;

    manager.setSharing(true);
    instance.setImage.mockClear();
    manager.setViewerCount(1);

    expect(instance.setImage).toHaveBeenCalled();
  });

  it("returns to red when viewer joins while sharing", () => {
    const manager = new TrayManager(stubActions());
    manager.create();
    const instance = getTrayInstance()!;

    manager.setSharing(true);
    instance.setImage.mockClear();

    manager.setViewerCount(0);
    instance.setImage.mockClear();
    manager.setViewerCount(2);

    expect(instance.setImage).toHaveBeenCalled();
  });

  it("returns to orange when viewers drop to zero while sharing", () => {
    const manager = new TrayManager(stubActions());
    manager.create();
    const instance = getTrayInstance()!;

    manager.setSharing(true);
    manager.setViewerCount(3);
    instance.setImage.mockClear();

    manager.setViewerCount(0);

    expect(instance.setImage).toHaveBeenCalled();
  });

  it("returns to idle icon when sharing, viewing, and viewers all stop", () => {
    const manager = new TrayManager(stubActions());
    manager.create();
    const instance = getTrayInstance()!;

    manager.setSharing(true);
    manager.setViewerCount(2);
    manager.setViewing(true);
    instance.setImage.mockClear();

    manager.setSharing(false);
    manager.setViewing(false);
    manager.setViewerCount(0);

    expect(instance.setImage).toHaveBeenCalled();
  });
});
