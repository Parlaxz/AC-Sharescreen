/**
 * update-channel.test.ts
 *
 * Unit coverage for the beta/stable update channel feature:
 *  - UpdateManager.applyChannel() updater configuration
 *  - update-available suppression vs. intentional downgrades
 *  - updates:set-channel IPC persistence via the injected callback
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let mockAppVersion = "0.9.0";

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return true;
    },
    getVersion: () => mockAppVersion,
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: class {},
}));

import { UpdateManager } from "../src/main/update-manager.js";
import type {
  UpdaterAdapter,
  LoggerAdapter,
} from "../src/main/update-manager.js";
import {
  IPC_CHANNELS,
  registerUpdateIpcHandlers,
  removeUpdateIpcHandlers,
} from "../src/main/update-ipc.js";
import { ipcMain } from "electron";

// ── Helpers ────────────────────────────────────────────────────────────────

interface Mocks {
  updater: UpdaterAdapter;
  triggerEvent: (event: string, ...args: unknown[]) => void;
}

function createUpdaterMock(currentVersion: string): Mocks {
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

  const updater: UpdaterAdapter = {
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(callback);
      eventHandlers.set(event, handlers);
    }),
    removeAllListeners: vi.fn(() => eventHandlers.clear()),
    checkForUpdates: vi.fn().mockResolvedValue({}),
    downloadUpdate: vi.fn().mockResolvedValue({}),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    disableDifferentialDownload: false,
    currentVersion: { version: currentVersion },
    channel: null,
    previousBlockmapBaseUrlOverride: null,
    logger: null,
  };

  return {
    updater,
    triggerEvent: (event: string, ...args: unknown[]) => {
      for (const handler of eventHandlers.get(event) ?? []) handler(...args);
    },
  };
}

function createManager(updater: UpdaterAdapter): UpdateManager {
  const logger: LoggerAdapter = { log: vi.fn() };
  return new UpdateManager(updater, vi.fn(), logger, vi.fn());
}

// ── applyChannel ───────────────────────────────────────────────────────────

describe("UpdateManager.applyChannel", () => {
  beforeEach(() => {
    mockAppVersion = "0.9.0";
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  it("applyChannel(beta) sets allowPrerelease and the beta feed channel", () => {
    const { updater } = createUpdaterMock("0.9.0");
    const manager = createManager(updater);

    const status = manager.applyChannel("beta");

    expect(updater.allowPrerelease).toBe(true);
    expect(updater.channel).toBe("beta");
    // Beta on a stable install never needs downgrades.
    expect(updater.allowDowngrade).toBe(false);
    expect(status.channel).toBe("beta");
  });

  it("applyChannel(stable) on a stable current version keeps downgrade disabled", () => {
    mockAppVersion = "0.9.0";
    const { updater } = createUpdaterMock("0.9.0");
    const manager = createManager(updater);

    manager.applyChannel("beta");
    const status = manager.applyChannel("stable");

    expect(updater.allowPrerelease).toBe(false);
    expect(updater.channel).toBe("latest");
    expect(updater.allowDowngrade).toBe(false);
    expect(status.channel).toBe("stable");
  });

  it("applyChannel(stable) on a prerelease current version enables downgrade", () => {
    mockAppVersion = "0.9.0-beta.1";
    const { updater } = createUpdaterMock("0.9.0-beta.1");
    const manager = createManager(updater);

    const status = manager.applyChannel("stable");

    expect(updater.allowPrerelease).toBe(false);
    expect(updater.channel).toBe("latest");
    expect(updater.allowDowngrade).toBe(true);
    expect(status.channel).toBe("stable");
  });
});

// ── Suppression vs. intentional downgrade ──────────────────────────────────

describe("update-available suppression with allowDowngrade", () => {
  beforeEach(() => {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  it("accepts LOWER versions when allowDowngrade is true (beta → stable revert)", () => {
    mockAppVersion = "0.9.0-beta.1";
    const { updater, triggerEvent } = createUpdaterMock("0.9.0-beta.1");
    const manager = createManager(updater);
    manager.applyChannel("stable"); // sets allowDowngrade = true

    triggerEvent("update-available", { version: "0.8.10" });

    const status = manager.getStatus();
    expect(status.phase).toBe("update-available");
    expect(status.availableVersion).toBe("0.8.10");
  });

  it("still suppresses lower versions when allowDowngrade is false", () => {
    mockAppVersion = "0.9.0";
    const { updater, triggerEvent } = createUpdaterMock("0.9.0");
    const manager = createManager(updater);

    triggerEvent("update-available", { version: "0.8.10" });

    expect(manager.getStatus().phase).toBe("up-to-date");
    expect(manager.getStatus().availableVersion).toBeUndefined();
  });

  it("still suppresses equal versions when allowDowngrade is true", () => {
    mockAppVersion = "0.9.0-beta.1";
    const { updater, triggerEvent } = createUpdaterMock("0.9.0-beta.1");
    const manager = createManager(updater);
    manager.applyChannel("stable");

    triggerEvent("update-available", { version: "0.9.0-beta.1" });

    expect(manager.getStatus().phase).toBe("up-to-date");
  });

  it("still errors on malformed metadata when allowDowngrade is true", () => {
    mockAppVersion = "0.9.0-beta.1";
    const { updater, triggerEvent } = createUpdaterMock("0.9.0-beta.1");
    const manager = createManager(updater);
    manager.applyChannel("stable");

    triggerEvent("update-available", { version: "not-a-version" });

    const status = manager.getStatus();
    expect(status.phase).toBe("error");
    expect(status.errorCode).toBe("invalid-update-metadata");
  });
});

// ── SET_CHANNEL IPC ────────────────────────────────────────────────────────

describe("updates:set-channel IPC handler", () => {
  let registered: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    vi.mocked(ipcMain.removeHandler).mockClear();
    registered = new Map();
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(channel, handler);
    }) as never);
  });

  function fakeManager(): { manager: UpdateManager; getStatus: ReturnType<typeof vi.fn> } {
    const getStatus = vi.fn().mockReturnValue({ phase: "idle", channel: "beta" });
    return {
      manager: { getStatus, checkForUpdates: vi.fn() } as unknown as UpdateManager,
      getStatus,
    };
  }

  it("persists valid channels via the injected callback and returns status", () => {
    const { manager, getStatus } = fakeManager();
    const setUpdateChannel = vi.fn();

    registerUpdateIpcHandlers({} as never, manager, setUpdateChannel);

    const handler = registered.get(IPC_CHANNELS.SET_CHANNEL);
    expect(handler).toBeDefined();

    const result = handler?.(null, "beta");

    expect(setUpdateChannel).toHaveBeenCalledWith("beta");
    expect(getStatus).toHaveBeenCalled();
    expect(result).toEqual({ phase: "idle", channel: "beta" });
  });

  it("rejects invalid channel values without persisting", () => {
    const { manager } = fakeManager();
    const setUpdateChannel = vi.fn();

    registerUpdateIpcHandlers({} as never, manager, setUpdateChannel);

    const handler = registered.get(IPC_CHANNELS.SET_CHANNEL)!;
    expect(() => handler(null, "nightly")).toThrow(/Invalid update channel/);
    expect(setUpdateChannel).not.toHaveBeenCalled();
  });

  it("registers and removes all update IPC channels including SET_CHANNEL", () => {
    const { manager } = fakeManager();
    registerUpdateIpcHandlers({} as never, manager, vi.fn());
    expect(registered.has(IPC_CHANNELS.SET_CHANNEL)).toBe(true);

    removeUpdateIpcHandlers();
    expect(vi.mocked(ipcMain.removeHandler)).toHaveBeenCalledWith(IPC_CHANNELS.SET_CHANNEL);
  });
});
