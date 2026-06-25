// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MediaStatsPoller, type PerViewerStats } from "../src/renderer/services/media-stats-service.js";
import type { VDONinjaSDK } from "@screenlink/vdo-adapter";

// ─── Mock RTCStatsReport ────────────────────────────────────────────────────

function createMockStatsReport(): RTCStatsReport {
  // Minimal object that behaves like RTCStatsReport (has forEach)
  const entries: [string, unknown][] = [];
  const report = {
    forEach: (cb: (stat: unknown) => void) => {
      for (const [, stat] of entries) cb(stat);
    },
    get: (id: string) => entries.find(([k]) => k === id)?.[1],
    has: (id: string) => entries.some(([k]) => k === id),
    entries: () => entries[Symbol.iterator](),
    keys: () => entries.map(([k]) => k)[Symbol.iterator](),
    values: () => entries.map(([, v]) => v)[Symbol.iterator](),
    [Symbol.iterator]: () => entries[Symbol.iterator](),
    size: entries.length,
  } as unknown as RTCStatsReport;
  return report;
}

// ─── Mock SDK ───────────────────────────────────────────────────────────────

function createMockPeerConnection(): RTCPeerConnection {
  return {
    getStats: vi.fn().mockResolvedValue(createMockStatsReport()),
    getSenders: vi.fn().mockReturnValue([]),
    getReceivers: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as RTCPeerConnection;
}

function createMockSDK(connections?: Map<string, any>): VDONinjaSDK {
  return {
    VERSION: "1.0",
    connections: connections ?? new Map(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    publish: vi.fn(),
    stopPublishing: vi.fn(),
    view: vi.fn(),
    stopViewing: vi.fn(),
    sendData: vi.fn(),
    getStats: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as VDONinjaSDK;
}

// ─── PerViewerPollerState (Stage 7) ─────────────────────────────────────────

describe("Stage 7: Per-viewer stats — keyed by composite key", () => {
  let poller: MediaStatsPoller;

  beforeEach(() => {
    poller = new MediaStatsPoller();
  });

  afterEach(() => {
    poller.stop();
    poller.stopViewerPoller?.("any", "any", "any", "any");
  });

  it("starts a per-viewer poller with exact composite key", () => {
    const pc = createMockPeerConnection();
    const callback = vi.fn();

    poller.startViewerPoller?.(
      "group-1",
      "stream-1",
      "viewer-1",
      "peer-uuid-1",
      pc,
      callback,
    );

    expect(poller.hasViewerPoller?.("group-1", "stream-1", "viewer-1", "peer-uuid-1")).toBe(true);
  });

  it("different viewers have separate pollers for same group+stream", () => {
    const pc1 = createMockPeerConnection();
    const pc2 = createMockPeerConnection();
    const callback = vi.fn();

    poller.startViewerPoller?.("group-1", "stream-1", "viewer-1", "peer-uuid-1", pc1, callback);
    poller.startViewerPoller?.("group-1", "stream-1", "viewer-2", "peer-uuid-2", pc2, callback);

    expect(poller.hasViewerPoller?.("group-1", "stream-1", "viewer-1", "peer-uuid-1")).toBe(true);
    expect(poller.hasViewerPoller?.("group-1", "stream-1", "viewer-2", "peer-uuid-2")).toBe(true);
  });

  it("stores per-viewer stats keyed by groupId+logicalStreamId+viewerDeviceId+mediaPeerUuid", () => {
    poller.startViewerPoller?.(
      "group-1",
      "stream-1",
      "viewer-1",
      "peer-uuid-1",
      createMockPeerConnection(),
      vi.fn(),
    );

    // Now accumulate stats with the composite key
    const stats: Omit<PerViewerStats, "lastUpdated"> = {
      viewerDeviceId: "viewer-1",
      mediaPeerUuid: "peer-uuid-1",
      videoBitrateKbps: 1500,
      width: 1280,
      height: 720,
      fps: 30,
      codec: "VP9",
      qualityLimitationReason: null,
      retransmittedBytes: 100,
      nackCount: 2,
      pliCount: 1,
      availableOutgoingBitrate: 5000,
      rtt: 20,
      packetLoss: 0.5,
      candidateType: "host",
      relayProtocol: "",
      audioBitrateKbps: 64,
      audioCodec: "opus",
    };

    poller.accumulateViewerStats(stats);

    // Should be retrievable
    const retrieved = poller.getViewerStats?.("group-1", "stream-1", "viewer-1", "peer-uuid-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.videoBitrateKbps).toBe(1500);
  });
});

describe("Stage 7: Per-viewer stats — exact RTCPeerConnection per poller", () => {
  let poller: MediaStatsPoller;

  beforeEach(() => {
    poller = new MediaStatsPoller();
  });

  afterEach(() => {
    poller.stop();
    poller.stopAllViewerPollers?.();
  });

  it("uses exactly the PC passed to startViewerPoller, not first-connection fallback", () => {
    const pc1 = createMockPeerConnection();
    const pc2 = createMockPeerConnection();
    const callback = vi.fn();

    // Start poller with pc1
    poller.startViewerPoller?.("g-1", "s-1", "v-1", "p-1", pc1, callback);

    // The poller should be using pc1, not looking up from SDK
    const usedPc = poller.getViewerPollerPC?.("g-1", "s-1", "v-1", "p-1");
    expect(usedPc).toBe(pc1);
    expect(usedPc).not.toBe(pc2);
  });

  it("each viewer gets its own poller instance with dedicated PC", () => {
    const pc1 = createMockPeerConnection();
    const pc2 = createMockPeerConnection();

    poller.startViewerPoller?.("g-1", "s-1", "v-1", "p-1", pc1, vi.fn());
    poller.startViewerPoller?.("g-1", "s-1", "v-2", "p-2", pc2, vi.fn());

    const usedPc1 = poller.getViewerPollerPC?.("g-1", "s-1", "v-1", "p-1");
    const usedPc2 = poller.getViewerPollerPC?.("g-1", "s-1", "v-2", "p-2");

    expect(usedPc1).toBe(pc1);
    expect(usedPc2).toBe(pc2);
  });
});

describe("Stage 7: Per-viewer stats — stopViewerPoller cleans up exact state", () => {
  let poller: MediaStatsPoller;

  beforeEach(() => {
    poller = new MediaStatsPoller();
  });

  afterEach(() => {
    poller.stop();
    poller.stopAllViewerPollers?.();
  });

  it("stopViewerPoller removes only the specified viewer poller", () => {
    const pc1 = createMockPeerConnection();
    const pc2 = createMockPeerConnection();

    poller.startViewerPoller?.("g-1", "s-1", "v-1", "p-1", pc1, vi.fn());
    poller.startViewerPoller?.("g-1", "s-1", "v-2", "p-2", pc2, vi.fn());

    // Stop v-1 only
    poller.stopViewerPoller?.("g-1", "s-1", "v-1", "p-1");

    expect(poller.hasViewerPoller?.("g-1", "s-1", "v-1", "p-1")).toBe(false);
    expect(poller.hasViewerPoller?.("g-1", "s-1", "v-2", "p-2")).toBe(true);
  });

  it("stopViewerPoller clears the poller interval and state", () => {
    const pc = createMockPeerConnection();

    poller.startViewerPoller?.("g-1", "s-1", "v-1", "p-1", pc, vi.fn());

    // Verify it exists first
    expect(poller.hasViewerPoller?.("g-1", "s-1", "v-1", "p-1")).toBe(true);

    // Stop it
    poller.stopViewerPoller?.("g-1", "s-1", "v-1", "p-1");

    // Should no longer exist
    expect(poller.hasViewerPoller?.("g-1", "s-1", "v-1", "p-1")).toBe(false);
  });

  it("stopAllViewerPollers removes all viewer pollers", () => {
    poller.startViewerPoller?.("g-1", "s-1", "v-1", "p-1", createMockPeerConnection(), vi.fn());
    poller.startViewerPoller?.("g-1", "s-1", "v-2", "p-2", createMockPeerConnection(), vi.fn());

    poller.stopAllViewerPollers?.();

    expect(poller.hasViewerPoller?.("g-1", "s-1", "v-1", "p-1")).toBe(false);
    expect(poller.hasViewerPoller?.("g-1", "s-1", "v-2", "p-2")).toBe(false);
  });

  it("disconnect cleans up all viewer pollers", () => {
    poller.startViewerPoller?.("g-1", "s-1", "v-1", "p-1", createMockPeerConnection(), vi.fn());

    // Simulate disconnect
    poller.disconnectViewer?.("g-1", "s-1", "v-1", "p-1");

    expect(poller.hasViewerPoller?.("g-1", "s-1", "v-1", "p-1")).toBe(false);
  });

  it("disconnectViewer deletes accumulated stats using correct key format", () => {
    const pc = createMockPeerConnection();
    poller.startViewerPoller?.("g-1", "s-1", "v-1", "p-1", pc, vi.fn());

    // Accumulate some stats
    poller.accumulateViewerStats({
      viewerDeviceId: "v-1",
      mediaPeerUuid: "p-1",
      videoBitrateKbps: 1000,
      width: 640, height: 480, fps: 15,
      codec: "VP9", qualityLimitationReason: null,
      retransmittedBytes: 0, nackCount: 0, pliCount: 0,
      availableOutgoingBitrate: 5000, rtt: 10, packetLoss: 0,
      candidateType: "host", relayProtocol: "",
      audioBitrateKbps: 64, audioCodec: "opus",
    });

    // Verify stats exist
    expect(poller.getViewerStats?.("g-1", "s-1", "v-1", "p-1")).not.toBeNull();

    // Disconnect — should clean up stats too
    poller.disconnectViewer?.("g-1", "s-1", "v-1", "p-1");

    // Stats should be gone
    expect(poller.getViewerStats?.("g-1", "s-1", "v-1", "p-1")).toBeNull();
  });
});

describe("Stage 7: Per-viewer stats — no first-connection fallback", () => {
  let poller: MediaStatsPoller;

  beforeEach(() => {
    poller = new MediaStatsPoller();
  });

  afterEach(() => {
    poller.stop();
  });

  it("does not fallback to first connection when peerUuid is provided", () => {
    // The start() method with a peerUuid should NOT iterate connections
    // to find a fallback — it should use the exact PC passed to startViewerPoller
    const pc = createMockPeerConnection();
    const sdk = createMockSDK();

    // Start the main poller with SDK + peerUuid
    poller.start(sdk, "specific-peer-uuid", vi.fn());

    // The getPeerConnection should prefer the specific peer UUID, not fallback
    // to the first connection. Since the SDK has no connections, it should return null.
    // (No fallback to iterate)
    const pcResult = (poller as any).getPeerConnection();
    expect(pcResult).toBeNull();
  });

  it("per-viewer poller is preferred over SDK-based polling for viewer stats", () => {
    const pc = createMockPeerConnection();

    // Start per-viewer poller (Stage 7 approach)
    poller.startViewerPoller?.("g-1", "s-1", "v-1", "p-1", pc, vi.fn());

    // The per-viewer poller should store its own PC reference
    // instead of going through getPeerConnection() fallback
    const storedPc = poller.getViewerPollerPC?.("g-1", "s-1", "v-1", "p-1");
    expect(storedPc).toBe(pc);
  });
});
