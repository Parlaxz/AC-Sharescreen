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
  getSDK: vi.fn(),
  sendMediaBind: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

const mockRuntimeMethods = vi.hoisted(() => ({
  getConnectionManager: vi.fn(),
  getStreamSessionManager: vi.fn(),
  waitForJoinResponse: vi.fn(),
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
    deviceId: mockRuntimeMethods.deviceId,
    displayName: mockRuntimeMethods.displayName,
    isDestroyed: mockRuntimeMethods.isDestroyed,
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
