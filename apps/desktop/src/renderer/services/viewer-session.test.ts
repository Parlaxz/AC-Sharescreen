import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ─── Mock Modules ──────────────────────────────────────────────────────────

// Shared mutable references so tests can configure mock behavior per-case.
let mockViewClient: ReturnType<typeof createMockViewClient>;
let mockRuntime: ReturnType<typeof createMockRuntime>;

function createMockViewClient() {
  const eventHandlers: Record<string, Set<(...args: unknown[]) => void>> = {};
  return {
    createAndConnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    view: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getSDK: vi.fn().mockReturnValue(null),
    sendMediaBind: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    pauseMedia: vi.fn(),
    resumeMedia: vi.fn(),
    on: vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        if (!eventHandlers[event]) eventHandlers[event] = new Set();
        eventHandlers[event].add(handler);
      },
    ),
    off: vi.fn(),
    get isShuttingDown() {
      return false;
    },
    get activeStreamId() {
      return null;
    },
    // Test seam: fire a synthetic SDK event as if from the real SDK
    __fireEvent(event: string, detail: unknown) {
      const handlers = eventHandlers[event];
      if (handlers) {
        for (const h of handlers) h({ detail });
      }
    },
  } as const;
}

function createMockRuntime() {
  return {
    isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
    deviceId: "test-device",
    displayName: "Test Viewer",
    getConnectionManager: vi.fn().mockReturnValue({
      getConnection: vi.fn().mockReturnValue({
        peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
        sendToPeer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      }),
    }),
    waitForJoinResponse: vi.fn().mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "media-session-1",
      streamId: "stream-1",
      password: "vdo-password",
    }),
    cancelJoinResponse: vi.fn(),
    requestGroupSync: vi.fn().mockResolvedValue({ status: "dispatched" }),
    getActiveStreamRegistry: vi.fn().mockReturnValue({
      getStreamsByGroup: vi.fn().mockReturnValue([]),
    }),
  };
}

vi.mock("@screenlink/vdo-adapter", () => ({
  ViewerClient: vi.fn(),
}));

vi.mock("./phase3-runtime.js", () => ({
  getRuntime: vi.fn(),
}));

vi.mock("./sdk-event-normalizer.js", () => ({
  extractTrackEvent: vi.fn(
    (event: { detail: Record<string, unknown> }) => {
      const detail = event.detail;
      if (
        detail &&
        typeof detail === "object" &&
        "track" in detail &&
        detail.track &&
        typeof detail.track === "object" &&
        "kind" in (detail.track as object)
      ) {
        return {
          valid: true,
          track: detail.track as MediaStreamTrack,
          streams: (detail.streams as unknown[]) ?? [],
          uuid: null,
        };
      }
      return { valid: false, track: null, streams: [], uuid: null };
    },
  ),
}));

vi.mock("./stream-metrics-service.js", () => ({
  StreamMetricsService: {
    getInstance: vi.fn().mockReturnValue({
      findHistoryIdByMediaSessionId: vi.fn().mockReturnValue(null),
      getSnapshot: vi.fn().mockReturnValue({ connections: [] }),
    }),
  },
}));

import { ViewerSession } from "./viewer-session.js";
import { getRuntime } from "./phase3-runtime.js";
import { ViewerClient } from "@screenlink/vdo-adapter";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockVideoTrack(): MediaStreamTrack {
  return {
    kind: "video",
    id: `track-${Math.random().toString(36).slice(2, 8)}`,
    enabled: true,
    readyState: "live" as MediaStreamTrackState,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    clone: vi.fn(),
    stop: vi.fn(),
    applyConstraints: vi.fn(),
    getCapabilities: vi.fn().mockReturnValue({}),
    getConstraints: vi.fn().mockReturnValue({}),
    getSettings: vi.fn().mockReturnValue({}),
    contentHint: "",
    label: "test-video",
    muted: false,
    onended: null,
    onmute: null,
    onunmute: null,
  } as unknown as MediaStreamTrack;
}

function fireTrackEvent(track: MediaStreamTrack): void {
  mockViewClient.__fireEvent("trackAdded", {
    track,
    uuid: "test-uuid",
    streamID: "stream-1",
    streams: [],
  });
}

const defaultOptions = {
  groupId: "group-1",
  hostDeviceId: "host-1",
  logicalStreamId: "stream-1",
  mediaSessionId: "media-session-1",
  hostName: "Test Host",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ViewerSession", () => {
  let session: ViewerSession;

  beforeEach(() => {
    mockViewClient = createMockViewClient();
    mockRuntime = createMockRuntime();

    vi.mocked(ViewerClient).mockImplementation(() => mockViewClient as any);
    vi.mocked(getRuntime).mockReturnValue(mockRuntime as any);
  });

  afterEach(async () => {
    // Clean up any session resources
    try {
      await session?.destroy();
    } catch {
      // Best-effort
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Happy path ─────────────────────────────────────────────────────────

  it("transitions through join flow and reaches watching when a video track arrives", async () => {
    session = new ViewerSession();
    const states: string[] = [];
    session.onStateChange = (s) => states.push(s);

    // start() completes the join flow — view resolves, media.bind is sent.
    // Without a video track, state stays at "connecting-media".
    await session.start(defaultOptions);

    expect(states[0]).toBe("requesting-join");
    expect(states).toContain("connecting-media");
    expect(session.state).toBe("connecting-media");

    // Now fire a video track event as the SDK would
    const track = createMockVideoTrack();
    fireTrackEvent(track);

    // handleTrackEvent transitions to "watching"
    expect(session.state).toBe("watching");
    expect(states).toContain("watching");

    // Verify viewerClient was created and view() was called
    expect(ViewerClient).toHaveBeenCalledTimes(1);
    expect(mockViewClient.createAndConnect).toHaveBeenCalledWith("vdo-password");
    expect(mockViewClient.view).toHaveBeenCalledWith("stream-1", "Test Viewer");
  });

  it("handles view rejecting immediately as a non-timeout error", async () => {
    session = new ViewerSession();
    const error = new Error("stream not found");
    mockViewClient.view.mockRejectedValue(error);

    await session.start(defaultOptions);

    expect(session.state).toBe("error");
    // Should NOT have auto-retried (this is not a connect failure).
    // Flush the event loop so the fire-and-forget teardown (now raced
    // against a bounded budget) has settled before asserting side effects.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockViewClient.shutdown).toHaveBeenCalledTimes(1);
    expect(mockViewClient.view).toHaveBeenCalledTimes(1);
  });

  // ─── View timeout → auto-retry → resolved on second attempt ────────────

  it("times out a never-resolving view(), auto-retries, and succeeds on second attempt", async () => {
    vi.useFakeTimers();

    session = new ViewerSession();
    const states: string[] = [];
    session.onStateChange = (s) => states.push(s);

    // First call to view() hangs forever; subsequent calls resolve
    let viewCallCount = 0;
    mockViewClient.view.mockImplementation(() => {
      viewCallCount++;
      if (viewCallCount === 1) {
        return new Promise<void>(() => {}); // never resolves
      }
      return Promise.resolve();
    });

    const startPromise = session.start(defaultOptions);

    // Advance past the 30s view timeout — the first attempt times out and
    // triggers the auto-retry path.  The auto-retry tears down, runs a fresh
    // runJoinFlow, and the second view() call resolves immediately.
    await vi.advanceTimersByTimeAsync(30_000);

    // After the retry the second runJoinFlow completed successfully.
    // State is "connecting-media" waiting for a video track.
    // Fire a track event to complete the transition.
    const track = createMockVideoTrack();
    fireTrackEvent(track);

    await startPromise;

    // Should have attempted view() twice, once per runJoinFlow
    expect(viewCallCount).toBe(2);

    // Session recovered and is watching
    expect(session.state).toBe("watching");
    expect(states).toContain("watching");
    // Auto-retry triggered teardown + second attempt
    expect(states.filter((s) => s === "connecting-media").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  // ─── View timeout + exhausted retry budget → error ─────────────────────

  it("times out twice and ends in error when view() never resolves", async () => {
    vi.useFakeTimers();

    session = new ViewerSession();
    const states: string[] = [];
    session.onStateChange = (s) => states.push(s);
    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    // view() never resolves on any attempt
    mockViewClient.view.mockReturnValue(new Promise<void>(() => {}));

    const startPromise = session.start(defaultOptions);

    // First timeout → auto-retry triggers
    await vi.advanceTimersByTimeAsync(30_000);

    // Second runJoinFlow is now pending on view again with a fresh 30s timer.
    // Advance again to trigger the final timeout.
    await vi.advanceTimersByTimeAsync(30_000);

    await startPromise;

    // After two timeouts, the second attempt falls through to setError
    expect(session.state).toBe("error");
    // The error should mention the view timeout
    expect(errors[0]).toContain("view timed out");

    // ViewerClient.shutdown was called during auto-retry teardown
    expect(mockViewClient.shutdown).toHaveBeenCalled();
  });

  // ─── Total media.bind failure → fail fast into error/retry ─────────────

  it("fails fast into error/retry when every media.bind attempt fails", async () => {
    session = new ViewerSession();
    const states: string[] = [];
    const errors: string[] = [];
    session.onStateChange = (s) => states.push(s);
    session.onError = (e) => errors.push(e);

    // One publisher peer; every bind send throws.
    mockViewClient.getSDK.mockReturnValue({
      connections: new Map([["publisher-uuid-1", {}]]),
    });
    mockViewClient.sendMediaBind.mockRejectedValue(new Error("sendData failed"));

    await session.start(defaultOptions);

    // "media-bind-failed" is classified as a connect failure, so the first
    // attempt auto-retries; the second attempt fails the same way and the
    // session lands in "error" — without ever waiting for the 15s readiness
    // timeout in "connecting-media".
    expect(mockViewClient.sendMediaBind).toHaveBeenCalledTimes(2);
    expect(mockViewClient.shutdown).toHaveBeenCalled(); // teardown ran on retry
    expect(session.state).toBe("error");
    expect(errors[0]).toContain("media-bind-failed");
  });

  it("keeps current behavior when at least one media.bind succeeds", async () => {
    session = new ViewerSession();
    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    // Two publishers: one bind succeeds, one throws → partial success.
    mockViewClient.getSDK.mockReturnValue({
      connections: new Map([
        ["publisher-ok", {}],
        ["publisher-bad", {}],
      ]),
    });
    mockViewClient.sendMediaBind.mockImplementation(async (uuid: string) => {
      if (uuid === "publisher-bad") throw new Error("sendData failed");
    });

    await session.start(defaultOptions);

    // Partial success must NOT trigger the fail-fast path — the session
    // stays in "connecting-media" waiting for media as before.
    expect(mockViewClient.sendMediaBind).toHaveBeenCalledTimes(2);
    expect(mockViewClient.sendMediaBind).toHaveBeenCalledWith(
      "publisher-ok",
      "test-token",
      "media-session-1",
      expect.any(String),
    );
    expect(session.state).toBe("connecting-media");
    expect(errors).toHaveLength(0);
  });

  // ─── Join-request retransmission on lost response ──────────────────────

  it("retransmits stream.join.request twice (3 sends total) when no join response arrives", async () => {
    vi.useFakeTimers();

    session = new ViewerSession();
    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    // Join response never arrives — the runtime waiter rejects at its own
    // 30s deadline, mirroring the real GroupMessageRouter behavior.
    mockRuntime.waitForJoinResponse.mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Join response timeout")), 30_000),
        ),
    );

    const startPromise = session.start(defaultOptions);

    // Advance past both retransmit points (8s and 16s)
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(8_000);

    const conn = mockRuntime.getConnectionManager().getConnection("group-1");
    const sendToPeer = conn.sendToPeer as ReturnType<typeof vi.fn>;
    const joinSends = sendToPeer.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>).type === "stream.join.request",
    );

    // Exactly 3 sends: initial + 2 retransmits, same envelope/generation.
    expect(joinSends).toHaveLength(3);
    const requestIds = new Set(
      joinSends.map((c) => (c[1] as Record<string, unknown>).requestId),
    );
    expect(requestIds.size).toBe(1);

    // Advance past the 30s join-response deadline → single attempt fails
    // into error (join timeouts are not connect failures, no auto-retry).
    await vi.advanceTimersByTimeAsync(14_000);
    await startPromise;

    expect(session.state).toBe("error");
    expect(errors[0]).toContain("Join response timeout");

    // No further retransmits fire after the attempt ended.
    await vi.advanceTimersByTimeAsync(20_000);
    const joinSendsAfter = (sendToPeer.mock.calls as Array<[string, Record<string, unknown>]>).filter(
      (c) => c[1].type === "stream.join.request",
    );
    expect(joinSendsAfter).toHaveLength(3);
  });
});
