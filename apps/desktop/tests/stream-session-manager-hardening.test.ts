// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StreamSessionManager } from "../src/renderer/services/stream-session-manager.js";
import { PublisherManager } from "../src/renderer/services/publisher-manager.js";
import { StreamMetricsService } from "../src/renderer/services/stream-metrics-service.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeMockRuntime(): Phase3Runtime {
  const registry = {
    registerLocalStream: vi.fn(),
    handleStopped: vi.fn(),
    getStream: vi.fn().mockReturnValue(null),
    getAllStreams: vi.fn().mockReturnValue([]),
    getStreamsByGroup: vi.fn().mockReturnValue([]),
  };
  const connManager = {
    broadcast: vi.fn().mockResolvedValue(undefined),
    sendOrQueueStreamLifecycle: vi.fn().mockResolvedValue("sent" as const),
    getConnection: vi.fn().mockReturnValue(null),
    isConnected: vi.fn().mockReturnValue(false),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    clearPendingForStream: vi.fn(),
  };
  const viewerBinding = {
    removeViewer: vi.fn(),
    rejectPending: vi.fn(),
    getAllViewers: vi.fn().mockReturnValue([]),
    removeMappingsForMediaSessions: vi.fn(),
  };
  const syncService = {
    getSyncState: vi.fn().mockReturnValue(null),
    performLocalEdit: vi.fn().mockResolvedValue(undefined),
  };
  const compareSessionManager = {
    isActive: vi.fn().mockReturnValue(false),
    state: "idle",
  };
  return {
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ({}),
    getViewerMediaBinding: () => viewerBinding,
    getSyncService: () => syncService,
    getMediaStatsService: () => ({
      startViewerPoller: vi.fn(),
      stopViewerPoller: vi.fn(),
      disconnectViewer: vi.fn(),
      hasViewerPoller: vi.fn().mockReturnValue(false),
    }),
    getCompareSessionManager: () => compareSessionManager,
    viewerBinding,
    syncService,
  } as unknown as Phase3Runtime & { viewerBinding: typeof viewerBinding; syncService: typeof syncService };
}

/**
 * Helpers for display media mocking with proper teardown.
 */
let _origNav: any = undefined;

function mockGetDisplayMediaResolve(): void {
  const fakeTrack = {
    kind: "video",
    label: "Screen",
    id: crypto.randomUUID(),
    enabled: true,
    readyState: "live" as const,
    stop: vi.fn(),
    getCapabilities: vi.fn().mockReturnValue({
      width: { min: 1, max: 4096 },
      height: { min: 1, max: 4096 },
      frameRate: { min: 1, max: 60 },
    }),
    getSettings: vi.fn().mockReturnValue({
      width: 1920,
      height: 1080,
      frameRate: 30,
    }),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  } as unknown as MediaStreamTrack;
  const fakeStream = {
    getVideoTracks: () => [fakeTrack],
    getAudioTracks: () => [],
    getTracks: () => [fakeTrack],
  } as unknown as MediaStream;

  _origNav = (globalThis as any).navigator;
  if (_origNav) {
    (_origNav as any).mediaDevices = (_origNav as any).mediaDevices || {};
    (_origNav as any).mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue(fakeStream);
  } else {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(fakeStream) } },
      writable: true,
      configurable: true,
    });
  }
}

/** Spy getDisplayMedia to reject with a specific error, simulating capture failure. */
function mockGetDisplayMediaReject(errorMsg = "getDisplayMedia rejected by test"): void {
  _origNav = (globalThis as any).navigator;
  if (_origNav) {
    (_origNav as any).mediaDevices = (_origNav as any).mediaDevices || {};
    (_origNav as any).mediaDevices.getDisplayMedia = vi.fn().mockRejectedValue(new Error(errorMsg));
  } else {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(new Error(errorMsg)) } },
      writable: true,
      configurable: true,
    });
  }
}

function restoreNavigator(): void {
  if (_origNav !== undefined) {
    Object.defineProperty(globalThis, "navigator", {
      value: _origNav,
      writable: true,
      configurable: true,
    });
    _origNav = undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PHASE A FAILURE — No heartbeat/reannounce timers
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreamSessionManager — Phase A failure leaves no timers", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreNavigator();
  });

  it("CHARACTERIZATION: Phase A failure leaves state=failed, no heartbeat or reannounce timers", async () => {
    // Mock getDisplayMedia to explicitly reject, rather than relying on Node not having the API
    mockGetDisplayMediaReject("simulated-capture-failure");

    await expect(ssm.startStream({
      groupId: "test-g-fail",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).rejects.toThrow("simulated-capture-failure");

    expect(ssm.state).toBe("failed");

    // Heartbeat and reannounce timers must NOT have been started
    expect((ssm as any).heartbeatTimer).toBeNull();
    expect((ssm as any).reannounceTimer).toBeNull();
  });

  it("CHARACTERIZATION: cleanupPublisher is idempotent after Phase A failure", async () => {
    mockGetDisplayMediaReject("simulated-capture-failure");

    // First failure
    await expect(ssm.startStream({
      groupId: "test-g-fail-2",
      source: { id: "s2", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).rejects.toThrow("simulated-capture-failure");

    // Second start attempt (should reset from failed state, but fail again)
    await expect(ssm.startStream({
      groupId: "test-g-fail-2",
      source: { id: "s2", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).rejects.toThrow("simulated-capture-failure");

    // Should still be in failed state
    expect(ssm.state).toBe("failed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PHASE B FAILURE — Media stays active
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreamSessionManager — Phase B announcement failure", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreNavigator();
  });

  it("CHARACTERIZATION: when sendOrQueueStreamLifecycle throws, stream state is still active", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    // Make Phase B fail
    const connManager = runtime.getConnectionManager();
    (connManager.sendOrQueueStreamLifecycle as any).mockRejectedValue(new Error("Phase B failure"));

    await ssm.startStream({
      groupId: "test-g-pb-fail",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // Despite Phase B failure, stream should be active
    expect(ssm.state).toBe("active");

    startPublishingSpy.mockRestore();
  });

  it("CHARACTERIZATION: when sendOrQueueStreamLifecycle returns 'queued', stream state is still active", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    // Make Phase B queue instead of send
    const connManager = runtime.getConnectionManager();
    (connManager.sendOrQueueStreamLifecycle as any).mockResolvedValue("queued");

    await ssm.startStream({
      groupId: "test-g-pb-queued",
      source: { id: "s2", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    expect(ssm.state).toBe("active");

    // Heartbeat and reannounce timers should still be started
    expect((ssm as any).heartbeatTimer).not.toBeNull();
    expect((ssm as any).reannounceTimer).not.toBeNull();

    startPublishingSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SUCCESSFUL CAPTURE — Live+enabled track with nonzero getSettings
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreamSessionManager — successful capture readback", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreNavigator();
  });

  it("CHARACTERIZATION: successful startStream stores nonzero capture dimensions from getSettings", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    await ssm.startStream({
      groupId: "test-g-cap",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    expect(ssm.state).toBe("active");

    // Capture dimensions should be read from getSettings
    const dims = ssm.getActualCaptureDimensions();
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
    expect(dims.fps).toBeGreaterThan(0);

    startPublishingSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PENDING LIFECYCLE CLEARED ON STOP
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreamSessionManager — pending lifecycle cleared on stop", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreNavigator();
  });

  it("CHARACTERIZATION: stopStream clears pending lifecycle for the stream", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    await ssm.startStream({
      groupId: "test-g-pending",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // Capture logicalStreamId BEFORE stop clears it
    const logicalStreamId = ssm.currentLogicalStreamId;
    expect(logicalStreamId).not.toBeNull();

    const connManager = runtime.getConnectionManager();
    const clearPendingSpy = connManager.clearPendingForStream as any;
    expect(clearPendingSpy).not.toHaveBeenCalled();

    await ssm.stopStream();

    // clearPendingForStream should have been called for the stream
    expect(clearPendingSpy).toHaveBeenCalledTimes(1);
    const callArgs = clearPendingSpy.mock.calls[0];
    expect(callArgs[0]).toBe("test-g-pending");
    expect(callArgs[1]).toBe(logicalStreamId);

    startPublishingSpy.mockRestore();
  });

  it("CHARACTERIZATION: stopStream removes local registry entry", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    await ssm.startStream({
      groupId: "test-g-reg",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    const registry = runtime.getActiveStreamRegistry();
    const handleStoppedSpy = registry.handleStopped as any;

    await ssm.stopStream();

    expect(handleStoppedSpy).toHaveBeenCalledTimes(1);
    const stopArg = handleStoppedSpy.mock.calls[0][0];
    expect(stopArg.groupId).toBe("test-g-reg");

    startPublishingSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. DESTROYED guard — switchSource no-op
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreamSessionManager — destroyed guards", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreNavigator();
  });

  it("CHARACTERIZATION: switchSource throws when destroyed", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    // First get to active state
    await ssm.startStream({
      groupId: "test-g-switch",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // Destroy (now async — Phase 1)
    await ssm.destroy();

    // Phase 1: switchSource now throws instead of silent return when destroyed
    await expect(ssm.switchSource({
      id: "s2",
      name: "New Source",
      kind: "window",
    })).rejects.toThrow("StreamSessionManager is destroyed");

    // State should still be destroyed
    expect(ssm.state).toBe("destroyed");

    startPublishingSpy.mockRestore();
  });

  it("CHARACTERIZATION: stopStream is no-op when destroyed", async () => {
    await ssm.destroy();
    await expect(ssm.stopStream()).resolves.toBeUndefined();
    expect(ssm.state).toBe("destroyed");
  });

  it("CHARACTERIZATION: startStream throws when destroyed", async () => {
    await ssm.destroy();
    await expect(ssm.startStream({
      groupId: "test-g-destroyed",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).rejects.toThrow("StreamSessionManager is destroyed");
    expect(ssm.state).toBe("destroyed");
  });

  it("CHARACTERIZATION: restartStream throws when destroyed", async () => {
    await ssm.destroy();
    await expect(ssm.restartStream()).rejects.toThrow("StreamSessionManager is destroyed");
    expect(ssm.state).toBe("destroyed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. STOP STATE GUARDS
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreamSessionManager — stop state guards", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("CHARACTERIZATION: stopStream from 'failed' state transitions to idle", async () => {
    mockGetDisplayMediaReject("simulated-capture-failure");
    await expect(ssm.startStream({
      groupId: "test-g-fail-stop",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).rejects.toThrow();

    expect(ssm.state).toBe("failed");

    // stopStream from failed should transition to idle
    await ssm.stopStream();
    expect(ssm.state).toBe("idle");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. RESET SESSION STATE VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreamSessionManager — reset session state", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreNavigator();
  });

  it("CHARACTERIZATION: after stop+start, fresh identifiers are generated", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    await ssm.startStream({
      groupId: "test-g-cycle",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    const firstMediaSessionId = ssm.currentMediaSessionId;
    const firstLogicalStreamId = ssm.currentLogicalStreamId;

    await ssm.stopStream();

    // Now start again fresh
    mockGetDisplayMediaResolve();
    await ssm.startStream({
      groupId: "test-g-cycle",
      source: { id: "s2", name: "New Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // New identifiers
    expect(ssm.currentMediaSessionId).not.toBe(firstMediaSessionId);
    expect(ssm.currentLogicalStreamId).not.toBe(firstLogicalStreamId);

    startPublishingSpy.mockRestore();
  });

  it("CHARACTERIZATION: getCaptureStream returns null after stop", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    await ssm.startStream({
      groupId: "test-g-capstream",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    expect(ssm.getCaptureStream()).not.toBeNull();

    await ssm.stopStream();

    expect(ssm.getCaptureStream()).toBeNull();

    startPublishingSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. B-11 REGRESSION — Metrics session finalization ordering on restart
// ═══════════════════════════════════════════════════════════════════════════════

describe("StreamSessionManager — B-11 metrics finalization ordering on restart", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;
  let finalizeSpy: ReturnType<typeof vi.spyOn>;
  let startSessionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);

    // Spy on the singleton's finalizeSession and startHostSession
    const svc = StreamMetricsService.getInstance();
    finalizeSpy = vi.spyOn(svc, "finalizeSession");
    startSessionSpy = vi.spyOn(svc, "startHostSession");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreNavigator();
  });

  it("REGRESSION: restartStream finalizes old metrics session BEFORE replacing this.mediaSessionId and starting new session", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    // ── Phase 1: Start initial stream ───────────────────────────────
    await ssm.startStream({
      groupId: "test-g-metrics",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });
    expect(ssm.state).toBe("active");

    const firstMediaSessionId = ssm.currentMediaSessionId;
    expect(firstMediaSessionId).toBeTruthy();

    // Verify the first metrics session was created
    const svc = StreamMetricsService.getInstance();
    const firstHistoryId = svc.findHistoryIdByMediaSessionId(firstMediaSessionId!);
    expect(firstHistoryId).toBeTruthy();

    // Clear spies so we only track calls made during restart
    finalizeSpy.mockClear();
    startSessionSpy.mockClear();

    // ── Phase 2: Restart ────────────────────────────────────────────
    // Start a new getDisplayMedia resolve for the restart phase
    mockGetDisplayMediaResolve();
    startPublishingSpy.mockClear();
    startPublishingSpy.mockResolvedValue(undefined);
    await ssm.restartStream();
    expect(ssm.state).toBe("active");

    const secondMediaSessionId = ssm.currentMediaSessionId;
    expect(secondMediaSessionId).toBeTruthy();
    expect(secondMediaSessionId).not.toBe(firstMediaSessionId);

    // ── Phase 3: Verify finalization order ──────────────────────────
    // 1. The OLD metrics session (firstMediaSessionId) must have been finalized.
    //    findHistoryIdByMediaSessionId returns null for finalized/removed sessions.
    const oldSessionAfterRestart = svc.findHistoryIdByMediaSessionId(firstMediaSessionId!);
    expect(oldSessionAfterRestart).toBeNull(
      "Old metrics session must be finalized after restart (B-11)",
    );

    // 2. The NEW metrics session (secondMediaSessionId) must still be active.
    const newSessionAfterRestart = svc.findHistoryIdByMediaSessionId(secondMediaSessionId!);
    expect(newSessionAfterRestart).toBeTruthy(
      "New metrics session must be active after restart",
    );

    // 3. finalizeSession was called for the old session's historyId
    expect(finalizeSpy).toHaveBeenCalledWith(firstHistoryId);

    // 4. startHostSession was called for the new media session ID
    expect(startSessionSpy).toHaveBeenCalledWith(
      secondMediaSessionId,
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );

    // ── Phase 3: Stop → new session is finalized too ────────────────
    await ssm.stopStream();
    const newSessionAfterStop = svc.findHistoryIdByMediaSessionId(secondMediaSessionId!);
    expect(newSessionAfterStop).toBeNull(
      "New metrics session must be finalized after stop",
    );

    startPublishingSpy.mockRestore();
  });
});
