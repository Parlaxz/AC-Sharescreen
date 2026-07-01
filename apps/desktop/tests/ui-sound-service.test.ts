// @vitest-environment happy-dom
/**
 * Tests for UiSoundService — viewer join/leave audio cues.
 *
 * Each test uses vi.isolateModulesAsync to get a fresh singleton
 * because UiSoundService is a module-level singleton (ESM cached).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mock AudioContext infrastructure ───────────────────────────────────────

let mockAudioContext: any = null;
let mockGainNode: any = null;
let mockBufferSource: any = null;
let mockDecodedBuffer: any = null;
let audioContextCtorSpy: any = null;

function createMockAudioContext() {
  mockGainNode = {
    connect: vi.fn(),
    gain: { value: 0.5 },
    disconnect: vi.fn(),
  };
  mockBufferSource = {
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    buffer: null,
  };
  mockDecodedBuffer = { duration: 2.0, numberOfChannels: 2, sampleRate: 48000 };
  mockAudioContext = {
    decodeAudioData: vi.fn().mockResolvedValue(mockDecodedBuffer),
    createGain: vi.fn().mockReturnValue(mockGainNode),
    createBufferSource: vi.fn().mockReturnValue(mockBufferSource),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    state: "running",
    destination: {},
  };
  audioContextCtorSpy = vi.fn(() => mockAudioContext);
  return mockAudioContext;
}

/** Force a fresh module import by resetting the ESM cache first */
async function importFresh() {
  vi.resetModules();
  return await import("../src/renderer/services/ui-sound-service.js");
}

// Store the real AudioContext before mocking
const RealAudioContext = globalThis.AudioContext;

beforeEach(() => {
  createMockAudioContext();
  (globalThis as any).AudioContext = audioContextCtorSpy;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  });
});

afterEach(() => {
  (globalThis as any).AudioContext = RealAudioContext;
  delete (globalThis as any).fetch;
  vi.restoreAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("UiSoundService", () => {
  it("is imported correctly", async () => {
    const { uiSoundService } = await importFresh();
    expect(uiSoundService).toBeDefined();
  });

  it("preload decodes both sound files", async () => {
    const { uiSoundService } = await importFresh();
    await uiSoundService.preload();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(mockAudioContext.decodeAudioData).toHaveBeenCalledTimes(2);
  });

  it("play creates a new AudioBufferSourceNode per playback", async () => {
    const { uiSoundService } = await importFresh();
    await uiSoundService.preload();
    vi.clearAllMocks();

    await uiSoundService.play("user-join");
    expect(mockAudioContext.createBufferSource).toHaveBeenCalledTimes(1);
    expect(mockBufferSource.start).toHaveBeenCalledTimes(1);

    await uiSoundService.play("user-leave");
    expect(mockAudioContext.createBufferSource).toHaveBeenCalledTimes(2);
    expect(mockBufferSource.start).toHaveBeenCalledTimes(2);
  });

  it("setEnabled controls whether sounds play", async () => {
    const { uiSoundService } = await importFresh();
    await uiSoundService.preload();
    vi.clearAllMocks();

    uiSoundService.setEnabled(false);
    await uiSoundService.play("user-join");
    expect(mockBufferSource.start).not.toHaveBeenCalled();
    expect(mockAudioContext.createBufferSource).not.toHaveBeenCalled();

    uiSoundService.setEnabled(true);
    await uiSoundService.play("user-leave");
    expect(mockBufferSource.start).toHaveBeenCalledTimes(1);
  });

  it("setVolume clamps between 0 and 1", async () => {
    const { uiSoundService } = await importFresh();
    // Ensure the context and gain node exist before testing clamping
    await uiSoundService.preload();

    uiSoundService.setVolume(-1);
    expect(mockGainNode.gain.value).toBe(0);

    uiSoundService.setVolume(2);
    expect(mockGainNode.gain.value).toBe(1);

    uiSoundService.setVolume(0.7);
    expect(mockGainNode.gain.value).toBe(0.7);
  });

  it("reuses one AudioContext", async () => {
    const { uiSoundService } = await importFresh();
    await uiSoundService.preload();
    expect(audioContextCtorSpy).toHaveBeenCalledTimes(1);
  });

  it("gracefully handles suspended AudioContext", async () => {
    mockAudioContext.state = "suspended";

    const { uiSoundService } = await importFresh();
    await uiSoundService.preload();
    vi.clearAllMocks();

    await uiSoundService.play("user-join");
    expect(mockAudioContext.resume).toHaveBeenCalled();
  });

  it("preload/decode failure does not interrupt flow", async () => {
    mockAudioContext.decodeAudioData = vi.fn().mockRejectedValue(new Error("decode failed"));

    const { uiSoundService } = await importFresh();
    await expect(uiSoundService.preload()).resolves.toBeUndefined();
    await expect(uiSoundService.play("user-join")).resolves.toBeUndefined();
  });

  it("prevents overlapping duplicate playback for same lifecycle event", async () => {
    const { uiSoundService } = await importFresh();
    await uiSoundService.preload();
    vi.clearAllMocks();

    await Promise.all([
      uiSoundService.play("user-join"),
      uiSoundService.play("user-join"),
    ]);

    // Should only create one buffer source for this lifecycle event
    expect(mockAudioContext.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it("destroy cleans up AudioContext", async () => {
    const { uiSoundService } = await importFresh();
    await uiSoundService.preload();

    await uiSoundService.destroy();
    expect(mockAudioContext.close).toHaveBeenCalledTimes(1);
  });

  it("never throws into stream lifecycle", async () => {
    const { uiSoundService } = await importFresh();

    await expect(uiSoundService.play("user-join")).resolves.toBeUndefined();
    await expect(uiSoundService.play("user-leave")).resolves.toBeUndefined();
    await uiSoundService.destroy();
    await expect(uiSoundService.destroy()).resolves.toBeUndefined();
  });

  it("play is independent from stream audio controls", async () => {
    const { uiSoundService } = await importFresh();
    const serviceProto = Object.getPrototypeOf(uiSoundService);
    const methods = Object.getOwnPropertyNames(serviceProto)
      .filter((k) => typeof (uiSoundService as any)[k] === "function");

    const methodStrings = methods.map((m) => (uiSoundService as any)[m].toString().toLowerCase()).join(" ");
    expect(methodStrings).not.toContain("video");
    expect(methodStrings).not.toContain("mediastream");
    expect(methodStrings).not.toContain("rtcpeerconnection");
  });
});
