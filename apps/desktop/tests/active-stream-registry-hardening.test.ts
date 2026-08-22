// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ActiveStreamRegistry, type StreamAnnouncement } from "../src/renderer/services/active-stream-registry.js";

// ─── Factory helpers ───────────────────────────────────────────────────────────

function makeAnnouncement(overrides: Partial<StreamAnnouncement> = {}): StreamAnnouncement {
  return {
    logicalStreamId: "stream-1",
    mediaSessionId: "media-1",
    groupId: "group-1",
    hostDeviceId: "host-1",
    hostDisplayName: "Host One",
    sourceKind: "screen",
    sourceName: "Screen 1",
    startedAt: Date.now(),
    appliedSettingsRevision: 1,
    heartbeatSequence: 1,
    streamRevision: 1,
    mediaJoinMetadata: "",
    replacesSessionId: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. TOMBSTONE VISIBILITY — Characterization
// ═══════════════════════════════════════════════════════════════════════════════

describe("ActiveStreamRegistry — tombstone visibility", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("CHARACTERIZATION: getAllStreams excludes tombstoned streams", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    expect(registry.getAllStreams()).toHaveLength(0);
  });

  it("CHARACTERIZATION: getStreamsByGroup excludes tombstoned entries", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    expect(registry.getStreamsByGroup("group-1")).toHaveLength(0);
  });

  it("CHARACTERIZATION: getStream returns null for tombstoned stream", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    expect(registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" })).toBeNull();
  });

  it("CHARACTERIZATION: getGroupKeys excludes tombstoned entries", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    expect(registry.getGroupKeys("group-1")).toHaveLength(0);
  });

  it("CHARACTERIZATION: re-add within tombstone window is rejected", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleStarted(makeAnnouncement({
      groupId: "group-1",
      hostDeviceId: "host-1",
      logicalStreamId: "stream-1",
      heartbeatSequence: 2,
      streamRevision: 2,
    }));

    expect(updates).not.toContain("new");
    expect(updates).not.toContain("updated");
    expect(registry.getAllStreams()).toHaveLength(0);
  });

  it("CHARACTERIZATION: handleHeartbeat to tombstoned stream is silently ignored", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    registry.handleHeartbeat({
      groupId: "group-1",
      hostDeviceId: "host-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "media-1",
      heartbeatSequence: 2,
    });

    expect(registry.getAllStreams()).toHaveLength(0);
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("CHARACTERIZATION: tombstone older than tombstoneMaxAgeMs allows re-add", () => {
      registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
      registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      const updates: string[] = [];
      registry.onUpdate((u) => updates.push(u.type));

      registry.handleStarted(makeAnnouncement({
        groupId: "group-1",
        hostDeviceId: "host-1",
        logicalStreamId: "stream-1",
        heartbeatSequence: 2,
        streamRevision: 2,
      }));

      expect(updates).toContain("new");
      expect(registry.getAllStreams()).toHaveLength(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. LEASE-BASED EXPIRY — Characterization
// ═══════════════════════════════════════════════════════════════════════════════

describe("ActiveStreamRegistry — leaseValidUntil expiry behavior", () => {
  let registry: ActiveStreamRegistry;

  afterEach(() => {
    registry.destroy();
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("REGRESSION: stream with future leaseValidUntil survives heartbeat-based expiry", () => {
      // Short intervals: check every 50ms, expire after 200ms without heartbeat
      registry = new ActiveStreamRegistry(50, 200);

      registry.handleStarted(makeAnnouncement({
        heartbeatSequence: 1,
        leaseValidUntil: Date.now() + 60_000, // Future
      }));

      expect(registry.getAllStreams()).toHaveLength(1);

      // Advance time past expiry — the stream should survive because the
      // host-advertised lease is still valid.
      vi.advanceTimersByTime(500);

      expect(registry.getAllStreams()).toHaveLength(1);
    });
  });

  it("CHARACTERIZATION: leaseValidUntil in the past + no prior heartbeat = stream skipped in handleSnapshot", () => {
    // Use long expiry so the timer never fires during the test
    registry = new ActiveStreamRegistry(10_000, 600_000);

    const now = Date.now();
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([makeAnnouncement({
      heartbeatSequence: 1,
      streamRevision: 1,
      leaseValidUntil: now - 1000, // Past
    })]);

    // handleSnapshot: leaseValidUntil < now and no prior heartbeat → skip
    expect(updates).toHaveLength(0);
    expect(registry.getAllStreams()).toHaveLength(0);
  });

  it("CHARACTERIZATION: leaseValidUntil in the past + existing heartbeatSeq allows snapshot update", () => {
    // Use long expiry so the timer never fires during the test
    registry = new ActiveStreamRegistry(10_000, 600_000);

    // Start stream first (creates heartbeat sequence entry)
    registry.handleStarted(makeAnnouncement({
      heartbeatSequence: 10,
      streamRevision: 1,
    }));

    expect(registry.getAllStreams()).toHaveLength(1);

    // Now send snapshot with lease in the past but existing heartbeat seq entry
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([makeAnnouncement({
      heartbeatSequence: 15,
      streamRevision: 2,
      leaseValidUntil: Date.now() - 1000, // Past
    })]);

    // handleSnapshot: leaseValidUntil < now but a heartbeatSeq exists, so the
    // stream is NOT skipped — it falls through to normal revision/seq comparison.
    // Since seq 15 > 10 and revision 2 > 1, the snapshot is accepted as an update.
    expect(updates).toEqual(["updated"]);
    const stream = registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(stream?.heartbeatSequence).toBe(15);
    expect(stream?.streamRevision).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. TOMBSTONE RACE RE-ADD — Simulated stale internal insertion
// ═══════════════════════════════════════════════════════════════════════════════

describe("ActiveStreamRegistry — tombstone race re-add (regression)", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  /**
   * Simulate a stale/reordered insertion that bypasses handleStarted (e.g.
   * a replayed or out-of-order message that writes directly into the stream
   * map). While a tombstone is valid, all public read methods must hide
   * this entry — the tombstone represents an authoritative intent to stop.
   */
  function insertDirectly(
    groupId: string,
    hostDeviceId: string,
    logicalStreamId: string,
    heartbeatSequence: number,
  ): void {
    const map = (registry as unknown as { streams: Map<string, unknown> }).streams;
    const k = `${groupId}:${hostDeviceId}:${logicalStreamId}`;
    map.set(k, {
      announcement: makeAnnouncement({
        groupId,
        hostDeviceId,
        logicalStreamId,
        heartbeatSequence,
        streamRevision: 99,
      }),
      lastHeartbeatAt: Date.now(),
      stopped: false,
    });
  }

  it("REGRESSION: reordered handleStarted via internal map insertion is hidden by tombstone", () => {
    // 1. Start and stop a stream → creates tombstone, deletes active entry
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(registry.getAllStreams()).toHaveLength(0);

    // 2. Simulate a stale/reordered message that bypasses handleStarted
    insertDirectly("group-1", "host-1", "stream-1", 2);

    // 3. All public reads must still hide this entry while tombstone is valid
    expect(registry.getAllStreams()).toHaveLength(0);
    expect(registry.getStreamsByGroup("group-1")).toHaveLength(0);
    expect(registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" })).toBeNull();
    expect(registry.getGroupKeys("group-1")).toHaveLength(0);
  });

  it("CHARACTERIZATION: handleSnapshot still rejects tombstoned stream even after direct map insertion", () => {
    // 1. Start and stop a stream
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    // 2. Bypass insertion
    insertDirectly("group-1", "host-1", "stream-1", 2);

    // 3. Snapshot should also reject (handleSnapshot checks tombstones)
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([makeAnnouncement({
      heartbeatSequence: 3,
      streamRevision: 100,
    })]);

    expect(updates).toHaveLength(0);
    expect(registry.getAllStreams()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SNAPSHOT BEHAVIOR — Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("ActiveStreamRegistry — snapshot edge cases", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("CHARACTERIZATION: handleSnapshot with empty array is a no-op", () => {
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([]);

    expect(updates).toHaveLength(0);
    expect(registry.getAllStreams()).toHaveLength(0);
  });

  it("CHARACTERIZATION: handleSnapshot with stopped flag entry does not resurrect", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    // Snapshot should not resurrect
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([makeAnnouncement({
      heartbeatSequence: 2,
      streamRevision: 2,
    })]);

    expect(updates).toHaveLength(0);
    expect(registry.getAllStreams()).toHaveLength(0);
  });

  it("CHARACTERIZATION: snapshot with same revision but higher heartbeat updates the entry", () => {
    registry.handleStarted(makeAnnouncement({
      streamRevision: 5,
      heartbeatSequence: 10,
    }));

    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([makeAnnouncement({
      streamRevision: 5,
      heartbeatSequence: 15,
    })]);

    expect(updates).toEqual(["updated"]);
    const stream = registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(stream?.heartbeatSequence).toBe(15);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. REGISTERLOCALSTREAM BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════

describe("ActiveStreamRegistry — registerLocalStream edge cases", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("CHARACTERIZATION: registerLocalStream bypasses tombstones", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    // registerLocalStream should bypass tombstone (per doc: "Does NOT check tombstones")
    registry.registerLocalStream(makeAnnouncement({
      heartbeatSequence: 2,
      streamRevision: 2,
    }));

    // Should succeed regardless of tombstone
    expect(registry.getAllStreams()).toHaveLength(1);
  });

  it("CHARACTERIZATION: registerLocalStream updates existing entry with new event", () => {
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.registerLocalStream(makeAnnouncement({
      heartbeatSequence: 1,
      streamRevision: 1,
    }));

    registry.registerLocalStream(makeAnnouncement({
      heartbeatSequence: 2,
      streamRevision: 2,
    }));

    expect(updates).toEqual(["new", "updated"]);
    expect(registry.getAllStreams()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. HEARTBEAT EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe("ActiveStreamRegistry — heartbeat edge cases", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("CHARACTERIZATION: heartbeat for non-existent stream is silently ignored", () => {
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleHeartbeat({
      groupId: "group-1",
      hostDeviceId: "host-1",
      logicalStreamId: "non-existent",
      mediaSessionId: "media-1",
      heartbeatSequence: 1,
    });

    expect(updates).toHaveLength(0);
    expect(registry.getAllStreams()).toHaveLength(0);
  });

  it("CHARACTERIZATION: heartbeat updates appliedSettingsRevision and leaseValidUntil", () => {
    registry.handleStarted(makeAnnouncement({
      heartbeatSequence: 1,
      appliedSettingsRevision: 5,
    }));

    registry.handleHeartbeat({
      groupId: "group-1",
      hostDeviceId: "host-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "media-1",
      heartbeatSequence: 2,
      appliedSettingsRevision: 10,
      leaseValidUntil: Date.now() + 60_000,
    });

    const stream = registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(stream?.appliedSettingsRevision).toBe(10);
    expect(stream?.leaseValidUntil).toBeGreaterThan(Date.now());
  });

  it("CHARACTERIZATION: stale heartbeat (sequence <= last) is ignored", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 5 }));

    const stream1 = registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(stream1?.heartbeatSequence).toBe(5);

    // Stale heartbeat
    registry.handleHeartbeat({
      groupId: "group-1",
      hostDeviceId: "host-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "media-1",
      heartbeatSequence: 3,
    });

    const stream2 = registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(stream2?.heartbeatSequence).toBe(5);
  });
});
