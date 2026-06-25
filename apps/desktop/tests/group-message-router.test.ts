// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GroupMessageRouter } from "../src/renderer/services/group-message-router.js";
import { ActiveStreamRegistry } from "../src/renderer/services/active-stream-registry.js";
import type { GroupSyncService } from "../src/renderer/services/group-sync-service.js";
import type { GroupControlEnvelope, HybridTimestamp } from "@screenlink/shared";
import { QualityCoordinator } from "../src/renderer/services/quality-coordinator.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const GROUP_ID = "test-g-1";

function ts(wallTimeMs: number, counter: number, nodeId: string): HybridTimestamp {
  return { wallTimeMs, counter, nodeId };
}

function makeEnvelope(type: string, payload: unknown, stamp: HybridTimestamp): GroupControlEnvelope {
  return {
    version: 2,
    type: type as any,
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId: "sender-dev",
    groupId: GROUP_ID,
    logicalStamp: stamp,
    payload: payload as Record<string, unknown>,
    mac: "0".repeat(64),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("GroupMessageRouter payload validation", () => {
  let router: GroupMessageRouter;
  let syncService: any;
  let streamRegistry: any;
  let connManager: any;

  beforeEach(() => {
    syncService = {
      handleGroupMessage: vi.fn(),
    };
    streamRegistry = {
      handleStarted: vi.fn(),
      handleHeartbeat: vi.fn(),
      handleStopped: vi.fn(),
      handleSnapshot: vi.fn(),
      getAllStreams: vi.fn().mockReturnValue([]),
    };
    connManager = {
      getConnection: vi.fn().mockReturnValue({
        peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
        sendToPeer: vi.fn(),
      }),
    };

    router = new GroupMessageRouter(syncService as any, streamRegistry as any, connManager as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes valid group.state.update to syncService", () => {
    const envelope = makeEnvelope("group.state.update", {
      state: {
        name: { value: "Room", stamp: ts(100, 0, "dev"), valueHash: "abc", updatedByDeviceId: "dev" },
      },
    }, ts(100, 0, "dev"));

    router.routeMessage(GROUP_ID, envelope);
    expect(syncService.handleGroupMessage).toHaveBeenCalledWith(GROUP_ID, envelope);
  });

  it("routes valid group.member.update to syncService", () => {
    const envelope = makeEnvelope("group.member.update", {
      member: { deviceId: "dev-1", displayName: "Alice", firstSeenAt: 1000, profileStamp: ts(100, 0, "dev") },
    }, ts(100, 0, "dev"));

    router.routeMessage(GROUP_ID, envelope);
    expect(syncService.handleGroupMessage).toHaveBeenCalledWith(GROUP_ID, envelope);
  });

  it("routes valid ping to connection manager", () => {
    const envelope = makeEnvelope("ping", { seq: 1 }, ts(100, 0, "dev"));

    // Should not throw
    expect(() => router.routeMessage(GROUP_ID, envelope)).not.toThrow();
    // ping is handled by the router itself (not syncService)
    expect(syncService.handleGroupMessage).not.toHaveBeenCalled();
  });

  it("routes valid pong to connection manager", () => {
    const envelope = makeEnvelope("pong", { seq: 1 }, ts(100, 0, "dev"));

    expect(() => router.routeMessage(GROUP_ID, envelope)).not.toThrow();
    expect(syncService.handleGroupMessage).not.toHaveBeenCalled();
  });

  it("ignores unknown message types gracefully", () => {
    const envelope = makeEnvelope("unknown.type" as any, {}, ts(100, 0, "dev"));
    expect(() => router.routeMessage(GROUP_ID, envelope)).not.toThrow();
  });

  it("rejects malformed payload for known type (no syncService call)", () => {
    // Valid envelope type but invalid payload (missing required fields)
    const envelope = makeEnvelope("group.member.update", {
      member: { deviceId: "d1" }, // missing displayName, firstSeenAt, profileStamp
    }, ts(100, 0, "dev"));

    router.routeMessage(GROUP_ID, envelope);

    // syncService should NOT be called — malformed payload rejected by schema check
    expect(syncService.handleGroupMessage).not.toHaveBeenCalled();
  });

  it("rejects null payload for known type", () => {
    const envelope = makeEnvelope("ping", null, ts(100, 0, "dev"));

    router.routeMessage(GROUP_ID, envelope);
    expect(syncService.handleGroupMessage).not.toHaveBeenCalled();
  });

  it("routes stream.started to streamRegistry", () => {
    const envelope = makeEnvelope("stream.started", {
      logicalStreamId: "stream-1",
      mediaSessionId: "session-1",
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      hostDisplayName: "Host",
      sourceKind: "screen",
      sourceName: "Monitor",
      startedAt: 1000,
      appliedSettingsRevision: 1,
      heartbeatSequence: 1,
      streamRevision: 1,
      mediaJoinMetadata: "meta",
      replacesSessionId: null,
    }, ts(100, 0, "host-dev"));

    router.routeMessage(GROUP_ID, envelope);
    expect(streamRegistry.handleStarted).toHaveBeenCalled();
  });

  it("routes stream.heartbeat to streamRegistry", () => {
    const envelope = makeEnvelope("stream.heartbeat", {
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      logicalStreamId: "stream-1",
      mediaSessionId: "session-1",
      heartbeatSequence: 5,
    }, ts(100, 0, "host-dev"));

    router.routeMessage(GROUP_ID, envelope);
    expect(streamRegistry.handleHeartbeat).toHaveBeenCalled();
  });

  it("routes stream.stopped to streamRegistry", () => {
    const envelope = makeEnvelope("stream.stopped", {
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      logicalStreamId: "stream-1",
    }, ts(100, 0, "host-dev"));

    router.routeMessage(GROUP_ID, envelope);
    expect(streamRegistry.handleStopped).toHaveBeenCalled();
  });

  // ─── stream.restarted replacement routing ────────────────────────

  it("routes stream.restarted to streamRegistry with full replacement fields", () => {
    const payload = {
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-2",
      previousMediaSessionId: "ms-1",
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      hostDisplayName: "Host",
      sourceKind: "screen",
      sourceName: "Monitor",
      startedAt: 2000,
      appliedSettingsRevision: 0,
      heartbeatSequence: 5,
      streamRevision: 2,
      mediaJoinMetadata: "",
      replacesSessionId: "ms-1",
    };

    const envelope = makeEnvelope("stream.restarted", payload, ts(100, 0, "host-dev"));

    router.routeMessage(GROUP_ID, envelope);

    // Must reach handleStarted
    expect(streamRegistry.handleStarted).toHaveBeenCalledTimes(1);

    // payload fields are preserved through Zod validation and routing
    const received = streamRegistry.handleStarted.mock.calls[0][0];
    expect(received.logicalStreamId).toBe("stream-1");
    expect(received.mediaSessionId).toBe("ms-2");
    expect(received.groupId).toBe(GROUP_ID);
    expect(received.hostDeviceId).toBe("host-dev");
    expect(received.hostDisplayName).toBe("Host");
    expect(received.sourceKind).toBe("screen");
    expect(received.sourceName).toBe("Monitor");
    expect(received.startedAt).toBe(2000);
    expect(received.heartbeatSequence).toBe(5);
    expect(received.streamRevision).toBe(2);
    expect(received.mediaJoinMetadata).toBe("");
    // replacesSessionId is the key field for replacement detection
    expect(received.replacesSessionId).toBe("ms-1");
    // previousMediaSessionId is also preserved for traceability
    expect(received.previousMediaSessionId).toBe("ms-1");
  });

  it("rejects stream.restarted with missing required fields", () => {
    // Missing sourceKind, sourceName, mediaJoinMetadata — Zod strips
    const envelope = makeEnvelope("stream.restarted", {
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-2",
    }, ts(100, 0, "host-dev"));

    router.routeMessage(GROUP_ID, envelope);

    // handleStarted should NOT be called — schema rejects incomplete payload
    expect(streamRegistry.handleStarted).not.toHaveBeenCalled();
  });
});

// ─── stream.restarted replacement via real ActiveStreamRegistry ──────

describe("stream.restarted replacement through GroupMessageRouter → ActiveStreamRegistry", () => {
  let registry: ActiveStreamRegistry;
  let router: GroupMessageRouter;
  let syncService: any;
  let connManager: any;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
    syncService = {
      handleGroupMessage: vi.fn(),
    };
    connManager = {
      getConnection: vi.fn().mockReturnValue({
        peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
        sendToPeer: vi.fn(),
      }),
    };
    router = new GroupMessageRouter(syncService as any, registry as any, connManager as any);
  });

  afterEach(() => {
    registry.destroy();
    vi.restoreAllMocks();
  });

  function makeRestartedEnvelope(overrides: Record<string, unknown> = {}): GroupControlEnvelope {
    return makeEnvelope("stream.restarted", {
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-2",
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      hostDisplayName: "Host",
      sourceKind: "screen",
      sourceName: "Monitor",
      startedAt: 2000,
      appliedSettingsRevision: 0,
      heartbeatSequence: 5,
      streamRevision: 2,
      mediaJoinMetadata: "",
      replacesSessionId: "ms-1",
      ...overrides,
    }, ts(100, 0, "host-dev"));
  }

  it("routes stream.restarted with replacesSessionId and registry emits 'replaced'", () => {
    // 1. First, establish a stream via stream.started
    const startedEnvelope = makeEnvelope("stream.started", {
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      hostDisplayName: "Host",
      sourceKind: "screen",
      sourceName: "Monitor",
      startedAt: 1000,
      appliedSettingsRevision: 0,
      heartbeatSequence: 1,
      streamRevision: 1,
      mediaJoinMetadata: "",
      replacesSessionId: null,
    }, ts(100, 0, "host-dev"));
    router.routeMessage(GROUP_ID, startedEnvelope);

    const preStreams = registry.getAllStreams();
    expect(preStreams).toHaveLength(1);
    expect(preStreams[0].mediaSessionId).toBe("ms-1");

    // 2. Listen for registry updates
    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(`${u.type}:${u.stream.mediaSessionId}:replacesSessionId=${u.stream.replacesSessionId}`));

    // 3. Route stream.restarted with replacesSessionId pointing to ms-1
    const restartedEnvelope = makeRestartedEnvelope();
    router.routeMessage(GROUP_ID, restartedEnvelope);

    // 4. Verify stream was replaced (not added as new)
    expect(updates).toContain("replaced:ms-2:replacesSessionId=ms-1");

    // 5. Verify the registry has exactly one stream with updated fields
    const postStreams = registry.getAllStreams();
    expect(postStreams).toHaveLength(1);
    expect(postStreams[0].mediaSessionId).toBe("ms-2");
    expect(postStreams[0].heartbeatSequence).toBe(5);
    expect(postStreams[0].streamRevision).toBe(2);
    expect(postStreams[0].replacesSessionId).toBe("ms-1");
  });

  it("routes stream.restarted with replacesSessionId=null (no replacement)", () => {
    // Establish a stream first
    const startedEnvelope = makeEnvelope("stream.started", {
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      hostDisplayName: "Host",
      sourceKind: "screen",
      sourceName: "Monitor",
      startedAt: 1000,
      appliedSettingsRevision: 0,
      heartbeatSequence: 1,
      streamRevision: 1,
      mediaJoinMetadata: "",
      replacesSessionId: null,
    }, ts(100, 0, "host-dev"));
    router.routeMessage(GROUP_ID, startedEnvelope);

    const updates: string[] = [];
    registry.onUpdate((u) => updates.push(`${u.type}:${u.stream.mediaSessionId}`));

    // Route stream.restarted with replacesSessionId=null — should NOT trigger replacement
    const restartedEnvelope = makeRestartedEnvelope({ replacesSessionId: null, mediaSessionId: "ms-2a" });
    router.routeMessage(GROUP_ID, restartedEnvelope);

    // With replacesSessionId=null, the registry treats it as a sequence-update or new
    // Since same composite key exists, heartbeat seq (5) > last seq (1), it emits "updated"
    expect(updates).toContain("updated:ms-2a");
    const postStreams = registry.getAllStreams();
    expect(postStreams).toHaveLength(1);
    expect(postStreams[0].replacesSessionId).toBeNull();
  });

  it("rejects stream.restarted when replacesSessionId is missing from payload", () => {
    // Missing replacesSessionId entirely — Zod should reject due to required field
    const envelope = makeEnvelope("stream.restarted", {
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-2",
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      hostDisplayName: "Host",
      sourceKind: "screen",
      sourceName: "Monitor",
      startedAt: 2000,
      appliedSettingsRevision: 0,
      heartbeatSequence: 5,
      streamRevision: 2,
      mediaJoinMetadata: "",
      // no replacesSessionId
    }, ts(100, 0, "host-dev"));

    // Must be rejected since replacesSessionId is now required (not optional)
    const preCount = registry.getAllStreams().length;
    router.routeMessage(GROUP_ID, envelope);
    expect(registry.getAllStreams()).toHaveLength(preCount);
  });
});

// ─── Stage 6: Quality message routing tests ──────────────────────────────

describe("Stage 6: Quality message routing through GroupMessageRouter", () => {
  let router: GroupMessageRouter;
  let syncService: any;
  let streamRegistry: any;
  let connManager: any;
  let qualityCoordinator: QualityCoordinator;

  beforeEach(() => {
    qualityCoordinator = new QualityCoordinator();
    syncService = { handleGroupMessage: vi.fn() };
    streamRegistry = {
      handleStarted: vi.fn(),
      handleHeartbeat: vi.fn(),
      handleStopped: vi.fn(),
      handleSnapshot: vi.fn(),
      getAllStreams: vi.fn().mockReturnValue([]),
    };
    connManager = {
      getConnection: vi.fn().mockReturnValue({
        peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
        sendToPeer: vi.fn(),
      }),
    };

    router = new GroupMessageRouter(
      syncService as any,
      streamRegistry as any,
      connManager as any,
      undefined,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes quality.viewer.request to qualityCoordinator", () => {
    // The router should forward quality.viewer.request to the quality coordinator
    // This test verifies the integration: the router must have a setQualityCoordinator
    // or receive it via constructor, and forward quality messages.
    expect(typeof router.setQualityCoordinator).toBe("function");
  });

  it("routes quality.viewer.clear to qualityCoordinator", () => {
    const envelope = makeEnvelope("quality.viewer.clear", {
      streamSessionId: "session-1",
    }, ts(100, 0, "viewer-dev"));

    // Should not throw when no quality coordinator is set
    expect(() => router.routeMessage(GROUP_ID, envelope)).not.toThrow();
  });

  it("routes quality.effective broadcast messages", () => {
    const envelope = makeEnvelope("quality.effective", {
      streamSessionId: "session-1",
      videoBitrateKbps: 2000,
    }, ts(100, 0, "host-dev"));

    expect(() => router.routeMessage(GROUP_ID, envelope)).not.toThrow();
  });

  it("routes quality.configured broadcast messages", () => {
    const envelope = makeEnvelope("quality.configured", {
      streamSessionId: "session-1",
      videoBitrateKbps: 1500,
    }, ts(100, 0, "host-dev"));

    expect(() => router.routeMessage(GROUP_ID, envelope)).not.toThrow();
  });

  it("routes quality.observed broadcast messages", () => {
    const envelope = makeEnvelope("quality.observed", {
      streamSessionId: "session-1",
      videoBitrateKbps: 1200,
    }, ts(100, 0, "host-dev"));

    expect(() => router.routeMessage(GROUP_ID, envelope)).not.toThrow();
  });

  it("forwards quality.viewer.request to coordinator when set", () => {
    const envelope = makeEnvelope("quality.viewer.request", {
      streamSessionId: "session-1",
      requestId: "req-1",
      revision: 1,
      videoBitrateKbps: 2000,
      maxWidth: 1280,
      maxHeight: 720,
      maxFps: 30,
      degradationPreference: "balanced",
      requestedAt: Date.now(),
    }, ts(100, 0, "sender-dev"));

    const coordinatorSpy = vi.spyOn(qualityCoordinator, 'handleViewerRequest');
    router.setQualityCoordinator(qualityCoordinator);
    router.routeMessage(GROUP_ID, envelope);

    // Must forward to coordinator with correct parameters:
    // groupId, logicalStreamId (from streamSessionId), viewerDeviceId (senderDeviceId), payload
    expect(coordinatorSpy).toHaveBeenCalledWith(
      GROUP_ID,
      "session-1",                       // logicalStreamId from streamSessionId
      "sender-dev",                      // senderDeviceId
      expect.objectContaining({
        streamSessionId: "session-1",
        videoBitrateKbps: 2000,
      }),
    );
  });

  it("routes quality.viewer.request with coordinator set handles correctly", () => {
    const envelope = makeEnvelope("quality.viewer.request", {
      streamSessionId: "session-1",
      requestId: "req-2",
      revision: 1,
      videoBitrateKbps: 3000,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 30,
      degradationPreference: "maintain-resolution",
      requestedAt: Date.now(),
    }, ts(100, 0, "sender-dev"));

    const coordinatorSpy = vi.spyOn(qualityCoordinator, 'handleViewerRequest');
    router.setQualityCoordinator(qualityCoordinator);
    router.routeMessage(GROUP_ID, envelope);

    // The coordinator should receive groupId, logicalStreamId, viewerDeviceId, payload
    expect(coordinatorSpy).toHaveBeenCalledWith(
      GROUP_ID,
      "session-1",                       // logicalStreamId
      "sender-dev",                      // senderDeviceId
      expect.objectContaining({
        streamSessionId: "session-1",
        videoBitrateKbps: 3000,
      }),
    );
  });

  it("routes quality.viewer.clear to coordinator's handleViewerClear", () => {
    const envelope = makeEnvelope("quality.viewer.clear", {
      streamSessionId: "session-1",
    }, ts(100, 0, "sender-dev"));

    const clearSpy = vi.spyOn(qualityCoordinator, 'handleViewerClear');
    router.setQualityCoordinator(qualityCoordinator);
    router.routeMessage(GROUP_ID, envelope);

    // Must forward to handleViewerClear with groupId, logicalStreamId, viewerDeviceId
    expect(clearSpy).toHaveBeenCalledWith(
      GROUP_ID,
      "session-1",    // logicalStreamId from streamSessionId
      "sender-dev",   // senderDeviceId (from envelope)
    );
    // Only handleViewerClear should have been called, not handleViewerRequest
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("quality.viewer.clear does not overwrite with defaults when coordinator set", () => {
    // First, store a request
    router.setQualityCoordinator(qualityCoordinator);

    // Send a request via router (envelope senderDeviceId = "sender-dev")
    const reqEnvelope = makeEnvelope("quality.viewer.request", {
      streamSessionId: "session-1",
      requestId: "req-1",
      revision: 1,
      videoBitrateKbps: 4000,
      maxWidth: 1920, maxHeight: 1080, maxFps: 30,
      degradationPreference: "balanced",
      requestedAt: Date.now(),
    }, ts(100, 0, "sender-dev"));
    router.routeMessage(GROUP_ID, reqEnvelope);

    // Verify stored (keyed by groupId + streamSessionId + senderDeviceId from envelope)
    const stored = qualityCoordinator.getViewerRequest(GROUP_ID, "session-1", "sender-dev");
    expect(stored?.videoBitrateKbps).toBe(4000);

    // Now send clear
    const clearEnvelope = makeEnvelope("quality.viewer.clear", {
      streamSessionId: "session-1",
    }, ts(100, 0, "sender-dev"));
    router.routeMessage(GROUP_ID, clearEnvelope);

    // After clear, request should be null (not overwritten with zeros)
    const afterClear = qualityCoordinator.getViewerRequest(GROUP_ID, "session-1", "sender-dev");
    expect(afterClear).toBeNull();
  });
});
