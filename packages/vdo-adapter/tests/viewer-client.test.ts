// @vitest-environment node
/**
 * Tests for ViewerClient — data channel open tracking and per-UUID waiter state.
 *
 * Covers:
 * - EventTarget detail.uuid path (SDK 1.3.18 standard)
 * - Direct string UUID fallback
 * - Per-UUID waiters do not race across peer UUIDs
 * - Immediate resolution for already-opened channels
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
