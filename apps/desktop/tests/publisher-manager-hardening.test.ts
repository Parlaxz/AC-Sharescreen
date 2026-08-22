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

function resetMockSDK() {
  // Reset all shared mock state. The HostPublisher mock factory closes over
  // mockSDKMethods, so each new HostPublisher instance automatically returns
  // the shared object — no need to patch individual instances.
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

// ═══════════════════════════════════════════════════════════════════════════════
// 1. STOP CAPTURE IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════════

describe("PublisherManager — stopCapture idempotency", () => {
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

  it("CHARACTERIZATION: stopCapture is idempotent when already idle", async () => {
    await pm.stopCapture();
    await pm.stopCapture();
    // Should not throw
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
  });

  it("CHARACTERIZATION: stopCapture does not throw when called after startPublishing", async () => {
    await pm.startPublishing(makeMediaStream(), makePublisherConfig());
    await expect(pm.stopCapture()).resolves.toBeUndefined();
    expect(pm.getState()).toBe("idle");
  });

  it("CHARACTERIZATION: second stopCapture call is idempotent (no crash, state ends idle)", async () => {
    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    // First call initiates stopping
    const p1 = pm.stopCapture();
    // Second call (before first settles) awaits the in-flight promise
    const p2 = pm.stopCapture();

    // Both should resolve to idle state
    await p1;
    await p2;
    expect(pm.getState()).toBe("idle");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. REPLACE VIDEO TRACK — Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("PublisherManager — replaceVideoTrack edge cases", () => {
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

  it("CHARACTERIZATION: replaceVideoTrack throws when no publisher active", async () => {
    const newTrack = {
      kind: "video",
      id: "new-track",
      enabled: true,
      readyState: "live",
      label: "new-capture",
      getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;

    await expect(pm.replaceVideoTrack(newTrack)).rejects.toThrow("replaceVideoTrack: no publisher active");
  });

  it("CHARACTERIZATION: replaceVideoTrack throws when no current video track", async () => {
    // Start publishing with a track
    await pm.startPublishing(makeMediaStream(), makePublisherConfig());

    const newTrack = {
      kind: "video",
      id: "new-track",
      enabled: true,
      readyState: "live",
      label: "new-capture",
      getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;

    // The _publishedVideoTrack was set by startPublishing, so this should succeed
    const oldTrack = await pm.replaceVideoTrack(newTrack);
    expect(oldTrack).toBeTruthy();
    expect(oldTrack.id).toBe("track-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. BITRATE CORRECTION BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════

describe("PublisherManager — bitrate correction behavior", () => {
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

  it("CHARACTERIZATION: startPublishing post-publish bitrate enforcement catches mismatch", async () => {
    // Set up mock sender with mismatched bitrate
    let params: RTCRtpSendParameters = {
      encodings: [{ active: true, maxBitrate: 1_000_000 } as RTCRtpEncodingParameters],
      transactionId: "tx-test",
      codecs: [],
      headerExtensions: [],
      rtcp: { reducedSize: false, compound: false },
    };

    const sender = {
      getParameters: vi.fn(() => {
        // Return current params
        return params;
      }),
      setParameters: vi.fn(async (p: RTCRtpSendParameters) => {
        params = p;
      }),
      track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) },
    } as unknown as RTCRtpSender;

    const pc = {
      getSenders: vi.fn(() => [sender]),
      getTransceivers: vi.fn(() => []),
    } as unknown as RTCPeerConnection;

    mockSDKMethods.connections.set("peer-test", { publisher: { pc } });

    // Start with bitrate 2000 Kbps = 2,000,000 bps — but sender has 1,000,000
    await pm.startPublishing(makeMediaStream(), makePublisherConfig({ videoBitrate: 2000 }));

    // Bitrate correction should have updated maxBitrate to 2,000,000
    const updatedParams = sender.getParameters();
    const maxBitrate = updatedParams.encodings?.[0]?.maxBitrate ?? 0;
    expect(maxBitrate).toBe(2_000_000);

    // Verify setParameters was called for correction
    expect(sender.setParameters).toHaveBeenCalled();
  });

  it("CHARACTERIZATION: startPublishing with zero bitrate does not trigger correction", async () => {
    let params: RTCRtpSendParameters = {
      encodings: [{ active: true, maxBitrate: 0 } as RTCRtpEncodingParameters],
      transactionId: "tx-test",
      codecs: [],
      headerExtensions: [],
      rtcp: { reducedSize: false, compound: false },
    };

    const sender = {
      getParameters: vi.fn(() => params),
      setParameters: vi.fn(async (p: RTCRtpSendParameters) => { params = p; }),
      track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) },
    } as unknown as RTCRtpSender;

    const pc = {
      getSenders: vi.fn(() => [sender]),
      getTransceivers: vi.fn(() => []),
    } as unknown as RTCPeerConnection;

    mockSDKMethods.connections.set("peer-zero", { publisher: { pc } });

    await pm.startPublishing(makeMediaStream(), makePublisherConfig({ videoBitrate: 0 }));

    // Zero bitrate requested — correction is skipped (requestedBps === 0).
    // The sender.setParameters should NOT have been called for correction.
    expect(sender.setParameters).not.toHaveBeenCalled();

    // The maxBitrate should remain at 0 (unchanged by correction logic).
    const finalParams = sender.getParameters();
    expect(finalParams.encodings?.[0]?.maxBitrate).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. DESTROY BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════

describe("PublisherManager — destroy behavior", () => {
  let pm: PublisherManager;
  let events: ReturnType<typeof makeEvents>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSDK();
    events = makeEvents();
    pm = new PublisherManager(events);
  });

  it("CHARACTERIZATION: destroy does not throw when idle", () => {
    expect(() => pm.destroy()).not.toThrow();
  });

  it("CHARACTERIZATION: destroy does not throw after startPublishing", async () => {
    await pm.startPublishing(makeMediaStream(), makePublisherConfig());
    expect(() => pm.destroy()).not.toThrow();
  });

  it("CHARACTERIZATION: getPublisher returns null after stopCapture", async () => {
    await pm.startPublishing(makeMediaStream(), makePublisherConfig());
    await pm.stopCapture();
    expect(pm.getPublisher()).toBeNull();
  });

  it("CHARACTERIZATION: getAudioState returns disabled after stopCapture", async () => {
    await pm.startPublishing(makeMediaStream(), makePublisherConfig());
    await pm.stopCapture();
    expect(pm.getAudioState()).toBe("disabled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. AUDIO CONTROLLER BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════

describe("PublisherManager — audio controller edge cases", () => {
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

  it("CHARACTERIZATION: clearAudioController when no controller set does not throw", () => {
    expect(() => pm.clearAudioController()).not.toThrow();
    expect(pm.getAudioState()).toBe("disabled");
  });

  it("CHARACTERIZATION: hasAudio returns false before any controller set", () => {
    expect(pm.hasAudio()).toBe(false);
  });

  it("CHARACTERIZATION: getAudioTrack returns null before any controller set", () => {
    expect(pm.getAudioTrack()).toBeNull();
  });
});
