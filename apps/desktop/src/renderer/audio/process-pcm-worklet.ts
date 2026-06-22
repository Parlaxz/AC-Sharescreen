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
    if (actual === 0) {
      this.underrunFrames += frameCount;
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
  private primedFrames = 0;
  private discontinuityPending = false;

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

          // Track primed state
          if (!this.primed) {
            this.primedFrames += written;
            if (this.primedFrames >= kTargetBufferFrames) {
              this.primed = true;
              this.port.postMessage({ type: 'pcm:primed' });
            }
          }
        } else {
          this.stats.invalidMessages++;
        }
        break;
      }

      case 'pcm:reset': {
        this.ringBuffer.reset();
        this.primed = false;
        this.primedFrames = 0;
        this.discontinuityPending = false;
        break;
      }

      case 'pcm:discontinuity': {
        this.discontinuityPending = true;
        this.stats.discontinuities++;
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
    const output = outputs[0];
    if (!output || output.length < 2) {
      // No output channels — keep processor alive
      return true;
    }

    const renderQuantum = output[0].length; // Typically 128

    // Zero-fill output initially (underrun case handled by ring buffer read)
    const framesRead = this.ringBuffer.read(output, renderQuantum);
    this.stats.framesRendered += framesRead;
    this.stats.underrunFrames = this.ringBuffer.underrun;

    if (framesRead === 0) {
      this.stats.silentFrames += renderQuantum;
    }

    // Track discontinuity on this render quantum
    if (this.discontinuityPending) {
      this.discontinuityPending = false;
      // Zero out this quantum to avoid audible glitch from stale data
      // The ring buffer already dropped stale data
    }

    // Update buffer depth stats
    this.stats.currentBufferDepth = this.ringBuffer.framesAvailable;
    this.stats.maxBufferDepth = Math.max(
      this.stats.maxBufferDepth,
      this.ringBuffer.framesAvailable,
    );

    // Send periodic stats
    if (this.stats.framesRendered % (480 * 100) === 0) {
      // Every ~100 packets
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
