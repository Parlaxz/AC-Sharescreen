// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";
import { GroupMessageRouter } from "../src/renderer/services/group-message-router.js";
import type { GroupSyncService } from "../src/renderer/services/group-sync-service.js";
import type { ActiveStreamRegistry } from "../src/renderer/services/active-stream-registry.js";
import type { GroupConnectionManager } from "../src/renderer/services/group-connection-manager.js";
import type { ViewerMediaBinding } from "../src/renderer/services/viewer-media-binding.js";
import type { GroupControlEnvelope, HybridTimestamp } from "@screenlink/shared";

// ─── Helpers ───────────────────────────────────────────────────────────────

const GROUP_ID = "test-g-1";

function ts(wallTimeMs: number, counter: number, nodeId: string): HybridTimestamp {
  return { wallTimeMs, counter, nodeId };
}

function makeEnvelope(type: string, payload: unknown, senderDeviceId = "viewer-dev"): GroupControlEnvelope {
  return {
    version: 2,
    type: type as any,
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId,
    groupId: GROUP_ID,
    logicalStamp: ts(Date.now(), 0, senderDeviceId),
    payload: payload as Record<string, unknown>,
    mac: "0".repeat(64),
  };
}

function makeMockRuntime(): any {
  return {
    getActiveStreamRegistry: () => ({
      handleStarted: vi.fn(),
      handleHeartbeat: vi.fn(),
      handleStopped: vi.fn(),
      handleSnapshot: vi.fn(),
      getAllStreams: vi.fn().mockReturnValue([]),
      getStream: vi.fn().mockReturnValue(null),
      registerLocalStream: vi.fn(),
      getStreamsByGroup: vi.fn().mockReturnValue([]),
    }),
    getConnectionManager: () => ({
      broadcast: vi.fn().mockResolvedValue(undefined),
      getConnection: vi.fn().mockReturnValue(null),
    }),
    getStreamSessionManager: () => ({
      currentLogicalStreamId: null,
      currentMediaSessionId: null,
      currentGroupId: null,
      state: "idle",
      getCurrentVdoConfig: () => null,
    }),
    getViewerMediaBinding: () => ({}),
  };
}

describe("Watch Stream Flow (Stage 5)", () => {
  let router: GroupMessageRouter;
  let syncService: any;
  let streamRegistry: any;
  let connManager: any;
  let viewerBinding: any;
  let runtime: Phase3Runtime;

  beforeEach(() => {
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
        sendToPeer: vi.fn().mockResolvedValue(undefined),
        broadcast: vi.fn().mockResolvedValue(undefined),
      }),
    };
    viewerBinding = {
      handleJoinRequest: vi.fn().mockReturnValue({ mediaSessionId: "ms-1", token: "abc123" }),
      handleMediaBind: vi.fn().mockResolvedValue(true),
      consumeBinding: vi.fn().mockResolvedValue(true),
      getViewerMediaPeer: vi.fn().mockReturnValue("peer-uuid"),
      removeViewer: vi.fn(),
      getAllViewers: vi.fn().mockReturnValue([]),
    };

    router = new GroupMessageRouter(
      syncService as any,
      streamRegistry as any,
      connManager as any,
      viewerBinding as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Stage 5: Router ordering ──────────────────────────────────

  it("routes stream.join.request to viewerBinding (not streamRegistry)", () => {
    const envelope = makeEnvelope("stream.join.request", {
      logicalStreamId: "stream-1",
      viewerDeviceId: "viewer-dev",
      viewerDisplayName: "Viewer",
    });

    router.routeMessage(GROUP_ID, envelope);

    // Must go to viewerBinding, not streamRegistry
    expect(viewerBinding.handleJoinRequest).toHaveBeenCalledWith(envelope);
    expect(streamRegistry.handleStarted).not.toHaveBeenCalled();
  });

  it("routes media.bind to viewerBinding", () => {
    const envelope = makeEnvelope("media.bind", {
      token: "some-token",
      mediaSessionId: "ms-1",
    });

    router.routeMessage(GROUP_ID, envelope);

    // The router passes senderDeviceId as peerUuid (for backward compat),
    // and the token
    expect(viewerBinding.handleMediaBind).toHaveBeenCalled();
  });

  it("routes stream.leave to viewerBinding", () => {
    const envelope = makeEnvelope("stream.leave", {
      logicalStreamId: "stream-1",
      viewerDeviceId: "viewer-dev",
    });

    router.routeMessage(GROUP_ID, envelope);

    // Should trigger removeViewer on the binding
    // (or be passed to viewerBinding for handling)
    expect(viewerBinding.removeViewer).toHaveBeenCalledWith("viewer-dev");
  });

  it("routes stream.join.response and resolves pending join with credential fields", async () => {
    const requestId = "req-cred-1";
    const responsePromise = router.waitForJoinResponse(requestId, 5_000);

    const envelope = makeEnvelope("stream.join.response", {
      logicalStreamId: "stream-1",
      accepted: true,
      viewerDeviceId: "viewer-dev",
      mediaJoinMetadata: "token-abc",
      mediaSessionId: "ms-1",
      streamId: "vdo-stream-abc",
      password: "vdo-password-xyz",
      bindingToken: "token-abc",
      requestId,
    });

    router.routeMessage(GROUP_ID, envelope);

    const response = await responsePromise;
    expect(response.accepted).toBe(true);
    expect(response.logicalStreamId).toBe("stream-1");
    expect(response.mediaSessionId).toBe("ms-1");
    expect(response.mediaJoinMetadata).toBe("token-abc");
    expect(response.streamId).toBe("vdo-stream-abc");
    expect(response.password).toBe("vdo-password-xyz");
    expect(response.bindingToken).toBe("token-abc");
    expect(response.requestId).toBe(requestId);
  });

  it("resolves join response even without optional credential fields", async () => {
    const requestId = "req-no-cred";
    const responsePromise = router.waitForJoinResponse(requestId, 5_000);

    const envelope = makeEnvelope("stream.join.response", {
      logicalStreamId: "stream-2",
      accepted: true,
      viewerDeviceId: "viewer-dev",
      requestId,
    });

    router.routeMessage(GROUP_ID, envelope);

    const response = await responsePromise;
    expect(response.accepted).toBe(true);
    expect(response.streamId).toBeUndefined();
    expect(response.password).toBeUndefined();
    expect(response.bindingToken).toBeUndefined();
  });

  it("still routes stream.started to streamRegistry", () => {
    const envelope = makeEnvelope("stream.started", {
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
    });

    router.routeMessage(GROUP_ID, envelope);
    expect(streamRegistry.handleStarted).toHaveBeenCalled();
  });

  it("routes stream.heartbeat to streamRegistry", () => {
    const envelope = makeEnvelope("stream.heartbeat", {
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      heartbeatSequence: 5,
    });

    router.routeMessage(GROUP_ID, envelope);
    expect(streamRegistry.handleHeartbeat).toHaveBeenCalled();
  });

  it("routes stream.stopped to streamRegistry", () => {
    const envelope = makeEnvelope("stream.stopped", {
      groupId: GROUP_ID,
      hostDeviceId: "host-dev",
      logicalStreamId: "stream-1",
    });

    router.routeMessage(GROUP_ID, envelope);
    expect(streamRegistry.handleStopped).toHaveBeenCalled();
  });

  // ─── Viewer join/leave integration ─────────────────────────────

  it("viewer join request via router triggers binding", () => {
    const envelope = makeEnvelope("stream.join.request", {
      logicalStreamId: "stream-1",
      viewerDeviceId: "viewer-dev",
      viewerDisplayName: "Viewer",
    });

    router.routeMessage(GROUP_ID, envelope);
    expect(viewerBinding.handleJoinRequest).toHaveBeenCalledWith(envelope);
  });

  it("multiple viewer joins are tracked independently", () => {
    const env1 = makeEnvelope("stream.join.request", {
      logicalStreamId: "stream-1",
      viewerDeviceId: "viewer-1",
    }, "viewer-1");

    const env2 = makeEnvelope("stream.join.request", {
      logicalStreamId: "stream-1",
      viewerDeviceId: "viewer-2",
    }, "viewer-2");

    router.routeMessage(GROUP_ID, env1);
    router.routeMessage(GROUP_ID, env2);

    expect(viewerBinding.handleJoinRequest).toHaveBeenCalledTimes(2);
    expect(viewerBinding.handleJoinRequest).toHaveBeenCalledWith(env1);
    expect(viewerBinding.handleJoinRequest).toHaveBeenCalledWith(env2);
  });

  // ─── stream.restart.request routing ────────────────────────────

  it("routes stream.restart.request to viewerBinding", () => {
    const envelope = makeEnvelope("stream.restart.request", {
      logicalStreamId: "stream-1",
      reason: "source change",
    });

    // Should route without hitting streamRegistry's generic handler
    router.routeMessage(GROUP_ID, envelope);
    expect(streamRegistry.handleStarted).not.toHaveBeenCalled();
  });

  it("routes stream.restarted to streamRegistry as replacement with full fields", () => {
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
      heartbeatSequence: 1,
      streamRevision: 2,
      mediaJoinMetadata: "",
      replacesSessionId: "ms-1",
    };

    const envelope = makeEnvelope("stream.restarted", payload);

    router.routeMessage(GROUP_ID, envelope);

    // Must reach handleStarted (not silently dropped by schema validation)
    expect(streamRegistry.handleStarted).toHaveBeenCalledTimes(1);

    // The payload passed to handleStarted must include all fields needed
    // for replacement logic, especially replacesSessionId.
    const received = streamRegistry.handleStarted.mock.calls[0][0];
    expect(received.groupId).toBe(GROUP_ID);
    expect(received.hostDeviceId).toBe("host-dev");
    expect(received.logicalStreamId).toBe("stream-1");
    expect(received.mediaSessionId).toBe("ms-2");
    expect(received.replacesSessionId).toBe("ms-1");
    expect(received.heartbeatSequence).toBe(1);
    expect(received.streamRevision).toBe(2);
    expect(received.sourceKind).toBe("screen");
    expect(received.sourceName).toBe("Monitor");
    expect(received.mediaJoinMetadata).toBe("");
  });

  it("routes stream.restart.result to be handled (no-op for now)", () => {
    const envelope = makeEnvelope("stream.restart.result", {
      logicalStreamId: "stream-1",
      success: true,
      mediaSessionId: "ms-2",
    });

    expect(() => router.routeMessage(GROUP_ID, envelope)).not.toThrow();
  });

  // ─── Quality.* routing (future) ─────────────────────────────────

  it("routes quality.* messages without throwing", () => {
    const envelope = makeEnvelope("quality.viewer.request", {
      streamSessionId: "ss-1",
      requestId: "req-1",
      revision: 1,
      videoBitrateKbps: 1000,
      maxWidth: 1280,
      maxHeight: 720,
      maxFps: 30,
      degradationPreference: "maintain-resolution",
    });

    expect(() => router.routeMessage(GROUP_ID, envelope)).not.toThrow();
  });
});
