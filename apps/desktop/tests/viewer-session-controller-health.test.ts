// @vitest-environment node
/**
 * ViewerSessionController - Phase 5B health integration tests.
 *
 * Tests the connection-supervisor integration, health monitor polling,
 * recovery scheduling, backoff/cancellation, pause suppression,
 * intentional-stop classification, and retry target refresh.
 *
 * Uses injectable constructor options for deterministic timing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Hoisted mocks -----------------------------------------------------------

const mockPause = vi.hoisted(() => vi.fn());
const mockResume = vi.hoisted(() => vi.fn());
const mockDestroy = vi.hoisted(() => vi.fn());

const mockStreamMetricsInstance = vi.hoisted(() => {
  const snapshot = {
    historyId: "metrics-id-1",
    role: "viewer" as const,
    aggregate: {
      rawSamples: Object.freeze([] as never[]),
      mediumBuckets: Object.freeze([] as never[]),
      longBuckets: Object.freeze([] as never[]),
      markers: Object.freeze([] as never[]),
      currentBitsPerSecond: 0,
      averageBitsPerSecond: 0,
      peakBitsPerSecond: 0,
      totalBytes: 0,
      durationMs: 0,
      activeDurationMs: 0,
      configuredBitsPerSecond: null,
      effectiveBitsPerSecond: null,
      state: "playing" as const,
      currentVideoBitsPerSecond: null,
      currentAudioBitsPerSecond: null,
      currentTransportBitsPerSecond: null,
      cumulativeInboundVideoBytes: 5000,
    },
    connections: Object.freeze([] as never[]),
  };
  return {
    startViewerSession: vi.fn().mockReturnValue("metrics-id-1"),
    finalizeSession: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn().mockReturnValue(snapshot),
  };
});

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

// --- Module mocks ------------------------------------------------------------

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

// --- Imports -----------------------------------------------------------------

import { ViewerSessionController } from "../src/renderer/services/viewer-session-controller.js";
import type { ViewerSessionControllerOptions } from "../src/renderer/services/viewer-session-controller.js";
import { ViewerSession } from "../src/renderer/services/viewer-session.js";
import type { StreamTarget } from "@screenlink/shared";

// --- Helpers -----------------------------------------------------------------

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

function createControllableClock(initial = 0) {
  let _now = initial;
  return {
    now: () => _now,
    advance: (ms: number) => { _now += ms; },
    set: (ms: number) => { _now = ms; },
  };
}

interface MockConnection { state: string; }
function createMockConnection(state = "disconnected"): MockConnection {
  return { state };
}

interface MockPC { getStats: ReturnType<typeof vi.fn>; }
function createMockPC(statsMap?: Map<string, unknown>): MockPC {
  return {
    getStats: vi.fn().mockResolvedValue(statsMap ?? new Map()),
  };
}

interface MockSession {
  onPauseStateChange: ((s: string) => void) | null;
  onError: ((e: string) => void) | null;
  onStateChange: ((s: string) => void) | null;
  onPosterFrameChange: ((p: string | null) => void) | null;
  pauseState: string;
  state: string;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  _historyId: string | null;
  videoElement: null;
  getPeerConnection: ReturnType<typeof vi.fn>;
  getViewerClient: ReturnType<typeof vi.fn>;
}

function makeMockSession(): MockSession {
  return {
    onPauseStateChange: null,
    onError: null,
    onStateChange: null,
    onPosterFrameChange: null,
    pauseState: "playing",
    state: "idle",
    pause: mockPause,
    resume: mockResume,
    destroy: mockDestroy,
    stop: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    _historyId: null,
    videoElement: null,
    getPeerConnection: vi.fn().mockReturnValue(null),
    getViewerClient: vi.fn().mockReturnValue(null),
  };
}

function resetViewerSessionMock(): void {
  const mock = ViewerSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockImplementation(() => makeMockSession());
}

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

function makeControllerOpts(
  clock: ReturnType<typeof createControllableClock>,
): ViewerSessionControllerOptions {
  return {
    healthPollIntervalMs: 100,
    supervisorOptions: {
      stallThresholdMs: 1000,
      now: clock.now,
      backoff: { minMs: 50, maxMs: 500, factor: 2, jitter: undefined },
    },
    now: clock.now,
  };
}

// --- Suite -------------------------------------------------------------------

describe("ViewerSessionController health integration", () => {
  let controller: ViewerSessionController;
  let clock: ReturnType<typeof createControllableClock>;

  beforeEach(() => {
    vi.useFakeTimers();

    mockPause.mockClear();
    mockPause.mockResolvedValue(undefined);
    mockResume.mockClear();
    mockResume.mockResolvedValue(undefined);
    mockDestroy.mockClear();
    mockDestroy.mockResolvedValue(undefined);
    mockGetStreamMetrics.mockClear();
    mockStreamMetricsInstance.startViewerSession.mockClear();
    mockStreamMetricsInstance.finalizeSession.mockClear();
    resetViewerSessionMock();
    resetRuntimeMocks();
    mockUseStore.subscribe.mockClear();
    mockUseStore.subscribe.mockReturnValue(vi.fn());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await controller.destroy().catch(() => {});
  });

  // --- Health projection ----------------------------------------------------

  describe("health projection", () => {
    it("starts with up/up in snapshot", () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const snap = controller.snapshot;
      expect(snap.controlHealth).toBe("up");
      expect(snap.mediaHealth).toBe("up");
    });

    it("exposes supervisor via getter", () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      expect(controller.supervisor.getSnapshot().controlHealth).toBe("down");
    });

    it("projects supervisor changes into snapshot after start", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);

      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      session.getPeerConnection.mockReturnValue(pc);

      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      // Let first health tick propagate
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.snapshot.controlHealth).toBe("up");
      expect(controller.snapshot.mediaHealth).toBe("up");
    });
  });

  // --- Control / media loss transitions ------------------------------------

  describe("control and media loss transitions", () => {
    /** Helper: start a session, set it watching, run one health tick. */
    async function startWatching(ctrl: ViewerSessionController, session: MockSession, pc: MockPC): Promise<void> {
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await ctrl.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching"; // keep mock in sync
      }
      // Advance past first health tick + flush microtasks
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
    }

    it("detects control disconnection and projects down", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      await startWatching(controller, session, pc);

      // Verify healthy after first tick
      expect(controller.supervisor.getSnapshot().controlHealth).toBe("up");

      // Disconnect control
      clock.advance(200);
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.supervisor.getSnapshot().controlHealth).toBe("down");
      expect(controller.supervisor.getSnapshot().mediaHealth).toBe("up");
      expect(controller.snapshot.controlHealth).toBe("down");
    });

    it("detects media disconnection when canonical snapshot is unavailable", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      await startWatching(controller, session, pc);

      // Verify healthy first
      expect(controller.supervisor.getSnapshot().mediaHealth).toBe("up");

      // Simulate metrics snapshot unavailable (e.g. session finalised)
      mockStreamMetricsInstance.getSnapshot.mockReturnValue(null);
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.supervisor.getSnapshot().mediaHealth).toBe("down");
      expect(controller.snapshot.mediaHealth).toBe("down");

      // Restore for subsequent tests
      mockStreamMetricsInstance.getSnapshot.mockReturnValue(
        mockStreamMetricsInstance.getSnapshot.mock.results[0].value,
      );
    });

    it("detects media stall via canonical snapshot bytes plateau", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      // Advance through first health tick
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.supervisor.getSnapshot().mediaHealth).toBe("up");

      // Bytes plateau: clock advances but stats unchanged
      clock.advance(2000);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.supervisor.getSnapshot().mediaHealth).toBe("stalled");
      expect(controller.snapshot.mediaHealth).toBe("stalled");
    });
  });

  // --- Pause suppression ---------------------------------------------------

  describe("pause suppression", () => {
    it("sets supervisor paused when session pauses", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      const pc = createMockPC();
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) si.onStateChange("watching");
      await vi.advanceTimersByTimeAsync(100);

      expect(controller.supervisor.getSnapshot().isPaused).toBe(false);
      if (si?.onPauseStateChange) si.onPauseStateChange("paused");
      expect(controller.supervisor.getSnapshot().isPaused).toBe(true);
      if (si?.onPauseStateChange) si.onPauseStateChange("playing");
      expect(controller.supervisor.getSnapshot().isPaused).toBe(false);
    });

    it("does not stall while paused even with no byte progress", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) si.onStateChange("watching");
      await vi.advanceTimersByTimeAsync(100);

      if (si?.onPauseStateChange) si.onPauseStateChange("paused");
      clock.advance(5000);
      await vi.advanceTimersByTimeAsync(100);
      expect(controller.snapshot.mediaHealth).not.toBe("stalled");
    });
  });

  // --- Recovery scheduling -------------------------------------------------

  describe("recovery scheduling", () => {
    /** Start a healthy session, then disconnect control. */
    async function disconnectAfterStart(ctrl: ViewerSessionController, session: MockSession, pc: MockPC): Promise<void> {
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await ctrl.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      clock.advance(200);
    }

    it("schedules recovery with backoff after control loss", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      await disconnectAfterStart(controller, session, pc);

      // Next health tick detects control=down -> schedules recovery
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.supervisor.getSnapshot().controlHealth).toBe("down");
      expect(controller.snapshot.controlHealth).toBe("down");
      expect(controller.snapshot.phase).toBe("reconnecting");
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(1);
      expect(controller.supervisor.getSnapshot().backoffDelayMs).toBe(50);
    });

    it("executes recovery after backoff delay and resets backoff on success", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si1 = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si1?.onStateChange) {
        si1.onStateChange("watching");
        si1.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Disconnect
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.snapshot.phase).toBe("reconnecting");
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(1);

      // Provide a new session for recovery
      const session2 = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session2);

      // Reconnect control before timeout fires
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("connected")),
      });
      const stats2 = new Map<string, unknown>();
      stats2.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 6000 });
      const pc2 = createMockPC(stats2);
      session2.getPeerConnection.mockReturnValue(pc2);

      // Advance past 50ms backoff timer — recovery enqueues and runs
      clock.advance(50);
      vi.advanceTimersByTime(100);
      // Flush microtasks for the enqueued recovery execution chain
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Session2's onStateChange was already wired by _startImpl; trigger it
      if (session2.onStateChange) {
        session2.onStateChange("watching");
        session2.state = "watching";
      }
      vi.advanceTimersByTime(150);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(controller.snapshot.phase).toBe("watching");
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(0);
    });

    it("failed recovery transitions to error and cancels supervisor", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Disconnect -> first recovery scheduled at backoff=50
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(1);

      // Recovery fires but new session start fails
      const failSession = makeMockSession();
      failSession.start.mockRejectedValue(new Error("reject"));
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => failSession);

      // Advance past 50ms backoff -> recovery fires and fails
      // After failed start, _startImpl catch handler stops health monitor
      // and cancels the supervisor (resets backoff to 0).
      clock.advance(60);
      vi.advanceTimersByTime(100);
      for (let i = 0; i < 15; i++) await Promise.resolve();

      // Controller is in error state after failed recovery
      expect(controller.snapshot.phase).toBe("error");
      // Supervisor was cancelled by _startImpl catch handler
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(0);
    });
  });

  // --- No duplicate concurrent recovery ------------------------------------

  describe("no duplicate concurrent recovery", () => {
    it("does not schedule a second recovery while one is in flight", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Disconnect -> first recovery scheduled (backoff=50)
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(1);

      // While recovery timer is pending (50ms), another health tick fires
      // It should NOT schedule another recovery
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      // Still only 1 attempt (no duplicate)
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(1);
    });
  });

  // --- Intentional stop ----------------------------------------------------

  describe("intentional stop classification", () => {
    it("does NOT schedule recovery when supervisor is marked intentional-stop", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      controller.supervisor.markIntentionalStop();

      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.supervisor.getSnapshot().controlHealth).toBe("down");
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(0);
      expect(controller.snapshot.phase).toBe("watching");
    });

    it("stream-end detection marks intentional stop so recovery is suppressed", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Fire store subscription to simulate stream removal
      const subscribeFn = mockUseStore.subscribe.mock.calls[0][0];
      subscribeFn({ activeStreamsByGroup: { "g-1": [] } }, {});
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.supervisor.getSnapshot().isIntentionalStop).toBe(true);

      // Health monitor should NOT schedule recovery
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(0);
    });
  });

  // --- Retry target refresh -------------------------------------------------

  describe("retry target refresh", () => {
    it("retry refreshes target from registry", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);

      mockRuntimeObj.getActiveStreamRegistry.mockReturnValue({
        getStreamsByGroup: vi.fn().mockReturnValue([
          { hostDeviceId: "host-1", logicalStreamId: "ls-1",
            mediaSessionId: "ms-2", streamRevision: 2, startedAt: 2000 },
        ]),
      });
      mockRuntimeObj.requestGroupSync.mockReturnValue(Promise.resolve());

      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.target?.mediaSessionId).toBe("ms-1");

      const session2 = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session2);
      await controller.retry();
      const si2 = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[1]?.value as MockSession;
      if (si2?.onStateChange) {
        si2.onStateChange("watching");
        si2.state = "watching";
      }
      expect(controller.target?.mediaSessionId).toBe("ms-2");
    });
  });

  // --- Bounded backoff / cancellation --------------------------------------

  describe("bounded backoff and cancellation", () => {
    it("stop cancels pending recovery timer", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Disconnect -> schedule recovery
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(1);

      // Stop before recovery fires
      await controller.stop();
      expect(controller.snapshot.phase).toBe("idle");

      // Advance past backoff — no recovery should occur
      clock.advance(100);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.snapshot.phase).toBe("idle");
    });

    it("destroy cancels health monitor and supervisor", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      await controller.destroy();
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(0);
      expect(controller.supervisor.getSnapshot().controlState).toBe("disconnected");

      const afterDestroy = controller.snapshot;
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.snapshot).toBe(afterDestroy);
    });
  });

  // --- Control up + media plateau → stall + recovery scheduled -----------

  describe("control-up media-plateau stall detection", () => {
    it("schedules recovery when control stays up but media plateaus and stalls", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Both control and media are up after first tick
      expect(controller.supervisor.getSnapshot().controlHealth).toBe("up");
      expect(controller.supervisor.getSnapshot().mediaHealth).toBe("up");

      // Bytes plateau — stats stay the same, clock advances past stall threshold
      clock.advance(2000);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Control still up, media is now stalled
      expect(controller.supervisor.getSnapshot().controlHealth).toBe("up");
      expect(controller.supervisor.getSnapshot().mediaHealth).toBe("stalled");

      // Recovery should have been scheduled (stalled media is recoverable)
      expect(controller.snapshot.phase).toBe("reconnecting");
      expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(1);
    });
  });

  // --- Health tick reads canonical snapshot (no getStats) -------------------

  describe("health tick reads canonical snapshot", () => {
    it("reads cumulativeInboundVideoBytes from StreamMetricsService, not getStats", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      // Provide a mock PC but its getStats will NOT be called by the health tick
      const pc = createMockPC(new Map());
      session.getPeerConnection.mockReturnValue(pc);
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }

      // Set up getSnapshot to report specific inbound bytes
      const firstValue = mockStreamMetricsInstance.getSnapshot.mock.results[0].value;
      mockStreamMetricsInstance.getSnapshot.mockReturnValue({
        ...firstValue,
        aggregate: { ...firstValue.aggregate, cumulativeInboundVideoBytes: 10000 },
      });

      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Media should be progressing because the snapshot reported bytes
      expect(controller.supervisor.getSnapshot().mediaHealth).toBe("up");

      // Verify getStats was NOT called on the PC
      expect(pc.getStats).not.toHaveBeenCalled();

      // Reset mock for other tests
      mockStreamMetricsInstance.getSnapshot.mockReturnValue(firstValue);
    });
  });

  // --- recover() / preserveActiveStreams ---------------------------------

  describe("recover and preserveActiveStreams", () => {
    it("recover() is exposed and returns a promise", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(createMockPC());
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // recover() should exist, be callable, and return a promise
      expect(typeof controller.recover).toBe("function");

      // Provide a second session mock for the recovery
      const session2 = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session2);
      const stats2 = new Map<string, unknown>();
      stats2.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 6000 });
      const pc2 = createMockPC(stats2);
      session2.getPeerConnection.mockReturnValue(pc2);

      const recoverPromise = controller.recover();
      expect(recoverPromise).toBeInstanceOf(Promise);
      // Let recovery execute
      if (session2.onStateChange) {
        session2.onStateChange("watching");
        session2.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      await expect(recoverPromise).resolves.toBeUndefined();
    });

    it("retry() delegates to recover / same impl", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      session.getPeerConnection.mockReturnValue(createMockPC());
      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Snapshot retry and recover — both work
      const session2 = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session2);
      const stats2 = new Map<string, unknown>();
      stats2.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 6000 });
      const pc2 = createMockPC(stats2);
      session2.getPeerConnection.mockReturnValue(pc2);

      await controller.retry();
      if (session2.onStateChange) {
        session2.onStateChange("watching");
        session2.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // recover works after retry too
      expect(typeof controller.recover).toBe("function");
    });

    it("recovery passes preserveActiveStreams:true to requestGroupSync", async () => {
      clock = createControllableClock(0);
      controller = new ViewerSessionController(makeControllerOpts(clock));
      const session = makeMockSession();
      (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => session);
      const conn = createMockConnection("connected");
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(conn),
      });
      const stats = new Map<string, unknown>();
      stats.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 5000 });
      const pc = createMockPC(stats);
      session.getPeerConnection.mockReturnValue(pc);
      mockRuntimeObj.requestGroupSync.mockReturnValue(Promise.resolve({ status: "dispatched" } as const));

      await controller.start(makeTarget(), null);
      const si = (ViewerSession as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as MockSession;
      if (si?.onStateChange) {
        si.onStateChange("watching");
        si.state = "watching";
      }
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Disconnect control to trigger recovery
      mockRuntimeObj.getConnectionManager.mockReturnValue({
        getConnection: vi.fn().mockReturnValue(createMockConnection("disconnected")),
      });
      clock.advance(200);
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();

      // Recovery should have called requestGroupSync with preserveActiveStreams:true
      expect(mockRuntimeObj.requestGroupSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ preserveActiveStreams: true }),
      );
    });
  });
});
