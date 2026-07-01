import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  ViewerFrameTiming,
  type FrameTimingSample,
  type VideoElementLike,
  type RvfcCallback,
} from "./viewer-frame-timing.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockVideoElement(): VideoElementLike & {
  __fireRvfc: (now: number, metadata: { presentedFrames: number }) => void;
} {
  // The real browser fires exactly ONE rVFC callback per frame — the one
  // that was scheduled by the previous requestVideoFrameCallback().  Our mock
  // simulates this by keeping a single "pending" callback slot.  When fired,
  // the service schedules the next one via handleRvfc → scheduleRvfc →
  // requestVideoFrameCallback, which becomes the new pending callback.
  let pendingCallback: RvfcCallback | null = null;
  let currentHandle = 0;
  let cancelled = false;

  const el: VideoElementLike & {
    __fireRvfc: (now: number, metadata: { presentedFrames: number }) => void;
  } = {
    requestVideoFrameCallback: vi.fn((cb: RvfcCallback): number => {
      pendingCallback = cb;
      currentHandle++;
      cancelled = false;
      return currentHandle;
    }),
    cancelVideoFrameCallback: vi.fn((_handle: number): void => {
      pendingCallback = null;
      cancelled = true;
    }),
    getVideoPlaybackQuality: vi.fn(() => ({
      totalVideoFrames: 0,
      totalInterFrameDelay: 0,
      totalDecodeTime: 0,
    })),

    __fireRvfc(now: number, metadata: { presentedFrames: number }): void {
      const cb = pendingCallback;
      // Simulate real browser: after firing, the slot is consumed until
      // the next requestVideoFrameCallback call (which happens inside
      // the service's handleRvfc → scheduleRvfc).
      pendingCallback = null;
      if (cb && !cancelled) {
        (cb as Function)(now, metadata);
      }
    },
  };

  return el;
}

function collectSamples(
  timing: ViewerFrameTiming,
  count: number,
): FrameTimingSample[] {
  const samples: FrameTimingSample[] = [];
  const unsub = timing.onSample((s) => {
    samples.push(s);
    if (samples.length >= count) unsub();
  });
  return samples;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ViewerFrameTiming", () => {
  let timing: ViewerFrameTiming;

  beforeEach(() => {
    timing = new ViewerFrameTiming();
  });

  afterEach(() => {
    timing.detach();
  });

  // ─── Construction ───────────────────────────────────────────────────────

  it("starts detached with no pending work", () => {
    expect(timing.isAttached).toBe(false);
  });

  // ─── rVFC path: basic frame timing ──────────────────────────────────────

  it("produces displayed fps from callback intervals", () => {
    const video = createMockVideoElement();
    const collected = collectSamples(timing, 5);

    timing.attach(video);

    // Simulate 5 callbacks at ~16.67ms intervals (~60fps).
    // Each fire triggers the service's handleRvfc, which schedules
    // the next rVFC (the mock replaces the pending callback slot).
    for (let i = 1; i <= 5; i++) {
      video.__fireRvfc(i * 16.67, { presentedFrames: i });
    }

    expect(collected).toHaveLength(5);

    // First sample is segmentStart because it's the first attach
    expect(collected[0].segmentStart).toBe(true);
    // First sample has no interval (no prior callback)
    expect(collected[0].displayedFrameIntervalMs).toBeNull();
    expect(collected[0].displayedFps).toBeNull();

    // Subsequent samples should have ~60fps
    for (let i = 1; i < collected.length; i++) {
      expect(collected[i].displayedFps).toBeCloseTo(60, -1);
      expect(collected[i].displayedFrameIntervalMs).toBeCloseTo(16.67, -1);
      expect(collected[i].segmentStart).toBe(false);
    }

    // Average should be ~16.67ms
    expect(
      collected[collected.length - 1].averageDisplayedFrameIntervalMs,
    ).toBeCloseTo(16.67, -1);
  });

  it("exposes presentedFrames counter from rVFC metadata", () => {
    const video = createMockVideoElement();
    const collected = collectSamples(timing, 3);

    timing.attach(video);

    video.__fireRvfc(16.67, { presentedFrames: 100 });
    video.__fireRvfc(33.33, { presentedFrames: 101 });
    video.__fireRvfc(50.0, { presentedFrames: 102 });

    expect(collected[0].presentedFrames).toBe(100);
    expect(collected[1].presentedFrames).toBe(101);
    expect(collected[2].presentedFrames).toBe(102);
  });

  it("computes rolling p50 and p95 from interval window", () => {
    const video = createMockVideoElement();
    const collected = collectSamples(timing, 62);

    timing.attach(video);

    // Fire 62 callbacks at uniform intervals so we get a full window
    for (let i = 1; i <= 62; i++) {
      video.__fireRvfc(i * 16.67, { presentedFrames: i });
    }

    const last = collected[collected.length - 1];
    // With uniform 16.67ms intervals, p50 and p95 should be ~16.67
    expect(last.p50DisplayedIntervalMs).toBeCloseTo(16.67, -1);
    expect(last.p95DisplayedIntervalMs).toBeCloseTo(16.67, -1);

    // First sample has no window, p50/p95 should be null
    expect(collected[0].p50DisplayedIntervalMs).toBeNull();
    expect(collected[0].p95DisplayedIntervalMs).toBeNull();

    // Second sample has only 1 interval, p50/p95 should still be null (< 2)
    expect(collected[1].p50DisplayedIntervalMs).toBeNull();
    expect(collected[1].p95DisplayedIntervalMs).toBeNull();
  });

  // ─── Segment / baseline reset ──────────────────────────────────────────

  it("resets timing baseline on detach and reattach", () => {
    const video = createMockVideoElement();
    const collected = collectSamples(timing, 4);

    timing.attach(video);

    // Two frames
    video.__fireRvfc(16.67, { presentedFrames: 1 });
    video.__fireRvfc(33.33, { presentedFrames: 2 });

    expect(collected[0].segmentStart).toBe(true);
    expect(collected[1].segmentStart).toBe(false);

    // Detach and reattach
    timing.detach();
    timing.attach(video);

    // Fire another frame
    video.__fireRvfc(50.0, { presentedFrames: 3 });
    video.__fireRvfc(66.67, { presentedFrames: 4 });

    // The first sample after reattach should be a segment start
    expect(collected[2].segmentStart).toBe(true);
    expect(collected[2].displayedFrameIntervalMs).toBeNull(); // no prior reference

    // Second sample after reattach uses interval from reattached baseline
    expect(collected[3].segmentStart).toBe(false);
    expect(collected[3].displayedFrameIntervalMs).toBeCloseTo(16.67, -1);

    // Average only uses the new segment's intervals
    expect(collected[3].averageDisplayedFrameIntervalMs).toBeCloseTo(16.67, -1);
  });

  it("detects long gaps and creates new segment without spikes", () => {
    const video = createMockVideoElement();
    const collected = collectSamples(timing, 5);

    timing.attach(video);

    // Normal frames
    video.__fireRvfc(16.67, { presentedFrames: 1 });
    video.__fireRvfc(33.33, { presentedFrames: 2 });

    // Long gap (pause/reconnect) — 5 seconds
    video.__fireRvfc(5033.33, { presentedFrames: 3 });
    // After long gap
    video.__fireRvfc(5050.0, { presentedFrames: 4 });
    video.__fireRvfc(5066.67, { presentedFrames: 5 });

    // The sample right after the long gap is a new segment start
    expect(collected[2].segmentStart).toBe(true);
    // Its interval should be null (baseline reset), not the huge 5s gap
    expect(collected[2].displayedFrameIntervalMs).toBeNull();
    expect(collected[2].displayedFps).toBeNull();

    // Next frame should have normal timing, not affected by the gap
    expect(collected[3].segmentStart).toBe(false);
    expect(collected[3].displayedFrameIntervalMs).toBeCloseTo(16.67, -1);
    expect(collected[3].displayedFps).toBeCloseTo(60, -1);

    // Average only includes post-gap intervals
    expect(collected[4].averageDisplayedFrameIntervalMs).toBeCloseTo(16.67, -1);
  });

  it("cancels pending rVFC on detach", () => {
    const video = createMockVideoElement();
    timing.attach(video);

    // After attach, rVFC was requested
    expect(
      (video.requestVideoFrameCallback as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBeGreaterThan(0);

    // Detach should cancel
    timing.detach();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
  });

  it("cancels pending rVFC on re-attach with a new element", () => {
    const videoA = createMockVideoElement();
    const videoB = createMockVideoElement();
    timing.attach(videoA);
    const cancelCallsBefore = (
      videoA.cancelVideoFrameCallback as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    // Re-attach with a different element should cancel old and request new
    timing.attach(videoB);
    expect(
      (videoA.cancelVideoFrameCallback as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBeGreaterThan(cancelCallsBefore);
  });

  it("flushes baseline on explicit reset()", () => {
    const video = createMockVideoElement();
    const collected = collectSamples(timing, 4);

    timing.attach(video);

    video.__fireRvfc(16.67, { presentedFrames: 1 });
    video.__fireRvfc(33.33, { presentedFrames: 2 });

    timing.reset();

    video.__fireRvfc(50.0, { presentedFrames: 3 });
    video.__fireRvfc(66.67, { presentedFrames: 4 });

    // The first sample after reset should be a segment start
    expect(collected[2].segmentStart).toBe(true);
    expect(collected[2].displayedFrameIntervalMs).toBeNull();
  });

  // ─── Null video element ─────────────────────────────────────────────────

  it("handles null video element gracefully", () => {
    timing.attach(null);
    expect(timing.isAttached).toBe(false);
  });

  it("handles null video on re-attach without error", () => {
    const video = createMockVideoElement();
    timing.attach(video);
    timing.attach(null);
    expect(timing.isAttached).toBe(false);
  });

  // ─── Decoded-stat fallback ─────────────────────────────────────────────

  it("emits decoded fallback sample when rVFC is not supported", () => {
    const video = createMockVideoElement();
    (video.requestVideoFrameCallback as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error("not supported");
      },
    );

    const collected: FrameTimingSample[] = [];
    timing.onSample((s) => collected.push(s));
    timing.attach(video);

    // Fallback requires explicit pollDecodedFallback call
    expect(collected).toHaveLength(0);

    // Now poll
    timing.pollDecodedFallback();

    expect(collected).toHaveLength(1);
    // rVFC not available → displayedFps is null
    expect(collected[0].displayedFps).toBeNull();
    expect(collected[0].displayedFrameIntervalMs).toBeNull();
    // decodedFps should be null on first sample (no delta)
    expect(collected[0].decodedFps).toBeNull();
    expect(collected[0].decodeTimeMs).toBeNull();
    expect(collected[0].segmentStart).toBe(true);
  });

  it("computes decoded fps from framesDecoded deltas on fallback", () => {
    const video = createMockVideoElement();
    (video.requestVideoFrameCallback as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error("not supported");
      },
    );

    const collected: FrameTimingSample[] = [];
    timing.onSample((s) => collected.push(s));
    timing.attach(video);

    // First poll establishes baseline — no delta yet
    timing.pollDecodedFallback();
    expect(collected).toHaveLength(1);
    expect(collected[0].decodedFps).toBeNull(); // baseline, no delta
    expect(collected[0].segmentStart).toBe(true);
    collected.length = 0;

    // Update playback quality with meaningful data
    (video.getVideoPlaybackQuality as ReturnType<typeof vi.fn>).mockReturnValue({
      totalVideoFrames: 60,
      totalInterFrameDelay: 1000,
      totalDecodeTime: 500,
    });

    // Second poll: delta frames=60, delta inter-frame delay=1000ms → 60fps
    timing.pollDecodedFallback();
    expect(collected).toHaveLength(1);
    const s = collected[0];
    expect(s.segmentStart).toBe(false);
    // decoded fps = (60 / 1000) * 1000 = 60
    expect(s.decodedFps).toBeCloseTo(60, 0);
    // decode time = 500 / 60 ≈ 8.33ms
    expect(s.decodeTimeMs).toBeCloseTo(8.33, 0);
    // displayed fields are null in fallback mode
    expect(s.displayedFps).toBeNull();
    expect(s.displayedFrameIntervalMs).toBeNull();
  });

  it("does not crash when getVideoPlaybackQuality is missing", () => {
    const video = createMockVideoElement() as any;
    (video.requestVideoFrameCallback as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error("not supported");
      },
    );
    delete video.getVideoPlaybackQuality;

    timing.attach(video);
    expect(() => timing.pollDecodedFallback()).not.toThrow();
  });

  // ─── Subscription ──────────────────────────────────────────────────────

  it("unsubscribe removes callback", () => {
    const video = createMockVideoElement();
    const spy = vi.fn();
    const unsub = timing.onSample(spy);
    unsub();
    timing.attach(video);
    video.__fireRvfc(16.67, { presentedFrames: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  // ─── Displayed timing preferred ────────────────────────────────────────

  it("does not derive displayed fps from 1000/FPS formula", () => {
    // This test verifies that displayedFps comes from actual callback
    // intervals, not by deriving from a configured/requested rate.
    const video = createMockVideoElement();
    const collected = collectSamples(timing, 3);

    timing.attach(video);

    // Fire callbacks at varying intervals simulating a variable-rate stream
    video.__fireRvfc(10, { presentedFrames: 1 }); // first callback
    video.__fireRvfc(30, { presentedFrames: 2 }); // 20ms → 50fps
    video.__fireRvfc(70, { presentedFrames: 3 }); // 40ms → 25fps

    // The samples should measure the actual callback intervals
    // Sample 0 has no interval (first callback)
    expect(collected[0].displayedFrameIntervalMs).toBeNull();

    // Sample 1: interval = 20ms → 50fps
    expect(collected[1].displayedFrameIntervalMs).toBe(20);
    expect(collected[1].displayedFps).toBeCloseTo(50, 0);

    // Sample 2: interval = 40ms → 25fps
    expect(collected[2].displayedFrameIntervalMs).toBe(40);
    expect(collected[2].displayedFps).toBeCloseTo(25, 0);

    // The values should match actual measured intervals, not computed from anything else
    expect(collected[2].displayedFps).not.toBe(60); // not assuming 60fps
    expect(collected[2].displayedFps).not.toBe(30); // not assuming 30fps
  });
});
