/**
 * Bounded ring buffer for interleaved float32 stereo PCM.
 * Supports arbitrary write sizes and read sizes.
 * Thread-safe guard: designed to be used from a single consumer (worklet process())
 * and a single producer (MessagePort message handler). No internal locks.
 */
export class PcmRingBuffer {
  private buffer: Float32Array;
  private writeIndex: number = 0;
  private readIndex: number = 0;
  private frameCapacity: number;
  private framesAvailable_: number = 0;
  private totalFramesWritten: number = 0;
  private totalFramesRead: number = 0;
  private overrunFrames: number = 0;
  private underrunFrames: number = 0;

  constructor(capacityFrames: number, private channels: number = 2) {
    this.frameCapacity = capacityFrames;
    this.buffer = new Float32Array(capacityFrames * channels);
  }

  /** Write interleaved samples. Returns frames actually written (may be less on overrun). */
  write(samples: Float32Array, frameCount: number): number {
    const sampleCount = frameCount * this.channels;
    if (sampleCount === 0) return 0;

    // If buffer would overflow, drop oldest frames
    const framesAvailable = this.framesAvailable_;
    const freeFrames = this.frameCapacity - framesAvailable;
    const framesToDrop = frameCount - freeFrames;

    if (framesToDrop > 0) {
      // Advance read pointer to free space
      const dropSamples = framesToDrop * this.channels;
      this.readIndex = (this.readIndex + dropSamples) % this.buffer.length;
      this.framesAvailable_ -= framesToDrop;
      this.overrunFrames += framesToDrop;
      // If we dropped everything, return 0 (consumer will see discontinuity)
    }

    const actualFrameCount = Math.min(frameCount, this.frameCapacity);
    const actualSampleCount = actualFrameCount * this.channels;

    // Write samples with wraparound
    for (let i = 0; i < actualSampleCount; i++) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
    }

    this.framesAvailable_ += actualFrameCount;
    this.totalFramesWritten += actualFrameCount;
    return actualFrameCount;
  }

  /** Write from a Float32Array directly (interleaved). */
  writeInterleaved(data: Float32Array): number {
    const frameCount = data.length / this.channels;
    return this.write(data, frameCount);
  }

  /**
   * Read frames into the output arrays (planar format for Web Audio).
   * Returns actual frames read.
   */
  read(output: Float32Array[], frameCount: number): number {
    if (output.length < this.channels) return 0;

    const actual = Math.min(frameCount, this.framesAvailable_);
    if (actual === 0) {
      this.underrunFrames += frameCount;
      // Write zeros to output
      for (let ch = 0; ch < this.channels; ch++) {
        output[ch].fill(0, 0, frameCount);
      }
      return 0;
    }

    for (let f = 0; f < actual; f++) {
      for (let ch = 0; ch < this.channels; ch++) {
        output[ch][f] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.buffer.length;
      }
    }

    // If fewer frames read than requested, zero-fill remaining
    for (let ch = 0; ch < this.channels; ch++) {
      for (let f = actual; f < frameCount; f++) {
        output[ch][f] = 0;
      }
    }

    this.framesAvailable_ -= actual;
    this.totalFramesRead += actual;
    return actual;
  }

  get framesAvailable(): number {
    return this.framesAvailable_;
  }

  get capacity(): number {
    return this.frameCapacity;
  }

  get overrunFrames(): number {
    return this.overrunFrames;
  }

  get underrunFrames(): number {
    return this.underrunFrames;
  }

  get totalWritten(): number {
    return this.totalFramesWritten;
  }

  get totalRead(): number {
    return this.totalFramesRead;
  }

  reset(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.framesAvailable_ = 0;
    this.totalFramesWritten = 0;
    this.totalFramesRead = 0;
    this.overrunFrames = 0;
    this.underrunFrames = 0;
  }
}
