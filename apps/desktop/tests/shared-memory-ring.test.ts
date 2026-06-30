import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SharedMemoryFrameRing, SlotState } from "../src/main/SharedMemoryFrameRing.js";

// Constants matching the C++ layout
const kMaxFrameSize = 33_177_600;
const SLOT_HEADER_OFFSET = 8;
const SLOT_INPUT_OFFSET = SLOT_HEADER_OFFSET + 104;
const SLOT_OUTPUT_OFFSET = SLOT_INPUT_OFFSET + kMaxFrameSize;
const SLOT_BYTE_SIZE = SLOT_OUTPUT_OFFSET + kMaxFrameSize;
const RING_TOTAL_SIZE = 3 * SLOT_BYTE_SIZE;

describe("SharedMemoryFrameRing", () => {
  let tmpFile: string;
  let ring: SharedMemoryFrameRing;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `screenlink-shm-test-${Date.now()}.bin`);
    // Create a zero-filled file matching ring size
    const buf = Buffer.alloc(RING_TOTAL_SIZE, 0);
    fs.writeFileSync(tmpFile, buf);
    ring = new SharedMemoryFrameRing();
  });

  afterEach(() => {
    ring.close();
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("opens and closes the backing file", () => {
    expect(ring.open(tmpFile)).toBe(true);
    expect(ring.isOpen).toBe(true);
    expect(ring.filePath).toBe(tmpFile);
    ring.close();
    expect(ring.isOpen).toBe(false);
  });

  it("returns false when opening a non-existent file", () => {
    expect(ring.open("nonexistent-file.bin")).toBe(false);
  });

  it("reads and writes control words", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // Initially all slots are Empty
    for (let i = 0; i < 3; i++) {
      expect(ring.readControl(i)).toBe(SlotState.Empty);
    }

    // Write Submitted to slot 1
    expect(ring.writeControl(1, SlotState.Submitted)).toBe(true);
    expect(ring.readControl(1)).toBe(SlotState.Submitted);

    // Write Done to slot 0
    expect(ring.writeControl(0, SlotState.Done)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Done);

    // Slot 2 remains Empty
    expect(ring.readControl(2)).toBe(SlotState.Empty);
  });

  it("finds empty slots correctly", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // All empty
    expect(ring.findEmptySlot()).toBe(0);

    // Fill slot 0
    ring.writeControl(0, SlotState.Submitted);
    expect(ring.findEmptySlot()).toBe(1);

    // Fill slot 1
    ring.writeControl(1, SlotState.Processing);
    expect(ring.findEmptySlot()).toBe(2);

    // Fill all slots
    ring.writeControl(2, SlotState.Done);
    expect(ring.findEmptySlot()).toBe(-1);

    // Clear slot 1
    ring.writeControl(1, SlotState.Empty);
    expect(ring.findEmptySlot()).toBe(1);
  });

  it("writes and reads frame data round-trip", () => {
    expect(ring.open(tmpFile)).toBe(true);

    const slotIndex = 0;
    const generation = 42;
    const frameSequence = 7;
    const inputWidth = 1920;
    const inputHeight = 1080;
    const inputStride = inputWidth * 4;
    const outW = 1920;
    const outH = 1080;
    const modeNum = 1;
    const qualNum = 2;

    // Create a small test frame (just first few rows)
    const pixelCount = inputWidth * 16; // 16 rows
    const pixelBytes = pixelCount * 4;
    const frameData = new Uint8Array(pixelBytes);
    for (let i = 0; i < pixelBytes; i++) {
      frameData[i] = i & 0xFF;
    }

    // Write input
    const writeOk = ring.writeInput(
      slotIndex, generation, frameSequence,
      inputWidth, inputHeight, inputStride,
      2, // RGBA8
      outW, outH, modeNum, qualNum,
      frameData,
    );
    expect(writeOk).toBe(true);

    // Set control to Submitted and then Done (simulating helper)
    ring.writeControl(slotIndex, SlotState.Submitted);
    ring.writeControl(slotIndex, SlotState.Done);

    // Read output (before any real processing, the output region is all zeros)
    const output = ring.readOutput(slotIndex);
    expect(output).not.toBeNull();
    expect(output!.generation).toBe(generation);
    expect(output!.frameSequence).toBe(frameSequence);
    expect(output!.width).toBe(inputWidth);
    expect(output!.height).toBe(inputHeight);
    expect(output!.payloadBytes).toBe(pixelBytes);
    // Since we wrote original header before setting Done, the header payload
    // reflects what was written
  });

  it("returns null when slot is not Done", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // Slot is Empty, should return null
    expect(ring.readOutput(0)).toBeNull();

    // Set to Submitted, still not Done
    ring.writeControl(0, SlotState.Submitted);
    expect(ring.readOutput(0)).toBeNull();
  });

  it("returns -1 for control reads on closed ring", () => {
    expect(ring.readControl(0)).toBe(-1);
    expect(ring.writeControl(0, SlotState.Empty)).toBe(false);
    expect(ring.findEmptySlot()).toBe(-1);
    expect(ring.readOutput(0)).toBeNull();
  });

  // ── Slice 4: Legal/illegal slot transition tests ──────────────────

  it("accepts legal slot transitions: Empty→Submitted→Processing→Done", () => {
    expect(ring.open(tmpFile)).toBe(true);

    expect(ring.readControl(0)).toBe(SlotState.Empty);
    expect(ring.writeControl(0, SlotState.Submitted)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Submitted);
    expect(ring.writeControl(0, SlotState.Processing)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Processing);
    expect(ring.writeControl(0, SlotState.Done)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Done);
  });

  it("accepts legal Empty→Done transition (skip processing)", () => {
    expect(ring.open(tmpFile)).toBe(true);

    expect(ring.writeControl(0, SlotState.Done)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Done);

    // Reset to Empty
    expect(ring.writeControl(0, SlotState.Empty)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Empty);
  });

  it("accepts Done→Empty transition (slot release)", () => {
    expect(ring.open(tmpFile)).toBe(true);

    ring.writeControl(0, SlotState.Done);
    expect(ring.writeControl(0, SlotState.Empty)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Empty);
  });

  it("accepts Error→Empty transition (error recovery)", () => {
    expect(ring.open(tmpFile)).toBe(true);

    ring.writeControl(0, SlotState.Error);
    expect(ring.readControl(0)).toBe(SlotState.Error);
    expect(ring.writeControl(0, SlotState.Empty)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Empty);
  });

  it("accepts Submitted→Empty transition (cancellation)", () => {
    expect(ring.open(tmpFile)).toBe(true);

    expect(ring.writeControl(0, SlotState.Submitted)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Submitted);
    // Cancel: reset to Empty
    expect(ring.writeControl(0, SlotState.Empty)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Empty);
  });

  it("all 3 slots can be occupied simultaneously", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // Fill all 3 slots
    expect(ring.writeControl(0, SlotState.Submitted)).toBe(true);
    expect(ring.writeControl(1, SlotState.Submitted)).toBe(true);
    expect(ring.writeControl(2, SlotState.Submitted)).toBe(true);

    // No empty slots
    expect(ring.findEmptySlot()).toBe(-1);
    expect(ring.readControl(0)).toBe(SlotState.Submitted);
    expect(ring.readControl(1)).toBe(SlotState.Submitted);
    expect(ring.readControl(2)).toBe(SlotState.Submitted);
  });

  it("writeInput returns false when ring is closed", () => {
    // Ring not opened yet
    const result = ring.writeInput(0, 1, 1, 100, 100, 400, 2, 100, 100, 1, 2, new Uint8Array(1600));
    expect(result).toBe(false);
  });
});
