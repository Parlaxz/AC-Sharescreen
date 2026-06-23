/**
 * ProcessPcmWorklet — AudioWorkletProcessor for ScreenLink PCM transport.
 *
 * Expected output shape: exactly 2 channels (stereo).
 * A single bounded fatal is emitted if the shape is wrong; process() continues
 * returning true (filling zero) to keep the graph alive for diagnostics.
 */

const kBufferFrames = 8192;
const kTargetBufferFrames = 3840;

interface WorkletMessage {
  type: 'pcm:data' | 'pcm:reset' | 'pcm:discontinuity';
  data?: Float32Array;
  frameCount?: number;
  streamGeneration?: number;
}

interface WorkletStats {
  /** Lifetime counters (never reset). */
  framesReceived: number;
  framesRendered: number;
  silentFrames: number;
  underrunFrames: number;
  overrunFrames: number;
  droppedFrames: number;
  discontinuities: number;
  maxBufferDepth: number;
  messagesReceived: number;
  invalidMessages: number;
  processCalls: number;
  outputFrames: number;
  underflowFrames: number;

  /** Per-report counters (reset after each stats post). */
  nonZeroSamples: number;

  /** Current instantaneous values. */
  currentBufferDepth: number;
  targetBufferDepth: number;
  peak: number;
  rms: number;
  ringFramesAvailable: number;

  /** Accumulator for ~1s reporting interval. */
  framesSinceReport: number;
  hasRenderedNonZero: boolean;
  /** Real stream generation (propagated from native capture). */
  streamGeneration: number;
}

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
    for (let f = 0; f < actual; f++) {
      for (let ch = 0; ch < this.channels; ch++) {
        output[ch][f] = this.buffer[this.readIndex++];
      }
    }
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

  get framesAvailable(): number { return this.framesAvailable_; }
  get overrun(): number { return this.overrunFrames; }
  get underrun(): number { return this.underrunFrames; }

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

class ProcessPcmWorklet extends AudioWorkletProcessor {
  private ringBuffer: PcmRingBuffer;
  private stats: WorkletStats;
  private primed = false;
  private renderedNonZero = false;
  private outputShapeReported = false;
  private fatalShapeReported = false;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.ringBuffer = new PcmRingBuffer(kBufferFrames, 2);
    this.stats = {
      framesReceived: 0, framesRendered: 0, silentFrames: 0,
      underrunFrames: 0, overrunFrames: 0, droppedFrames: 0, discontinuities: 0,
      maxBufferDepth: 0, messagesReceived: 0, invalidMessages: 0,
      processCalls: 0, outputFrames: 0, underflowFrames: 0,
      nonZeroSamples: 0,
      currentBufferDepth: 0, targetBufferDepth: kTargetBufferFrames,
      peak: 0, rms: 0, ringFramesAvailable: 0,
      framesSinceReport: 0, hasRenderedNonZero: false,
      streamGeneration: 0,
    };

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
        // Apply real stream generation if provided
        if (msg.streamGeneration !== undefined) {
          this.stats.streamGeneration = msg.streamGeneration;
        }
        this.ringBuffer.reset();
        this.primed = false;
        this.renderedNonZero = false;
        break;
      }

      case 'pcm:discontinuity': {
        this.stats.discontinuities++;
        this.ringBuffer.flushAudio();
        this.primed = false;
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

    // Report output shape on first call
    if (!this.outputShapeReported) {
      this.outputShapeReported = true;
      const channelCount = output ? output.length : 0;
      this.port.postMessage({
        type: 'pcm:output-shape',
        outputCount: outputs.length,
        channelCount,
        quantumFrames: output && output[0] ? output[0].length : 0,
        sampleRate: sampleRate,
        generation: this.stats.streamGeneration,
      });
    }

    // Validate output shape — exactly 2 channels supported.
    // Emit fatal once; always zero-fill to keep graph alive.
    if (!output || output.length !== 2) {
      if (!this.fatalShapeReported) {
        this.fatalShapeReported = true;
        this.port.postMessage({
          type: 'pcm:fatal',
          error: 'invalid-output-channel-count',
          expectedChannels: 2,
          actualChannels: output ? output.length : 0,
          generation: this.stats.streamGeneration,
        });
      }
      if (output) {
        for (let ch = 0; ch < output.length; ch++) {
          output[ch].fill(0);
        }
      }
      this.stats.outputFrames += output && output[0] ? output[0].length : 128;
      return true;
    }

    const renderQuantum = output[0].length;

    // Not primed — silence, preserve buffer
    if (!this.primed) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
      this.stats.silentFrames += renderQuantum;
      this.stats.outputFrames += renderQuantum;
      return true;
    }

    // Normal processing: read from ring buffer
    const framesRead = this.ringBuffer.read(output, renderQuantum);
    this.stats.framesRendered += framesRead;
    this.stats.underrunFrames = this.ringBuffer.underrun;
    this.stats.outputFrames += renderQuantum;
    this.stats.framesSinceReport += renderQuantum;

    if (framesRead === 0) {
      this.stats.silentFrames += renderQuantum;
    }

    // Calculate render diagnostics
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

    if (framesRead < renderQuantum) {
      this.stats.underflowFrames += renderQuantum - framesRead;
    }

    this.stats.ringFramesAvailable = this.ringBuffer.framesAvailable;
    this.stats.currentBufferDepth = this.ringBuffer.framesAvailable;
    this.stats.maxBufferDepth = Math.max(
      this.stats.maxBufferDepth,
      this.ringBuffer.framesAvailable,
    );

    // Emit pcm:rendering once nonzero output has been produced
    if (!this.renderedNonZero && samplePeak > 0) {
      this.renderedNonZero = true;
      this.stats.hasRenderedNonZero = true;
      this.port.postMessage({
        type: 'pcm:rendering',
        peak: samplePeak,
        rms: this.stats.rms,
        framesRendered: this.stats.framesRendered,
        generation: this.stats.streamGeneration,
      });
    }

    // Periodic stats: snapshot, then reset interval-only counters.
    // Use accumulator to avoid depending on exact modulo.
    if (this.stats.framesSinceReport >= 48000) {
      // Snapshot: copy per-interval fields into the report
      const report = { ...this.stats };
      this.port.postMessage({ type: 'pcm:stats', stats: report });

      // Reset interval-only counters; preserve lifetime counters.
      this.stats.nonZeroSamples = 0;
      this.stats.framesSinceReport -= 48000;
      // If drift accumulated beyond a second, keep it (don't truncate)
    }

    return true;
  }
}

registerProcessor('process-pcm-worklet', ProcessPcmWorklet);
