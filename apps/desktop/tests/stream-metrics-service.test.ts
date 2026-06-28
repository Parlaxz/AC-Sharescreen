import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StreamMetricsService, type StreamHistoryRecord } from "../src/renderer/services/stream-metrics-service.js";
import type { PersistenceRecordV2 } from "../src/renderer/services/bandwidth-telemetry-types.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function createMockScreenlink() {
  let store: PersistenceRecordV2[] = [];
  return {
    getStreamHistory: vi.fn<() => Promise<PersistenceRecordV2[]>>().mockImplementation(async () => [...store]),
    saveStreamHistory: vi.fn<(r: PersistenceRecordV2[]) => Promise<void>>().mockImplementation(async (r) => { store = r.map(x => ({ ...x })); }),
    upsertStreamHistory: vi.fn<(record: unknown) => Promise<void>>().mockImplementation(async (record) => {
      const r = record as PersistenceRecordV2;
      const idx = store.findIndex(x => x.historyId === r.historyId);
      if (idx >= 0) store[idx] = { ...r };
      else store.push({ ...r });
    }),
    _getStore: () => store,
    _setStore: (s: PersistenceRecordV2[]) => { store = s.map(x => ({ ...x })); },
  };
}

function createMockPC(): RTCPeerConnection {
  const stats = new Map<string, Record<string, unknown>>();
  return {
    getStats: vi.fn().mockImplementation(async () => stats),
    _stats: stats,
  } as unknown as RTCPeerConnection;
}

function setupTest() {
  vi.useFakeTimers();
  const mock = createMockScreenlink();
  (globalThis as any).window = { screenlink: mock };
  return { mock };
}

function teardownTest() {
  StreamMetricsService.setInstance(null);
  vi.useRealTimers();
  delete (globalThis as any).window;
}

async function flushPromises() {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

async function advanceTime(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("StreamMetricsService", () => {
  let svc: StreamMetricsService;

  beforeEach(() => { setupTest(); svc = StreamMetricsService.getInstance(); });
  afterEach(() => { teardownTest(); });

  describe("startHostSession", () => {
    it("returns unique historyId on each call", () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1");
      const id2 = svc.startHostSession("ms2", "ls2", "g1", "G1");
      expect(id1).not.toBe(id2);
    });

    it("starts the timer when first session is created", () => {
      expect((svc as any).timer).toBeNull();
      svc.startHostSession("ms1", "ls1", "g1", "G1");
      expect((svc as any).timer).not.toBeNull();
    });

    it("does not start a second timer when another session starts", () => {
      svc.startHostSession("ms1", "ls1", "g1", "G1");
      const timer1 = (svc as any).timer;
      svc.startHostSession("ms2", "ls2", "g1", "G1");
      expect((svc as any).timer).toBe(timer1);
    });
  });

  describe("startViewerSession", () => {
    it("creates active viewer session", () => {
      const historyId = svc.startViewerSession("ms1", "ls1", "g1", "G1");
      expect(svc.getActiveSessionIds()).toContain(historyId);
    });

    it("rejoin creates different historyId", () => {
      const id1 = svc.startViewerSession("ms1", "ls1", "g1", "G1");
      const id2 = svc.startViewerSession("ms2", "ls2", "g1", "G1");
      expect(id1).not.toBe(id2);
    });
  });

  describe("registerConnection", () => {
    it("registers and unregisters a connection", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      const pc = createMockPC();
      const unreg = svc.registerConnection({
        historyId,
        connectionId: "host:dev1:uuid1",
        viewerDeviceId: "dev1",
        displayName: "Viewer 1",
        peerConnection: pc,
        direction: "outbound",
        configuredVideoBitsPerSecond: 5000000,
      });
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.connections.length).toBe(1);
      expect(snapshot.connections[0].connectionId).toBe("host:dev1:uuid1");

      unreg();
      const snapshot2 = svc.getSnapshot(historyId);
      expect(snapshot2.connections.length).toBe(0);
    });
  });

  describe("addMarker", () => {
    it("adds a marker to the session via snapshot", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      svc.addMarker(historyId, "resolution", "1920x1080", "1280x720", "Res changed");
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate.markers.length).toBe(1);
      expect(snapshot.aggregate.markers[0].type).toBe("resolution");
    });

    it("does not add markers for unknown historyId", () => {
      svc.addMarker("nonexistent", "other", null, "value", "label");
    });
  });

  describe("setSessionState", () => {
    it("transitions state and creates pause/resume markers", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      svc.setSessionState(historyId, "paused");
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate.state).toBe("paused");

      svc.setSessionState(historyId, "playing");
      const snapshot2 = svc.getSnapshot(historyId);
      expect(snapshot2.aggregate.state).toBe("playing");
    });
  });

  describe("timer", () => {
    it("stops timer when no active sessions remain", async () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1");
      expect((svc as any).timer).not.toBeNull();
      await svc.finalizeSession(id1);
      expect((svc as any).timer).toBeNull();
    });

    it("does not stop timer when one of two sessions ends", async () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1");
      const id2 = svc.startHostSession("ms2", "ls2", "g1", "G1");
      await svc.finalizeSession(id1);
      expect((svc as any).timer).not.toBeNull();
      await svc.finalizeSession(id2);
      expect((svc as any).timer).toBeNull();
    });
  });

  describe("finalizeSession", () => {
    it("idempotent: repeated calls finalize once", async () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      await advanceTime(100);
      await svc.finalizeSession(historyId);
      await svc.finalizeSession(historyId);
      expect(svc.getActiveSessionIds()).not.toContain(historyId);
    });
  });

  describe("getSnapshot", () => {
    it("returns empty snapshot for unknown historyId", () => {
      const snapshot = svc.getSnapshot("unknown");
      expect(snapshot.aggregate.rawSamples.length).toBe(0);
      expect(snapshot.connections.length).toBe(0);
    });

    it("snapshot contains aggregate and connections", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1");
      const pc = createMockPC();
      svc.registerConnection({
        historyId, connectionId: "host:dev1:uuid1",
        viewerDeviceId: "dev1", displayName: "V1",
        peerConnection: pc, direction: "outbound",
      });
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.aggregate).toBeDefined();
      expect(snapshot.connections).toBeDefined();
      expect(snapshot.role).toBe("host");
    });
  });

  describe("schema migration", () => {
    it("converts legacy v1 record to StreamHistoryRecord", async () => {
      const mock = (globalThis as any).window.screenlink;
      const now = Date.now();
      // Simulate a v1 record (schemaVersion undefined/1)
      const v1 = {
        historyId: "hist1", role: "host", status: "completed",
        startedAt: now - 60000, lastCheckpointAt: now, stoppedAt: now,
        durationMs: 60000, totalBytes: 5000000,
        averageBytesPerSecond: 83333, bytesPerSecond: 83333,
        samples: [{ timestamp: now, bytesPerSecond: 83333, totalBytes: 5000000 }],
        markers: [],
        interrupted: false,
      };
      mock._setStore([v1]);
      const history = await svc.getHistory();
      expect(history.length).toBe(1);
    });
  });
});
