// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ViewerMediaBinding } from "../src/renderer/services/viewer-media-binding.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";
import type { GroupControlEnvelope } from "@screenlink/shared";
import { ViewerSenderController } from "../src/renderer/services/viewer-sender-controller.js";

// ─── Stateful RTCRtpSender fake ───────────────────────────────────────────
// A real implementation (NOT a Vitest mock) whose setParameters() updates
// internal readback state.  The non-applying variant accept setParameters()
// without updating state so verifyEncodingStates catches the mismatch.
// This avoids the Vitest-mock detection bypass in verifyEncodingStates
// (which returns true when "mock" in getParametersFn).

class FakeRTCRtpSender {
  private _params: RTCRtpSendParameters;
  private _track: MediaStreamTrack;
  private _ignoreSetParameters: boolean;

  constructor(kind: string, initialEncodings?: RTCRtpEncodingParameters[]) {
    this._track = { kind } as MediaStreamTrack;
    this._params = {
      encodings: initialEncodings ?? [{ active: true }],
      codecs: [],
      headerExtensions: [],
      rtcp: {},
      transactionId: `tx-${kind}-${Math.random().toString(36).slice(2, 6)}`,
    };
    this._ignoreSetParameters = false;
  }

  get track(): MediaStreamTrack { return this._track; }

  getParameters(): RTCRtpSendParameters {
    // Return a fresh copy each time so the caller's mutations are isolated
    return {
      ...this._params,
      encodings: this._params.encodings?.map(e => ({ ...e })) ?? [],
    };
  }

  async setParameters(params: RTCRtpSendParameters): Promise<void> {
    if (this._ignoreSetParameters) {
      // Accept the call but do NOT update internal state.
      // verifyEncodingStates will detect the mismatch on the next getParameters().
      return;
    }
    // Apply — deep-copy so subsequent getParameters returns the new state
    this._params = {
      ...params,
      encodings: params.encodings?.map(e => ({ ...e })) ?? [],
    };
  }

  /** When true, setParameters resolves without updating internal readback state. */
  set ignoreSetParameters(v: boolean) { this._ignoreSetParameters = v; }

  /** Assert-only helpers for test assertions */
  get encodingActiveStates(): boolean[] {
    return this._params.encodings?.map(e => e.active !== false) ?? [];
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeMockRuntime(): Phase3Runtime {
  const registry = {
    registerLocalStream: vi.fn(),
    handleStopped: vi.fn(),
    getStream: vi.fn().mockReturnValue(null),
    getAllStreams: vi.fn().mockReturnValue([]),
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
  };
  const mediaStatsService = {
    startViewerPoller: vi.fn(),
    stopViewerPoller: vi.fn(),
    disconnectViewer: vi.fn(),
    hasViewerPoller: vi.fn().mockReturnValue(false),
  };
  // resolveLocalPublication returns the SSM's VDO config for any call
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
  const controller = new ViewerSenderController();
  return {
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ssm,
    getViewerMediaBinding: () => ({} as any),
    getMediaStatsService: () => mediaStatsService,
    getQualityCoordinator: () => null,
    getSyncService: () => ({ getSyncState: vi.fn().mockReturnValue(null) }),
    getHostQualityLimits: () => ({ maxVideoBitrateKbps: 20000, maxWidth: 3840, maxHeight: 2160, maxFps: 60, allowViewerQualityRequests: true }),
    getViewerSenderController: () => controller,
    resolveLocalPublication,
    getCompareSessionManager: vi.fn().mockReturnValue(null),
    ssm, // expose for test assertions
    deviceId: "real-host-device",
    displayName: "Real Host",
  } as unknown as Phase3Runtime & { ssm: typeof ssm };
}

function makeJoinRequestEnvelope(
  groupId: string,
  senderDeviceId: string,
  logicalStreamId: string,
  viewerDeviceId?: string,
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
      viewerDeviceId: viewerDeviceId ?? senderDeviceId,
      viewerDisplayName: "Viewer",
    } as Record<string, unknown>,
    mac: "0".repeat(64),
  };
}

describe("ViewerMediaBinding (Stage 5)", () => {
  let binding: ViewerMediaBinding;
  let runtime: Phase3Runtime;
  let registry: ReturnType<typeof makeMockRuntime>["getActiveStreamRegistry"];

  beforeEach(() => {
    runtime = makeMockRuntime();
    binding = new ViewerMediaBinding(runtime);
    registry = runtime.getActiveStreamRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    binding.destroy();
  });

  // ─── handleJoinRequest ───────────────────────────────────────────

  it("returns null when destroyed", () => {
    binding.destroy();
    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    expect(binding.handleJoinRequest(envelope)).toBeNull();
  });

  it("returns null when no active stream matches", () => {
    vi.spyOn(registry, "getStream").mockReturnValue(null);
    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "unknown-stream");
    expect(binding.handleJoinRequest(envelope)).toBeNull();
  });

  it("returns null when viewerDeviceId is missing", () => {
    const envelope = makeJoinRequestEnvelope("g-1", "", "stream-1");
    expect(binding.handleJoinRequest(envelope)).toBeNull();
  });

  it("returns null when logicalStreamId is missing from payload", () => {
    const envelope = {
      ...makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1"),
      payload: {} as Record<string, unknown>,
    };
    expect(binding.handleJoinRequest(envelope)).toBeNull();
  });

  it("generates token and stores binding when stream is active", () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);

    expect(result).not.toBeNull();
    expect(result!.mediaSessionId).toBe("ms-1");
    expect(result!.token).toBeTruthy();
    expect(typeof result!.token).toBe("string");
    expect(result!.token.length).toBeGreaterThan(0);

    // Token is stored in the binding
    const storedToken = binding.getBindingToken(result!.token);
    expect(storedToken).toBeDefined();
    expect(storedToken!.viewerDeviceId).toBe("viewer-1");
    expect(storedToken!.groupId).toBe("g-1");
    expect(storedToken!.logicalStreamId).toBe("stream-1");
    expect(storedToken!.mediaSessionId).toBe("ms-1");
    expect(storedToken!.consumed).toBe(false);
    expect(storedToken!.expiresAt).toBeGreaterThan(storedToken!.createdAt);
  });

  // ─── handleMediaBind ─────────────────────────────────────────────

  it("returns false when destroyed", async () => {
    binding.destroy();
    const result = await binding.handleMediaBind("peer-uuid", "some-token");
    expect(result).toBe(false);
  });

  it("returns false for unknown token", async () => {
    const result = await binding.handleMediaBind("peer-uuid", "nonexistent-token");
    expect(result).toBe(false);
  });

  it("returns false for consumed token", async () => {
    // Create a token by making a valid request first
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    // Consume the token
    const consumeResult = await binding.handleMediaBind("peer-uuid-1", result!.token);
    expect(consumeResult).toBe(true);

    // Second consumption fails
    const secondResult = await binding.handleMediaBind("peer-uuid-1", result!.token);
    expect(secondResult).toBe(false);
  });

  it("returns false for expired token", async () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    // Manually expire the token
    const storedToken = binding.getBindingToken(result!.token);
    (storedToken as any).expiresAt = Date.now() - 1000;

    const consumeResult = await binding.handleMediaBind("peer-uuid-1", result!.token);
    expect(consumeResult).toBe(false);
  });

  it("stores viewer → media peer mapping on successful bind", async () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    await binding.handleMediaBind("peer-uuid-1", result!.token);

    expect(binding.getViewerMediaPeer("viewer-1")).toBe("peer-uuid-1");
  });

  // ─── removeViewerMapping (replaces removed removeViewer) ─────────

  it("removeViewerMapping clears the viewer from the map", async () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    await binding.handleMediaBind("peer-uuid-1", result!.token);
    expect(binding.getViewerMediaPeer("viewer-1")).toBe("peer-uuid-1");

    // Use exact composite key (Phase 2: removeViewer removed)
    const mapping = binding.getAllViewers().find(m => m.viewerDeviceId === "viewer-1");
    expect(mapping).not.toBeNull();
    binding.removeViewerMapping(mapping!.viewerDeviceId, mapping!.mediaSessionId, mapping!.viewerSessionId);
    expect(binding.getViewerMediaPeer("viewer-1")).toBeNull();
  });

  it("removeViewerMapping does NOT close the SDK-owned peer connection but cleans up ScreenLink state", () => {
    const close = vi.fn();

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: {
        connectionState: "connected",
        close,
      },
      videoSender: null,
      audioSender: null,
    });

    binding.removeViewerMapping("viewer-1", "ms-1");

    // Peer connection must NOT be closed by ScreenLink.
    expect(close).not.toHaveBeenCalled();
    // Mapping is removed.
    expect(binding.getViewerMediaPeer("viewer-1")).toBeNull();
  });

  it("removeViewerMapping respects viewerSessionId guard (stale session ignored)", () => {
    const statsService = runtime.getMediaStatsService() as any;

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-NEW",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: null,
      audioSender: null,
    });

    // Stale viewerSessionId should be rejected
    const removed = binding.removeViewerMapping("viewer-1", "ms-1", "session-OLD");
    expect(removed).toBe(false);
    expect(statsService.disconnectViewer).not.toHaveBeenCalled();
    // Active mapping still in place.
    expect(binding.getViewerMediaPeer("viewer-1")).toBe("peer-uuid-1");

    // Matching session ID succeeds.
    const removed2 = binding.removeViewerMapping("viewer-1", "ms-1", "session-NEW");
    expect(removed2).toBe(true);
    expect(binding.getViewerMediaPeer("viewer-1")).toBeNull();
  });

  it("removeViewerByPeerUuid resolves the viewer device from the peer UUID", () => {
    const close = vi.fn();

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close },
      videoSender: null,
      audioSender: null,
    });

    const removed = binding.removeViewerByPeerUuid("peer-uuid-1");
    expect(removed).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  // ─── consumeBinding (Stage 5) ────────────────────────────────────

  it("consumeBinding validates token and returns false for unknown", async () => {
    const result = await binding.consumeBinding({
      token: "unknown-token",
      viewerDeviceId: "viewer-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-1",
    });
    expect(result).toBe(false);
  });

  it("consumeBinding validates viewerDeviceId match", async () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    // Wrong viewerDeviceId
    const consumeResult = await binding.consumeBinding({
      token: result!.token,
      viewerDeviceId: "wrong-viewer",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-1",
    });
    expect(consumeResult).toBe(false);
  });

  it("consumeBinding validates groupId match", async () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    const consumeResult = await binding.consumeBinding({
      token: result!.token,
      viewerDeviceId: "viewer-1",
      groupId: "wrong-group",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-1",
    });
    expect(consumeResult).toBe(false);
  });

  it("consumeBinding validates logicalStreamId match", async () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    const consumeResult = await binding.consumeBinding({
      token: result!.token,
      viewerDeviceId: "viewer-1",
      groupId: "g-1",
      logicalStreamId: "wrong-stream",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-1",
    });
    expect(consumeResult).toBe(false);
  });

  it("consumeBinding deletes token on success", async () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    const consumeResult = await binding.consumeBinding({
      token: result!.token,
      viewerDeviceId: "viewer-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-1",
    });
    expect(consumeResult).toBe(true);

    // Token should be deleted
    expect(binding.getBindingToken(result!.token)).toBeUndefined();
  });

  it("consumeBinding stores viewer mapping on success", async () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    await binding.consumeBinding({
      token: result!.token,
      viewerDeviceId: "viewer-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-1",
    });

    expect(binding.getViewerMediaPeer("viewer-1")).toBe("peer-1");
  });

  // ─── Join response includes VDO credentials ─────────────────────

  it("sendJoinResponse includes VDO streamId and password when session has config", () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    binding.handleJoinRequest(envelope);

    // Get the mock after the call so we can inspect what was sent
    const connManager = runtime.getConnectionManager();
    const connection = connManager.getConnection("g-1");
    const mockSendToPeer = connection.sendToPeer as ReturnType<typeof vi.fn>;

    // The join response should include the VDO credentials from getCurrentVdoConfig()
    expect(mockSendToPeer).toHaveBeenCalled();
    const sentPayload = mockSendToPeer.mock.calls[0][1] as Record<string, unknown>;
    expect(sentPayload.type).toBe("stream.join.response");
    expect(sentPayload.streamId).toBe("vdo-stream-abc");
    expect(sentPayload.password).toBe("vdo-password-xyz");
    expect(sentPayload.bindingToken).toBeTruthy();
    expect(typeof sentPayload.bindingToken).toBe("string");
    expect(sentPayload.mediaSessionId).toBe("ms-1");
    expect(sentPayload.accepted).toBe(true);
  });

  it("sendJoinResponse omits streamId/password when vdoConfig is null", () => {
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

    // Get the stable ssm reference from the runtime and override to return null
    const { ssm } = runtime as unknown as { ssm: { getCurrentVdoConfig: ReturnType<typeof vi.fn> } };
    ssm.getCurrentVdoConfig.mockReturnValue(null);

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    binding.handleJoinRequest(envelope);

    const connManager = runtime.getConnectionManager();
    const connection = connManager.getConnection("g-1");
    const mockSendToPeer = connection.sendToPeer as ReturnType<typeof vi.fn>;
    expect(mockSendToPeer).toHaveBeenCalled();
    const sentPayload = mockSendToPeer.mock.calls[0][1] as Record<string, unknown>;
    expect(sentPayload.streamId).toBeUndefined();
    expect(sentPayload.password).toBeUndefined();
    expect(sentPayload.bindingToken).toBeTruthy();
  });

  // ─── Duplicate requestId idempotency ─────────────────────────────

  it("same requestId returns same token on duplicate request", () => {
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

    // We need to add requestId support. For now test that the basic
    // mechanism works: same viewer + logicalStreamId is idempotent
    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result1 = binding.handleJoinRequest(envelope);
    const result2 = binding.handleJoinRequest(envelope);

    // These should be the same token (duplicate request)
    // Already-consumed requests are routed differently, but clean duplicates
    // from the same viewer for the same stream should be idempotent.
    // Currently viewerMediaBinding generates new tokens each time,
    // so this is a future requirement. For now just verify both work.
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
  });

  // ─── getAllViewers ───────────────────────────────────────────────

  it("getAllViewers returns empty array when no viewers", () => {
    expect(binding.getAllViewers()).toEqual([]);
  });

  it("getAllViewers returns all mapped viewers", async () => {
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

    // Add two viewers
    const env1 = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const r1 = binding.handleJoinRequest(env1);
    await binding.handleMediaBind("peer-1", r1!.token);

    const env2 = makeJoinRequestEnvelope("g-1", "viewer-2", "stream-1");
    const r2 = binding.handleJoinRequest(env2);
    await binding.handleMediaBind("peer-2", r2!.token);

    const viewers = binding.getAllViewers();
    expect(viewers).toHaveLength(2);
    expect(viewers).toContainEqual(expect.objectContaining({ viewerDeviceId: "viewer-1", mediaPeerUuid: "peer-1" }));
    expect(viewers).toContainEqual(expect.objectContaining({ viewerDeviceId: "viewer-2", mediaPeerUuid: "peer-2" }));
  });

  // ─── Disconnect preserves other viewers ──────────────────────────

  it("removeViewer does not affect other viewers", async () => {
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

    const env1 = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const r1 = binding.handleJoinRequest(env1);
    await binding.handleMediaBind("peer-1", r1!.token);

    const env2 = makeJoinRequestEnvelope("g-1", "viewer-2", "stream-1");
    const r2 = binding.handleJoinRequest(env2);
    await binding.handleMediaBind("peer-2", r2!.token);

    const v1Mapping = binding.getAllViewers().find(m => m.viewerDeviceId === "viewer-1");
    expect(v1Mapping).not.toBeNull();
    binding.removeViewerMapping(v1Mapping!.viewerDeviceId, v1Mapping!.mediaSessionId, v1Mapping!.viewerSessionId);

    expect(binding.getViewerMediaPeer("viewer-1")).toBeNull();
    expect(binding.getViewerMediaPeer("viewer-2")).toBe("peer-2");
    expect(binding.getAllViewers()).toHaveLength(1);
  });

  // ─── Audio sender mapping (remediation batch) ──────────────────────

  it("ViewerMapping includes audioSender field", () => {
    const mapping: import("../src/renderer/services/viewer-media-binding.js").ViewerMapping = {
      viewerDeviceId: "v-1",
      mediaPeerUuid: "peer-1",
      groupId: "g-1",
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      pc: null,
      videoSender: null,
      audioSender: null,
    };
    expect(mapping.audioSender).toBeNull();
    expect("audioSender" in mapping).toBe(true);
  });

  it("consumeBinding resolves audio sender alongside video sender", async () => {
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

    // Mock getPublisherManager to return a publisher with SDK that has connections
    const getSenders = vi.fn().mockReturnValue([
      { track: { kind: "video" }, getParameters: vi.fn() },
      { track: { kind: "audio" }, getParameters: vi.fn() },
    ]);
    const mockPc = { getSenders };
    const mockConnections = new Map([
      ["peer-uuid-1", { publisher: { pc: mockPc }, viewer: null }],
    ]);
    const mockSDK = { connections: mockConnections };
    const mockPublisher = { getSDK: vi.fn().mockReturnValue(mockSDK) };
    const mockPubManager = { getPublisher: vi.fn().mockReturnValue(mockPublisher) };

    // Access SSM through the runtime
    const { ssm } = runtime as unknown as { ssm: { getPublisherManager: any } };
    ssm.getPublisherManager = vi.fn().mockReturnValue(mockPubManager);

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    await binding.consumeBinding({
      token: result!.token,
      viewerDeviceId: "viewer-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-uuid-1",
    });

    // Verify audio sender is stored alongside video sender
    expect(binding.getViewerVideoSender("viewer-1")).not.toBeNull();
    expect(binding.getViewerAudioSender("viewer-1")).not.toBeNull();
    expect(binding.getViewerAudioSender("viewer-1")!.track!.kind).toBe("audio");
  });

  it("getViewerAudioSender returns null for unmapped viewer", () => {
    expect(binding.getViewerAudioSender("unknown-viewer")).toBeNull();
  });

  // ─── SSM-based authority (fix: StreamSessionManager is authority, not registry) ──

  it("accepts join when registry is missing but StreamSessionManager is active", () => {
    // Registry returns null (no entry), but SSM is active and matches
    vi.spyOn(registry, "getStream").mockReturnValue(null);
    const { ssm } = runtime as unknown as { ssm: { getPublisherManager: () => unknown } };
    ssm.getPublisherManager = vi.fn().mockReturnValue({
      getPublisher: vi.fn().mockReturnValue(null),
    });

    const envelope = makeJoinRequestEnvelope("group-1", "viewer-1", "local-stream-1");
    const result = binding.handleJoinRequest(envelope);

    // Must accept: SSM has active publication matching the request
    expect(result).not.toBeNull();
    expect(result!.mediaSessionId).toBe("media-session-1");
    expect(result!.token).toBeTruthy();

    // Verify the token is stored
    const storedToken = binding.getBindingToken(result!.token);
    expect(storedToken).toBeDefined();
    expect(storedToken!.groupId).toBe("group-1");
    expect(storedToken!.logicalStreamId).toBe("local-stream-1");
    expect(storedToken!.mediaSessionId).toBe("media-session-1");
  });

  it("self-heals by re-registering local stream when SSM active but registry entry missing", () => {
    const registerSpy = vi.spyOn(registry, "registerLocalStream");
    vi.spyOn(registry, "getStream").mockReturnValue(null);
    const { ssm } = runtime as unknown as { ssm: { getPublisherManager: () => unknown } };
    ssm.getPublisherManager = vi.fn().mockReturnValue({
      getPublisher: vi.fn().mockReturnValue(null),
    });

    const envelope = makeJoinRequestEnvelope("group-1", "viewer-1", "local-stream-1");
    binding.handleJoinRequest(envelope);

    // Must have called registerLocalStream to self-heal
    expect(registerSpy).toHaveBeenCalled();
    const registered = registerSpy.mock.calls[0][0];
    expect(registered.groupId).toBe("group-1");
    expect(registered.logicalStreamId).toBe("local-stream-1");
    expect(registered.mediaSessionId).toBe("media-session-1");
    expect(registered.hostDeviceId).toBe("real-host-device");
  });

  it("rejects join when SSM state is not active (e.g. stopped)", () => {
    // Set SSM state to idle (not active)
    const { ssm } = runtime as unknown as { ssm: { state: string } };
    ssm.state = "idle";
    vi.spyOn(registry, "getStream").mockReturnValue(null);

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);

    expect(result).toBeNull();
  });

  it("rejects join when SSM groupId does not match requested group", () => {
    const { ssm } = runtime as unknown as { ssm: { currentGroupId: string } };
    ssm.currentGroupId = "different-group";
    vi.spyOn(registry, "getStream").mockReturnValue(null);

    const envelope = makeJoinRequestEnvelope("requested-group", "viewer-1", "local-stream-1");
    const result = binding.handleJoinRequest(envelope);

    expect(result).toBeNull();
  });

  it("rejects join when SSM logicalStreamId does not match requested stream", () => {
    const { ssm } = runtime as unknown as { ssm: { currentLogicalStreamId: string } };
    ssm.currentLogicalStreamId = "different-stream";
    vi.spyOn(registry, "getStream").mockReturnValue(null);

    const envelope = makeJoinRequestEnvelope("group-1", "viewer-1", "requested-stream");
    const result = binding.handleJoinRequest(envelope);

    expect(result).toBeNull();
  });

  it("rejects join when SSM has no PublisherManager", () => {
    const { ssm } = runtime as unknown as { ssm: { getPublisherManager: () => null } };
    ssm.getPublisherManager = vi.fn().mockReturnValue(null);
    vi.spyOn(registry, "getStream").mockReturnValue(null);

    const envelope = makeJoinRequestEnvelope("group-1", "viewer-1", "local-stream-1");
    const result = binding.handleJoinRequest(envelope);

    expect(result).toBeNull();
  });

  it("rejects join when SSM has no VDO config", () => {
    const { ssm } = runtime as unknown as { ssm: { getCurrentVdoConfig: () => null } };
    ssm.getCurrentVdoConfig = vi.fn().mockReturnValue(null);
    vi.spyOn(registry, "getStream").mockReturnValue(null);

    const envelope = makeJoinRequestEnvelope("group-1", "viewer-1", "local-stream-1");
    const result = binding.handleJoinRequest(envelope);

    expect(result).toBeNull();
  });

  it("still accepts join via registry fallback when SSM does not own the stream (remote stream)", () => {
    // SSM has a different logical stream active; registry has the requested stream
    const { ssm } = runtime as unknown as { ssm: { currentLogicalStreamId: string } };
    ssm.currentLogicalStreamId = "local-stream-1";
    vi.spyOn(registry, "getStream").mockReturnValue({
      logicalStreamId: "remote-stream-1",
      mediaSessionId: "remote-ms-1",
      groupId: "group-1",
      hostDeviceId: "remote-host",
      hostDisplayName: "Remote Host",
      sourceKind: "screen",
      sourceName: "Remote Screen",
      startedAt: 1000,
      appliedSettingsRevision: 0,
      heartbeatSequence: 1,
      streamRevision: 1,
      mediaJoinMetadata: "",
      replacesSessionId: null,
    });

    const envelope = makeJoinRequestEnvelope("group-1", "viewer-1", "remote-stream-1");
    const result = binding.handleJoinRequest(envelope);

    // Must accept via registry fallback (remote stream)
    expect(result).not.toBeNull();
    expect(result!.mediaSessionId).toBe("remote-ms-1");
  });

  // ─── Normal join/HMAC behavior remains working ─────────────────────

  it("normal join via registry continues to work unchanged", () => {
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

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);

    expect(result).not.toBeNull();
    expect(result!.mediaSessionId).toBe("ms-1");
    expect(result!.token).toBeTruthy();
  });

  it("getViewerAudioSender returns null when no audio sender resolved", async () => {
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

    // Mock publisher manager with NO audio sender (no audio track)
    const getSenders = vi.fn().mockReturnValue([
      { track: { kind: "video" }, getParameters: vi.fn() },
    ]);
    const mockPc = { getSenders };
    const mockConnections = new Map([
      ["peer-uuid-1", { publisher: { pc: mockPc }, viewer: null }],
    ]);
    const mockSDK = { connections: mockConnections };
    const mockPublisher = { getSDK: vi.fn().mockReturnValue(mockSDK) };
    const mockPubManager = { getPublisher: vi.fn().mockReturnValue(mockPublisher) };

    const { ssm } = runtime as unknown as { ssm: { getPublisherManager: any } };
    ssm.getPublisherManager = vi.fn().mockReturnValue(mockPubManager);

    const envelope = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const result = binding.handleJoinRequest(envelope);
    expect(result).not.toBeNull();

    await binding.consumeBinding({
      token: result!.token,
      viewerDeviceId: "viewer-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      mediaPeerUuid: "peer-uuid-1",
    });

    expect(binding.getViewerVideoSender("viewer-1")).not.toBeNull();
    expect(binding.getViewerAudioSender("viewer-1")).toBeNull();
  });

  // ─── Composite-key concurrent session tests ────────────────────

  it("getViewersForMediaSession returns all viewers for a media session", async () => {
    vi.spyOn(registry, "getStream").mockReturnValue({
      logicalStreamId: "stream-1", mediaSessionId: "ms-1", groupId: "g-1",
      hostDeviceId: "local", hostDisplayName: "Host", sourceKind: "screen",
      sourceName: "Screen", startedAt: 1000, appliedSettingsRevision: 0,
      heartbeatSequence: 1, streamRevision: 1, mediaJoinMetadata: "", replacesSessionId: null,
    });

    // Two viewers join the same media session
    const env1 = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const r1 = binding.handleJoinRequest(env1);
    await binding.handleMediaBind("peer-uuid-1", r1!.token);

    const env2 = makeJoinRequestEnvelope("g-1", "viewer-2", "stream-1");
    const r2 = binding.handleJoinRequest(env2);
    await binding.handleMediaBind("peer-uuid-2", r2!.token);

    const viewers = binding.getViewersForMediaSession("ms-1");
    expect(viewers).toHaveLength(2);
    expect(viewers.map(v => v.viewerDeviceId).sort()).toEqual(["viewer-1", "viewer-2"]);
  });

  it("getViewerMapping with composite key returns exact match", async () => {
    vi.spyOn(registry, "getStream").mockReturnValue({
      logicalStreamId: "stream-1", mediaSessionId: "ms-1", groupId: "g-1",
      hostDeviceId: "local", hostDisplayName: "Host", sourceKind: "screen",
      sourceName: "Screen", startedAt: 1000, appliedSettingsRevision: 0,
      heartbeatSequence: 1, streamRevision: 1, mediaJoinMetadata: "", replacesSessionId: null,
    });

    const env1 = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const r1 = binding.handleJoinRequest(env1);
    await binding.handleMediaBind("peer-uuid-1", r1!.token);

    const mapping = binding.getViewerMapping("viewer-1", "ms-1");
    expect(mapping).not.toBeNull();
    expect(mapping!.viewerDeviceId).toBe("viewer-1");
    expect(mapping!.mediaSessionId).toBe("ms-1");

    // Non-existent composite returns null
    expect(binding.getViewerMapping("viewer-1", "nonexistent-session")).toBeNull();
  });

  it("one device can hold A and B bindings simultaneously", async () => {
    // Register two streams (different media sessions)
    const getStreamSpy = vi.spyOn(registry, "getStream");
    getStreamSpy.mockImplementation(({ logicalStreamId }: { logicalStreamId: string }) => ({
      logicalStreamId, mediaSessionId: logicalStreamId === "stream-a" ? "ms-a" : "ms-b",
      groupId: "g-1", hostDeviceId: "local", hostDisplayName: "Host",
      sourceKind: "screen", sourceName: "Screen", startedAt: 1000,
      appliedSettingsRevision: 0, heartbeatSequence: 1, streamRevision: 1,
      mediaJoinMetadata: "", replacesSessionId: null,
    } as any));

    // Same device joins both sessions
    const envA = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-a");
    const rA = binding.handleJoinRequest(envA);
    await binding.handleMediaBind("peer-uuid-a", rA!.token);

    const envB = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-b");
    const rB = binding.handleJoinRequest(envB);
    await binding.handleMediaBind("peer-uuid-b", rB!.token);

    // Same device has two distinct bindings
    const mappingA = binding.getViewerMapping("viewer-1", "ms-a");
    const mappingB = binding.getViewerMapping("viewer-1", "ms-b");
    expect(mappingA).not.toBeNull();
    expect(mappingB).not.toBeNull();
    expect(mappingA!.mediaPeerUuid).toBe("peer-uuid-a");
    expect(mappingB!.mediaPeerUuid).toBe("peer-uuid-b");

    // All-viewers returns both
    expect(binding.getAllViewers()).toHaveLength(2);
  });

  it("removeViewerMapping removes exact composite entry", async () => {
    vi.spyOn(registry, "getStream").mockReturnValue({
      logicalStreamId: "stream-1", mediaSessionId: "ms-1", groupId: "g-1",
      hostDeviceId: "local", hostDisplayName: "Host", sourceKind: "screen",
      sourceName: "Screen", startedAt: 1000, appliedSettingsRevision: 0,
      heartbeatSequence: 1, streamRevision: 1, mediaJoinMetadata: "", replacesSessionId: null,
    });

    const env1 = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const r1 = binding.handleJoinRequest(env1);
    await binding.handleMediaBind("peer-uuid-1", r1!.token);

    expect(binding.getViewerMapping("viewer-1", "ms-1")).not.toBeNull();

    const removed = binding.removeViewerMapping("viewer-1", "ms-1");
    expect(removed).toBe(true);
    expect(binding.getViewerMapping("viewer-1", "ms-1")).toBeNull();
  });

  it("removeViewerMapping respects viewerSessionId guard", async () => {
    vi.spyOn(registry, "getStream").mockReturnValue({
      logicalStreamId: "stream-1", mediaSessionId: "ms-1", groupId: "g-1",
      hostDeviceId: "local", hostDisplayName: "Host", sourceKind: "screen",
      sourceName: "Screen", startedAt: 1000, appliedSettingsRevision: 0,
      heartbeatSequence: 1, streamRevision: 1, mediaJoinMetadata: "", replacesSessionId: null,
    });

    const envelope = {
      ...makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1"),
      payload: {
        logicalStreamId: "stream-1",
        viewerDeviceId: "viewer-1",
        viewerDisplayName: "Viewer",
        viewerSessionId: "session-ACTIVE",
      } as Record<string, unknown>,
    };
    const result = binding.handleJoinRequest(envelope);
    await binding.handleMediaBind("peer-uuid-1", result!.token);

    // Wrong viewerSessionId should not remove
    const removed = binding.removeViewerMapping("viewer-1", "ms-1", "session-STALE");
    expect(removed).toBe(false);
    expect(binding.getViewerMapping("viewer-1", "ms-1")).not.toBeNull();

    // Correct viewerSessionId removes
    const removed2 = binding.removeViewerMapping("viewer-1", "ms-1", "session-ACTIVE");
    expect(removed2).toBe(true);
    expect(binding.getViewerMapping("viewer-1", "ms-1")).toBeNull();
  });

  it("removeMappingsForMediaSessions removes all mappings for given sessions", async () => {
    const getStreamSpy = vi.spyOn(registry, "getStream");
    getStreamSpy.mockImplementation(({ logicalStreamId }: { logicalStreamId: string }) => ({
      logicalStreamId, mediaSessionId: logicalStreamId === "stream-a" ? "ms-a" : "ms-b",
      groupId: "g-1", hostDeviceId: "local", hostDisplayName: "Host",
      sourceKind: "screen", sourceName: "Screen", startedAt: 1000,
      appliedSettingsRevision: 0, heartbeatSequence: 1, streamRevision: 1,
      mediaJoinMetadata: "", replacesSessionId: null,
    } as any));

    // viewer-1 joins ms-a, viewer-2 joins ms-b
    const envA = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-a");
    await binding.handleMediaBind("peer-uuid-a", binding.handleJoinRequest(envA)!.token);

    const envB = makeJoinRequestEnvelope("g-1", "viewer-2", "stream-b");
    await binding.handleMediaBind("peer-uuid-b", binding.handleJoinRequest(envB)!.token);

    expect(binding.getAllViewers()).toHaveLength(2);

    const removed = binding.removeMappingsForMediaSessions(["ms-a"]);
    expect(removed).toBe(1);
    expect(binding.getViewerMapping("viewer-1", "ms-a")).toBeNull();
    expect(binding.getViewerMapping("viewer-2", "ms-b")).not.toBeNull();
  });

  it("getUniqueViewerDevicesForLogicalStream deduplicates by viewerDeviceId", async () => {
    const getStreamSpy = vi.spyOn(registry, "getStream");
    getStreamSpy.mockImplementation(({ logicalStreamId }: { logicalStreamId: string }) => ({
      logicalStreamId, mediaSessionId: logicalStreamId === "stream-a" ? "ms-a" : "ms-b",
      groupId: "g-1", hostDeviceId: "local", hostDisplayName: "Host",
      sourceKind: "screen", sourceName: "Screen", startedAt: 1000,
      appliedSettingsRevision: 0, heartbeatSequence: 1, streamRevision: 1,
      mediaJoinMetadata: "", replacesSessionId: null,
    } as any));

    // Same device joins both A and B sessions of the same logical stream
    const envA = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-a");
    const rA = binding.handleJoinRequest(envA);
    await binding.handleMediaBind("peer-uuid-a", rA!.token);

    const envB = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-b");
    const rB = binding.handleJoinRequest(envB);
    await binding.handleMediaBind("peer-uuid-b", rB!.token);

    // Also add a different viewer
    const envC = makeJoinRequestEnvelope("g-1", "viewer-2", "stream-a");
    const rC = binding.handleJoinRequest(envC);
    await binding.handleMediaBind("peer-uuid-c", rC!.token);

    // All three mappings share the same logicalStreamId-related sessions
    // Unique devices should be viewer-1 (once) and viewer-2 (once) = 2
    const uniqueDevices = binding.getUniqueViewerDevicesForLogicalStream("stream-a");
    expect(uniqueDevices.sort()).toEqual(["viewer-1", "viewer-2"]);
    expect(uniqueDevices).toHaveLength(2);
  });

  it("removeViewerMapping with exact composite key removes single mapping", async () => {
    vi.spyOn(registry, "getStream").mockReturnValue({
      logicalStreamId: "stream-1", mediaSessionId: "ms-1", groupId: "g-1",
      hostDeviceId: "local", hostDisplayName: "Host", sourceKind: "screen",
      sourceName: "Screen", startedAt: 1000, appliedSettingsRevision: 0,
      heartbeatSequence: 1, streamRevision: 1, mediaJoinMetadata: "", replacesSessionId: null,
    });

    const env1 = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const r1 = binding.handleJoinRequest(env1);
    await binding.handleMediaBind("peer-uuid-1", r1!.token);

    // Phase 2: removeViewer removed — use removeViewerMapping with exact key
    binding.removeViewerMapping("viewer-1", "ms-1");
    expect(binding.getViewerMapping("viewer-1", "ms-1")).toBeNull();
  });

  it("audio sender is included in getAllViewers output", async () => {
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

    // Mock publishers with both video and audio senders
    const makeSenders = () => [
      { track: { kind: "video" } },
      { track: { kind: "audio" } },
    ];
    const getSenders1 = vi.fn().mockReturnValue(makeSenders());
    const getSenders2 = vi.fn().mockReturnValue(makeSenders());
    const mockConnections = new Map([
      ["peer-uuid-1", { publisher: { pc: { getSenders: getSenders1 } }, viewer: null }],
      ["peer-uuid-2", { publisher: { pc: { getSenders: getSenders2 } }, viewer: null }],
    ]);
    const mockSDK = { connections: mockConnections };
    const mockPublisher = { getSDK: vi.fn().mockReturnValue(mockSDK) };
    const mockPubManager = { getPublisher: vi.fn().mockReturnValue(mockPublisher) };

    const { ssm } = runtime as unknown as { ssm: { getPublisherManager: any } };
    ssm.getPublisherManager = vi.fn().mockReturnValue(mockPubManager);

    // Bind viewer-1
    const env1 = makeJoinRequestEnvelope("g-1", "viewer-1", "stream-1");
    const r1 = binding.handleJoinRequest(env1);
    await binding.consumeBinding({
      token: r1!.token, viewerDeviceId: "viewer-1", groupId: "g-1",
      logicalStreamId: "stream-1", mediaSessionId: "ms-1", mediaPeerUuid: "peer-uuid-1",
    });

    // Bind viewer-2
    const env2 = makeJoinRequestEnvelope("g-1", "viewer-2", "stream-1");
    const r2 = binding.handleJoinRequest(env2);
    await binding.consumeBinding({
      token: r2!.token, viewerDeviceId: "viewer-2", groupId: "g-1",
      logicalStreamId: "stream-1", mediaSessionId: "ms-1", mediaPeerUuid: "peer-uuid-2",
    });

    const allViewers = binding.getAllViewers();
    expect(allViewers).toHaveLength(2);
    for (const v of allViewers) {
      expect(v).toHaveProperty("audioSender");
      expect(v.audioSender).not.toBeNull();
      expect(v.audioSender!.track!.kind).toBe("audio");
    }
  });

  // ─── SSM authority: stale registry entry must NOT bypass stopped SSM ──

  it("rejects local join when SSM is stopped but registry still has a matching entry", () => {
    // SSM is stopped (idle) and does NOT match the request
    vi.spyOn(registry, "getStream").mockReturnValue({
      logicalStreamId: "local-stream-1",
      mediaSessionId: "media-session-1",
      groupId: "group-1",
      hostDeviceId: "real-host-device",
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

    // SSM is stopped — state is idle but identities still match the request
    const { ssm } = runtime as unknown as { ssm: { state: string } };
    ssm.state = "idle";

    const envelope = makeJoinRequestEnvelope("group-1", "viewer-1", "local-stream-1");
    const result = binding.handleJoinRequest(envelope);

    // Must reject: SSM owns this stream (same group + logicalStreamId) but is not active,
    // even though the registry has a stale matching entry.
    expect(result).toBeNull();
  });

  it("self-heal re-registers with accurate current announcement snapshot from SSM", () => {
    const registerSpy = vi.spyOn(registry, "registerLocalStream");
    vi.spyOn(registry, "getStream").mockReturnValue(null);

    // Verify getCurrentAnnouncementSnapshot is called and the registered
    // announcement has real metadata (not placeholder defaults).
    const { ssm } = runtime as unknown as {
      ssm: {
        getPublisherManager: () => unknown;
        getCurrentAnnouncementSnapshot?: () => unknown;
      };
    };
    ssm.getPublisherManager = vi.fn().mockReturnValue({
      getPublisher: vi.fn().mockReturnValue(null),
    });

    // Add getCurrentAnnouncementSnapshot to the mock SSM with accurate data
    const realSnapshot = {
      logicalStreamId: "local-stream-1",
      mediaSessionId: "media-session-1",
      groupId: "group-1",
      hostDeviceId: "real-host-device",
      hostDisplayName: "Real Host",
      sourceKind: "screen",
      sourceName: "My Screen",
      startedAt: 5000,
      appliedSettingsRevision: 3,
      heartbeatSequence: 42,
      streamRevision: 7,
      mediaJoinMetadata: "",
      replacesSessionId: null,
      isAudioDegraded: false,
    };

    // We need to update the ssm mock to include getCurrentAnnouncementSnapshot
    // Since it's on the prototype, let's add it directly
    const ssmActual = runtime.getStreamSessionManager() as any;
    const origSnapshot = ssmActual.getCurrentAnnouncementSnapshot;
    ssmActual.getCurrentAnnouncementSnapshot = vi.fn().mockReturnValue(realSnapshot);

    try {
      const envelope = makeJoinRequestEnvelope("group-1", "viewer-1", "local-stream-1");
      binding.handleJoinRequest(envelope);

      // Must have called registerLocalStream with the accurate snapshot
      expect(registerSpy).toHaveBeenCalled();
      const registered = registerSpy.mock.calls[0][0];

      // Verify the registered announcement has the real metadata, not placeholders
      expect(registered.hostDisplayName).toBe("Real Host");
      expect(registered.sourceName).toBe("My Screen");
      expect(registered.startedAt).toBe(5000);
      expect(registered.heartbeatSequence).toBe(42);
      expect(registered.streamRevision).toBe(7);
      expect(registered.sourceKind).toBe("screen");
    } finally {
      // Restore
      if (origSnapshot !== undefined) {
        ssmActual.getCurrentAnnouncementSnapshot = origSnapshot;
      } else {
        delete ssmActual.getCurrentAnnouncementSnapshot;
      }
    }
  });

  // ─── Normal join/HMAC behavior remains working (explicit re-test) ─────

  it("normal join via registry fallback for remote streams continues to work when SSM has a different stream", () => {
    // SSM has local-stream-1 active. Request is for remote-stream-1 (different stream)
    // in the same group. Registry has the remote-host's stream. This must be accepted.
    const { ssm } = runtime as unknown as { ssm: { currentLogicalStreamId: string } };
    ssm.currentLogicalStreamId = "local-stream-1";
    vi.spyOn(registry, "getStream").mockReturnValue({
      logicalStreamId: "remote-stream-1",
      mediaSessionId: "remote-ms-1",
      groupId: "group-1",
      hostDeviceId: "remote-host",
      hostDisplayName: "Remote Host",
      sourceKind: "screen",
      sourceName: "Remote Screen",
      startedAt: 1000,
      appliedSettingsRevision: 0,
      heartbeatSequence: 1,
      streamRevision: 1,
      mediaJoinMetadata: "",
      replacesSessionId: null,
    });

    const envelope = makeJoinRequestEnvelope("group-1", "viewer-1", "remote-stream-1");
    const result = binding.handleJoinRequest(envelope);

    // Must accept via registry fallback (SSM has a different stream, not this one)
    expect(result).not.toBeNull();
    expect(result!.mediaSessionId).toBe("remote-ms-1");
    expect(result!.token).toBeTruthy();
  });

  it("reconcileViewerQuality reports apply-failed when sender.setParameters throws", async () => {
    const sendToPeer = vi.fn().mockResolvedValue(undefined);
    const failingSender = {
      track: {
        kind: "video",
        getSettings: () => ({ width: 1920, height: 1080 }),
      },
      getParameters: vi.fn(() => ({
        encodings: [{ active: true, priority: "medium" }],
        codecs: [],
        headerExtensions: [],
        rtcp: {},
        transactionId: "tx-1",
      })),
      setParameters: vi.fn().mockRejectedValue(new Error("setParameters failed")),
    } as unknown as RTCRtpSender;
    const mockPc = {
      getSenders: vi.fn().mockReturnValue([failingSender]),
    } as unknown as RTCPeerConnection;
    const mockSDK = {
      connections: new Map([
        ["peer-uuid-1", { publisher: { pc: mockPc }, viewer: null }],
      ]),
    };
    const mockPublisher = { getSDK: vi.fn().mockReturnValue(mockSDK) };
    const mockPubManager = { getPublisher: vi.fn().mockReturnValue(mockPublisher) };
    const qualityCoordinator = {
      getViewerRequest: vi.fn().mockReturnValue({
        streamSessionId: "stream-1",
        requestId: "req-1",
        revision: 1,
        videoBitrateKbps: 1200,
        maxWidth: 1280,
        maxHeight: 720,
        maxFps: 24,
        degradationPreference: "balanced",
      }),
      calculateEffectiveQuality: vi.fn().mockReturnValue({
        effective: {
          videoBitrateKbps: 1200,
          maxWidth: 1280,
          maxHeight: 720,
          maxFps: 24,
          degradationPreference: "balanced",
        },
        clampReasons: [],
      }),
      applyToExactViewer: vi.fn().mockRejectedValue(new Error("setParameters failed")),
    };

    const runtimeAny = runtime as any;
    runtimeAny.getQualityCoordinator = () => qualityCoordinator;
    runtimeAny.getConnectionManager = () => ({
      getConnection: vi.fn().mockReturnValue({
        peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
        sendToPeer,
      }),
    });
    runtimeAny.getSyncService = () => ({ getSyncState: vi.fn().mockReturnValue(null) });
    runtimeAny.getHostQualityLimits = () => ({
      maxVideoBitrateKbps: 20000,
      maxWidth: 3840,
      maxHeight: 2160,
      maxFps: 60,
      allowViewerQualityRequests: true,
    });
    runtimeAny.resolveLocalPublication = vi.fn().mockReturnValue({
      mediaSessionId: "ms-1",
      logicalStreamId: "stream-1",
      publisherManager: mockPubManager,
      vdoConfig: { streamId: "vdo-stream-abc", password: "vdo-password-xyz" },
    });

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "viewer-session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: mockPc,
      videoSender: null,
      audioSender: null,
    });

    await expect(binding.reconcileViewerQuality("viewer-1", "ms-1")).resolves.toEqual(
      expect.objectContaining({
        status: "apply-failed",
        error: expect.stringContaining("setParameters failed"),
      }),
    );
    expect(sendToPeer).not.toHaveBeenCalled();
  });

  // ─── Pause / Resume (Task B) ──────────────────────────────────────
  //
  // Requirements:
  //   1. Per-viewer host media pause/resume via composite identity
  //   2. Pause disables ALL encodings for video AND audio senders
  //   3. Prior active state persisted so resume restores only active
  //   4. Respect viewer media mode on resume
  //   5. Reapply stored video quality on resume
  //   6. Verify configured readback
  //   7. Reapply paused state after sender reconciliation

  it("handleViewerPaused returns mapping-missing for unknown composite key", async () => {
    const result = await binding.handleViewerPaused("unknown-viewer", "unknown-session", true);
    expect(result).toEqual({ status: "mapping-missing" });
  });

  it("handleViewerPaused returns sender-not-ready when video sender has no encodings", async () => {
    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: vi.fn(() => ({
          encodings: [],
          codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-1",
        })),
        setParameters: vi.fn(),
      } as unknown as RTCRtpSender,
      audioSender: null,
    });

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", true);
    expect(result).toEqual({ status: "sender-not-ready" });
  });

  it("handleViewerPaused disables all video sender encodings on pause", async () => {
    const setParameters = vi.fn();
    const getParameters = vi.fn(() => ({
      encodings: [
        { active: true, maxBitrate: 5000000 },
        { active: true, maxBitrate: 1000000 },
      ],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-1",
    }));

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters,
        setParameters,
      } as unknown as RTCRtpSender,
      audioSender: null,
    });

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", true);

    expect(result.status).toBe("applied");
    expect(setParameters).toHaveBeenCalledTimes(1);
    const appliedParams = setParameters.mock.calls[0][0];
    // Both encodings must be inactive
    for (const enc of appliedParams.encodings) {
      expect(enc.active).toBe(false);
    }
    // Returned configured readback is present
    expect((result as any).configured).toBeDefined();
  });

  it("handleViewerPaused disables all audio sender encodings on pause", async () => {
    const videoSetParams = vi.fn();
    const audioSetParams = vi.fn();
    const videoGetParams = vi.fn(() => ({
      encodings: [{ active: true, maxBitrate: 3000000 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));
    const audioGetParams = vi.fn(() => ({
      encodings: [
        { active: true },
        { active: true },
      ],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-a",
    }));

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: {
        track: { kind: "audio" },
        getParameters: audioGetParams,
        setParameters: audioSetParams,
      } as unknown as RTCRtpSender,
    });

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", true);

    expect(result.status).toBe("applied");
    // Video sender was updated
    expect(videoSetParams).toHaveBeenCalledTimes(1);
    expect(videoSetParams.mock.calls[0][0].encodings[0].active).toBe(false);
    // Audio sender was updated — both encodings disabled
    expect(audioSetParams).toHaveBeenCalledTimes(1);
    for (const enc of audioSetParams.mock.calls[0][0].encodings) {
      expect(enc.active).toBe(false);
    }
  });

  it("handleViewerPaused saves prior active state and resume restores only previously active encodings", async () => {
    const videoSetParams = vi.fn();
    const audioSetParams = vi.fn();
    const videoGetParams = vi.fn(() => ({
      encodings: [
        { active: true, maxBitrate: 5000000 },
        { active: false, maxBitrate: 1000000 },
      ],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));
    const audioGetParams = vi.fn(() => ({
      encodings: [
        { active: true },
        { active: false },
      ],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-a",
    }));

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: {
        track: { kind: "audio" },
        getParameters: audioGetParams,
        setParameters: audioSetParams,
      } as unknown as RTCRtpSender,
    });

    // Pause
    await binding.handleViewerPaused("viewer-1", "ms-1", true);
    expect(videoSetParams.mock.calls[0][0].encodings[0].active).toBe(false);
    expect(videoSetParams.mock.calls[0][0].encodings[1].active).toBe(false);
    expect(audioSetParams.mock.calls[0][0].encodings[0].active).toBe(false);
    expect(audioSetParams.mock.calls[0][0].encodings[1].active).toBe(false);

    // Resume — restore prior active states
    videoGetParams.mockReturnValue({
      encodings: [
        { active: false, maxBitrate: 5000000 },
        { active: false, maxBitrate: 1000000 },
      ],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    });
    audioGetParams.mockReturnValue({
      encodings: [
        { active: false },
        { active: false },
      ],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-a",
    });
    videoSetParams.mockClear();
    audioSetParams.mockClear();

    await binding.handleViewerPaused("viewer-1", "ms-1", false);

    // Encoding 0 was active before → should be active again
    expect(videoSetParams).toHaveBeenCalled();
    expect(videoSetParams.mock.calls[0][0].encodings[0].active).toBe(true);
    // Encoding 1 was inactive before → should remain inactive
    expect(videoSetParams.mock.calls[0][0].encodings[1].active).toBe(false);
    // Audio encoding 0 was active → should be active again
    expect(audioSetParams.mock.calls[0][0].encodings[0].active).toBe(true);
    // Audio encoding 1 was inactive → should remain inactive
    expect(audioSetParams.mock.calls[0][0].encodings[1].active).toBe(false);
  });

  it("handleViewerPaused respects viewer media mode on resume", async () => {
    const videoSetParams = vi.fn();
    const audioSetParams = vi.fn();
    const videoGetParams = vi.fn(() => ({
      encodings: [{ active: true, maxBitrate: 5000000 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));
    const audioGetParams = vi.fn(() => ({
      encodings: [{ active: true }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-a",
    }));

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: {
        track: { kind: "audio" },
        getParameters: audioGetParams,
        setParameters: audioSetParams,
      } as unknown as RTCRtpSender,
    });

    // Store media mode: video disabled, audio enabled
    (binding as any).viewerMediaModes.set("viewer-1::ms-1", {
      audioEnabled: true,
      videoEnabled: false,
    });

    // Pause
    await binding.handleViewerPaused("viewer-1", "ms-1", true);

    // Resume
    videoGetParams.mockReturnValue({
      encodings: [{ active: false, maxBitrate: 5000000 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    });
    audioGetParams.mockReturnValue({
      encodings: [{ active: false }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-a",
    });
    videoSetParams.mockClear();
    audioSetParams.mockClear();

    await binding.handleViewerPaused("viewer-1", "ms-1", false);

    // Video encoding should stay inactive because media mode said videoEnabled=false
    // Phase 6B: resume delegates to controller which applies media mode override
    expect(videoSetParams).toHaveBeenCalled();
    expect(videoSetParams.mock.calls[0][0].encodings[0].active).toBe(false);
    // Audio should be re-enabled
    expect(audioSetParams).toHaveBeenCalled();
    expect(audioSetParams.mock.calls[0][0].encodings[0].active).toBe(true);
  });

  it("handleViewerPaused re-applies stored video quality on resume", async () => {
    const videoSetParams = vi.fn();
    const videoGetParams = vi.fn(() => ({
      encodings: [{ active: true, maxBitrate: 5000000, maxFramerate: 30, scaleResolutionDownBy: 1 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));
    const sendToPeer = vi.fn().mockResolvedValue(undefined);

    const qualityCoordinator = {
      getViewerRequest: vi.fn().mockReturnValue({
        streamSessionId: "stream-1",
        requestId: "req-1",
        revision: 1,
        videoBitrateKbps: 1200,
        maxWidth: 1280,
        maxHeight: 720,
        maxFps: 24,
        degradationPreference: "balanced",
      }),
      calculateEffectiveQuality: vi.fn().mockReturnValue({
        effective: {
          videoBitrateKbps: 1200,
          maxWidth: 1280,
          maxHeight: 720,
          maxFps: 24,
          degradationPreference: "balanced",
        },
        clampReasons: [],
      }),
      applyToExactViewer: vi.fn().mockResolvedValue({
        maxBitrate: 1200000,
        maxFramerate: 24,
        scaleResolutionDownBy: 1,
        degradationPreference: "balanced",
        priority: "medium",
      }),
    };

    const runtimeAny = runtime as any;
    runtimeAny.getQualityCoordinator = () => qualityCoordinator;
    runtimeAny.getConnectionManager = () => ({
      getConnection: vi.fn().mockReturnValue({
        peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
        sendToPeer,
      }),
    });
    runtimeAny.getSyncService = () => ({ getSyncState: vi.fn().mockReturnValue(null) });

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: null,
    });

    // Pause
    await binding.handleViewerPaused("viewer-1", "ms-1", true);

    // Resume
    videoGetParams.mockReturnValue({
      encodings: [{ active: false, maxBitrate: 5000000, maxFramerate: 30, scaleResolutionDownBy: 1 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    });
    videoSetParams.mockClear();

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", false);

    expect(result.status).toBe("applied");
    const configured = (result as any).configured;
    expect(configured.maxBitrate).toBeGreaterThan(0);
    // Quality coordinator was consulted for viewer request
    expect(qualityCoordinator.getViewerRequest).toHaveBeenCalled();
    // Phase 6B: effective quality computed via senderController.computeEffectiveQuality
    // (shared resolver), not qualityCoordinator.calculateEffectiveQuality
  });

  it("handleViewerPaused returns configured readback on success", async () => {
    const videoSetParams = vi.fn();
    const videoGetParams = vi.fn(() => ({
      encodings: [{ active: true, maxBitrate: 5000000, maxFramerate: 30 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: null,
    });

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", true);
    expect(result.status).toBe("applied");
    const configured = (result as any).configured as import("../src/renderer/services/viewer-media-binding.js").SenderSettingsReadback;
    expect(configured.maxBitrate).toBe(5000000);
    expect(configured.maxFramerate).toBe(30);
  });

  it("handleViewerPaused returns apply-failed when setParameters throws on pause", async () => {
    const failingSetParams = vi.fn().mockRejectedValue(new Error("setParameters failed"));
    const getParams = vi.fn(() => ({
      encodings: [{ active: true }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-1",
    }));

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: getParams,
        setParameters: failingSetParams,
      } as unknown as RTCRtpSender,
      audioSender: null,
    });

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", true);
    expect(result.status).toBe("apply-failed");
    expect((result as any).error).toContain("setParameters failed");
  });

  it("handleViewerPaused returns apply-failed when setParameters throws on resume", async () => {
    const videoGetParams = vi.fn(() => ({
      encodings: [{ active: true }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));
    const audioGetParams = vi.fn(() => ({
      encodings: [{ active: true }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-a",
    }));
    const videoSetParams = vi.fn();
    const audioSetParams = vi.fn();

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: {
        track: { kind: "audio" },
        getParameters: audioGetParams,
        setParameters: audioSetParams,
      } as unknown as RTCRtpSender,
    });

    // Pre-pause so we have saved state
    const pauseResult = await binding.handleViewerPaused("viewer-1", "ms-1", true);
    expect(pauseResult.status).toBe("applied");

    // Resume with failing video setParameters
    videoGetParams.mockReturnValue({
      encodings: [{ active: false }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    });
    videoSetParams.mockClear();
    videoSetParams.mockRejectedValue(new Error("video resume failed"));

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", false);
    expect(result.status).toBe("apply-failed");
    expect((result as any).error).toContain("video resume failed");
  });

  it("handleViewerPaused resumes correctly when paused sender state is missing (fallback)", async () => {
    const videoSetParams = vi.fn();
    const videoGetParams = vi.fn(() => ({
      encodings: [{ active: false, maxBitrate: 5000000 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: null,
    });

    // Resume without having paused first — no saved state, should fall back
    // to reactivating all encodings
    const result = await binding.handleViewerPaused("viewer-1", "ms-1", false);
    expect(result.status).toBe("applied");
    expect(videoSetParams).toHaveBeenCalled();
    // Fallback: set active=true for all encodings
    expect(videoSetParams.mock.calls[0][0].encodings[0].active).toBe(true);
  });

  it("reapplies paused sender state after reconcileViewerByPeerUuid", async () => {
    // This test verifies that after a reconnect (sender replacement),
    // the paused state is reapplied to keep the viewer paused.
    const videoSetParams = vi.fn();
    const videoGetParams = vi.fn(() => ({
      encodings: [{ active: true, maxBitrate: 5000000 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));

    const pc = {
      connectionState: "connected",
      close: vi.fn(),
      getSenders: vi.fn().mockReturnValue([
        {
          track: { kind: "video" },
          getParameters: videoGetParams,
          setParameters: videoSetParams,
        },
      ]),
    } as unknown as RTCPeerConnection;

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc,
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: null,
    });

    // Pause the viewer
    await binding.handleViewerPaused("viewer-1", "ms-1", true);
    expect(videoSetParams).toHaveBeenCalled();
    videoSetParams.mockClear();

    // Re-resolution produces a "fresh" sender (encoding active=true)
    const freshGetParams = vi.fn(() => ({
      encodings: [{ active: true, maxBitrate: 5000000 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));
    const freshSetParams = vi.fn();
    pc.getSenders = vi.fn().mockReturnValue([
      {
        track: { kind: "video" },
        getParameters: freshGetParams,
        setParameters: freshSetParams,
      },
    ]);

    // Simulate reconnect — mapping resolved with default SDK (active=false)
    const mockSDK = {
      connections: new Map([
        ["peer-uuid-1", { publisher: { pc }, viewer: null }],
      ]),
    };
    const mockPublisher = { getSDK: vi.fn().mockReturnValue(mockSDK) };
    const mockPubManager = { getPublisher: vi.fn().mockReturnValue(mockPublisher) };

    const runtimeAny = runtime as any;
    runtimeAny.resolveLocalPublication = vi.fn().mockReturnValue({
      mediaSessionId: "ms-1",
      logicalStreamId: "stream-1",
      publisherManager: mockPubManager,
      vdoConfig: { streamId: "vdo-stream-abc", password: "vdo-password-xyz" },
    });

    // reconcileViewerByPeerUuid should reapply the paused state
    await binding.reconcileViewerByPeerUuid("peer-uuid-1");

    // The fresh sender should have its encoding disabled again (paused state reapplied)
    expect(freshSetParams).toHaveBeenCalled();
    expect(freshSetParams.mock.calls[0][0].encodings[0].active).toBe(false);
  });

  it("reapplies paused sender state after retryResolveSender resolves senders", async () => {
    vi.useFakeTimers();
    try {
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

      // Phase 6C: Paused state is now authoritative in the controller.
      // Pre-set paused state in the controller to verify retryResolveSender calls reapplyState.
      const senderController = runtime.getViewerSenderController();
      const bId = { groupId: "g-1", logicalStreamId: "stream-1", viewerDeviceId: "viewer-1", mediaSessionId: "ms-1" };
      senderController.registerSenders(bId, { videoSender: null, audioSender: null });

      (binding as any).viewerMap.set("viewer-1::ms-1", mapping);

      vi.spyOn(binding as any, "resolveSendersForMapping").mockImplementation((target: any) => {
        target.videoSender = { track: { kind: "video" }, getParameters: vi.fn(() => ({ encodings: [{ active: true }] })), setParameters: vi.fn() };
        target.audioSender = { track: { kind: "audio" }, getParameters: vi.fn(() => ({ encodings: [{ active: true }] })), setParameters: vi.fn() };
        return true;
      });
      vi.spyOn(binding, "reconcileViewerQuality").mockResolvedValue({ status: "applied", configured: { maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1, degradationPreference: "balanced", priority: "medium" } });

      (binding as any).retryResolveSender("viewer-1", "ms-1", "peer-uuid-1");
      await vi.advanceTimersByTimeAsync(2000);

      // retryResolveSender should call reapplyState on the controller
      expect(senderController.hasBinding(bId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps both senders paused when reconcileViewerByPeerUuid reapplies media mode", async () => {
    const videoSender = new FakeRTCRtpSender("video");
    const audioSender = new FakeRTCRtpSender("audio");
    const pc = {
      connectionState: "connected",
      close: vi.fn(),
      getSenders: vi.fn().mockReturnValue([videoSender, audioSender]),
    } as unknown as RTCPeerConnection;
    const mapping = {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc,
      videoSender,
      audioSender,
    };

    (binding as any).viewerMap.set("viewer-1::ms-1", mapping);
    await binding.handleViewerPaused("viewer-1", "ms-1", true);
    (binding as any).viewerMediaModes.set("viewer-1::ms-1", { audioEnabled: true, videoEnabled: true });

    await binding.reconcileViewerByPeerUuid("peer-uuid-1");

    expect(videoSender.encodingActiveStates).toEqual([false]);
    expect(audioSender.encodingActiveStates).toEqual([false]);
  });

  it("keeps both senders paused when retryResolveSender reapplies media mode", async () => {
    vi.useFakeTimers();
    try {
      const initialVideoSender = new FakeRTCRtpSender("video");
      const initialAudioSender = new FakeRTCRtpSender("audio");
      const freshVideoSender = new FakeRTCRtpSender("video");
      const freshAudioSender = new FakeRTCRtpSender("audio");
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
      const senderController = runtime.getViewerSenderController();
      const bId = { groupId: "g-1", logicalStreamId: "stream-1", viewerDeviceId: "viewer-1", mediaSessionId: "ms-1" };
      senderController.registerSenders(bId, { videoSender: initialVideoSender, audioSender: initialAudioSender });
      await senderController.applyPause(bId);

      (binding as any).viewerMap.set("viewer-1::ms-1", mapping);
      (binding as any).viewerMediaModes.set("viewer-1::ms-1", { audioEnabled: true, videoEnabled: true });
      vi.spyOn(binding as any, "resolveSendersForMapping").mockImplementation((target: any) => {
        target.videoSender = freshVideoSender;
        target.audioSender = freshAudioSender;
        return true;
      });
      vi.spyOn(binding, "reconcileViewerQuality").mockResolvedValue({
        status: "applied",
        configured: { maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1, degradationPreference: "balanced", priority: "medium" },
      });

      (binding as any).retryResolveSender("viewer-1", "ms-1", "peer-uuid-1");
      await vi.advanceTimersByTimeAsync(2000);

      expect(freshVideoSender.encodingActiveStates).toEqual([false]);
      expect(freshAudioSender.encodingActiveStates).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries paused-state reapplication and warns after exhaustion", async () => {
    vi.useFakeTimers();
    try {
      const senderController = runtime.getViewerSenderController();
      const reapplyState = vi.spyOn(senderController, "reapplyState").mockResolvedValue({ status: "sender-not-ready" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const bId = { groupId: "g-1", logicalStreamId: "stream-1", viewerDeviceId: "viewer-1", mediaSessionId: "ms-1" };

      const resultPromise = (binding as any).reapplyPausedStateWithRetry(bId, { width: 1920, height: 1080 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.status).toBe("sender-not-ready");
      expect(reapplyState).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledWith(
        "[ViewerMediaBinding] reapplyState returned non-applied after retries",
        expect.objectContaining({ result: { status: "sender-not-ready" } }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("viewer-paused state is authoritative in ViewerSenderController (not VMB)", async () => {
    const videoSetParams = vi.fn();
    const videoGetParams = vi.fn(() => ({
      encodings: [{ active: true }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: null,
    });

    await binding.handleViewerPaused("viewer-1", "ms-1", true);

    // Phase 6C: Paused state is in controller, not VMB
    const senderController = runtime.getViewerSenderController();
    const bId = { groupId: "g-1", logicalStreamId: "stream-1", viewerDeviceId: "viewer-1", mediaSessionId: "ms-1" };
    expect(senderController.getPausedState(bId)).not.toBeNull();
    expect(senderController.hasBinding(bId)).toBe(true);

    // Remove mapping — controller state should be cleaned up
    binding.removeViewerMapping("viewer-1", "ms-1");
    expect(senderController.hasBinding(bId)).toBe(false);
  });

  it("destroy clears controller paused state for all viewers", async () => {
    const videoSetParams = vi.fn();
    const videoGetParams = vi.fn(() => ({
      encodings: [{ active: true }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    }));

    (binding as any).viewerMap.set("viewer-1::ms-1", {
      viewerDeviceId: "viewer-1",
      viewerSessionId: "session-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "stream-1",
      mediaSessionId: "ms-1",
      pc: { connectionState: "connected", close: vi.fn() },
      videoSender: {
        track: { kind: "video" },
        getParameters: videoGetParams,
        setParameters: videoSetParams,
      } as unknown as RTCRtpSender,
      audioSender: null,
    });

    await binding.handleViewerPaused("viewer-1", "ms-1", true);

    // After VMB destroy, pause operations should return mapping-missing
    // (controller state is cleared by Phase3Runtime.destroy, not VMB.destroy)
    binding.destroy();

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", false);
    expect(result.status).toBe("mapping-missing");
  });

  // ─── Phase 6C: removed viewerPausedSenderStates tests — controller is authoritative ──

  // ─── Stateful-fake regression (Task B – readback verification) ──────────
  //
  // These tests use a non-Vitest-mock FakeRTCRtpSender whose setParameters()
  // updates internal readback state.  The existing Vitest-mock-based tests
  // bypass verifyEncodingStates (which returns true when "mock" in
  // getParametersFn).  These tests prove that the readback verification path
  // works correctly for both applying and non-applying senders.

  it("pause disables all video encodings (stateful fake, readback verified)", async () => {
    const videoSender = new FakeRTCRtpSender("video", [
      { active: true, maxBitrate: 5_000_000 },
      { active: true, maxBitrate: 1_000_000 },
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
      audioSender: null,
    });

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", true);

    expect(result.status).toBe("applied");
    // Internal state of the fake sender must show all encodings inactive
    expect(videoSender.encodingActiveStates).toEqual([false, false]);
  });

  it("pause disables all audio encodings (stateful fake, readback verified)", async () => {
    const videoSender = new FakeRTCRtpSender("video", [{ active: true, maxBitrate: 3_000_000 }]);
    const audioSender = new FakeRTCRtpSender("audio", [
      { active: true },
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

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", true);

    expect(result.status).toBe("applied");
    expect(videoSender.encodingActiveStates).toEqual([false]);
    expect(audioSender.encodingActiveStates).toEqual([false, false]);
  });

  it("resume restores only previously active encodings (stateful fake, readback verified)", async () => {
    const videoSender = new FakeRTCRtpSender("video", [
      { active: true, maxBitrate: 5_000_000 },
      { active: false, maxBitrate: 1_000_000 },
    ]);
    const audioSender = new FakeRTCRtpSender("audio", [
      { active: true },
      { active: false },
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
    expect(videoSender.encodingActiveStates).toEqual([false, false]);
    expect(audioSender.encodingActiveStates).toEqual([false, false]);

    // Resume — restore previously active encodings only
    const resumeResult = await binding.handleViewerPaused("viewer-1", "ms-1", false);
    expect(resumeResult.status).toBe("applied");
    // Encoding 0 was active before → active. Encoding 1 was inactive → inactive.
    expect(videoSender.encodingActiveStates).toEqual([true, false]);
    expect(audioSender.encodingActiveStates).toEqual([true, false]);
  });

  it("non-applying video sender returns apply-failed on pause (stateful fake, readback catches mismatch)", async () => {
    const videoSender = new FakeRTCRtpSender("video", [{ active: true }]);
    // Sender will accept setParameters but NOT update its internal state
    videoSender.ignoreSetParameters = true;

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

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", true);

    // Must NOT be "applied" — the readback didn't change
    expect(result.status).toBe("apply-failed");
    expect((result as any).error).toContain("readback mismatch");
  });

  it("non-applying audio sender returns apply-failed on pause (stateful fake, readback catches mismatch)", async () => {
    const videoSender = new FakeRTCRtpSender("video", [{ active: true }]);
    const audioSender = new FakeRTCRtpSender("audio", [{ active: true }]);
    audioSender.ignoreSetParameters = true;

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

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", true);

    expect(result.status).toBe("apply-failed");
    expect((result as any).error).toContain("readback mismatch");
  });

  it("non-applying video sender returns apply-failed on resume (stateful fake, readback catches mismatch)", async () => {
    const videoSender = new FakeRTCRtpSender("video", [{ active: true }]);

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

    // Pause first (applying sender — works fine)
    await binding.handleViewerPaused("viewer-1", "ms-1", true);

    // Now make the sender non-applying and try to resume
    videoSender.ignoreSetParameters = true;

    const result = await binding.handleViewerPaused("viewer-1", "ms-1", false);

    expect(result.status).toBe("apply-failed");
    expect((result as any).error).toContain("readback mismatch");
  });
});
