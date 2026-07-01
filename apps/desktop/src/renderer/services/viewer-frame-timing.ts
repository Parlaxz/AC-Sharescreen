/**
 * viewer-frame-timing.ts
 *
 * Measures actual displayed/presented frame timing from the real viewer <video>
 * element using HTMLVideoElement.requestVideoFrameCallback() (rVFC) when
 * available, falling back to getVideoPlaybackQuality().framesDecoded deltas.
 *
 * Design:
 *   - rVFC path: self-triggering via the rVFC callback chain.
 *   - Fallback path: caller invokes pollDecodedFallback() on their own cadence
 *     (no long-running getStats poller).
 *   - On pause, reconnection, unmount, or a long callback gap (>200ms): resets
 *     the local timing baseline and emits a segment-start sample.
 *   - Displayed FPS and decoded FPS are kept distinct — never derived from
 *     configured/requested FPS.
 *
 * Integration with StreamMetricsService:
 *   const ft = new ViewerFrameTiming();
 *   ft.attach(videoElement);
 *   ft.onSample((sample) => { /* feed into StreamMetricsService *\/ });
 */

// ─── Local type declarations (avoid pulling DOM lib into test pipeline) ─────

/** Minimal shape of the rVFC metadata we consume. */
interface RvfcMetadata {
  readonly presentedFrames: number;
}

/** The rVFC callback shape. */
export type RvfcCallback = (now: DOMHighResTimeStamp, metadata: RvfcMetadata) => void;

/** Minimal VideoPlaybackQuality shape (Chrome extensions included). */
interface PlaybackQuality {
  readonly totalVideoFrames: number;
  readonly totalInterFrameDelay: number;
  readonly totalDecodeTime: number;
}

/** Minimal video-element shape we operate on. */
export interface VideoElementLike {
  requestVideoFrameCallback(callback: RvfcCallback): number;
  cancelVideoFrameCallback(handle: number): void;
  getVideoPlaybackQuality(): PlaybackQuality;
}

// ─── Public types ───────────────────────────────────────────────────────────

export interface FrameTimingSample {
  /** Monotonic timestamp (performance.now()) when this sample was produced. */
  readonly timestamp: number;

  /**
   * Displayed/presented FPS derived from rVFC callback intervals.
   * null when rVFC is unavailable or on segment start.
   */
  readonly displayedFps: number | null;

  /**
   * Interval in ms between the last two displayed-frame callbacks.
   * null on first callback or segment start.
   */
  readonly displayedFrameIntervalMs: number | null;

  /**
   * Rolling average of displayed-frame intervals over the current segment
   * window (last N frames). null when no interval data accumulated.
   */
  readonly averageDisplayedFrameIntervalMs: number | null;

  /**
   * Decoded FPS from getVideoPlaybackQuality framesDecoded deltas.
   * Available even when rVFC is not. null on first observation.
   */
  readonly decodedFps: number | null;

  /**
   * Average decode time per frame (ms) from
   * delta(totalDecodeTime) / delta(framesDecoded).
   * null until enough data accumulates.
   */
  readonly decodeTimeMs: number | null;

  /**
   * p50 (median) of displayed frame intervals in the rolling window.
   * null when fewer than 2 intervals accumulated.
   */
  readonly p50DisplayedIntervalMs: number | null;

  /**
   * p95 (95th percentile) of displayed frame intervals in the rolling window.
   * null when fewer than 2 intervals accumulated.
   */
  readonly p95DisplayedIntervalMs: number | null;

  /**
   * presentedFrames counter from rVFC metadata, if available.
   * null when rVFC is unavailable.
   */
  readonly presentedFrames: number | null;

  /**
   * True when this sample starts a new segment after a baseline reset
   * (attach, detach, explicit reset, long callback gap). The integrator
   * can use this to create a graph discontinuity.
   */
  readonly segmentStart: boolean;
}

export type FrameTimingCallback = (sample: Readonly<FrameTimingSample>) => void;

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of intervals kept in the rolling window for averaging. */
const WINDOW_SIZE = 60;

/**
 * Gap between rVFC callbacks exceeding this threshold (ms) triggers a new
 * segment. Covers pause, reconnection, track replacement, and tab backgrounding.
 */
const LONG_GAP_THRESHOLD_MS = 200;

// ─── Decoded fallback state ─────────────────────────────────────────────────

interface DecodedFallbackState {
  initialized: boolean;
  lastFramesDecoded: number;
  lastTotalInterFrameDelay: number;
  lastTotalDecodeTime: number;
}

function freshDecodedFallbackState(): DecodedFallbackState {
  return {
    initialized: false,
    lastFramesDecoded: 0,
    lastTotalInterFrameDelay: 0,
    lastTotalDecodeTime: 0,
  };
}

// ─── Service ────────────────────────────────────────────────────────────────

export class ViewerFrameTiming {
  private videoElement: VideoElementLike | null = null;
  private rvfcHandle: number | null = null;
  private rvfcActive = false;
  private lastRvfcTimestamp = 0;
  private lastPresentedFrames: number | null = null;
  private intervalWindow: number[] = [];
  private callbacks = new Set<FrameTimingCallback>();
  private segmentStart = true;
  private decodedState: DecodedFallbackState = freshDecodedFallbackState();

  // ─── Public API ─────────────────────────────────────────────────────────

  /** True when a video element is currently attached. */
  get isAttached(): boolean {
    return this.videoElement !== null;
  }

  /**
   * Attach to a video element-like object. Detaches any previously attached
   * element first. Starts the rVFC chain if supported; otherwise samples can
   * be obtained via pollDecodedFallback().
   *
   * Accepts null to detach without error.
   */
  attach(videoElement: VideoElementLike | null): void {
    if (videoElement === this.videoElement) return;

    this.detach();
    this.videoElement = videoElement;
    this.resetBaseline();

    if (videoElement) {
      this.tryStartRvfc();
    }
  }

  /**
   * Detach from the current video element. Cancels any pending rVFC.
   */
  detach(): void {
    this.stopRvfc();
    this.videoElement = null;
    this.segmentStart = true;
  }

  /**
   * Explicitly reset all timing baselines. The next sample (whether from rVFC
   * or pollDecodedFallback) will be a segmentStart. Does not detach the
   * video element. Useful on generation/session changes.
   */
  reset(): void {
    this.resetBaseline();
  }

  /**
   * Subscribe to frame-timing samples. The callback is invoked on every rVFC
   * callback (preferred path) or on every pollDecodedFallback() call
   * (fallback path).
   *
   * Returns an unsubscribe function.
   */
  onSample(cb: FrameTimingCallback): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  /**
   * Manually poll decoded stats from the attached video element.
   * Only needed when rVFC is not supported. Can be called on any timer
   * cadence the integrator chooses (e.g. every 1s).
   *
   * Safe to call even when rVFC is active — emits a sample with both
   * displayed and decoded data.
   */
  pollDecodedFallback(): void {
    if (!this.videoElement) return;
    this.emitDecodedFallbackSample();
  }

  // ─── rVFC management ───────────────────────────────────────────────────

  private tryStartRvfc(): void {
    if (!this.videoElement || this.rvfcActive) return;
    this.rvfcActive = true;
    this.scheduleRvfc();
  }

  private scheduleRvfc(): void {
    if (!this.videoElement || !this.rvfcActive) return;

    try {
      this.rvfcHandle = this.videoElement.requestVideoFrameCallback(
        (now: DOMHighResTimeStamp, metadata: RvfcMetadata) => {
          this.handleRvfc(now, metadata);
        },
      );
    } catch {
      // rVFC not supported — fallback to decoded stats (caller must poll)
      this.rvfcActive = false;
      this.rvfcHandle = null;
    }
  }

  private stopRvfc(): void {
    this.rvfcActive = false;
    if (this.rvfcHandle !== null && this.videoElement) {
      try {
        this.videoElement.cancelVideoFrameCallback(this.rvfcHandle);
      } catch {
        // Ignore cancel errors
      }
      this.rvfcHandle = null;
    }
  }

  // ─── rVFC callback handler ─────────────────────────────────────────────

  private handleRvfc(
    now: DOMHighResTimeStamp,
    metadata: RvfcMetadata,
  ): void {
    if (!this.videoElement || !this.rvfcActive) return;

    // Detect long gap → new segment
    const gap = this.lastRvfcTimestamp > 0
      ? now - this.lastRvfcTimestamp
      : 0;
    const isLongGap = gap > LONG_GAP_THRESHOLD_MS;
    const isSegmentStart = this.segmentStart || isLongGap;

    // Compute displayed frame interval
    const interval =
      this.lastRvfcTimestamp > 0 && !isSegmentStart
        ? now - this.lastRvfcTimestamp
        : null;

    // Update tracking
    if (isSegmentStart) {
      this.intervalWindow = [];
    }

    if (interval !== null) {
      this.intervalWindow.push(interval);
      if (this.intervalWindow.length > WINDOW_SIZE) {
        this.intervalWindow.shift();
      }
    }

    this.lastRvfcTimestamp = now;
    this.lastPresentedFrames = metadata.presentedFrames;
    this.segmentStart = false;

    // Build and emit the displayed-timing sample
    const sample = this.buildDisplayedSample(interval, metadata, isSegmentStart);
    this.emitSample(sample);

    // Schedule the next rVFC
    this.scheduleRvfc();
  }

  // ─── Sample construction ───────────────────────────────────────────────

  private buildDisplayedSample(
    interval: number | null,
    metadata: RvfcMetadata,
    segmentStart: boolean,
  ): FrameTimingSample {
    const window = this.intervalWindow;
    const displayedFps =
      interval !== null && interval > 0 ? 1000 / interval : null;

    // Rolling average
    let avgInterval: number | null = null;
    if (window.length > 0) {
      avgInterval =
        window.reduce((a, b) => a + b, 0) / window.length;
    }

    // Percentiles
    let p50: number | null = null;
    let p95: number | null = null;
    if (window.length >= 2) {
      const sorted = [...window].sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.5)];
      p95 = sorted[Math.floor(sorted.length * 0.95)];
    }

    return {
      timestamp: performance.now(),
      displayedFps,
      displayedFrameIntervalMs: interval,
      averageDisplayedFrameIntervalMs: avgInterval,
      decodedFps: null,
      decodeTimeMs: null,
      p50DisplayedIntervalMs: p50,
      p95DisplayedIntervalMs: p95,
      presentedFrames: metadata.presentedFrames,
      segmentStart,
    };
  }

  // ─── Decoded fallback ──────────────────────────────────────────────────

  private emitDecodedFallbackSample(): void {
    const el = this.videoElement;
    if (!el) return;

    let quality: PlaybackQuality;
    try {
      quality = el.getVideoPlaybackQuality();
    } catch {
      return;
    }

    const framesDecoded = quality.totalVideoFrames;
    const totalInterFrameDelay = quality.totalInterFrameDelay;
    const totalDecodeTime = quality.totalDecodeTime;

    if (!this.decodedState.initialized) {
      this.decodedState.lastFramesDecoded = framesDecoded;
      this.decodedState.lastTotalInterFrameDelay = totalInterFrameDelay;
      this.decodedState.lastTotalDecodeTime = totalDecodeTime;
      this.decodedState.initialized = true;

      // Emit initial sample with decoded baseline established
      this.emitSample(this.buildDecodedSample(null, null, null, this.segmentStart));
      this.segmentStart = false;
      return;
    }

    const deltaFrames = framesDecoded - this.decodedState.lastFramesDecoded;
    const deltaInterFrameDelay =
      totalInterFrameDelay - this.decodedState.lastTotalInterFrameDelay;
    const deltaDecodeTime =
      totalDecodeTime - this.decodedState.lastTotalDecodeTime;

    // Detect counter wrap
    const counterReset =
      deltaFrames < 0 || deltaInterFrameDelay < 0 || deltaDecodeTime < 0;

    if (counterReset) {
      this.decodedState.lastFramesDecoded = framesDecoded;
      this.decodedState.lastTotalInterFrameDelay = totalInterFrameDelay;
      this.decodedState.lastTotalDecodeTime = totalDecodeTime;

      this.emitSample(this.buildDecodedSample(null, null, null, true));
      return;
    }

    let decodedFps: number | null = null;
    let decodeTimeMs: number | null = null;

    if (deltaFrames > 0) {
      // decoded fps = deltaFrames / average inter-frame interval
      if (deltaInterFrameDelay > 0) {
        decodedFps = (deltaFrames / deltaInterFrameDelay) * 1000;
      }

      if (deltaDecodeTime > 0) {
        decodeTimeMs = deltaDecodeTime / deltaFrames;
      }
    }

    this.decodedState.lastFramesDecoded = framesDecoded;
    this.decodedState.lastTotalInterFrameDelay = totalInterFrameDelay;
    this.decodedState.lastTotalDecodeTime = totalDecodeTime;

    this.emitSample(
      this.buildDecodedSample(decodedFps, decodeTimeMs, framesDecoded, this.segmentStart),
    );
    this.segmentStart = false;
  }

  private buildDecodedSample(
    decodedFps: number | null,
    decodeTimeMs: number | null,
    framesDecoded: number | null,
    segmentStart: boolean,
  ): FrameTimingSample {
    return {
      timestamp: performance.now(),
      displayedFps: null,
      displayedFrameIntervalMs: null,
      averageDisplayedFrameIntervalMs: null,
      decodedFps,
      decodeTimeMs,
      p50DisplayedIntervalMs: null,
      p95DisplayedIntervalMs: null,
      presentedFrames: null,
      segmentStart,
    };
  }

  // ─── Emit ──────────────────────────────────────────────────────────────

  private emitSample(sample: FrameTimingSample): void {
    for (const cb of this.callbacks) {
      try {
        cb(sample);
      } catch {
        // Swallow subscriber errors
      }
    }
  }

  // ─── Baseline management ───────────────────────────────────────────────

  private resetBaseline(): void {
    this.lastRvfcTimestamp = 0;
    this.lastPresentedFrames = null;
    this.intervalWindow = [];
    this.decodedState = freshDecodedFallbackState();
    this.segmentStart = true;
  }
}
