/**
 * ProcessPcmWorklet — AudioWorkletProcessor for ScreenLink PCM transport.
 *
 * Receives float32 interleaved PCM samples from the renderer's main thread
 * through its MessagePort, stores them in a ring buffer, and serves them
 * to the audio rendering callback.
 */

// Import types are not available in AudioWorklet scope
// (AudioWorkletGlobalScope), so we use inline types.

interface WorkletMessage {
  type: 'pcm:data' | 'pcm:reset' | 'pcm:discontinuity';
  /** Interleaved float32 PCM data */
  data?: Float32Array;
  /** Frame count for this message */
  frameCount?: number;
  /** New stream generation on reset */
  streamGeneration?: number;
}

interface WorkletStats {
  framesReceived: number;
  framesRendered: number;
  silentFrames: number;
  underrunFrames: number;
  overrunFrames: number;
  droppedFrames: number;
  discontinuities: number;
  maxBufferDepth: number;
  currentBufferDepth: number;
  targetBufferDepth: number;
  messagesReceived: number;
  invalidMessages: number;
  /** Render diagnostic fields */
  peak: number;
  rms: number;
  nonZeroSamples: number;
  processCalls: number;
  outputFrames: number;
  underflowFrames: number;
  ringFramesAvailable: number;
}

/**
 * Self-contained ring buffer for AudioWorklet scope.
 * Logic mirrors PcmRingBuffer but cannot import it due to
 * AudioWorklet scope restrictions.
 */
class PcmRingBuffer {
  private buffer: Float32Array;
  private writeIndex = 0;
  private readIndex = 0;
  private framesAvailable_ = 0;
  private frameCapacity: number;
  private totalWritten = 0;
  private totalRead = 0;
  private overrunFrames = 0;
  private underrunFrames = 0;
  private readonly channels: number;

  constructor(capacityFrames: number, channels = 2) {
    this.frameCapacity = capacityFrames;
    this.channels = channels;
    this.buffer = new Float32Array(capacityFrames * channels);
  }

  write(samples: Float32Array, frameCount: number): number {
    const avail = this.framesAvailable_;
    const free = this.frameCapacity - avail;
    const toDrop = frameCount - free;
    if (toDrop > 0) {
      const dropSamples = toDrop * this.channels;
      this.readIndex = (this.readIndex + dropSamples) % this.buffer.length;
      this.framesAvailable_ -= toDrop;
      this.overrunFrames += toDrop;
    }
    const actual = Math.min(frameCount, this.frameCapacity);
    const sampleCount = actual * this.channels;
    for (let i = 0; i < sampleCount; i++) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
    }
    this.framesAvailable_ += actual;
    this.totalWritten += actual;
    return actual;
  }

  read(output: Float32Array[], frameCount: number): number {
    const actual = Math.min(frameCount, this.framesAvailable_);
    if (actual < frameCount) {
      this.underrunFrames += (frameCount - actual);
    }
    if (actual === 0) {
      for (let ch = 0; ch < this.channels; ch++) {
        output[ch].fill(0, 0, frameCount);
      }
      return 0;
    }
    // Read interleaved buffer into planar output
    for (let f = 0; f < actual; f++) {
      for (let ch = 0; ch < this.channels; ch++) {
        output[ch][f] = this.buffer[this.readIndex++];
      }
    }
    // Handle wraparound
    this.readIndex %= this.buffer.length;

    for (let ch = 0; ch < this.channels; ch++) {
      for (let f = actual; f < frameCount; f++) {
        output[ch][f] = 0;
      }
    }

    this.framesAvailable_ -= actual;
    this.totalRead += actual;
    return actual;
  }

  get framesAvailable(): number {
    return this.framesAvailable_;
  }

  get capacity(): number {
    return this.frameCapacity;
  }

  get overrun(): number {
    return this.overrunFrames;
  }

  get underrun(): number {
    return this.underrunFrames;
  }

  get totalRenderedFrames(): number {
    return this.totalRead;
  }

  get totalReceivedFrames(): number {
    return this.totalWritten;
  }

  flushAudio(): void {
    this.framesAvailable_ = 0;
    this.writeIndex = 0;
    this.readIndex = 0;
  }

  reset(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.framesAvailable_ = 0;
    this.totalWritten = 0;
    this.totalRead = 0;
    this.overrunFrames = 0;
    this.underrunFrames = 0;
  }
}

// Buffer sizes: 8192 frames = ~170ms at 48kHz (within 250ms hard limit)
const kBufferFrames = 8192;
const kTargetBufferFrames = 3840; // ~80ms target priming

class ProcessPcmWorklet extends AudioWorkletProcessor {
  private ringBuffer: PcmRingBuffer;
  private stats: WorkletStats;
  private primed = false;
  private discontinuityPending = false;
  private currentStreamGeneration: number = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.ringBuffer = new PcmRingBuffer(kBufferFrames, 2);
    this.stats = {
      framesReceived: 0,
      framesRendered: 0,
      silentFrames: 0,
      underrunFrames: 0,
      overrunFrames: 0,
      droppedFrames: 0,
      discontinuities: 0,
      maxBufferDepth: 0,
      currentBufferDepth: 0,
      targetBufferDepth: kTargetBufferFrames,
      messagesReceived: 0,
      invalidMessages: 0,
      peak: 0,
      rms: 0,
      nonZeroSamples: 0,
      processCalls: 0,
      outputFrames: 0,
      underflowFrames: 0,
      ringFramesAvailable: 0,
    };

    // Receive messages from the renderer main thread
    this.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      this.handleMessage(event.data);
    };
  }

  private handleMessage(msg: WorkletMessage): void {
    this.stats.messagesReceived++;

    switch (msg.type) {
      case 'pcm:data': {
        if (msg.data && msg.frameCount && msg.data.length > 0) {
          const written = this.ringBuffer.write(msg.data, msg.frameCount);
          this.stats.framesReceived += written;
          this.stats.overrunFrames = this.ringBuffer.overrun;

          // Check if primed — use actual buffer depth, not cumulative
          if (!this.primed && this.ringBuffer.framesAvailable >= kTargetBufferFrames) {
            this.primed = true;
            this.port.postMessage({ type: 'pcm:primed' });
          }
        } else {
          this.stats.invalidMessages++;
        }
        break;
      }

      case 'pcm:reset': {
        this.ringBuffer.reset();
        this.primed = false;
        this.discontinuityPending = false;
        break;
      }

      case 'pcm:discontinuity': {
        this.discontinuityPending = true;
        this.stats.discontinuities++;
        // Flush pre-discontinuity audio, preserve session counters
        this.ringBuffer.flushAudio();
        this.primed = false; // Must re-prime after discontinuity
        break;
      }

      default:
        this.stats.invalidMessages++;
        break;
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _params: Record<string, Float32Array>,
  ): boolean {
    this.stats.processCalls++;
    const output = outputs[0];
    if (!output || output.length < 2) {
      // No output channels — keep processor alive
      return true;
    }

    const renderQuantum = output[0].length; // Typically 128

    // If not primed yet, output silence without consuming buffer
    if (!this.primed) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
      this.stats.silentFrames += renderQuantum;
      this.stats.outputFrames += renderQuantum;
      return true;
    }

    // Normal processing
    const framesRead = this.ringBuffer.read(output, renderQuantum);
    this.stats.framesRendered += framesRead;
    this.stats.underrunFrames = this.ringBuffer.underrun;
    this.stats.outputFrames += renderQuantum;

    if (framesRead === 0) {
      this.stats.silentFrames += renderQuantum;
    }

    // Calculate render diagnostics (peak, RMS, non-zero samples)
    let sumSquares = 0;
    let samplePeak = 0;
    let nonZero = 0;
    for (let ch = 0; ch < output.length; ch++) {
      for (let f = 0; f < renderQuantum; f++) {
        const s = output[ch][f];
        const abs = Math.abs(s);
        if (abs > samplePeak) samplePeak = abs;
        sumSquares += s * s;
        if (abs > 0) nonZero++;
      }
    }
    this.stats.peak = samplePeak;
    this.stats.rms = Math.sqrt(sumSquares / (renderQuantum * output.length));
    this.stats.nonZeroSamples += nonZero;

    // Track underflow frames (requested frames that were not available)
    if (framesRead < renderQuantum) {
      this.stats.underflowFrames += renderQuantum - framesRead;
    }

    // Update buffer depth stats
    this.stats.ringFramesAvailable = this.ringBuffer.framesAvailable;
    this.stats.currentBufferDepth = this.ringBuffer.framesAvailable;
    this.stats.maxBufferDepth = Math.max(
      this.stats.maxBufferDepth,
      this.ringBuffer.framesAvailable,
    );

    // Send periodic stats every ~1 second at 48kHz
    if (this.stats.framesRendered % 48000 === 0) {
      // Reset per-second diagnostics
      this.stats.nonZeroSamples = 0;
      this.port.postMessage({
        type: 'pcm:stats',
        stats: { ...this.stats },
      });
    }

    // Return true to keep processor alive
    return true;
  }
}

registerProcessor('process-pcm-worklet', ProcessPcmWorklet);
