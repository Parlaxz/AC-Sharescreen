// @vitest-environment node
/**
 * Hardening tests for ViewerSession — self-view characterization, runtime race
 * conditions, and lifecycle invariants not covered by the primary test suite.
 *
 * These tests characterize the current behavior without assuming correctness:
 * they assert WHAT the code does today so that regressions are caught on
 * refactoring.  Passing hypotheses are documented as characterization; only
 * tests that fail against the current source force production changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Hoisted mock setup (mirrors viewer-session.test.ts) ──────────────────
const mockViewerClientMethods = vi.hoisted(() => ({
  createAndConnect: vi.fn(),
  view: vi.fn(),
  stopViewing: vi.fn(),
  disconnect: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getSDK: vi.fn(),
  sendMediaBind: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  pauseMedia: vi.fn(),
  resumeMedia: vi.fn(),
}));

const mockRuntimeMethods = vi.hoisted(() => ({
  getConnectionManager: vi.fn(),
  getStreamSessionManager: vi.fn(),
  waitForJoinResponse: vi.fn(),
  cancelJoinResponse: vi.fn(),
  waitForViewerPauseResult: vi.fn(),
  cancelViewerPauseResult: vi.fn(),
  isDestroyed: vi.fn(),
  deviceId: "my-device",
  displayName: "Test Viewer",
}));

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: vi.fn(),
}));

vi.mock("@screenlink/vdo-adapter", () => ({
  ViewerClient: vi.fn(() => ({
    createAndConnect: mockViewerClientMethods.createAndConnect,
    view: mockViewerClientMethods.view,
    stopViewing: mockViewerClientMethods.stopViewing,
    disconnect: mockViewerClientMethods.disconnect,
    shutdown: mockViewerClientMethods.shutdown,
    getSDK: mockViewerClientMethods.getSDK,
    sendMediaBind: mockViewerClientMethods.sendMediaBind,
    on: mockViewerClientMethods.on,
    off: mockViewerClientMethods.off,
    pauseMedia: mockViewerClientMethods.pauseMedia,
    resumeMedia: mockViewerClientMethods.resumeMedia,
  })),
}));

import { getRuntime } from "../src/renderer/services/phase3-runtime.js";
import { ViewerClient } from "@screenlink/vdo-adapter";
import { ViewerSession } from "../src/renderer/services/viewer-session.js";

// ─── Helper ────────────────────────────────────────────────────────────────

function makeMockRuntime() {
  const sendToPeer = vi.fn().mockResolvedValue(undefined);
  const conn = {
    sendToPeer,
    peerForDevice: vi.fn().mockReturnValue("peer-uuid-host"),
  };
  const connManager = { getConnection: vi.fn().mockReturnValue(conn) };
  const ssm = { getCaptureStream: vi.fn().mockReturnValue(null) };
  return {
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ssm,
    waitForJoinResponse: mockRuntimeMethods.waitForJoinResponse,
    cancelJoinResponse: mockRuntimeMethods.cancelJoinResponse,
    waitForViewerPauseResult: mockRuntimeMethods.waitForViewerPauseResult,
    cancelViewerPauseResult: mockRuntimeMethods.cancelViewerPauseResult,
    deviceId: mockRuntimeMethods.deviceId,
    displayName: mockRuntimeMethods.displayName,
    isDestroyed: mockRuntimeMethods.isDestroyed,
    __conn: conn,
    __sendToPeer: sendToPeer,
    ssm,
  };
}

// ─── Self-view characterization ─────────────────────────────────────────────
// Requirement 1: self-view must NOT construct ViewerClient, send join request,
// call media.bind, or send host pause requests. Capture unavailability must
// retry exactly SELF_VIEW_MAX_RETRIES (3) times then stop without infinite
// timer.  All timers cleaned on destroy.

describe("ViewerSession — self-view characterization", () => {
  let session: ViewerSession;
  let runtime: ReturnType<typeof makeMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = makeMockRuntime();
    runtime.deviceId = "self-device";
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtime);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);
    session = new ViewerSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    session.destroy().catch(() => {});
  });

  function makeCaptureStream() {
    const endedHandler = vi.fn();
    const track = {
      kind: "video" as const,
      id: "self-vt-1",
      enabled: true,
      readyState: "live" as MediaStreamTrackState,
      addEventListener: vi.fn((_event: string, _handler: () => void) => {}),
      removeEventListener: vi.fn(),
    };
    return {
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
      addTrack: vi.fn(),
      getTracks: vi.fn().mockReturnValue([track]),
      id: "self-stream",
    };
  }

  it("self-view does not construct ViewerClient", async () => {
    const fakeStream = makeCaptureStream();
    runtime.ssm.getCaptureStream.mockReturnValue(fakeStream);

    await session.start({
      groupId: "g-1",
      hostDeviceId: "self-device", // matches runtime.deviceId → self-view
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Self Host",
    });

    // ViewerClient constructor was never called
    expect(ViewerClient).not.toHaveBeenCalled();
    // join flow never reached waitForJoinResponse
    expect(mockRuntimeMethods.waitForJoinResponse).not.toHaveBeenCalled();
    // No SDK connect/view/bind calls
    expect(mockViewerClientMethods.createAndConnect).not.toHaveBeenCalled();
    expect(mockViewerClientMethods.view).not.toHaveBeenCalled();
    expect(mockViewerClientMethods.sendMediaBind).not.toHaveBeenCalled();
  });

  it("self-view does not send stream.join.request", async () => {
    const fakeStream = makeCaptureStream();
    runtime.ssm.getCaptureStream.mockReturnValue(fakeStream);

    await session.start({
      groupId: "g-1",
      hostDeviceId: "self-device",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Self Host",
    });

    // No stream.join.request messages sent
    const joinRequests = runtime.__sendToPeer.mock.calls.filter(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.type === "stream.join.request",
    );
    expect(joinRequests).toHaveLength(0);
  });

  it("self-view transitions to watching state when capture available", async () => {
    const videoEl = {
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      srcObject: null,
      videoWidth: 1920,
      videoHeight: 1080,
      muted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;

    const fakeStream = makeCaptureStream();
    runtime.ssm.getCaptureStream.mockReturnValue(fakeStream);

    session.bindVideoElement(videoEl);

    const stateChanges: string[] = [];
    session.onStateChange = (s) => stateChanges.push(s);

    await session.start({
      groupId: "g-1",
      hostDeviceId: "self-device",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Self Host",
      videoElement: videoEl,
    });

    expect(session.state).toBe("watching");
    expect(stateChanges).toContain("watching");
    // Self-view mutes the video element to prevent feedback
    expect(videoEl.muted).toBe(true);
    expect(videoEl.srcObject).toBe(fakeStream);
  });

  it("self-view retries capture exactly SELF_VIEW_MAX_RETRIES times then stops", async () => {
    vi.useFakeTimers();

    // getCaptureStream always returns null (capture not ready)
    runtime.ssm.getCaptureStream.mockReturnValue(null);

    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    // Start the self-view flow (will enter the retry loop)
    const startPromise = session.start({
      groupId: "g-1",
      hostDeviceId: "self-device",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Self Host",
    });

    // The first call to getCaptureStream happens inside startSelfView,
    // which is called synchronously from runJoinFlow.  After that first
    // null result, it should schedule a timer.
    await vi.advanceTimersByTimeAsync(10_000);

    // After advancing through enough time for all retries:
    //   1 initial + 3 retries at 2s each = 4 total calls
    // But the retry fires startSelfView after 2s, which in turn calls
    // getCaptureStream again, etc.
    // SELF_VIEW_MAX_RETRIES = 3 means:
    //   attempt 0: immediate, fails → schedule retry 1
    //   attempt 1: after 2s, fails → schedule retry 2
    //   attempt 2: after 4s, fails → schedule retry 3
    //   attempt 3: after 6s, fails → no more retries, fire error
    // At 10s, all 4 attempts should have been made
    expect(runtime.ssm.getCaptureStream).toHaveBeenCalledTimes(4);

    // After the last retry, the error callback should have been called
    // with the "No local capture stream available" message
    const finalError = errors.find(
      (e) => e === "No local capture stream available. Click Preview to try again.",
    );
    expect(finalError).toBeDefined();

    // State should be "connecting" (not error — the session stays alive for
    // manual retry via UI, but the timer should NOT be scheduled again)
    expect(session.state).toBe("connecting");

    // Advance more time — no additional getCaptureStream calls
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.ssm.getCaptureStream).toHaveBeenCalledTimes(4);

    vi.useRealTimers();
  });

  it("self-view timer is cleaned on destroy", async () => {
    vi.useFakeTimers();

    runtime.ssm.getCaptureStream.mockReturnValue(null);

    // Start self-view (will enter retry loop)
    const startPromise = session.start({
      groupId: "g-1",
      hostDeviceId: "self-device",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Self Host",
    });

    // Let the first attempt fail and the first retry be scheduled
    await vi.advanceTimersByTimeAsync(1000);

    // Capture the current retry timer reference
    const retryTimer = (session as any)._selfViewRetryTimer;
    expect(retryTimer).not.toBeNull();

    // Destroy should cancel the timer
    await session.destroy();

    expect((session as any)._selfViewRetryTimer).toBeNull();

    // Advance past the original retry time — no additional calls should happen
    await vi.advanceTimersByTimeAsync(10_000);
    // Should still have only the first call (destroy cancelled before retry)
    expect(runtime.ssm.getCaptureStream).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

// ─── Runtime race tests ─────────────────────────────────────────────────────
// Requirement 2: Rapid pause→resume→pause generation correlation; teardown
// while join response/view/media.bind is pending leaves no orphan state.

describe("ViewerSession — rapid pause/resume race", () => {
  let session: ViewerSession;
  let runtime: ReturnType<typeof makeMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = makeMockRuntime();
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtime);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);
    session = new ViewerSession();
  });

  afterEach(() => {
    session.destroy().catch(() => {});
    vi.restoreAllMocks();
  });

  function setupPausedSession() {
    Object.defineProperty(session, "_state", { value: "watching", writable: true });
    (session as any).viewerClient = {
      pauseMedia: vi.fn(),
      resumeMedia: vi.fn(),
      getSDK: vi.fn().mockReturnValue({
        connections: new Map(),
      }),
    };
    Object.defineProperty(session, "groupId", { value: "g-1", writable: true });
    Object.defineProperty(session, "hostDeviceId", { value: "host-1", writable: true });
    Object.defineProperty(session, "logicalStreamId", { value: "ls-1", writable: true });
    Object.defineProperty(session, "mediaSessionId", { value: "ms-1", writable: true });
    Object.defineProperty(session, "_viewerSessionId", { value: "vsid-1", writable: true });
  }

  it("pause→resume→pause: first pause held on host ack; resume/second-pause are no-ops while pausing; first completes to paused", async () => {
    setupPausedSession();

    // Hold the first pause's host ack so we can prove state before firing
    // resume and the second pause.
    let resolveHostAck!: (data: unknown) => void;
    const hostAckHeld = new Promise((resolve) => { resolveHostAck = resolve; });
    mockRuntimeMethods.waitForViewerPauseResult.mockReturnValue(hostAckHeld);

    // Capture the real operationId from the pause request so the ack
    // matches what assertPauseResult expects.
    let realOperationId: string | undefined;
    (runtime as any).__sendToPeer.mockImplementation(
      async (_peer: string, payload: { type?: string; operationId?: string }) => {
        if (payload.type === "viewer.pause.request") {
          realOperationId = payload.operationId;
        }
      },
    );

    const nextGenBefore = (session as any)._nextPauseGeneration;

    // Start first pause (held on host ack)
    const pause1Promise = session.pause();

    // Wait for the sendToPeer notification — the pause has sent its
    // request, meaning the guard cleared and generation bumped.
    // Use setImmediate to let the microtask queue drain so the
    // synchronous sendToPeer mock fires.
    await new Promise((resolve) => setImmediate(resolve));
    expect(realOperationId).toBeDefined();
    expect(session.pauseState).toBe("pausing");
    expect((session as any)._nextPauseGeneration).toBe(nextGenBefore + 1);

    // resume() is a no-op when _pauseState !== "paused"
    const resume1 = session.resume();
    await resume1.catch(() => {});
    expect(session.pauseState).toBe("pausing"); // unchanged
    expect((session as any)._nextPauseGeneration).toBe(nextGenBefore + 1); // no bump

    // pause() is a no-op when _pauseState is "pausing"
    const pause2 = session.pause();
    await pause2.catch(() => {});
    expect(session.pauseState).toBe("pausing"); // unchanged
    expect((session as any)._nextPauseGeneration).toBe(nextGenBefore + 1); // no bump

    // Now resolve the host ack with the real operationId — first pause
    // completes, transitions to "paused"
    resolveHostAck({
      groupId: "g-1", logicalStreamId: "ls-1", mediaSessionId: "ms-1",
      viewerSessionId: "vsid-1", viewerDeviceId: "my-device",
      operationId: realOperationId!,
      paused: true, success: true,
    });
    await pause1Promise.catch(() => {});

    // Terminal state is paused; generation bumped exactly once
    expect(session.pauseState).toBe("paused");
    expect((session as any)._nextPauseGeneration).toBe(nextGenBefore + 1);
  });

  it("concurrent pause calls: second call is a no-op when already pausing; first completes normally to paused", async () => {
    setupPausedSession();

    let resolveFirstPause!: (data: unknown) => void;
    const firstPauseOpIdPromise = new Promise<string>((resolve) => {
      (runtime as any).__sendToPeer.mockImplementation(
        async (_peer: string, payload: { type?: string; operationId?: string }) => {
          if (payload.type === "viewer.pause.request") {
            resolve(payload.operationId!);
          }
        },
      );
    });

    // First pause is slow (held), second resolves immediately
    mockRuntimeMethods.waitForViewerPauseResult
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirstPause = resolve; }))
      .mockImplementation((operationId: string) =>
        Promise.resolve({
          groupId: "g-1",
          logicalStreamId: "ls-1",
          mediaSessionId: "ms-1",
          viewerSessionId: "vsid-1",
          viewerDeviceId: "my-device",
          operationId,
          paused: true,
          success: true,
        }),
      );

    // Start first pause (held on host ack)
    const pause1Promise = session.pause();
    const firstOpId = await firstPauseOpIdPromise;

    // Start second pause while first is still waiting for host ack
    // Bumps generation so first pause's result will be stale
    const pause2Promise = session.pause();

    // Resolve first pause's stale result
    resolveFirstPause({
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      viewerSessionId: "vsid-1",
      viewerDeviceId: "my-device",
      operationId: firstOpId,
      paused: true,
      success: true,
    });

    await pause1Promise.catch(() => {});
    await pause2Promise;

    // Second pause should have the current generation
    expect(session.pauseState).toBe("paused");
  });
});

// ─── Remote track-ended while paused ───────────────────────────────────────
// Requirement 4: When the remote track ended handler fires while the session
// is intentionally paused or pausing, it must NOT schedule a debounce timer,
// transition to ended, or leave lingering timer state.  The handler skips
// auto-stop because pause explicitly stops media — the track-ended event
// is expected and must not be misinterpreted as the host ending the share.

describe("ViewerSession — remote track ended while paused", () => {
  let session: ViewerSession;
  let runtime: ReturnType<typeof makeMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = makeMockRuntime();
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtime);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);
    session = new ViewerSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    session.destroy().catch(() => {});
  });

  /**
   * Start a full join flow to "watching" and capture the handleRemoteTrackEnded
   * closure registered on the video track.  The closure is wired via
   * track.addEventListener("ended", ...) inside the runJoinFlow track handler,
   * so we capture it from the mock and fire it directly.
   */
  async function startSessionAndCaptureEndedHandler(): Promise<{
    track: ReturnType<typeof vi.fn> & { addEventListener: ReturnType<typeof vi.fn> };
    endedHandler: () => void;
  }> {
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true, mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1", streamId: "stream-1", password: "vdo-password",
    });
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-1", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);

    // Track mock that captures the "ended" handler when the SDK wires it
    let capturedEndedHandler: (() => void) | null = null;
    const mockAddEventListener = vi.fn(
      (event: string, handler: () => void) => {
        if (event === "ended") capturedEndedHandler = handler;
      },
    );
    const track = {
      kind: "video",
      id: "vt-1",
      enabled: true,
      readyState: "live",
      addEventListener: mockAddEventListener,
      removeEventListener: vi.fn(),
    } as unknown as MediaStreamTrack;

    const mockAddTrack = vi.fn();
    const mockStream = {
      addTrack: mockAddTrack,
      getTracks: vi.fn().mockReturnValue([]),
    };

    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // Find the trackAdded handler that runJoinFlow registered
    const trackAddedHandler = mockViewerClientMethods.on.mock.calls.find(
      ([e]: [string]) => e === "trackAdded",
    )?.[1] as ((event: { detail: unknown }) => void) | undefined;
    expect(trackAddedHandler).toBeDefined();

    // Fire the track event — this triggers handleTrackEvent which calls
    // track.addEventListener("ended", handleRemoteTrackEnded)
    trackAddedHandler!({
      detail: { track, streams: [mockStream], uuid: "peer-1" },
    });

    expect(session.state).toBe("watching");
    expect(capturedEndedHandler).not.toBeNull();
    expect(mockAddEventListener).toHaveBeenCalledWith(
      "ended", expect.any(Function), { once: true },
    );

    return { track: track as any, endedHandler: capturedEndedHandler! };
  }

  it("remote track ended while pauseState is 'paused' does not stop or create debounce timer", async () => {
    vi.useFakeTimers();
    try {
      const { endedHandler } = await startSessionAndCaptureEndedHandler();

      // Set pause state to paused
      Object.defineProperty(session, "_pauseState", { value: "paused", writable: true });
      expect((session as any)._remoteTrackEndedTimer).toBeNull();

      // Fire the ended handler — guarded by pauseState check
      endedHandler();

      // Must NOT have set a debounce timer
      expect((session as any)._remoteTrackEndedTimer).toBeNull();
      // Must NOT have transitioned to ended
      expect(session.state).toBe("watching");
      // No stop-related artifacts
      expect(session.state).not.toBe("ended");

      // Advance past the debounce window — no latent timer fires
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session.state).toBe("watching");
    } finally {
      vi.useRealTimers();
    }
  });

  it("remote track ended while pauseState is 'pausing' does not stop or create debounce timer", async () => {
    vi.useFakeTimers();
    try {
      const { endedHandler } = await startSessionAndCaptureEndedHandler();

      // Set pause state to pausing
      Object.defineProperty(session, "_pauseState", { value: "pausing", writable: true });
      expect((session as any)._remoteTrackEndedTimer).toBeNull();

      // Fire the ended handler — guarded by pauseState check
      endedHandler();

      // Must NOT have set a debounce timer
      expect((session as any)._remoteTrackEndedTimer).toBeNull();
      // Must NOT have transitioned to ended
      expect(session.state).toBe("watching");

      // Advance past the debounce window — no latent timer fires
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session.state).toBe("watching");
    } finally {
      vi.useRealTimers();
    }
  });

  it("remote track ended while watching (not paused) creates 2s debounce timer", async () => {
    vi.useFakeTimers();
    try {
      const { endedHandler } = await startSessionAndCaptureEndedHandler();

      // pauseState defaults to "playing" — not paused
      expect(session.pauseState).toBe("playing");
      expect((session as any)._remoteTrackEndedTimer).toBeNull();

      // Fire the ended handler — NOT guarded, should start debounce
      endedHandler();

      // Must have set a debounce timer
      expect((session as any)._remoteTrackEndedTimer).not.toBeNull();

      // Advance partway — still watching
      await vi.advanceTimersByTimeAsync(1_000);
      expect(session.state).toBe("watching");

      // Advance past 2s debounce — should trigger stop → ended
      await vi.advanceTimersByTimeAsync(1_500);
      expect(session.state).toBe("ended");
    } finally {
      vi.useRealTimers();
    }
  });

  it("remote track ended while paused does not leave lingering debounce timer on destroy", async () => {
    vi.useFakeTimers();
    try {
      const { endedHandler } = await startSessionAndCaptureEndedHandler();

      // Set pause state to paused
      Object.defineProperty(session, "_pauseState", { value: "paused", writable: true });
      endedHandler();

      // No timer was set
      expect((session as any)._remoteTrackEndedTimer).toBeNull();

      // Destroy cleans up cleanly
      await session.destroy();
      expect((session as any)._remoteTrackEndedTimer).toBeNull();

      // Advance past debounce window — nothing fires
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session.state).toBe("ended"); // set by destroy
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ViewerSession — destroy while pending operations", () => {
  let session: ViewerSession;
  let runtime: ReturnType<typeof makeMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = makeMockRuntime();
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtime);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);
    session = new ViewerSession();
  });

  afterEach(async () => {
    // Safely destroy even if already destroyed (idempotent by design).
    // The .catch() guards against rejected teardown in test-failure edge cases.
    if (session) {
      await session.destroy().catch(() => {});
    }
    vi.restoreAllMocks();
  });

  it("destroy while join response is pending leaves no orphan ViewerClient", async () => {
    // Hold the join response
    let resolveJoin!: (value: unknown) => void;
    mockRuntimeMethods.waitForJoinResponse.mockReturnValue(
      new Promise((resolve) => { resolveJoin = resolve; }),
    );

    // Set up join request to succeed
    const sendToPeer = vi.fn().mockResolvedValue(undefined);
    const conn = { sendToPeer, peerForDevice: vi.fn().mockReturnValue("peer-uuid-host") };
    const connManager = { getConnection: vi.fn().mockReturnValue(conn) };
    (runtime as any).getConnectionManager = () => connManager;

    const startPromise = session.start({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Host",
    });

    // Destroy while join response is pending
    await session.destroy();

    // Now resolve the join response (stale)
    resolveJoin({
      accepted: true,
      mediaJoinMetadata: "token",
      mediaSessionId: "ms-1",
      streamId: "stream-1",
      password: "vdo-password",
    });

    await startPromise.catch(() => {});

    // ViewerClient should NOT have been created (abandoned flow)
    expect(ViewerClient).not.toHaveBeenCalled();
    expect(mockViewerClientMethods.createAndConnect).not.toHaveBeenCalled();
    expect(mockViewerClientMethods.view).not.toHaveBeenCalled();
  });

  it("destroy while view() is pending cleans up safely", async () => {
    // Join response resolves quickly
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "stream-1",
      password: "vdo-password",
    });

    // Hold createAndConnect (simulates SDK connect in progress).
    // Expose a notification so the test can await until createAndConnect
    // is definitely entered, rather than guessing with setImmediate.
    let resolveConnect!: () => void;
    let connectEntered!: () => void;
    const connectEnteredPromise = new Promise<void>((resolve) => { connectEntered = resolve; });
    mockViewerClientMethods.createAndConnect.mockImplementation(async () => {
      connectEntered();
      await new Promise<void>((resolve) => { resolveConnect = resolve; });
    });

    const sendToPeer = vi.fn().mockResolvedValue(undefined);
    const conn = { sendToPeer, peerForDevice: vi.fn().mockReturnValue("peer-uuid-host") };
    const connManager = { getConnection: vi.fn().mockReturnValue(conn) };
    (runtime as any).getConnectionManager = () => connManager;

    const startPromise = session.start({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Host",
    });

    // Wait for createAndConnect to be entered (deterministic, no timing)
    await connectEnteredPromise;
    // At this point the ViewerClient was constructed and createAndConnect
    // is in-flight. The join flow is suspended on the await.

    // Destroy while createAndConnect is pending
    await session.destroy();

    // Resolve createAndConnect — should be abandoned (generation check after await)
    resolveConnect();

    await startPromise.catch(() => {});

    // After destroy, no view() or sendMediaBind should have been called
    expect(mockViewerClientMethods.view).not.toHaveBeenCalled();
    expect(mockViewerClientMethods.sendMediaBind).not.toHaveBeenCalled();
    // The connect call itself may have been started but its result was abandoned
    expect(session.state).toBe("ended");
  });

  it("destroy while media.bind is pending leaves no orphan video srcObject", async () => {
    // Full join flow up to media.bind — hold sendMediaBind
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "stream-1",
      password: "vdo-password",
    });
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);

    // Hold sendMediaBind
    let resolveBind!: () => void;
    mockViewerClientMethods.sendMediaBind.mockReturnValue(
      new Promise<void>((resolve) => { resolveBind = resolve; }),
    );

    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-1", { viewer: null, publisher: null }]]),
    });

    const sendToPeer = vi.fn().mockResolvedValue(undefined);
    const conn = { sendToPeer, peerForDevice: vi.fn().mockReturnValue("peer-uuid-host") };
    const connManager = { getConnection: vi.fn().mockReturnValue(conn) };
    (runtime as any).getConnectionManager = () => connManager;

    // Use a sentinel object so we can assert exact identity remains unchanged
    // after the abandoned flow. A plain object {} is a unique reference —
    // if the abandoned flow somehow mutates srcObject, identity will differ.
    const SENTINEL_SRC_OBJECT = {};
    const mockVideo = {
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      srcObject: SENTINEL_SRC_OBJECT,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    session.bindVideoElement(mockVideo);

    const startPromise = session.start({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Host",
      videoElement: mockVideo,
    });

    // Let flow reach sendMediaBind (it's held)
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Destroy while sendMediaBind is pending
    await session.destroy();

    // Resolve sendMediaBind (abandoned)
    resolveBind();
    await startPromise.catch(() => {});

    // After destroy, video element's srcObject must be the EXACT sentinel
    // reference — the abandoned flow must NOT have overwritten it.
    expect(mockVideo.srcObject).toBe(SENTINEL_SRC_OBJECT);
    // The session's received stream should be null (never delivered)
    expect((session as any)._receivedStream).toBeNull();
    // State is ended
    expect(session.state).toBe("ended");
  });
});
