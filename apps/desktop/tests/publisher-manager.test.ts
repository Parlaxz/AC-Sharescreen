// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock helpers ───────────────────────────────────────────────────
const mockSDKMethods = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  connections: new Map<string, { publisher?: { pc?: RTCPeerConnection } }>(),
  _handlers: new Map<string, Set<(...args: unknown[]) => void>>(),
  _trigger: vi.fn(),
}));

vi.mock("@screenlink/vdo-adapter", () => ({
  HostPublisher: vi.fn(() => ({
    createAndConnect: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    stopPublishing: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    replaceVideoTrack: vi.fn().mockResolvedValue(undefined),
    getSDK: vi.fn(() => mockSDKMethods),
  })),
}));

import { HostPublisher } from "@screenlink/vdo-adapter";
import { PublisherManager } from "../src/renderer/services/publisher-manager.js";
import type { MediaStatsSnapshot } from "../src/renderer/services/media-stats-service.js";
import { extractPeerUuid } from "../src/renderer/services/sdk-event-normalizer.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvents() {
  return {
    onStateChange: vi.fn(),
    onStats: vi.fn(),
    onError: vi.fn(),
    onTrackEnded: vi.fn(),
  };
}

function makePublisherConfig(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "source-1",
    password: "pw-test",
    streamId: "stream-test",
    videoBitrate: 2000,
    videoWidth: 1280,
    videoHeight: 720,
    videoFps: 30,
    ...overrides,
  };
}

function makeMediaStream(): MediaStream {
  const track = {
    kind: "video",
    id: "track-1",
    enabled: true,
    readyState: "live",
    label: "test-capture",
    contentHint: "motion",
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;

  return {
    getVideoTracks: vi.fn(() => [track]),
    getAudioTracks: vi.fn(() => []),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    getTrackById: vi.fn(),
    clone: vi.fn(),
    getAudioTrack: vi.fn(),
    getVideoTrack: vi.fn(),
    id: "stream-1",
    active: true,
  } as unknown as MediaStream;
}

function makeMockSender(initialParams?: Partial<RTCRtpSendParameters>): RTCRtpSender {
  let params: RTCRtpSendParameters = {
    encodings: [
      {
        active: true,
        maxBitrate: 2_000_000,
        maxFramerate: 30,
        scaleResolutionDownBy: 1,
        degradationPreference: "balanced",
        priority: "medium",
      } as RTCRtpEncodingParameters,
    ],
    transactionId: "tx-test",
    codecs: [],
    headerExtensions: [],
    rtcp: { reducedSize: false, compound: false },
  };
  if (params.encodings && initialParams) {
    Object.assign(params.encodings[0], initialParams);
  }
  return {
    getParameters: vi.fn(() => params),
    setParameters: vi.fn(async (p: RTCRtpSendParameters) => {
      params = p;
    }),
    track: {
      kind: "video",
      getSettings: () => ({ width: 1920, height: 1080 }),
    } as MediaStreamTrack,
    replaceTrack: vi.fn(),
  } as unknown as RTCRtpSender;
}

function makeMockPC(senders: RTCRtpSender[] = []): RTCRtpConnection {
  return {
    getSenders: vi.fn(() => senders),
    getTransceivers: vi.fn(() => []),
    addTransceiver: vi.fn(),
    createOffer: vi.fn(),
    setLocalDescription: vi.fn(),
    close: vi.fn(),
  } as unknown as RTCPeerConnection;
}

function makeMockGroup(): { publisher?: { pc?: RTCPeerConnection } } {
  return { publisher: { pc: makeMockPC() } };
}

// Reset the mock SDK state before each test
function resetMockSDK() {
  // The vi.mock returns the same HostPublisher mock; re-set getSDK return
  const mockHostPub = (HostPublisher as ReturnType<typeof vi.fn>).mock.results[0]?.value;
  // We re-initialize fresh SDK mock state
  mockSDKMethods.on.mockReset();
  mockSDKMethods.off.mockReset();
  mockSDKMethods.connections = new Map();
  mockSDKMethods._handlers = new Map();
  mockSDKMethods._trigger = vi.fn((event: string, ...args: unknown[]) => {
    const handlers = mockSDKMethods._handlers.get(event);
    if (handlers) {
      handlers.forEach((h) => h(...args));
    }
  });

  // Re-wire getSDK to return our controlled mock
  const mockCtor = HostPublisher as ReturnType<typeof vi.fn>;
  if (mockCtor.mock.results.length > 0) {
    const instance = mockCtor.mock.results[mockCtor.mock.results.length - 1].value;
    if (instance) {
      instance.getSDK.mockReturnValue(mockSDKMethods);
    }
  }

  // Patch on/off to record handlers
  mockSDKMethods.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (!mockSDKMethods._handlers.has(event)) {
      mockSDKMethods._handlers.set(event, new Set());
    }
    mockSDKMethods._handlers.get(event)!.add(handler);
  });
  mockSDKMethods.off.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    mockSDKMethods._handlers.get(event)?.delete(handler);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PublisherManager — peer-disconnect event attachment", () => {
  let pm: PublisherManager;
  let events: ReturnType<typeof makeEvents>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSDK();
    events = makeEvents();
    pm = new PublisherManager(events);
  });

  afterEach(async () => {
    await pm.stopCapture().catch(() => {});
  });

  it("fires handler registered before startPublishing when a peerDisconnected event occurs", async () => {
    const onPeerDisc = vi.fn();
    pm.setOnPeerDisconnected(onPeerDisc);

    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    // Trigger peerDisconnected through the SDK mock
    mockSDKMethods._trigger("peerDisconnected", "peer-uuid-1");

    expect(onPeerDisc).toHaveBeenCalledWith("peer-uuid-1");
  });

  it("fires handler registered after startPublishing when a peerDisconnected event occurs", async () => {
    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    const onPeerDisc = vi.fn();
    pm.setOnPeerDisconnected(onPeerDisc);

    mockSDKMethods._trigger("peerDisconnected", "peer-uuid-2");

    expect(onPeerDisc).toHaveBeenCalledWith("peer-uuid-2");
  });

  it("fires exactly one callback per event (no duplicate listeners)", async () => {
    const onPeerDisc = vi.fn();
    pm.setOnPeerDisconnected(onPeerDisc);

    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    // Second registration (simulates restart re-registration)
    const onPeerDisc2 = vi.fn();
    pm.setOnPeerDisconnected(onPeerDisc2);

    mockSDKMethods._trigger("peerDisconnected", "peer-uuid-3");

    // Only the latest handler should fire
    expect(onPeerDisc).not.toHaveBeenCalled();
    expect(onPeerDisc2).toHaveBeenCalledTimes(1);
  });

  it("does not fire handler after stopCapture (teardown)", async () => {
    const onPeerDisc = vi.fn();
    pm.setOnPeerDisconnected(onPeerDisc);

    await pm.startPublishing(makeMediaStream(), makePublisherConfig());
    await pm.stopCapture();

    mockSDKMethods._trigger("peerDisconnected", "peer-uuid-4");

    expect(onPeerDisc).not.toHaveBeenCalled();
  });
});

describe("PublisherManager — applyVideoSenderSettings", () => {
  let pm: PublisherManager;
  let events: ReturnType<typeof makeEvents>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSDK();
    events = makeEvents();
    pm = new PublisherManager(events);
  });

  afterEach(async () => {
    await pm.stopCapture().catch(() => {});
  });

  it("applies settings to all current senders and returns per-peer results", async () => {
    const sender1 = makeMockSender({ maxBitrate: 1_000_000, maxFramerate: 15 });
    const sender2 = makeMockSender({ maxBitrate: 2_000_000, maxFramerate: 30 });
    const pc1 = makeMockPC([sender1]);
    const pc2 = makeMockPC([sender2]);

    // Set up SDK connections (simulating two connected viewers)
    mockSDKMethods.connections.set("peer-a", { publisher: { pc: pc1 } });
    mockSDKMethods.connections.set("peer-b", { publisher: { pc: pc2 } });

    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    const result = await pm.applyVideoSenderSettings({ maxBitrate: 4000, maxFramerate: 60 });

    expect(result.results).toHaveLength(2);
    expect(result.overall).toBe("all-succeeded");

    // Both senders should have been updated
    expect(sender1.setParameters).toHaveBeenCalled();
    expect(sender2.setParameters).toHaveBeenCalled();

    // Readbacks should reflect the applied values
    for (const r of result.results) {
      expect(r.success).toBe(true);
      expect(r.readback).not.toBeNull();
      if (r.readback) {
        // maxBitrate is in bps; we set 4000 kbps = 4,000,000 bps
        expect(r.readback.maxBitrate).toBe(4_000_000);
        expect(r.readback.maxFramerate).toBe(60);
      }
    }
  });

  it("returns partial failure when one sender fails", async () => {
    const sender1 = makeMockSender();
    const sender2 = makeMockSender();
    // Make sender2's setParameters throw
    sender2.setParameters = vi.fn().mockRejectedValue(new Error("sender-error"));
    const pc1 = makeMockPC([sender1]);
    const pc2 = makeMockPC([sender2]);

    mockSDKMethods.connections.set("peer-a", { publisher: { pc: pc1 } });
    mockSDKMethods.connections.set("peer-b", { publisher: { pc: pc2 } });

    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    const result = await pm.applyVideoSenderSettings({ maxBitrate: 3000, maxFramerate: 30 });

    expect(result.results).toHaveLength(2);
    // At least one succeeded, one failed
    const succeeded = result.results.filter((r) => r.success);
    const failed = result.results.filter((r) => !r.success);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0].error).toBe("sender-error");
    // Overall should be "partial" when some fail and some succeed
    expect(result.overall).toBe("partial");
  });

  it("returns readback for each peer with applied sender parameters", async () => {
    const sender = makeMockSender({ maxBitrate: 500_000, maxFramerate: 10 });
    const pc = makeMockPC([sender]);
    mockSDKMethods.connections.set("peer-a", { publisher: { pc } });

    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    const result = await pm.applyVideoSenderSettings({ maxBitrate: 2500, maxFramerate: 25 });

    expect(result.results).toHaveLength(1);
    const r = result.results[0];
    expect(r.peerUuid).toBe("peer-a");
    expect(r.success).toBe(true);
    expect(r.readback).toEqual({
      maxBitrate: 2_500_000,
      maxFramerate: 25,
      scaleResolutionDownBy: 1,
      degradationPreference: "balanced",
      priority: "medium",
    });
  });

  it("returns all-succeeded with empty results when no connections exist", async () => {
    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    const result = await pm.applyVideoSenderSettings({ maxBitrate: 1000, maxFramerate: 15 });

    expect(result.results).toHaveLength(0);
    expect(result.overall).toBe("all-succeeded");
  });

  it("returns empty result when not publishing (no publisher)", async () => {
    const result = await pm.applyVideoSenderSettings({ maxBitrate: 1000, maxFramerate: 15 });

    expect(result.results).toHaveLength(0);
    expect(result.overall).toBe("all-succeeded");
  });

  it("applies settings to late-joining viewers when they appear in connections at call time", async () => {
    const sender1 = makeMockSender();
    const pc1 = makeMockPC([sender1]);
    mockSDKMethods.connections.set("viewer-early", { publisher: { pc: pc1 } });

    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    // Apply initial settings
    await pm.applyVideoSenderSettings({ maxBitrate: 3000, maxFramerate: 30 });

    // Simulate a late-joining viewer
    const sender2 = makeMockSender({ maxBitrate: 1_000_000, maxFramerate: 15 });
    const pc2 = makeMockPC([sender2]);
    mockSDKMethods.connections.set("viewer-late", { publisher: { pc: pc2 } });

    // Apply settings again — late joiner should get the settings too
    const result = await pm.applyVideoSenderSettings({ maxBitrate: 5000, maxFramerate: 60 });

    expect(result.results).toHaveLength(2);
    const lateResult = result.results.find((r) => r.peerUuid === "viewer-late");
    expect(lateResult).toBeDefined();
    expect(lateResult!.success).toBe(true);
    expect(lateResult!.readback?.maxBitrate).toBe(5_000_000);
  });
});

describe("PublisherManager — setQuality is removed (replaced by applyVideoSenderSettings)", () => {
  it("does not expose setQuality method", () => {
    const pm = new PublisherManager(makeEvents());
    expect((pm as any).setQuality).toBeUndefined();
  });
});
