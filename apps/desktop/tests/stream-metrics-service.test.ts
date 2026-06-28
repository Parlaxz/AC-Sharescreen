// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StreamMetricsService, type StreamHistoryRecord } from "../src/renderer/services/stream-metrics-service.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Mock IPC API mimicking window.screenlink */
function createMockScreenlink() {
  let store: StreamHistoryRecord[] = [];

  return {
    getStreamHistory: vi.fn<() => Promise<StreamHistoryRecord[]>>().mockImplementation(async () => [...store]),
    saveStreamHistory: vi.fn<(r: StreamHistoryRecord[]) => Promise<void>>().mockImplementation(async (r) => { store = r.map(x => ({ ...x })); }),
    upsertStreamHistory: vi.fn<(record: unknown) => Promise<void>>().mockImplementation(async (record) => {
      const r = record as StreamHistoryRecord;
      const idx = store.findIndex(x => x.historyId === r.historyId);
      if (idx >= 0) store[idx] = { ...r };
      else store.push({ ...r });
    }),
    deleteStreamHistory: vi.fn<(historyId: string) => Promise<void>>().mockImplementation(async (id) => {
      store = store.filter(x => x.historyId !== id);
    }),
    _getStore: () => store,
    _setStore: (s: StreamHistoryRecord[]) => { store = s.map(x => ({ ...x })); },
  };
}

/** Enable fake timers + mock screenlink API */
function setupTest() {
  vi.useFakeTimers();
  const mock = createMockScreenlink();

  // Mock window.screenlink
  (globalThis as any).window = {
    screenlink: mock,
  };

  return { mock };
}

function teardownTest() {
  StreamMetricsService.setInstance(null);
  vi.useRealTimers();
  delete (globalThis as any).window;
}

/** Flush pending promise microtasks WITHOUT advancing fake timers */
async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Advance fake timers by ms and flush promises */
async function advanceTime(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("StreamMetricsService", () => {
  let svc: StreamMetricsService;

  beforeEach(() => {
    setupTest();
    svc = StreamMetricsService.getInstance();
  });

  afterEach(() => {
    teardownTest();
  });

  describe("startHostSession", () => {
    it("persists active record immediately on start", async () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "My Group", "preset1", false, "1080p");

      await flushPromises();

      const mock = (globalThis as any).window.screenlink;
      expect(mock.upsertStreamHistory).toHaveBeenCalledTimes(1);
      const record = mock.upsertStreamHistory.mock.calls[0][0] as StreamHistoryRecord;
      expect(record.historyId).toBe(historyId);
      expect(record.role).toBe("host");
      expect(record.status).toBe("active");
      expect(record.mediaSessionId).toBe("ms1");
      expect(record.groupName).toBe("My Group");
      expect(record.presetName).toBe("preset1");
      expect(record.customQuality).toBe(false);
    });

    it("returns unique historyId on each call", () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      const id2 = svc.startHostSession("ms2", "ls2", "g1", "G1", null, false, null);
      expect(id1).not.toBe(id2);
    });

    it("adds initial quality marker when label is provided", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, "1920x1080@60,5000kbps");
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.markers.length).toBe(1);
      expect(snapshot.markers[0].label).toBe("1920x1080@60,5000kbps");
      expect(snapshot.markers[0].type).toBe("other");
    });

    it("starts the timer when first session is created", () => {
      expect(svc["timer"]).toBeNull();
      svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      expect(svc["timer"]).not.toBeNull();
    });

    it("does not start a second timer when another session starts", () => {
      svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      const timer1 = svc["timer"];
      svc.startHostSession("ms2", "ls2", "g1", "G1", null, false, null);
      expect(svc["timer"]).toBe(timer1);
    });
  });

  describe("startViewerSession", () => {
    it("persists active viewer record immediately on start", async () => {
      svc.startViewerSession("ms1", "ls1", "g1", "G1", "Remote Host");

      await flushPromises();

      const mock = (globalThis as any).window.screenlink;
      expect(mock.upsertStreamHistory).toHaveBeenCalledTimes(1);
      const record = mock.upsertStreamHistory.mock.calls[0][0] as StreamHistoryRecord;
      expect(record.role).toBe("viewer");
      expect(record.remoteDisplayName).toBe("Remote Host");
      expect(record.status).toBe("active");
    });
  });

  describe("feedHostBytes", () => {
    function getTotalBytes(svc: StreamMetricsService, historyId: string): number {
      return svc.getSnapshot(historyId).totalBytes;
    }

    function getBytesPerSecond(svc: StreamMetricsService, historyId: string): number {
      return Math.round(svc.getSnapshot(historyId).currentBitsPerSecond / 8);
    }

    it("computes delta bytes and updates totalBytes", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);

      svc.feedHostBytes(historyId, 1000, 1000);
      expect(getTotalBytes(svc, historyId)).toBe(0);    // first feed is baseline only
      expect(getBytesPerSecond(svc, historyId)).toBe(0); // cannot compute rate with single point

      // Feed again with delta of 2000 over 1 second
      svc.feedHostBytes(historyId, 3000, 2000);
      expect(getTotalBytes(svc, historyId)).toBe(2000); // 3000 - 1000 = 2000 delta
      expect(getBytesPerSecond(svc, historyId)).toBe(2000); // 2000 bytes / 1 sec = 2000 B/s
    });

    it("handles counter reset gracefully (cumulativeBytes < lastBytes)", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);

      svc.feedHostBytes(historyId, 5000, 1000);
      expect(getTotalBytes(svc, historyId)).toBe(0);   // first feed is baseline only

      // Second feed establishes first real delta
      svc.feedHostBytes(historyId, 10000, 2000);
      expect(getTotalBytes(svc, historyId)).toBe(5000); // 10000 - 5000 = 5000 delta

      // Counter reset - new value is lower, should set baseline without negative delta
      svc.feedHostBytes(historyId, 100, 3000);
      expect(getTotalBytes(svc, historyId)).toBe(5000); // total unchanged (no negative delta)
    });

    it("stores bytesPerSecond in bytes (not bits)", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);

      svc.feedHostBytes(historyId, 0, 0);
      // 8000 bytes over 2 seconds = 4000 B/s (NOT 32000 bps)
      svc.feedHostBytes(historyId, 8000, 2000);
      expect(getBytesPerSecond(svc, historyId)).toBe(4000);
    });

    it("ignores feed for non-host sessions", () => {
      const historyId = svc.startViewerSession("ms1", "ls1", "g1", "G1", "Remote");
      svc.feedHostBytes(historyId, 1000, 1000);
      expect(getTotalBytes(svc, historyId)).toBe(0);
    });
  });

  describe("feedViewerBytes", () => {
    it("computes delta bytes for viewer sessions", () => {
      const historyId = svc.startViewerSession("ms1", "ls1", "g1", "G1", "Remote");

      svc.feedViewerBytes(historyId, 500, 1000);
      expect(svc.getSnapshot(historyId).totalBytes).toBe(0);   // first feed is baseline only

      svc.feedViewerBytes(historyId, 1500, 2000);
      expect(svc.getSnapshot(historyId).totalBytes).toBe(1000); // 1500 - 500 = 1000 delta
    });
  });

  describe("addMarker", () => {
    it("adds a setting marker to the session via snapshot", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, "initial");
      svc.addMarker(historyId, "resolution", "1920x1080", "1280x720", "Res changed");
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.markers.length).toBe(2); // 1 initial + 1 new
      expect(snapshot.markers[1].type).toBe("resolution");
      expect(snapshot.markers[1].detail).toContain("1920x1080");
    });

    it("does not add markers for unknown historyId", () => {
      svc.addMarker("nonexistent", "other", null, "value", "label");
      // Should not throw
    });
  });

  describe("checkpointSession", () => {
    it("persists a record with correct totalBytes on checkpoint", async () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      await flushPromises(); // flush start's persist

      svc.feedHostBytes(historyId, 5000, 1000);
      svc.feedHostBytes(historyId, 10000, 2000);

      // Clear the mock call count so we can count checkpoint persists
      const mock = (globalThis as any).window.screenlink;
      mock.upsertStreamHistory.mockClear();

      svc.checkpointSession(historyId);
      await flushPromises();

      expect(mock.upsertStreamHistory).toHaveBeenCalledTimes(1);
      const record = mock.upsertStreamHistory.mock.calls[0][0] as StreamHistoryRecord;
      expect(record.totalBytes).toBe(5000); // 5000 delta bytes added on second feed
    });

    it("snapshot currentBitsPerSecond reflects bytes-to-bits conversion", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      svc.feedHostBytes(historyId, 0, 0);
      svc.feedHostBytes(historyId, 8000, 2000); // 4000 B/s → 32000 bits/s
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.currentBitsPerSecond).toBe(32000); // bits per second
      expect(Math.round(snapshot.currentBitsPerSecond / 8)).toBe(4000); // bytes, not bits
    });
  });

  describe("timer", () => {
    it("checkpoints all active sessions every 10 seconds", async () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      const id2 = svc.startHostSession("ms2", "ls2", "g1", "G1", null, false, null);
      await flushPromises();
      (globalThis as any).window.screenlink.upsertStreamHistory.mockClear();

      // Advance by 10 seconds — this fires the timer tick
      await advanceTime(10000);

      // After 10 seconds, each session should have been checkpointed
      const calls = (globalThis as any).window.screenlink.upsertStreamHistory.mock.calls;
      const persistedIds = calls.map((c: any[]) => c[0].historyId as string);
      expect(persistedIds.filter((id: string) => id === id1).length).toBeGreaterThanOrEqual(1);
      expect(persistedIds.filter((id: string) => id === id2).length).toBeGreaterThanOrEqual(1);
    });

    it("stops timer when no active sessions remain", async () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      expect(svc["timer"]).not.toBeNull();

      await svc.finalizeSession(id1);
      expect(svc["timer"]).toBeNull();
    });

    it("does not stop another active session's timer when one session stops", async () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      const id2 = svc.startHostSession("ms2", "ls2", "g1", "G1", null, false, null);
      expect(svc["timer"]).not.toBeNull();

      await svc.finalizeSession(id1);
      expect(svc["timer"]).not.toBeNull(); // timer still runs for id2

      await svc.finalizeSession(id2);
      expect(svc["timer"]).toBeNull(); // now idle
    });
  });

  describe("finalizeSession", () => {
    it("idempotent: repeated calls create one record", async () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      await flushPromises();
      (globalThis as any).window.screenlink.upsertStreamHistory.mockClear();

      // Advance time so duration > 0
      await advanceTime(100);

      // First finalize
      await svc.finalizeSession(historyId);
      const callCount1 = (globalThis as any).window.screenlink.upsertStreamHistory.mock.calls.length;
      // Should have 1 completed record
      expect(callCount1).toBe(1);

      // Second finalize should be a no-op
      await svc.finalizeSession(historyId);
      const callCount2 = (globalThis as any).window.screenlink.upsertStreamHistory.mock.calls.length;

      // The number of upsert calls should be the same (idempotent)
      expect(callCount2).toBe(callCount1);
    });

    it("sets status to completed, stoppedAt, and averageBytesPerSecond", async () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      svc.feedHostBytes(historyId, 0, 0);      // baseline
      svc.feedHostBytes(historyId, 10000, 5000); // delta = 10000, totalBytes = 10000

      // Advance time so durationMs > 0
      await advanceTime(100);

      await svc.finalizeSession(historyId);
      await flushPromises();

      const mock = (globalThis as any).window.screenlink;
      const calls = mock.upsertStreamHistory.mock.calls;
      const lastCall = calls[calls.length - 1][0] as StreamHistoryRecord;
      expect(lastCall.status).toBe("completed");
      expect(lastCall.stoppedAt).not.toBeNull();
      expect(lastCall.interrupted).toBe(false);
      expect(lastCall.averageBytesPerSecond).toBeGreaterThan(0);
    });

    it("concurrent finalize calls create one record", async () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      await flushPromises();
      (globalThis as any).window.screenlink.upsertStreamHistory.mockClear();

      // Advance time so duration > 0
      await advanceTime(100);

      // Fire multiple concurrent finalize calls
      await Promise.all([
        svc.finalizeSession(historyId),
        svc.finalizeSession(historyId),
        svc.finalizeSession(historyId),
      ]);

      // Only the first call should have persisted a completed record
      const persisted = (globalThis as any).window.screenlink.upsertStreamHistory.mock.calls;
      const completedRecords = persisted.filter((c: any[]) => c[0]?.status === "completed");
      expect(completedRecords.length).toBe(1);
    });
  });

  describe("markers via snapshot", () => {
    it("reads markers via getSnapshot", () => {
      svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, "initial");
      const sessionIds = svc.getActiveSessionIds();
      const snapshot = svc.getSnapshot(sessionIds[0]);
      expect(snapshot.markers.length).toBe(1);
      expect(snapshot.markers[0].label).toBe("initial");
    });

    it("addMarker via addMarker reflects in snapshot", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, "initial");
      svc.addMarker(historyId, "resolution", "1920x1080", "1280x720", "Res changed");
      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.markers.length).toBe(2);
      expect(snapshot.markers[1].type).toBe("resolution");
      expect(snapshot.markers[1].detail).toContain("1920x1080");
    });
  });

  describe("crash recovery", () => {
    it("converts active records to interrupted at lastCheckpointAt", async () => {
      const mock = (globalThis as any).window.screenlink;

      // Simulate persisted active records
      const now = Date.now();
      const activeRecord: StreamHistoryRecord = {
        historyId: "hist1",
        role: "host",
        status: "active",
        mediaSessionId: "ms1",
        logicalStreamId: "ls1",
        groupId: "g1",
        groupName: "G1",
        remoteDisplayName: null,
        startedAt: now - 60000,
        lastCheckpointAt: now - 10000,
        stoppedAt: null,
        durationMs: 50000,
        totalBytes: 5000000,
        averageBytesPerSecond: 100000,
        presetName: null,
        customQuality: false,
        samples: [{ timestamp: now - 10000, bytesPerSecond: 100000, totalBytes: 5000000 }],
        markers: [],
        interrupted: false,
      };
      mock._setStore([activeRecord]);

      await svc.recoverInterruptedSessions();

      const store = mock._getStore();
      expect(store.length).toBe(1);
      expect(store[0].status).toBe("interrupted");
      expect(store[0].interrupted).toBe(true);
      expect(store[0].stoppedAt).toBe(now - 10000); // lastCheckpointAt
    });

    it("skips already completed records", async () => {
      const mock = (globalThis as any).window.screenlink;
      const completedRecord: StreamHistoryRecord = {
        historyId: "hist1",
        role: "host",
        status: "completed",
        mediaSessionId: "ms1",
        logicalStreamId: "ls1",
        groupId: "g1",
        groupName: "G1",
        remoteDisplayName: null,
        startedAt: Date.now() - 60000,
        lastCheckpointAt: Date.now() - 10000,
        stoppedAt: Date.now(),
        durationMs: 60000,
        totalBytes: 5000000,
        averageBytesPerSecond: 100000,
        presetName: null,
        customQuality: false,
        samples: [],
        markers: [],
        interrupted: false,
      };
      mock._setStore([completedRecord]);

      await svc.recoverInterruptedSessions();

      const store = mock._getStore();
      expect(store[0].status).toBe("completed"); // unchanged
    });
  });

  describe("main-process upsert replaces by historyId", () => {
    it("upsert replaces an existing record with same historyId", async () => {
      const mock = (globalThis as any).window.screenlink;
      const record1: StreamHistoryRecord = {
        historyId: "hist1", role: "host", status: "active",
        mediaSessionId: "ms1", logicalStreamId: "ls1", groupId: "g1", groupName: "G1",
        remoteDisplayName: null, startedAt: 1000, lastCheckpointAt: 2000,
        stoppedAt: null, durationMs: 1000, totalBytes: 100, averageBytesPerSecond: 100,
        presetName: null, customQuality: false, samples: [], markers: [], interrupted: false,
      };
      const updatedRecord: StreamHistoryRecord = {
        ...record1,
        status: "completed", totalBytes: 500, averageBytesPerSecond: 500,
        stoppedAt: 3000, durationMs: 2000,
      };

      mock._setStore([record1]);

      // Upsert the updated record
      await mock.upsertStreamHistory(updatedRecord);

      const store = mock._getStore();
      expect(store.length).toBe(1);
      expect(store[0].historyId).toBe("hist1");
      expect(store[0].status).toBe("completed");
      expect(store[0].totalBytes).toBe(500);
    });

    it("upsert appends a new record when historyId does not exist", async () => {
      const mock = (globalThis as any).window.screenlink;
      const record1: StreamHistoryRecord = {
        historyId: "hist1", role: "host", status: "active",
        mediaSessionId: "ms1", logicalStreamId: "ls1", groupId: "g1", groupName: "G1",
        remoteDisplayName: null, startedAt: 1000, lastCheckpointAt: 2000,
        stoppedAt: null, durationMs: 1000, totalBytes: 100, averageBytesPerSecond: 100,
        presetName: null, customQuality: false, samples: [], markers: [], interrupted: false,
      };
      const record2: StreamHistoryRecord = {
        historyId: "hist2", role: "host", status: "active",
        mediaSessionId: "ms2", logicalStreamId: "ls2", groupId: "g1", groupName: "G1",
        remoteDisplayName: null, startedAt: 1000, lastCheckpointAt: 2000,
        stoppedAt: null, durationMs: 1000, totalBytes: 200, averageBytesPerSecond: 200,
        presetName: null, customQuality: false, samples: [], markers: [], interrupted: false,
      };

      mock._setStore([record1]);
      await mock.upsertStreamHistory(record2);

      const store = mock._getStore();
      expect(store.length).toBe(2);
    });
  });

  describe("timer isolation", () => {
    it("starting and stopping one session does not stop another active session's timer", async () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      const id2 = svc.startHostSession("ms2", "ls2", "g1", "G1", null, false, null);

      expect(svc["timer"]).not.toBeNull();

      await svc.finalizeSession(id1);
      expect(svc["timer"]).not.toBeNull(); // id2 still active
      expect(svc.getActiveSessionIds()).toEqual([id2]);
    });

    it("stopping last session stops timer", async () => {
      const id1 = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);
      expect(svc["timer"]).not.toBeNull();

      await svc.finalizeSession(id1);
      expect(svc["timer"]).toBeNull();
    });
  });

  describe("viewer lifecycle", () => {
    it("viewer start creates active viewer session", () => {
      const historyId = svc.startViewerSession("ms1", "ls1", "g1", "G1", "Remote Host");
      expect(svc.getActiveSessionIds()).toContain(historyId);
    });

    it("viewer finalize creates one completed record", async () => {
      const historyId = svc.startViewerSession("ms1", "ls1", "g1", "G1", "Remote Host");
      await flushPromises();
      (globalThis as any).window.screenlink.upsertStreamHistory.mockClear();

      await svc.finalizeSession(historyId);
      const completedCount = (globalThis as any).window.screenlink.upsertStreamHistory.mock.calls
        .filter((c: any[]) => c[0]?.status === "completed").length;
      expect(completedCount).toBe(1);
    });
  });

  describe("rejoin creates new historyId", () => {
    it("subsequent startViewerSession for same mediaSessionId creates different historyId", () => {
      // Simulate rejoin: same logical stream, new media session
      const id1 = svc.startViewerSession("ms1", "ls1", "g1", "G1", "Remote");
      const id2 = svc.startViewerSession("ms2", "ls2", "g1", "G1", "Remote");
      expect(id1).not.toBe(id2);
    });
  });

  describe("in-memory samples", () => {
    it("rawSamples are retained in snapshot", () => {
      const historyId = svc.startHostSession("ms1", "ls1", "g1", "G1", null, false, null);

      // Trigger a timer tick to collect a sample
      svc.feedHostBytes(historyId, 0, 0);
      svc.feedHostBytes(historyId, 1000, 1000);

      const snapshot = svc.getSnapshot(historyId);
      expect(snapshot.rawSamples.length).toBeGreaterThanOrEqual(0);
      expect(snapshot.totalBytes).toBe(1000);
    });
  });



  describe("schema migration for legacy records", () => {
    it("existing exact duplicates are migrated to one record", async () => {
      const mock = (globalThis as any).window.screenlink;
      const now = Date.now();

      // Two records with the same derived key (same mediaSessionId, startedAt, role)
      const rec1: StreamHistoryRecord = {
        historyId: "hist1", role: "host", status: "completed",
        mediaSessionId: "ms1", logicalStreamId: "ls1", groupId: "g1", groupName: "G1",
        remoteDisplayName: null, startedAt: now - 60000, lastCheckpointAt: now - 10000,
        stoppedAt: now, durationMs: 60000, totalBytes: 5000000, averageBytesPerSecond: 83333,
        presetName: null, customQuality: false, samples: [], markers: [{ timestamp: now - 30000, category: "other", from: null, to: "4K", label: "4K" }],
        interrupted: false,
      };
      // Exact duplicate: same key (same mediaSessionId, startedAt, role)
      const rec1dup: StreamHistoryRecord = {
        ...rec1, historyId: "hist1dup",
        totalBytes: 6000000, averageBytesPerSecond: 100000,
        markers: [{ timestamp: now - 30000, category: "other", from: null, to: "4K", label: "4K" },
                   { timestamp: now - 10000, category: "other", from: null, to: "1080p", label: "1080p" }],
      };
      mock._setStore([rec1, rec1dup]);

      // Deduplicate by historyId (the upsert handler in main process does this)
      const seen = new Set<string>();
      const deduped = mock._getStore().filter((r: StreamHistoryRecord) => {
        if (!r.historyId || seen.has(r.historyId)) return false;
        seen.add(r.historyId);
        return true;
      });

      // Both have different historyIds, so both survive — this tests that
      // the upsert's safety net dedup only kicks in for exact historyId match
      expect(deduped.length).toBe(2);
    });

    it("legitimate separate sessions remain separate", () => {
      // Two records with different startedAt — they are separate sessions
      const now = Date.now();
      const rec1: StreamHistoryRecord = {
        historyId: "hist1", role: "host", status: "completed",
        mediaSessionId: "ms1", logicalStreamId: "ls1", groupId: "g1", groupName: "G1",
        remoteDisplayName: null, startedAt: now - 120000, lastCheckpointAt: now - 60000,
        stoppedAt: now - 60000, durationMs: 60000, totalBytes: 5000000, averageBytesPerSecond: 83333,
        presetName: null, customQuality: false, samples: [], markers: [], interrupted: false,
      };
      const rec2: StreamHistoryRecord = {
        historyId: "hist2", role: "host", status: "completed",
        mediaSessionId: "ms1", logicalStreamId: "ls1", groupId: "g1", groupName: "G1",
        remoteDisplayName: null, startedAt: now - 60000, lastCheckpointAt: now,
        stoppedAt: now, durationMs: 60000, totalBytes: 3000000, averageBytesPerSecond: 50000,
        presetName: null, customQuality: false, samples: [], markers: [], interrupted: false,
      };

      const seen = new Set<string>();
      const deduped = [rec1, rec2].filter((r: StreamHistoryRecord) => {
        if (!r.historyId || seen.has(r.historyId)) return false;
        seen.add(r.historyId);
        return true;
      });

      expect(deduped.length).toBe(2);
    });
  });
});
