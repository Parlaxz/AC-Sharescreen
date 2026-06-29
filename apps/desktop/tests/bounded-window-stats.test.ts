// @vitest-environment node
/**
 * Tests for BoundedWindowStats — rolling average, p50, p95, and
 * bounded-window sample tracking.
 */
import { describe, it, expect } from "vitest";
import { BoundedWindowStats } from "@/lib/bounded-window-stats";

describe("BoundedWindowStats — basic operations", () => {
  it("starts empty with NaN for average/median/p95", () => {
    const s = new BoundedWindowStats(100);
    expect(s.count).toBe(0);
    expect(s.average()).toBeNaN();
    expect(s.median()).toBeNaN();
    expect(s.p95()).toBeNaN();
    expect(s.latest()).toBeNaN();
  });

  it("tracks a single sample correctly", () => {
    const s = new BoundedWindowStats(100);
    s.push(42);
    expect(s.count).toBe(1);
    expect(s.average()).toBeCloseTo(42);
    expect(s.median()).toBeCloseTo(42);
    expect(s.p95()).toBeCloseTo(42);
    expect(s.latest()).toBeCloseTo(42);
  });

  it("computes average of multiple samples", () => {
    const s = new BoundedWindowStats(100);
    s.push(10);
    s.push(20);
    s.push(30);
    expect(s.count).toBe(3);
    expect(s.average()).toBeCloseTo(20);
  });

  it("computes median (p50) correctly with odd count", () => {
    const s = new BoundedWindowStats(100);
    s.push(1);
    s.push(10);
    s.push(100);
    expect(s.median()).toBeCloseTo(10);
  });

  it("computes median (p50) correctly with even count", () => {
    const s = new BoundedWindowStats(100);
    s.push(1);
    s.push(10);
    s.push(100);
    s.push(200);
    // sorted: [1, 10, 100, 200], median = (10+100)/2 = 55
    expect(s.median()).toBeCloseTo(55);
  });

  it("computes p95 correctly", () => {
    const s = new BoundedWindowStats(100);
    // Push 0..99 (100 values)
    for (let i = 0; i < 100; i++) {
      s.push(i);
    }
    // p95 of 0..99: rank = 0.95 * 99 = 94.05
    // lower=94, upper=95, frac=0.05
    // = 94 * 0.95 + 95 * 0.05 = 94.05
    // Using linear interpolation
    expect(s.p95()).toBeCloseTo(94.05, 5);
  });

  it("returns latest sample", () => {
    const s = new BoundedWindowStats(10);
    s.push(1);
    s.push(2);
    s.push(3);
    expect(s.latest()).toBeCloseTo(3);
  });

  it("resets to empty state", () => {
    const s = new BoundedWindowStats(10);
    s.push(1);
    s.push(2);
    s.reset();
    expect(s.count).toBe(0);
    expect(s.average()).toBeNaN();
    expect(s.median()).toBeNaN();
  });
});

describe("BoundedWindowStats — bounded window eviction", () => {
  it("evicts oldest samples when window is full", () => {
    const s = new BoundedWindowStats(5);
    for (let i = 0; i < 10; i++) {
      s.push(i);
    }
    expect(s.count).toBe(10); // total count
    // Window of last 5: [5, 6, 7, 8, 9]
    // average = (5+6+7+8+9)/5 = 7
    expect(s.average()).toBeCloseTo(7);
    expect(s.latest()).toBeCloseTo(9);
  });

  it("eviction maintains sorted percentile correctness", () => {
    const s = new BoundedWindowStats(3);
    s.push(1);
    s.push(100);
    s.push(50);
    // window: [1, 100, 50] sorted: [1, 50, 100]
    expect(s.median()).toBeCloseTo(50);
    expect(s.average()).toBeCloseTo(50.333, 2);

    // Push new values, evict old
    s.push(200);
    // window: [100, 50, 200] sorted: [50, 100, 200]
    expect(s.median()).toBeCloseTo(100);
    expect(s.average()).toBeCloseTo(116.667, 2);
  });
});

describe("BoundedWindowStats — edge cases", () => {
  it("handles capacity of 1", () => {
    const s = new BoundedWindowStats(1);
    s.push(100);
    expect(s.average()).toBeCloseTo(100);
    s.push(200);
    expect(s.average()).toBeCloseTo(200);
    expect(s.count).toBe(2);
  });

  it("handles duplicate values correctly", () => {
    const s = new BoundedWindowStats(10);
    for (let i = 0; i < 5; i++) s.push(7);
    expect(s.average()).toBeCloseTo(7);
    expect(s.median()).toBeCloseTo(7);
    expect(s.p95()).toBeCloseTo(7);
  });

  it("percentile(0) returns min", () => {
    const s = new BoundedWindowStats(10);
    s.push(5);
    s.push(1);
    s.push(10);
    expect(s.percentile(0)).toBeCloseTo(1);
  });

  it("percentile(100) returns max", () => {
    const s = new BoundedWindowStats(10);
    s.push(5);
    s.push(1);
    s.push(10);
    expect(s.percentile(100)).toBeCloseTo(10);
  });
});
