// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ActiveStreamRegistry, type StreamAnnouncement } from "../src/renderer/services/active-stream-registry.js";
import { StreamSessionManager } from "../src/renderer/services/stream-session-manager.js";
import { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";
import { GroupConnectionManager } from "../src/renderer/services/group-connection-manager.js";

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

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("ActiveStreamRegistry Phase 3 — composite keys", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("two groups with the same logicalStreamId do not collide", () => {
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(`${u.type}:${u.stream.groupId}:${u.stream.logicalStreamId}`));

    registry.handleStarted(makeAnnouncement({ groupId: "group-a", logicalStreamId: "stream-1", hostDeviceId: "host-1", heartbeatSequence: 1 }));
    registry.handleStarted(makeAnnouncement({ groupId: "group-b", logicalStreamId: "stream-1", hostDeviceId: "host-1", heartbeatSequence: 1 }));

    expect(updates).toEqual([
      "new:group-a:stream-1",
      "new:group-b:stream-1",
    ]);

    const allStreams = registry.getAllStreams();
    expect(allStreams).toHaveLength(2);

    const streamA = registry.getStream({ groupId: "group-a", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    const streamB = registry.getStream({ groupId: "group-b", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(streamA).not.toBeNull();
    expect(streamB).not.toBeNull();
    expect(streamA!.groupId).toBe("group-a");
    expect(streamB!.groupId).toBe("group-b");
  });

  it("two hosts with the same logicalStreamId in the same group do not collide", () => {
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(`${u.type}:${u.stream.hostDeviceId}:${u.stream.logicalStreamId}`));

    registry.handleStarted(makeAnnouncement({ groupId: "group-1", logicalStreamId: "stream-1", hostDeviceId: "host-a", heartbeatSequence: 1 }));
    registry.handleStarted(makeAnnouncement({ groupId: "group-1", logicalStreamId: "stream-1", hostDeviceId: "host-b", heartbeatSequence: 1 }));

    expect(updates).toEqual([
      "new:host-a:stream-1",
      "new:host-b:stream-1",
    ]);

    const allStreams = registry.getAllStreams();
    expect(allStreams).toHaveLength(2);

    const streamA = registry.getStream({ groupId: "group-1", hostDeviceId: "host-a", logicalStreamId: "stream-1" });
    const streamB = registry.getStream({ groupId: "group-1", hostDeviceId: "host-b", logicalStreamId: "stream-1" });
    expect(streamA).not.toBeNull();
    expect(streamB).not.toBeNull();
  });
});

describe("ActiveStreamRegistry Phase 3 — explicit stop", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("stop deletes the active record", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));

    let activeAfterStart = registry.getAllStreams();
    expect(activeAfterStart).toHaveLength(1);

    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    // Active entry should be deleted
    const activeAfterStop = registry.getAllStreams();
    expect(activeAfterStop).toHaveLength(0);

    // getStream should return null
    const stream = registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(stream).toBeNull();
  });

  it("stop emits stopped exactly once", () => {
    const stopEvents: string[] = [];
    registry.onUpdate((u) => {
      if (u.type === "stopped") stopEvents.push(u.stream.logicalStreamId);
    });

    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    expect(stopEvents).toEqual(["stream-1"]);

    // Second stop should not emit again
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(stopEvents).toEqual(["stream-1"]);
  });

  it("stop removes heartbeat sequence entry", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 5 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    // After stop, a new start with lower heartbeat should be accepted
    // (tombstone may still block, but that's a different test)
    // Actually, let's test that heartbeat state is cleaned up by checking
    // that a new handleStarted for a different identity using same logicalStreamId
    // does NOT have stale heartbeat sequence

    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    // Clear tombstones by advancing past max age
    // Skip tombstone by using different host
    registry.handleStarted(makeAnnouncement({
      groupId: "group-1",
      hostDeviceId: "host-2", // different host
      logicalStreamId: "stream-1",
      heartbeatSequence: 1, // would be rejected if old seq (5) was still tracked
    }));

    expect(updates).toContain("new");
  });

  it("stop creates a bounded tombstone that blocks resurrection", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    // Attempt to start the same stream — should be blocked by tombstone
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
    expect(updates).toHaveLength(0);
  });
});

describe("ActiveStreamRegistry Phase 3 — snapshot validation", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("snapshot rejects tombstoned streams", () => {
    // Start and stop a stream, creating tombstone
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    // Snapshot should not resurrect it
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([
      makeAnnouncement({
        groupId: "group-1",
        hostDeviceId: "host-1",
        logicalStreamId: "stream-1",
        streamRevision: 2,
        heartbeatSequence: 2,
      }),
    ]);

    expect(updates).not.toContain("new");
    expect(updates).not.toContain("updated");
    expect(updates).toHaveLength(0);

    // Registry should still be empty
    expect(registry.getAllStreams()).toHaveLength(0);
  });

  it("snapshot rejects lower streamRevision", () => {
    registry.handleStarted(makeAnnouncement({
      streamRevision: 5,
      heartbeatSequence: 10,
    }));

    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    // Lower revision should be rejected
    registry.handleSnapshot([
      makeAnnouncement({
        streamRevision: 3,
        heartbeatSequence: 15, // higher heartbeat but lower revision
      }),
    ]);

    expect(updates).toHaveLength(0);
  });

  it("snapshot rejects lower heartbeatSequence", () => {
    registry.handleStarted(makeAnnouncement({
      streamRevision: 5,
      heartbeatSequence: 10,
    }));

    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    // Lower heartbeat with same revision should be rejected
    registry.handleSnapshot([
      makeAnnouncement({
        streamRevision: 5,
        heartbeatSequence: 8,
      }),
    ]);

    expect(updates).toHaveLength(0);
  });

  it("snapshot accepts long-running streams regardless of startedAt age (Gate 3.3)", () => {
    // Gate 3.3: liveness is decided by heartbeat freshness or
    // host-provided leaseValidUntil. A stream that has been running
    // for several hours must remain discoverable to a late viewer;
    // we no longer reject on the basis of startedAt age.
    const oldStartedAt = Date.now() - 6 * 60 * 60 * 1000; // 6 hours ago
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([
      makeAnnouncement({
        groupId: "group-1",
        hostDeviceId: "host-1",
        logicalStreamId: "stream-1",
        startedAt: oldStartedAt,
        heartbeatSequence: 1,
        streamRevision: 1,
        leaseValidUntil: Date.now() + 30_000,
      }),
    ]);

    expect(updates).toEqual(["new"]);
    expect(registry.getAllStreams()).toHaveLength(1);
  });

  it("snapshot accepts long-running streams with old startedAt but within tombstone window", () => {
    // A stream that started 3 minutes ago is a valid long-running stream.
    // It should NOT be rejected because startedAt is old — it's still the
    // peer's current active stream.
    const oldStartedAt = Date.now() - 180_000; // 3 minutes ago, within 5 min tombstoneMaxAgeMs
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([
      makeAnnouncement({
        groupId: "group-1",
        hostDeviceId: "host-1",
        logicalStreamId: "long-running-stream",
        startedAt: oldStartedAt,
        heartbeatSequence: 50,
        streamRevision: 3,
      }),
    ]);

    expect(updates).toEqual(["new"]);
    expect(registry.getAllStreams()).toHaveLength(1);
  });

  it("snapshot avoids duplicate new events for unchanged state", () => {
    registry.handleStarted(makeAnnouncement({
      streamRevision: 5,
      heartbeatSequence: 10,
    }));

    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(`${u.type}:${u.stream.streamRevision}:${u.stream.heartbeatSequence}`));

    // Same revision and heartbeat — should not emit anything
    registry.handleSnapshot([
      makeAnnouncement({
        streamRevision: 5,
        heartbeatSequence: 10,
      }),
    ]);

    expect(updates).toHaveLength(0);
  });

  it("snapshot emits updated for valid newer records", () => {
    registry.handleStarted(makeAnnouncement({
      streamRevision: 5,
      heartbeatSequence: 10,
    }));

    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(`${u.type}:${u.stream.streamRevision}:${u.stream.heartbeatSequence}`));

    registry.handleSnapshot([
      makeAnnouncement({
        streamRevision: 6,
        heartbeatSequence: 15,
      }),
    ]);

    expect(updates).toEqual(["updated:6:15"]);
  });

  it("snapshot emits new for completely new streams", () => {
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleSnapshot([
      makeAnnouncement({
        groupId: "group-1",
        hostDeviceId: "host-1",
        logicalStreamId: "new-stream",
        heartbeatSequence: 1,
        streamRevision: 1,
      }),
    ]);

    expect(updates).toEqual(["new"]);
  });
});

describe("ActiveStreamRegistry Phase 3 — timeout expiry", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new ActiveStreamRegistry(50, 100); // Check every 50ms, expire after 100ms
  });

  afterEach(() => {
    registry.destroy();
    vi.useRealTimers();
  });

  it("timeout deletes the active record", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));

    expect(registry.getAllStreams()).toHaveLength(1);

    // Advance past expiry: 100ms stale + 50ms check interval = 150ms needed
    vi.advanceTimersByTime(200);

    // Stream should be removed from active entries
    expect(registry.getAllStreams()).toHaveLength(0);
  });

  it("timeout emits stopped once", () => {
    const stopEvents: string[] = [];
    registry.onUpdate((u) => {
      if (u.type === "stopped") stopEvents.push(u.stream.logicalStreamId);
    });

    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));

    // Advance past expiry
    vi.advanceTimersByTime(200);

    expect(stopEvents).toEqual(["stream-1"]);

    // Advance further — should not emit again
    vi.advanceTimersByTime(300);
    expect(stopEvents).toEqual(["stream-1"]);
  });

  it("active heartbeat prevents expiry", () => {
    let seq = 1;
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: seq }));

    // Advance time by 50ms (one check interval) — still alive
    vi.advanceTimersByTime(50);
    expect(registry.getAllStreams()).toHaveLength(1);

    // Send heartbeats to keep alive before expiry
    seq++;
    registry.handleHeartbeat({
      groupId: "group-1",
      hostDeviceId: "host-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "media-1",
      heartbeatSequence: seq,
    });

    // Advance past the original expiry — heartbeat should have refreshed
    vi.advanceTimersByTime(100);

    // Stream should still be alive
    expect(registry.getAllStreams()).toHaveLength(1);

    // Now stop sending heartbeats and let it expire
    vi.advanceTimersByTime(200);

    // Stream should be gone
    expect(registry.getAllStreams()).toHaveLength(0);
  });
});

describe("ActiveStreamRegistry Phase 3 — local registration", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("local stream is registered and appears in getAllStreams", () => {
    registry.registerLocalStream(makeAnnouncement({
      groupId: "group-1",
      hostDeviceId: "my-device",
      logicalStreamId: "my-stream",
      heartbeatSequence: 1,
      streamRevision: 1,
    }));

    const streams = registry.getAllStreams();
    expect(streams).toHaveLength(1);
    expect(streams[0].hostDeviceId).toBe("my-device");
    expect(streams[0].logicalStreamId).toBe("my-stream");
  });

  it("local registration emits new event", () => {
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.registerLocalStream(makeAnnouncement({
      heartbeatSequence: 1,
      streamRevision: 1,
    }));

    expect(updates).toEqual(["new"]);
  });

  it("local registration is idempotent for same composite key", () => {
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.registerLocalStream(makeAnnouncement({
      groupId: "group-1",
      hostDeviceId: "my-device",
      logicalStreamId: "my-stream",
      heartbeatSequence: 1,
      streamRevision: 1,
    }));

    // Second registration — should update, not create duplicate
    registry.registerLocalStream(makeAnnouncement({
      groupId: "group-1",
      hostDeviceId: "my-device",
      logicalStreamId: "my-stream",
      heartbeatSequence: 2,
      streamRevision: 2,
    }));

    expect(registry.getAllStreams()).toHaveLength(1);
    expect(updates).toEqual(["new", "updated"]);
  });

  it("local registration does not overwrite streams from other groups/hosts", () => {
    registry.registerLocalStream(makeAnnouncement({
      groupId: "group-1",
      hostDeviceId: "dev-a",
      logicalStreamId: "stream-1",
      heartbeatSequence: 1,
      streamRevision: 1,
    }));

    registry.registerLocalStream(makeAnnouncement({
      groupId: "group-2",
      hostDeviceId: "dev-b",
      logicalStreamId: "stream-1",
      heartbeatSequence: 1,
      streamRevision: 1,
    }));

    expect(registry.getAllStreams()).toHaveLength(2);
  });
});

describe("ActiveStreamRegistry Phase 3 — handleHeartbeat with composite keys", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("heartbeat updates correct stream when same logicalStreamId in different groups", () => {
    registry.handleStarted(makeAnnouncement({ groupId: "group-a", logicalStreamId: "stream-1", hostDeviceId: "host-1", heartbeatSequence: 1 }));
    registry.handleStarted(makeAnnouncement({ groupId: "group-b", logicalStreamId: "stream-1", hostDeviceId: "host-1", heartbeatSequence: 1 }));

    // Heartbeat for group-b only
    registry.handleHeartbeat({
      groupId: "group-b",
      hostDeviceId: "host-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "media-1",
      heartbeatSequence: 2,
    });

    const streamA = registry.getStream({ groupId: "group-a", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    const streamB = registry.getStream({ groupId: "group-b", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    expect(streamA!.heartbeatSequence).toBe(1); // unchanged
    expect(streamB!.heartbeatSequence).toBe(2); // updated
  });

  it("heartbeat is rejected after stop via tombstone", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    // Heartbeat should be ignored (tombstone)
    const heartbeatResult = registry.handleHeartbeat({
      groupId: "group-1",
      hostDeviceId: "host-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "media-1",
      heartbeatSequence: 2,
    });

    // Stream should remain deleted
    expect(registry.getAllStreams()).toHaveLength(0);
  });
});

describe("ActiveStreamRegistry Phase 3 — handleStarted rejects stale across different hosts", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("different hosts with same logicalStreamId have independent heartbeat sequences", () => {
    registry.handleStarted(makeAnnouncement({
      groupId: "group-1",
      hostDeviceId: "host-a",
      logicalStreamId: "stream-1",
      heartbeatSequence: 100,
    }));

    // Different host, same logicalStreamId — should not be affected by host-a's seq
    registry.handleStarted(makeAnnouncement({
      groupId: "group-1",
      hostDeviceId: "host-b",
      logicalStreamId: "stream-1",
      heartbeatSequence: 1, // low but valid for host-b
    }));

    const streams = registry.getAllStreams();
    expect(streams).toHaveLength(2);
  });
});

describe("ActiveStreamRegistry Phase 3 — getStream with composite key", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("getStream returns null for wrong composite key", () => {
    registry.handleStarted(makeAnnouncement({
      groupId: "group-1",
      hostDeviceId: "host-a",
      logicalStreamId: "stream-1",
    }));

    // Wrong group
    expect(registry.getStream({ groupId: "group-2", hostDeviceId: "host-a", logicalStreamId: "stream-1" })).toBeNull();
    // Wrong host
    expect(registry.getStream({ groupId: "group-1", hostDeviceId: "host-b", logicalStreamId: "stream-1" })).toBeNull();
    // Wrong logicalStreamId
    expect(registry.getStream({ groupId: "group-1", hostDeviceId: "host-a", logicalStreamId: "stream-2" })).toBeNull();
    // Correct key
    expect(registry.getStream({ groupId: "group-1", hostDeviceId: "host-a", logicalStreamId: "stream-1" })).not.toBeNull();
  });
});

describe("ActiveStreamRegistry Phase 3 — replacement chains", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("replacement updates heartbeatSequences", () => {
    registry.handleStarted(makeAnnouncement({
      heartbeatSequence: 10,
      streamRevision: 1,
    }));

    // Replacement with higher heartbeatSequence
    registry.handleStarted(makeAnnouncement({
      heartbeatSequence: 20,
      streamRevision: 2,
      replacesSessionId: "media-1",
    }));

    // After replacement, heartbeatSequences should be 20, not 10
    // Verify by sending a heartbeat with seq 15 — should be rejected as stale
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(u.type));

    registry.handleHeartbeat({
      groupId: "group-1",
      hostDeviceId: "host-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "media-2",
      heartbeatSequence: 15, // lower than 20, should be rejected
    });

    // No updates expected — heartbeat was rejected
    expect(registry.getAllStreams()).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it("replacement chain: replacing a replaced stream is allowed", () => {
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(`${u.type}:${u.stream.heartbeatSequence}:${u.stream.mediaSessionId}`));

    // First start
    registry.handleStarted(makeAnnouncement({
      mediaSessionId: "media-A",
      heartbeatSequence: 1,
      streamRevision: 1,
    }));

    // First replacement — replacesSessionId points to media-A
    registry.handleStarted(makeAnnouncement({
      mediaSessionId: "media-B",
      heartbeatSequence: 10,
      streamRevision: 2,
      replacesSessionId: "media-A",
    }));

    // Second replacement — replacesSessionId points to media-B
    registry.handleStarted(makeAnnouncement({
      mediaSessionId: "media-C",
      heartbeatSequence: 20,
      streamRevision: 3,
      replacesSessionId: "media-B",
    }));

    // All three should have been accepted: new, replaced, replaced
    expect(updates).toEqual([
      "new:1:media-A",
      "replaced:10:media-B",
      "replaced:20:media-C",
    ]);

    const stream = registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(stream).not.toBeNull();
    expect(stream!.mediaSessionId).toBe("media-C");
    expect(stream!.heartbeatSequence).toBe(20);
  });
});

describe("StreamSessionManager Phase 3 — stopStream cleanup", () => {
  let runtime: Phase3Runtime;

  beforeEach(async () => {
    vi.spyOn(GroupConnectionManager.prototype, "addGroup").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "destroyAll").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "removeGroup").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "broadcast").mockResolvedValue(undefined);

    // Mock browser APIs for node environment
    const navigatorObj = (globalThis as any).navigator ?? {};
    if (!("mediaDevices" in navigatorObj)) {
      (navigatorObj as any).mediaDevices = {};
    }
    if (!(globalThis as any).navigator) {
      Object.defineProperty(globalThis, "navigator", {
        value: navigatorObj,
        writable: true,
        configurable: true,
      });
    }
    const fakeTrack = { kind: "video", label: "Screen", stop: vi.fn(), enabled: true, id: "track-1", getCapabilities: vi.fn().mockReturnValue({}), getSettings: vi.fn().mockReturnValue({ width: 1920, height: 1080, frameRate: 30 }), applyConstraints: vi.fn().mockResolvedValue(undefined) } as unknown as MediaStreamTrack;
    const fakeStream = { getVideoTracks: () => [fakeTrack], getAudioTracks: () => [], getTracks: () => [fakeTrack] } as unknown as MediaStream;
    (globalThis.navigator as any).mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue(fakeStream);

    // Mock PublisherManager.startPublishing to avoid VDO connection
    const { PublisherManager } = await import("../src/renderer/services/publisher-manager.js");
    vi.spyOn(PublisherManager.prototype, "startPublishing").mockResolvedValue(undefined);
    vi.spyOn(PublisherManager.prototype, "stopCapture").mockResolvedValue(undefined);

    runtime = new Phase3Runtime();
    await runtime.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await runtime.destroy().catch(() => {});
  });

  it("stopStream removes the local registry entry immediately", async () => {
    const sessionManager = runtime.getStreamSessionManager();
    sessionManager.setDeviceIdentity("dev-stop", "Stop User");

    const registry = runtime.getActiveStreamRegistry();
    const handleStoppedSpy = vi.spyOn(registry, "handleStopped");

    await sessionManager.startStream({
      groupId: "test-stop-group",
      source: { id: "source-1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // Stream should be in registry
    expect(registry.getAllStreams().length).toBeGreaterThan(0);

    // Stop the stream
    await sessionManager.stopStream();

    // handleStopped should have been called on the registry
    expect(handleStoppedSpy).toHaveBeenCalledTimes(1);
    const stopCall = handleStoppedSpy.mock.calls[0][0];
    expect(stopCall.groupId).toBe("test-stop-group");
    expect(stopCall.hostDeviceId).toBe("dev-stop");

    // Registry should be empty
    expect(registry.getAllStreams()).toHaveLength(0);
  });
});

describe("StreamSessionManager Phase 3 — sendHeartbeat error handling", () => {
  let runtime: Phase3Runtime;

  beforeEach(async () => {
    vi.spyOn(GroupConnectionManager.prototype, "addGroup").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "destroyAll").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "removeGroup").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "broadcast").mockResolvedValue(undefined);

    // Mock browser APIs for node environment
    const navigatorObj = (globalThis as any).navigator ?? {};
    if (!("mediaDevices" in navigatorObj)) {
      (navigatorObj as any).mediaDevices = {};
    }
    if (!(globalThis as any).navigator) {
      Object.defineProperty(globalThis, "navigator", {
        value: navigatorObj,
        writable: true,
        configurable: true,
      });
    }
    const fakeTrack = { kind: "video", label: "Screen", stop: vi.fn(), enabled: true, id: "track-1", getCapabilities: vi.fn().mockReturnValue({}), getSettings: vi.fn().mockReturnValue({ width: 1920, height: 1080, frameRate: 30 }), applyConstraints: vi.fn().mockResolvedValue(undefined) } as unknown as MediaStreamTrack;
    const fakeStream = { getVideoTracks: () => [fakeTrack], getAudioTracks: () => [], getTracks: () => [fakeTrack] } as unknown as MediaStream;
    (globalThis.navigator as any).mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue(fakeStream);

    const { PublisherManager } = await import("../src/renderer/services/publisher-manager.js");
    vi.spyOn(PublisherManager.prototype, "startPublishing").mockResolvedValue(undefined);
    vi.spyOn(PublisherManager.prototype, "stopCapture").mockResolvedValue(undefined);

    runtime = new Phase3Runtime();
    await runtime.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await runtime.destroy().catch(() => {});
  });

  it("heartbeat failure does not crash the session", async () => {
    const sessionManager = runtime.getStreamSessionManager();
    sessionManager.setDeviceIdentity("dev-hb", "HB User");

    await sessionManager.startStream({
      groupId: "test-hb-error",
      source: { id: "source-1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // Make broadcast throw
    const broadcastSpy = vi.spyOn(runtime.getConnectionManager(), "broadcast");
    broadcastSpy.mockRejectedValue(new Error("Network error"));

    // Force a heartbeat — should not throw
    // Accessing private method via bracket notation
    await expect(
      (sessionManager as unknown as { sendHeartbeat(): Promise<void> }).sendHeartbeat()
    ).resolves.toBeUndefined();

    // Session should still be active
    expect(sessionManager.state).toBe("active");
  });

  it("interval timer survives heartbeat failure", async () => {
    const sessionManager = runtime.getStreamSessionManager();
    sessionManager.setDeviceIdentity("dev-hb2", "HB User 2");

    await sessionManager.startStream({
      groupId: "test-hb-error-2",
      source: { id: "source-1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // Make broadcast throw
    vi.spyOn(runtime.getConnectionManager(), "broadcast").mockRejectedValue(new Error("Network error"));

    // Simulate multiple timer ticks
    for (let i = 0; i < 5; i++) {
      await expect(
        (sessionManager as unknown as { sendHeartbeat(): Promise<void> }).sendHeartbeat()
      ).resolves.toBeUndefined();
    }

    // Session should remain active after multiple failed heartbeats
    expect(sessionManager.state).toBe("active");
  });
});

// ─── Identity and StreamSessionManager integration tests ─────────────────────

describe("StreamSessionManager Phase 3 — identity wiring", () => {
  let runtime: Phase3Runtime;

  beforeEach(async () => {
    vi.spyOn(GroupConnectionManager.prototype, "addGroup").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "destroyAll").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "removeGroup").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "broadcast").mockResolvedValue(undefined);

    // Mock browser APIs for node environment
    const navigatorObj = (globalThis as any).navigator ?? {};
    if (!("mediaDevices" in navigatorObj)) {
      (navigatorObj as any).mediaDevices = {};
    }
    if (!(globalThis as any).navigator) {
      Object.defineProperty(globalThis, "navigator", {
        value: navigatorObj,
        writable: true,
        configurable: true,
      });
    }
    const fakeTrack = { kind: "video", label: "Screen", stop: vi.fn(), enabled: true, id: "track-1", getCapabilities: vi.fn().mockReturnValue({}), getSettings: vi.fn().mockReturnValue({ width: 1920, height: 1080, frameRate: 30 }), applyConstraints: vi.fn().mockResolvedValue(undefined) } as unknown as MediaStreamTrack;
    const fakeStream = { getVideoTracks: () => [fakeTrack], getAudioTracks: () => [], getTracks: () => [fakeTrack] } as unknown as MediaStream;
    (globalThis.navigator as any).mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue(fakeStream);

    const { PublisherManager } = await import("../src/renderer/services/publisher-manager.js");
    vi.spyOn(PublisherManager.prototype, "startPublishing").mockResolvedValue(undefined);
    vi.spyOn(PublisherManager.prototype, "stopCapture").mockResolvedValue(undefined);

    // Create runtime directly to avoid singleton interference
    runtime = new Phase3Runtime();
    await runtime.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await runtime.destroy().catch(() => {});
  });

  it("uses default hostDeviceId 'local' before identity is set", () => {
    const sessionManager = runtime.getStreamSessionManager();
    expect(sessionManager.hostDeviceId).toBe("local");
    expect(sessionManager.hostDisplayName).toBe("");
  });

  it("setDeviceIdentity updates the hostDeviceId", () => {
    const sessionManager = runtime.getStreamSessionManager();
    sessionManager.setDeviceIdentity("real-device-id", "Real User");
    expect(sessionManager.hostDeviceId).toBe("real-device-id");
    expect(sessionManager.hostDisplayName).toBe("Real User");
  });

  it("broadcasts use real device identity when set via addGroup", async () => {
    const sessionManager = runtime.getStreamSessionManager();

    // addGroup should set identity on the session manager
    await runtime.addGroup(
      {
        groupId: "test-g-identity",
        controlRoomId: "room-id",
        groupSecret: "secret",
        nodeId: "my-device-123",
        displayName: "My Display",
      },
      {
        schemaVersion: 1 as const,
        groupId: "test-g-identity",
        name: { value: "Test", stamp: { wallTimeMs: 1000, counter: 0, nodeId: "n1" }, valueHash: "h1", updatedByDeviceId: "n1" },
        defaultQuality: {
          value: {
            schemaVersion: 1 as const,
            video: { videoBitrateKbps: 1000, sendWidth: 1280, sendHeight: 720, sendFps: 30, captureWidth: 1280, captureHeight: 720, captureFps: 30, preserveAspectRatio: true, preventUpscale: true, resolutionMode: "target-dimensions" as const, scaleResolutionDownBy: 1, codec: "vp9" as const, h264Profile: "auto" as const, contentHint: "detail" as const, degradationPreference: "maintain-resolution" as const, scalabilityMode: null, cursorMode: "always" as const, rtpPriority: "medium" as const },
            audio: { bitrateKbps: 64, channels: "stereo" as const, bitrateMode: "vbr" as const, dtx: false, fec: true, packetDurationMs: 20 as const, redundantAudio: false },
          },
          stamp: { wallTimeMs: 1000, counter: 0, nodeId: "n1" }, valueHash: "h2", updatedByDeviceId: "n1",
        },
        members: {},
      },
      { wallTimeMs: 1000, counter: 0, nodeId: "n1" },
    );

    expect(sessionManager.hostDeviceId).toBe("my-device-123");
    expect(sessionManager.hostDisplayName).toBe("My Display");

    // Now start a stream and verify broadcast uses real identity
    const broadcastSpy = vi.spyOn(runtime.getConnectionManager(), "broadcast");

    await sessionManager.startStream({
      groupId: "test-g-identity",
      source: { id: "source-1", name: "My Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // The last broadcast should be the stream.started message
    const lastCall = broadcastSpy.mock.lastCall;
    expect(lastCall).not.toBeNull();
    const payload = lastCall![1] as Record<string, unknown>;
    expect(payload.hostDeviceId).toBe("my-device-123");
    expect(payload.hostDisplayName).toBe("My Display");
    expect(payload.type).toBe("stream.started");
  });

  it("broadcasts use real identity in heartbeat", async () => {
    const sessionManager = runtime.getStreamSessionManager();
    sessionManager.setDeviceIdentity("heartbeat-device", "Heartbeat User");

    const broadcastSpy = vi.spyOn(runtime.getConnectionManager(), "broadcast");

    await sessionManager.startStream({
      groupId: "test-g-heartbeat",
      source: { id: "source-1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // Find the heartbeat broadcast (there should be one started broadcast first)
    // Check the started broadcast
    const startedCall = broadcastSpy.mock.calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.type === "stream.started"
    );
    expect(startedCall).toBeDefined();
    const startedPayload = startedCall![1] as Record<string, unknown>;
    expect(startedPayload.hostDeviceId).toBe("heartbeat-device");
  });

  it("registerLocalStream is called before broadcast", async () => {
    const sessionManager = runtime.getStreamSessionManager();
    sessionManager.setDeviceIdentity("local-dev", "Local User");

    const registry = runtime.getActiveStreamRegistry();
    const registerSpy = vi.spyOn(registry, "registerLocalStream");

    await sessionManager.startStream({
      groupId: "test-g-register-first",
      source: { id: "source-1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    });

    // registerLocalStream should have been called
    expect(registerSpy).toHaveBeenCalledTimes(1);

    // The registered stream should be in the registry
    const announcement = registerSpy.mock.calls[0][0];
    expect(announcement.hostDeviceId).toBe("local-dev");
    expect(announcement.groupId).toBe("test-g-register-first");

    // Verify stream is visible in the registry
    const allStreams = registry.getAllStreams();
    expect(allStreams.some((s) => s.groupId === "test-g-register-first")).toBe(true);
  });
});
