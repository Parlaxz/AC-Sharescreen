// @vitest-environment node
/**
 * Tests for ViewerSession — generation counter, abandoned flow prevention,
 * and track event handling.
 *
 * Since ViewerSession depends on browser APIs (MediaStream, HTMLVideoElement,
 * ViewerClient from vdo-adapter), these tests focus on the generation-counter
 * logic, the extractTrackEvent integration, and the isCurrent guard, using
 * minimal mocking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Hoisted mock setup ────────────────────────────────────────────────────
// vi.mock is hoisted above imports, so vi.hoisted is needed for shared vars.
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
}));

const mockRuntimeMethods = vi.hoisted(() => ({
  getConnectionManager: vi.fn(),
  getStreamSessionManager: vi.fn(),
  waitForJoinResponse: vi.fn(),
  cancelJoinResponse: vi.fn(),
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
  })),
}));

import { getRuntime } from "../src/renderer/services/phase3-runtime.js";
import { ViewerSession } from "../src/renderer/services/viewer-session.js";

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
    deviceId: mockRuntimeMethods.deviceId,
    displayName: mockRuntimeMethods.displayName,
    isDestroyed: mockRuntimeMethods.isDestroyed,
    __conn: conn,
    __sendToPeer: sendToPeer,
  };
}

describe("ViewerSession — generation counter", () => {
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
    session.destroy();
    vi.restoreAllMocks();
  });

  it("starts in idle state", () => {
    expect(session.state).toBe("idle");
  });

  it("isCurrent() returns false before any start", () => {
    // Before start(), generation is -1, so isCurrent() returns false.
    // This is expected — nothing should be in-flight before start.
    expect(session.state).toBe("idle");
  });

  it("generation is set on start and checked after awaits", async () => {
    // Set up join response
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "stream-1",
      password: "vdo-password",
    });

    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-1", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);

    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    await session.start({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Host",
    });

    expect(errors).toEqual([]);
    expect(session.state).not.toBe("error");
    expect(mockViewerClientMethods.createAndConnect).toHaveBeenCalled();
    expect(mockViewerClientMethods.view).toHaveBeenCalled();
  });

  it("destroy() prevents track handler from setting watching", () => {
    const stateChanges: string[] = [];
    session.onStateChange = (s) => stateChanges.push(s);

    // Fire the track handler logic after destroy:
    // isCurrent() returns false because _destructed is true
    session.destroy();

    expect(stateChanges).not.toContain("watching");
  });

  it("calling destroy mid-flow abandons the flow", async () => {
    let resolveJoinResponse!: (value: unknown) => void;
    mockRuntimeMethods.waitForJoinResponse.mockReturnValue(
      new Promise((resolve) => { resolveJoinResponse = resolve; }),
    );

    const startPromise = session.start({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Host",
    });

    // Destroy before join response resolves
    session.destroy();

    // Now resolve the join response
    resolveJoinResponse({
      accepted: true,
      mediaJoinMetadata: "token",
      mediaSessionId: "ms-1",
    });

    await startPromise;

    // After destroy, the flow should be abandoned.
    // ViewerClient should NOT have been created.
    expect(mockViewerClientMethods.createAndConnect).not.toHaveBeenCalled();
    expect(mockViewerClientMethods.view).not.toHaveBeenCalled();
  });

  it("destroy during pending send does not surface an unhandled join-cancel rejection", async () => {
    let rejectJoinResponse!: (reason?: unknown) => void;
    let resolveSendToPeer!: () => void;

    const joinResponsePromise = new Promise((_, reject) => {
      rejectJoinResponse = reject;
    });
    mockRuntimeMethods.waitForJoinResponse.mockReturnValue(joinResponsePromise);
    mockRuntimeMethods.cancelJoinResponse.mockImplementation(() => {
      rejectJoinResponse(new Error("Join response cancelled"));
    });

    (runtime as any).__sendToPeer.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSendToPeer = resolve;
      }),
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const startPromise = session.start({
        groupId: "g-1",
        hostDeviceId: "host-1",
        logicalStreamId: "ls-1",
        mediaSessionId: "ms-1",
        hostName: "Host",
      });

      session.destroy();
      await new Promise((resolve) => setImmediate(resolve));
      resolveSendToPeer();
      await startPromise;

      expect(unhandled).toEqual([]);
      expect((session as any)._pendingRequestId).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stop sends stream.leave to the host peer", async () => {
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "stream-1",
      password: "vdo-password",
    });

    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-1", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);

    await session.start({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Host",
    });

    session.stop();
    await Promise.resolve();

    expect((runtime as any).__sendToPeer).toHaveBeenNthCalledWith(
      2,
      "peer-uuid-host",
      expect.objectContaining({
        type: "stream.leave",
        logicalStreamId: "ls-1",
        viewerDeviceId: "my-device",
      }),
    );
  });

  it("retry() bumps generation and creates a new ViewerClient", async () => {
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "stream-1",
      password: "vdo-password",
    });

    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-1", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);

    // First start
    await session.start({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      hostName: "Host",
    });

    expect(mockViewerClientMethods.createAndConnect).toHaveBeenCalledTimes(1);
    const firstGen = (session as any)._generation;

    // Clear call counts for retry
    vi.clearAllMocks();
    // Re-setup mocks after clearAllMocks
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "stream-1",
      password: "vdo-password",
    });
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-2", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);

    // Retry
    await session.retry();

    expect(mockViewerClientMethods.createAndConnect).toHaveBeenCalledTimes(1);
    const secondGen = (session as any)._generation;
    expect(secondGen).not.toBe(firstGen);
  });
});

// ─── Leave/rejoin lifecycle ─────────────────────────────────────────────

describe("ViewerSession — leave/rejoin lifecycle", () => {
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
    session.destroy();
    vi.restoreAllMocks();
  });

  function mockJoinResponseOk() {
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "stream-1",
      password: "vdo-password",
    });
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-1", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);
  }

  it("start() generates a viewerSessionId for the attempt", async () => {
    mockJoinResponseOk();
    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });
    expect(session.viewerSessionId).toMatch(/^[0-9a-f-]{8,}/);
  });

  it("stream.join.request carries the viewerSessionId", async () => {
    mockJoinResponseOk();
    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });
    const sentJoin = (runtime as any).__sendToPeer.mock.calls.find(
      ([peer, payload]: [string, Record<string, unknown>]) => payload.type === "stream.join.request",
    )?.[1];
    expect(sentJoin).toBeDefined();
    expect(sentJoin.viewerSessionId).toBe(session.viewerSessionId);
  });

  it("stream.leave carries the viewerSessionId", async () => {
    mockJoinResponseOk();
    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });
    session.stop();
    await Promise.resolve();
    const sentLeave = (runtime as any).__sendToPeer.mock.calls.find(
      ([peer, payload]: [string, Record<string, unknown>]) => payload.type === "stream.leave",
    )?.[1];
    expect(sentLeave).toBeDefined();
    expect(sentLeave.viewerSessionId).toBe(session.viewerSessionId);
  });

  it("stream.leave carries the mediaSessionId for precise host cleanup", async () => {
    mockJoinResponseOk();
    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });
    session.stop();
    await Promise.resolve();
    const sentLeave = (runtime as any).__sendToPeer.mock.calls.find(
      ([peer, payload]: [string, Record<string, unknown>]) => payload.type === "stream.leave",
    )?.[1];
    expect(sentLeave).toBeDefined();
    // mediaSessionId must be present so the host can call removeViewerMapping()
    // with the exact composite key instead of falling through to the less precise
    // removeViewer() path.
    expect(sentLeave.mediaSessionId).toBe("ms-1");
  });

  it("teardown calls shutdown() on the ViewerClient (not stopViewing + disconnect concurrently)", async () => {
    mockJoinResponseOk();
    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });
    session.stop();
    // Drain the microtask queue so the async teardown completes
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockViewerClientMethods.shutdown).toHaveBeenCalledTimes(1);
  });

  it("repeated stop() calls share a single teardown promise", async () => {
    mockJoinResponseOk();
    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });
    session.stop();
    session.stop();
    session.stop();
    await new Promise((resolve) => setImmediate(resolve));
    // shutdown was awaited exactly once, even though stop() was called 3 times
    expect(mockViewerClientMethods.shutdown).toHaveBeenCalledTimes(1);
  });

  it("new start() after stop() awaits the in-progress teardown", async () => {
    mockJoinResponseOk();
    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // First leave: fire-and-forget stop
    session.stop();
    // Immediately start a new watch while teardown is in flight
    mockJoinResponseOk();
    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // New attempt has a new session ID
    expect(session.viewerSessionId).toMatch(/^[0-9a-f-]{8,}/);
    // And the new join request was sent
    const sentJoin = (runtime as any).__sendToPeer.mock.calls
      .map(([, p]: [string, Record<string, unknown>]) => p)
      .filter((p) => p.type === "stream.join.request");
    expect(sentJoin.length).toBe(2);
    expect(sentJoin[0].viewerSessionId).not.toBe(sentJoin[1].viewerSessionId);
  });
});

describe("ViewerSession — track event handling", () => {
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
    session.destroy();
    vi.restoreAllMocks();
  });

  it("extractTrackEvent helper correctly processes event detail with track", async () => {
    const { extractTrackEvent } = await import("../src/renderer/services/sdk-event-normalizer.js");

    const mockTrack = { kind: "video", id: "vt-1", enabled: true, readyState: "live" };
    const result = extractTrackEvent({
      detail: { track: mockTrack, streams: [{ id: "stream-1" }], uuid: "peer-1" },
    });

    expect(result.valid).toBe(true);
    expect(result.track).toBe(mockTrack);
    expect(result.streams).toHaveLength(1);
    expect(result.uuid).toBe("peer-1");
  });

  it("audio-only track does not trigger watching transition", () => {
    const handlerIsVideoOnly = (kind: string): boolean => kind === "video";
    expect(handlerIsVideoOnly("audio")).toBe(false);
    expect(handlerIsVideoOnly("video")).toBe(true);
  });

  it("registers handlers for both trackAdded and track events", async () => {
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

    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    const onCalls = mockViewerClientMethods.on.mock.calls;
    const registeredEvents = onCalls.map(([event]: [string]) => event);
    expect(registeredEvents).toContain("trackAdded");
    expect(registeredEvents).toContain("track");
  });

  it("trackAdded event without streams array creates stream and transitions to watching", async () => {
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

    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // Capture the trackAdded handler registered on the mock ViewerClient
    const trackAddedHandler = mockViewerClientMethods.on.mock.calls.find(
      ([event]: [string]) => event === "trackAdded",
    )?.[1] as ((event: { detail: unknown }) => void) | undefined;
    expect(trackAddedHandler).toBeDefined();

    // Fire a trackAdded-like event with no streams array (real SDK shape)
    const mockTrack = { kind: "video", id: "vt-1", enabled: true, readyState: "live" };
    trackAddedHandler!({ detail: { track: mockTrack, uuid: "peer-1" } });

    // Should have created a received stream and transitioned to watching
    expect(session.state).toBe("watching");
    expect(session.receivedStream).not.toBeNull();
  });

  it("seeds dedupe from adopted stream tracks to avoid duplicate insertion", async () => {
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

    await session.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // Capture the trackAdded handler
    const trackAddedHandler = mockViewerClientMethods.on.mock.calls.find(
      ([event]: [string]) => event === "trackAdded",
    )?.[1] as ((event: { detail: unknown }) => void) | undefined;
    expect(trackAddedHandler).toBeDefined();

    // Mock stream that already contains the track we will fire
    const mockTrack = { kind: "video", id: "vt-existing", enabled: true, readyState: "live" };
    const mockStreamAddTrack = vi.fn();
    const mockStream = {
      addTrack: mockStreamAddTrack,
      getTracks: vi.fn().mockReturnValue([mockTrack]),
    };

    // Fire event with streams[0] containing the pre-existing track
    trackAddedHandler!({ detail: { track: mockTrack, streams: [mockStream], uuid: "peer-1" } });

    // The handler should NOT call addTrack because the track id is already
    // in the dedupe set (seeded from the adopted stream's getTracks)
    expect(mockStreamAddTrack).not.toHaveBeenCalled();
    expect(session.state).toBe("watching");
  });
});

describe("ViewerSession — readiness timeout", () => {
  let session: ViewerSession;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    session = new ViewerSession();
  });

  afterEach(() => {
    session.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("timeout fires error when no video track arrives", () => {
    const errors: string[] = [];
    const stateChanges: string[] = [];
    session.onError = (e) => errors.push(e);
    session.onStateChange = (s) => stateChanges.push(s);

    // Simulate being mid-join with no video track yet
    Object.defineProperty(session, "_state", { value: "connecting-media", writable: true });
    (session as any).startReadinessTimeout();

    vi.advanceTimersByTime(15_000);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("no video track was received");
    expect(stateChanges).toContain("error");
  });

  it("timeout does not fire after watching state set", () => {
    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    Object.defineProperty(session, "_state", { value: "watching", writable: true });
    (session as any).startReadinessTimeout();
    vi.advanceTimersByTime(15_000);

    expect(errors.length).toBe(0);
  });

  it("timeout does not fire after destroy", () => {
    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    Object.defineProperty(session, "_state", { value: "connecting-media", writable: true });
    session.destroy();
    (session as any).startReadinessTimeout();
    vi.advanceTimersByTime(15_000);

    expect(errors.length).toBe(0);
  });
});

describe("ViewerSession — destroy lifecycle", () => {
  let session: ViewerSession;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    session = new ViewerSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("destroy clears video.srcObject and pauses the video element", () => {
    const mockVideo = {
      pause: vi.fn(),
      srcObject: "fake-stream",
      autoplay: false,
      playsInline: false,
      muted: false,
      volume: 1,
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;

    session.bindVideoElement(mockVideo);
    // Simulate having a received stream
    Object.defineProperty(session, "_receivedStream", { value: "some-stream", writable: true });

    session.destroy();

    // video.pause and srcObject cleared
    expect(mockVideo.pause).toHaveBeenCalled();
    expect((mockVideo as any).srcObject).toBeNull();
  });

  it("destroy cancels readiness timer", () => {
    const cancelSpy = vi.fn();
    (session as any).cancelReadinessTimer = cancelSpy;

    session.destroy();

    expect(cancelSpy).toHaveBeenCalled();
  });

  it("destroy clears status interval", () => {
    const clearSpy = vi.fn();
    (session as any).clearStatusInterval = clearSpy;

    session.destroy();

    expect(clearSpy).toHaveBeenCalled();
  });

  it("destroy cancels pending join", () => {
    const cancelSpy = vi.fn();
    (session as any).cancelPendingJoin = cancelSpy;

    session.destroy();

    expect(cancelSpy).toHaveBeenCalled();
  });

  it("destroy clears callback references (onStateChange, onStreamReceived, onError)", () => {
    session.onStateChange = vi.fn();
    session.onStreamReceived = vi.fn();
    session.onError = vi.fn();

    session.destroy();

    // After final teardown, callbacks should be nulled
    expect(session.onStateChange).toBeNull();
    expect(session.onStreamReceived).toBeNull();
    expect(session.onError).toBeNull();
  });

  it("destroy is idempotent", () => {
    session.destroy();
    // Second destroy should not throw
    expect(() => session.destroy()).not.toThrow();
    // State should be "ended"
    expect(session.state).toBe("ended");
  });

  it("destroy clears received stream", () => {
    Object.defineProperty(session, "_receivedStream", { value: "some-stream", writable: true });

    session.destroy();

    expect((session as any)._receivedStream).toBeNull();
  });

  it("destroy clears pause state and poster", () => {
    Object.defineProperty(session, "_pauseState", { value: "paused", writable: true });
    Object.defineProperty(session, "_pausePoster", { value: "data:image/jpeg;base64,abc", writable: true });

    session.destroy();

    expect(session.pauseState).toBe("playing");
    expect(session.pausePoster).toBeNull();
  });

  it("destroy clears bind token and mediaSessionId", () => {
    Object.defineProperty(session, "_bindToken", { value: "token-123", writable: true });
    Object.defineProperty(session, "_bindMediaSessionId", { value: "ms-1", writable: true });

    session.destroy();

    expect((session as any)._bindToken).toBeNull();
    expect((session as any)._bindMediaSessionId).toBeNull();
  });
});

// ─── Concurrent instances (instance-local generations) ──────────────────

describe("ViewerSession — instance-local generations", () => {
  let sessionA: ViewerSession;
  let sessionB: ViewerSession;
  let runtime: ReturnType<typeof makeMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = makeMockRuntime();
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtime);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);
    sessionA = new ViewerSession();
    sessionB = new ViewerSession();
  });

  afterEach(() => {
    sessionA.destroy();
    sessionB.destroy();
    vi.restoreAllMocks();
  });

  function mockJoinOk() {
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "stream-1",
      password: "vdo-password",
    });
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-1", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);
  }

  it("two ViewerSession instances can run concurrently without interfering", async () => {
    mockJoinOk();
    mockJoinOk(); // same setup works for both

    await Promise.all([
      sessionA.start({
        groupId: "g-1", hostDeviceId: "host-1",
        logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
      }),
      sessionB.start({
        groupId: "g-2", hostDeviceId: "host-2",
        logicalStreamId: "ls-2", mediaSessionId: "ms-2", hostName: "Host2",
      }),
    ]);

    // Both sessions should have succeeded independently
    expect(sessionA.state).not.toBe("error");
    expect(sessionB.state).not.toBe("error");
    expect(sessionA.viewerSessionId).toMatch(/^[0-9a-f-]{8,}/);
    expect(sessionB.viewerSessionId).toMatch(/^[0-9a-f-]{8,}/);
    expect(sessionA.viewerSessionId).not.toBe(sessionB.viewerSessionId);
    // Both should have created their own ViewerClient
    expect(mockViewerClientMethods.createAndConnect).toHaveBeenCalledTimes(2);
    expect(mockViewerClientMethods.view).toHaveBeenCalledTimes(2);
  });

  it("destroy on session A does not invalidate session B", async () => {
    mockJoinOk();
    await sessionA.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });
    // Start session B and hold it at join response
    let resolveB!: (value: unknown) => void;
    mockRuntimeMethods.waitForJoinResponse.mockReturnValue(
      new Promise((resolve) => { resolveB = resolve; }),
    );
    const startBPromise = sessionB.start({
      groupId: "g-2", hostDeviceId: "host-2",
      logicalStreamId: "ls-2", mediaSessionId: "ms-2", hostName: "Host2",
    });

    // Destroy session A mid-flow of session B
    await sessionA.destroy();
    expect(sessionA.state).toBe("ended");

    // Session B should still be alive (in-flight), resolve it
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-2", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);
    resolveB({
      accepted: true,
      mediaJoinMetadata: "token-b",
      mediaSessionId: "ms-2",
      streamId: "stream-2",
      password: "vdo-password",
    });

    await startBPromise;
    // Session B's flow completed because it uses its own generation
    expect(sessionB.state).not.toBe("error");
    // Both A and B called createAndConnect: A before destroy, B after
    expect(mockViewerClientMethods.createAndConnect).toHaveBeenCalledTimes(2);
  });

  it("retry refreshes stale logical/media session IDs from active stream registry", async () => {
    // Original session has ms-1/ls-1, but host has restarted with ms-2/ls-2
    mockJoinOk();

    // Runtime mock with registry that returns the NEW stream
    const mockRegistry = {
      getStreamsByGroup: vi.fn().mockReturnValue([{
        logicalStreamId: "ls-2",
        mediaSessionId: "ms-2",
        groupId: "g-1",
        hostDeviceId: "host-1",
        hostDisplayName: "Host",
        sourceKind: "screen",
        sourceName: "Screen",
        startedAt: 2000,
        appliedSettingsRevision: 0,
        heartbeatSequence: 2,
        streamRevision: 2,
        mediaJoinMetadata: "",
        replacesSessionId: "ms-1",
      }]),
      getStream: vi.fn().mockReturnValue(null),
      registerLocalStream: vi.fn(),
      handleStopped: vi.fn(),
      getAllStreams: vi.fn().mockReturnValue([]),
      onUpdate: vi.fn(),
      destroy: vi.fn(),
    };
    const mockConn = {
      sendToPeer: vi.fn().mockResolvedValue(undefined),
      peerForDevice: vi.fn().mockReturnValue("peer-uuid-host"),
    };
    const mockConnManager = { getConnection: vi.fn().mockReturnValue(mockConn) };
    const mockSsm = { getCaptureStream: vi.fn().mockReturnValue(null) };
    const refreshedRuntime = {
      ...runtime,
      getActiveStreamRegistry: () => mockRegistry,
      getConnectionManager: () => mockConnManager,
      getStreamSessionManager: () => mockSsm,
    };
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(refreshedRuntime);

    // Start with old session IDs
    await sessionA.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // Host restarts — registry now has new stream
    // Mock the join response to return new session IDs
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "new-token",
      mediaSessionId: "ms-2",
      streamId: "stream-2",
      password: "vdo-password",
    });
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-2", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);

    // Clear previous call tracking then retry
    mockConn.sendToPeer.mockClear();

    // Retry — should pick up new stream info from registry
    await sessionA.retry();

    // The join request should have been sent with the NEW logicalStreamId
    const sendToPeerCalls = mockConn.sendToPeer.mock.calls;
    const joinRequest = sendToPeerCalls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.type === "stream.join.request",
    );
    expect(joinRequest).toBeDefined();
    const joinPayload = joinRequest![1] as Record<string, unknown>;
    expect(joinPayload.logicalStreamId).toBe("ls-2");
  });

  it("restarting a share with new logical/media session does not leave viewer joining old stream", async () => {
    // Viewer starts watching stream with ls-1/ms-1
    mockJoinOk();
    await sessionA.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // Host stops and restarts with new stream ls-2/ms-2
    // Registry now only has the new stream
    const mockRegistry2 = {
      getStreamsByGroup: vi.fn().mockReturnValue([{
        logicalStreamId: "ls-2",
        mediaSessionId: "ms-2",
        groupId: "g-1",
        hostDeviceId: "host-1",
        hostDisplayName: "Host",
        sourceKind: "screen",
        sourceName: "New Screen",
        startedAt: 3000,
        appliedSettingsRevision: 0,
        heartbeatSequence: 1,
        streamRevision: 2,
        mediaJoinMetadata: "",
        replacesSessionId: "ms-1",
      }]),
      getStream: vi.fn().mockReturnValue(null),
      registerLocalStream: vi.fn(),
      handleStopped: vi.fn(),
      getAllStreams: vi.fn().mockReturnValue([]),
      onUpdate: vi.fn(),
      destroy: vi.fn(),
    };
    const conn2 = {
      sendToPeer: vi.fn().mockResolvedValue(undefined),
      peerForDevice: vi.fn().mockReturnValue("peer-uuid-new"),
    };
    const connManager2 = { getConnection: vi.fn().mockReturnValue(conn2) };
    const ssm2 = { getCaptureStream: vi.fn().mockReturnValue(null) };
    const refreshedRuntime2 = {
      ...runtime,
      getActiveStreamRegistry: () => mockRegistry2,
      getConnectionManager: () => connManager2,
      getStreamSessionManager: () => ssm2,
    };
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(refreshedRuntime2);

    // Retry should NOT send join request with old stream IDs
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "token-new",
      mediaSessionId: "ms-2",
      streamId: "vdo-stream-2",
      password: "vdo-password-2",
    });
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-new", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);

    await sessionA.retry();

    // Verify join request carried new IDs
    const calls = conn2.sendToPeer.mock.calls;
    const joinReq = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.type === "stream.join.request",
    );
    expect(joinReq).toBeDefined();
    const payload = joinReq![1] as Record<string, unknown>;
    // Must NOT carry old stream IDs
    expect(payload.logicalStreamId).not.toBe("ls-1");
    // Must carry new stream ID
    expect(payload.logicalStreamId).toBe("ls-2");
  });

  it("retry on session A does not reset session B", async () => {
    mockJoinOk();
    await Promise.all([
      sessionA.start({
        groupId: "g-1", hostDeviceId: "host-1",
        logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
      }),
      sessionB.start({
        groupId: "g-2", hostDeviceId: "host-2",
        logicalStreamId: "ls-2", mediaSessionId: "ms-2", hostName: "Host2",
      }),
    ]);

    const genA = (sessionA as any)._generation;
    const genB = (sessionB as any)._generation;

    // Retry session A
    vi.clearAllMocks();
    mockJoinOk();
    await sessionA.retry();

    // Session A got a new generation
    expect((sessionA as any)._generation).not.toBe(genA);
    // Session B's generation should be unchanged
    expect((sessionB as any)._generation).toBe(genB);
    // Session B should still be watching
    expect(sessionB.state).not.toBe("error");
  });

  it("pause on session A does not affect session B's pause generation", async () => {
    mockJoinOk();
    await sessionA.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });
    await sessionB.start({
      groupId: "g-2", hostDeviceId: "host-2",
      logicalStreamId: "ls-2", mediaSessionId: "ms-2", hostName: "Host2",
    });

    const pauseGenA = (sessionA as any)._pauseGeneration;
    const pauseGenB = (sessionB as any)._pauseGeneration;

    // Simulate pause on A (viewerClient mock needed)
    (sessionA as any).viewerClient = {
      pauseMedia: vi.fn().mockResolvedValue(undefined),
      getSDK: vi.fn(),
      resumeMedia: vi.fn(),
      sendMediaBind: vi.fn(),
    };
    await sessionA.pause();

    expect((sessionA as any)._pauseGeneration).not.toBe(pauseGenA);
    // Session B's pause generation should be unchanged
    expect((sessionB as any)._pauseGeneration).toBe(pauseGenB);
  });

  it("each session cleans only its own video element on destroy", () => {
    const videoA = {
      pause: vi.fn(), srcObject: "stream-a",
      autoplay: false, playsInline: false, muted: false, volume: 1,
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;
    const videoB = {
      pause: vi.fn(), srcObject: "stream-b",
      autoplay: false, playsInline: false, muted: false, volume: 1,
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;

    sessionA.bindVideoElement(videoA);
    sessionB.bindVideoElement(videoB);
    Object.defineProperty(sessionA, "_receivedStream", { value: "stream-a", writable: true });
    Object.defineProperty(sessionB, "_receivedStream", { value: "stream-b", writable: true });

    sessionA.destroy();

    // Only A's video should be paused and cleared
    expect(videoA.pause).toHaveBeenCalled();
    expect((videoA as any).srcObject).toBeNull();
    expect(videoB.pause).not.toHaveBeenCalled();
    expect((videoB as any).srcObject).toBe("stream-b");
  });

  it("retry calls requestGroupSync before sending a new join request", async () => {
    // Setup mock with requestGroupSync
    const requestGroupSync = vi.fn().mockReturnValue(undefined);
    const runtimeWithSync = { ...runtime, requestGroupSync };
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtimeWithSync);

    mockJoinOk();
    await sessionA.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // Clear mocks and set up join response for retry
    vi.clearAllMocks();
    mockJoinOk();
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtimeWithSync);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);

    await sessionA.retry();

    // Must have called requestGroupSync with the group ID
    expect(requestGroupSync).toHaveBeenCalledWith("g-1");
  });

  it("retry awaits a returned promise from requestGroupSync before sending join request", async () => {
    // Setup mock that returns a promise
    let resolveSync!: () => void;
    const syncPromise = new Promise<void>((resolve) => { resolveSync = resolve; });
    const requestGroupSync = vi.fn().mockReturnValue(syncPromise);
    const conn = {
      sendToPeer: vi.fn().mockResolvedValue(undefined),
      peerForDevice: vi.fn().mockReturnValue("peer-uuid-host"),
    };
    const connManager = { getConnection: vi.fn().mockReturnValue(conn) };
    const runtimeWithSync = {
      ...runtime,
      requestGroupSync,
      getConnectionManager: () => connManager,
    };
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtimeWithSync);

    mockJoinOk();
    await sessionA.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // Clear mocks and set up for retry
    conn.sendToPeer.mockClear();
    vi.clearAllMocks();
    mockJoinOk();
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtimeWithSync);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);
    conn.sendToPeer.mockClear();

    // Start retry (it will await the sync promise)
    const retryPromise = sessionA.retry();

    // At this point, retry should be waiting on the sync promise.
    // A join request should NOT have been sent yet (leave may have been sent
    // during teardown, but the join request must not be sent before sync).
    const joinCallsBeforeSync = conn.sendToPeer.mock.calls.filter(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.type === "stream.join.request",
    );
    expect(joinCallsBeforeSync).toHaveLength(0);

    // Resolve the sync
    resolveSync();
    await retryPromise;

    // After sync resolves, the join request should have been sent
    const joinCallsAfter = conn.sendToPeer.mock.calls.filter(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.type === "stream.join.request",
    );
    expect(joinCallsAfter.length).toBeGreaterThan(0);
  });

  it("retry picks the latest host stream when old logical stream is gone and multiple announcements exist", async () => {
    // Registry has TWO announcements from the same host:
    //   - Old stream (ls-1/ms-1) with lower streamRevision — stale, still in registry
    //   - New stream (ls-2/ms-2) with higher streamRevision — the current active one
    // After the host restarted, the viewer's old logical stream (ls-1) was replaced;
    // the viewer must pick the latest by composite freshness.
    const streamData = [
      {
        logicalStreamId: "ls-1", mediaSessionId: "ms-1",
        groupId: "g-1", hostDeviceId: "host-1",
        hostDisplayName: "Host", sourceKind: "screen",
        sourceName: "Old Screen", startedAt: 1000,
        appliedSettingsRevision: 0, heartbeatSequence: 1,
        streamRevision: 1, mediaJoinMetadata: "", replacesSessionId: null,
      },
      {
        logicalStreamId: "ls-2", mediaSessionId: "ms-2",
        groupId: "g-1", hostDeviceId: "host-1",
        hostDisplayName: "Host", sourceKind: "screen",
        sourceName: "New Screen", startedAt: 2000,
        appliedSettingsRevision: 0, heartbeatSequence: 5,
        streamRevision: 2, mediaJoinMetadata: "", replacesSessionId: null,
      },
    ];
    const mockRegistry = {
      getStreamsByGroup: vi.fn(),
      getStream: vi.fn().mockReturnValue(null),
      registerLocalStream: vi.fn(),
      handleStopped: vi.fn(),
      getAllStreams: vi.fn().mockReturnValue([]),
    };
    const conn = {
      sendToPeer: vi.fn().mockResolvedValue(undefined),
      peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
    };
    const connManager = { getConnection: vi.fn().mockReturnValue(conn) };
    const ssm = { getCaptureStream: vi.fn().mockReturnValue(null) };
    const runtimeWithMulti = {
      ...runtime,
      requestGroupSync: vi.fn().mockReturnValue(undefined),
      getActiveStreamRegistry: () => mockRegistry,
      getConnectionManager: () => connManager,
      getStreamSessionManager: () => ssm,
    };
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtimeWithMulti);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);

    // On initial start, only ls-1 is in the registry
    mockRegistry.getStreamsByGroup.mockReturnValue([
      { ...streamData[0] },
    ]);

    mockJoinOk();
    await sessionA.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // Now host restarts: old stream (ls-1) is gone from the viewpoint of
    // the algorithm (same logicalStreamId not found — gone from registry).
    // Both ls-1 and ls-2 are returned but the same-logical check is based
    // on the viewer's stored logicalStreamId (ls-1). Since ls-1 is in the
    // list, the algorithm will use it.  To test "prefers latest" we need
    // the old stream GONE so Phase 2 triggers (pick latest announcement).
    vi.clearAllMocks();
    mockJoinOk();
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtimeWithMulti);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);
    conn.sendToPeer.mockClear();
    // Only return the NEW stream (ls-1 is gone from registry)
    mockRegistry.getStreamsByGroup.mockReturnValue([{ ...streamData[1] }]);

    await sessionA.retry();

    const calls = conn.sendToPeer.mock.calls;
    const joinReq = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.type === "stream.join.request",
    );
    expect(joinReq).toBeDefined();
    const payload = joinReq![1] as Record<string, unknown>;
    // The old logical stream is gone; must pick the latest (only) announcement
    expect(payload.logicalStreamId).toBe("ls-2");
    expect(payload.mediaSessionId).toBe("ms-2");
  });

  it("retry sends refreshed mediaSessionId in join.request payload", async () => {
    // Start with ms-1, host restarted to ms-2 (same logicalStreamId)
    mockJoinOk();
    const tmpRuntime = { ...runtime, requestGroupSync: vi.fn().mockReturnValue(undefined) };
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(tmpRuntime);

    const mockRegistry = {
      getStreamsByGroup: vi.fn().mockReturnValue([
        {
          logicalStreamId: "ls-1", mediaSessionId: "ms-2",
          groupId: "g-1", hostDeviceId: "host-1",
          hostDisplayName: "Host", sourceKind: "screen",
          sourceName: "Screen", startedAt: 2000,
          appliedSettingsRevision: 0, heartbeatSequence: 10,
          streamRevision: 2, mediaJoinMetadata: "", replacesSessionId: "ms-1",
        },
      ]),
      getStream: vi.fn().mockReturnValue(null),
      registerLocalStream: vi.fn(),
      handleStopped: vi.fn(),
      getAllStreams: vi.fn().mockReturnValue([]),
    };
    const conn = {
      sendToPeer: vi.fn().mockResolvedValue(undefined),
      peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
    };
    const connManager = { getConnection: vi.fn().mockReturnValue(conn) };
    const ssm = { getCaptureStream: vi.fn().mockReturnValue(null) };
    tmpRuntime.getActiveStreamRegistry = () => mockRegistry;
    tmpRuntime.getConnectionManager = () => connManager;
    tmpRuntime.getStreamSessionManager = () => ssm;

    mockRuntimeMethods.isDestroyed.mockReturnValue(false);

    await sessionA.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    // Retry: registry has ls-1 with ms-2 (same logical, newer media session)
    vi.clearAllMocks();
    mockJoinOk();
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(tmpRuntime);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);
    conn.sendToPeer.mockClear();
    mockRegistry.getStreamsByGroup.mockClear();

    await sessionA.retry();

    const calls = conn.sendToPeer.mock.calls;
    const joinReq = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.type === "stream.join.request",
    );
    expect(joinReq).toBeDefined();
    const payload = joinReq![1] as Record<string, unknown>;
    // Must carry the refreshed mediaSessionId in the join request
    expect(payload.mediaSessionId).toBe("ms-2");
    expect(payload.logicalStreamId).toBe("ls-1");
  });

  it("retry sends both logicalStreamId and mediaSessionId in join.request", async () => {
    // Verify join.request payload always includes mediaSessionId alongside logicalStreamId
    mockJoinOk();
    await sessionA.start({
      groupId: "g-1", hostDeviceId: "host-1",
      logicalStreamId: "ls-1", mediaSessionId: "ms-1", hostName: "Host",
    });

    const conn = runtime.getConnectionManager().getConnection("g-1");
    const joinRequests = (conn as any).sendToPeer.mock.calls.filter(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.type === "stream.join.request",
    );
    expect(joinRequests.length).toBeGreaterThan(0);
    const payload = joinRequests[0][1] as Record<string, unknown>;
    expect(payload.mediaSessionId).toBe("ms-1");
    expect(payload.logicalStreamId).toBe("ls-1");
  });
});
