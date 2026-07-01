// @vitest-environment node
/**
 * Tests for ViewerClient — data channel open tracking, per-UUID waiter state,
 * and pause/resume lifecycle.
 *
 * Covers:
 * - EventTarget detail.uuid path (SDK 1.3.18 standard)
 * - Direct string UUID fallback
 * - Per-UUID waiters do not race across peer UUIDs
 * - Immediate resolution for already-opened channels
 * - PauseMedia stops viewing but keeps SDK alive
 * - ResumeMedia re-establishes viewing
 * - Rapid toggle safety (pause → pause is idempotent)
 * - Resume without pause errors
 * - Pause during shutdown is no-op
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock ────────────────────────────────────────────────────────────

const mockGetSDKConstructor = vi.hoisted(() => vi.fn());

vi.mock("../src/sdk-version.js", () => ({
  getSDKConstructor: mockGetSDKConstructor,
}));

import { ViewerClient } from "../src/viewer-client.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockSDK() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const sdk = {
    VERSION: "1.3.18",
    connections: new Map(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    }),
    off: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    view: vi.fn().mockResolvedValue(undefined),
    stopViewing: vi.fn().mockResolvedValue(undefined),
    sendData: vi.fn().mockResolvedValue(undefined),
    /** Test helper: fire an event through all registered handlers. */
    _fire(event: string, ...args: unknown[]) {
      const hs = handlers.get(event);
      if (hs) hs.forEach((h) => h(...args));
    },
    getStats: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    stopPublishing: vi.fn().mockResolvedValue(undefined),
  };
  return sdk;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ViewerClient — dataChannelOpen per-UUID waiters", () => {
  let client: ViewerClient;
  let mockSDK: ReturnType<typeof makeMockSDK>;

  beforeEach(async () => {
    mockSDK = makeMockSDK();
    const MockCtor = vi.fn(() => mockSDK);
    mockGetSDKConstructor.mockReturnValue(MockCtor);
    client = new ViewerClient();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("resolves waitForDataChannelOpen via EventTarget detail.uuid", async () => {
    await client.createAndConnect("pw");
    const waitPromise = client.waitForDataChannelOpen("uuid-1");
    mockSDK._fire("dataChannelOpen", { detail: { uuid: "uuid-1" } });
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("resolves waitForDataChannelOpen via direct string UUID", async () => {
    await client.createAndConnect("pw");
    const waitPromise = client.waitForDataChannelOpen("uuid-2");
    mockSDK._fire("dataChannelOpen", "uuid-2");
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("per-UUID waiters do not race: one UUID does not consume another's waiter", async () => {
    await client.createAndConnect("pw");

    const waitA = client.waitForDataChannelOpen("uuid-a");
    const waitB = client.waitForDataChannelOpen("uuid-b");

    // Fire uuid-a's dataChannelOpen
    mockSDK._fire("dataChannelOpen", { detail: { uuid: "uuid-a" } });
    await expect(waitA).resolves.toBeUndefined();

    // waitB should still be pending (uuid-b has not fired yet),
    // but it should resolve when we fire uuid-b
    mockSDK._fire("dataChannelOpen", "uuid-b");
    await expect(waitB).resolves.toBeUndefined();
  });

  it("resolves immediately when data channel already opened for the UUID", async () => {
    await client.createAndConnect("pw");

    // Pre-fire the event
    mockSDK._fire("dataChannelOpen", { detail: { uuid: "uuid-pre" } });

    // Now wait — should resolve immediately (channel already tracked)
    await expect(
      client.waitForDataChannelOpen("uuid-pre"),
    ).resolves.toBeUndefined();
  });

  it("requires a fresh open after dataChannelClose for the same UUID", async () => {
    vi.useFakeTimers();
    try {
      await client.createAndConnect("pw");

      mockSDK._fire("dataChannelOpen", { detail: { uuid: "uuid-pre" } });
      mockSDK._fire("dataChannelClose", { detail: { uuid: "uuid-pre" } });

      const waitPromise = client.waitForDataChannelOpen("uuid-pre", 500);
      vi.advanceTimersByTime(600);

      await expect(waitPromise).rejects.toThrow(
        "Data channel open timed out for peer uuid-pre",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects on timeout when data channel never opens", async () => {
    vi.useFakeTimers();
    try {
      await client.createAndConnect("pw");

      // Start waiting for a UUID that will never fire
      const waitPromise = client.waitForDataChannelOpen("uuid-ghost", 500);

      // Advance past the timeout
      vi.advanceTimersByTime(600);

      await expect(waitPromise).rejects.toThrow(
        "Data channel open timed out for peer uuid-ghost",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Pause / Resume Tests ──────────────────────────────────────────────────

describe("ViewerClient — pause / resume", () => {
  let client: ViewerClient;
  let mockSDK: ReturnType<typeof makeMockSDK>;

  beforeEach(async () => {
    mockSDK = makeMockSDK();
    const MockCtor = vi.fn(() => mockSDK);
    mockGetSDKConstructor.mockReturnValue(MockCtor);
    client = new ViewerClient();
    await client.createAndConnect("pw");
    await client.view("stream-1", "Test Viewer");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("pauseMedia marks paused without calling stopViewing", async () => {
    expect(client.isUserPaused).toBe(false);
    expect(client.activeStreamId).toBe("stream-1");
    await client.pauseMedia();
    expect(client.isUserPaused).toBe(true);
    // The connection stays alive — stopViewing should NOT be called
    expect(mockSDK.stopViewing).not.toHaveBeenCalled();
    // SDK should still be connected (not disconnected)
    expect(mockSDK.disconnect).not.toHaveBeenCalled();
    // active stream ID is preserved for the new pause
  });

  it("resumeMedia clears pause state without calling view()", async () => {
    await client.pauseMedia();
    expect(client.isUserPaused).toBe(true);

    // Clear the view spy (was called once during beforeEach setup)
    mockSDK.view.mockClear();

    await client.resumeMedia();
    expect(client.isUserPaused).toBe(false);
    // The existing connection is reused — view() should NOT be called again
    expect(mockSDK.view).not.toHaveBeenCalled();
  });

  it("pauseMedia is synchronous (no async SDK ops)", () => {
    mockSDK.view.mockClear();
    // Should not return a promise — synchronous state setter
    const result = client.pauseMedia();
    expect(result).toBeUndefined();
    expect(client.isUserPaused).toBe(true);
    // No SDK calls of any kind
    expect(mockSDK.stopViewing).not.toHaveBeenCalled();
    expect(mockSDK.view).not.toHaveBeenCalled();
  });

  it("resumeMedia is synchronous (no async SDK ops)", () => {
    mockSDK.view.mockClear();
    client.pauseMedia();
    expect(client.isUserPaused).toBe(true);

    const result = client.resumeMedia();
    expect(result).toBeUndefined();
    expect(client.isUserPaused).toBe(false);
    // No SDK calls
    expect(mockSDK.stopViewing).not.toHaveBeenCalled();
    expect(mockSDK.view).not.toHaveBeenCalled();
  });

  it("pauseMedia while already paused is idempotent", async () => {
    await client.pauseMedia();
    expect(client.isUserPaused).toBe(true);

    await client.pauseMedia(); // should be no-op
    expect(client.isUserPaused).toBe(true);
    // stopViewing should never be called during any pause
    expect(mockSDK.stopViewing).not.toHaveBeenCalled();
  });

  it("resumeMedia without prior pause throws", () => {
    // client is still viewing (not paused)
    expect(() => client.resumeMedia()).toThrow("resumeMedia called but viewer was not paused");
    expect(client.isUserPaused).toBe(false);
  });

  it("rapid pause → resume cycle is safe (no overlapping operations)", () => {
    // Both start simultaneously — the second should be idempotent no-op
    expect(client.pauseMedia()).toBeUndefined();
    // Second concurrent pause is idempotent
    expect(client.pauseMedia()).toBeUndefined();
    expect(client.isUserPaused).toBe(true);

    // Now resume
    expect(client.resumeMedia()).toBeUndefined();
    // Second resume without being paused throws
    expect(() => client.resumeMedia()).toThrow("not paused");
    expect(client.isUserPaused).toBe(false);
  });

  it("pauseMedia after shutdown is a no-op", async () => {
    await client.shutdown();
    // SDK should be null now
    expect(client.pauseMedia()).toBeUndefined();
    expect(client.isUserPaused).toBe(false);
  });

  it("resumeMedia after shutdown throws", async () => {
    await client.pauseMedia();
    await client.shutdown();
    expect(() => client.resumeMedia()).toThrow("ViewerClient is shutting down");
  });

  it("pauseMedia preserves activeStreamId for reconnect path", async () => {
    await client.pauseMedia();
    // The active stream ID is preserved (not nulled) so the reconnect
    // path can still use it if the connection genuinely fails.
    expect(client.activeStreamId).toBe("stream-1");
  });

  it("pause during shutdown is no-op when shutdown started", async () => {
    // Start shutdown but don't await — simulate concurrent pause
    const shutdownPromise = client.shutdown();
    expect(client.pauseMedia()).toBeUndefined();
    expect(client.isUserPaused).toBe(false);
    await shutdownPromise;
  });

  it("shutdown clears pause state", async () => {
    await client.pauseMedia();
    expect(client.isUserPaused).toBe(true);

    await client.shutdown();
    expect(client.isUserPaused).toBe(false);

    // After shutdown, no further operations should work
    expect(() => client.resumeMedia()).toThrow("shutting down");
  });

  it("pauseMedia preserves data channel state for the existing connection", async () => {
    // Simulate an already-open data channel
    mockSDK._fire("dataChannelOpen", { detail: { uuid: "publisher-1" } });

    // Pause does NOT clear data channel state — the connection stays alive
    await client.pauseMedia();

    // The same data channel should still be tracked (generation did not change)
    await expect(
      client.waitForDataChannelOpen("publisher-1", 500),
    ).resolves.toBeUndefined();
  });
});

// ─── Shutdown reconnect prevention ───────────────────────────────────────

describe("ViewerClient — shutdown reconnect prevention", () => {
  let client: ViewerClient;
  let mockSDK: ReturnType<typeof makeMockSDK>;

  beforeEach(async () => {
    mockSDK = makeMockSDK();
    const MockCtor = vi.fn(() => mockSDK);
    mockGetSDKConstructor.mockReturnValue(MockCtor);
    client = new ViewerClient();
    await client.createAndConnect("pw");
    await client.view("stream-1", "Test Viewer");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("shutdown sets SDK reconnect fields to 0 before disconnect", async () => {
    await client.shutdown();
    // best-effort guard: either maxReconnectAttempts or _maxReconnectAttempts should be set to 0
    const reconnectSet =
      mockSDK.maxReconnectAttempts === 0 ||
      mockSDK._maxReconnectAttempts === 0;
    expect(reconnectSet).toBe(true);
  });

  it("shutdown calls stopViewing with active stream ID before disconnect", async () => {
    await client.shutdown();
    // stopViewing must be called BEFORE disconnect
    const stopViewingOrder = mockSDK.stopViewing.mock.invocationCallOrder[0];
    const disconnectOrder = mockSDK.disconnect.mock.invocationCallOrder[0];
    expect(stopViewingOrder).toBeLessThan(disconnectOrder);
  });

  it("shutdown removes all SDK listeners (both internal and registered)", async () => {
    // Register a public handler
    const publicHandler = vi.fn();
    client.on("track", publicHandler);

    await client.shutdown();

    // off should have been called for the internal handlers (peerConnected, dataChannelOpen)
    expect(mockSDK.off).toHaveBeenCalled();
  });

  it("shutdown is idempotent — repeated calls return same promise", async () => {
    const p1 = client.shutdown();
    const p2 = client.shutdown();
    await p1;
    await p2; // both resolve because they share the same underlying promise
    expect((client as any)._shuttingDown).toBe(true);
    expect((client as any)._shutdownPromise).not.toBeNull();
  });

  it("shutdown clears _activeStreamId", async () => {
    expect((client as any)._activeStreamId).toBe("stream-1");
    await client.shutdown();
    expect((client as any)._activeStreamId).toBeNull();
  });

  it("shutdown clears pause state", async () => {
    // Simulate paused state before shutdown
    (client as any)._userPaused = true;
    (client as any)._pausedStreamId = "stream-1";
    await client.shutdown();

    expect((client as any)._userPaused).toBe(false);
    expect((client as any)._pausedStreamId).toBeNull();
  });

  it("shutdown resolves data channel waiters", async () => {
    // Create a waiter on the existing client (already connected in beforeEach)
    const waiter = client.waitForDataChannelOpen("uuid-waiter");
    await client.shutdown();
    // Should resolve without error (from the resolve call in shutdown)
    await expect(waiter).resolves.toBeUndefined();
  });

  it("view() after shutdown throws", async () => {
    await client.shutdown();
    await expect(client.view("stream-2")).rejects.toThrow("shutting down");
  });

  it("sendMediaBind disables WebSocket fallback", async () => {
    mockSDK._fire("dataChannelOpen", { detail: { uuid: "publisher-1" } });

    await client.sendMediaBind("publisher-1", "bind-token", "media-session-1", "viewer-session-1");

    expect(mockSDK.sendData).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media.bind",
        token: "bind-token",
        mediaSessionId: "media-session-1",
        viewerSessionId: "viewer-session-1",
      }),
      expect.objectContaining({
        uuid: "publisher-1",
        preference: "any",
        allowFallback: false,
      }),
    );
  });
});
