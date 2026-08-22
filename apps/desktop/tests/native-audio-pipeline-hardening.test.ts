// @vitest-environment node
/**
 * Hypothesis-driven regression tests for the native audio pipeline.
 *
 * Every test below is a CHARACTERIZATION test — it documents the current
 * runtime behavior of the audio pipeline. Tests use real service constructors
 * with mocks (not static fs reads).
 *
 * Design spec §9.3 hypotheses covered:
 *   H2: MessagePort listener detached synchronously before awaited AudioContext close
 *   H3: waitForPcmPort listener cleans on success, timeout, and concurrent waits
 *   H5: Audio setup failure during restart sets isAudioDegraded
 *
 * NOT covered here (tested in audio-ownership-regression.test.ts):
 *   H1: Controller replacement/close idempotence
 *   H4: Combined stream validation (buildCombinedStream invariants)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── File-level cleanup (runs after EVERY test) ──────────────────────────
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════════
// H2: MessagePort listener detached synchronously before awaited AudioContext close
// ═════════════════════════════════════════════════════════════════════════════

describe("H2: MessagePort teardown before async AudioContext shutdown (ordering)", () => {
  it("port listener removal and port.close() complete before deferred audioContext.close() resolves", async () => {
    // ── Deferred promise for AudioContext.close() ────────────────
    // We hold the resolve function so the close() method hits its
    // first await and pauses *before* our ordering assertions.
    let resolveAudioClose!: () => void;
    const audioClosePromise = new Promise<void>((resolve) => {
      resolveAudioClose = resolve;
    });

    // ── Call-order tracking ────────────────────────────────────
    const order: string[] = [];

    // ── Mock AudioContext ──────────────────────────────────────
    const mockAudioCtx = {
      sampleRate: 48000,
      state: "running",
      audioWorklet: {
        addModule: vi.fn().mockResolvedValue(undefined),
      },
      createAnalyser: vi.fn(() => ({
        fftSize: 2048,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(() => { order.push("analyser.disconnect"); }),
      })),
      createMediaStreamDestination: vi.fn(() => ({
        stream: {
          getAudioTracks: () => [{
            id: "mock-audio-track",
            kind: "audio",
            enabled: true,
            muted: false,
            readyState: "live",
            stop: vi.fn(() => { order.push("audioTrack.stop"); }),
          }],
        },
      })),
      close: vi.fn(() => {
        order.push("audioContext.close invoked");
        return audioClosePromise;
      }),
      resume: vi.fn().mockResolvedValue(undefined),
    };

    vi.stubGlobal("AudioContext", vi.fn(() => mockAudioCtx));

    // ── Mock AudioWorkletNode ──────────────────────────────────
    const workletPortRemove = vi.fn(() => { order.push("worklet.port.removeEventListener"); });
    const workletPortAdd = vi.fn();
    vi.stubGlobal("AudioWorkletNode", class MockAudioWorkletNode {
      port = {
        addEventListener: workletPortAdd,
        removeEventListener: workletPortRemove,
        start: vi.fn(),
        postMessage: vi.fn(),
      };
      connect = vi.fn(() => { order.push("worklet.connect"); });
      disconnect = vi.fn(() => { order.push("worklet.disconnect"); });
    });

    // ── Mock MessagePort for initialize ────────────────────────
    const portRemoveMessage = vi.fn(() => { order.push("port.removeEventListener message"); });
    const portRemoveError = vi.fn(() => { order.push("port.removeEventListener messageerror"); });
    const portCloseSpy = vi.fn(() => { order.push("port.close"); });
    const mockPort = {
      addEventListener: vi.fn(),
      postMessage: vi.fn(),
      start: vi.fn(),
      close: portCloseSpy,
      removeEventListener: vi.fn((type: string) => {
        if (type === "message") portRemoveMessage();
        else if (type === "messageerror") portRemoveError();
      }),
    } as unknown as MessagePort;

    // ── Create & initialize controller ─────────────────────────
    const { ProcessAudioController } = await import(
      "../src/renderer/audio/ProcessAudioController"
    );
    const ctrl = new ProcessAudioController();
    await ctrl.initialize(mockPort);

    // Sanity: controller is in a valid state after initialize
    expect(ctrl.getState()).toBe("buffering");

    // ── Call close() — DO NOT await yet ────────────────────────
    // The function body runs synchronously up to the first await
    // (audioContext.close()). At that point it suspends because the
    // deferred promise is still pending.
    order.length = 0; // reset tracking for close() phase
    const closePromise = ctrl.close("test");

    // ---- AT THIS POINT close() is SUSPENDED at the await ----
    // All synchronous cleanup has already completed. Verify ordering
    // inside a try/finally so the deferred is ALWAYS resolved even if
    // an assertion fails — the test reports the failure instead of hanging.
    try {
      // 1) Port listeners were removed
      expect(order).toContain("port.removeEventListener message");
      expect(order).toContain("port.removeEventListener messageerror");
      // 2) Worklet listener was removed
      expect(order).toContain("worklet.port.removeEventListener");
      // 3) Port was closed
      expect(order).toContain("port.close");
      // 4) AudioTrack was stopped
      expect(order).toContain("audioTrack.stop");
      // 5) Worklet was disconnected
      expect(order).toContain("worklet.disconnect");
      // 6) Analyser was disconnected
      expect(order).toContain("analyser.disconnect");
      // 7) audioContext.close() was *invoked* (returned deferred, not resolved)
      expect(order).toContain("audioContext.close invoked");

      // 8) CRITICAL: port.close() happened BEFORE audioContext.close was invoked
      const portCloseIdx = order.indexOf("port.close");
      const audioCtxCloseIdx = order.indexOf("audioContext.close invoked");
      expect(portCloseIdx).toBeGreaterThanOrEqual(0);
      expect(audioCtxCloseIdx).toBeGreaterThan(portCloseIdx);

      // 9) State has NOT yet transitioned to 'closed' (that happens after await)
      expect(ctrl.getState()).not.toBe("closed");
    } finally {
      // Guarantee: always resolve the deferred so close() cannot hang
      // the test, even if an ordering assertion above fails.
      resolveAudioClose();
    }

    // ── Now let close() finish (it was unblocked by finally above) ─
    await closePromise;

    // ── Final state assertions ─────────────────────────────────
    expect(mockAudioCtx.close).toHaveBeenCalled();
    expect(ctrl.getState()).toBe("closed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// H3: waitForPcmPort listener cleanup on success, timeout, concurrent
// ═════════════════════════════════════════════════════════════════════════════

describe("H3: waitForPcmPort listener cleanup (characterization)", () => {
  let handlers: Map<string, Set<(event: any) => void>>;
  let addSpy: ReturnType<typeof vi.fn>;
  let removeSpy: ReturnType<typeof vi.fn>;
  const mockPort = {
    postMessage: vi.fn(),
    close: vi.fn(),
    start: vi.fn(),
  };

  beforeEach(() => {
    handlers = new Map();
    addSpy = vi.fn((type: string, handler: any) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    });
    removeSpy = vi.fn((type: string, handler: any) => {
      handlers.get(type)?.delete(handler);
    });
    (globalThis as any).window = {
      addEventListener: addSpy,
      removeEventListener: removeSpy,
    };
  });

  afterEach(() => {
    delete (globalThis as any).window;
    // vi.useRealTimers also at file-level afterEach
  });

  it("removes event listener after successful pcm:port resolution", async () => {
    // Use fake timers so the success-path setTimeout(1000) inside
    // waitForPcmPort (which is NOT cleared on success) is captured
    // and discarded by afterEach via vi.useRealTimers().
    vi.useFakeTimers();

    const { StreamSessionManager } = await import(
      "../src/renderer/services/stream-session-manager"
    );
    const ssm = new (StreamSessionManager as any)({
      deviceId: "test",
      displayName: "T",
      getGroupId: () => "g",
      sendOrQueueStreamLifecycle: vi.fn(),
      clearSharingGroupInStore: vi.fn(),
    });

    const promise = (ssm.waitForPcmPort as (ms: number) => Promise<any>)(1000);

    // Listener must be registered
    expect(addSpy).toHaveBeenCalledWith("message", expect.any(Function));
    const handler = addSpy.mock.calls[0][1];
    expect(handlers.get("message")?.has(handler)).toBe(true);

    // Deliver pcm:port message via stored handler
    handler({ data: { type: "pcm:port" }, ports: [mockPort] });
    const port = await promise;

    expect(port).toBe(mockPort);

    // Handler must be removed after resolution
    expect(removeSpy).toHaveBeenCalledWith("message", handler);
    expect(handlers.get("message")?.has(handler)).toBe(false);
  });

  it("removes event listener on timeout", async () => {
    vi.useFakeTimers();

    const { StreamSessionManager } = await import(
      "../src/renderer/services/stream-session-manager"
    );
    const ssm = new (StreamSessionManager as any)({
      deviceId: "test",
      displayName: "T",
      getGroupId: () => "g",
      sendOrQueueStreamLifecycle: vi.fn(),
      clearSharingGroupInStore: vi.fn(),
    });

    const promise = (ssm.waitForPcmPort as (ms: number) => Promise<any>)(5000);
    const handler = addSpy.mock.calls[0][1];
    expect(handlers.get("message")?.has(handler)).toBe(true);

    vi.advanceTimersByTime(5000);
    await expect(promise).rejects.toThrow("pcm:port wait timeout");

    // Handler must be removed on timeout
    expect(removeSpy).toHaveBeenCalledWith("message", handler);
    expect(handlers.get("message")?.has(handler)).toBe(false);
  });

  it("overlapping waitForPcmPort calls: earlier waiter resolves its timeout independently of later waiter", async () => {
    vi.useFakeTimers();

    const { StreamSessionManager } = await import(
      "../src/renderer/services/stream-session-manager"
    );
    const ssm = new (StreamSessionManager as any)({
      deviceId: "test",
      displayName: "T",
      getGroupId: () => "g",
      sendOrQueueStreamLifecycle: vi.fn(),
      clearSharingGroupInStore: vi.fn(),
    });

    // Call #1 — registers listener #1 with 5s timeout
    const promise1 = (ssm.waitForPcmPort as (ms: number) => Promise<any>)(5000);
    const handler1 = addSpy.mock.calls[0][1];

    // Call #2 — registers listener #2 with 5s timeout
    const promise2 = (ssm.waitForPcmPort as (ms: number) => Promise<any>)(5000);
    const handler2 = addSpy.mock.calls[1][1];

    // Both listeners are registered
    expect(handlers.get("message")?.has(handler1)).toBe(true);
    expect(handlers.get("message")?.has(handler2)).toBe(true);

    // Resolve call #2 via pcm:port message
    handler2({ data: { type: "pcm:port" }, ports: [mockPort] });
    await promise2;

    // Handler2 removed (resolved path)
    expect(removeSpy).toHaveBeenCalledWith("message", handler2);
    expect(handlers.get("message")?.has(handler2)).toBe(false);

    // Handler1 persists until its timeout (bounded leak, ~200 bytes for 5s)
    expect(handlers.get("message")?.has(handler1)).toBe(true);

    // Advance past timeout
    vi.advanceTimersByTime(5000);
    await expect(promise1).rejects.toThrow("pcm:port wait timeout");

    // Handler1 now cleaned up
    expect(removeSpy).toHaveBeenCalledWith("message", handler1);
    expect(handlers.get("message")?.has(handler1)).toBe(false);
  });
});



// ═════════════════════════════════════════════════════════════════════════════
// H5: Audio setup failure during restart sets isAudioDegraded
// ═════════════════════════════════════════════════════════════════════════════

describe("H5: restartStream with audio IPC failure sets isAudioDegraded (integration)", () => {
  let ssm: any;
  let startPublishingSpy: any;
  let stopCaptureSpy: any;
  /** Saved descriptors for cleanup. */
  let savedWindowDesc: PropertyDescriptor | undefined;
  let savedNavDesc: PropertyDescriptor | undefined;

  function captureAndMockDisplayMedia(): void {
    const fakeTrack = {
      kind: "video",
      label: "Screen",
      id: crypto.randomUUID(),
      enabled: true,
      readyState: "live" as const,
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
      // Capture original navigator descriptor only once.
      if (savedNavDesc === undefined) {
        savedNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
      }
      Object.defineProperty(globalThis, "navigator", {
        value: { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(fakeStream) } },
        writable: true,
        configurable: true,
      });
    }
  }

  function makeMockRuntime(): any {
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
      getAllViewers: vi.fn().mockReturnValue([]),
      removeMappingsForMediaSessions: vi.fn(),
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
    };
  }

  function installFailingAudioWindow(): void {
    // Capture original descriptor only ONCE — repeated calls cannot
    // overwrite the saved original with the mock descriptor.
    if (savedWindowDesc === undefined) {
      savedWindowDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
    }
    const failApi = {
      ensureAudioHelper: vi.fn().mockResolvedValue({ success: false, error: "helper-unavailable" }),
      requestAudioPort: vi.fn(),
      startFilteredMonitorAudio: vi.fn(),
      startApplicationAudio: vi.fn(),
      stopAudio: vi.fn(),
    };
    Object.defineProperty(globalThis, "window", {
      value: {
        screenlink: failApi,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
      },
      writable: true,
      configurable: true,
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    const [{ StreamSessionManager }, { PublisherManager }] = await Promise.all([
      import("../src/renderer/services/stream-session-manager"),
      import("../src/renderer/services/publisher-manager"),
    ]);
    const runtime = makeMockRuntime();
    ssm = new (StreamSessionManager as any)(runtime);

    captureAndMockDisplayMedia();
    // No window.screenlink setup — audioMode="none" in the test avoids
    // needing the audio pipeline for the initial startStream.

    // Spy on PublisherManager prototype so startPublishing succeeds without SDK
    startPublishingSpy = vi
      .spyOn(PublisherManager.prototype, "startPublishing")
      .mockResolvedValue(undefined);
    stopCaptureSpy = vi
      .spyOn(PublisherManager.prototype, "stopCapture")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Restore window descriptor if we overwrote it.
    if (savedWindowDesc !== undefined) {
      Object.defineProperty(globalThis, "window", savedWindowDesc);
      savedWindowDesc = undefined;
    }
    // Restore navigator descriptor if we created it.
    if (savedNavDesc !== undefined) {
      Object.defineProperty(globalThis, "navigator", savedNavDesc);
      savedNavDesc = undefined;
    }
  });

  it("restartStream with ensureAudioHelper failure sets isAudioDegraded=true, keeps video active", async () => {
    // ── Phase 1: Start an active stream with audioMode="none" ─────
    // We skip audio initially so the first startStream does not block
    // on waitUntilPrimed() (no AudioWorkletNode in node env).
    await ssm.startStream({
      groupId: "test-h5-g",
      source: { id: "h5-src", name: "H5 Source", kind: "screen", displayId: null, fingerprint: null },
      audioMode: "none",
    });
    expect(ssm.state).toBe("active");
    expect(ssm.isAudioDegraded).toBe(false);
    const originalStreamId = ssm.currentLogicalStreamId;

    // ── Phase 2: Establish preconditions for audio during restart ──
    // Inject the audio-mode so restartStream attempts setupSourceAudio.
    // (Minimal private injection to establish preconditions — the
    // method under test is still restartStream, not setupSourceAudio.)
    ssm._explicitAudioMode = "monitor";
    ssm._sourceKind = "screen";
    ssm._sourceId = "h5-src";

    // Set up window.screenlink with failing ensureAudioHelper.
    installFailingAudioWindow();

    // ── Phase 3: Execute restart ─────────────────────────────────
    await ssm.restartStream();

    // ── Phase 4: Assertions ──────────────────────────────────────
    expect(ssm.state).toBe("active");
    expect(ssm.currentLogicalStreamId).toBe(originalStreamId);
    expect(ssm.currentMediaSessionId).not.toBeUndefined();
    expect(ssm.isAudioDegraded).toBe(true);
    expect(startPublishingSpy).toHaveBeenCalledTimes(2);
    expect(stopCaptureSpy).toHaveBeenCalled();
  });
}, 10000);
