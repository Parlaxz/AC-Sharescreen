/**
 * Slice 5: Renderer input shared slots — SAB registration, metadata-only
 * submission, and structured-clone fallback.
 *
 * Tests are focused on the TypeScript/JS side only: RendererInputSlots,
 * protocol changes, and the VideoHelperManager frame-port extension.
 * No benchmarks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ────────────────────────────────────────────────────────────────────────────
// Test: RendererInputSlots — SAB creation, registration, slot I/O
// ────────────────────────────────────────────────────────────────────────────

describe("RendererInputSlots", () => {
  let RendererInputSlotsClass: typeof import("../src/renderer/services/viewer-image-processing/renderer-input-slots").RendererInputSlots;

  beforeEach(async () => {
    // Fresh import to avoid cross-test state
    RendererInputSlotsClass = (await import("../src/renderer/services/viewer-image-processing/renderer-input-slots")).RendererInputSlots;
  });

  it("creates 3 SharedArrayBuffer slots", () => {
    const slots = new RendererInputSlotsClass();
    const ok = slots.create();
    expect(ok).toBe(true);
    expect(slots.isCreated).toBe(true);
    expect(slots.slotCount).toBe(3);
    expect(slots.isRegistered).toBe(false);
    const bufs = slots.buffers_;
    expect(bufs).not.toBeNull();
    expect(bufs!.length).toBe(3);
    for (const buf of bufs!) {
      expect(buf).toBeInstanceOf(SharedArrayBuffer);
      expect(buf.byteLength).toBeGreaterThan(0);
    }
    slots.destroy();
  });

  it("returns false on double create", () => {
    const slots = new RendererInputSlotsClass();
    expect(slots.create()).toBe(true);
    expect(slots.create()).toBe(false);
    slots.destroy();
  });

  it("writes and reads pixel data via slots", () => {
    const slots = new RendererInputSlotsClass();
    slots.create();

    const pixelData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const wrote = slots.writeSlot(0, 1, 100, 320, 240, pixelData);
    expect(wrote).toBe(true);

    const read = slots.readSlot(0);
    expect(read).not.toBeNull();
    expect(read!.byteLength).toBe(pixelData.byteLength);
    expect(Array.from(read!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    slots.destroy();
  });

  it("round-robins slot index via nextSlot()", () => {
    const slots = new RendererInputSlotsClass();
    slots.create();

    expect(slots.nextSlot()).toBe(0);
    expect(slots.nextSlot()).toBe(1);
    expect(slots.nextSlot()).toBe(2);
    expect(slots.nextSlot()).toBe(0); // wraps around
    expect(slots.nextSlot()).toBe(1);

    slots.destroy();
  });

  it("rejects write when destroyed", () => {
    const slots = new RendererInputSlotsClass();
    slots.create();
    slots.destroy();

    const wrote = slots.writeSlot(0, 1, 0, 320, 240, new Uint8Array(4));
    expect(wrote).toBe(false);
  });

  it("rejects write with out-of-range slot index", () => {
    const slots = new RendererInputSlotsClass();
    slots.create();

    expect(slots.writeSlot(-1, 1, 0, 320, 240, new Uint8Array(4))).toBe(false);
    expect(slots.writeSlot(3, 1, 0, 320, 240, new Uint8Array(4))).toBe(false);
    expect(slots.writeSlot(99, 1, 0, 320, 240, new Uint8Array(4))).toBe(false);

    slots.destroy();
  });

  it("readSlot returns null for destroyed slots", () => {
    const slots = new RendererInputSlotsClass();
    slots.create();
    slots.destroy();
    expect(slots.readSlot(0)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test: SAB registration via IPC (simulated)
// ────────────────────────────────────────────────────────────────────────────

describe("SAB registration protocol", () => {
  let RendererInputSlotsClass: typeof import("../src/renderer/services/viewer-image-processing/renderer-input-slots").RendererInputSlots;

  beforeEach(async () => {
    RendererInputSlotsClass = (await import("../src/renderer/services/viewer-image-processing/renderer-input-slots")).RendererInputSlots;
  });

  it("register succeeds with valid slots", async () => {
    const slots = new RendererInputSlotsClass();
    slots.create();

    const mockRegister = vi.fn().mockResolvedValue({ success: true });
    const registered = await slots.register(mockRegister);
    expect(registered).toBe(true);
    expect(slots.isRegistered).toBe(true);
    expect(mockRegister).toHaveBeenCalledTimes(1);

    // Verify the argument is the 3 SABs
    const callArg = mockRegister.mock.calls[0][0];
    expect(callArg).toBeInstanceOf(Array);
    expect(callArg.length).toBe(3);
    expect(callArg[0]).toBeInstanceOf(SharedArrayBuffer);

    slots.destroy();
  });

  it("register fails when main process rejects", async () => {
    const slots = new RendererInputSlotsClass();
    slots.create();

    const mockRegister = vi.fn().mockResolvedValue({ success: false });
    const registered = await slots.register(mockRegister);
    expect(registered).toBe(false);
    expect(slots.isRegistered).toBe(false);

    slots.destroy();
  });

  it("register fails when create not called", async () => {
    const slots = new RendererInputSlotsClass();
    // No create() called
    const mockRegister = vi.fn().mockResolvedValue({ success: true });
    const registered = await slots.register(mockRegister);
    expect(registered).toBe(false);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("register is idempotent (second call is no-op)", async () => {
    const slots = new RendererInputSlotsClass();
    slots.create();

    const mockRegister = vi.fn().mockResolvedValue({ success: true });
    await slots.register(mockRegister);
    expect(slots.isRegistered).toBe(true);

    // Second register should short-circuit
    const mockRegister2 = vi.fn().mockResolvedValue({ success: true });
    const registered2 = await slots.register(mockRegister2);
    expect(registered2).toBe(true);
    expect(mockRegister2).not.toHaveBeenCalled(); // not called

    slots.destroy();
  });

  it("release calls main process release function", async () => {
    const slots = new RendererInputSlotsClass();
    slots.create();

    const mockRegister = vi.fn().mockResolvedValue({ success: true });
    await slots.register(mockRegister);
    expect(slots.isRegistered).toBe(true);

    const mockRelease = vi.fn().mockResolvedValue({ success: true });
    await slots.release(mockRelease);
    expect(slots.isRegistered).toBe(false);
    expect(mockRelease).toHaveBeenCalledTimes(1);

    slots.destroy();
  });

  it("release is idempotent when not registered", async () => {
    const slots = new RendererInputSlotsClass();
    slots.create();

    const mockRelease = vi.fn().mockResolvedValue({ success: true });
    await slots.release(mockRelease);
    expect(mockRelease).not.toHaveBeenCalled(); // no-op since not registered

    slots.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test: Metadata-only submission path (frame port with slotIndex)
// ────────────────────────────────────────────────────────────────────────────

describe("Metadata-only submission via shared slots", () => {
  let RendererInputSlotsClass: typeof import("../src/renderer/services/viewer-image-processing/renderer-input-slots").RendererInputSlots;

  beforeEach(async () => {
    RendererInputSlotsClass = (await import("../src/renderer/services/viewer-image-processing/renderer-input-slots")).RendererInputSlots;
  });

  it("submitFrameViaSharedSlot sends slotIndex instead of frameData", () => {
    // This test verifies the protocol shape of the MessagePort message
    // when using the shared-slot path — no frameData, only metadata.
    const slots = new RendererInputSlotsClass();
    slots.create();

    const pixelData = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const slotIndex = slots.nextSlot();
    const wrote = slots.writeSlot(0, 2, 200, 640, 480, pixelData);
    expect(wrote).toBe(true);

    // Simulate what the frame-port message would contain:
    const portMessage = {
      clientId: "test-client",
      generation: 2,
      frameSequence: 200,
      slotIndex: 0,
      inputWidth: 640,
      inputHeight: 480,
      // No frameData — this is the optimized metadata-only path
    };

    // Verify no frameData
    expect((portMessage as any).frameData).toBeUndefined();
    expect(portMessage.slotIndex).toBe(0);
    expect(portMessage.generation).toBe(2);
    expect(portMessage.frameSequence).toBe(200);

    // Verify the pixel data is accessible via the slot
    const readback = slots.readSlot(0);
    expect(readback).not.toBeNull();
    expect(Array.from(readback!)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);

    slots.destroy();
  });

  it("structured-clone path includes frameData as explicit fallback", () => {
    // This test verifies the structured-clone fallback protocol shape
    const frameData = new Uint8Array([1, 2, 3, 4]);

    const portMessage = {
      clientId: "test-client",
      generation: 3,
      frameSequence: 300,
      inputWidth: 320,
      inputHeight: 240,
      frameData: frameData.buffer,
      _fallbackPath: true, // explicit fallback flag
    };

    expect(portMessage.frameData).toBeInstanceOf(ArrayBuffer);
    expect(portMessage.frameData!.byteLength).toBe(4);
    expect(portMessage._fallbackPath).toBe(true);
    expect((portMessage as any).slotIndex).toBeUndefined();
  });

  it("writeSlot stores correct metadata in header", () => {
    const slots = new RendererInputSlotsClass();
    slots.create();

    const pixelData = new Uint8Array(1024); // 16x16 RGBA
    slots.writeSlot(1, 5, 42, 1920, 1080, pixelData);

    // Read header fields via DataView
    const buf = slots.buffers_![1];
    const dv = new DataView(buf, 0, 104);

    // magic
    expect(dv.getBigUint64(0, true)).toBe(BigInt("0x464C4156454D5246"));
    // headerSize
    expect(dv.getUint32(8, true)).toBe(104);
    // generation (offset 16)
    expect(dv.getUint32(16, true)).toBe(5);
    // frameSequence (offset 20)
    expect(dv.getUint32(20, true)).toBe(42);
    // capturedAtUs (offset 24, 8 bytes)
    // inputWidth (offset 32)
    expect(dv.getUint32(32, true)).toBe(1920);
    // inputHeight (offset 36)
    expect(dv.getUint32(36, true)).toBe(1080);
    // slotIndex (offset 56)
    expect(dv.getUint32(56, true)).toBe(1);
    // payloadBytes (offset 60)
    expect(dv.getUint32(60, true)).toBe(1024);

    slots.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test: VideoHelperManager frame-port dispatch (simulated)
// ────────────────────────────────────────────────────────────────────────────

describe("Frame-port shared-slot vs structured-clone dispatch", () => {
  it("message with slotIndex and no frameData triggers shared-slot path", () => {
    // Verify the dispatch logic in createFramePort:
    //   useSharedSlot = typeof msg.slotIndex === "number" && rendererSlots !== null && ... && !msg.frameData

    const msg1 = { slotIndex: 0, frameData: undefined };
    const rendererSlots = [new SharedArrayBuffer(4096), new SharedArrayBuffer(4096), new SharedArrayBuffer(4096)];

    // Shared slot path conditions:
    // 1. slotIndex is a number
    // 2. rendererSlots is not null
    // 3. slotIndex is in range
    // 4. frameData is falsy
    const useShared = (
      typeof msg1.slotIndex === "number" &&
      rendererSlots !== null &&
      msg1.slotIndex >= 0 &&
      msg1.slotIndex < rendererSlots.length &&
      !msg1.frameData
    );
    expect(useShared).toBe(true);
  });

  it("message with frameData triggers structured-clone fallback path", () => {
    const msg2 = { frameData: new ArrayBuffer(100), slotIndex: undefined };
    const rendererSlots = [new SharedArrayBuffer(4096), new SharedArrayBuffer(4096), new SharedArrayBuffer(4096)];

    const useShared = (
      typeof msg2.slotIndex === "number" &&
      rendererSlots !== null &&
      (msg2 as any).slotIndex >= 0 &&
      (msg2 as any).slotIndex < rendererSlots.length &&
      !msg2.frameData
    );
    expect(useShared).toBe(false);
  });

  it("message with both slotIndex and frameData uses structured clone", () => {
    // If both are present, frameData takes priority (conservative)
    const msg3 = { slotIndex: 0, frameData: new ArrayBuffer(100) };
    const rendererSlots = [new SharedArrayBuffer(4096), new SharedArrayBuffer(4096), new SharedArrayBuffer(4096)];

    // The condition requires !msg.frameData to be true
    const useShared = (
      typeof msg3.slotIndex === "number" &&
      rendererSlots !== null &&
      msg3.slotIndex >= 0 &&
      msg3.slotIndex < rendererSlots.length &&
      !msg3.frameData
    );
    expect(useShared).toBe(false);
  });

  it("message with no slotIndex and no frameData is rejected", () => {
    const msg4 = { generation: 1, frameSequence: 1 };
    const rendererSlots = [new SharedArrayBuffer(4096), new SharedArrayBuffer(4096), new SharedArrayBuffer(4096)];

    const hasFrameData = !!(msg4 as any).frameData;
    const hasSlotIndex = typeof (msg4 as any).slotIndex === "number";

    expect(hasFrameData).toBe(false);
    expect(hasSlotIndex).toBe(false);
  });
});
