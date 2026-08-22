// @vitest-environment node
/**
 * Hypothesis-driven regression tests for the native video/frame pipeline.
 *
 * Covers:
 *   VFR-H1: Frame ring slot exhaustion returns -1 (bounded behavior)
 *   VFR-H2: Slot double-release is safe at TS layer
 *   VEP-H3: FramePipeParser reset/cleanup on crash
 *   VEP-H4: Partial pipe write framing
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Small test file size — only control words (4 bytes × 3 slots) + margin
const TEST_FILE_SIZE = 4096;

import {
  SharedMemoryFrameRing,
  SlotState,
} from "../src/main/SharedMemoryFrameRing.js";
import { FramePipeParser } from "../src/main/VideoHelperManager.js";

// ── File-level cleanup (runs after EVERY test) ──────────────────────────
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════════
// VFR-H1: Frame ring slot exhaustion returns -1 (bounded behavior)
// ═════════════════════════════════════════════════════════════════════════════

describe("VFR-H1: Slot exhaustion bounded behavior (characterization)", () => {
  let tmpFile: string;
  let ring: SharedMemoryFrameRing;

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `screenlink-shm-exhaust-${Date.now()}.bin`,
    );
    fs.writeFileSync(tmpFile, Buffer.alloc(TEST_FILE_SIZE, 0));
    ring = new SharedMemoryFrameRing();
  });

  afterEach(() => {
    ring.close();
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it("findEmptySlot returns -1 when all 3 slots are occupied", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // Fill all 3 slots sequentially
    expect(ring.findEmptySlot()).toBe(0);
    ring.writeControl(0, SlotState.Submitted);
    expect(ring.findEmptySlot()).toBe(1);
    ring.writeControl(1, SlotState.Submitted);
    expect(ring.findEmptySlot()).toBe(2);
    ring.writeControl(2, SlotState.Submitted);

    // All exhausted — must return -1
    expect(ring.findEmptySlot()).toBe(-1);

    // Release slot 0 → must be found again
    ring.writeControl(0, SlotState.Empty);
    expect(ring.findEmptySlot()).toBe(0);
  });

  it("writeInput on unopened ring returns false", () => {
    // Ring was never opened — fd is null, writeInput must short-circuit.
    const result = ring.writeInput(
      0,
      1,
      1,
      100,
      100,
      400,
      2,
      100,
      100,
      1,
      2,
      new Uint8Array(1600),
    );
    expect(result).toBe(false);
  });

  it("writeInput succeeds even when slot is occupied (TS layer has no guard)", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // Occupy slot 0
    ring.writeControl(0, SlotState.Submitted);

    // writeInput writes regardless of slot state — this is a characterization.
    // The caller (VHM.submitFrameViaShm) guards via findEmptySlot,
    // but there is no TS-level guard against writing to an occupied slot.
    const frameData = new Uint8Array(32);
    const writeOk = ring.writeInput(
      0,
      1,
      1,
      16,
      16,
      64,
      2,
      16,
      2,
      1,
      2,
      frameData,
    );
    expect(writeOk).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// VFR-H2: Slot double-release safety
// ═════════════════════════════════════════════════════════════════════════════

describe("VFR-H2: Slot double-release safety (characterization)", () => {
  let tmpFile: string;
  let ring: SharedMemoryFrameRing;

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `screenlink-shm-double-${Date.now()}.bin`,
    );
    fs.writeFileSync(tmpFile, Buffer.alloc(TEST_FILE_SIZE, 0));
    ring = new SharedMemoryFrameRing();
  });

  afterEach(() => {
    ring.close();
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it("writeControl Empty on already-empty slot is idempotent at TS layer", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // The TS writeControl layer does not track slot ownership.
    // Writing Empty twice succeeds — no corruption at this layer.
    expect(ring.writeControl(0, SlotState.Empty)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Empty);
    expect(ring.writeControl(0, SlotState.Empty)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Empty);
  });

  it("all 3 slots can be occupied simultaneously then released", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // Fill all 3 slots with different states
    expect(ring.writeControl(0, SlotState.Submitted)).toBe(true);
    expect(ring.writeControl(1, SlotState.Processing)).toBe(true);
    expect(ring.writeControl(2, SlotState.Done)).toBe(true);

    // No empty slots
    expect(ring.findEmptySlot()).toBe(-1);

    // Release all back to Empty
    expect(ring.writeControl(0, SlotState.Empty)).toBe(true);
    expect(ring.writeControl(1, SlotState.Empty)).toBe(true);
    expect(ring.writeControl(2, SlotState.Empty)).toBe(true);

    // All must be findable again
    expect(ring.findEmptySlot()).toBe(0);
    expect(ring.readControl(0)).toBe(SlotState.Empty);
    expect(ring.readControl(1)).toBe(SlotState.Empty);
    expect(ring.readControl(2)).toBe(SlotState.Empty);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// VEP-H3: FramePipeParser crash recovery reset
// ═════════════════════════════════════════════════════════════════════════════

describe("VEP-H3: FramePipeParser crash fallback (characterization)", () => {
  // afterEach calls vi.useRealTimers at file level, so fake timers
  // from the timeout test are cleaned up even if the test fails.

  it("reset() clears pending frame and resolves callback with null", () => {
    const parser = new FramePipeParser();
    expect(parser.hasPending).toBe(false);

    // Install a pending frame correlation
    let resolvedResult: unknown = undefined;
    parser.installPending(1, 1, (r) => {
      resolvedResult = r;
    }, 5000);
    expect(parser.hasPending).toBe(true);

    // Simulate crash/exit: reset clears everything
    parser.reset();
    expect(parser.hasPending).toBe(false);
    // The pending callback must have been resolved with null
    expect(resolvedResult).toBeNull();
  });

  it("installPending replaces prior pending and resolves old with null", () => {
    const parser = new FramePipeParser();

    let firstResult: unknown = undefined;
    let secondResult: unknown = undefined;

    parser.installPending(1, 1, (r) => {
      firstResult = r;
    }, 5000);

    // Second installPending should replace first
    parser.installPending(1, 2, (r) => {
      secondResult = r;
    }, 5000);

    // First pending was resolved with null (replaced)
    expect(firstResult).toBeNull();
    expect(parser.hasPending).toBe(true);
  });

  it("timeout resolves pending callback with null", async () => {
    vi.useFakeTimers();

    const parser = new FramePipeParser();

    let resolvedResult: unknown = undefined;
    parser.installPending(1, 1, (r) => {
      resolvedResult = r;
    }, 5000);

    expect(parser.hasPending).toBe(true);
    vi.advanceTimersByTime(5000);

    // Timeout resolves with null and resets parser
    expect(resolvedResult).toBeNull();
    expect(parser.hasPending).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// VEP-H4: Partial pipe write framing
// ═════════════════════════════════════════════════════════════════════════════

describe("VEP-H4: Partial pipe write does not desync reader (characterization)", () => {
  // Golden wire value — must match C++ FrameHeader.kHeaderSize.
  // Change if and only if the native protocol version is bumped.
  const HEADER_SIZE = 104;

  function buildValidHeader(
    generation: number,
    frameSequence: number,
    payloadBytes: number,
  ): Buffer {
    const hdr = Buffer.alloc(HEADER_SIZE);
    hdr.writeBigUInt64LE(BigInt("0x464C4156454D5246"), 0); // Golden magic — matches FRAME_MAGIC in VideoHelperManager.ts
    hdr.writeUInt32LE(HEADER_SIZE, 8);
    hdr.writeUInt32LE(1, 12);
    hdr.writeUInt32LE(generation, 16);
    hdr.writeUInt32LE(frameSequence, 20);
    hdr.writeBigUInt64LE(BigInt(Date.now() * 1000), 24);
    hdr.writeUInt32LE(100, 32);
    hdr.writeUInt32LE(100, 36);
    hdr.writeUInt32LE(400, 40);
    hdr.writeUInt32LE(2, 44);
    hdr.writeUInt32LE(100, 48);
    hdr.writeUInt32LE(100, 52);
    hdr.writeUInt32LE(0, 56);
    hdr.writeUInt32LE(payloadBytes, 60);
    hdr.writeUInt32LE(1, 64);
    hdr.writeUInt32LE(2, 68);
    hdr.writeUInt32LE(0, 72);
    hdr.writeUInt32LE(1, 76); // resultCode = success
    for (let i = 80; i < HEADER_SIZE; i += 4) hdr.writeUInt32LE(0, i);
    return hdr;
  }

  it("handles header split across chunks (first 60 bytes, then rest + payload)", () => {
    const payloadBytes = 100;
    const hdr = buildValidHeader(1, 42, payloadBytes);
    const payload = Buffer.alloc(payloadBytes, 0xab);

    const parser = new FramePipeParser();

    let resolvedResult: unknown = undefined;
    parser.installPending(1, 42, (r) => {
      resolvedResult = r;
    }, 5000);

    // Feed partial header (first 60 of 104 bytes)
    const chunk1 = hdr.subarray(0, 60);
    let result = parser.feed(chunk1);
    expect(result).toBeNull();
    expect(parser.hasPending).toBe(true);

    // Feed remaining header + full payload
    const chunk2 = Buffer.concat([hdr.subarray(60), payload]);
    result = parser.feed(chunk2);
    expect(result).not.toBeNull();
    expect(result!.generation).toBe(1);
    expect(result!.sequence).toBe(42);
    expect(result!.pixels.byteLength).toBe(payloadBytes);
    expect(resolvedResult).not.toBeNull();
  });

  it("handles payload split across chunks (header + half, then rest)", () => {
    const payloadBytes = 200;
    const hdr = buildValidHeader(1, 7, payloadBytes);
    const payload = Buffer.alloc(payloadBytes, 0xcd);

    const parser = new FramePipeParser();
    let resolvedResult: unknown = undefined;
    parser.installPending(1, 7, (r) => {
      resolvedResult = r;
    }, 5000);

    // Feed header + first half of payload
    const midPoint = payloadBytes >> 1;
    const chunk1 = Buffer.concat([hdr, payload.subarray(0, midPoint)]);
    let result = parser.feed(chunk1);
    expect(result).toBeNull(); // Payload not yet complete

    // Feed remaining payload
    const chunk2 = payload.subarray(midPoint);
    result = parser.feed(chunk2);
    expect(result).not.toBeNull();
    expect(result!.sequence).toBe(7);
    expect((resolvedResult as any)?.sequence).toBe(7);
  });

  it("rejects payloadBytes > 200MB as protocol error", () => {
    const hdr = buildValidHeader(1, 1, 300 * 1024 * 1024); // 300MB > 200MB limit
    const parser = new FramePipeParser();
    let resolvedResult: unknown = undefined;
    parser.installPending(1, 1, (r) => {
      resolvedResult = r;
    }, 5000);

    const result = parser.feed(hdr);
    expect(result).toBeNull();
    // Parser must have reset on oversized payload
    expect(parser.hasPending).toBe(false);
    expect(resolvedResult).toBeNull();
  });

  it("valid full frame round-trip (single chunk)", () => {
    const payloadBytes = 64;
    const hdr = buildValidHeader(2, 99, payloadBytes);
    const payload = Buffer.alloc(payloadBytes, 0xef);
    const fullFrame = Buffer.concat([hdr, payload]);

    const parser = new FramePipeParser();
    let resolvedResult: unknown = undefined;
    parser.installPending(2, 99, (r) => {
      resolvedResult = r;
    }, 5000);

    const result = parser.feed(fullFrame);
    expect(result).not.toBeNull();
    expect(result!.generation).toBe(2);
    expect(result!.sequence).toBe(99);
    expect(result!.pixels.byteLength).toBe(payloadBytes);
  });
});
