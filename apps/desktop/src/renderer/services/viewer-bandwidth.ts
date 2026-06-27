export interface BandwidthTracker {
  lastObservedBytes: number | null;
  lastSampleAtMs: number | null;
  totalBytesReceived: number;
  currentBytesPerSecond: number;
}

export function createBandwidthTracker(): BandwidthTracker {
  return {
    lastObservedBytes: null,
    lastSampleAtMs: null,
    totalBytesReceived: 0,
    currentBytesPerSecond: 0,
  };
}

export function updateBandwidthTracker(
  tracker: BandwidthTracker,
  observedBytes: number,
  sampleAtMs: number,
): BandwidthTracker {
  const safeObservedBytes = Number.isFinite(observedBytes) && observedBytes >= 0
    ? observedBytes
    : 0;

  if (tracker.lastObservedBytes === null || tracker.lastSampleAtMs === null) {
    return {
      lastObservedBytes: safeObservedBytes,
      lastSampleAtMs: sampleAtMs,
      totalBytesReceived: safeObservedBytes,
      currentBytesPerSecond: 0,
    };
  }

  const elapsedMs = sampleAtMs - tracker.lastSampleAtMs;
  if (elapsedMs <= 0) {
    return tracker;
  }

  const deltaBytes = safeObservedBytes >= tracker.lastObservedBytes
    ? safeObservedBytes - tracker.lastObservedBytes
    : safeObservedBytes;

  const elapsedSeconds = elapsedMs / 1000;

  return {
    lastObservedBytes: safeObservedBytes,
    lastSampleAtMs: sampleAtMs,
    totalBytesReceived: tracker.totalBytesReceived + deltaBytes,
    currentBytesPerSecond: elapsedSeconds > 0
      ? Math.round(deltaBytes / elapsedSeconds)
      : 0,
  };
}
