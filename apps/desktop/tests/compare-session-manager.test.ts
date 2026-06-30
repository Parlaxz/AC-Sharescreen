// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CompareSessionManager } from "../src/renderer/services/compare-session-manager.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";

// ─── Mock runtime ───────────────────────────────────────────────────────────

function makeMockRuntime(overrides: Record<string, unknown> = {}): Phase3Runtime {
  const registry = {
    registerLocalStream: vi.fn(),
    handleStopped: vi.fn(),
    getStream: vi.fn().mockReturnValue(null),
    getAllStreams: vi.fn().mockReturnValue([]),
    getStreamsByGroup: vi.fn().mockReturnValue([]),
  };
  const connManager = {
    broadcast: vi.fn().mockResolvedValue(undefined),
    sendOrQueueStreamLifecycle: vi.fn().mockResolvedValue("sent" as const),
    getConnection: vi.fn().mockReturnValue(null),
    isConnected: vi.fn().mockReturnValue(false),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    clearPendingForStream: vi.fn(),
  };
  const viewerBinding = {
    removeViewer: vi.fn(),
    removeViewerMapping: vi.fn(),
    removeMappingsForMediaSessions: vi.fn().mockReturnValue(0),
    getAllViewers: vi.fn().mockReturnValue([] as Array<{ viewerDeviceId: string; mediaPeerUuid: string; mediaSessionId: string }>),
    getViewersForMediaSession: vi.fn().mockReturnValue([]),
  };
  const syncService = {
    getSyncState: vi.fn().mockReturnValue(null),
    performLocalEdit: vi.fn().mockResolvedValue(undefined),
  };
  const ssm = {
    state: "idle",
    startStream: vi.fn(),
    stopStream: vi.fn(),
    destroy: vi.fn(),
    getPublisherManager: vi.fn().mockReturnValue(null),
    getCurrentVdoConfig: vi.fn().mockReturnValue(null),
    currentMediaSessionId: null,
    currentLogicalStreamId: null,
    setDeviceIdentity: vi.fn(),
    hostDeviceId: "local",
  };
  const mediaStats = {
    startViewerPoller: vi.fn(),
    stopViewerPoller: vi.fn(),
    disconnectViewer: vi.fn(),
    hasViewerPoller: vi.fn().mockReturnValue(false),
  };

  return {
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ssm,
    getViewerMediaBinding: () => viewerBinding,
    getSyncService: () => syncService,
    getMediaStatsService: () => mediaStats,
    getCompareSessionManager: () => null,
    resolveLocalPublication: vi.fn().mockReturnValue(null),
    deviceId: "test-device",
    displayName: "Test Host",
    ...overrides,
  } as unknown as Phase3Runtime;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockNavigatorMediaDevices(): void {
  const mockTrack = {
    kind: "video",
    id: "source-track",
    enabled: true,
    readyState: "live",
    label: "Screen Capture",
    stop: vi.fn(),
    addEventListener: vi.fn((_event: string, _cb: () => void) => {}),
    removeEventListener: vi.fn(),
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
    getCapabilities: () => ({
      width: { min: 320, max: 3840 },
      height: { min: 240, max: 2160 },
      frameRate: { min: 1, max: 60 },
    }),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  } as unknown as MediaStreamTrack;

  const mockStream = {
    getVideoTracks: vi.fn(() => [mockTrack]),
    getAudioTracks: vi.fn(() => []),
    getTracks: vi.fn(() => [mockTrack]),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    id: "capture-stream",
    active: true,
  } as unknown as MediaStream;

  const orig = (globalThis as any).navigator;
  if (orig?.mediaDevices) return;

  const mockMediaDevices = {
    getDisplayMedia: vi.fn().mockResolvedValue(mockStream),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  };

  if (orig) {
    (orig as any).mediaDevices = mockMediaDevices;
  } else {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: mockMediaDevices },
      writable: true,
      configurable: true,
    });
  }
}

function mockCanvasAndVideo(): void {
  if (typeof document === "undefined") {
    (globalThis as any).document = {
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
      createElement: vi.fn((tag: string) => {
        if (tag === "video") {
          return {
            muted: false,
            playsInline: false,
            autoplay: false,
            style: { display: "" },
            srcObject: null,
            videoWidth: 1920,
            videoHeight: 1080,
            play: vi.fn().mockResolvedValue(undefined),
            pause: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            parentNode: document.body,
            remove: vi.fn(),
          } as unknown as HTMLVideoElement;
        }
        if (tag === "canvas") {
          return {
            width: 1920,
            height: 1080,
            style: { display: "" },
            getContext: vi.fn(() => ({
              drawImage: vi.fn(),
              clearRect: vi.fn(),
            })),
            captureStream: vi.fn((_fps: number) => ({
              getVideoTracks: vi.fn(() => ([{
                kind: "video",
                id: "canvas-track",
                enabled: true,
                readyState: "live",
                stop: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
              }])),
              getTracks: vi.fn(() => ([{
                kind: "video",
                id: "canvas-track",
                enabled: true,
                readyState: "live",
                stop: vi.fn(),
              }])),
              getAudioTracks: vi.fn(() => []),
            })),
            parentNode: document.body,
            remove: vi.fn(),
          } as unknown as HTMLCanvasElement;
        }
        return {};
      }),
    } as unknown as Document;
  }

  (globalThis as any).requestAnimationFrame = vi.fn((cb: () => void) => {
    return setTimeout(cb, 16);
  });
  (globalThis as any).cancelAnimationFrame = vi.fn((id: number) => {
    clearTimeout(id);
  });
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe("CompareSessionManager", () => {
  let csm: CompareSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    vi.useFakeTimers();
    mockNavigatorMediaDevices();
    mockCanvasAndVideo();
    runtime = makeMockRuntime();
    csm = new CompareSessionManager(runtime);
  });

  afterEach(() => {
    csm.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as any).document;
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
  });

  // ── State machine ─────────────────────────────────────────────────

  describe("state machine", () => {
    it("starts in idle state", () => {
      expect(csm.state).toBe("idle");
    });

    it("isActive returns false when idle", () => {
      expect(csm.isActive()).toBe(false);
    });
  });

  // ── Start/stop ────────────────────────────────────────────────────

  describe("start compare", () => {
    const validInput = {
      groupId: "test-group-1",
      source: {
        id: "source-1",
        name: "Screen",
        kind: "screen" as const,
        displayId: null,
        fingerprint: null,
      },
      variantConfigs: {
        A: { targetWidth: 854, targetHeight: 480, targetFps: 30, videoBitrateKbps: 650 },
        B: { targetWidth: 640, targetHeight: 360, targetFps: 15, videoBitrateKbps: 400 },
      },
    };

    it("rejects start when already active (mutual exclusion with normal)", async () => {
      // Set SSM to active
      (runtime.getStreamSessionManager() as any).state = "active";
      await expect(csm.startCompare(validInput)).rejects.toThrow(/normal stream/i);
    });

    it("rejects start when in starting state", async () => {
      // This is more internal — startCompare should fail if already starting
      // We trigger first start which will fail due to no mock pipeline
      // then check state
      (csm as any)._state = "starting";
      await expect(csm.startCompare(validInput)).rejects.toThrow();
    });

    it("rejects start when destroyed", async () => {
      csm.destroy();
      await expect(csm.startCompare(validInput)).rejects.toThrow(/destroyed/i);
    });

    it("fails to start when getDisplayMedia fails", async () => {
      const md = (globalThis as any).navigator?.mediaDevices;
      if (md) {
        md.getDisplayMedia = vi.fn().mockRejectedValue(new Error("capture failed"));
      }
      await expect(csm.startCompare(validInput)).rejects.toThrow();
      expect(csm.state).toBe("failed");
    });
  });

  describe("stop compare", () => {
    it("is idempotent when already idle", async () => {
      await expect(csm.stopCompare()).resolves.toBeUndefined();
      expect(csm.state).toBe("idle");
    });

    it("is idempotent when already destroyed", async () => {
      csm.destroy();
      await expect(csm.stopCompare()).resolves.toBeUndefined();
    });
  });

  // ── Resolve variant ───────────────────────────────────────────────

  describe("resolveVariant", () => {
    it("returns null when not active", () => {
      expect(csm.resolveVariant("some-ms-id")).toBeNull();
    });

    it("returns null for unknown media session ID when active", () => {
      // Manually poke some state
      (csm as any)._state = "active";
      (csm as any)._variantMediaSessionIds = { A: "ms-a", B: "ms-b" };
      expect(csm.resolveVariant("unknown-ms")).toBeNull();
    });
  });

  // ── Destroy ───────────────────────────────────────────────────────

  describe("destroy", () => {
    it("transitions to destroyed terminal state", () => {
      csm.destroy();
      expect(csm.state).toBe("destroyed");
    });

    it("is idempotent", () => {
      csm.destroy();
      csm.destroy();
      expect(csm.state).toBe("destroyed");
    });
  });
});
