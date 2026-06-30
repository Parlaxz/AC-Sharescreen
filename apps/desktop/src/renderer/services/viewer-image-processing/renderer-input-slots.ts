// SPDX-License-Identifier: MIT

/**
 * Renderer-owned input shared slots for zero-copy frame transport.
 *
 * Allocates 3 SharedArrayBuffer-backed slots in the renderer process.
 * Registration with the main process happens once per generation;
 * subsequent frame submissions send only metadata (slotIndex + offsets)
 * instead of cloning the full pixel buffer.
 *
 * When the native helper reads pixel data directly from these shared
 * slots via the shared-memory ring or a registered SAB reference, the
 * per-frame IPC payload drops from ~8 MB (1920×1080×4 RGBA) to ~32 bytes.
 */

import { lifecycleLog } from "./lifecycle-id";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Number of round-robin input slots (must match native helper slot count). */
export const RENDERER_SLOT_COUNT = 3;

/** Maximum frame dimension supported (3840×2160 = 8,294,400 pixels = 33,177,600 bytes RGBA). */
export const MAX_FRAME_PIXEL_BYTES = 33_177_600; // 3840 * 2160 * 4

/**
 * Per-slot header size (matches FrameHeader layout in SharedMemoryFrameRing).
 * Stored at slot[0..103] for correlation metadata.
 */
export const SLOT_HEADER_SIZE = 104;

/** Total per-slot size: header + pixel data. */
export const SLOT_BYTE_SIZE = SLOT_HEADER_SIZE + MAX_FRAME_PIXEL_BYTES;

/** Total ring buffer size. */
export const RENDERER_RING_TOTAL_SIZE = RENDERER_SLOT_COUNT * SLOT_BYTE_SIZE;

// ─── Slot metadata written at the start of each slot ────────────────────────

export interface SlotMetadata {
  generation: number;
  frameSequence: number;
  inputWidth: number;
  inputHeight: number;
  pixelByteLength: number;
}

// ─── Registration API type ─────────────────────────────────────────────────

export interface RendererSlotsRegistration {
  /** The 3 shared array buffers, each SLOT_BYTE_SIZE bytes. */
  slots: SharedArrayBuffer[];
  /** Whether registration with main process succeeded. */
  registered: boolean;
}

// ─── RendererInputSlots ─────────────────────────────────────────────────────

export class RendererInputSlots {
  private buffers: SharedArrayBuffer[] | null = null;
  private views: Uint8Array[] | null = null;
  private registered_ = false;
  private slotNext = 0;
  private destroyed_ = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Allocate the 3 shared array buffers.
   * Must be called from the renderer process where SharedArrayBuffer is
   * available (requires appropriate COOP/COEP headers or Electron
   * webPreferences configuration).
   *
   * Returns false if SharedArrayBuffer is not available or if already
   * created/registered.
   */
  create(): boolean {
    if (this.buffers) return false; // already created
    if (typeof SharedArrayBuffer === "undefined") {
      console.warn("[RendererInputSlots] SharedArrayBuffer not available in this context");
      return false;
    }

    try {
      const bufs: SharedArrayBuffer[] = [];
      const views: Uint8Array[] = [];

      for (let i = 0; i < RENDERER_SLOT_COUNT; i++) {
        const sab = new SharedArrayBuffer(SLOT_BYTE_SIZE);
        bufs.push(sab);
        views.push(new Uint8Array(sab));
      }

      this.buffers = bufs;
      this.views = views;
      this.slotNext = 0;

      lifecycleLog("RendererInputSlots", "create", {
        slotCount: RENDERER_SLOT_COUNT,
        slotByteSize: SLOT_BYTE_SIZE,
        totalBytes: RENDERER_RING_TOTAL_SIZE,
      });

      return true;
    } catch (err) {
      console.error("[RendererInputSlots] Allocation failed:", err);
      this.buffers = null;
      this.views = null;
      return false;
    }
  }

  /**
   * Register the allocated slots with the main process.
   * Returns true when registration succeeds.
   */
  async register(
    registerFn: (slots: SharedArrayBuffer[]) => Promise<{ success: boolean }>,
  ): Promise<boolean> {
    if (!this.buffers) return false;
    if (this.registered_) return true; // already registered

    try {
      const result = await registerFn(this.buffers);
      this.registered_ = result.success;

      if (result.success) {
        lifecycleLog("RendererInputSlots", "register", {
          slotCount: RENDERER_SLOT_COUNT,
        });
      }

      return result.success;
    } catch (err) {
      console.error("[RendererInputSlots] Registration failed:", err);
      this.registered_ = false;
      return false;
    }
  }

  /**
   * Release registered slots from the main process.
   * Idempotent.
   */
  async release(
    releaseFn: () => Promise<{ success: boolean }>,
  ): Promise<void> {
    if (!this.registered_) return;
    try {
      await releaseFn();
    } catch { /* best-effort */ }
    this.registered_ = false;
    lifecycleLog("RendererInputSlots", "release", {});
  }

  /**
   * Destroy all resources.
   */
  destroy(): void {
    this.destroyed_ = true;
    this.buffers = null;
    this.views = null;
    this.registered_ = false;
    this.slotNext = 0;
    lifecycleLog("RendererInputSlots", "destroy", {});
  }

  // ── Slot management ────────────────────────────────────────────────────

  /**
   * Get the next slot index in round-robin order.
   */
  nextSlot(): number {
    const idx = this.slotNext;
    this.slotNext = (this.slotNext + 1) % RENDERER_SLOT_COUNT;
    return idx;
  }

  /**
   * Write pixel data to a specific slot, including header metadata.
   * Returns the slot index used, or -1 if not available.
   */
  writeSlot(
    slotIndex: number,
    generation: number,
    frameSequence: number,
    inputWidth: number,
    inputHeight: number,
    pixelData: Uint8Array,
  ): boolean {
    if (!this.views || this.destroyed_) return false;
    if (slotIndex < 0 || slotIndex >= RENDERER_SLOT_COUNT) return false;

    const view = this.views[slotIndex];

    // Write header metadata at the start of the slot
    // (matches SharedMemoryFrameRing header layout for compatibility)
    const dv = new DataView(view.buffer, 0, SLOT_HEADER_SIZE);
    let off = 0;
    // magic: 0x464C4156454D5246n at offset 0 (not strictly needed for renderer→main path)
    dv.setBigUint64(off, BigInt("0x464C4156454D5246"), true); off += 8;
    dv.setUint32(off, SLOT_HEADER_SIZE, true); off += 4; // headerSize
    dv.setUint32(off, 1, true); off += 4; // wireVersion
    dv.setUint32(off, generation, true); off += 4; // generation
    dv.setUint32(off, frameSequence, true); off += 4; // frameSequence
    dv.setBigUint64(off, BigInt(Date.now() * 1000), true); off += 8; // capturedAtUs
    dv.setUint32(off, inputWidth, true); off += 4;
    dv.setUint32(off, inputHeight, true); off += 4;
    dv.setUint32(off, inputWidth * 4, true); off += 4; // inputStride
    dv.setUint32(off, 2, true); off += 4; // pixelFormat = RGBA8
    dv.setUint32(off, 0, true); off += 4; // outWidth (0 = same as input)
    dv.setUint32(off, 0, true); off += 4; // outHeight
    dv.setUint32(off, slotIndex, true); off += 4; // slotIndex
    dv.setUint32(off, pixelData.byteLength, true); off += 4; // payloadBytes
    // remaining header fields are zeroed (not used for renderer→main direction)

    // Write pixel data after the header
    const pixelView = new Uint8Array(view.buffer, SLOT_HEADER_SIZE);
    if (pixelData.byteLength > pixelView.byteLength) return false;
    pixelView.set(pixelData);

    return true;
  }

  /**
   * Read pixel data from a slot (for verification/testing).
   */
  readSlot(slotIndex: number): Uint8Array | null {
    if (!this.views || this.destroyed_) return null;
    if (slotIndex < 0 || slotIndex >= RENDERER_SLOT_COUNT) return null;

    const view = this.views[slotIndex];
    const dv = new DataView(view.buffer, 0, SLOT_HEADER_SIZE);
    const payloadBytes = dv.getUint32(60, true); // payloadBytes offset in header

    if (payloadBytes === 0 || payloadBytes > MAX_FRAME_PIXEL_BYTES) return null;

    return new Uint8Array(view.buffer, SLOT_HEADER_SIZE, payloadBytes);
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get isCreated(): boolean {
    return this.buffers !== null;
  }

  get isRegistered(): boolean {
    return this.registered_;
  }

  get byteSize(): number {
    return RENDERER_RING_TOTAL_SIZE;
  }

  get slotCount(): number {
    return RENDERER_SLOT_COUNT;
  }

  get buffers_(): readonly SharedArrayBuffer[] | null {
    return this.buffers;
  }

  get isDestroyed(): boolean {
    return this.destroyed_;
  }
}
