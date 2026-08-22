import { describe, it, expect } from "vitest";
import {
  createBackoff,
} from "@screenlink/shared";

describe("createBackoff", () => {
  // ─── Defaults ─────────────────────────────────────────────────────────

  it("uses default options when none provided", () => {
    const b = createBackoff();
    expect(b.attempt).toBe(0);
    expect(b.next()).toBe(100);  // default minMs
  });

  it("uses default min/max/factor when only one option set", () => {
    const b = createBackoff({ minMs: 500 });
    expect(b.next()).toBe(500);
    // default factor=2 → second call 1000, then 2000, etc.
    expect(b.next()).toBe(1000);
    expect(b.next()).toBe(2000);
  });

  // ─── Basic sequence ────────────────────────────────────────────────────

  it("produces geometrically increasing delays", () => {
    const b = createBackoff({ minMs: 100, maxMs: 10_000, factor: 2, jitter: undefined });
    expect(b.next()).toBe(100);
    expect(b.next()).toBe(200);
    expect(b.next()).toBe(400);
    expect(b.next()).toBe(800);
    expect(b.next()).toBe(1600);
    expect(b.next()).toBe(3200);
    expect(b.next()).toBe(6400);
    // Would be 12800, but clamped to maxMs=10000
    expect(b.next()).toBe(10_000);
    expect(b.next()).toBe(10_000); // stays at max
  });

  it("respects custom factor", () => {
    const b = createBackoff({ minMs: 50, maxMs: 10_000, factor: 3, jitter: undefined });
    expect(b.next()).toBe(50);
    expect(b.next()).toBe(150);
    expect(b.next()).toBe(450);
    expect(b.next()).toBe(1350);
  });

  it("never exceeds maxMs", () => {
    const b = createBackoff({ minMs: 1000, maxMs: 3000, factor: 4, jitter: undefined });
    expect(b.next()).toBe(1000);
    expect(b.next()).toBe(3000); // 4000 clamped
    expect(b.next()).toBe(3000); // stays at max
  });

  it("returns at least minMs", () => {
    const b = createBackoff({ minMs: 200, maxMs: 500, factor: 0.5, jitter: undefined });
    // factor < 1 is degenerate (would shrink), but the guard keeps minMs
    expect(b.next()).toBe(200);
    // next raw would be 200*0.5=100, but guard clamps to minMs=200
    expect(b.next()).toBe(200);
  });

  // ─── Reset ─────────────────────────────────────────────────────────────

  it("reset() returns to initial state", () => {
    const b = createBackoff({ minMs: 100, maxMs: 10_000, factor: 2, jitter: undefined });
    b.next();
    b.next();
    b.next();
    expect(b.attempt).toBe(3);
    b.reset();
    expect(b.attempt).toBe(0);
    expect(b.next()).toBe(100); // back to min
  });

  it("reset() can be called immediately without prior next()", () => {
    const b = createBackoff({ minMs: 250, factor: 2, jitter: undefined });
    expect(() => b.reset()).not.toThrow();
    expect(b.attempt).toBe(0);
    expect(b.next()).toBe(250);
  });

  // ─── Attempt counter ───────────────────────────────────────────────────

  it("tracks attempt count", () => {
    const b = createBackoff({ minMs: 10, factor: 2, jitter: undefined });
    expect(b.attempt).toBe(0);
    b.next();
    expect(b.attempt).toBe(1);
    b.next();
    expect(b.attempt).toBe(2);
    b.reset();
    expect(b.attempt).toBe(0);
  });

  // ─── Deterministic jitter (function form) ──────────────────────────────

  it("accepts a custom jitter function for deterministic tests", () => {
    const calls: number[] = [];
    const b = createBackoff({
      minMs: 100,
      maxMs: 1000,
      factor: 2,
      jitter: (raw) => {
        calls.push(raw);
        return raw + 5; // deterministic shift
      },
    });
    expect(b.next()).toBe(105); // 100 + 5
    expect(b.next()).toBe(205); // 200 + 5
    expect(b.next()).toBe(405); // 400 + 5
    expect(calls).toEqual([100, 200, 400]);
  });

  it("fraction jitter produces values within expected range", () => {
    // Use jitter=0 to effectively disable (0 * anything = 0)
    const b = createBackoff({ minMs: 500, maxMs: 5000, factor: 2, jitter: 0 });
    const v1 = b.next();
    const v2 = b.next();
    const v3 = b.next();
    // With jitter=0, values should be exact
    expect(v1).toBe(500);
    expect(v2).toBe(1000);
    expect(v3).toBe(2000);
  });

  it("fraction jitter 0.5 varies within ±50 % range at each step", () => {
    // Test a single step: min=1000, 50% jitter → [500, 1500]
    for (let i = 0; i < 50; i++) {
      const b = createBackoff({ minMs: 1000, maxMs: 10_000, factor: 2, jitter: 0.5 });
      const v = b.next();
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1500);
    }
  });

  // ─── Edge cases ────────────────────────────────────────────────────────

  it("handles minMs === maxMs", () => {
    const b = createBackoff({ minMs: 5000, maxMs: 5000, factor: 2, jitter: undefined });
    expect(b.next()).toBe(5000);
    expect(b.next()).toBe(5000); // clamped
    expect(b.attempt).toBe(2);
  });

  it("handles factor === 1 (no growth)", () => {
    const b = createBackoff({ minMs: 200, maxMs: 1000, factor: 1, jitter: undefined });
    expect(b.next()).toBe(200);
    expect(b.next()).toBe(200);
    expect(b.next()).toBe(200);
  });

  it("handles very large maxMs", () => {
    const b = createBackoff({ minMs: 1, maxMs: 1_000_000, factor: 2, jitter: undefined });
    let prev = 1;
    for (let i = 0; i < 15; i++) {
      const v = b.next();
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("backoff does not return floating point noise beyond rounding", () => {
    const b = createBackoff({ minMs: 100, maxMs: 1000, factor: 2, jitter: undefined });
    for (let i = 0; i < 10; i++) {
      const v = b.next();
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
