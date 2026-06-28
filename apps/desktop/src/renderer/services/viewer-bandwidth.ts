export interface BandwidthTracker {
  lastCumulativeBytes: number | null;
  lastSampleAtMs: number | null;
  lastSsrc: number | null;
  totalBytes: number;
  currentBitsPerSecond: number;
  hasBaseline: boolean;
  paused: boolean;
}

export function createBandwidthTracker(): BandwidthTracker {
  return {
    lastCumulativeBytes: null,
    lastSampleAtMs: null,
    lastSsrc: null,
    totalBytes: 0,
    currentBitsPerSecond: 0,
    hasBaseline: false,
    paused: false,
  };
}

export function updateBandwidthTracker(
  tracker: BandwidthTracker,
  observedBytes: number,
  sampleAtMs: number,
  ssrc: number | null,
): BandwidthTracker {
  const safeObservedBytes = Number.isFinite(observedBytes) && observedBytes >= 0
    ? observedBytes
    : 0;

  // ── First call: establish baseline, don't count pre-observation bytes ──
  if (!tracker.hasBaseline) {
    return {
      lastCumulativeBytes: safeObservedBytes,
      lastSampleAtMs: sampleAtMs,
      lastSsrc: ssrc,
      totalBytes: 0,
      currentBitsPerSecond: 0,
      hasBaseline: true,
      paused: tracker.paused,
    };
  }

  // ── Paused: keep baseline current but don't accumulate ──
  if (tracker.paused) {
    return {
      ...tracker,
      lastCumulativeBytes: safeObservedBytes,
      lastSampleAtMs: sampleAtMs,
      lastSsrc: ssrc,
      currentBitsPerSecond: 0,
    };
  }

  const lastBytes = tracker.lastCumulativeBytes!;
  const lastMs = tracker.lastSampleAtMs!;

  // ── SSRC changed — new RTP stream, reset baseline ──
  if (tracker.lastSsrc !== null && ssrc !== null && ssrc !== tracker.lastSsrc) {
    return {
      ...tracker,
      lastCumulativeBytes: safeObservedBytes,
      lastSampleAtMs: sampleAtMs,
      lastSsrc: ssrc,
      currentBitsPerSecond: 0,
    };
  }

  const elapsedMs = sampleAtMs - lastMs;
  if (elapsedMs <= 0) {
    return {
      ...tracker,
      lastSsrc: ssrc,
    };
  }

  // ── Counter reset (decreased): new baseline, no delta ──
  if (safeObservedBytes < lastBytes) {
    return {
      ...tracker,
      lastCumulativeBytes: safeObservedBytes,
      lastSampleAtMs: sampleAtMs,
      lastSsrc: ssrc,
      currentBitsPerSecond: 0,
    };
  }

  // ── Normal: compute delta, multiply by 8 for bits ──
  const deltaBytes = safeObservedBytes - lastBytes;
  const elapsedSeconds = elapsedMs / 1000;

  return {
    ...tracker,
    lastCumulativeBytes: safeObservedBytes,
    lastSampleAtMs: sampleAtMs,
    lastSsrc: ssrc,
    totalBytes: tracker.totalBytes + deltaBytes,
    currentBitsPerSecond: Math.round(deltaBytes * 8 / elapsedSeconds),
  };
}
