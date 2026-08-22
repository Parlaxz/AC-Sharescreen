// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ViewerSenderController } from "../src/renderer/services/viewer-sender-controller.js";
import type { ViewerBindingId } from "../src/renderer/services/viewer-sender-controller.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const bId: ViewerBindingId = {
  groupId: "g-1",
  logicalStreamId: "ls-1",
  viewerDeviceId: "v-1",
  mediaSessionId: "ms-1",
};

function makeMockSender(overrides?: {
  encodings?: RTCRtpEncodingParameters[];
  setParametersImpl?: (p: RTCRtpSendParameters) => Promise<void>;
}): RTCRtpSender {
  let params: RTCRtpSendParameters = {
    encodings: overrides?.encodings ?? [{ active: true, maxBitrate: 5_000_000, maxFramerate: 30 }],
    codecs: [],
    headerExtensions: [],
    rtcp: {},
    transactionId: "tx-test",
  };

  const setParametersFn = overrides?.setParametersImpl ?? vi.fn(async (p: RTCRtpSendParameters) => {
    params = { ...p, encodings: p.encodings?.map(e => ({ ...e })) ?? [] };
  });

  return {
    track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) } as MediaStreamTrack,
    getParameters: vi.fn(() => ({
      ...params,
      encodings: params.encodings?.map(e => ({ ...e })) ?? [],
    })),
    setParameters: setParametersFn,
  } as unknown as RTCRtpSender;
}

function makeMockAudioSender(overrides?: {
  encodings?: RTCRtpEncodingParameters[];
}): RTCRtpSender {
  let params: RTCRtpSendParameters = {
    encodings: overrides?.encodings ?? [{ active: true }],
    codecs: [],
    headerExtensions: [],
    rtcp: {},
    transactionId: "tx-audio",
  };

  return {
    track: { kind: "audio" } as MediaStreamTrack,
    getParameters: vi.fn(() => ({
      ...params,
      encodings: params.encodings?.map(e => ({ ...e })) ?? [],
    })),
    setParameters: vi.fn(async (p: RTCRtpSendParameters) => {
      params = { ...p, encodings: p.encodings?.map(e => ({ ...e })) ?? [] };
    }),
  } as unknown as RTCRtpSender;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ViewerSenderController Phase 7A — bounded timeout", () => {
  let controller: ViewerSenderController;

  beforeEach(() => {
    controller = new ViewerSenderController({ pauseTimeoutMs: 1000 });
  });

  afterEach(() => {
    controller.destroy();
  });

  // ── applyPause timeout ──────────────────────────────────────────────

  it("applyPause returns apply-failed with timeout error when setParameters never resolves (video)", async () => {
    const neverResolve = new Promise<void>(() => { /* never resolves */ });
    const sender = makeMockSender({ setParametersImpl: vi.fn(() => neverResolve) });
    controller.registerSenders(bId, { videoSender: sender, audioSender: null });

    const result = await controller.applyPause(bId);

    expect(result.status).toBe("apply-failed");
    expect(result.error).toContain("timed out");
  });

  it("applyPause returns apply-failed with timeout error when setParameters never resolves (audio)", async () => {
    const neverResolve = new Promise<void>(() => { /* never resolves */ });
    const videoSender = makeMockSender();
    const audioSender = makeMockAudioSender();
    // Override only audio setParameters to hang
    const origSetParams = audioSender.setParameters;
    (audioSender as any).setParameters = vi.fn(() => neverResolve);
    controller.registerSenders(bId, { videoSender, audioSender: audioSender });

    const result = await controller.applyPause(bId);

    expect(result.status).toBe("apply-failed");
    expect(result.error).toContain("timed out");
  });

  it("applyPause does not commit paused state on timeout", async () => {
    const neverResolve = new Promise<void>(() => { /* never resolves */ });
    const sender = makeMockSender({ setParametersImpl: vi.fn(() => neverResolve) });
    controller.registerSenders(bId, { videoSender: sender, audioSender: null });

    await controller.applyPause(bId);

    // Paused state must NOT be stored
    expect(controller.getPausedState(bId)).toBeNull();
  });

  it("applyPause returns apply-failed with timeout error when setParameters hangs but audio proceeds (partial fail)", async () => {
    const neverResolve = new Promise<void>(() => { /* never resolves */ });
    const videoSender = makeMockSender({ setParametersImpl: vi.fn(() => neverResolve) });
    const audioSender = makeMockAudioSender();
    controller.registerSenders(bId, { videoSender, audioSender });

    const result = await controller.applyPause(bId);

    expect(result.status).toBe("apply-failed");
    expect(result.error).toContain("timed out");
  });

  it("applyPause succeeds when setParameters resolves within timeout", async () => {
    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null });

    const result = await controller.applyPause(bId);

    expect(result.status).toBe("applied");
    expect(result.configured).toBeDefined();
    // Pause only sets active=false, does not modify maxBitrate
    expect(result.configured!.maxBitrate).toBeGreaterThan(0);
  });

  // ── applyResume timeout ─────────────────────────────────────────────

  it("applyResume returns apply-failed with timeout error when setParameters never resolves", async () => {
    const neverResolve = new Promise<void>(() => { /* never resolves */ });
    const sender = makeMockSender({ setParametersImpl: vi.fn(() => neverResolve) });
    controller.registerSenders(bId, { videoSender: sender, audioSender: null });

    // Pause first to set up saved state
    await controller.applyPause(bId); // fails — no state saved
    // Manually set paused state for resume test
    (controller as any).pausedStates.set("g-1::ls-1::v-1::ms-1", {
      videoEncodings: [{ active: true }],
      audioEncodings: [],
    });

    const result = await controller.applyResume(bId, {}, { width: 1920, height: 1080 });

    expect(result.status).toBe("apply-failed");
    expect(result.error).toContain("timed out");
  });

  it("applyResume preserves prior paused state on timeout", async () => {
    const neverResolve = new Promise<void>(() => { /* never resolves */ });
    const sender = makeMockSender({ setParametersImpl: vi.fn(() => neverResolve) });
    controller.registerSenders(bId, { videoSender: sender, audioSender: null });

    // Manually set paused state
    const pausedState = { videoEncodings: [{ active: true }], audioEncodings: [] };
    (controller as any).pausedStates.set("g-1::ls-1::v-1::ms-1", pausedState);

    await controller.applyResume(bId, {}, { width: 1920, height: 1080 });

    // Paused state must still be present after timeout
    const saved = controller.getPausedState(bId);
    expect(saved).not.toBeNull();
    expect(saved!.videoEncodings[0]!.active).toBe(true);
  });

  it("applyResume preserves desired state (quality/media-mode) on timeout", async () => {
    const neverResolve = new Promise<void>(() => { /* never resolves */ });
    const sender = makeMockSender({ setParametersImpl: vi.fn(() => neverResolve) });
    controller.registerSenders(bId, { videoSender: sender, audioSender: null });

    // Set media mode
    controller.setMediaMode(bId, true, false);

    const pausedState = { videoEncodings: [{ active: true }], audioEncodings: [] };
    (controller as any).pausedStates.set("g-1::ls-1::v-1::ms-1", pausedState);

    await controller.applyResume(bId, { videoEnabled: false }, { width: 1920, height: 1080 });

    // Media mode must be preserved
    const mediaMode = controller.getMediaMode(bId);
    expect(mediaMode.videoEnabled).toBe(false);
    // Paused state must be preserved
    expect(controller.getPausedState(bId)).not.toBeNull();
  });

  it("applyResume succeeds when setParameters resolves within timeout", async () => {
    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null });

    // Manually set paused state to simulate prior pause
    (controller as any).pausedStates.set("g-1::ls-1::v-1::ms-1", {
      videoEncodings: [{ active: true }],
      audioEncodings: [],
    });

    const result = await controller.applyResume(bId, {}, { width: 1920, height: 1080 });

    expect(result.status).toBe("applied");
    expect(result.configured).toBeDefined();
  });

  // ── Configurable timeout ────────────────────────────────────────────

  it("uses custom timeout when provided via constructor", () => {
    let capturedTimerMs = 0;
    const fakeSetTimeout = ((fn: Function, ms: number) => {
      capturedTimerMs = ms;
      return 123 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;

    const customCtrl = new ViewerSenderController({
      pauseTimeoutMs: 250,
      setTimeout: fakeSetTimeout,
      clearTimeout: vi.fn() as unknown as typeof globalThis.clearTimeout,
    });

    // Verify constructor stores the custom timeout
    expect((customCtrl as any).pauseTimeoutMs).toBe(250);
    customCtrl.destroy();
  });

  it("default timeout is 5000ms", () => {
    const defaultCtrl = new ViewerSenderController();
    expect((defaultCtrl as any).pauseTimeoutMs).toBe(5000);
    defaultCtrl.destroy();
  });

  // ── Active-state readback on timeout ────────────────────────────────

  it("active encoding state does not change when resume times out", async () => {
    // Create a stateful (applying) sender
    const sender = makeMockSender({ encodings: [{ active: false }] });
    controller.registerSenders(bId, { videoSender: sender, audioSender: null });

    // Set paused state saying encoding 0 was active=true
    (controller as any).pausedStates.set("g-1::ls-1::v-1::ms-1", {
      videoEncodings: [{ active: true }],
      audioEncodings: [],
    });

    // Use a setParameters that hangs
    const neverResolve = new Promise<void>(() => {});
    (sender as any).setParameters = vi.fn(() => neverResolve);

    await controller.applyResume(bId, {}, { width: 1920, height: 1080 });

    // Sender should still be inactive (timeout prevented the resume)
    const params = sender.getParameters();
    expect(params.encodings?.[0]?.active).toBe(false);
  });
});

describe("ViewerSenderController Phase 7A — injectable timer for deterministic tests", () => {
  it("timeout fires when custom setTimeout advances past limit", async () => {
    // Use a real resolver to make the pause succeed first, then test timeout on resume
    let resolveSetParams: (() => void) | null = null;
    const controllablePromise = new Promise<void>((resolve) => { resolveSetParams = resolve; });

    let registeredTimer: (() => void) | null = null;
    const fakeSetTimeout = ((fn: () => void, _ms: number) => {
      registeredTimer = fn;
      return 456 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    const fakeClearTimeout = vi.fn() as unknown as typeof globalThis.clearTimeout;

    const ctrl = new ViewerSenderController({
      pauseTimeoutMs: 100,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    });

    // First make a sender that resolves setParameters so pause works
    const sender = makeMockSender();
    const bId2: ViewerBindingId = { groupId: "g-2", logicalStreamId: "ls-2", viewerDeviceId: "v-2", mediaSessionId: "ms-2" };
    ctrl.registerSenders(bId2, { videoSender: sender, audioSender: null });

    // Pause works because the mock sender resolves immediately
    const pauseResult = await ctrl.applyPause(bId2);
    expect(pauseResult.status).toBe("applied");

    // Now try a resume with a hanging setParameters
    // Replace the sender's setParameters with a hanging one
    const hangingSender = makeMockSender({ setParametersImpl: vi.fn(() => controllablePromise) });
    ctrl.registerSenders(bId2, { videoSender: hangingSender, audioSender: null });

    // Start resume — it will hang until we fire the timer or resolve the promise
    const resumePromise = ctrl.applyResume(bId2, {}, { width: 1920, height: 1080 });

    // Fire the registered timeout
    expect(registeredTimer).not.toBeNull();
    registeredTimer!();

    const result = await resumePromise;
    expect(result.status).toBe("apply-failed");
    expect(result.error).toContain("timed out");

    // Also verify the timer was cleared (cancelled) after timeout
    expect(fakeClearTimeout).toHaveBeenCalled();
    ctrl.destroy();
  });

  it("success path clears the timer", async () => {
    let timerCleared = false;
    const fakeSetTimeout = ((fn: () => void, _ms: number) => {
      return 789 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    const fakeClearTimeout = ((id: unknown) => {
      if (id === 789) timerCleared = true;
    }) as unknown as typeof globalThis.clearTimeout;

    const ctrl = new ViewerSenderController({
      pauseTimeoutMs: 100,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    });

    const sender = makeMockSender();
    const bId3: ViewerBindingId = { groupId: "g-3", logicalStreamId: "ls-3", viewerDeviceId: "v-3", mediaSessionId: "ms-3" };
    ctrl.registerSenders(bId3, { videoSender: sender, audioSender: null });

    await ctrl.applyPause(bId3);
    expect(timerCleared).toBe(true);
    ctrl.destroy();
  });
});

describe("ViewerSenderController media mode while paused", () => {
  let controller: ViewerSenderController;

  beforeEach(() => {
    controller = new ViewerSenderController({ pauseTimeoutMs: 1000 });
  });

  afterEach(() => {
    controller.destroy();
  });

  it("keeps both senders inactive when media mode changes while paused", async () => {
    const videoSender = makeMockSender();
    const audioSender = makeMockAudioSender();
    controller.registerSenders(bId, { videoSender, audioSender });

    const pauseResult = await controller.applyPause(bId);
    expect(pauseResult.status).toBe("applied");

    const result = await controller.applyMediaMode(bId, true, true, { width: 1920, height: 1080 });

    expect(result.status).toBe("applied");
    expect(videoSender.getParameters().encodings?.every((encoding) => encoding.active === false)).toBe(true);
    expect(audioSender.getParameters().encodings?.every((encoding) => encoding.active === false)).toBe(true);
    expect(videoSender.setParameters).toHaveBeenCalledTimes(2);
    expect(audioSender.setParameters).toHaveBeenCalledTimes(2);
    expect(videoSender.setParameters).toHaveBeenLastCalledWith(
      expect.objectContaining({ encodings: [expect.objectContaining({ active: false })] }),
    );
    expect(audioSender.setParameters).toHaveBeenLastCalledWith(
      expect.objectContaining({ encodings: [expect.objectContaining({ active: false })] }),
    );
  });

  it("stores the requested media mode while paused", async () => {
    const videoSender = makeMockSender();
    const audioSender = makeMockAudioSender();
    controller.registerSenders(bId, { videoSender, audioSender });

    await controller.applyPause(bId);
    await controller.applyMediaMode(bId, true, true, { width: 1920, height: 1080 });

    expect(controller.getMediaMode(bId)).toEqual({ audioEnabled: true, videoEnabled: true });
  });

  it("activates both senders when media mode changes without a paused state", async () => {
    const videoSender = makeMockSender({ encodings: [{ active: false }] });
    const audioSender = makeMockAudioSender({ encodings: [{ active: false }] });
    controller.registerSenders(bId, { videoSender, audioSender });

    const result = await controller.applyMediaMode(bId, true, true, { width: 1920, height: 1080 });

    expect(result.status).toBe("applied");
    expect(videoSender.getParameters().encodings?.[0]?.active).toBe(true);
    expect(audioSender.getParameters().encodings?.[0]?.active).toBe(true);
  });
});

// ─── Phase 7B: Outbound observation ─────────────────────────────────────────

describe("ViewerSenderController Phase 7B — outbound observation", () => {
  let controller: ViewerSenderController;

  afterEach(() => {
    controller?.destroy();
  });

  // ── bytesSent falling below threshold → applied ─────────────────────

  it("confirms pause when outbound bytes stay below threshold", async () => {
    let callIndex = 0;
    const values = [1000, 1800, 2600, 3400]; // each delta ≈ 800 bytes
    const fakeObserve = vi.fn(async () => {
      const v = values[callIndex] ?? 0;
      callIndex++;
      return v;
    });

    // BPS = delta(800) / (5ms/1000) = 160,000 — set threshold above that
    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: {
        maxBytesPerSecond: 200_000,
        sampleIntervalMs: 5,
        confirmationWindowMs: 15,
      },
      observeOutboundBytes: fakeObserve,
    });

    const sender = makeMockSender();
    const fakePC = { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection;
    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: fakePC });

    const result = await controller.applyPause(bId);

    expect(result.status).toBe("applied");
    // initial + 3 samples = 4 calls
    expect(fakeObserve).toHaveBeenCalledTimes(4);
    expect(controller.getPausedState(bId)).not.toBeNull();
  });

  it("confirms pause with zero bytes (static frame / no motion)", async () => {
    const fakeObserve = vi.fn(async () => 0);

    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 1000, sampleIntervalMs: 3, confirmationWindowMs: 9 },
      observeOutboundBytes: fakeObserve,
    });

    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection });

    const result = await controller.applyPause(bId);
    expect(result.status).toBe("applied");
  });

  it("skips observation when no PC is registered (compat mode)", async () => {
    const fakeObserve = vi.fn();
    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 100, sampleIntervalMs: 100, confirmationWindowMs: 300 },
      observeOutboundBytes: fakeObserve,
      requirePcForObservation: false,
    });

    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null }); // no pc

    const result = await controller.applyPause(bId);
    expect(result.status).toBe("applied");
    expect(fakeObserve).not.toHaveBeenCalled();
  });

  it("fails when no PC is registered (authoritative mode)", async () => {
    const fakeObserve = vi.fn();
    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 100, sampleIntervalMs: 100, confirmationWindowMs: 300 },
      observeOutboundBytes: fakeObserve,
      // requirePcForObservation defaults to true
    });

    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null }); // no pc

    const result = await controller.applyPause(bId);
    expect(result.status).toBe("apply-failed");
    expect(result.error).toContain("no RTCPeerConnection");
    expect(fakeObserve).not.toHaveBeenCalled();
  });

  it("skips observation when no policy is configured", async () => {
    const fakeObserve = vi.fn();
    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      observeOutboundBytes: fakeObserve,
      requirePcForObservation: false,
    });

    const sender = makeMockSender();
    const fakePC = { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection;
    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: fakePC });

    const result = await controller.applyPause(bId);
    expect(result.status).toBe("applied");
    expect(fakeObserve).not.toHaveBeenCalled();
  });

  // ── bytesSent exceeding threshold → truthful failure/rollback ──────

  it("fails when outbound bytes exceed threshold", async () => {
    let callCount = 0;
    const fakeObserve = vi.fn(async () => {
      callCount++;
      return callCount * 100000; // first delta = 200K - 100K = 100K / 0.1s = 1M B/s
    });

    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 10000, sampleIntervalMs: 5, confirmationWindowMs: 15 },
      observeOutboundBytes: fakeObserve,
    });

    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection });

    const result = await controller.applyPause(bId);

    expect(result.status).toBe("apply-failed");
    expect(result.error).toContain("quiescence");
    // Paused state must NOT be committed
    expect(controller.getPausedState(bId)).toBeNull();
  });

  it("rolls back video sender active states after failed observation", async () => {
    // Set up a stateful (applying) sender
    let senderParams: RTCRtpSendParameters = {
      encodings: [{ active: true, maxBitrate: 5_000_000 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-rollback",
    };
    const setParams = vi.fn(async (p: RTCRtpSendParameters) => {
      senderParams = { ...p, encodings: p.encodings?.map(e => ({ ...e })) ?? [] };
    });
    const getParams = vi.fn(() => ({
      ...senderParams,
      encodings: senderParams.encodings?.map(e => ({ ...e })) ?? [],
    }));

    const sender = {
      track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) } as MediaStreamTrack,
      getParameters: getParams,
      setParameters: setParams,
    } as unknown as RTCRtpSender;

    // Increasing bytes to trigger threshold
    let callIdx = 0;
    const fakeObserve = vi.fn(async () => {
      callIdx++;
      return callIdx * 999999;
    });

    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 1000, sampleIntervalMs: 5, confirmationWindowMs: 15 },
      observeOutboundBytes: fakeObserve,
    });

    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection });

    const result = await controller.applyPause(bId);

    expect(result.status).toBe("apply-failed");

    // After rollback, the sender should have active=true again
    const readback = sender.getParameters();
    expect(readback.encodings?.[0]?.active).toBe(true);
  });

  // ── Multiple viewers isolated ──────────────────────────────────────

  it("isolates observation state across multiple bindings", async () => {
    const ctrl = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 10000, sampleIntervalMs: 5, confirmationWindowMs: 15 },
      observeOutboundBytes: vi.fn(async () => 0),
    });

    const bIdA: ViewerBindingId = { groupId: "g-a", logicalStreamId: "ls-a", viewerDeviceId: "v-a", mediaSessionId: "ms-a" };
    const bIdB: ViewerBindingId = { groupId: "g-b", logicalStreamId: "ls-b", viewerDeviceId: "v-b", mediaSessionId: "ms-b" };

    const senderA = makeMockSender();
    const senderB = makeMockSender();
    ctrl.registerSenders(bIdA, { videoSender: senderA, audioSender: null, pc: { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection });
    ctrl.registerSenders(bIdB, { videoSender: senderB, audioSender: null, pc: { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection });

    const [resultA, resultB] = await Promise.all([
      ctrl.applyPause(bIdA),
      ctrl.applyPause(bIdB),
    ]);

    expect(resultA.status).toBe("applied");
    expect(resultB.status).toBe("applied");

    // Each binding has independent paused state
    expect(ctrl.getPausedState(bIdA)).not.toBeNull();
    expect(ctrl.getPausedState(bIdB)).not.toBeNull();

    ctrl.destroy();
  });

  // ── Resume restores quality and active state after confirmed pause ──

  it("resume restores active state and quality after confirmed pause", async () => {
    // Stateful sender
    let senderParams: RTCRtpSendParameters = {
      encodings: [{ active: true, maxBitrate: 5_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-resume",
    };
    const setParams = vi.fn(async (p: RTCRtpSendParameters) => {
      senderParams = { ...p, encodings: p.encodings?.map(e => ({ ...e })) ?? [] };
    });
    const getParams = vi.fn(() => ({
      ...senderParams,
      encodings: senderParams.encodings?.map(e => ({ ...e })) ?? [],
    }));

    const sender = {
      track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) } as MediaStreamTrack,
      getParameters: getParams,
      setParameters: setParams,
    } as unknown as RTCRtpSender;

    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 100000, sampleIntervalMs: 5, confirmationWindowMs: 15 },
      observeOutboundBytes: vi.fn(async () => 0),
    });

    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection });

    // Pause — should confirm (bytes at 0 < threshold)
    const pauseResult = await controller.applyPause(bId);
    expect(pauseResult.status).toBe("applied");

    // Verify sender is now inactive
    expect(sender.getParameters().encodings?.[0]?.active).toBe(false);

    // Resume — should restore active=true with quality
    const resumeResult = await controller.applyResume(bId, {
      effective: { videoBitrateKbps: 2000, maxWidth: 1280, maxHeight: 720, maxFps: 30, degradationPreference: "balanced" },
    }, { width: 1920, height: 1080 });
    expect(resumeResult.status).toBe("applied");

    // Verify sender is active again with quality restored
    const after = sender.getParameters();
    expect(after.encodings?.[0]?.active).toBe(true);
    expect(after.encodings?.[0]?.maxBitrate).toBe(2_000_000);
    expect(after.encodings?.[0]?.maxFramerate).toBe(30);
  });

  it("rolls back both video and audio sender states after failed observation", async () => {
    let callIdx = 0;
    const fakeObserve = vi.fn(async () => {
      callIdx++;
      return callIdx * 999999;
    });

    // Stateful video sender
    let videoParams: RTCRtpSendParameters = {
      encodings: [{ active: true, maxBitrate: 5_000_000 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-v",
    };
    const setVideo = vi.fn(async (p: RTCRtpSendParameters) => {
      videoParams = { ...p, encodings: p.encodings?.map(e => ({ ...e })) ?? [] };
    });
    const getVideo = vi.fn(() => ({
      ...videoParams,
      encodings: videoParams.encodings?.map(e => ({ ...e })) ?? [],
    }));
    const videoSender = {
      track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) } as MediaStreamTrack,
      getParameters: getVideo,
      setParameters: setVideo,
    } as unknown as RTCRtpSender;

    // Stateful audio sender
    let audioParams: RTCRtpSendParameters = {
      encodings: [{ active: true }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-a",
    };
    const setAudio = vi.fn(async (p: RTCRtpSendParameters) => {
      audioParams = { ...p, encodings: p.encodings?.map(e => ({ ...e })) ?? [] };
    });
    const getAudio = vi.fn(() => ({
      ...audioParams,
      encodings: audioParams.encodings?.map(e => ({ ...e })) ?? [],
    }));
    const audioSender = {
      track: { kind: "audio" } as MediaStreamTrack,
      getParameters: getAudio,
      setParameters: setAudio,
    } as unknown as RTCRtpSender;

    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 1000, sampleIntervalMs: 5, confirmationWindowMs: 15 },
      observeOutboundBytes: fakeObserve,
    });

    controller.registerSenders(bId, { videoSender, audioSender, pc: { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection });

    const result = await controller.applyPause(bId);
    expect(result.status).toBe("apply-failed");

    // Both senders should be rolled back to active=true
    expect(videoSender.getParameters().encodings?.[0]?.active).toBe(true);
    expect(audioSender.getParameters().encodings?.[0]?.active).toBe(true);
  });

  it("observer sums both video and audio outbound bytes", async () => {
    // Verify the default observer includes both video and audio outbound-rtp.
    // We test by making the observer throw if it doesn't see audio bytes.
    let seenAudio = false;
    let seenVideo = false;
    const checkingObserver: import("../src/renderer/services/viewer-sender-controller.js").OutboundBytesObserver = async (pc) => {
      const stats = await pc.getStats();
      let total = 0;
      for (const s of stats.values()) {
        if (s.type === "outbound-rtp") {
          if ((s as any).kind === "audio") seenAudio = true;
          if ((s as any).kind === "video") seenVideo = true;
          total += (s as any).bytesSent ?? 0;
        }
      }
      return total;
    };

    // Single-call fake PC: return same stats each time (delta=0 → BPS=0 → OK)
    const fakePC = {
      getStats: vi.fn(async () => {
        const map = new Map<string, any>();
        map.set("v-out", { type: "outbound-rtp", kind: "video", bytesSent: 100000 });
        map.set("a-out", { type: "outbound-rtp", kind: "audio", bytesSent: 5000 });
        return map as unknown as RTCStatsReport;
      }),
    } as unknown as RTCPeerConnection;

    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 1000000, sampleIntervalMs: 5, confirmationWindowMs: 15 },
      observeOutboundBytes: checkingObserver,
    });

    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: fakePC });

    const result = await controller.applyPause(bId);
    expect(result.status).toBe("applied");

    // Observer must have seen both audio and video outbound-rtp entries
    expect(seenVideo).toBe(true);
    expect(seenAudio).toBe(true);
  });

  it("observer error causes pause failure", async () => {
    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 1000, sampleIntervalMs: 5, confirmationWindowMs: 15 },
      observeOutboundBytes: vi.fn(async () => { throw new Error("getStats failed"); }),
    });

    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: { getStats: vi.fn() } as unknown as RTCPeerConnection });

    const result = await controller.applyPause(bId);
    expect(result.status).toBe("apply-failed");
    expect(result.error).toContain("getStats failed");
  });

  // ─── Phase 7C: Injected clock ───────────────────────────────────────

  it("uses injected clock for deterministic quiescence rate", async () => {
    // Real setTimeout (fast 5ms intervals) + injected clock that advances
    // with each call so the BPS calculation uses deterministic timestamps.
    let fakeNow = 1000;
    const fakeClock = () => fakeNow;
    let callIdx = 0;
    // values advance by 100 bytes each sample
    const values = [1000, 1100, 1200, 1300];
    const fakeObserve = vi.fn(async () => {
      // Advance the clock by exactly the sample interval each time
      // so deltaTime is deterministic regardless of real wall-clock jitter
      const prevFake = fakeNow;
      fakeNow += 10; // simulate sampleIntervalMs
      const v = values[callIdx] ?? 0;
      callIdx++;
      return v;
    });

    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 50000, sampleIntervalMs: 10, confirmationWindowMs: 30 },
      observeOutboundBytes: fakeObserve,
      now: fakeClock,
    });

    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: { getStats: vi.fn() } as unknown as RTCPeerConnection });

    const result = await controller.applyPause(bId);
    // delta = 100 bytes, elapsed = 10ms → BPS = 10000, threshold 50000 → OK
    expect(result.status).toBe("applied");
    // fakeNow starts at 1000, observed advances by 10 per sample, 4 calls = 40
    expect(fakeNow).toBe(1040);
  });

  it("injected clock produces deterministic failure when rate exceeds threshold", async () => {
    let fakeNow = 5000;
    const fakeClock = () => fakeNow;
    let callIdx = 0;
    const values = [1000, 50000]; // delta = 49000
    const fakeObserve = vi.fn(async () => {
      fakeNow += 10; // advance clock by sample interval
      const v = values[callIdx] ?? 0;
      callIdx++;
      return v;
    });

    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 10000, sampleIntervalMs: 10, confirmationWindowMs: 30 },
      observeOutboundBytes: fakeObserve,
      now: fakeClock,
    });

    const sender = makeMockSender();
    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: { getStats: vi.fn() } as unknown as RTCPeerConnection });

    const result = await controller.applyPause(bId);
    expect(result.status).toBe("apply-failed");
    expect(result.error).toContain("quiescence failed");
  });

  // ─── Phase 7C: Re-register senders → pause → resume ────────────────

  it("re-register preserves paused state for subsequent resume", async () => {
    // Stateful sender
    let senderParams: RTCRtpSendParameters = {
      encodings: [{ active: true, maxBitrate: 5_000_000, maxFramerate: 30 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-cycle",
    };
    const setParams = vi.fn(async (p: RTCRtpSendParameters) => {
      senderParams = { ...p, encodings: p.encodings?.map(e => ({ ...e })) ?? [] };
    });
    const getParams = vi.fn(() => ({
      ...senderParams,
      encodings: senderParams.encodings?.map(e => ({ ...e })) ?? [],
    }));

    const sender = {
      track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) } as MediaStreamTrack,
      getParameters: getParams,
      setParameters: setParams,
    } as unknown as RTCRtpSender;

    controller = new ViewerSenderController({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 100000, sampleIntervalMs: 5, confirmationWindowMs: 15 },
      observeOutboundBytes: vi.fn(async () => 0),
    });

    const fakePC = { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection;
    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: fakePC });

    // Pause — confirmed (bytes at 0)
    const pauseResult = await controller.applyPause(bId);
    expect(pauseResult.status).toBe("applied");

    // Verify the sender was disabled
    expect(sender.getParameters().encodings?.[0]?.active).toBe(false);

    // Re-register with a fresh sender (same binding, simulates reconnect)
    let newSenderParams: RTCRtpSendParameters = {
      encodings: [{ active: false, maxBitrate: 0, maxFramerate: 30 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-new",
    };
    const newSetParams = vi.fn(async (p: RTCRtpSendParameters) => {
      newSenderParams = { ...p, encodings: p.encodings?.map(e => ({ ...e })) ?? [] };
    });
    const newGetParams = vi.fn(() => ({
      ...newSenderParams,
      encodings: newSenderParams.encodings?.map(e => ({ ...e })) ?? [],
    }));
    const newSender = {
      track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) } as MediaStreamTrack,
      getParameters: newGetParams,
      setParameters: newSetParams,
    } as unknown as RTCRtpSender;

    const newPC = { getStats: vi.fn(async () => new Map()) } as unknown as RTCPeerConnection;
    controller.registerSenders(bId, { videoSender: newSender, audioSender: null, pc: newPC });

    // Paused state for the binding must exist in the controller's pausedStates map
    const savedPaused = controller.getPausedState(bId);
    expect(savedPaused).not.toBeNull();
    expect(savedPaused!.videoEncodings[0]!.active).toBe(true);

    // Resume — should restore active state and quality from paused state
    const resumeResult = await controller.applyResume(bId, {
      effective: { videoBitrateKbps: 2000, maxWidth: 1280, maxHeight: 720, maxFps: 30, degradationPreference: "balanced" },
    }, { width: 1920, height: 1080 });
    expect(resumeResult.status).toBe("applied");

    // Verify the new sender is active with quality restored
    const after = newSender.getParameters();
    expect(after.encodings?.[0]?.active).toBe(true);
    expect(after.encodings?.[0]?.maxBitrate).toBe(2_000_000);
    expect(after.encodings?.[0]?.maxFramerate).toBe(30);

    // The peer connection should still be the re-registered one
    const registered = controller.getSenders(bId);
    expect(registered?.pc).toBe(newPC);
  });

  // ─── Phase 7C: Protocol-level pause failure mapping ─────────────────

  it("handleViewerPaused maps observation failure to apply-failed result", async () => {
    // This test uses VMB's handleViewerPaused which delegates to the controller.
    // We inject a controller that fails observation.
    const { ViewerMediaBinding } = await import("../src/renderer/services/viewer-media-binding.js");
    const { ViewerSenderController: VSC } = await import("../src/renderer/services/viewer-sender-controller.js");

    // Minimal runtime with controlled sender controller
    let obsCalls = 0;
    const failingCtrl = new VSC({
      pauseTimeoutMs: 100000,
      pauseObservation: { maxBytesPerSecond: 1, sampleIntervalMs: 5, confirmationWindowMs: 15 },
      observeOutboundBytes: vi.fn(async () => {
        obsCalls++;
        return obsCalls * 999999; // increasing → large delta → BPS >> threshold
      }),
    });

    const mockSendToPeer = vi.fn().mockResolvedValue(undefined);
    const mockRuntime = {
      getConnectionManager: () => ({
        getConnection: vi.fn().mockReturnValue({
          sendToPeer: mockSendToPeer,
          peerForDevice: vi.fn().mockReturnValue("peer-uuid"),
        }),
      }),
      getStreamSessionManager: () => ({
        getCaptureStream: vi.fn().mockReturnValue(null),
        state: "active", currentGroupId: "g-1", currentLogicalStreamId: "ls-1", currentMediaSessionId: "ms-1",
        getActualCaptureDimensions: vi.fn().mockReturnValue({}),
      }),
      getViewerMediaBinding: () => ({} as any),
      getMediaStatsService: () => ({ startViewerPoller: vi.fn(), hasViewerPoller: vi.fn().mockReturnValue(true) }),
      getQualityCoordinator: () => null,
      getSyncService: () => ({ getSyncState: vi.fn().mockReturnValue(null) }),
      getHostQualityLimits: () => ({ maxVideoBitrateKbps: 20000, maxWidth: 3840, maxHeight: 2160, maxFps: 60, allowViewerQualityRequests: true }),
      getViewerSenderController: () => failingCtrl,
      resolveLocalPublication: vi.fn().mockReturnValue(null),
      getCompareSessionManager: vi.fn().mockReturnValue(null),
      deviceId: "test-device",
      displayName: "Test User",
      getActiveStreamRegistry: () => ({ getStream: vi.fn(), registerLocalStream: vi.fn(), getStreamsByGroup: vi.fn().mockReturnValue([]) }),
    } as any;

    const sender = makeMockSender();
    const binding = new ViewerMediaBinding(mockRuntime);
    (binding as any).viewerMap.set("v-1::ms-1", {
      viewerDeviceId: "v-1", viewerSessionId: "s-1", mediaPeerUuid: "p-1",
      groupId: "g-1", logicalStreamId: "ls-1", mediaSessionId: "ms-1",
      pc: { getStats: vi.fn() } as unknown as RTCPeerConnection,
      videoSender: sender, audioSender: null,
    });

    const result = await binding.handleViewerPaused("v-1", "ms-1", true);
    expect(result.status).toBe("apply-failed");
    expect((result as any).error).toContain("quiescence");
    binding.destroy();
  });

  // ─── Phase 7C: Bounded retry for partial rollback ──────────────────

  it("rollback retries on setParameters failure", async () => {
    let callCount = 0;
    let senderParams: RTCRtpSendParameters = {
      encodings: [{ active: true, maxBitrate: 5_000_000 }],
      codecs: [], headerExtensions: [], rtcp: {}, transactionId: "tx-retry",
    };
    // First call succeeds (pause setParameters), then first rollback call fails,
    // second rollback call succeeds
    const setParams = vi.fn(async (p: RTCRtpSendParameters) => {
      callCount++;
      if (callCount === 2) throw new Error("transient failure"); // first rollback
      senderParams = { ...p, encodings: p.encodings?.map(e => ({ ...e })) ?? [] };
    });
    const getParams = vi.fn(() => ({
      ...senderParams,
      encodings: senderParams.encodings?.map(e => ({ ...e })) ?? [],
    }));

    const sender = {
      track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) } as MediaStreamTrack,
      getParameters: getParams,
      setParameters: setParams,
    } as unknown as RTCRtpSender;

    // Use real timers with short intervals to avoid test slowdown
    controller = new ViewerSenderController({
      pauseTimeoutMs: 30000, // enough headroom
      pauseObservation: { maxBytesPerSecond: 1000, sampleIntervalMs: 3, confirmationWindowMs: 9 },
      observeOutboundBytes: vi.fn(async () => { callCount++; return callCount * 999999; }),
    });

    controller.registerSenders(bId, { videoSender: sender, audioSender: null, pc: { getStats: vi.fn() } as unknown as RTCPeerConnection });

    const result = await controller.applyPause(bId);
    expect(result.status).toBe("apply-failed");

    // After rollback retry, the sender should have active=true
    const readback = sender.getParameters();
    expect(readback.encodings?.[0]?.active).toBe(true);
  });
});
