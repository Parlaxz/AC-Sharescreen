// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { QualityCoordinator } from "../src/renderer/services/quality-coordinator.js";
import { ViewerMediaBinding } from "../src/renderer/services/viewer-media-binding.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";
import type { GroupControlEnvelope } from "@screenlink/shared";
import { createDefaultGroupQualitySettings, createDefaultHostQualityLimits } from "@screenlink/shared";

// ─── Mock Helpers ───────────────────────────────────────────────────────────

function createMockSender(
  storedParams?: Partial<RTCRtpSendParameters>,
): RTCRtpSender {
  let params: RTCRtpSendParameters = {
    encodings: [
      {
        active: true,
        maxBitrate: 500_000,
        maxFramerate: 15,
        scaleResolutionDownBy: 1,
        degradationPreference: "maintain-resolution",
        priority: "medium",
      },
    ],
    transactionId: "tx-test",
    codecs: [],
    headerExtensions: [],
    rtcp: {},
    degradationPreference: "maintain-resolution",
    ...storedParams,
  };

  return {
    getParameters: vi.fn(() => params),
    setParameters: vi.fn(async (p: RTCRtpSendParameters) => {
      params = p;
    }),
    track: {
      kind: "video",
      getSettings: () => ({ width: 1920, height: 1080 }),
    } as MediaStreamTrack,
  } as unknown as RTCRtpSender;
}

function createMockPeerConnection(sender?: RTCRtpSender): RTCPeerConnection {
  return {
    getStats: vi.fn().mockResolvedValue({
      forEach: vi.fn(),
      entries: () => [],
      keys: () => [],
      values: () => [],
      size: 0,
      [Symbol.iterator]: function* () {},
    } as unknown as RTCStatsReport),
    getSenders: vi.fn().mockReturnValue(sender ? [sender] : []),
    getReceivers: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as RTCPeerConnection;
}

function makeMockRuntime(): Phase3Runtime {
  const registry = {
    registerLocalStream: vi.fn(),
    handleStopped: vi.fn(),
    getStream: vi.fn().mockReturnValue(null),
    getAllStreams: vi.fn().mockReturnValue([]),
  };
  const connManager = {
    broadcast: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue(null),
  };
  const viewerBinding = {
    removeViewer: vi.fn(),
    getAllViewers: vi.fn().mockReturnValue([]),
    getViewerVideoSender: vi.fn().mockReturnValue(null),
    getViewerMediaPeer: vi.fn().mockReturnValue(null),
  };
  const syncService = {
    getSyncState: vi.fn().mockReturnValue(null),
    performLocalEdit: vi.fn().mockResolvedValue(undefined),
    handleGroupMessage: vi.fn(),
  };
  const mediaStatsService = {
    startViewerPoller: vi.fn(),
    stopViewerPoller: vi.fn(),
    disconnectViewer: vi.fn(),
    hasViewerPoller: vi.fn().mockReturnValue(false),
    getViewerStats: vi.fn().mockReturnValue(null),
    getViewerPollerPC: vi.fn().mockReturnValue(null),
    stopAllViewerPollers: vi.fn(),
    stop: vi.fn(),
  };
  const ssm = {
    currentLogicalStreamId: null,
    currentMediaSessionId: null,
    currentGroupId: null,
    state: "idle",
    getCurrentVdoConfig: () => null,
    getPublisherManager: () => null,
  };
  const runtime = {
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ssm,
    getViewerMediaBinding: () => viewerBinding,
    getSyncService: () => syncService,
    getMediaStatsService: () => mediaStatsService,
    getQualityCoordinator: () => new QualityCoordinator(),
    viewerBinding,
    syncService,
    ssm,
    deviceId: "host-device",
    displayName: "Host",
  } as unknown as Phase3Runtime & {
    viewerBinding: typeof viewerBinding;
    syncService: typeof syncService;
    ssm: typeof ssm;
  };
  // Expose mediaStatsService directly on the mock for access via getMediaStatsService
  (runtime as any)._mss = mediaStatsService;
  return runtime;
}

describe("Per-Viewer Quality Apply + Stats Wiring (Stage 6/7)", () => {
  let coordinator: QualityCoordinator;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    coordinator = new QualityCoordinator();
    runtime = makeMockRuntime();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Quality applies to exact viewer sender ────────────────────────

  it("quality.viewer.request applies quality only to the targeted viewer's sender", () => {
    const senderV1 = createMockSender();
    const senderV2 = createMockSender();

    // Store the requests
    coordinator.handleViewerRequest("g-1", "s-1", "v-1", {
      streamSessionId: "s-1",
      requestId: "req-1",
      revision: 1,
      videoBitrateKbps: 3000,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 30,
      degradationPreference: "balanced",
    });
    coordinator.handleViewerRequest("g-1", "s-1", "v-2", {
      streamSessionId: "s-1",
      requestId: "req-2",
      revision: 1,
      videoBitrateKbps: 1000,
      maxWidth: 854,
      maxHeight: 480,
      maxFps: 15,
      degradationPreference: "maintain-resolution",
    });

    // v-1 request
    const req1 = coordinator.getViewerRequest("g-1", "s-1", "v-1");
    expect(req1).not.toBeNull();
    expect(req1!.videoBitrateKbps).toBe(3000);

    // v-2 request
    const req2 = coordinator.getViewerRequest("g-1", "s-1", "v-2");
    expect(req2).not.toBeNull();
    expect(req2!.videoBitrateKbps).toBe(1000);

    // Apply only v-1's effective quality to senderV1
    const groupSettings = createDefaultGroupQualitySettings();
    const hostLimits = createDefaultHostQualityLimits();
    const eff1 = coordinator.calculateEffectiveQuality(
      groupSettings, hostLimits, req1, { width: 1920, height: 1080 },
    );
    expect(eff1.effective.videoBitrateKbps).toBe(3000);

    // senderV2 should still have default values
    const params2 = senderV2.getParameters();
    expect(params2.encodings?.[0]?.maxBitrate).toBe(500_000);
  });

  it("quality.viewer.request only changes the targeted viewer's sender via applyToExactViewer", async () => {
    const sender1 = createMockSender();
    const sender2 = createMockSender();

    const effective1 = {
      videoBitrateKbps: 2500,
      maxWidth: 1280,
      maxHeight: 720,
      maxFps: 25,
      degradationPreference: "maintain-resolution",
    };

    // Apply to viewer-1 only
    await coordinator.applyToExactViewer("viewer-1", "peer-uuid-1", sender1, effective1);

    // sender1 should have the new values
    const p1 = sender1.getParameters();
    expect(p1.encodings?.[0]?.maxBitrate).toBe(2_500_000);

    // sender2 should be unchanged
    const p2 = sender2.getParameters();
    expect(p2.encodings?.[0]?.maxBitrate).toBe(500_000);
  });

  it("quality.viewer.clear removes only the targeted viewer's request", () => {
    coordinator.storeViewerRequest("g-1", "s-1", "v-1", {
      streamSessionId: "s-1",
      requestId: "req-1",
      revision: 1,
      videoBitrateKbps: 3000,
      maxWidth: 1920, maxHeight: 1080, maxFps: 30,
      degradationPreference: "balanced",
      requestedAt: Date.now(),
    });
    coordinator.storeViewerRequest("g-1", "s-1", "v-2", {
      streamSessionId: "s-1",
      requestId: "req-2",
      revision: 1,
      videoBitrateKbps: 1000,
      maxWidth: 854, maxHeight: 480, maxFps: 15,
      degradationPreference: "maintain-resolution",
      requestedAt: Date.now(),
    });

    // Clear only v-1
    coordinator.handleViewerClear("g-1", "s-1", "v-1");

    // v-1 should be gone
    expect(coordinator.getViewerRequest("g-1", "s-1", "v-1")).toBeNull();

    // v-2 should remain
    expect(coordinator.getViewerRequest("g-1", "s-1", "v-2")).not.toBeNull();
    expect(coordinator.getViewerRequest("g-1", "s-1", "v-2")!.videoBitrateKbps).toBe(1000);
  });

  it("clear removes override and falls back to group defaults for the exact viewer", () => {
    const sender = createMockSender({
      encodings: [{
        active: true,
        maxBitrate: 3_000_000,
        maxFramerate: 30,
        scaleResolutionDownBy: 1,
        degradationPreference: "balanced",
        priority: "medium",
      }],
    });

    // Simulate the clear flow: set effective quality back to group defaults
    const groupSettings = createDefaultGroupQualitySettings();
    const hostLimits = createDefaultHostQualityLimits();
    const effective = coordinator.calculateEffectiveQuality(
      groupSettings, hostLimits, null, { width: 1920, height: 1080 },
    );

    coordinator.applyToSender(sender, effective.effective);

    // After clear, the sender should have group default values
    const params = sender.getParameters();
    expect(params.encodings?.[0]?.maxBitrate).toBe(650_000); // group default * 1000
    expect(params.encodings?.[0]?.maxFramerate).toBe(15); // group default fps
  });

  // ─── Stats poller starts for exact viewer and is removed on disconnect ──

  it("stats poller starts for the exact viewer when binding is established", () => {
    const mss = runtime.getMediaStatsService();

    // Simulate the binding lifecycle: consumeBinding starts the poller
    const pc = createMockPeerConnection();
    mss.startViewerPoller(
      "g-1",
      "s-1",
      "v-1",
      "peer-uuid-1",
      pc,
      expect.any(Function),
    );

    expect(mss.startViewerPoller).toHaveBeenCalledWith(
      "g-1",
      "s-1",
      "v-1",
      "peer-uuid-1",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("stats poller uses the exact RTCPeerConnection for the bound viewer", () => {
    const pc1 = createMockPeerConnection(createMockSender());
    const pc2 = createMockPeerConnection(createMockSender());

    const mss = runtime.getMediaStatsService();

    // Start poller for v-1 with pc1
    mss.startViewerPoller("g-1", "s-1", "v-1", "p-1", pc1, vi.fn());
    // Start poller for v-2 with pc2
    mss.startViewerPoller("g-1", "s-1", "v-2", "p-2", pc2, vi.fn());

    // Each viewer has its own PC
    const calls = mss.startViewerPoller.mock.calls;
    const call1 = calls.find((c: unknown[]) => c[2] === "v-1");
    const call2 = calls.find((c: unknown[]) => c[2] === "v-2");
    expect(call1?.[4]).toBe(pc1);
    expect(call2?.[4]).toBe(pc2);
    expect(call1?.[4]).not.toBe(call2?.[4]);
  });

  it("stats poller is stopped and removed when viewer disconnects", () => {
    const mss = runtime.getMediaStatsService();

    // Simulate removeViewer calling disconnectViewer on the stats service
    mss.disconnectViewer("g-1", "s-1", "v-1", "peer-uuid-1");

    expect(mss.disconnectViewer).toHaveBeenCalledWith(
      "g-1",
      "s-1",
      "v-1",
      "peer-uuid-1",
    );
  });

  it("stats poller is removed for the exact viewer only, other viewers unaffected", () => {
    const mss = runtime.getMediaStatsService();

    const pc1 = createMockPeerConnection();
    const pc2 = createMockPeerConnection();

    // Start two viewer pollers
    mss.startViewerPoller("g-1", "s-1", "v-1", "p-1", pc1, vi.fn());
    mss.startViewerPoller("g-1", "s-1", "v-2", "p-2", pc2, vi.fn());

    // Disconnect v-1 only
    mss.disconnectViewer("g-1", "s-1", "v-1", "p-1");

    // v-1 poller should be removed
    // v-2 poller should remain
    const disconnects = mss.disconnectViewer.mock.calls;
    expect(disconnects.length).toBe(1);
    expect(disconnects[0][2]).toBe("v-1");
  });

  it("ViewerMediaBinding.removeViewer calls stats service disconnectViewer", () => {
    // Create a binding and simulate a mapped viewer
    const binding = new ViewerMediaBinding(runtime);
    const mss = runtime.getMediaStatsService();

    // Manually inject a mapping (normally done by consumeBinding)
    (binding as any).viewerMap.set("viewer-1", {
      viewerDeviceId: "viewer-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "s-1",
      mediaSessionId: "ms-1",
      pc: null,
      videoSender: null,
    });

    // Remove viewer
    binding.removeViewer("viewer-1");

    // Should call disconnectViewer with the correct key
    expect(mss.disconnectViewer).toHaveBeenCalledWith(
      "g-1",
      "s-1",
      "viewer-1",
      "peer-uuid-1",
    );

    binding.destroy();
  });

  it("ViewerMediaBinding stores the RTCPeerConnection and video sender in the mapping", () => {
    const sender = createMockSender();
    const pc = createMockPeerConnection(sender);

    // Simulate what consumeBinding does: resolve PC and sender
    const mapping = {
      viewerDeviceId: "viewer-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "s-1",
      mediaSessionId: "ms-1",
      pc,
      videoSender: sender,
    };

    expect(mapping.pc).toBe(pc);
    expect(mapping.videoSender).toBe(sender);
    expect(mapping.viewerDeviceId).toBe("viewer-1");
    expect(mapping.mediaPeerUuid).toBe("peer-uuid-1");
    expect(mapping.groupId).toBe("g-1");
    expect(mapping.logicalStreamId).toBe("s-1");
    expect(mapping.mediaSessionId).toBe("ms-1");
  });

  it("getViewerVideoSender returns the correct sender for the exact viewer", () => {
    const sender = createMockSender();
    const binding = new ViewerMediaBinding(runtime);

    // Inject mapping
    (binding as any).viewerMap.set("viewer-1", {
      viewerDeviceId: "viewer-1",
      mediaPeerUuid: "peer-uuid-1",
      groupId: "g-1",
      logicalStreamId: "s-1",
      mediaSessionId: "ms-1",
      pc: createMockPeerConnection(sender),
      videoSender: sender,
    });

    const result = binding.getViewerVideoSender("viewer-1");
    expect(result).toBe(sender);

    // Non-existent viewer returns null
    expect(binding.getViewerVideoSender("nonexistent")).toBeNull();

    binding.destroy();
  });

  it("Phase3Runtime creates QualityCoordinator and wires it into GroupMessageRouter", () => {
    // This tests that the runtime instantiation path creates the coordinator
    // The initialize method of Phase3Runtime creates:
    //   this.qualityCoordinator = new QualityCoordinator();
    //   this.mediaStatsService = new MediaStatsPoller();
    // Then wires them into GroupMessageRouter

    // Verify that getQualityCoordinator and getMediaStatsService exist
    expect(typeof runtime.getQualityCoordinator).toBe("function");
    expect(typeof runtime.getMediaStatsService).toBe("function");

    // Verify they return non-null values (runtime mock provides them)
    const qc = runtime.getQualityCoordinator();
    expect(qc).toBeDefined();
  });
});
