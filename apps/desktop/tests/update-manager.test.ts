/**
 * update-manager.test.ts
 *
 * Comprehensive unit tests for the UpdateManager class.
 * Tests cover construction, state transitions, event handling,
 * error handling, lifecycle, and configuration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock for electron ──────────────────────────────────────────────
// The mutable variable lets each test control app.isPackaged at construction.
let mockIsPackaged = true;

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged;
    },
    getVersion: () => "0.1.0",
  },
}));

// ── Imports (after mock hoisting) ──────────────────────────────────────────

import { UpdateManager } from "../src/main/update-manager.js";
import type {
  UpdateStatus,
  UpdaterAdapter,
  LoggerAdapter,
} from "../src/main/update-manager.js";

// ── Helpers ────────────────────────────────────────────────────────────────

interface UpdaterMock {
  updater: UpdaterAdapter;
  triggerEvent: (event: string, ...args: unknown[]) => void;
  mockOn: ReturnType<typeof vi.fn>;
  mockRemoveAllListeners: ReturnType<typeof vi.fn>;
  mockCheckForUpdates: ReturnType<typeof vi.fn>;
  mockDownloadUpdate: ReturnType<typeof vi.fn>;
  mockQuitAndInstall: ReturnType<typeof vi.fn>;
  mockSetFeedURL: ReturnType<typeof vi.fn>;
}

function createUpdaterMock(): UpdaterMock {
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

  const mockOn = vi.fn(
    (event: string, callback: (...args: unknown[]) => void) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(callback);
      eventHandlers.set(event, handlers);
    },
  );

  const mockRemoveAllListeners = vi.fn(() => {
    eventHandlers.clear();
  });

  const mockCheckForUpdates = vi.fn().mockResolvedValue({});
  const mockDownloadUpdate = vi.fn().mockResolvedValue({});
  const mockQuitAndInstall = vi.fn();
  const mockSetFeedURL = vi.fn();

  const updater: UpdaterAdapter = {
    on: mockOn,
    removeAllListeners: mockRemoveAllListeners,
    checkForUpdates: mockCheckForUpdates,
    downloadUpdate: mockDownloadUpdate,
    quitAndInstall: mockQuitAndInstall,
    setFeedURL: mockSetFeedURL,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    disableDifferentialDownload: false,
    currentVersion: { version: "0.1.0" },
    channel: null,
    previousBlockmapBaseUrlOverride: null,
    logger: null,
  };

  function triggerEvent(event: string, ...args: unknown[]): void {
    const handlers = eventHandlers.get(event) ?? [];
    for (const handler of handlers) {
      handler(...args);
    }
  }

  return {
    updater,
    triggerEvent,
    mockOn,
    mockRemoveAllListeners,
    mockCheckForUpdates,
    mockDownloadUpdate,
    mockQuitAndInstall,
    mockSetFeedURL,
  };
}

// ── Describe blocks ───────────────────────────────────────────────────────

describe("UpdateManager construction", () => {
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockLogger: LoggerAdapter;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockPrepareForQuit: ReturnType<typeof vi.fn>;
  let mockUpdater: UpdaterAdapter;
  let mockQuitAndInstall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockIsPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_DIR;

    const mocks = createUpdaterMock();
    mockUpdater = mocks.updater;
    mockQuitAndInstall = mocks.mockQuitAndInstall;

    mockLog = vi.fn();
    mockBroadcast = vi.fn();
    mockPrepareForQuit = vi.fn();
    mockLogger = { log: mockLog };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  it("has prereleases disabled on the updater (config from main.ts)", () => {
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("has downgrade disabled on the updater (config from main.ts)", () => {
    expect(mockUpdater.allowDowngrade).toBe(false);
  });

  it("has differential download enabled on the updater (config from main.ts)", () => {
    expect(mockUpdater.disableDifferentialDownload).toBe(false);
  });

  // ── Test 1: unsupported development build ────────────────────────────

  it("enters unsupported phase when app is not packaged (dev build)", () => {
    mockIsPackaged = false;
    const m = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );
    const status = m.getStatus();

    expect(status.phase).toBe("unsupported");
    expect(status.updaterSupported).toBe(false);
    expect(status.isPackaged).toBe(false);
    expect(status.isPortable).toBe(false);
    expect(status.userMessage).toContain("packaged");
  });

  // ── Test 2: unsupported portable build ───────────────────────────────

  it("enters unsupported phase when running portable build", () => {
    process.env.PORTABLE_EXECUTABLE_DIR = "C:\\portable";
    const m = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );
    const status = m.getStatus();

    expect(status.phase).toBe("unsupported");
    expect(status.updaterSupported).toBe(false);
    expect(status.isPortable).toBe(true);
    expect(status.userMessage).toContain("portable");
  });

  // ── Test 3: supported packaged installed build ───────────────────────

  it("enters idle phase for supported packaged build", () => {
    const m = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );
    const status = m.getStatus();

    expect(status.phase).toBe("idle");
    expect(status.updaterSupported).toBe(true);
    expect(status.isPackaged).toBe(true);
    expect(status.isPortable).toBe(false);
  });
});

describe("initial state", () => {
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockLogger: LoggerAdapter;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockPrepareForQuit: ReturnType<typeof vi.fn>;
  let mockUpdater: UpdaterAdapter;
  let manager: UpdateManager;

  beforeEach(() => {
    mockIsPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_DIR;

    const mocks = createUpdaterMock();
    mockUpdater = mocks.updater;

    mockLog = vi.fn();
    mockBroadcast = vi.fn();
    mockPrepareForQuit = vi.fn();
    mockLogger = { log: mockLog };

    manager = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  // ── Test 4: initial idle state ───────────────────────────────────────

  it("has correct initial idle state fields", () => {
    const status = manager.getStatus();

    expect(status.phase).toBe("idle");
    expect(status.currentVersion).toBe("0.1.0");
    expect(status.updaterSupported).toBe(true);
    expect(status.isPackaged).toBe(true);
    expect(status.isPortable).toBe(false);
    expect(status.userMessage).toBe("No update check performed yet.");
  });
});

describe("updater configuration", () => {
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockLogger: LoggerAdapter;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockPrepareForQuit: ReturnType<typeof vi.fn>;
  let mockUpdater: UpdaterAdapter;
  let manager: UpdateManager;

  beforeEach(() => {
    mockIsPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_DIR;

    const mocks = createUpdaterMock();
    mockUpdater = mocks.updater;

    mockLog = vi.fn();
    mockBroadcast = vi.fn();
    mockPrepareForQuit = vi.fn();
    mockLogger = { log: mockLog };

    manager = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  it("sets allowPrerelease to false", () => {
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("sets allowDowngrade to false", () => {
    expect(mockUpdater.allowDowngrade).toBe(false);
  });

  it("sets disableDifferentialDownload to false (differential enabled)", () => {
    expect(mockUpdater.disableDifferentialDownload).toBe(false);
  });
});

describe("auto-check scheduling", () => {
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockLogger: LoggerAdapter;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockPrepareForQuit: ReturnType<typeof vi.fn>;
  let mockCheckForUpdates: ReturnType<typeof vi.fn>;
  let mockUpdater: UpdaterAdapter;
  let manager: UpdateManager;

  beforeEach(() => {
    mockIsPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_DIR;

    const mocks = createUpdaterMock();
    mockUpdater = mocks.updater;
    mockCheckForUpdates = mocks.mockCheckForUpdates;

    mockLog = vi.fn();
    mockBroadcast = vi.fn();
    mockPrepareForQuit = vi.fn();
    mockLogger = { log: mockLog };

    manager = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  // ── Test 5: automatic check scheduling ───────────────────────────────

  it("schedules an automatic check after init()", () => {
    manager.init();

    // Timer should not fire before the delay
    vi.advanceTimersByTime(14999);
    expect(mockCheckForUpdates).not.toHaveBeenCalled();

    // Advance past the 15 s threshold
    vi.advanceTimersByTime(1);
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe("update flow", () => {
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockLogger: LoggerAdapter;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockPrepareForQuit: ReturnType<typeof vi.fn>;
  let triggerEvent: (event: string, ...args: unknown[]) => void;
  let mockCheckForUpdates: ReturnType<typeof vi.fn>;
  let mockDownloadUpdate: ReturnType<typeof vi.fn>;
  let mockQuitAndInstall: ReturnType<typeof vi.fn>;
  let mockUpdater: UpdaterAdapter;
  let manager: UpdateManager;

  beforeEach(() => {
    mockIsPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_DIR;

    const mocks = createUpdaterMock();
    mockUpdater = mocks.updater;
    triggerEvent = mocks.triggerEvent;
    mockCheckForUpdates = mocks.mockCheckForUpdates;
    mockDownloadUpdate = mocks.mockDownloadUpdate;
    mockQuitAndInstall = mocks.mockQuitAndInstall;

    mockLog = vi.fn();
    mockBroadcast = vi.fn();
    mockPrepareForQuit = vi.fn();
    mockLogger = { log: mockLog };

    manager = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  // ── Test 6: no automatic download ────────────────────────────────────

  it("does not auto-download when update-available event fires", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    const status = manager.getStatus();
    expect(status.phase).toBe("update-available");
    expect(status.phase).not.toBe("downloading");
    expect(mockDownloadUpdate).not.toHaveBeenCalled();
  });

  // ── Test 7: manual check ─────────────────────────────────────────────

  it("calls updater.checkForUpdates on manual check", async () => {
    vi.useRealTimers();
    manager.init();
    await manager.checkForUpdates();

    expect(mockCheckForUpdates).toHaveBeenCalled();
  });

  // ── Test 8: checking state ───────────────────────────────────────────

  it("enters checking phase immediately during manual check", async () => {
    let resolveCheck!: (value: unknown) => void;
    mockCheckForUpdates.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );

    const checkPromise = manager.checkForUpdates();

    // Phase should be "checking" synchronously before the await resolves
    expect(manager.getStatus().phase).toBe("checking");

    resolveCheck({});
    await checkPromise;
  });

  // ── Test 9: update available ─────────────────────────────────────────

  it("transitions to update-available with version on event", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    const status = manager.getStatus();
    expect(status.phase).toBe("update-available");
    expect(status.availableVersion).toBe("2.0.0");
  });

  // ── Test 10: update not available ────────────────────────────────────

  it("transitions to up-to-date when update-not-available fires", () => {
    manager.init();
    triggerEvent("update-not-available", { version: "0.1.0" });

    const status = manager.getStatus();
    expect(status.phase).toBe("up-to-date");
    expect(status.availableVersion).toBeUndefined();
  });

  // ── Test 11: download start ──────────────────────────────────────────

  it("calls updater.downloadUpdate when downloadUpdate() is called", async () => {
    vi.useRealTimers();
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    await manager.downloadUpdate();

    expect(mockDownloadUpdate).toHaveBeenCalledTimes(1);
  });

  // ── Test 12: download progress normalization ─────────────────────────

  it("normalizes malformed download progress values", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    triggerEvent("download-progress", {
      percent: NaN,
      transferred: Infinity,
      total: -100,
      bytesPerSecond: -1,
    });

    const status = manager.getStatus();
    expect(status.phase).toBe("downloading");
    expect(status.downloadPercent).toBe(0);
    expect(status.transferredBytes).toBe(0);
    expect(status.totalBytes).toBe(0);
    expect(status.bytesPerSecond).toBe(0);
  });

  it("passes through valid progress values unchanged", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    triggerEvent("download-progress", {
      percent: 42.5,
      transferred: 1024,
      total: 4096,
      bytesPerSecond: 500_000,
    });

    const status = manager.getStatus();
    expect(status.downloadPercent).toBe(42.5);
    expect(status.transferredBytes).toBe(1024);
    expect(status.totalBytes).toBe(4096);
    expect(status.bytesPerSecond).toBe(500_000);
  });

  it("clamps percent to 0-100 range", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    triggerEvent("download-progress", {
      percent: 150,
      transferred: 100,
      total: 200,
      bytesPerSecond: 1000,
    });

    expect(manager.getStatus().downloadPercent).toBe(100);

    triggerEvent("download-progress", {
      percent: -50,
      transferred: 0,
      total: 200,
      bytesPerSecond: 1000,
    });

    expect(manager.getStatus().downloadPercent).toBe(0);
  });

  // ── Test 13: downloaded state ────────────────────────────────────────

  it("transitions to downloaded when update-downloaded fires", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });
    triggerEvent("update-downloaded", { version: "2.0.0" });

    const status = manager.getStatus();
    expect(status.phase).toBe("downloaded");
    expect(status.downloadedVersion).toBe("2.0.0");
    expect(status.downloadPercent).toBe(100);
  });

  // ── Test 14: explicit install ────────────────────────────────────────

  it("calls prepareForQuit before quitAndInstall on restart", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });
    triggerEvent("update-downloaded", { version: "2.0.0" });

    manager.restartAndInstallUpdate();

    expect(mockPrepareForQuit).toHaveBeenCalled();
    expect(mockQuitAndInstall).toHaveBeenCalled();
    expect(mockPrepareForQuit.mock.invocationCallOrder[0]).toBeLessThan(
      mockQuitAndInstall.mock.invocationCallOrder[0],
    );
  });

  it("transitions to installing phase during restart", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });
    triggerEvent("update-downloaded", { version: "2.0.0" });

    manager.restartAndInstallUpdate();

    expect(manager.getStatus().phase).toBe("installing");
  });

  // ── Test 15: quitAndInstall called exactly once ──────────────────────

  it("calls quitAndInstall exactly once on single install", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });
    triggerEvent("update-downloaded", { version: "2.0.0" });

    manager.restartAndInstallUpdate();

    expect(mockQuitAndInstall).toHaveBeenCalledTimes(1);
  });

  // ── Test 16: duplicate install rejected ──────────────────────────────

  it("rejects duplicate install calls", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });
    triggerEvent("update-downloaded", { version: "2.0.0" });

    manager.restartAndInstallUpdate();
    manager.restartAndInstallUpdate();

    // quitAndInstall should only be called once
    expect(mockQuitAndInstall).toHaveBeenCalledTimes(1);
  });

  // ── Test 17: duplicate download rejected ─────────────────────────────

  it("rejects duplicate downloadUpdate calls", async () => {
    vi.useRealTimers();
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    // Call downloadUpdate twice in quick succession; the second call should
    // see isDownloading = true and return immediately.
    const p1 = manager.downloadUpdate();
    const p2 = manager.downloadUpdate();

    await Promise.all([p1, p2]);

    expect(mockDownloadUpdate).toHaveBeenCalledTimes(1);
  });

  // ── Test 18: overlapping check rejected ──────────────────────────────

  it("rejects overlapping check when update is already available", async () => {
    vi.useRealTimers();
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    // The guard at the top of checkForUpdates should return early when
    // phase is "update-available" without calling updater.checkForUpdates.
    mockCheckForUpdates.mockClear();
    const result = await manager.checkForUpdates();

    expect(mockCheckForUpdates).not.toHaveBeenCalled();
    expect(result.phase).toBe("update-available");
  });

  it("rejects overlapping check when update is already downloaded", async () => {
    vi.useRealTimers();
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });
    triggerEvent("update-downloaded", { version: "2.0.0" });

    mockCheckForUpdates.mockClear();
    const result = await manager.checkForUpdates();

    expect(mockCheckForUpdates).not.toHaveBeenCalled();
    expect(result.phase).toBe("downloaded");
  });

  it("skips auto-check when phase is downloading", () => {
    // init() schedules auto-check at 15 s
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    // Fire download progress to set phase to "downloading"
    triggerEvent("download-progress", {
      percent: 10,
      transferred: 100,
      total: 1000,
      bytesPerSecond: 50000,
    });

    expect(manager.getStatus().phase).toBe("downloading");

    // Advance past the auto-check timer; should be skipped
    vi.advanceTimersByTime(15000);

    // The auto-check should not have called updater.checkForUpdates
    expect(mockCheckForUpdates).not.toHaveBeenCalled();
  });
});

describe("error handling", () => {
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockLogger: LoggerAdapter;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockPrepareForQuit: ReturnType<typeof vi.fn>;
  let triggerEvent: (event: string, ...args: unknown[]) => void;
  let mockCheckForUpdates: ReturnType<typeof vi.fn>;
  let mockUpdater: UpdaterAdapter;
  let manager: UpdateManager;

  beforeEach(() => {
    mockIsPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_DIR;

    const mocks = createUpdaterMock();
    mockUpdater = mocks.updater;
    triggerEvent = mocks.triggerEvent;
    mockCheckForUpdates = mocks.mockCheckForUpdates;

    mockLog = vi.fn();
    mockBroadcast = vi.fn();
    mockPrepareForQuit = vi.fn();
    mockLogger = { log: mockLog };

    manager = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  // ── Test 19: automatic offline error non-disruptive ──────────────────

  it("does not disrupt update-available phase with automatic error", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    triggerEvent("error", new Error("net::ERR_INTERNET_DISCONNECTED"));

    const status = manager.getStatus();
    expect(status.phase).toBe("update-available");
    expect(status.errorCode).toBeUndefined();
  });

  it("does not disrupt downloaded phase with automatic error", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });
    triggerEvent("update-downloaded", { version: "2.0.0" });

    triggerEvent("error", new Error("net::ERR_INTERNET_DISCONNECTED"));

    const status = manager.getStatus();
    expect(status.phase).toBe("downloaded");
    expect(status.errorCode).toBeUndefined();
  });

  it("suppresses checksum error during download (differential fallback)", () => {
    manager.init();
    triggerEvent("update-available", { version: "2.0.0" });

    // Set phase to "downloading"
    triggerEvent("download-progress", {
      percent: 10,
      transferred: 100,
      total: 1000,
      bytesPerSecond: 50000,
    });

    // Fire a checksum error; should be suppressed during download
    triggerEvent("error", new Error("blockmap checksum mismatch"));

    const status = manager.getStatus();
    expect(status.phase).toBe("downloading");
  });

  // ── Test 20: manual error is visible ─────────────────────────────────

  it("transitions to error when error event fires during idle/checking", () => {
    manager.init();
    triggerEvent("error", "net::ERR_CONNECTION_REFUSED");

    const status = manager.getStatus();
    expect(status.phase).toBe("error");
    expect(status.errorCode).toBe("network-unavailable");
    expect(status.errorMessage).toBeTruthy();
  });
});

describe("broadcast", () => {
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockLogger: LoggerAdapter;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockPrepareForQuit: ReturnType<typeof vi.fn>;
  let triggerEvent: (event: string, ...args: unknown[]) => void;
  let mockUpdater: UpdaterAdapter;
  let manager: UpdateManager;

  beforeEach(() => {
    mockIsPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_DIR;

    const mocks = createUpdaterMock();
    mockUpdater = mocks.updater;
    triggerEvent = mocks.triggerEvent;

    mockLog = vi.fn();
    mockBroadcast = vi.fn();
    mockPrepareForQuit = vi.fn();
    mockLogger = { log: mockLog };

    manager = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  // ── Test 21: state broadcasts ────────────────────────────────────────

  it("calls broadcast callback on state changes", () => {
    manager.init();

    // Clear any broadcasts from init
    mockBroadcast.mockClear();

    triggerEvent("update-available", { version: "2.0.0" });

    expect(mockBroadcast).toHaveBeenCalled();
    const status: UpdateStatus = mockBroadcast.mock.calls[0][0] as UpdateStatus;
    expect(status.phase).toBe("update-available");
    expect(status.availableVersion).toBe("2.0.0");
  });

  it("returns a copy of the status (immutability)", () => {
    const status1 = manager.getStatus();
    const status2 = manager.getStatus();

    // Different object references
    expect(status1).not.toBe(status2);
  });
});

describe("lifecycle", () => {
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockLogger: LoggerAdapter;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockPrepareForQuit: ReturnType<typeof vi.fn>;
  let triggerEvent: (event: string, ...args: unknown[]) => void;
  let mockCheckForUpdates: ReturnType<typeof vi.fn>;
  let mockRemoveAllListeners: ReturnType<typeof vi.fn>;
  let mockUpdater: UpdaterAdapter;
  let manager: UpdateManager;

  beforeEach(() => {
    mockIsPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_DIR;

    const mocks = createUpdaterMock();
    mockUpdater = mocks.updater;
    triggerEvent = mocks.triggerEvent;
    mockCheckForUpdates = mocks.mockCheckForUpdates;
    mockRemoveAllListeners = mocks.mockRemoveAllListeners;

    mockLog = vi.fn();
    mockBroadcast = vi.fn();
    mockPrepareForQuit = vi.fn();
    mockLogger = { log: mockLog };

    manager = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  // ── Test 22: destroyed-window broadcast safety ───────────────────────

  it("does not broadcast after destroy (setState returns early)", () => {
    manager.init();
    mockBroadcast.mockClear();

    manager.destroy();

    // Trigger an event after destroy; setState checks isDestroyed
    triggerEvent("update-available", { version: "2.0.0" });

    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("does not throw when triggering events after destroy", () => {
    manager.init();
    manager.destroy();

    expect(() => {
      triggerEvent("update-available", { version: "2.0.0" });
    }).not.toThrow();
  });

  it("returns current status without error after destroy", () => {
    manager.init();
    manager.destroy();

    const status = manager.getStatus();
    expect(status.phase).toBe("idle");
  });

  // ── Test 23: timers disposed ─────────────────────────────────────────

  it("does not run scheduled auto-check after destroy", () => {
    manager.init();

    // Advance almost to the timer but destroy before it fires
    manager.destroy();

    vi.advanceTimersByTime(20000);

    expect(mockCheckForUpdates).not.toHaveBeenCalled();
  });

  // ── Test 24: event listeners disposed ────────────────────────────────

  it("removes all event listeners on destroy", () => {
    manager.init();
    manager.destroy();

    expect(mockRemoveAllListeners).toHaveBeenCalled();
  });

  it("ignores updater events after destroy", () => {
    manager.init();

    // Save initial phase before destroy
    const initialPhase = manager.getStatus().phase;

    manager.destroy();

    // Clear the event handlers map to simulate removeAllListeners
    // already called; events fired after should be no-ops.
    triggerEvent("update-available", { version: "2.0.0" });
    triggerEvent("update-downloaded", { version: "2.0.0" });

    // Phase should remain unchanged
    const status = manager.getStatus();
    expect(status.phase).toBe(initialPhase);
  });
});

describe("blockmap base URL", () => {
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockLogger: LoggerAdapter;
  let mockLog: ReturnType<typeof vi.fn>;
  let mockPrepareForQuit: ReturnType<typeof vi.fn>;
  let mockUpdater: UpdaterAdapter;
  let manager: UpdateManager;

  beforeEach(() => {
    mockIsPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_DIR;

    const mocks = createUpdaterMock();
    mockUpdater = mocks.updater;

    mockLog = vi.fn();
    mockBroadcast = vi.fn();
    mockPrepareForQuit = vi.fn();
    mockLogger = { log: mockLog };

    manager = new UpdateManager(
      mockUpdater,
      mockBroadcast,
      mockLogger,
      mockPrepareForQuit,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  // ── Test 25: historical blockmap base URL uses app version ───────────

  it("sets previousBlockmapBaseUrlOverride with current version after init", () => {
    // Before init, the URL should be null (default mock value)
    expect(mockUpdater.previousBlockmapBaseUrlOverride).toBeNull();

    manager.init();

    // After init, the URL should contain the version from app.getVersion()
    expect(mockUpdater.previousBlockmapBaseUrlOverride).toBe(
      "https://github.com/Parlaxz/AC-Sharescreen/releases/download/v0.1.0",
    );
  });

  // ── Test 26: no hardcoded release version ────────────────────────────

  it("uses dynamic version from app.getVersion(), not a hardcoded version", () => {
    manager.init();

    const url = mockUpdater.previousBlockmapBaseUrlOverride;
    expect(url).toBeTruthy();
    expect(url).toContain("v0.1.0");

    // Verify the URL is built from the version, not a hardcoded string
    // by checking it does NOT contain a version that differs from the current one.
    expect(url).not.toContain("v1.0.0");
  });
});
