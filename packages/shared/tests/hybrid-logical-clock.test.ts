import { describe, it, expect } from "vitest";
import {
  createHybridClock,
  tickLocal,
  mergeRemote,
  compareHybridTimestamp,
  maxHybridTimestamp,
} from "@screenlink/shared";
import type { HybridTimestamp } from "@screenlink/shared";

describe("HybridLogicalClock", () => {
  it("createHybridClock initializes with wall time", () => {
    const before = Date.now();
    const clock = createHybridClock("node-a");
    const after = Date.now();
    expect(clock.wallTimeMs).toBeGreaterThanOrEqual(before);
    expect(clock.wallTimeMs).toBeLessThanOrEqual(after);
    expect(clock.counter).toBe(0);
    expect(clock.nodeId).toBe("node-a");
  });

  it("createHybridClock accepts persisted stamp", () => {
    const persisted: HybridTimestamp = { wallTimeMs: 1000, counter: 5, nodeId: "old" };
    const clock = createHybridClock("node-a", persisted);
    expect(clock.wallTimeMs).toBe(1000);
    expect(clock.counter).toBe(5);
    expect(clock.nodeId).toBe("node-a"); // nodeId is NOT taken from persisted
  });

  it("tickLocal increments counter and advances wall time", () => {
    const clock = createHybridClock("node-a");
    const before = clock.wallTimeMs;
    const t1 = tickLocal(clock);
    expect(t1.wallTimeMs).toBeGreaterThanOrEqual(before);
    expect(t1.counter).toBe(1);
    expect(t1.nodeId).toBe("node-a");
    expect(clock.counter).toBe(1);

    const t2 = tickLocal(clock);
    expect(t2.counter).toBe(2);
    expect(clock.counter).toBe(2);
  });

  it("tickLocal respects explicit now timestamp", () => {
    // Create clock with a low initial wall time so the explicit `now` wins
    const clock = createHybridClock("node-a", { wallTimeMs: 100, counter: 0, nodeId: "node-a" });
    const t1 = tickLocal(clock, 5000);
    expect(t1.wallTimeMs).toBe(5000);
    expect(t1.counter).toBe(1);
  });

  it("tickLocal uses max of current wall time and physical time", () => {
    const clock = createHybridClock("node-a");
    clock.wallTimeMs = 999999;
    const t1 = tickLocal(clock, 100);
    expect(t1.wallTimeMs).toBe(999999); // wall time is larger
    expect(t1.counter).toBe(1);
  });

  it("mergeRemote produces stamp greater than both local and remote", () => {
    const clock = createHybridClock("node-a", { wallTimeMs: 100, counter: 0, nodeId: "node-a" });
    const remote: HybridTimestamp = { wallTimeMs: 200, counter: 3, nodeId: "node-b" };
    // Pass explicit `now` so physical time doesn't dominate
    const stamp = mergeRemote(clock, remote, 200);
    expect(stamp.wallTimeMs).toBe(200);
    expect(stamp.counter).toBe(4); // remote counter + 1
    expect(clock.wallTimeMs).toBe(200);
    expect(clock.counter).toBe(4);
  });

  it("mergeRemote handles same wall time conflict", () => {
    const clock = createHybridClock("node-a", { wallTimeMs: 100, counter: 5, nodeId: "node-a" });
    const remote: HybridTimestamp = { wallTimeMs: 100, counter: 3, nodeId: "node-b" };
    const stamp = mergeRemote(clock, remote, 100);
    expect(stamp.wallTimeMs).toBe(100);
    expect(stamp.counter).toBe(6); // max(5,3) + 1 = 6
  });

  it("mergeRemote with physical time newer than both stamps", () => {
    const clock = createHybridClock("node-a", { wallTimeMs: 100, counter: 5, nodeId: "node-a" });
    const remote: HybridTimestamp = { wallTimeMs: 200, counter: 3, nodeId: "node-b" };
    const stamp = mergeRemote(clock, remote, 300);
    expect(stamp.wallTimeMs).toBe(300);
    expect(stamp.counter).toBe(0);
  });

  it("compareHybridTimestamp orders by wallTimeMs first", () => {
    const a: HybridTimestamp = { wallTimeMs: 100, counter: 0, nodeId: "a" };
    const b: HybridTimestamp = { wallTimeMs: 200, counter: 0, nodeId: "b" };
    expect(compareHybridTimestamp(a, b)).toBe(-1);
    expect(compareHybridTimestamp(b, a)).toBe(1);
  });

  it("compareHybridTimestamp orders by counter second", () => {
    const a: HybridTimestamp = { wallTimeMs: 100, counter: 1, nodeId: "a" };
    const b: HybridTimestamp = { wallTimeMs: 100, counter: 2, nodeId: "b" };
    expect(compareHybridTimestamp(a, b)).toBe(-1);
    expect(compareHybridTimestamp(b, a)).toBe(1);
  });

  it("compareHybridTimestamp orders by nodeId third", () => {
    const a: HybridTimestamp = { wallTimeMs: 100, counter: 1, nodeId: "a" };
    const b: HybridTimestamp = { wallTimeMs: 100, counter: 1, nodeId: "b" };
    expect(compareHybridTimestamp(a, b)).toBe(-1);
    expect(compareHybridTimestamp(b, a)).toBe(1);
  });

  it("compareHybridTimestamp returns 0 for equal stamps", () => {
    const a: HybridTimestamp = { wallTimeMs: 100, counter: 1, nodeId: "a" };
    const b: HybridTimestamp = { wallTimeMs: 100, counter: 1, nodeId: "a" };
    expect(compareHybridTimestamp(a, b)).toBe(0);
  });

  it("maxHybridTimestamp returns the larger of two", () => {
    const a: HybridTimestamp = { wallTimeMs: 100, counter: 0, nodeId: "a" };
    const b: HybridTimestamp = { wallTimeMs: 200, counter: 0, nodeId: "b" };
    expect(maxHybridTimestamp(a, b)).toBe(b);
    expect(maxHybridTimestamp(b, a)).toBe(b);
  });

  it("maxHybridTimestamp handles null/undefined", () => {
    const a: HybridTimestamp = { wallTimeMs: 100, counter: 0, nodeId: "a" };
    expect(maxHybridTimestamp(null, a)).toBe(a);
    expect(maxHybridTimestamp(a, undefined)).toBe(a);
    expect(maxHybridTimestamp(null, undefined)).toEqual({
      wallTimeMs: 0,
      counter: 0,
      nodeId: "",
    });
  });
});
