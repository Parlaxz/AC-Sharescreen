// @vitest-environment node
/**
 * Regression tests for the StreamSwitcher re-bind flow (VWUI-006).
 *
 * Reproduces the e2e switch sequence at unit level with the REAL
 * ViewerSessionController and REAL ViewerSession — only ViewerClient,
 * Phase3Runtime, StreamMetricsService, and the zustand store are mocked:
 *
 *   1. start(host A) → track arrives → watching
 *   2. start(host B) while A is active (the switch path)
 *   3. expect: old session torn down, fresh join toward B, watching on B,
 *      and the shared <video> element rebound to B's stream.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mockStreamMetricsInstance = vi.hoisted(() => ({
  startViewerSession: vi.fn().mockReturnValue("metrics-id"),
  finalizeSession: vi.fn().mockResolvedValue(undefined),
  getSnapshot: vi.fn().mockReturnValue({
    historyId: "metrics-id",
    role: "viewer",
    aggregate: {
      rawSamples: Object.freeze([]),
      mediumBuckets: Object.freeze([]),
      longBuckets: Object.freeze([]),
      markers: Object.freeze([]),
      currentBitsPerSecond: 0,
      averageBitsPerSecond: 0,
      peakBitsPerSecond: 0,
      totalBytes: 0,
      durationMs: 0,
      activeDurationMs: 0,
      configuredBitsPerSecond: null,
      effectiveBitsPerSecond: null,
      state: "playing",
      currentVideoBitsPerSecond: null,
      currentAudioBitsPerSecond: null,
      currentTransportBitsPerSecond: null,
      cumulativeInboundVideoBytes: 0,
    },
    connections: Object.freeze([]),
  }),
}));

const hoisted = vi.hoisted(() => {
  /** Per-host connection config, armed by each test. */
  const hosts: Record<
    string,
    { peerUuid: string; vdoStreamId: string; vdoPassword: string }
  > = {};
  /** Captured ViewerClient instances (one per join attempt). */
  const clients: Array<{
    handlers: Map<string, Set<(...args: unknown[]) => void>>;
    connectPassword: string | null;
    viewedStreamId: string | null;
    bound: boolean;
  }> = [];
  /** Sent control payloads: [{ peerUuid, payload }] */
  const sent: Array<{ peerUuid: string; payload: Record<string, unknown> }> = [];
  /** Pending join-response resolvers keyed by requestId. */
  const joinWaiters = new Map<string, (value: unknown) => void>();
  return { hosts, clients, sent, joinWaiters };
});

vi.mock("../src/renderer/services/stream-metrics-service.js", () => ({
  StreamMetricsService: { getInstance: () => mockStreamMetricsInstance },
}));

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: () => mockRuntime(),
}));

vi.mock("@screenlink/vdo-adapter", () => ({
  ViewerClient: class {
    handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    connectPassword: string | null = null;
    viewedStreamId: string | null = null;
    bound = false;
    on(event: string, handler: (...args: unknown[]) => void): void {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    }
    off(event: string, handler: (...args: unknown[]) => void): void {
      this.handlers.get(event)?.delete(handler);
    }
    async createAndConnect(password: string): Promise<void> {
      this.connectPassword = password;
      hoisted.clients.push(this as never);
    }
    async view(streamId: string): Promise<void> {
      this.viewedStreamId = streamId;
    }
    async sendMediaBind(): Promise<void> {
      this.bound = true;
    }
    getSDK() {
      // Feature-detectable PC stub for the transport death watch.
      const pc = {
        connectionState: "connected",
        iceConnectionState: "connected",
        addEventListener: (_t: string, _h: (...a: unknown[]) => void) => {},
        removeEventListener: (_t: string, _h: (...a: unknown[]) => void) => {},
        getReceivers: () => [],
      };
      return {
        connections: new Map([["publisher-uuid", { viewer: { pc }, publisher: null }]]),
      };
    }
    async shutdown(): Promise<void> {}
  },
}));

vi.mock("../src/renderer/stores/main-store.js", () => ({
  useStore: { subscribe: vi.fn().mockReturnValue(vi.fn()), getState: vi.fn() },
}));

// ─── Runtime mock ─────────────────────────────────────────────────────────────

function makeRuntime() {
  return {
    deviceId: "viewer-device",
    displayName: "Charlie",
    isDestroyed: () => false,
    requestGroupSync: () => undefined,
    getConnectionManager: () => ({
      getConnection: (groupId: string) =>
        groupId === "g-1"
          ? {
              peerForDevice: (deviceId: string) =>
                hoisted.hosts[deviceId]?.peerUuid ?? null,
              sendToPeer: async (
                peerUuid: string,
                payload: Record<string, unknown>,
              ) => {
                hoisted.sent.push({ peerUuid, payload });
                if (payload.type === "stream.join.request") {
                  const host = Object.entries(hoisted.hosts).find(
                    ([, h]) => h.peerUuid === peerUuid,
                  )?.[0];
                  const resolve = hoisted.joinWaiters.get(payload.requestId as string);
                  if (resolve && host) {
                    const h = hoisted.hosts[host];
                    resolve({
                      accepted: true,
                      mediaJoinMetadata: `token-${host}`,
                      mediaSessionId: (payload as { mediaSessionId?: string }).mediaSessionId,
                      streamId: h.vdoStreamId,
                      password: h.vdoPassword,
                    });
                  }
                }
              },
            }
          : null,
    }),
    getStreamSessionManager: () => ({ getCaptureStream: () => null }),
    waitForJoinResponse: (requestId: string, _timeout: number) =>
      new Promise((resolve) => {
        hoisted.joinWaiters.set(requestId, resolve);
      }),
    cancelJoinResponse: (requestId: string) => {
      hoisted.joinWaiters.delete(requestId);
    },
    waitForViewerPauseResult: () => Promise.resolve({}),
    cancelViewerPauseResult: () => {},
  };
}

let runtimeInstance: ReturnType<typeof makeRuntime>;
function mockRuntime() {
  return runtimeInstance;
}

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { ViewerSessionController } from "../src/renderer/services/viewer-session-controller.js";
import type { StreamTarget } from "@screenlink/shared";

function makeTarget(overrides: Partial<StreamTarget> & Pick<StreamTarget, "logicalStreamId" | "mediaSessionId" | "hostDeviceId" | "hostName">): StreamTarget {
  return {
    groupId: "g-1",
    startedAt: 1000,
    ...overrides,
  };
}

function makeVideoElement(): HTMLVideoElement {
  return {
    srcObject: null,
    paused: true,
    readyState: 0,
    autoplay: false,
    playsInline: false,
    muted: false,
    volume: 1,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLVideoElement;
}

/** Fire a video trackAdded event into the most recent client. */
function deliverVideoTrack(clientIndex: number, trackId: string): void {
  const client = hoisted.clients[clientIndex];
  const handler = client.handlers.get("trackAdded");
  expect(handler).toBeDefined();
  const track = { kind: "video", id: trackId, enabled: true, readyState: "live" };
  const stream = {
    id: `stream-${trackId}`,
    getTracks: () => [track],
    addTrack: () => {},
  };
  for (const h of handler!) {
    h({ detail: { track, streams: [stream], uuid: "publisher-uuid" } });
  }
}

describe("ViewerSessionController — stream switch re-bind (VWUI-006)", () => {
  let controller: ViewerSessionController;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.hosts.alice = { peerUuid: "peer-alice", vdoStreamId: "vdo-stream-a", vdoPassword: "pw-alice" };
    hoisted.hosts.bob = { peerUuid: "peer-bob", vdoStreamId: "vdo-stream-b", vdoPassword: "pw-bob" };
    hoisted.clients.length = 0;
    hoisted.sent.length = 0;
    hoisted.joinWaiters.clear();
    runtimeInstance = makeRuntime();
    controller = new ViewerSessionController();
  });

  afterEach(async () => {
    await controller.destroy().catch(() => {});
  });

  it("switching from a watching host A to host B rebinds playback to B", async () => {
    const targetA = makeTarget({
      logicalStreamId: "ls-alice",
      mediaSessionId: "ms-alice",
      hostDeviceId: "alice",
      hostName: "Alice",
    });
    const targetB = makeTarget({
      logicalStreamId: "ls-bob",
      mediaSessionId: "ms-bob",
      hostDeviceId: "bob",
      hostName: "Bob",
    });
    const video = makeVideoElement();

    // Regression guard (VWUI-006): the old session's terminal state change
    // must NOT be published during a switch. A spurious phase="ended" makes
    // the workspace unmount the persistent <video> element, and the remount
    // orphans the re-bind's stream attachment (black video forever).
    const observedPhases: string[] = [];
    controller.subscribe((snap) => {
      const last = observedPhases[observedPhases.length - 1];
      if (snap.phase !== last) observedPhases.push(snap.phase);
    });

    // 1) Initial watch of Alice → live
    await controller.start(targetA, video);
    expect(controller.snapshot.phase).toBe("connecting");
    deliverVideoTrack(0, "vt-alice");
    expect(controller.session!.state).toBe("watching");
    expect(controller.snapshot.phase).toBe("watching");

    // 2) Switch to Bob while Alice is active
    await controller.start(targetB, video);

    // The stale "ended" from Alice's teardown must never surface.
    expect(observedPhases).not.toContain("ended");

    // 3) Fresh join flow toward Bob must have run
    const joinRequests = hoisted.sent.filter((s) => s.payload.type === "stream.join.request");
    expect(joinRequests.length).toBe(2);
    const bobJoin = joinRequests[1];
    expect(bobJoin.peerUuid).toBe("peer-bob");
    expect(bobJoin.payload.logicalStreamId).toBe("ls-bob");
    expect(bobJoin.payload.mediaSessionId).toBe("ms-bob");

    expect(hoisted.clients.length).toBe(2);
    expect(hoisted.clients[1].connectPassword).toBe("pw-bob");
    expect(hoisted.clients[1].viewedStreamId).toBe("vdo-stream-b");
    expect(hoisted.clients[1].bound).toBe(true);

    // 4) Track from Bob arrives → watching on B, video rebound
    deliverVideoTrack(1, "vt-bob");
    expect(controller.session!.state).toBe("watching");
    expect(controller.snapshot.phase).toBe("watching");
    expect(controller.target?.mediaSessionId).toBe("ms-bob");
    // The ACTIVE session must still own the ORIGINAL mounted element —
    // attaching to a detached node is what produced the black screen.
    expect((controller.session as unknown as { videoElement: unknown }).videoElement).toBe(video);
    expect((video as unknown as { srcObject: unknown }).srcObject).not.toBeNull();
  });
});
