import * as fs from "node:fs";

// ─── Wire format constants (must match C++ FrameHeader layout) ─────────
const FRAME_MAGIC = 0x464C4156454D5246n;
const HEADER_SIZE = 104;
const kMaxFrameSize = 33_177_600; // 3840 * 2160 * 4 RGBA
const kRingSlotCount = 3;

// Slot layout offsets (must match SharedFrameRing.h RingSlotLayout):
//   control(4) + padding(4) + FrameHeader(104) + inputPixels(kMaxFrameSize) + outputPixels(kMaxFrameSize)
const SLOT_HEADER_OFFSET = 8;
const SLOT_INPUT_OFFSET = SLOT_HEADER_OFFSET + HEADER_SIZE;
const SLOT_OUTPUT_OFFSET = SLOT_INPUT_OFFSET + kMaxFrameSize;
const SLOT_BYTE_SIZE = SLOT_OUTPUT_OFFSET + kMaxFrameSize;

// ─── Slot states (must match C++ SlotState enum) ───────────────────────

export const SlotState = {
  Empty: 0,
  Submitted: 1,
  Processing: 2,
  Done: 3,
  Error: 4,
} as const;

// ─── SharedMemoryFrameRing ─────────────────────────────────────────────

/**
 * File-backed shared-memory ring for zero-copy frame transport between
 * the Electron main process and the native video-enhancer helper.
 *
 * Both processes open the same temp file (created by the helper via
 * CreateFileMapping).  The helper maps it with MapViewOfFile (zero-copy).
 * The main process uses fs.readSync / fs.writeSync at per-slot file offsets.
 *
 * Coordination: slot control words (uint32) + async JSON messages
 * over the control named pipe (slotSubmit command + slotCompleted event).
 *
 * Up to 3 frames can be in-flight simultaneously (Sliver 4).
 *
 * Fallback: when open() fails, the caller uses the existing named-pipe
 * frame transport (FramePipeParser + net.Socket).
 */
export class SharedMemoryFrameRing {
  private fd: number | null = null;
  private path_: string = "";

  // ── File management ────────────────────────────────────────────────

  /** Open the backing temp file. Returns true on success. */
  open(filePath: string): boolean {
    if (this.fd !== null) this.close();
    try {
      this.fd = fs.openSync(filePath, "r+");
      this.path_ = filePath;
      return true;
    } catch (err) {
      console.error("[SharedMemoryRing] open failed:", filePath, err);
      this.fd = null;
      return false;
    }
  }

  /** Close the file descriptor. Idempotent. */
  close(): void {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }

  get isOpen(): boolean {
    return this.fd !== null;
  }

  get filePath(): string {
    return this.path_;
  }

  // ── Per-slot file offset helpers ────────────────────────────────────

  private slotOffset(slotIndex: number, fieldOffset: number): number {
    return slotIndex * SLOT_BYTE_SIZE + fieldOffset;
  }

  private slotHeaderOffset(slotIndex: number): number {
    return this.slotOffset(slotIndex, SLOT_HEADER_OFFSET);
  }

  private slotInputOffset(slotIndex: number): number {
    return this.slotOffset(slotIndex, SLOT_INPUT_OFFSET);
  }

  private slotOutputOffset(slotIndex: number): number {
    return this.slotOffset(slotIndex, SLOT_OUTPUT_OFFSET);
  }

  // ── Control word operations ────────────────────────────────────────

  /** Read the 4-byte control word at a slot. Returns -1 on error. */
  readControl(slotIndex: number): number {
    if (this.fd === null) return -1;
    const buf = Buffer.alloc(4);
    try {
      fs.readSync(this.fd, buf, 0, 4, this.slotOffset(slotIndex, 0));
      return buf.readUInt32LE(0);
    } catch {
      return -1;
    }
  }

  /** Write a control word to a slot. Returns true on success. */
  writeControl(slotIndex: number, state: number): boolean {
    if (this.fd === null) return false;
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(state, 0);
    try {
      fs.writeSync(this.fd, buf, 0, 4, this.slotOffset(slotIndex, 0));
      return true;
    } catch {
      return false;
    }
  }

  /** Find the first slot with control == Empty. Returns -1 if none. */
  findEmptySlot(): number {
    for (let i = 0; i < kRingSlotCount; i++) {
      if (this.readControl(i) === SlotState.Empty) return i;
    }
    return -1;
  }

  // ── Frame I/O ──────────────────────────────────────────────────────

  /**
   * Write a frame header + pixel data to a slot's input region.
   * The caller must first ensure the slot is Empty.
   */
  writeInput(
    slotIndex: number,
    generation: number,
    frameSequence: number,
    inputWidth: number,
    inputHeight: number,
    inputStride: number,
    pixelFormat: number,
    outWidth: number,
    outHeight: number,
    modeNum: number,
    qualNum: number,
    frameData: Uint8Array,
  ): boolean {
    if (this.fd === null) return false;

    const hdr = Buffer.alloc(HEADER_SIZE);
    let off = 0;
    hdr.writeBigUInt64LE(FRAME_MAGIC, off); off += 8;
    hdr.writeUInt32LE(HEADER_SIZE, off); off += 4;
    hdr.writeUInt32LE(1, off); off += 4;                  // wireVersion
    hdr.writeUInt32LE(generation, off); off += 4;
    hdr.writeUInt32LE(frameSequence, off); off += 4;
    hdr.writeBigUInt64LE(BigInt(Date.now() * 1000), off); off += 8; // capturedAtUs
    hdr.writeUInt32LE(inputWidth, off); off += 4;
    hdr.writeUInt32LE(inputHeight, off); off += 4;
    hdr.writeUInt32LE(inputStride, off); off += 4;
    hdr.writeUInt32LE(pixelFormat, off); off += 4;
    hdr.writeUInt32LE(outWidth, off); off += 4;
    hdr.writeUInt32LE(outHeight, off); off += 4;
    hdr.writeUInt32LE(0, off); off += 4;                  // slotIndex
    hdr.writeUInt32LE(frameData.byteLength, off); off += 4; // payloadBytes
    hdr.writeUInt32LE(modeNum, off); off += 4;
    hdr.writeUInt32LE(qualNum, off); off += 4;
    hdr.writeUInt32LE(0, off); off += 4;                  // flags
    hdr.writeUInt32LE(0, off); off += 4;                  // resultCode
    hdr.writeUInt32LE(0, off); off += 4;                  // nativeInputReceiveUs
    hdr.writeUInt32LE(0, off); off += 4;
    hdr.writeUInt32LE(0, off); off += 4;
    hdr.writeUInt32LE(0, off); off += 4;
    hdr.writeUInt32LE(0, off); off += 4;
    hdr.writeUInt32LE(0, off);                           // nativeTotalUs

    try {
      fs.writeSync(this.fd, hdr, 0, HEADER_SIZE, this.slotHeaderOffset(slotIndex));
      const pix = Buffer.from(frameData.buffer, frameData.byteOffset, frameData.byteLength);
      fs.writeSync(this.fd, pix, 0, pix.length, this.slotInputOffset(slotIndex));
      return true;
    } catch (err) {
      console.error("[SharedMemoryRing] writeInput error:", err);
      return false;
    }
  }

  /**
   * Read the output header + pixel data from a slot after processing.
   * Returns null if the slot is not in Done/Error state or on I/O error.
   */
  readOutput(slotIndex: number): {
    generation: number;
    frameSequence: number;
    resultCode: number;
    payloadBytes: number;
    width: number;
    height: number;
    configurationId: number;
    appliedQualityLevel: number;
    nativeInputReceiveUs: number;
    nativeUploadUs: number;
    nativeEffectUs: number;
    nativeDownloadUs: number;
    nativeTotalUs: number;
    pixels: Uint8Array;
  } | null {
    if (this.fd === null) return null;

    const ctrl = this.readControl(slotIndex);
    if (ctrl !== SlotState.Done && ctrl !== SlotState.Error) return null;

    const hdrBuf = Buffer.alloc(HEADER_SIZE);
    try {
      fs.readSync(this.fd, hdrBuf, 0, HEADER_SIZE, this.slotHeaderOffset(slotIndex));
    } catch {
      return null;
    }

    if (hdrBuf.readBigUInt64LE(0) !== FRAME_MAGIC) return null;

    const resultCode = hdrBuf.readUInt32LE(76);
    const payloadBytes = hdrBuf.readUInt32LE(60);

    const out = {
      generation: hdrBuf.readUInt32LE(16),
      frameSequence: hdrBuf.readUInt32LE(20),
      resultCode,
      payloadBytes,
      width: hdrBuf.readUInt32LE(32),
      height: hdrBuf.readUInt32LE(36),
      configurationId: hdrBuf.readUInt32LE(56),
      appliedQualityLevel: hdrBuf.readUInt32LE(72),
      nativeInputReceiveUs: hdrBuf.readUInt32LE(80),
      nativeUploadUs: hdrBuf.readUInt32LE(84),
      nativeEffectUs: hdrBuf.readUInt32LE(88),
      nativeDownloadUs: hdrBuf.readUInt32LE(92),
      nativeTotalUs: hdrBuf.readUInt32LE(100),
      pixels: new Uint8Array(0),
    };

    if (resultCode === 1 && payloadBytes > 0 && payloadBytes <= kMaxFrameSize) {
      const pixBuf = Buffer.alloc(payloadBytes);
      try {
        fs.readSync(this.fd, pixBuf, 0, payloadBytes, this.slotOutputOffset(slotIndex));
      } catch {
        return null;
      }
      out.pixels = new Uint8Array(pixBuf);
    }

    return out;
  }
}
