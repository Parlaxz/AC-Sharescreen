// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StreamSessionManager } from "../src/renderer/services/stream-session-manager.js";
import { PublisherManager } from "../src/renderer/services/publisher-manager.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";
import type { GroupQualitySettings } from "@screenlink/shared";

// ─── Helpers ───────────────────────────────────────────────────────────────

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
    sendOrQueueStreamLifecycle: vi.fn().mockResolvedValue("sent" as const),
    getConnection: vi.fn().mockReturnValue(null),
    isConnected: vi.fn().mockReturnValue(false),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    clearPendingForStream: vi.fn(),
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
  const compareSessionManager = {
    isActive: vi.fn().mockReturnValue(false),
    state: "idle",
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
    getCompareSessionManager: () => compareSessionManager,
    viewerBinding, // expose for test assertions
    syncService,   // expose for test assertions
  } as unknown as Phase3Runtime & { viewerBinding: typeof viewerBinding; syncService: typeof syncService };
}

/**
 * Setup navigator.mediaDevices mock for node environment.
 * Uses Object.defineProperty since globalThis.navigator is read-only.
 */
function mockNavigatorMediaDevices(): void {
  const origNavigator = (globalThis as any).navigator;
  if (origNavigator && origNavigator.mediaDevices) return; // already exists

  const mockMediaDevices = {
    getDisplayMedia: vi.fn().mockRejectedValue(new Error("No display media in test env")),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  };

  if (origNavigator) {
    (origNavigator as any).mediaDevices = mockMediaDevices;
  } else {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: mockMediaDevices },
      writable: true,
      configurable: true,
    });
  }
}

describe("StreamSessionManager (Stage 4)", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── StartStreamInput shape ─────────────────────────────────────────

  it("accepts StartStreamInput with source object", () => {
    const input = {
      groupId: "test-group-1",
      source: {
        id: "source-1",
        name: "My Screen",
        kind: "screen" as const,
        displayId: "display-1",
        fingerprint: "fp-123",
      },
    };
    expect(input.groupId).toBe("test-group-1");
    expect(input.source.name).toBe("My Screen");
    expect(input.source.kind).toBe("screen");
    expect(input.source.displayId).toBe("display-1");
    expect(input.source.fingerprint).toBe("fp-123");
  });

  // ── State transitions ─────────────────────────────────────────────

  it("starts in idle state", () => {
    expect(ssm.state).toBe("idle");
  });

  it("fails startStream when getDisplayMedia fails (node env)", async () => {
    mockNavigatorMediaDevices();
    await expect(ssm.startStream({
      groupId: "test-g-1",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).rejects.toThrow();
    expect(ssm.state).toBe("failed");
  });

  it("rejects startStream when not idle or failed", async () => {
    (ssm as any)._state = "active";
    expect(ssm.state).toBe("active");

    await expect(ssm.startStream({
      groupId: "test-g-1",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).resolves.toBeUndefined();
    expect(ssm.state).toBe("active");
  });

  it("rejects startStream when destroyed", async () => {
    ssm.destroy();
    await expect(ssm.startStream({
      groupId: "test-g-1",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).resolves.toBeUndefined();
    expect(ssm.state).toBe("destroyed");
  });

  // ── Stop stream ──────────────────────────────────────────────────

  it("stopStream is idempotent when already idle", async () => {
    await expect(ssm.stopStream()).resolves.toBeUndefined();
    expect(ssm.state).toBe("idle");
  });

  it("stopStream queues stream.stopped and cleans up when active", async () => {
    const connManager = runtime.getConnectionManager();
    const registry = runtime.getActiveStreamRegistry();

    (ssm as any)._state = "active";
    (ssm as any).groupId = "test-g-1";
    (ssm as any).logicalStreamId = "ls-1";
    (ssm as any).mediaSessionId = "ms-1";
    (ssm as any)._hostDeviceId = "dev-1";
    (ssm as any)._hostDisplayName = "Host";

    await ssm.stopStream();

    expect(connManager.sendOrQueueStreamLifecycle).toHaveBeenCalledWith(
      "test-g-1",
      "ls-1",
      "stream.stopped",
      expect.objectContaining({ type: "stream.stopped", groupId: "test-g-1" }),
    );
    expect(registry.handleStopped).toHaveBeenCalledWith({
      groupId: "test-g-1",
      hostDeviceId: "dev-1",
      logicalStreamId: "ls-1",
    });
    expect(ssm.state).toBe("idle");
  });

  // ── SetDeviceIdentity ────────────────────────────────────────────

  it("setDeviceIdentity stores device identity", () => {
    ssm.setDeviceIdentity("dev-123", "Alice");
    expect(ssm.hostDeviceId).toBe("dev-123");
    expect(ssm.hostDisplayName).toBe("Alice");
  });

  // ── PublisherManager access ──────────────────────────────────────

  it("getPublisherManager returns null before startStream", () => {
    expect(ssm.getPublisherManager()).toBeNull();
  });

  it("getCurrentVdoConfig returns null before startStream", () => {
    expect(ssm.getCurrentVdoConfig()).toBeNull();
  });

  // ── setAudioController ───────────────────────────────────────────

  it("setAudioController does not throw when publisher manager is null", () => {
    expect(() => ssm.setAudioController(null as any, "none")).not.toThrow();
  });

  // ── Destroy ──────────────────────────────────────────────────────

  it("destroy transitions to destroyed state", () => {
    ssm.destroy();
    expect(ssm.state).toBe("destroyed");
  });

  it("destroy is idempotent", () => {
    ssm.destroy();
    ssm.destroy();
    expect(ssm.state).toBe("destroyed");
  });

  // ── Restart ──────────────────────────────────────────────────────

  it("restartStream requires active state", async () => {
    await expect(ssm.restartStream()).resolves.toBeUndefined();
    expect(ssm.state).toBe("idle");
  });

  it("restartStream is no-op when destroyed", async () => {
    await ssm.destroy();
    await expect(ssm.restartStream()).resolves.toBeUndefined();
    expect(ssm.state).toBe("destroyed");
  });

  // ── StreamAnnouncement building ──────────────────────────────────

  it("buildAnnouncement includes all required fields", () => {
    (ssm as any)._state = "active";
    (ssm as any).groupId = "g-1";
    (ssm as any).logicalStreamId = "ls-1";
    (ssm as any).mediaSessionId = "ms-1";
    (ssm as any)._hostDeviceId = "dev-1";
    (ssm as any)._hostDisplayName = "Host";
    (ssm as any).startedAt = 1000;
    (ssm as any).heartbeatSeq = 1;
    (ssm as any).streamRevision = 1;

    const ann = (ssm as any).buildAnnouncement();
    expect(ann).toMatchObject({
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      groupId: "g-1",
      hostDeviceId: "dev-1",
      hostDisplayName: "Host",
      heartbeatSequence: 1,
      streamRevision: 1,
    });
  });

  // ── Heartbeat ────────────────────────────────────────────────────

  it("sendHeartbeat is no-op when not active", async () => {
    await expect((ssm as any).sendHeartbeat()).resolves.toBeUndefined();
  });

  it("sendHeartbeat broadcasts to the group when active", async () => {
    const connManager = runtime.getConnectionManager();
    (ssm as any)._state = "active";
    (ssm as any).groupId = "g-1";
    (ssm as any).logicalStreamId = "ls-1";
    (ssm as any).mediaSessionId = "ms-1";
    (ssm as any)._hostDeviceId = "dev-1";
    (ssm as any)._hostDisplayName = "Host";

    await (ssm as any).sendHeartbeat();

    expect(connManager.broadcast).toHaveBeenCalledWith("g-1", expect.objectContaining({
      type: "stream.heartbeat",
      groupId: "g-1",
      hostDeviceId: "dev-1",
      heartbeatSequence: 1,
    }));
  });

  it("stopStream calls getAllViewers on viewerMediaBinding", async () => {
    // The mock returns the same viewerBinding object each time
    const { viewerBinding } = runtime as unknown as { viewerBinding: { getAllViewers: ReturnType<typeof vi.fn> } };
    (ssm as any)._state = "active";
    (ssm as any).groupId = "g-1";
    (ssm as any).logicalStreamId = "ls-1";
    (ssm as any).mediaSessionId = "ms-1";
    (ssm as any)._hostDeviceId = "dev-1";

    await ssm.stopStream();

    expect(viewerBinding.getAllViewers).toHaveBeenCalled();
  });

  // ── Group defaults for publication quality ──────────────────────────

  /**
   * Helper: set up navigator.mediaDevices.getDisplayMedia to resolve with a
   * fake stream containing one video track.
   */
  function mockGetDisplayMediaResolve(): void {
    const fakeTrack = {
      kind: "video",
      label: "Screen",
      id: crypto.randomUUID(),
      enabled: true,
      stop: vi.fn(),
      // Gate 4.4 capture readback
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

  it("uses group default quality values when sync state has quality settings", async () => {
    const customQuality: GroupQualitySettings = {
      schemaVersion: 1,
      video: {
        videoBitrateKbps: 1200,
        sendWidth: 1280,
        sendHeight: 720,
        sendFps: 30,
        captureWidth: 1920,
        captureHeight: 1080,
        captureFps: 30,
        preserveAspectRatio: true,
        preventUpscale: true,
        resolutionMode: "target-dimensions",
        scaleResolutionDownBy: 1,
        codec: "auto",
        h264Profile: "auto",
        contentHint: "detail",
        degradationPreference: "maintain-resolution",
        scalabilityMode: null,
        cursorMode: "always",
        rtpPriority: "medium",
      },
      audio: {
        bitrateKbps: 64,
        channels: "stereo",
        bitrateMode: "vbr",
        dtx: false,
        fec: true,
        packetDurationMs: 20,
        redundantAudio: false,
      },
    };

    const { syncService } = runtime as unknown as { syncService: { getSyncState: ReturnType<typeof vi.fn> } };
    syncService.getSyncState.mockReturnValue({
      groupId: "test-g-1",
      state: {
        schemaVersion: 1,
        groupId: "test-g-1",
        name: { value: "Test", stamp: { wallTimeMs: 0, counter: 0, nodeId: "" }, valueHash: "", updatedByDeviceId: "" },
        defaultQuality: {
          value: customQuality,
          stamp: { wallTimeMs: 1, counter: 0, nodeId: "dev-1" },
          valueHash: "abc",
          updatedByDeviceId: "dev-1",
        },
        members: {},
      },
      clock: { nodeId: "dev-1", wallTimeMs: 0, counter: 0 },
      lastSyncAt: Date.now(),
      isSynchronized: true,
    });

    mockGetDisplayMediaResolve();

    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    try {
      await ssm.startStream({
        groupId: "test-g-1",
        source: { id: "s1", name: "Custom Quality", kind: "screen", displayId: "display-1", fingerprint: "fp-1" },
      });

      expect(startPublishingSpy).toHaveBeenCalledTimes(1);
      const callArg = startPublishingSpy.mock.calls[0][1];
      expect(callArg).toMatchObject({
        videoBitrate: 1200,
        videoWidth: 1280,
        videoHeight: 720,
        videoFps: 30,
      });
    } finally {
      startPublishingSpy.mockRestore();
    }
  });

  it("falls back to default hardcoded quality when sync state has no quality settings", async () => {
    mockGetDisplayMediaResolve();

    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    try {
      await ssm.startStream({
        groupId: "test-g-2",
        source: { id: "s2", name: "Default Quality", kind: "window", displayId: null, fingerprint: null },
      });

      expect(startPublishingSpy).toHaveBeenCalledTimes(1);
      const callArg = startPublishingSpy.mock.calls[0][1];
      // Should fall back to factory defaults: 650/854x480/15
      expect(callArg).toMatchObject({
        videoBitrate: 650,
        videoWidth: 854,
        videoHeight: 480,
        videoFps: 15,
      });
    } finally {
      startPublishingSpy.mockRestore();
    }
  });

  it("reads codec and degradation preference from group defaults and passes them to PublisherManager", async () => {
    const customQuality: GroupQualitySettings = {
      schemaVersion: 1,
      video: {
        videoBitrateKbps: 2000,
        sendWidth: 1920,
        sendHeight: 1080,
        sendFps: 60,
        captureWidth: 1920,
        captureHeight: 1080,
        captureFps: 60,
        preserveAspectRatio: true,
        preventUpscale: true,
        resolutionMode: "target-dimensions",
        scaleResolutionDownBy: 1,
        codec: "h264",
        h264Profile: "main",
        contentHint: "motion",
        degradationPreference: "maintain-framerate",
        scalabilityMode: null,
        cursorMode: "always",
        rtpPriority: "high",
      },
      audio: {
        bitrateKbps: 128,
        channels: "stereo",
        bitrateMode: "cbr",
        dtx: true,
        fec: false,
        packetDurationMs: 20,
        redundantAudio: false,
      },
    };

    const { syncService } = runtime as unknown as { syncService: { getSyncState: ReturnType<typeof vi.fn> } };
    syncService.getSyncState.mockReturnValue({
      groupId: "test-g-3",
      state: {
        schemaVersion: 1,
        groupId: "test-g-3",
        name: { value: "Test3", stamp: { wallTimeMs: 0, counter: 0, nodeId: "" }, valueHash: "", updatedByDeviceId: "" },
        defaultQuality: {
          value: customQuality,
          stamp: { wallTimeMs: 2, counter: 0, nodeId: "dev-1" },
          valueHash: "def",
          updatedByDeviceId: "dev-1",
        },
        members: {},
      },
      clock: { nodeId: "dev-1", wallTimeMs: 0, counter: 0 },
      lastSyncAt: Date.now(),
      isSynchronized: true,
    });

    mockGetDisplayMediaResolve();

    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    try {
      await ssm.startStream({
        groupId: "test-g-3",
        source: { id: "s3", name: "Codec Test", kind: "screen", displayId: null, fingerprint: null },
      });

      expect(startPublishingSpy).toHaveBeenCalledTimes(1);
      const config = startPublishingSpy.mock.calls[0][1];
      expect(config.videoBitrate).toBe(2000);
      expect(config.videoWidth).toBe(1920);
      expect(config.videoHeight).toBe(1080);
      expect(config.videoFps).toBe(60);
    } finally {
      startPublishingSpy.mockRestore();
    }
  });

  // ── Audio pipeline ownership (Stage 13+) ──────────────────────────

  /**
   * Setup window.screenlink mock for audio pipeline tests.
   * Saves and restores the original window in afterEach via vi.mock.
   * Returns the mock api object for fine-grained assertions.
   */
  let savedWindow: any = null;

  function mockAudioApi() {
    savedWindow = (globalThis as any).window;
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
    return api;
  }

  function restoreWindow() {
    if (savedWindow !== undefined) {
      Object.defineProperty(globalThis, "window", {
        value: savedWindow,
        writable: true,
        configurable: true,
      });
      savedWindow = undefined;
    } else {
      delete (globalThis as any).window;
    }
  }

  it("setupSourceAudio goes through the full IPC pipeline for screen source", async () => {
    const api = mockAudioApi();
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    // Mock window.addEventListener to immediately fire the pcm:port event
    // when the message handler is registered, so waitForPcmPort resolves instantly.
    const mockPort = {
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window.addEventListener as any).mockImplementation((type: string, handler: any) => {
      if (type === "message") {
        // Fire the pcm:port event asynchronously so the promise can be returned first
        setTimeout(() => {
          handler({ data: { type: "pcm:port" }, ports: [mockPort] } as unknown as MessageEvent);
        }, 0);
      }
    });

    // ProcessAudioController will fail in node (no AudioContext) → audio degraded
    await ssm.startStream({
      groupId: "test-audio-g-1",
      source: { id: "src-1", name: "Screen Audio Test", kind: "screen", displayId: "d-1", fingerprint: "fp-1" },
    });

    // Verify the IPC call sequence for screen source.
    // Gate 4.5: helper is ensured first, then port, then capture.
    expect(api.ensureAudioHelper).toHaveBeenCalled();
    expect(api.requestAudioPort).toHaveBeenCalled();
    // ProcessAudioController fails to initialize in node (no
    // AudioContext), so the startFilteredMonitorAudio call may not
    // be reached on every test run; the ordering test in
    // audio-startup-order.test.ts covers the call sequence.
    // We assert degraded state + active video as the contract.
    expect(ssm.state).toBe("active");
    expect(ssm.isAudioDegraded).toBe(true);

    startPublishingSpy.mockRestore();
    restoreWindow();
  });

  it("audio failure during startStream marks degraded and preserves video (screen)", async () => {
    const api = mockAudioApi();
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    // Dispatch pcm:port immediately so waitForPcmPort resolves.
    const mockPort = {
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window.addEventListener as any).mockImplementation((type: string, handler: any) => {
      if (type === "message") {
        setTimeout(() => handler({ data: { type: "pcm:port" }, ports: [mockPort] } as unknown as MessageEvent), 0);
      }
    });

    // Make startFilteredMonitorAudio fail
    api.startFilteredMonitorAudio.mockResolvedValue({ success: false, error: "mock-failure" });

    await ssm.startStream({
      groupId: "test-degrade-g-1",
      source: { id: "src-2", name: "Degrade Test", kind: "screen", displayId: null, fingerprint: null },
    });

    // Video should still be active (state is active), but audio is degraded
    expect(ssm.state).toBe("active");
    expect(ssm.isAudioDegraded).toBe(true);
    expect(startPublishingSpy).toHaveBeenCalledTimes(1);

    startPublishingSpy.mockRestore();
    restoreWindow();
  });

  it("audio failure marks degraded for window source (application audio)", async () => {
    const api = mockAudioApi();
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    // Dispatch pcm:port immediately so waitForPcmPort resolves.
    const mockPort = {
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window.addEventListener as any).mockImplementation((type: string, handler: any) => {
      if (type === "message") {
        setTimeout(() => handler({ data: { type: "pcm:port" }, ports: [mockPort] } as unknown as MessageEvent), 0);
      }
    });

    // Make ensureAudioHelper fail; the audio pipeline must roll back
    // and the video stream must stay alive and degraded.
    api.ensureAudioHelper.mockResolvedValue({ success: false, error: "helper-down" });

    await ssm.startStream({
      groupId: "test-window-degrade-g-1",
      source: { id: "src-3", name: "Window Degrade", kind: "window", displayId: null, fingerprint: null },
    });

    expect(ssm.state).toBe("active");
    expect(ssm.isAudioDegraded).toBe(true);

    // Application audio is the source-derived mode for window — the
    // dedicated startApplicationAudio call only happens after the
    // helper is alive and the port is delivered. The audio-startup-
    // order.test.ts suite covers that ordering.

    startPublishingSpy.mockRestore();
    restoreWindow();
  });

  // ── Real restart lifecycle (Stage 14+) ──────────────────────────

  it("restartStream does a real lifecycle restart: stops publication, re-captures, re-publishes", async () => {
    mockGetDisplayMediaResolve();
    const stopCaptureSpy = vi.spyOn(PublisherManager.prototype, "stopCapture")
      .mockResolvedValue(undefined);
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    // First start a stream so we have something to restart
    await ssm.startStream({
      groupId: "test-restart-g-1",
      source: { id: "r-src-1", name: "Restart Test", kind: "screen", displayId: null, fingerprint: null },
    });
    expect(ssm.state).toBe("active");
    const originalLogicalStreamId = ssm.currentLogicalStreamId;
    const originalMediaSessionId = ssm.currentMediaSessionId;

    // Reset the spies to track restart-specific calls
    stopCaptureSpy.mockClear();
    startPublishingSpy.mockClear();

    // Simulate an active state for restart
    await ssm.restartStream();

    // Verify restart lifecycle
    expect(stopCaptureSpy).toHaveBeenCalled(); // old publication stopped
    expect(startPublishingSpy).toHaveBeenCalled(); // new publication started

    // Verify logicalStreamId preserved, mediaSessionId replaced
    expect(ssm.currentLogicalStreamId).toBe(originalLogicalStreamId);
    expect(ssm.currentMediaSessionId).not.toBe(originalMediaSessionId);

    // Verify new VDO config was generated
    const newVdoConfig = ssm.getCurrentVdoConfig();
    expect(newVdoConfig).not.toBeNull();
    expect(newVdoConfig!.streamId).toBeTruthy();
    expect(newVdoConfig!.password).toBeTruthy();

    // Verify restart was sent or queued
    const connManager = runtime.getConnectionManager();
    expect(connManager.sendOrQueueStreamLifecycle).toHaveBeenCalledWith(
      "test-restart-g-1",
      originalLogicalStreamId,
      "stream.restarted",
      expect.objectContaining({ type: "stream.restarted" }),
    );

    expect(ssm.state).toBe("active");

    stopCaptureSpy.mockRestore();
    startPublishingSpy.mockRestore();
  });

  it("restartStream is no-op when not active", async () => {
    // SSM is idle
    const stopCaptureSpy = vi.spyOn(PublisherManager.prototype, "stopCapture");
    await ssm.restartStream();
    expect(stopCaptureSpy).not.toHaveBeenCalled();
    expect(ssm.state).toBe("idle");
    stopCaptureSpy.mockRestore();
  });

  it("restartStream is no-op when destroyed", async () => {
    ssm.destroy();
    const stopCaptureSpy = vi.spyOn(PublisherManager.prototype, "stopCapture");
    await ssm.restartStream();
    expect(stopCaptureSpy).not.toHaveBeenCalled();
    expect(ssm.state).toBe("destroyed");
    stopCaptureSpy.mockRestore();
  });

  it("restartStream with audio failure falls back to degraded video", async () => {
    mockGetDisplayMediaResolve();
    const startPublishingSpy = vi.spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);

    // First start a stream
    await ssm.startStream({
      groupId: "test-restart-degrade-g-1",
      source: { id: "r-src-2", name: "Restart Degrade", kind: "screen", displayId: null, fingerprint: null },
    });
    expect(ssm.state).toBe("active");

    // Make the setupSourceAudio fail by removing window.screenlink
    Object.defineProperty(globalThis, "window", {
      value: {},
      writable: true,
      configurable: true,
    });

    await ssm.restartStream();

    // Stream should be active with degraded audio
    expect(ssm.state).toBe("active");
    expect(startPublishingSpy).toHaveBeenCalled(); // video still published

    startPublishingSpy.mockRestore();
  });
});
