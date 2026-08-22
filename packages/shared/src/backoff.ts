/**
 * Bounded exponential backoff utility.
 *
 * Pure state machine — no timers, no scheduling.  Returns the next delay
 * in milliseconds on each `next()` call and resets on `reset()`.
 *
 * Suitable for connection-retry delays, polling intervals, or any algorithm
 * that needs geometrically increasing delay capped at a maximum.
 *
 * @example
 * ```ts
 * const b = createBackoff({ minMs: 100, maxMs: 10_000, factor: 2 });
 * b.next(); //  100
 * b.next(); //  200
 * b.next(); //  400
 * b.next(); //  800
 * b.next(); // 1600
 * // ...
 * b.reset(); // returns to min
 * ```
 */

// ─── Options ─────────────────────────────────────────────────────────────────

export interface BackoffOptions {
  /**
   * Initial delay in ms (also the value returned on the first `next()` call
   * and after `reset()`).
   *
   * @default 100
   */
  minMs?: number;

  /**
   * Maximum delay in ms.  The backoff will never exceed this value.
   *
   * @default 30_000
   */
  maxMs?: number;

  /**
   * Multiplicative factor applied after each step.
   *
   * @default 2
   */
  factor?: number;

  /**
   * Optional jitter function or fixed fraction of the raw delay.
   *
   * - A **number** (0‑1) applies uniform random jitter of ± that fraction.
   *   e.g. `0.2` → delay is randomly adjusted by ±20 %.
   * - A **function** `(raw: number) => number` receives the raw (pre-jitter)
   *   delay and must return the final delay.  Use this for deterministic
   *   jitter in tests or custom distributions.
   *
   * When `jitter` is omitted or `undefined` no jitter is applied.
   *
   * @default undefined
   */
  jitter?: number | ((raw: number) => number);
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface Backoff {
  /** Return the next delay in milliseconds. */
  next(): number;

  /** Reset the backoff to its initial state (next call returns `minMs`). */
  reset(): void;

  /** The current attempt count (0 after reset, incremented by each `next()`). */
  readonly attempt: number;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createBackoff(opts?: BackoffOptions): Backoff {
  const minMs = opts?.minMs ?? 100;
  const maxMs = opts?.maxMs ?? 30_000;
  const factor = opts?.factor ?? 2;
  const jitter = opts?.jitter;

  let current = minMs;
  let attempt = 0;

  /** Apply jitter config to a raw delay. */
  function applyJitter(raw: number): number {
    if (jitter === undefined) return raw;

    if (typeof jitter === "number") {
      // Fraction-based uniform jitter: raw ± (raw * jitter)
      const range = raw * Math.min(jitter, 1);
      return raw - range + Math.random() * range * 2;
    }

    // Custom function
    return jitter(raw);
  }

  const backoff: Backoff = {
    get attempt(): number {
      return attempt;
    },

    next(): number {
      const raw = Math.min(current, maxMs);
      const delayed = applyJitter(raw);

      // Advance for the next call
      const nextVal = current * factor;
      if (nextVal > maxMs) {
        current = maxMs;
      } else if (nextVal < minMs) {
        // Shouldn't happen with factor >= 1, but guard against degenerate config
        current = minMs;
      } else {
        current = nextVal;
      }

      attempt++;

      return Math.round(delayed);
    },

    reset(): void {
      current = minMs;
      attempt = 0;
    },
  };

  return backoff;
}
