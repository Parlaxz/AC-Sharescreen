import { PcmRingBuffer } from './PcmRingBuffer';

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
  private primingTimeout: ReturnType<typeof setTimeout> | null = null;
  private renderingTimeout: ReturnType<typeof setTimeout> | null = null;
  private currentStreamGeneration: number = -1;
  private outputShapeOk = false;
  private fatalError: string | null = null;
  private diagMessagesReceived = 0;
  private diagPacketsReceived = 0;
  private diagBytesReceived = 0;
  private diagResetMessages = 0;
  private diagAnalyserSamples: { peak: number; rms: number; timestamp: number }[] = [];

  readonly TARGET_FRAMES = 3840;
  readonly PRIMING_TIMEOUT_MS = 5000;
  readonly RENDERING_TIMEOUT_MS = 5000;
  readonly SAMPLE_RATE = 48000;

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
        throw new Error(
          `Unsupported sample rate: ${this.audioContext.sampleRate} (expected ${this.SAMPLE_RATE})`,
        );
      }

      await this.audioContext.audioWorklet.addModule(
        new URL('./process-pcm-worklet.ts', import.meta.url),
      );

      this.state = 'loaded';
      this.onStateChange?.('loaded');

      // Create worklet node with explicit stereo output configuration.
      // Without outputChannelCount: [2], the browser may deliver mono
      // output to process(), causing the worklet to skip rendering.
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

      this.port = pcmPort;
      this.port.start();
      this.port.postMessage({ type: 'pcm:ready' });

      this.port.addEventListener('message', (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        this.diagMessagesReceived++;
        switch (msg.type) {
          case 'pcm:handshake':
            break;
          case 'pcm:packet':
            this.diagPacketsReceived++;
            this.diagBytesReceived += msg.packet?.pcmData?.byteLength ?? 0;
            this.handlePcmPacket(msg.packet);
            break;
          case 'pcm:reset':
            this.diagResetMessages++;
            this.currentStreamGeneration = -1;
            this.workletNode?.port.postMessage({ type: 'pcm:reset' });
            break;
          case 'pcm:canary':
            console.log('[ProcessAudioController] Port canary received, port is alive');
            break;
        }
      });

      this.port.addEventListener('messageerror', (event) => {
        console.error('[ProcessAudioController] Port messageerror:', event);
      });

      // Listen for worklet messages
      this.workletNode.port.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {
          case 'pcm:primed':
            this.state = 'primed';
            this.onStateChange?.('primed');
            if (this.primingTimeout) {
              clearTimeout(this.primingTimeout);
              this.primingTimeout = null;
            }
            break;

          case 'pcm:rendering':
            this.state = 'rendering';
            this.onStateChange?.('rendering');
            console.log('[ProcessAudioController] Worklet rendering, peak:', msg.peak, 'rms:', msg.rms);
            if (this.renderingTimeout) {
              clearTimeout(this.renderingTimeout);
              this.renderingTimeout = null;
            }
            break;

          case 'pcm:output-shape':
            console.log('[ProcessAudioController] Worklet output shape:', {
              outputCount: msg.outputCount,
              channelCount: msg.channelCount,
              quantumFrames: msg.quantumFrames,
              sampleRate: msg.sampleRate,
            });
            this.outputShapeOk = msg.channelCount === 2;
            break;

          case 'pcm:fatal':
            this.fatalError = msg.error;
            this.state = 'error';
            this.onStateChange?.('error');
            console.error('[ProcessAudioController] Worklet fatal:', msg.error,
              'expected', msg.expectedChannels, 'actual', msg.actualChannels);
            break;

          case 'pcm:stats':
            this.onStats?.(msg.stats);
            break;
        }
      };

      // Create AnalyserNode for diagnostic probing
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

      console.log('[Audio destination track]', {
        count: tracks.length,
        id: this.audioTrack.id,
        kind: this.audioTrack.kind,
        label: this.audioTrack.label,
        enabled: this.audioTrack.enabled,
        muted: this.audioTrack.muted,
        readyState: this.audioTrack.readyState,
        settings: this.audioTrack.getSettings(),
      });

      this.audioTrack.addEventListener('mute', () =>
        console.warn('[Audio track] muted'),
      );
      this.audioTrack.addEventListener('unmute', () =>
        console.log('[Audio track] unmuted'),
      );
      this.audioTrack.addEventListener('ended', () =>
        console.error('[Audio track] ended'),
      );

      // Resume AudioContext
      if (this.audioContext.state === 'suspended') {
        console.log('[ProcessAudioController] AudioContext suspended, resuming...');
        try {
          await this.audioContext.resume();
        } catch (resumeErr) {
          console.warn('[ProcessAudioController] AudioContext.resume() failed:', resumeErr);
        }
      }

      if (this.audioContext.state !== 'running') {
        console.warn(
          `[ProcessAudioController] AudioContext state is "${this.audioContext.state}" after resume`,
        );
      } else {
        console.log('[ProcessAudioController] AudioContext running');
      }

      // Sample analyser at init and 250ms later
      this.sampleAnalyser('post-init');
      setTimeout(() => this.sampleAnalyser('post-init+250ms'), 250);

    } catch (err) {
      this.state = 'error';
      this.onStateChange?.('error');
      await this.close();
      throw err;
    }
  }

  private handlePcmPacket(packet: any): void {
    if (!this.workletNode) return;

    if (this.currentStreamGeneration < 0) {
      this.currentStreamGeneration = packet.streamGeneration;
    } else if (packet.streamGeneration !== this.currentStreamGeneration) {
      return;
    }

    if (this.diagPacketsReceived === 1) {
      console.log('[ProcessAudioController] First PCM packet', {
        frameCount: packet.frameCount,
        channels: packet.channels,
        sampleRate: packet.sampleRate,
        sampleFormat: packet.sampleFormat,
        flags: packet.flags,
        pcmDataByteLength: packet.pcmData?.byteLength,
        streamGeneration: packet.streamGeneration,
      });
    }

    if (packet.flags & 2 || packet.droppedPackets > 0) {
      this.workletNode.port.postMessage({ type: 'pcm:discontinuity' });
    }

    const pcmFloat32 = new Float32Array(packet.pcmData);
    this.workletNode.port.postMessage(
      {
        type: 'pcm:data',
        data: pcmFloat32,
        frameCount: packet.frameCount,
      },
      packet.pcmData.byteLength > 0 ? [packet.pcmData] : undefined,
    );
  }

  getTrack(): MediaStreamTrack | null {
    return this.audioTrack;
  }

  getStream(): MediaStream | null {
    return this.mediaDestination?.stream ?? null;
  }

  /**
   * Sample the AnalyserNode and return { peak, rms }.
   */
  sampleAnalyser(label?: string): { peak: number; rms: number } | null {
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
    const entry = { peak, rms, timestamp: Date.now() };
    this.diagAnalyserSamples.push(entry);
    if (this.diagAnalyserSamples.length > 10) {
      this.diagAnalyserSamples.shift();
    }

    console.log(`[Audio graph]${label ? ` ${label}` : ''}`, {
      contextState: this.audioContext?.state,
      peak,
      rms,
      fftSize: this.analyserNode.fftSize,
    });

    return { peak, rms };
  }

  getAnalyserReadings(): { peak: number; rms: number; timestamp: number }[] {
    return [...this.diagAnalyserSamples];
  }

  getState(): AudioWorkletState {
    return this.state;
  }

  getFatalError(): string | null {
    return this.fatalError;
  }

  isOutputShapeValid(): boolean {
    return this.outputShapeOk;
  }

  getPortDiagnostics(): { messagesReceived: number; packetsReceived: number; bytesReceived: number; resetMessages: number } {
    return {
      messagesReceived: this.diagMessagesReceived,
      packetsReceived: this.diagPacketsReceived,
      bytesReceived: this.diagBytesReceived,
      resetMessages: this.diagResetMessages,
    };
  }

  /**
   * Wait until the worklet ring buffer reaches its priming target.
   */
  async waitUntilPrimed(): Promise<void> {
    if (this.state === 'primed' || this.state === 'rendering') return;
    if (!this.workletNode) throw new Error('Worklet not initialized');

    return new Promise<void>((resolve, reject) => {
      this.primingTimeout = setTimeout(() => {
        this.primingTimeout = null;
        this.state = 'error';
        this.onStateChange?.('error');
        reject(new Error('Priming timeout: no PCM received within 5000ms'));
      }, this.PRIMING_TIMEOUT_MS);

      const handler = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'pcm:primed' || msg.type === 'pcm:rendering') {
          clearTimeout(this.primingTimeout!);
          this.primingTimeout = null;
          this.state = msg.type === 'pcm:rendering' ? 'rendering' : 'primed';
          this.onStateChange?.(this.state);
          this.workletNode!.port.onmessage = null;
          resolve();
        }
      };
      this.workletNode!.port.onmessage = handler;
    });
  }

  /**
   * Wait until the worklet has produced nonzero output samples (pcm:rendering).
   * Only call after waitUntilPrimed has resolved and the native producer is running.
   */
  async waitUntilRendering(): Promise<void> {
    if (this.state === 'rendering') return;
    if (!this.workletNode) throw new Error('Worklet not initialized');

    return new Promise<void>((resolve, reject) => {
      this.renderingTimeout = setTimeout(() => {
        this.renderingTimeout = null;
        reject(new Error('Rendering timeout: no nonzero output within 5000ms'));
      }, this.RENDERING_TIMEOUT_MS);

      const handler = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'pcm:rendering') {
          clearTimeout(this.renderingTimeout!);
          this.renderingTimeout = null;
          this.state = 'rendering';
          this.onStateChange?.('rendering');
          console.log('[ProcessAudioController] Rendering confirmed, peak:', msg.peak, 'rms:', msg.rms);
          this.workletNode!.port.onmessage = null;
          resolve();
        } else if (msg.type === 'pcm:fatal') {
          clearTimeout(this.renderingTimeout!);
          this.renderingTimeout = null;
          this.fatalError = msg.error;
          this.state = 'error';
          this.onStateChange?.('error');
          reject(new Error(`Worklet fatal: ${msg.error}`));
        }
      };
      this.workletNode!.port.onmessage = handler;
    });
  }

  async resume(): Promise<boolean> {
    if (!this.audioContext) return false;
    if (this.audioContext.state === 'running') return true;

    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        const ok = this.audioContext.state === 'running';
        console.log(`[ProcessAudioController] Resume ${ok ? 'succeeded' : 'failed'}, state: ${this.audioContext.state}`);
        if (ok) {
          this.sampleAnalyser('post-resume');
        }
        return ok;
      } catch (err) {
        console.warn('[ProcessAudioController] resume() threw:', err);
        return false;
      }
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.primingTimeout) {
      clearTimeout(this.primingTimeout);
      this.primingTimeout = null;
    }
    if (this.renderingTimeout) {
      clearTimeout(this.renderingTimeout);
      this.renderingTimeout = null;
    }

    if (this.port) {
      this.port.close();
      this.port = null;
    }

    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        /* ignore */
      }
      this.workletNode = null;
    }

    if (this.analyserNode) {
      try {
        this.analyserNode.disconnect();
      } catch {
        /* ignore */
      }
      this.analyserNode = null;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.mediaDestination = null;
    this.audioTrack = null;
    this.state = 'closed';
  }
}
