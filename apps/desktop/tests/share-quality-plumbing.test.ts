// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/renderer/stores/main-store.js";
import { StreamSessionManager } from "../src/renderer/services/stream-session-manager.js";
import { PublisherManager } from "../src/renderer/services/publisher-manager.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";
import {
  BUILT_IN_PRESETS,
  builtInPresetToOverride,
  customPresetToOverride,
  presetSettingsToOverride,
  validateSessionQualityOverride,
} from "../src/renderer/services/share-quality.js";

const mockGetRuntime = vi.fn();
vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: mockGetRuntime,
}));

function makeMockRuntime(): Phase3Runtime {
  const registry = {
    registerLocalStream: vi.fn(),
    handleStopped: vi.fn(),
    getStream: vi.fn().mockReturnValue(null),
    getAllStreams: vi.fn().mockReturnValue([]),
    getStreamsByGroup: vi.fn().mockReturnValue([]),
  };
  const connManager = {
    broadcast: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue(null),
  };
  const viewerBinding = {
    removeViewer: vi.fn(),
    rejectPending: vi.fn(),
    getAllViewers: vi.fn().mockReturnValue([] as Array<{ viewerDeviceId: string; mediaPeerUuid: string }>),
  };
  const syncService = {
    getSyncState: vi.fn().mockReturnValue(null),
    performLocalEdit: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ({}),
    getViewerMediaBinding: () => viewerBinding,
    getSyncService: () => syncService,
    getMediaStatsService: () => ({
      startViewerPoller: vi.fn(),
      stopViewerPoller: vi.fn(),
      disconnectViewer: vi.fn(),
      hasViewerPoller: vi.fn().mockReturnValue(false),
    }),
  } as unknown as Phase3Runtime;
}

function mockGetDisplayMediaResolve(): void {
  const fakeTrack = {
    kind: "video",
    label: "Screen",
    id: crypto.randomUUID(),
    enabled: true,
    stop: vi.fn(),
    getCapabilities: vi.fn().mockReturnValue({
      width: { min: 1, max: 4096 },
      height: { min: 1, max: 4096 },
      frameRate: { min: 1, max: 60 },
    }),
    getSettings: vi.fn().mockReturnValue({
      width: 1920,
      height: 1080,
      frameRate: 30,
    }),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  } as unknown as MediaStreamTrack;
  const fakeStream = {
    getVideoTracks: () => [fakeTrack],
    getAudioTracks: () => [],
    getTracks: () => [fakeTrack],
  } as unknown as MediaStream;
  const nav = (globalThis as any).navigator;
  if (nav) {
    nav.mediaDevices = nav.mediaDevices || {};
    nav.mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue(fakeStream);
  } else {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(fakeStream) } },
      writable: true,
      configurable: true,
    });
  }
}

function mockAudioApi() {
  const savedWindow = (globalThis as any).window;
  const api = {
    ensureAudioHelper: vi.fn().mockResolvedValue({ success: true }),
    startFilteredMonitorAudio: vi.fn().mockResolvedValue({ success: true, streamGeneration: 42 }),
    startApplicationAudio: vi.fn().mockResolvedValue({ success: true, streamGeneration: 7 }),
    requestAudioPort: vi.fn().mockResolvedValue({ success: true }),
    stopAudio: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(globalThis, "window", {
    value: {
      screenlink: api,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
  (window.addEventListener as any).mockImplementation((type: string, handler: any) => {
    if (type === "message") {
      setTimeout(() => handler({ data: { type: "pcm:port" }, ports: [{ postMessage: vi.fn() }] } as unknown as MessageEvent), 0);
    }
  });
  return { api, restore: () => {
    if (savedWindow !== undefined) {
      Object.defineProperty(globalThis, "window", {
        value: savedWindow,
        writable: true,
        configurable: true,
      });
    } else {
      delete (globalThis as any).window;
    }
  } };
}

// ─── Built-in preset definitions ─────────────────────────────────────────

describe("Built-in preset definitions", () => {
  it("Data Saver is 640×360, 10 FPS, 400 kbps", () => {
    expect(builtInPresetToOverride("data-saver")).toEqual({
      videoBitrateKbps: 400,
      sendWidth: 640,
      sendHeight: 360,
      sendFps: 10,
      captureWidth: 640,
      captureHeight: 360,
      captureFps: 10,
    });
  });

  it("Balanced is 854×480, 15 FPS, 650 kbps", () => {
    expect(builtInPresetToOverride("balanced")).toEqual({
      videoBitrateKbps: 650,
      sendWidth: 854,
      sendHeight: 480,
      sendFps: 15,
      captureWidth: 854,
      captureHeight: 480,
      captureFps: 15,
    });
  });

  it("Clear is 1280×720, 24 FPS, 1500 kbps", () => {
    expect(builtInPresetToOverride("clear")).toEqual({
      videoBitrateKbps: 1500,
      sendWidth: 1280,
      sendHeight: 720,
      sendFps: 24,
      captureWidth: 1280,
      captureHeight: 720,
      captureFps: 24,
    });
  });

  it("Built-in slots omit codec/contentHint/degradationPreference", () => {
    for (const p of BUILT_IN_PRESETS) {
      const ov = builtInPresetToOverride(p.kind);
      expect(ov.codec).toBeUndefined();
      expect(ov.contentHint).toBeUndefined();
      expect(ov.degradationPreference).toBeUndefined();
    }
  });

  it("Custom uses the provided slider values verbatim", () => {
    expect(
      customPresetToOverride({ width: 1920, height: 1080, fps: 30, bitrate: 4000 }),
    ).toEqual({
      videoBitrateKbps: 4000,
      sendWidth: 1920,
      sendHeight: 1080,
      sendFps: 30,
      captureWidth: 1920,
      captureHeight: 1080,
      captureFps: 30,
    });
  });

  it("Personal preset video settings map into the override", () => {
    const ov = presetSettingsToOverride({
      video: {
        videoBitrateKbps: 2000,
        sendWidth: 1920,
        sendHeight: 1080,
        sendFps: 60,
        captureWidth: 1920,
        captureHeight: 1080,
        captureFps: 60,
        codec: "h264",
        contentHint: "motion",
        degradationPreference: "maintain-framerate",
      },
    });
    expect(ov.videoBitrateKbps).toBe(2000);
    expect(ov.sendWidth).toBe(1920);
    expect(ov.sendFps).toBe(60);
    expect(ov.codec).toBe("h264");
    expect(ov.contentHint).toBe("motion");
    expect(ov.degradationPreference).toBe("maintain-framerate");
  });

  it("validateSessionQualityOverride accepts valid values", () => {
    const ok = builtInPresetToOverride("balanced");
    expect(validateSessionQualityOverride(ok)).toBeNull();
  });

  it("validateSessionQualityOverride rejects out-of-range values", () => {
    const bad = { ...builtInPresetToOverride("balanced"), sendWidth: 10 };
    expect(validateSessionQualityOverride(bad)).toMatch(/Send width/);
  });
});

// ─── StreamSessionManager quality override plumbing ─────────────────────

describe("StreamSessionManager quality override plumbing", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
    vi.restoreAllMocks();
  });

  it("session override wins over group defaults", async () => {
    const syncService = runtime.getSyncService() as unknown as { getSyncState: ReturnType<typeof vi.fn> };
    syncService.getSyncState.mockReturnValue({
      state: {
        defaultQuality: {
          value: {
            video: {
              videoBitrateKbps: 9999,
              sendWidth: 9999,
              sendHeight: 9999,
              sendFps: 99,
              captureWidth: 9999,
              captureHeight: 9999,
              captureFps: 99,
            },
          },
        },
      },
    });

    mockGetDisplayMediaResolve();
    const startSpy = vi.spyOn(PublisherManager.prototype, "startPublishing").mockResolvedValue(undefined);
    try {
      await ssm.startStream({
        groupId: "g-1",
        source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
        qualityOverride: builtInPresetToOverride("data-saver"),
      });
      expect(ssm.state).toBe("active");
      const cfg = startSpy.mock.calls[0][1];
      expect(cfg).toMatchObject({
        videoBitrate: 400,
        videoWidth: 640,
        videoHeight: 360,
        videoFps: 10,
        captureWidth: 640,
        captureHeight: 360,
        captureFps: 10,
      });
    } finally {
      startSpy.mockRestore();
    }
  });

  it("missing override falls back to group default", async () => {
    const syncService = runtime.getSyncService() as unknown as { getSyncState: ReturnType<typeof vi.fn> };
    syncService.getSyncState.mockReturnValue({
      state: {
        defaultQuality: {
          value: {
            video: {
              videoBitrateKbps: 1234,
              sendWidth: 1600,
              sendHeight: 900,
              sendFps: 30,
              captureWidth: 1600,
              captureHeight: 900,
              captureFps: 30,
            },
          },
        },
      },
    });
    mockGetDisplayMediaResolve();
    const startSpy = vi.spyOn(PublisherManager.prototype, "startPublishing").mockResolvedValue(undefined);
    try {
      await ssm.startStream({
        groupId: "g-1",
        source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
      });
      const cfg = startSpy.mock.calls[0][1];
      expect(cfg).toMatchObject({
        videoBitrate: 1234,
        videoWidth: 1600,
        videoHeight: 900,
        videoFps: 30,
      });
    } finally {
      startSpy.mockRestore();
    }
  });

  it("invalid override throws", async () => {
    await expect(
      ssm.startStream({
        groupId: "g-1",
        source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
        qualityOverride: { ...builtInPresetToOverride("balanced"), sendWidth: 10 },
      }),
    ).rejects.toThrow(/Send width/);
  });

  it("restart preserves the active session override", async () => {
    mockGetDisplayMediaResolve();
    const startSpy = vi.spyOn(PublisherManager.prototype, "startPublishing").mockResolvedValue(undefined);
    try {
      await ssm.startStream({
        groupId: "g-1",
        source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
        qualityOverride: builtInPresetToOverride("clear"),
      });
      startSpy.mockClear();
      await ssm.restartStream();
      const cfg = startSpy.mock.calls[0][1];
      expect(cfg).toMatchObject({
        videoBitrate: 1500,
        videoWidth: 1280,
        videoHeight: 720,
        videoFps: 24,
      });
    } finally {
      startSpy.mockRestore();
    }
  });

  it("stopStream clears the active override", async () => {
    const { api, restore } = mockAudioApi();
    try {
      mockGetDisplayMediaResolve();
      const startSpy = vi.spyOn(PublisherManager.prototype, "startPublishing").mockResolvedValue(undefined);
      try {
        await ssm.startStream({
          groupId: "g-1",
          source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
          qualityOverride: builtInPresetToOverride("data-saver"),
        });
        await ssm.stopStream();
        // After stop, a fresh start with no override should use the
        // group default (or fallback), NOT the previous override.
        const syncService = runtime.getSyncService() as unknown as { getSyncState: ReturnType<typeof vi.fn> };
        syncService.getSyncState.mockReturnValue({
          state: {
            defaultQuality: {
              value: {
                video: {
                  videoBitrateKbps: 7777,
                  sendWidth: 1280,
                  sendHeight: 720,
                  sendFps: 30,
                  captureWidth: 1280,
                  captureHeight: 720,
                  captureFps: 30,
                },
              },
            },
          },
        });
        startSpy.mockClear();
        await ssm.startStream({
          groupId: "g-1",
          source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
        });
        const cfg = startSpy.mock.calls[0][1];
        expect(cfg.videoBitrate).toBe(7777);
      } finally {
        startSpy.mockRestore();
      }
    } finally {
      restore();
    }
    void api;
  });
});

// ─── Share coordinator uses the same plumbing for both flows ─────────────

describe("Share coordinator accepts explicit groupId + qualityOverride", () => {
  beforeEach(() => {
    useStore.getState().reset();
    vi.clearAllMocks();
  });

  it("passes explicit groupId, source, and qualityOverride to startStream", async () => {
    const startStream = vi.fn().mockResolvedValue(undefined);
    mockGetRuntime.mockReturnValue({
      getStreamSessionManager: () => ({
        startStream,
        getActualCaptureDimensions: () => ({ width: 0, height: 0, fps: 0 }),
        isAudioDegraded: false,
      }),
    });
    const { startShare } = await import("../src/renderer/services/share-coordinator.js");
    const override = builtInPresetToOverride("balanced");
    await startShare({
      groupId: "explicit-group",
      source: {
        id: "src-1",
        name: "Source 1",
        kind: "screen",
        displayId: null,
        fingerprint: null,
      },
      qualityOverride: override,
    });

    expect(startStream).toHaveBeenCalledWith({
      groupId: "explicit-group",
      source: {
        id: "src-1",
        name: "Source 1",
        kind: "screen",
        displayId: null,
        fingerprint: null,
      },
      qualityOverride: override,
    });
  });

  it("rejects when groupId is missing", async () => {
    const { startShare } = await import("../src/renderer/services/share-coordinator.js");
    await expect(
      startShare({
        groupId: "",
        source: { id: "src-1", name: "Source 1", kind: "screen", displayId: null, fingerprint: null },
      }),
    ).rejects.toThrow(/group id/i);
  });
});
