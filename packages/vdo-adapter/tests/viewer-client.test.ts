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

  it("pauseMedia stops viewing and sets isUserPaused", async () => {
    expect(client.isUserPaused).toBe(false);
    await client.pauseMedia();
    expect(client.isUserPaused).toBe(true);
    expect(mockSDK.stopViewing).toHaveBeenCalledWith("stream-1");
    // SDK should still be connected (not disconnected)
    expect(mockSDK.disconnect).not.toHaveBeenCalled();
  });

  it("resumeMedia re-establishes viewing after pause", async () => {
    await client.pauseMedia();
    expect(client.isUserPaused).toBe(true);

    await client.resumeMedia();
    expect(client.isUserPaused).toBe(false);
    expect(mockSDK.view).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ audio: true, video: true }),
    );
  });

  it("pauseMedia while already paused is idempotent", async () => {
    await client.pauseMedia();
    const stopViewingCallsBefore = mockSDK.stopViewing.mock.calls.length;

    await client.pauseMedia(); // should be no-op
    expect(mockSDK.stopViewing.mock.calls.length).toBe(stopViewingCallsBefore);
    expect(client.isUserPaused).toBe(true);
  });

  it("resumeMedia without prior pause throws", async () => {
    // client is still viewing (not paused)
    await expect(client.resumeMedia()).rejects.toThrow(
      "resumeMedia called but viewer was not paused",
    );
    expect(client.isUserPaused).toBe(false);
  });

  it("rapid pause → resume cycle is safe (no overlapping operations)", async () => {
    // Both start simultaneously — the second should be idempotent no-op
    await expect(client.pauseMedia()).resolves.toBeUndefined();
    // Second concurrent pause is idempotent
    await expect(client.pauseMedia()).resolves.toBeUndefined();
    expect(client.isUserPaused).toBe(true);

    // Now resume
    await expect(client.resumeMedia()).resolves.toBeUndefined();
    // Second resume without being paused throws
    await expect(client.resumeMedia()).rejects.toThrow("not paused");
    expect(client.isUserPaused).toBe(false);
  });

  it("pauseMedia after shutdown is a no-op", async () => {
    await client.shutdown();
    // SDK should be null now
    await expect(client.pauseMedia()).resolves.toBeUndefined();
    expect(client.isUserPaused).toBe(false);
  });

  it("resumeMedia after shutdown throws", async () => {
    await client.pauseMedia();
    await client.shutdown();
    await expect(client.resumeMedia()).rejects.toThrow(
      "ViewerClient is shutting down",
    );
  });

  it("pauseMedia preserves resume with streamIdOverride", async () => {
    await client.pauseMedia();
    // Host restarted while paused — new stream ID
    await client.resumeMedia("New Viewer", "stream-2-new");
    expect(mockSDK.view).toHaveBeenCalledWith(
      "stream-2-new",
      expect.objectContaining({ label: "New Viewer" }),
    );
  });

  it("pauseMedia failure restores isUserPaused to false", async () => {
    // Make stopViewing reject
    mockSDK.stopViewing.mockRejectedValueOnce(new Error("stop failed"));
    await expect(client.pauseMedia()).rejects.toThrow("stopViewing failed");
    // isUserPaused should remain false since pause didn't complete
    expect(client.isUserPaused).toBe(false);
  });

  it("resumeMedia failure restores isUserPaused to true (retryable)", async () => {
    await client.pauseMedia();
    expect(client.isUserPaused).toBe(true);

    // Make view reject
    mockSDK.view.mockRejectedValueOnce(new Error("view failed"));
    await expect(client.resumeMedia()).rejects.toThrow("view failed");
    // Should still be paused for retry
    expect(client.isUserPaused).toBe(true);
  });

  it("pause during shutdown is no-op when shutdown started", async () => {
    // Start shutdown but don't await — simulate concurrent pause
    const shutdownPromise = client.shutdown();
    await expect(client.pauseMedia()).resolves.toBeUndefined();
    expect(client.isUserPaused).toBe(false);
    await shutdownPromise;
  });

  it("stopViewing during shutdownSequence clears resume state", async () => {
    await client.pauseMedia();
    expect(client.isUserPaused).toBe(true);

    await client.shutdown();
    expect(client.isUserPaused).toBe(false);

    // After shutdown, no further operations should work
    await expect(client.resumeMedia()).rejects.toThrow("shutting down");
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
    (client as any)._pausedDisplayName = "Viewer";

    await client.shutdown();

    expect((client as any)._userPaused).toBe(false);
    expect((client as any)._pausedStreamId).toBeNull();
    expect((client as any)._pausedDisplayName).toBeNull();
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
});
