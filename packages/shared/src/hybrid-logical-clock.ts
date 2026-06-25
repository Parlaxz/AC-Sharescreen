import { z } from "zod";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface HybridTimestamp {
  wallTimeMs: number;
  counter: number;
  nodeId: string;
}

export interface HybridClock {
  wallTimeMs: number;
  counter: number;
  nodeId: string;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

export const HybridTimestampSchema = z.object({
  wallTimeMs: z.number().int().nonnegative(),
  counter: z.number().int().nonnegative(),
  nodeId: z.string().min(1).max(128),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Create a new HybridClock for the given nodeId.
 * Optionally seed the clock from a persisted HybridTimestamp (the last known stamp).
 */
export function createHybridClock(
  nodeId: string,
  persistedStamp?: HybridTimestamp,
): HybridClock {
  if (persistedStamp) {
    return {
      wallTimeMs: persistedStamp.wallTimeMs,
      counter: persistedStamp.counter,
      nodeId,
    };
  }
  return {
    wallTimeMs: Date.now(),
    counter: 0,
    nodeId,
  };
}

/**
 * Generate a new local timestamp that is strictly greater than any previously
 * generated local or observed remote timestamp.
 */
export function tickLocal(clock: HybridClock, now?: number): HybridTimestamp {
  const physical = now ?? Date.now();
  const newWall = Math.max(clock.wallTimeMs, physical);
  const newCounter = clock.counter + 1;

  clock.wallTimeMs = newWall;
  clock.counter = newCounter;

  return { wallTimeMs: newWall, counter: newCounter, nodeId: clock.nodeId };
}

/**
 * Incorporate a remote timestamp into the clock, returning a new timestamp that
 * is greater than both the last local tick and the remote timestamp.
 */
export function mergeRemote(
  clock: HybridClock,
  remoteStamp: HybridTimestamp,
  now?: number,
): HybridTimestamp {
  const physical = now ?? Date.now();
  const maxWall = Math.max(clock.wallTimeMs, remoteStamp.wallTimeMs, physical);

  let newCounter: number;

  if (maxWall === clock.wallTimeMs && maxWall === remoteStamp.wallTimeMs) {
    // Both timestamps (local and remote) share the same wall time — take max counter + 1
    newCounter = Math.max(clock.counter, remoteStamp.counter) + 1;
  } else if (maxWall === clock.wallTimeMs) {
    // Local wall time is the max — increment local counter
    newCounter = clock.counter + 1;
  } else if (maxWall === remoteStamp.wallTimeMs) {
    // Remote wall time is the max — use remote counter + 1
    newCounter = remoteStamp.counter + 1;
  } else {
    // Physical time is the max — start counter at 0
    newCounter = 0;
  }

  clock.wallTimeMs = maxWall;
  clock.counter = newCounter;

  return { wallTimeMs: maxWall, counter: newCounter, nodeId: clock.nodeId };
}

/**
 * Compare two HybridTimestamps.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Order: wallTimeMs → counter → nodeId (lexicographic).
 */
export function compareHybridTimestamp(
  a: HybridTimestamp,
  b: HybridTimestamp,
): number {
  if (a.wallTimeMs !== b.wallTimeMs) {
    return a.wallTimeMs < b.wallTimeMs ? -1 : 1;
  }
  if (a.counter !== b.counter) {
    return a.counter < b.counter ? -1 : 1;
  }
  if (a.nodeId !== b.nodeId) {
    return a.nodeId < b.nodeId ? -1 : 1;
  }
  return 0;
}

/**
 * Return the maximum of two HybridTimestamps (or null/undefined).
 * If one is null/undefined, returns the other.
 * If both are null/undefined, returns a zero-value timestamp (dangerous — prefer
 * handling nulls at the call site).
 */
export function maxHybridTimestamp(
  a: HybridTimestamp | null | undefined,
  b: HybridTimestamp | null | undefined,
): HybridTimestamp {
  if (a == null && b == null) {
    return { wallTimeMs: 0, counter: 0, nodeId: "" };
  }
  if (a == null) return b!;
  if (b == null) return a;
  return compareHybridTimestamp(a, b) >= 0 ? a : b;
}
