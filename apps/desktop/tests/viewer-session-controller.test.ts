// @vitest-environment node
/**
 * ViewerSessionController regression tests.
 *
 * Covers serialized/concurrent start-stop behavior, retry failure surfaced
 * in snapshot, pause/resume snapshot transitions, and destroy cleanup with
 * listener and session lifecycle guarantees.
 *
 * ViewerSession is fully mocked (it depends on DOM/browser APIs), and
 * getRuntime/StreamMetricsService are also mocked for isolation.
 *
 * NOTE: This test deliberately avoids vi.clearAllMocks() in beforeEach
 * because vitest's global mock tracking interacts unpredictably with
 * vi.hoisted mocks. Instead, each test re-arms only the mocks it needs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Hoisted mocks (persist across tests within a file) ───────────────────────

const mockPause = vi.hoisted(() => vi.fn());
const mockResume = vi.hoisted(() => vi.fn());
const mockDestroy = vi.hoisted(() => vi.fn());

const mockStreamMetricsInstance = vi.hoisted(() => ({
  startViewerSession: vi.fn().mockReturnValue("metrics-id-1"),
  finalizeSession: vi.fn().mockResolvedValue(undefined),
  getSnapshot: vi.fn().mockReturnValue({
    historyId: "metrics-id-1",
    role: "viewer",
    aggregate: {
      rawSamples: Object.freeze([]),
      mediumBuckets: Object.freeze([]),
      longBuckets: Object.freeze([]),
      markers: Object.freeze([]),
      currentBitsPerSecond: 0,
      averageBitsPerSecond: 0,
      peakBitsPerSecond: 0,
      totalBytes: 0,
      durationMs: 0,
      activeDurationMs: 0,
      configuredBitsPerSecond: null,
      effectiveBitsPerSecond: null,
      state: "playing",
      currentVideoBitsPerSecond: null,
      currentAudioBitsPerSecond: null,
      currentTransportBitsPerSecond: null,
      cumulativeInboundVideoBytes: 5000,
    },
    connections: Object.freeze([]),
  }),
}));

const mockGetStreamMetrics = vi.hoisted(() =>
  vi.fn().mockReturnValue(mockStreamMetricsInstance),
);

const mockRuntimeObj = vi.hoisted(() => ({
  getConnectionManager: vi.fn(),
  getStreamSessionManager: vi.fn(),
  getActiveStreamRegistry: vi.fn(),
  isDestroyed: vi.fn().mockReturnValue(false),
  requestGroupSync: vi.fn().mockReturnValue(undefined),
  deviceId: "test-device",
  displayName: "Test Viewer",
}));

const mockUseStore = vi.hoisted(() => ({
  subscribe: vi.fn().mockReturnValue(vi.fn()),
}));

// ─── Module mocks (must be before imports) ────────────────────────────────────

vi.mock("../src/renderer/services/stream-metrics-service.js", () => ({
  StreamMetricsService: { getInstance: mockGetStreamMetrics },
}));

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: vi.fn().mockReturnValue(mockRuntimeObj),
}));

vi.mock("../src/renderer/services/viewer-session.js", () => ({
  ViewerSession: vi.fn(),
}));

vi.mock("../src/renderer/stores/main-store.js", () => ({
  useStore: mockUseStore,
}));

// ─── Imports ───────────────────────────────────────────────────────────────────

import { ViewerSessionController } from "../src/renderer/services/viewer-session-controller.js";
import { ViewerSession } from "../src/renderer/services/viewer-session.js";
import type { ViewerSessionSnapshot, StreamTarget } from "@screenlink/shared";

// ─── Constants ─────────────────────────────────────────────────────────────────

function makeTarget(overrides?: Partial<StreamTarget>): StreamTarget {
  return {
    groupId: "g-1",
    logicalStreamId: "ls-1",
    mediaSessionId: "ms-1",
    hostDeviceId: "host-1",
    hostName: "Host-1",
    startedAt: 1000,
    ...overrides,
  };
}

function makeMockSession() {
  return {
    onPauseStateChange: null as ((s: string) => void) | null,
    onError: null as ((e: string) => void) | null,
    onStateChange: null as ((s: string) => void) | null,
    onPosterFrameChange: null as ((p: string | null) => void) | null,
    pauseState: "playing",
    state: "idle",
    pause: mockPause,
    resume: mockResume,
    destroy: mockDestroy,
    stop: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    _historyId: null as string | null,
    videoElement: null,
  };
}

/** Re-arm the ViewerSession constructor's default implementation. */
function resetViewerSessionMock(): void {
  const mock = ViewerSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockImplementation(() => makeMockSession());
}

/** Re-arm runtime defaults. */
function resetRuntimeMocks(): void {
  mockRuntimeObj.isDestroyed.mockReturnValue(false);
  mockRuntimeObj.requestGroupSync.mockReturnValue(undefined);
  mockRuntimeObj.getActiveStreamRegistry.mockReturnValue({
    getStreamsByGroup: vi.fn().mockReturnValue([]),
  });
  mockRuntimeObj.getConnectionManager.mockReturnValue({
    getConnection: vi.fn(),
  });
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("ViewerSessionController", () => {
  let controller: ViewerSessionController;

  beforeEach(() => {
    // Reset call info and re-apply default behaviours.
    // hoisted vi.fn() instances lose their resolved-value after mockClear
    // because bare vi.fn() returns undefined, not a promise.
    mockPause.mockClear();
    mockPause.mockResolvedValue(undefined);
    mockResume.mockClear();
    mockResume.mockResolvedValue(undefined);
    mockDestroy.mockClear();
    mockDestroy.mockResolvedValue(undefined);

    // StreamMetrics mock: hoisted vi.fn() — mockClear keeps return values
    mockGetStreamMetrics.mockClear();
    mockStreamMetricsInstance.startViewerSession.mockClear();
    mockStreamMetricsInstance.finalizeSession.mockClear();

    // Default session constructor
    resetViewerSessionMock();

    // Runtime defaults
    resetRuntimeMocks();

    // Store mock
    mockUseStore.subscribe.mockClear();
    mockUseStore.subscribe.mockReturnValue(vi.fn());

    controller = new ViewerSessionController();
  });

  afterEach(async () => {
    await controller.destroy().catch(() => {});
    // Don't call restoreAllMocks — it breaks module mocks
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  describe("initial state", () => {
    it("starts with idle snapshot", () => {
      expect(controller.snapshot.phase).toBe("idle");
      expect(controller.snapshot.target).toBeNull();
      expect(controller.snapshot.error).toBeNull();
      expect(controller.snapshot.pause).toBe("playing");
      expect(controller.snapshot.controlHealth).toBe("up");
      expect(controller.snapshot.mediaHealth).toBe("up");
    });

    it("has no session initially", () => {
      expect(controller.session).toBeNull();
    });

    it("has no target initially", () => {
      expect(controller.target).toBeNull();
    });
  });

  // ── Serialized start-stop behavior ───────────────────────────────────────

  describe("serialized start-stop behavior", () => {
    it("start creates a ViewerSession and sets the target", async () => {
      await controller.start(makeTarget(), null);

      expect(controller.snapshot.phase).not.toBe("idle");
      expect(controller.snapshot.target).not.toBeNull();
      expect(controller.session).not.toBeNull();
      expect(ViewerSession).toHaveBeenCalledTimes(1);
    });

    it("stop resets snapshot to idle", async () => {
      await controller.start(makeTarget(), null);
      expect(controller.snapshot.phase).not.toBe("idle");

      await controller.stop();
      expect(controller.snapshot.phase).toBe("idle");
      expect(controller.snapshot.target).toBeNull();
      expect(controller.snapshot.error).toBeNull();
    });

    it("stop is idempotent (idle before start)", async () => {
      expect(controller.snapshot.phase).toBe("idle");
      await controller.stop();
      expect(controller.snapshot.phase).toBe("idle");
    });

    it("double stop is idempotent", async () => {
      await controller.start(makeTarget(), null);
      await controller.stop();
      const snap = controller.snapshot;

      await controller.stop();
      expect(controller.snapshot).toEqual(snap);
    });
  });

  // ── Retry failure surfaced in snapshot ───────────────────────────────────

  describe("retry failure surfaced in snapshot", () => {
    it("failed start sets error in snapshot", async () => {
      const failSession = makeMockSession();
      failSession.start.mockRejectedValue(new Error("connection rejected"));
      (ViewerSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => failSession);

      await expect(controller.start(makeTarget(), null)).rejects.toThrow("connection rejected");

      expect(controller.snapshot.phase).toBe("error");
      expect(controller.snapshot.error).toContain("connection rejected");
      expect(controller.snapshot.target).not.toBeNull();
    });

    it("retry after a failed start surfaces new error in snapshot", async () => {
      // First start fails
      const fail1 = makeMockSession();
      fail1.start.mockRejectedValue(new Error("first failure"));
      (ViewerSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fail1);
      await expect(controller.start(makeTarget(), null)).rejects.toThrow("first failure");
      expect(controller.snapshot.error).toContain("first failure");

      // Retry fails again
      mockRuntimeObj.requestGroupSync.mockReturnValue(Promise.resolve());
      const fail2 = makeMockSession();
      fail2.start.mockRejectedValue(new Error("still offline"));
      (ViewerSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fail2);

      await expect(controller.retry()).rejects.toThrow("still offline");
      expect(controller.snapshot.phase).toBe("error");
      expect(controller.snapshot.error).toContain("still offline");
    });

    it("retry with no target sets error in snapshot", async () => {
      mockRuntimeObj.requestGroupSync.mockReturnValue(Promise.resolve());
      await controller.retry();

      expect(controller.snapshot.phase).toBe("error");
      expect(controller.snapshot.error).toContain("No stream target available");
    });

    it("retry starts a new ViewerSession instance", async () => {
      await controller.start(makeTarget(), null);
      const firstSession = controller.session;
      expect(firstSession).not.toBeNull();

      mockRuntimeObj.requestGroupSync.mockReturnValue(Promise.resolve());
      await controller.retry();

      expect(controller.session).not.toBe(firstSession);
      expect(controller.session).not.toBeNull();
    });
  });

  // ── Pause/resume snapshot transitions ────────────────────────────────────

  describe("pause/resume snapshot transitions", () => {
    it("pause transitions snapshot to paused", async () => {
      await controller.start(makeTarget(), null);

      mockPause.mockImplementation(async () => {
        const s = controller.session as Record<string, unknown> | null;
        if (s && typeof s.onPauseStateChange === "function") {
          s.pauseState = "paused";
          (s.onPauseStateChange as (s: string) => void)("paused");
        }
      });

      await controller.pause();
      expect(controller.snapshot.pause).toBe("paused");
    });

    it("resume transitions snapshot from paused to playing", async () => {
      await controller.start(makeTarget(), null);

      // Pause first
      mockPause.mockImplementation(async () => {
        const s = controller.session as Record<string, unknown> | null;
        if (s && typeof s.onPauseStateChange === "function") {
          s.pauseState = "paused";
          (s.onPauseStateChange as (s: string) => void)("paused");
        }
      });
      await controller.pause();
      expect(controller.snapshot.pause).toBe("paused");

      // Resume
      mockResume.mockImplementation(async () => {
        const s = controller.session as Record<string, unknown> | null;
        if (s && typeof s.onPauseStateChange === "function") {
          s.pauseState = "playing";
          (s.onPauseStateChange as (s: string) => void)("playing");
        }
      });
      await controller.resume();
      expect(controller.snapshot.pause).toBe("playing");
    });

    it("resume is no-op when already playing", async () => {
      await controller.start(makeTarget(), null);
      await controller.resume();
      expect(mockResume).not.toHaveBeenCalled();
      expect(controller.snapshot.pause).toBe("playing");
    });

    it("togglePause alternates pause state", async () => {
      await controller.start(makeTarget(), null);

      mockPause.mockImplementation(async () => {
        const s = controller.session as Record<string, unknown> | null;
        if (s && typeof s.onPauseStateChange === "function") {
          s.pauseState = "paused";
          (s.onPauseStateChange as (s: string) => void)("paused");
        }
      });
      await controller.togglePause();
      expect(controller.snapshot.pause).toBe("paused");

      mockResume.mockImplementation(async () => {
        const s = controller.session as Record<string, unknown> | null;
        if (s && typeof s.onPauseStateChange === "function") {
          s.pauseState = "playing";
          (s.onPauseStateChange as (s: string) => void)("playing");
        }
      });
      await controller.togglePause();
      expect(controller.snapshot.pause).toBe("playing");
    });

    it("pause error does not crash controller", async () => {
      await controller.start(makeTarget(), null);
      mockPause.mockRejectedValue(new Error("pause error"));
      await expect(controller.pause()).resolves.toBeUndefined();
      expect(controller.snapshot.pause).toBe("playing");
    });
  });

  // ── Snapshot subscriptions ───────────────────────────────────────────────

  describe("snapshot subscriptions", () => {
    it("subscribe immediately notifies with current snapshot", () => {
      const cb = vi.fn();
      const unsub = controller.subscribe(cb);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(controller.snapshot);
      unsub();
    });

    it("unsubscribe stops notifications", async () => {
      const cb = vi.fn();
      const unsub = controller.subscribe(cb);
      cb.mockClear();
      unsub();

      await controller.stop();
      expect(cb).not.toHaveBeenCalled();
    });

    it("listeners notified on phase change", async () => {
      const cb = vi.fn();
      controller.subscribe(cb);
      cb.mockClear();

      await controller.start(makeTarget(), null);
      expect(cb).toHaveBeenCalled();
      const last = cb.mock.calls[cb.mock.calls.length - 1][0] as ViewerSessionSnapshot;
      expect(last.phase).not.toBe("idle");
    });
  });

  // ── Quality feedback ─────────────────────────────────────────────────────

  describe("quality feedback", () => {
    it("quality listeners receive published feedback", () => {
      const cb = vi.fn();
      controller.subscribeQuality(cb);
      controller.publishQuality({ type: "effective", data: { bitrate: 5000 } });
      expect(cb).toHaveBeenCalledWith({ type: "effective", data: { bitrate: 5000 } });
    });

    it("unsubscribed quality listener does not receive feedback", () => {
      const cb = vi.fn();
      const unsub = controller.subscribeQuality(cb);
      cb.mockClear();
      unsub();
      controller.publishQuality({ type: "effective", data: {} });
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ── Destroy ──────────────────────────────────────────────────────────────

  describe("destroy cleanup", () => {
    it("resets snapshot to idle and clears session", async () => {
      await controller.start(makeTarget(), null);
      expect(controller.session).not.toBeNull();

      await controller.destroy();
      expect(controller.snapshot.phase).toBe("idle");
      expect(controller.snapshot.target).toBeNull();
      expect(controller.snapshot.error).toBeNull();
      expect(controller.session).toBeNull();
    });

    it("clears snapshot listeners", async () => {
      const cb = vi.fn();
      controller.subscribe(cb);
      cb.mockClear();

      await controller.destroy();
      // Reset mock for potential re-start
      resetViewerSessionMock();
      await controller.start(makeTarget(), null);

      expect(cb).not.toHaveBeenCalled();
    });

    it("clears quality listeners", () => {
      const cb = vi.fn();
      controller.subscribeQuality(cb);
      cb.mockClear();

      controller.destroy();
      controller.publishQuality({ type: "effective", data: {} });
      expect(cb).not.toHaveBeenCalled();
    });

    it("calls destroy on the underlying ViewerSession", async () => {
      await controller.start(makeTarget(), null);
      const session = controller.session;
      await controller.destroy();
      expect(mockDestroy).toHaveBeenCalled();
    });

    it("is idempotent", async () => {
      await controller.destroy();
      await expect(controller.destroy()).resolves.toBeUndefined();
    });

    it("stop after destroy is no-op", async () => {
      await controller.destroy();
      await controller.stop();
      expect(controller.snapshot.phase).toBe("idle");
    });
  });

  // ── Generation counter ───────────────────────────────────────────────────

  describe("generation counter prevents stale callbacks", () => {
    it("stale onError from old session is ignored after destroy", async () => {
      let capturedOnError: ((e: string) => void) | null = null;
      const session = makeMockSession();
      session.start.mockImplementation(async function () {
        capturedOnError = this.onError as ((e: string) => void) | null;
      });
      (ViewerSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => session);

      await controller.start(makeTarget(), null);
      await controller.destroy();

      capturedOnError?.("stale error");

      expect(controller.snapshot.phase).toBe("idle");
      expect(controller.snapshot.error).toBeNull();
    });

    it("stale onPauseStateChange from old session is ignored after new start", async () => {
      let capturedOnPause: ((s: string) => void) | null = null;
      const session1 = makeMockSession();
      session1.start.mockImplementation(async function () {
        capturedOnPause = this.onPauseStateChange as ((s: string) => void) | null;
      });
      (ViewerSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => session1);

      await controller.start(makeTarget(), null);

      // Second start — new gen
      mockRuntimeObj.requestGroupSync.mockReturnValue(undefined);
      await controller.start(makeTarget(), null);

      capturedOnPause?.("paused");
      expect(controller.snapshot.pause).not.toBe("paused");
    });
  });

  // ── Accessors ────────────────────────────────────────────────────────────

  describe("accessors", () => {
    it("target getter returns the started target", async () => {
      const target = makeTarget({ groupId: "g-42" });
      await controller.start(target, null);
      expect(controller.target?.groupId).toBe("g-42");
    });

    it("session is null before start and after destroy", async () => {
      expect(controller.session).toBeNull();
      await controller.start(makeTarget(), null);
      expect(controller.session).not.toBeNull();
      await controller.destroy();
      expect(controller.session).toBeNull();
    });
  });

  // ── refreshTarget ────────────────────────────────────────────────────────

  describe("refreshTarget", () => {
    it("reads from active stream registry and updates mediaSessionId", async () => {
      await controller.start(makeTarget(), null);

      const getStreamsByGroup = vi.fn().mockReturnValue([
        {
          logicalStreamId: "ls-1",
          mediaSessionId: "ms-2",
          groupId: "g-1",
          hostDeviceId: "host-1",
          hostDisplayName: "Host-1",
          sourceKind: "screen",
          sourceName: "Screen",
          streamRevision: 2,
          startedAt: 2000,
          heartbeatSequence: 5,
          appliedSettingsRevision: 0,
          mediaJoinMetadata: "",
          replacesSessionId: null,
        },
      ]);
      mockRuntimeObj.getActiveStreamRegistry.mockReturnValue({
        getStreamsByGroup,
        getStream: vi.fn(),
        registerLocalStream: vi.fn(),
        handleStopped: vi.fn(),
        getAllStreams: vi.fn().mockReturnValue([]),
        onUpdate: vi.fn(),
        destroy: vi.fn(),
      });

      controller.refreshTarget();

      // _refreshTarget calls getRuntime, checks isDestroyed, reads registry
      expect(mockRuntimeObj.isDestroyed).toHaveBeenCalled();
      expect(getStreamsByGroup).toHaveBeenCalledWith("g-1");
      expect(controller.target?.mediaSessionId).toBe("ms-2");
      expect(controller.target?.logicalStreamId).toBe("ls-1");
    });

    it("is no-op when target is null", () => {
      expect(controller.target).toBeNull();
      controller.refreshTarget();
      expect(controller.target).toBeNull();
    });
  });
});
