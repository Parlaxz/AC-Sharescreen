// @vitest-environment node
/**
 * Phase 3: SharedArrayBuffer support probe test.
 *
 * This test checks whether the runtime environment supports SharedArrayBuffer.
 * A SharedArrayBuffer ring-buffer for zero-copy frame transport is NOT
 * implemented yet — this probe only verifies that the platform CAN support it
 * so the implementation path is unblocked.
 *
 * If this test fails, the runtime lacks:
 *   - SharedArrayBuffer constructor, OR
 *   - Atomics API
 *
 * In Electron 28+ with proper COOP/COEP headers, this should pass.
 * If it fails, the zero-copy shared-memory path cannot be used and the
 * structured-clone ArrayBuffer transport fallback (already in place) is the
 * permanent transport mechanism.
 */

import { describe, it, expect } from "vitest";

describe("SharedArrayBuffer support probe", () => {
  it("SharedArrayBuffer constructor is available", () => {
    expect(typeof SharedArrayBuffer).toBe("function");
  });

  it("can create a SharedArrayBuffer of minimum size", () => {
    const sab = new SharedArrayBuffer(4);
    expect(sab.byteLength).toBe(4);
  });

  it("can create a SharedArrayBuffer large enough for a 4K RGBA frame", () => {
    // 3840 × 2160 × 4 bytes = 33,177,600 bytes (~31.6 MB)
    const frameSize = 3840 * 2160 * 4;
    const sab = new SharedArrayBuffer(frameSize);
    expect(sab.byteLength).toBe(frameSize);
  });

  it("Atomics API is available for synchronization", () => {
    expect(typeof Atomics).toBe("object");
    expect(typeof Atomics.store).toBe("function");
    expect(typeof Atomics.load).toBe("function");
    expect(typeof Atomics.compareExchange).toBe("function");
  });

  it("Atomics.store and Atomics.load work on a SharedArrayBuffer", () => {
    const sab = new SharedArrayBuffer(8);
    const view = new Uint32Array(sab);
    Atomics.store(view, 0, 42);
    expect(Atomics.load(view, 0)).toBe(42);
  });

  it("Atomics.compareExchange works for lock-free ring-buffer slots", () => {
    const sab = new SharedArrayBuffer(4);
    const view = new Uint32Array(sab);
    // Slot state: 0=empty, 1=writing, 2=ready, 3=reading
    const result = Atomics.compareExchange(view, 0, 0, 1); // claim empty slot
    expect(result).toBe(0); // claimed successfully (was 0, now 1)
    expect(Atomics.load(view, 0)).toBe(1); // confirmed
  });
});
