// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { ActiveStreamRegistry, type StreamAnnouncement } from "../src/renderer/services/active-stream-registry.js";

function makeAnnouncement(overrides: Partial<StreamAnnouncement> = {}): StreamAnnouncement {
  return {
    logicalStreamId: "ls-1",
    mediaSessionId: "ms-1",
    groupId: "g-1",
    hostDeviceId: "host-1",
    hostDisplayName: "Host",
    sourceKind: "screen",
    sourceName: "Display",
    startedAt: Date.now(),
    appliedSettingsRevision: 0,
    heartbeatSequence: 0,
    streamRevision: 1,
    mediaJoinMetadata: "",
    replacesSessionId: null,
    ...overrides,
  };
}

describe("ActiveStreamRegistry long-running liveness (Gate 3.3)", () => {
  it("accepts a stream whose startedAt is several hours old when no tombstone is set", () => {
    const r = new ActiveStreamRegistry(10_000, 30_000);
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    const ann = makeAnnouncement({ startedAt: fourHoursAgo, heartbeatSequence: 1 });
    r.handleStarted(ann);
    const got = r.getStream({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    expect(got).not.toBeNull();
    expect(got?.startedAt).toBe(fourHoursAgo);
  });

  it("snapshot still accepts a multi-hour stream as long as no tombstone exists", () => {
    const r = new ActiveStreamRegistry(10_000, 30_000);
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    r.handleSnapshot([
      makeAnnouncement({
        startedAt: fourHoursAgo,
        heartbeatSequence: 1,
        leaseValidUntil: Date.now() + 30_000,
      }),
    ]);
    const got = r.getStream({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    expect(got).not.toBeNull();
  });

  it("snapshot rejects a stream whose lease is in the past and no heartbeat is recorded", () => {
    const r = new ActiveStreamRegistry(10_000, 30_000);
    r.handleSnapshot([
      makeAnnouncement({
        startedAt: Date.now() - 60_000,
        heartbeatSequence: 5,
        leaseValidUntil: Date.now() - 1000,
      }),
    ]);
    const got = r.getStream({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    expect(got).toBeNull();
  });

  it("heartbeat updates leaseValidUntil and revives liveness for late joiners", () => {
    const r = new ActiveStreamRegistry(10_000, 30_000);
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    r.handleStarted(makeAnnouncement({ startedAt: fourHoursAgo, heartbeatSequence: 1 }));
    r.handleHeartbeat({
      groupId: "g-1",
      hostDeviceId: "host-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      heartbeatSequence: 2,
      leaseValidUntil: Date.now() + 60_000,
    });
    const got = r.getStream({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    expect(got?.leaseValidUntil).toBeGreaterThan(Date.now());
  });

  it("tombstone still blocks resurrection of an old stopped stream", () => {
    const r = new ActiveStreamRegistry(10_000, 30_000);
    r.handleStarted(makeAnnouncement({ startedAt: Date.now() - 4 * 60 * 60 * 1000, heartbeatSequence: 1 }));
    r.handleStopped({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    // A subsequent snapshot for the same composite key must not
    // resurrect the stopped stream.
    r.handleSnapshot([
      makeAnnouncement({
        startedAt: Date.now() - 4 * 60 * 60 * 1000,
        heartbeatSequence: 2,
      }),
    ]);
    const got = r.getStream({ groupId: "g-1", hostDeviceId: "host-1", logicalStreamId: "ls-1" });
    expect(got).toBeNull();
  });
});
