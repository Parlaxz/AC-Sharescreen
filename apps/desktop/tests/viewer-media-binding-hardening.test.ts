// @vitest-environment node
/**
 * Hardening tests for ViewerMediaBinding — lifecycle invariants, retry
 * bounds, token TTL, stale mapping cleanup, and pause/resume operation
 * correlation not covered by the primary test suite.
 *
 * These tests characterize the current behavior without assuming correctness.
 * Only tests that fail against the current source force production changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ViewerMediaBinding } from "../src/renderer/services/viewer-media-binding.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";
import type { GroupControlEnvelope } from "@screenlink/shared";

// ─── Helpers (mirrors viewer-media-binding.test.ts) ────────────────────────

function makeMockRuntime(): Phase3Runtime {
  const registry = {
    registerLocalStream: vi.fn(),
    handleStopped: vi.fn(),
    getStream: vi.fn().mockReturnValue(null),
    getAllStreams: vi.fn().mockReturnValue([]),
    getStreamsByGroup: vi.fn().mockReturnValue([]),
    onUpdate: vi.fn(),
    destroy: vi.fn(),
  };
  const mockSendToPeer = vi.fn().mockResolvedValue(undefined);
  const connManager = {
    broadcast: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue({
      sendToPeer: mockSendToPeer,
      peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
    }),
    peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
    sendToPeer: mockSendToPeer,
  };
  const ssm = {
    currentLogicalStreamId: "local-stream-1",
    currentMediaSessionId: "media-session-1",
    currentGroupId: "group-1",
    state: "active",
    getCurrentVdoConfig: vi.fn(() => ({
      streamId: "vdo-stream-abc",
      password: "vdo-password-xyz",
    })),
    getPublisherManager: vi.fn().mockReturnValue({
      getPublisher: vi.fn().mockReturnValue(null),
    }),
    getCaptureStream: vi.fn().mockReturnValue(null),
  };
  const mediaStatsService = {
    startViewerPoller: vi.fn(),
    stopViewerPoller: vi.fn(),
    disconnectViewer: vi.fn(),
    hasViewerPoller: vi.fn().mockReturnValue(false),
    stopAllViewerPollers: vi.fn(),
  };
  const resolveLocalPublication = vi.fn().mockImplementation((_mediaSessionId: string) => {
    const vdoConfig = ssm.getCurrentVdoConfig();
    if (vdoConfig) {
      return {
        mediaSessionId: _mediaSessionId,
        logicalStreamId: ssm.currentLogicalStreamId ?? "",
        publisherManager: null as any,
        vdoConfig,
      };
    }
    return null;
  });
  return {
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ssm,
    getViewerMediaBinding: () => ({} as any),
    getMediaStatsService: () => mediaStatsService,
    getQualityCoordinator: () => null,
    getSyncService: () => ({ getSyncState: vi.fn().mockReturnValue(null) }),
    getHostQualityLimits: () => ({
      maxVideoBitrateKbps: 20000, maxWidth: 3840, maxHeight: 2160,
      maxFps: 60, allowViewerQualityRequests: true,
    }),
    resolveLocalPublication,
    getCompareSessionManager: vi.fn().mockReturnValue(null),
    deviceId: "real-host-device",
    displayName: "Real Host",
    ssm, // expose for test assertions
  } as unknown as Phase3Runtime & { ssm: typeof ssm };
}

function makeJoinRequestEnvelope(
  groupId: string,
  senderDeviceId: string,
  logicalStreamId: string,
  viewerSessionId?: string,
): GroupControlEnvelope {
  return {
    version: 2,
    type: "stream.join.request" as any,
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId,
    groupId,
    logicalStamp: { wallTimeMs: Date.now(), counter: 0, nodeId: senderDeviceId },
    payload: {
      logicalStreamId,
      viewerDeviceId: senderDeviceId,
      viewerDisplayName: "Viewer",
      viewerSessionId: viewerSessionId ?? crypto.randomUUID(),
    } as Record<string, unknown>,
    mac: "0".repeat(64),
  };
}

/** Seed a ready-to-bind stream in the registry. */
function seedStream(registry: ReturnType<typeof makeMockRuntime>["getActiveStreamRegistry"]) {
  vi.spyOn(registry, "getStream").mockReturnValue({
    logicalStreamId: "stream-1",
    mediaSessionId: "ms-1",
    groupId: "g-1",
    hostDeviceId: "local",
    hostDisplayName: "Host",
    sourceKind: "screen",
    sourceName: "Screen",
    startedAt: 1000,
    appliedSettingsRevision: 0,
    heartbeatSequence: 1,
    streamRevision: 1,
    mediaJoinMetadata: "",
    replacesSessionId: null,
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("ViewerMediaBinding — consume/bind after destroy", () => {
  let binding: ViewerMediaBinding;
  let runtime: Phase3Runtime;
  let registry: ReturnType<typeof makeMockRuntime>["getActiveStreamRegistry"];

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = makeMockRuntime();
    binding = new ViewerMediaBinding(runtime);
    registry = runtime.getActiveStreamRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    binding.destroy();
  });

  it("consumeBinding returns false when binding is destroyed", async () => {
    binding.destroy();
    const result = await binding.consumeBinding({
      token: "any-token",
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-1",
    });
    expect(result).toBe(false);
  });

  it("handleMediaBind returns false when binding is destroyed", async () => {
    binding.destroy();
    const result = await binding.handleMediaBind("peer-uuid", "any-token");
    expect(result).toBe(false);
  });

  it("destroy does not throw when called multiple times", () => {
    binding.destroy();
    expect(() => binding.destroy()).not.toThrow();
  });
});

// ─── Token TTL cleanup ─────────────────────────────────────────────────────

describe("ViewerMediaBinding — token TTL cleanup", () => {
  let binding: ViewerMediaBinding;
  let runtime: Phase3Runtime;
  let registry: ReturnType<typeof makeMockRuntime>["getActiveStreamRegistry"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    runtime = makeMockRuntime();
    binding = new ViewerMediaBinding(runtime);
    registry = runtime.getActiveStreamRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    binding.destroy();
  });

  it("expired tokens are cleaned by periodic timer", () => {
    seedStream(registry);
    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();
    expect(binding.getBindingToken(result!.token)).toBeDefined();

    // Advance time past the TOKEN_TTL_MS (60s) + CLEANUP_INTERVAL_MS (30s)
    vi.advanceTimersByTime(100_000);

    // Token should have been cleaned up by the periodic timer
    expect(binding.getBindingToken(result!.token)).toBeUndefined();
  });

  it("expired token is rejected by handleMediaBind", async () => {
    seedStream(registry);
    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    // Manually expire the token
    const storedToken = binding.getBindingToken(result!.token);
    (storedToken as any).expiresAt = Date.now() - 1;

    // handleMediaBind should reject expired token
    const bindResult = await binding.handleMediaBind("peer-uuid-1", result!.token);
    expect(bindResult).toBe(false);
  });

  it("expired token is rejected by consumeBinding", async () => {
    seedStream(registry);
    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    // Manually expire the token
    const storedToken = binding.getBindingToken(result!.token);
    (storedToken as any).expiresAt = Date.now() - 1;

    const consumeResult = await binding.consumeBinding({
      token: result!.token,
      viewerDeviceId: "viewer-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-1",
    });
    expect(consumeResult).toBe(false);
  });
});

// ─── Stale mapping cleanup ─────────────────────────────────────────────────

describe("ViewerMediaBinding — stale mapping cleanup", () => {
  let binding: ViewerMediaBinding;
  let runtime: Phase3Runtime;
  let registry: ReturnType<typeof makeMockRuntime>["getActiveStreamRegistry"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    runtime = makeMockRuntime();
    binding = new ViewerMediaBinding(runtime);
    registry = runtime.getActiveStreamRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    binding.destroy();
  });

  /**
   * When the same viewer device binds a new media session for the SAME
   * logical stream (e.g. host restarted with a new publication), the old
   * mapping must be removed so viewer tracking does not leak.
   *
   * This is distinct from compare mode where one device holds A+B mappings
   * for DIFFERENT logical streams simultaneously.
   */
  it("cleans stale mapping when same viewer and logical stream binds new mediaSessionId", async () => {
    // Seed registry with two media sessions for the same logical stream
    const getStreamSpy = vi.spyOn(registry, "getStream");
    getStreamSpy.mockImplementation(({ logicalStreamId }: { logicalStreamId: string }) => {
      if (logicalStreamId === "stream-1") {
        return {
          logicalStreamId: "stream-1",
          mediaSessionId: "ms-1",
          groupId: "g-1",
          hostDeviceId: "local",
          hostDisplayName: "Host",
          sourceKind: "screen",
          sourceName: "Screen",
          startedAt: 1000,
          appliedSettingsRevision: 0,
          heartbeatSequence: 1,
          streamRevision: 1,
          mediaJoinMetadata: "",
          replacesSessionId: null,
        };
      }
      return null;
    });

    // Produce a publisher that has no senders (so consumeBinding does not crash
    // trying to resolve SDK connections that may not exist in the mock).
    const mockPublisher = { getSDK: vi.fn().mockReturnValue({ connections: new Map() }) };
    const mockPubManager = { getPublisher: vi.fn().mockReturnValue(mockPublisher) };
    const { ssm } = runtime as unknown as { ssm: { getPublisherManager: any } };
    ssm.getPublisherManager = vi.fn().mockReturnValue(mockPubManager);

    // Bind viewer-1 to ms-1 (original session)
    const env1 = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const r1 = binding.handleJoinRequest(env1);
    expect(r1).not.toBeNull();
    await binding.handleMediaBind("peer-uuid-1", r1!.token);

    // Sanity: mapping for viewer-1::ms-1 exists
    const mapping1 = binding.getViewerMapping("viewer-1", "ms-1");
    expect(mapping1).not.toBeNull();
    expect(mapping1!.mediaSessionId).toBe("ms-1");

    // Now simulate host restart: same viewer device, same logical stream,
    // but a NEW media session (ms-2). The registry now points to ms-2.
    getStreamSpy.mockImplementation(({ logicalStreamId }: { logicalStreamId: string }) => {
      if (logicalStreamId === "stream-1") {
        return {
          logicalStreamId: "stream-1",
          mediaSessionId: "ms-2",
          groupId: "g-1",
          hostDeviceId: "local",
          hostDisplayName: "Host",
          sourceKind: "screen",
          sourceName: "Screen",
          startedAt: 2000,
          appliedSettingsRevision: 0,
          heartbeatSequence: 2,
          streamRevision: 2,
          mediaJoinMetadata: "",
          replacesSessionId: "ms-1",
        };
      }
      return null;
    });

    // Bind viewer-1 to ms-2 (new session, same logical stream)
    const env2 = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const r2 = binding.handleJoinRequest(env2);
    expect(r2).not.toBeNull();
    await binding.handleMediaBind("peer-uuid-2", r2!.token);

    // The OLD mapping (viewer-1::ms-1) must have been cleaned up
    expect(binding.getViewerMapping("viewer-1", "ms-1")).toBeNull();

    // The NEW mapping (viewer-1::ms-2) must exist
    const mapping2 = binding.getViewerMapping("viewer-1", "ms-2");
    expect(mapping2).not.toBeNull();
    expect(mapping2!.mediaSessionId).toBe("ms-2");
    expect(mapping2!.mediaPeerUuid).toBe("peer-uuid-2");
  });

  it("does NOT clean mappings for different logical streams (compare mode safety)", async () => {
    // Two streams in the registry with different logical IDs
    const getStreamSpy = vi.spyOn(registry, "getStream");
    getStreamSpy.mockImplementation(({ logicalStreamId }: { logicalStreamId: string }) => {
      if (logicalStreamId === "stream-a") {
        return {
          logicalStreamId: "stream-a", mediaSessionId: "ms-a",
          groupId: "g-1", hostDeviceId: "local", hostDisplayName: "Host",
          sourceKind: "screen", sourceName: "Screen A", startedAt: 1000,
          appliedSettingsRevision: 0, heartbeatSequence: 1, streamRevision: 1,
          mediaJoinMetadata: "", replacesSessionId: null,
        };
      }
      if (logicalStreamId === "stream-b") {
        return {
          logicalStreamId: "stream-b", mediaSessionId: "ms-b",
          groupId: "g-1", hostDeviceId: "local", hostDisplayName: "Host",
          sourceKind: "screen", sourceName: "Screen B", startedAt: 1000,
          appliedSettingsRevision: 0, heartbeatSequence: 1, streamRevision: 1,
          mediaJoinMetadata: "", replacesSessionId: null,
        };
      }
      return null;
    });

    const mockPublisher = { getSDK: vi.fn().mockReturnValue({ connections: new Map() }) };
    const mockPubManager = { getPublisher: vi.fn().mockReturnValue(mockPublisher) };
    const { ssm } = runtime as unknown as { ssm: { getPublisherManager: any } };
    ssm.getPublisherManager = vi.fn().mockReturnValue(mockPubManager);

    // Viewer-1 binds stream-a (ms-a)
    const envA = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-a");
    await binding.handleMediaBind("peer-uuid-a", binding.handleJoinRequest(envA)!.token);

    // Viewer-1 binds stream-b (ms-b) — different logical stream
    const envB = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-b");
    await binding.handleMediaBind("peer-uuid-b", binding.handleJoinRequest(envB)!.token);

    // Both mappings should still exist (different logical streams)
    expect(binding.getViewerMapping("viewer-1", "ms-a")).not.toBeNull();
    expect(binding.getViewerMapping("viewer-1", "ms-b")).not.toBeNull();
    expect(binding.getAllViewers()).toHaveLength(2);
  });
});

// ─── Sender-resolution retry lifecycle ─────────────────────────────────────

describe("ViewerMediaBinding — sender-resolution retry lifecycle", () => {
  let binding: ViewerMediaBinding;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    runtime = makeMockRuntime();
    binding = new ViewerMediaBinding(runtime);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    binding.destroy();
  });

  it("retry stops on success (sender resolved)", async () => {
    // Seed a mapping with null videoSender (as if media.bind arrived before sender ready)
    const mapping = {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: null,
      audioSender: null,
    };
    (binding as any).viewerMap.set("viewer-1::ms-1", mapping);

    // resolveSendersForMapping will succeed on second attempt
    let callCount = 0;
    vi.spyOn(binding as any, "resolveSendersForMapping").mockImplementation((target: any) => {
      callCount++;
      if (callCount >= 2) {
        target.videoSender = {
          track: { kind: "video" },
          getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
          setParameters: vi.fn(),
        };
        target.audioSender = null;
        return true;
      }
      return false;
    });
    vi.spyOn(binding as any, "reconcileViewerQuality").mockResolvedValue({
      status: "applied" as const,
      configured: {
        maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1,
        degradationPreference: "balanced", priority: "medium",
      },
    });

    (binding as any).retryResolveSender("viewer-1", "ms-1", "peer-uuid-1");

    // Advance just enough for first attempt (fails) and second attempt (succeeds)
    await vi.advanceTimersByTimeAsync(100);

    // resolveSendersForMapping was called twice (first failure, second success)
    expect(callCount).toBeGreaterThanOrEqual(2);

    // After success, no more calls should happen
    const countAfterSuccess = callCount;
    await vi.advanceTimersByTimeAsync(2000);
    expect(callCount).toBe(countAfterSuccess);
  });

  it("retry stops on mapping removal", async () => {
    const mapping = {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: null,
      audioSender: null,
    };
    (binding as any).viewerMap.set("viewer-1::ms-1", mapping);

    // Always fail (sender never resolves)
    vi.spyOn(binding as any, "resolveSendersForMapping").mockReturnValue(false);

    (binding as any).retryResolveSender("viewer-1", "ms-1", "peer-uuid-1");

    // Let a few retries happen
    await vi.advanceTimersByTimeAsync(200);

    // Remove the mapping while retry is active
    binding.removeViewerMapping("viewer-1", "ms-1");
    expect(binding.getViewerMapping("viewer-1", "ms-1")).toBeNull();

    const countBefore = (binding as any).resolveSendersForMapping.mock.calls.length;

    // Advance more time — no additional calls after mapping removal
    await vi.advanceTimersByTimeAsync(2000);

    const countAfter = (binding as any).resolveSendersForMapping.mock.calls.length;
    expect(countAfter).toBe(countBefore);
  });

  it("retry stops on max attempts", async () => {
    const mapping = {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: null,
      audioSender: null,
    };
    (binding as any).viewerMap.set("viewer-1::ms-1", mapping);

    const resolveSpy = vi.spyOn(binding as any, "resolveSendersForMapping").mockReturnValue(false);

    (binding as any).retryResolveSender("viewer-1", "ms-1", "peer-uuid-1");

    // SENDER_RETRY_MAX = 40 attempts at 50ms intervals = 2000ms total
    await vi.advanceTimersByTimeAsync(5000);

    // Should not exceed max attempts
    // First call is at t=0 (initial), then attempts at 50ms intervals
    // Max 40 retries means at most 41 calls (1 initial + 40 retries)
    expect(resolveSpy.mock.calls.length).toBeLessThanOrEqual(41);

    // After max attempts, no more calls
    const countAfterMax = resolveSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolveSpy.mock.calls.length).toBe(countAfterMax);
  });
});

// ─── Pause/resume sender encoding state restoration ─────────────────────────

describe("ViewerMediaBinding — pause/resume operation correlation", () => {
  let binding: ViewerMediaBinding;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = makeMockRuntime();
    binding = new ViewerMediaBinding(runtime);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    binding.destroy();
  });

  it("pause saves encoding active states and resume restores them", async () => {
    // Use a stateful sender whose getParameters/setParameters track real state
    class FakeSender {
      private params: RTCRtpSendParameters;
      constructor(public track: MediaStreamTrack, initialEncodings: RTCRtpEncodingParameters[]) {
        this.params = {
          encodings: initialEncodings.map(e => ({ ...e })),
          codecs: [], headerExtensions: [], rtcp: {},
          transactionId: `tx-${Math.random()}`,
        };
      }
      getParameters(): RTCRtpSendParameters {
        return {
          ...this.params,
          encodings: this.params.encodings?.map(e => ({ ...e })) ?? [],
        };
      }
      async setParameters(params: RTCRtpSendParameters): Promise<void> {
        this.params = {
          ...params,
          encodings: params.encodings?.map(e => ({ ...e })) ?? [],
        };
      }
      get encodingActiveStates(): boolean[] {
        return this.params.encodings?.map(e => e.active !== false) ?? [];
      }
    }

    const videoSender = new FakeSender({ kind: "video" } as MediaStreamTrack, [
      { active: true, maxBitrate: 5_000_000 },
      { active: false, maxBitrate: 1_000_000 },
    ]);
    const audioSender = new FakeSender({ kind: "audio" } as MediaStreamTrack, [
      { active: true },
    ]);

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender,
      audioSender,
    });

    // Pause
    const pauseResult = await binding.handleViewerPaused("viewer-1", "ms-1", true);
    expect(pauseResult.status).toBe("applied");
    // All encodings should now be false
    expect(videoSender.encodingActiveStates).toEqual([false, false]);
    expect(audioSender.encodingActiveStates).toEqual([false]);

    // Resume
    const resumeResult = await binding.handleViewerPaused("viewer-1", "ms-1", false);
    expect(resumeResult.status).toBe("applied");
    // Encoding 0 was active → active. Encoding 1 was inactive → inactive.
    expect(videoSender.encodingActiveStates).toEqual([true, false]);
    // Audio was active → active
    expect(audioSender.encodingActiveStates).toEqual([true]);
  });

  it("paused sender state is cleaned up on mapping removal", async () => {
    class FakeSender {
      private params: RTCRtpSendParameters;
      constructor(public track: MediaStreamTrack, active: boolean) {
        this.params = {
          encodings: [{ active }],
          codecs: [], headerExtensions: [], rtcp: {},
          transactionId: `tx-${Math.random()}`,
        };
      }
      getParameters(): RTCRtpSendParameters {
        return {
          ...this.params,
          encodings: this.params.encodings?.map(e => ({ ...e })) ?? [],
        };
      }
      async setParameters(params: RTCRtpSendParameters): Promise<void> {
        this.params = { ...params, encodings: params.encodings?.map(e => ({ ...e })) ?? [] };
      }
    }

    const videoSender = new FakeSender({ kind: "video" } as MediaStreamTrack, true);

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender,
      audioSender: null,
    });

    // Pause
    await binding.handleViewerPaused("viewer-1", "ms-1", true);
    // Phase 6C: paused sender state lives in the ViewerSenderController
    const mapping = (binding as any).viewerMap.get("viewer-1::ms-1");
    const bId = (ViewerMediaBinding as any).bindingIdFromMapping(mapping);
    expect((binding as any).senderController.getPausedState(bId)).not.toBeNull();

    // Remove mapping — paused state should be cleaned up with the binding
    binding.removeViewerMapping("viewer-1", "ms-1");
    expect((binding as any).senderController.hasBinding(bId)).toBe(false);
    expect((binding as any).senderController.getPausedState(bId)).toBeNull();
  });

  it("viewerMediaModes cleaned up on mapping removal", async () => {
    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: null,
      audioSender: null,
    });

    // Store a media mode preference
    (binding as any).viewerMediaModes.set("viewer-1::ms-1", {
      audioEnabled: true,
      videoEnabled: false,
    });

    binding.removeViewerMapping("viewer-1", "ms-1");
    expect((binding as any).viewerMediaModes.has("viewer-1::ms-1")).toBe(false);
  });

  it("destroy clears all per-viewer state and rejects further pause handling", async () => {
    // Seed mappings and a media mode preference
    const mkMapping = (viewerDeviceId: string) => ({
      viewerDeviceId,
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: null,
      audioSender: null,
    });
    (binding as any).viewerMap.set("v1::ms-1", mkMapping("v1"));
    (binding as any).viewerMap.set("v2::ms-1", mkMapping("v2"));
    (binding as any).viewerMediaModes.set("v1::ms-1", {
      audioEnabled: true,
      videoEnabled: false,
    });

    expect((binding as any).viewerMap.size).toBe(2);
    expect((binding as any).viewerMediaModes.size).toBe(1);

    binding.destroy();

    expect((binding as any).viewerMap.size).toBe(0);
    expect((binding as any).viewerMediaModes.size).toBe(0);

    // Post-destroy pause handling is rejected outright
    const result = await binding.handleViewerPaused("v1", "ms-1", true);
    expect(result.status).toBe("mapping-missing");
  });
});
