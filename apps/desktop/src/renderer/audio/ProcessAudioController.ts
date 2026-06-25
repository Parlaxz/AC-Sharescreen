/// <reference types="vite/client" />

import processPcmWorkletUrl from './process-pcm-worklet.ts?worker&url';

export type AudioWorkletState =
  | 'closed'
  | 'loading'
  | 'loaded'
  | 'buffering'
  | 'primed'
  | 'rendering'
  | 'error';

export interface WorkletStatsReport {
  framesReceived: number;
  framesRendered: number;
  silentFrames: number;
  underrunFrames: number;
  overrunFrames: number;
  discontinuities: number;
  maxBufferDepth: number;
  currentBufferDepth: number;
  peak: number;
  rms: number;
  nonZeroSamples: number;
  processCalls: number;
  outputFrames: number;
  underflowFrames: number;
  ringFramesAvailable: number;
}

type Waiter = { type: 'primed' | 'rendering'; resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ProcessAudioController {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private mediaDestination: MediaStreamAudioDestinationNode | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private port: MessagePort | null = null;
  private state: AudioWorkletState = 'closed';
  private onStateChange: ((state: AudioWorkletState) => void) | null = null;
  private onStats: ((stats: WorkletStatsReport) => void) | null = null;
  private currentStreamGeneration: number = -1;
  private outputShapeOk = false;
  private fatalError: string | null = null;
  private closed_ = false;
  private static nextId = 0;
  private readonly instanceId: number;
  private closeOwner: string | null = null;

  /** Permanent worklet message handler (stored for removeEventListener during close). */
  private workletMessageHandler: ((event: MessageEvent) => void) | null = null;
  /** Permanent port message handler. */
  private portMessageHandler: ((event: MessageEvent) => void) | null = null;
  private portMessageErrorHandler: ((event: MessageEvent) => void) | null = null;

  /** Internal waiters for priming/rendering. */
  private waiters: Waiter[] = [];

  readonly TARGET_FRAMES = 3840;
  readonly PRIMING_TIMEOUT_MS = 5000;
  readonly RENDERING_TIMEOUT_MS = 5000;
  readonly SAMPLE_RATE = 48000;

  constructor() {
    ProcessAudioController.nextId++;
    this.instanceId = ProcessAudioController.nextId;
  }

  async initialize(
    pcmPort: MessagePort,
    callbacks?: {
      onStateChange?: (state: AudioWorkletState) => void;
      onStats?: (stats: WorkletStatsReport) => void;
    },
  ): Promise<void> {
    this.onStateChange = callbacks?.onStateChange ?? null;
    this.onStats = callbacks?.onStats ?? null;
    this.state = 'loading';
    this.onStateChange?.('loading');

    try {
      this.audioContext = new AudioContext({
        sampleRate: this.SAMPLE_RATE,
        latencyHint: 'interactive',
      });

      if (this.audioContext.sampleRate !== this.SAMPLE_RATE) {
        throw new Error(`Unsupported sample rate: ${this.audioContext.sampleRate} (expected ${this.SAMPLE_RATE})`);
      }

      await this.audioContext.audioWorklet.addModule(
        processPcmWorkletUrl,
      );

      this.state = 'loaded';
      this.onStateChange?.('loaded');

      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        'process-pcm-worklet',
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        },
      );
      this.state = 'buffering';
      this.onStateChange?.('buffering');

      // Set up permanent MessagePort listener (NEVER replaced)
      this.port = pcmPort;
      this.portMessageHandler = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'pcm:handshake': break;
          case 'pcm:packet':
            this.handlePcmPacket(msg.packet);
            break;
          case 'pcm:reset':
            this.currentStreamGeneration = msg.streamGeneration ?? this.currentStreamGeneration;
            this.workletNode?.port.postMessage({
              type: 'pcm:reset',
              streamGeneration: msg.streamGeneration ?? this.currentStreamGeneration,
            });
            break;
          case 'pcm:canary': break;
        }
      };
      this.port.addEventListener('message', this.portMessageHandler);

      this.portMessageErrorHandler = (event: MessageEvent) => {
        console.error('[ProcessAudioController] Port messageerror:', event);
      };
      this.port.addEventListener('messageerror', this.portMessageErrorHandler);

      this.port.start();
      this.port.postMessage({ type: 'pcm:ready' });

      // Set up permanent worklet message listener (NEVER replaced)
      this.workletMessageHandler = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {
          case 'pcm:primed':
            if (this.state === 'buffering') {
              this.state = 'primed';
              this.onStateChange?.('primed');
            }
            this.resolveWaiters('primed');
            break;

          case 'pcm:rendering':
            if (this.state !== 'rendering') {
              this.state = 'rendering';
              this.onStateChange?.('rendering');
            }
            this.resolveWaiters('rendering');
            break;

          case 'pcm:output-shape':
            this.outputShapeOk = msg.channelCount === 2;
            break;

          case 'pcm:fatal':
            this.fatalError = msg.error;
            this.state = 'error';
            this.onStateChange?.('error');
            this.rejectAllWaiters(new Error(`Worklet fatal: ${msg.error}`));
            break;

          case 'pcm:stats':
            this.onStats?.(msg.stats);
            break;
        }
      };
      this.workletNode.port.addEventListener('message', this.workletMessageHandler);
      this.workletNode.port.start();

      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0;

      this.mediaDestination = this.audioContext.createMediaStreamDestination();
      this.workletNode.connect(this.analyserNode);
      this.analyserNode.connect(this.mediaDestination);

      const tracks = this.mediaDestination.stream.getAudioTracks();
      if (tracks.length !== 1) {
        throw new Error(`Expected 1 audio track, got ${tracks.length}`);
      }
      this.audioTrack = tracks[0];

      if (this.audioContext.state === 'suspended') {
        try { await this.audioContext.resume(); } catch { /* best effort */ }
      }

      this.sampleAnalyser('post-init');
    } catch (err) {
      this.state = 'error';
      this.onStateChange?.('error');
      await this.close();
      throw err;
    }
  }

  /** Forward a PCM packet to the worklet, checking stream-generation. */
  private handlePcmPacket(packet: any): void {
    if (!this.workletNode || this.closed_) return;

    if (this.currentStreamGeneration < 0) {
      this.currentStreamGeneration = packet.streamGeneration;
    } else if (packet.streamGeneration !== this.currentStreamGeneration) {
      return; // stale generation — discard
    }

    if (packet.flags & 2 || packet.droppedPackets > 0) {
      this.workletNode.port.postMessage({ type: 'pcm:discontinuity' });
    }

    const pcmFloat32 = new Float32Array(packet.pcmData);
    // MessagePort's structured-clone overload needs an ArrayBuffer (or
    // ArrayBufferLike); Float32Array.buffer is shared with the typed
    // array, but the postMessage signature infers it as ArrayBuffer.
    const payloadBuffer = packet.pcmData.byteLength > 0
      ? [packet.pcmData.buffer.slice(0)] as ArrayBuffer[]
      : undefined;
    (this.workletNode.port as unknown as { postMessage: (msg: unknown, transfer?: unknown[]) => void }).postMessage(
      { type: 'pcm:data', data: pcmFloat32, frameCount: packet.frameCount },
      payloadBuffer,
    );
  }

  /** Set the stream generation (called after native capture starts). */
  setStreamGeneration(gen: number): void {
    this.currentStreamGeneration = gen;
    // Forward reset to worklet with real generation
    this.workletNode?.port.postMessage({ type: 'pcm:reset', streamGeneration: gen });
  }

  getTrack(): MediaStreamTrack | null {
    return this.audioTrack;
  }

  getOutputTrack(): MediaStreamTrack | null {
    return this.audioTrack;
  }

  getStream(): MediaStream | null {
    return this.mediaDestination?.stream ?? null;
  }

  getState(): AudioWorkletState {
    return this.state;
  }

  getStreamGeneration(): number {
    return this.currentStreamGeneration;
  }

  getInstanceId(): number {
    return this.instanceId;
  }

  getFatalError(): string | null {
    return this.fatalError;
  }

  isOutputShapeValid(): boolean {
    return this.outputShapeOk;
  }

  sampleAnalyser(_label?: string): { peak: number; rms: number } | null {
    if (!this.analyserNode) return null;
    const samples = new Float32Array(this.analyserNode.fftSize);
    this.analyserNode.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    let peak = 0;
    for (const sample of samples) {
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / samples.length);
    return { peak, rms };
  }

  /** Wait until the worklet ring buffer reaches priming target. */
  async waitUntilPrimed(): Promise<void> {
    if (this.state === 'primed' || this.state === 'rendering') return;
    if (!this.workletNode) throw new Error('Worklet not initialized');
    return this.addWaiter('primed', this.PRIMING_TIMEOUT_MS);
  }

  /** Wait until nonzero output is produced (Test Tone only). */
  async waitUntilRendering(): Promise<void> {
    if (this.state === 'rendering') return;
    if (!this.workletNode) throw new Error('Worklet not initialized');
    return this.addWaiter('rendering', this.RENDERING_TIMEOUT_MS);
  }

  /**
   * Add a deferred waiter that resolves when the worklet emits the target message,
   * or rejects on timeout / fatal / close.
   */
  private addWaiter(type: 'primed' | 'rendering', timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(new Error(`${type === 'primed' ? 'Priming' : 'Rendering'} timeout: no ${type} within ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter: Waiter = { type, resolve, reject, timer };
      this.waiters.push(waiter);
    });
  }

  private resolveWaiters(type: 'primed' | 'rendering'): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.type === type) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }

  private rejectAllWaiters(err: Error): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters = [];
  }

  async resume(): Promise<boolean> {
    if (!this.audioContext) return false;
    if (this.audioContext.state === 'running') return true;
    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        const ok = (this.audioContext.state as string) === 'running';
        if (ok) this.sampleAnalyser('post-resume');
        return ok;
      } catch {
        return false;
      }
    }
    return false;
  }

  async close(owner?: string): Promise<void> {
    if (this.closed_) return;
    this.closed_ = true;
    this.closeOwner = owner ?? 'unknown';
    console.log(`[AudioController] close id=${this.instanceId} owner=${this.closeOwner}`);

    // Reject all pending waiters
    this.rejectAllWaiters(new Error('Controller closed'));

    // Cancel own timeouts (legacy — kept for safety)
    // (waiters are cleaned up via rejectAllWaiters above)

    // Remove permanent listeners
    if (this.port && this.portMessageHandler) {
      this.port.removeEventListener('message', this.portMessageHandler);
    }
    if (this.port && this.portMessageErrorHandler) {
      this.port.removeEventListener('messageerror', this.portMessageErrorHandler);
    }
    if (this.workletNode && this.workletMessageHandler) {
      this.workletNode.port.removeEventListener('message', this.workletMessageHandler);
    }

    // Close MessagePort
    if (this.port) {
      try { this.port.close(); } catch { /* ignore */ }
      this.port = null;
    }

    // Stop destination track
    if (this.audioTrack) {
      try { this.audioTrack.stop(); } catch { /* ignore */ }
      this.audioTrack = null;
    }

    // Disconnect nodes
    if (this.workletNode) {
      try { this.workletNode.disconnect(); } catch { /* ignore */ }
      this.workletNode = null;
    }
    if (this.analyserNode) {
      try { this.analyserNode.disconnect(); } catch { /* ignore */ }
      this.analyserNode = null;
    }

    // Close AudioContext
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.mediaDestination = null;
    this.state = 'closed';
  }

  logState(label: string): void {
    const track = this.audioTrack;
    console.log(`[AudioController] id=${this.instanceId} ${label}`, {
      contextState: this.audioContext?.state,
      contextCurrentTime: this.audioContext?.currentTime,
      destinationTrackCount: this.mediaDestination?.stream.getAudioTracks().length ?? 0,
      trackId: track?.id ?? null,
      trackKind: track?.kind ?? null,
      trackEnabled: track?.enabled ?? null,
      trackMuted: track?.muted ?? null,
      trackReadyState: track?.readyState ?? null,
      controllerState: this.state,
      streamGeneration: this.currentStreamGeneration,
    });
  }
}
