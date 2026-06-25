import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  getPublisherConnection,
  getViewerConnection,
  getVideoSender,
  getAudioSender,
  getPeerConnection,
  getVideoSenderForPeer,
} from "../src/connection-access.js";
import type { VDONinjaSDK, PeerGroup } from "../src/sdk-types.js";

// ─── Stub global RTCPeerConnection for instanceof checks ────────────────────

beforeAll(() => {
  if (typeof globalThis.RTCPeerConnection === "undefined") {
    class StubRTCPeerConnection {
      static getCapabilities() { return null; }
      getSenders() { return []; }
      getReceivers() { return []; }
      getTransceivers() { return []; }
      close() {}
      addEventListener() {}
      removeEventListener() {}
      createOffer() { return Promise.resolve({ type: "offer", sdp: "" }); }
      setLocalDescription() { return Promise.resolve(); }
    }
    (globalThis as any).RTCPeerConnection = StubRTCPeerConnection;
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock PC with vi.fn() methods that are instanceof RTCPeerConnection. */
function createMockPeerConnection(overrides?: Partial<RTCPeerConnection>): RTCPeerConnection {
  // Create a proper instance first (for instanceof checks)
  const instance = new RTCPeerConnection();
  // Replace methods with vi.fn() mocks
  const mock: Partial<RTCPeerConnection> = {
    ...instance,
    getSenders: vi.fn().mockReturnValue(overrides?.getSenders?.() ?? []),
    getReceivers: vi.fn().mockReturnValue(overrides?.getReceivers?.() ?? []),
    getTransceivers: vi.fn().mockReturnValue(overrides?.getTransceivers?.() ?? []),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...overrides,
  };
  // But we must ensure instanceof works - we can do this by prototyping
  Object.setPrototypeOf(mock, RTCPeerConnection.prototype);
  return mock as unknown as RTCPeerConnection;
}

function createMockPeerGroup(overrides?: Partial<PeerGroup>): PeerGroup {
  return {
    viewer: undefined,
    publisher: undefined,
    ...overrides,
  };
}

function createMockSDK(connections?: Map<string, PeerGroup>): VDONinjaSDK {
  return {
    VERSION: "1.0",
    connections: connections ?? new Map(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    publish: vi.fn(),
    stopPublishing: vi.fn(),
    view: vi.fn(),
    stopViewing: vi.fn(),
    sendData: vi.fn(),
    getStats: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as VDONinjaSDK;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("getPeerConnection — exact PC lookup", () => {
  it("returns publisher PC when no viewer PC exists", () => {
    const pc = createMockPeerConnection();
    const connections = new Map<string, PeerGroup>();
    connections.set("peer-uuid", createMockPeerGroup({ publisher: { pc } }));
    const sdk = createMockSDK(connections);

    const result = getPeerConnection(sdk, "peer-uuid");
    expect(result).toBe(pc);
  });

  it("returns viewer PC when no publisher PC exists", () => {
    const pc = createMockPeerConnection();
    const connections = new Map<string, PeerGroup>();
    connections.set("peer-uuid", createMockPeerGroup({ viewer: { pc } }));
    const sdk = createMockSDK(connections);

    const result = getPeerConnection(sdk, "peer-uuid");
    expect(result).toBe(pc);
  });

  it("prefers publisher PC over viewer PC when both exist", () => {
    const publisherPc = createMockPeerConnection();
    const viewerPc = createMockPeerConnection();
    const connections = new Map<string, PeerGroup>();
    connections.set("peer-uuid", createMockPeerGroup({
      publisher: { pc: publisherPc },
      viewer: { pc: viewerPc },
    }));
    const sdk = createMockSDK(connections);

    const result = getPeerConnection(sdk, "peer-uuid");
    expect(result).toBe(publisherPc);
  });

  it("returns null for non-existent peer UUID", () => {
    const sdk = createMockSDK(new Map());
    const result = getPeerConnection(sdk, "nonexistent-peer");
    expect(result).toBeNull();
  });
});

describe("getVideoSenderForPeer — exact sender lookup", () => {
  it("returns video sender from PC", () => {
    const videoSender = { track: { kind: "video" } } as RTCRtpSender;
    const pc = createMockPeerConnection({
      getSenders: () => [videoSender],
    });

    const result = getVideoSenderForPeer(pc, "peer-uuid");
    expect(result).toBe(videoSender);
  });

  it("returns null when no video sender exists", () => {
    const pc = createMockPeerConnection();

    const result = getVideoSenderForPeer(pc, "peer-uuid");
    expect(result).toBeNull();
  });

  it("returns null when only audio sender exists", () => {
    const audioSender = { track: { kind: "audio" } } as RTCRtpSender;
    const pc = createMockPeerConnection({
      getSenders: () => [audioSender],
    });

    const result = getVideoSenderForPeer(pc, "peer-uuid");
    expect(result).toBeNull();
  });

  it("ignores senders with null track", () => {
    const nullTrackSender = { track: null } as unknown as RTCRtpSender;
    const videoSender = { track: { kind: "video" } } as RTCRtpSender;
    const pc = createMockPeerConnection({
      getSenders: () => [nullTrackSender, videoSender],
    });

    const result = getVideoSenderForPeer(pc, "peer-uuid");
    expect(result).toBe(videoSender);
  });

  it("keeps mediaPeerUuid in API signature for future per-peer selection", () => {
    const pc = createMockPeerConnection();
    const result = getVideoSenderForPeer(pc, "any-peer-uuid");
    // Should not throw — API accepts the parameter and returns null for empty senders
    expect(result).toBeNull();
  });
});

describe("getPublisherConnection and getViewerConnection", () => {
  it("getPublisherConnection returns publisher PC", () => {
    const pc = createMockPeerConnection();
    const connections = new Map<string, PeerGroup>();
    connections.set("peer-uuid", createMockPeerGroup({ publisher: { pc } }));
    const sdk = createMockSDK(connections);

    const result = getPublisherConnection(sdk, "peer-uuid");
    expect(result).toBe(pc);
  });

  it("getViewerConnection returns viewer PC", () => {
    const pc = createMockPeerConnection();
    const connections = new Map<string, PeerGroup>();
    connections.set("peer-uuid", createMockPeerGroup({ viewer: { pc } }));
    const sdk = createMockSDK(connections);

    const result = getViewerConnection(sdk, "peer-uuid");
    expect(result).toBe(pc);
  });

  it("getPublisherConnection throws when no publisher PC exists", () => {
    const connections = new Map<string, PeerGroup>();
    connections.set("peer-uuid", createMockPeerGroup());
    const sdk = createMockSDK(connections);

    expect(() => getPublisherConnection(sdk, "peer-uuid")).toThrow();
  });

  it("getViewerConnection throws when no viewer PC exists", () => {
    const connections = new Map<string, PeerGroup>();
    connections.set("peer-uuid", createMockPeerGroup());
    const sdk = createMockSDK(connections);

    expect(() => getViewerConnection(sdk, "peer-uuid")).toThrow();
  });
});

describe("getVideoSender and getAudioSender", () => {
  it("getVideoSender finds video sender", () => {
    const videoSender = { track: { kind: "video" } } as RTCRtpSender;
    const pc = createMockPeerConnection({
      getSenders: () => [videoSender],
    });

    const result = getVideoSender(pc);
    expect(result).toBe(videoSender);
  });

  it("getAudioSender finds audio sender", () => {
    const audioSender = { track: { kind: "audio" } } as RTCRtpSender;
    const pc = createMockPeerConnection({
      getSenders: () => [audioSender],
    });

    const result = getAudioSender(pc);
    expect(result).toBe(audioSender);
  });

  it("getVideoSender returns undefined for no video", () => {
    const audioSender = { track: { kind: "audio" } } as RTCRtpSender;
    const pc = createMockPeerConnection({
      getSenders: () => [audioSender],
    });

    const result = getVideoSender(pc);
    expect(result).toBeUndefined();
  });
});
