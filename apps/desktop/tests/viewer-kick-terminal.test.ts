// @vitest-environment node
/**
 * Kick-terminality regression tests (MEDIA-006).
 *
 * A host-executed kick must be TERMINAL for the kicked viewer:
 *   1. Viewer side — a terminal stop (transport death / intentional stop)
 *      must win over an already-scheduled auto-recovery; the controller
 *      settles to "ended" instead of rejoining.
 *   2. Host side — ViewerMediaBinding remembers recently-kicked viewers and
 *      rejects their join requests for a bounded window, so a rejoin
 *      attempt cannot defeat the kick.
 *
 * Silent host crashes WITHOUT a kick are unaffected: ordinary recovery
 * still proceeds when no intentional stop was marked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Shared hoisted mocks (controller suite) ────────────────────────────────

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

vi.mock("../src/renderer/services/stream-metrics-service.js", () => ({
  StreamMetricsService: { getInstance: () => mockStreamMetricsInstance },
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

import { ViewerSessionController } from "../src/renderer/services/viewer-session-controller.js";
import { ViewerSession } from "../src/renderer/services/viewer-session.js";
import type { StreamTarget } from "@screenlink/shared";

// ─── Controller helpers ─────────────────────────────────────────────────────

function makeTarget(): StreamTarget {
  return {
    groupId: "g-1",
    logicalStreamId: "ls-1",
    mediaSessionId: "ms-1",
    hostDeviceId: "host-1",
    hostName: "Host-1",
    startedAt: 1000,
  };
}

function createControllableClock(initial = 0) {
  let _now = initial;
  return {
    now: () => _now,
    advance: (ms: number) => { _now += ms; },
  };
}

/** PC stub whose connectionstatechange listeners can be fired by tests. */
function makePCStub() {
  const listeners = new Map<string, Set<() => void>>();
  const pc = {
    connectionState: "connected",
    iceConnectionState: "connected",
    addEventListener: (type: string, handler: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener: (type: string, handler: () => void) => {
      listeners.get(type)?.delete(handler);
    },
    getReceivers: () => [] as unknown[],
  };
  return {
    pc,
    fireConnectionStateChange: () => {
      for (const h of listeners.get("connectionstatechange") ?? []) h();
    },
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

function makeMockSession(pc: ReturnType<typeof makePCStub>["pc"] | null): MockSession {
  return {
    onPauseStateChange: null,
    onError: null,
    onStateChange: null,
    onPosterFrameChange: null,
    pauseState: "playing",
    state: "idle",
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: mockDestroy,
    stop: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    _historyId: null,
    videoElement: null,
    getPeerConnection: vi.fn().mockReturnValue(pc),
    getViewerClient: vi.fn().mockReturnValue(null),
  };
}

function resetViewerSessionMock(): void {
  const mock = ViewerSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
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

function makeControllerOpts(clock: ReturnType<typeof createControllableClock>) {
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

async function flushMicrotasks(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("ViewerSessionController — kick terminality (MEDIA-006)", () => {
  let controller: ViewerSessionController;
  let clock: ReturnType<typeof createControllableClock>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockDestroy.mockClear();
    mockDestroy.mockResolvedValue(undefined);
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

  /** Start a session, mark it watching, run one healthy tick. */
  async function startWatching(
    session: MockSession,
    pcStub: ReturnType<typeof makePCStub>,
  ): Promise<void> {
    const conn = { state: "connected" };
    mockRuntimeObj.getConnectionManager.mockReturnValue({
      getConnection: vi.fn().mockReturnValue(conn),
    });
    (ViewerSession as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => session);
    await controller.start(makeTarget(), null);
    if (session.onStateChange) {
      session.onStateChange("watching");
      session.state = "watching";
    }
    vi.advanceTimersByTime(150);
    await flushMicrotasks();
    expect(controller.snapshot.phase).toBe("watching");
    void pcStub;
  }

  /** Disconnect control and run a tick so auto-recovery gets scheduled. */
  async function scheduleRecovery(): Promise<void> {
    mockRuntimeObj.getConnectionManager.mockReturnValue({
      getConnection: vi.fn().mockReturnValue({ state: "disconnected" }),
    });
    clock.advance(200);
    vi.advanceTimersByTime(150);
    await flushMicrotasks();
    expect(controller.snapshot.phase).toBe("reconnecting");
    expect(controller.supervisor.getSnapshot().backoffAttempt).toBe(1);
  }

  it("kick during a pending auto-recovery settles to ended and never rejoins", async () => {
    clock = createControllableClock(0);
    controller = new ViewerSessionController(makeControllerOpts(clock));
    const pcStub = makePCStub();
    const session1 = makeMockSession(pcStub.pc);
    await startWatching(session1, pcStub);
    await scheduleRecovery();

    // Host kick kills the media transport → death watch fires.
    pcStub.pc.connectionState = "failed";
    pcStub.fireConnectionStateChange();
    await flushMicrotasks();

    // Terminal state surfaced…
    expect(controller.snapshot.phase).toBe("ended");
    expect(controller.supervisor.getSnapshot().isIntentionalStop).toBe(true);

    // …and the previously-scheduled recovery must NOT rejoin.
    const session2 = makeMockSession(null);
    (ViewerSession as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => session2);
    clock.advance(10_000);
    vi.advanceTimersByTime(500);
    await flushMicrotasks();

    expect((ViewerSession as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(controller.snapshot.phase).toBe("ended");
  });

  it("intentional stop marked while a recovery timer is pending suppresses the rejoin", async () => {
    clock = createControllableClock(0);
    controller = new ViewerSessionController(makeControllerOpts(clock));
    const pcStub = makePCStub();
    const session1 = makeMockSession(pcStub.pc);
    await startWatching(session1, pcStub);
    await scheduleRecovery();

    // Any terminal detection (stream end / kick) between scheduling and
    // firing marks intentional-stop; the pending timer must respect it.
    controller.supervisor.markIntentionalStop();

    const session2 = makeMockSession(null);
    (ViewerSession as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => session2);

    clock.advance(60);
    vi.advanceTimersByTime(100);
    await flushMicrotasks();

    expect((ViewerSession as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(controller.snapshot.phase).toBe("ended");
  });

  it("silent transport death without prior recovery ends cleanly and does not auto-recover", async () => {
    clock = createControllableClock(0);
    controller = new ViewerSessionController(makeControllerOpts(clock));
    const pcStub = makePCStub();
    const session1 = makeMockSession(pcStub.pc);
    await startWatching(session1, pcStub);

    // Silent host-side teardown (no announcement, no stall-recovery yet).
    pcStub.pc.connectionState = "closed";
    pcStub.fireConnectionStateChange();
    await flushMicrotasks();
    expect(controller.snapshot.phase).toBe("ended");

    // Health monitor is stopped: further degradation must not schedule recovery.
    const session2 = makeMockSession(null);
    (ViewerSession as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => session2);
    mockRuntimeObj.getConnectionManager.mockReturnValue({
      getConnection: vi.fn().mockReturnValue({ state: "disconnected" }),
    });
    clock.advance(30_000);
    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();

    expect((ViewerSession as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(controller.snapshot.phase).toBe("ended");
  });

  it("silent crash WITHOUT intentional stop still auto-recovers (watcher purpose preserved)", async () => {
    clock = createControllableClock(0);
    controller = new ViewerSessionController(makeControllerOpts(clock));
    const pcStub = makePCStub();
    const session1 = makeMockSession(pcStub.pc);
    await startWatching(session1, pcStub);
    await scheduleRecovery();

    // No kick, no terminal signal — control loss only. Recovery proceeds.
    const stats2 = new Map<string, unknown>();
    stats2.set("rtp-video", { type: "inbound-rtp", kind: "video", bytesReceived: 6000 });
    const session2 = makeMockSession(null);
    session2.getPeerConnection.mockReturnValue({
      getStats: vi.fn().mockResolvedValue(stats2),
    });
    (ViewerSession as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => session2);

    clock.advance(50);
    vi.advanceTimersByTime(100);
    await flushMicrotasks();

    expect((ViewerSession as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    if (session2.onStateChange) {
      session2.onStateChange("watching");
      session2.state = "watching";
    }
    vi.advanceTimersByTime(150);
    await flushMicrotasks();
    expect(controller.snapshot.phase).toBe("watching");
  });
});

// ─── Host side: kicked viewers' join requests are rejected ─────────────────

import { ViewerMediaBinding } from "../src/renderer/services/viewer-media-binding.js";
import { JOIN_REJECTION_KICKED } from "../src/renderer/services/join-rejection.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";
import type { GroupControlEnvelope } from "@screenlink/shared";

function makeBindingRuntime() {
  const sent: Array<Record<string, unknown>> = [];
  const connManager = {
    getConnection: vi.fn().mockReturnValue({
      sendToPeer: vi.fn().mockImplementation(async (_peer: string, payload: Record<string, unknown>) => {
        sent.push(payload);
      }),
      peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
    }),
  };
  const ssm = {
    currentLogicalStreamId: "local-stream-1",
    currentMediaSessionId: "media-session-1",
    currentGroupId: "group-1",
    state: "active",
    getCurrentVdoConfig: vi.fn(() => ({ streamId: "vdo-1", password: "pw" })),
    getPublisherManager: vi.fn().mockReturnValue({ getPublisher: vi.fn().mockReturnValue(null) }),
  };
  const registry = {
    registerLocalStream: vi.fn(),
    getStream: vi.fn().mockReturnValue(null),
  };
  const runtime = {
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ssm,
    getViewerSenderController: () => null,
    resolveLocalPublication: vi.fn().mockReturnValue({
      mediaSessionId: "media-session-1",
      logicalStreamId: "local-stream-1",
      publisherManager: null,
      vdoConfig: { streamId: "vdo-1", password: "pw" },
    }),
    deviceId: "host-device",
    displayName: "Host",
  } as unknown as Phase3Runtime;
  return { runtime, sent };
}

function makeJoinEnvelope(
  viewerDeviceId: string,
  mediaSessionId: string | undefined,
): GroupControlEnvelope {
  return {
    version: 2,
    type: "stream.join.request" as never,
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId: viewerDeviceId,
    groupId: "group-1",
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: viewerDeviceId },
    payload: {
      logicalStreamId: "local-stream-1",
      viewerDeviceId,
      viewerDisplayName: "Viewer",
      requestId: crypto.randomUUID(),
      ...(mediaSessionId !== undefined ? { mediaSessionId } : {}),
    } as Record<string, unknown>,
    mac: "0".repeat(64),
  };
}

describe("ViewerMediaBinding — kicked viewer join rejection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a kicked viewer's join for the same media session", async () => {
    const { runtime, sent } = makeBindingRuntime();
    const binding = new ViewerMediaBinding(runtime);
    binding.markViewerKicked("viewer-bob", "media-session-1");

    const result = binding.handleJoinRequest(makeJoinEnvelope("viewer-bob", "media-session-1"));
    expect(result).toBeNull();
    await flushMicrotasks(4);

    const rejection = sent.find((p) => p.type === "stream.join.response");
    expect(rejection).toBeDefined();
    expect(rejection!.accepted).toBe(false);
    expect(rejection!.reason).toBe(JOIN_REJECTION_KICKED);
    binding.destroy();
  });

  it("does not affect other viewers or other media sessions", () => {
    const { runtime } = makeBindingRuntime();
    const binding = new ViewerMediaBinding(runtime);
    binding.markViewerKicked("viewer-bob", "media-session-1");

    // Different viewer — accepted.
    expect(binding.handleJoinRequest(makeJoinEnvelope("viewer-carol", "media-session-1"))).not.toBeNull();
    // Same viewer, different (new) media session — accepted.
    expect(binding.handleJoinRequest(makeJoinEnvelope("viewer-bob", "media-session-2"))).not.toBeNull();
    binding.destroy();
  });

  it("allows the kicked viewer back after the rejection window expires", async () => {
    const { runtime } = makeBindingRuntime();
    const binding = new ViewerMediaBinding(runtime);
    binding.markViewerKicked("viewer-bob", "media-session-1");

    // Inside the window → rejected.
    expect(binding.handleJoinRequest(makeJoinEnvelope("viewer-bob", "media-session-1"))).toBeNull();

    // Past the 5-minute window → accepted again.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(binding.handleJoinRequest(makeJoinEnvelope("viewer-bob", "media-session-1"))).not.toBeNull();
    binding.destroy();
  });
});
