// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CompareVariantTrackPipeline } from "../src/renderer/services/compare-variant-track-pipeline.js";

// ─── DOM mocks ───────────────────────────────────────────────────────────────
function createMockVideoElement(): HTMLVideoElement {
  const listeners = new Map<string, Set<() => void>>();
  return {
    muted: false,
    playsInline: false,
    autoplay: false,
    style: { display: "" },
    srcObject: null,
    videoWidth: 1280,
    videoHeight: 720,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    addEventListener: vi.fn((event: string, cb: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    }),
    removeEventListener: vi.fn((event: string, cb: () => void) => {
      listeners.get(event)?.delete(cb);
    }),
    parentNode: document.body,
    remove: vi.fn(),
    _listeners: listeners,
  } as unknown as HTMLVideoElement;
}

function createMockCanvasElement(): HTMLCanvasElement & { _width: number; _height: number } {
  return {
    width: 854,
    height: 480,
    style: { display: "" },
    getContext: vi.fn(() => ({
      drawImage: vi.fn(),
      clearRect: vi.fn(),
    })),
    captureStream: vi.fn((_fps: number) => ({
      getVideoTracks: vi.fn(() => [createMockMediaStreamTrack()]),
      getTracks: vi.fn(() => [createMockMediaStreamTrack()]),
      getAudioTracks: vi.fn(() => []),
    })),
    parentNode: document.body,
    remove: vi.fn(),
    _width: 854,
    _height: 480,
  } as unknown as HTMLCanvasElement & { _width: number; _height: number };
}

function createMockMediaStreamTrack(): MediaStreamTrack {
  return {
    kind: "video",
    id: "track-" + Math.random().toString(36).slice(2, 8),
    enabled: true,
    readyState: "live",
    label: "test-output",
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function createMockSourceTrack(): MediaStreamTrack {
  return {
    kind: "video",
    id: "source-" + Math.random().toString(36).slice(2, 8),
    enabled: true,
    readyState: "live",
    label: "source-capture",
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
    getCapabilities: () => ({}),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  } as unknown as MediaStreamTrack;
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe("CompareVariantTrackPipeline", () => {
  let pipeline: CompareVariantTrackPipeline;
  let sourceTrack: MediaStreamTrack;

  beforeEach(() => {
    vi.useFakeTimers();

    // Mock document methods
    if (typeof document === "undefined") {
      (globalThis as any).document = {
        body: {
          appendChild: vi.fn(),
          removeChild: vi.fn(),
        },
        createElement: vi.fn((tag: string) => {
          if (tag === "video") return createMockVideoElement();
          if (tag === "canvas") return createMockCanvasElement();
          return {};
        }),
      } as unknown as Document;
    }

    // Mock requestAnimationFrame
    (globalThis as any).requestAnimationFrame = vi.fn((cb: () => void) => {
      return setTimeout(cb, 16);
    });
    (globalThis as any).cancelAnimationFrame = vi.fn((id: number) => {
      clearTimeout(id);
    });

    sourceTrack = createMockSourceTrack();
    pipeline = new CompareVariantTrackPipeline(
      { targetWidth: 854, targetHeight: 480, targetFps: 30 },
      "A",
    );
  });

  afterEach(() => {
    pipeline.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as any).document;
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
  });

  describe("construction", () => {
    it("starts in idle state", () => {
      expect(pipeline.state).toBe("idle");
    });

    it("stores settings and variant ID", () => {
      expect(pipeline.variantId).toBe("A");
      expect(pipeline.settings).toEqual({ targetWidth: 854, targetHeight: 480, targetFps: 30 });
    });

    it("getOutputTrack returns null before initialize", () => {
      expect(pipeline.getOutputTrack()).toBeNull();
    });
  });

  describe("initialize", () => {
    it("produces an output track from source", async () => {
      const outputTrack = await pipeline.initialize(sourceTrack);
      expect(outputTrack).toBeTruthy();
      expect(outputTrack.kind).toBe("video");
      expect(pipeline.state).toBe("active");
      expect(pipeline.getOutputTrack()).toBe(outputTrack);
    });

    it("throws if called when not idle", async () => {
      await pipeline.initialize(sourceTrack);
      await expect(pipeline.initialize(sourceTrack)).rejects.toThrow();
    });

    it("throws if pipeline is destroyed", async () => {
      pipeline.destroy();
      await expect(pipeline.initialize(sourceTrack)).rejects.toThrow();
    });
  });

  describe("source track isolation", () => {
    it("destroy does not stop the source track", async () => {
      await pipeline.initialize(sourceTrack);
      const sourceStop = vi.fn();
      sourceTrack.stop = sourceStop;

      pipeline.destroy();
      expect(sourceStop).not.toHaveBeenCalled();
    });

    it("initialize does not stop the source track", async () => {
      const sourceStop = vi.fn();
      sourceTrack.stop = sourceStop;

      await pipeline.initialize(sourceTrack);
      expect(sourceStop).not.toHaveBeenCalled();
    });
  });

  describe("replaceSource", () => {
    it("accepts a replacement source track", async () => {
      await pipeline.initialize(sourceTrack);
      // Advance timers to let the first render frame fire
      vi.advanceTimersByTime(100);
      const newTrack = createMockSourceTrack();
      const outputPromise = pipeline.replaceSource(newTrack);
      // Advance timers to let RAF fire for _waitForFrame
      vi.advanceTimersByTime(100);
      const output = await outputPromise;
      expect(output).toBe(pipeline.getOutputTrack());
    });

    it("throws if pipeline is not active", async () => {
      await expect(pipeline.replaceSource(createMockSourceTrack())).rejects.toThrow();
    });

    it("throws if pipeline is destroyed", async () => {
      pipeline.destroy();
      await expect(pipeline.replaceSource(createMockSourceTrack())).rejects.toThrow();
    });
  });

  describe("getReadback", () => {
    it("returns state info before initialization", () => {
      const rb = pipeline.getReadback();
      expect(rb.state).toBe("idle");
      expect(rb.variantId).toBe("A");
    });

    it("returns state info after initialization", async () => {
      await pipeline.initialize(sourceTrack);
      const rb = pipeline.getReadback();
      expect(rb.state).toBe("active");
      expect(rb.settings.targetWidth).toBe(854);
      expect(rb.settings.targetFps).toBe(30);
    });
  });

  describe("destroy", () => {
    it("transitions to idle state", () => {
      pipeline.destroy();
      expect(pipeline.state).toBe("idle");
    });

    it("is idempotent", () => {
      pipeline.destroy();
      pipeline.destroy();
      expect(pipeline.state).toBe("idle");
    });

    it("nullifies output track", async () => {
      await pipeline.initialize(sourceTrack);
      expect(pipeline.getOutputTrack()).toBeTruthy();
      pipeline.destroy();
      expect(pipeline.getOutputTrack()).toBeNull();
    });
  });
});
