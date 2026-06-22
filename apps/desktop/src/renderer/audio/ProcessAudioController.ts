import { PcmRingBuffer } from './PcmRingBuffer';

export type AudioWorkletState =
  | 'closed'
  | 'loading'
  | 'loaded'
  | 'buffering'
  | 'primed'
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
}

export class ProcessAudioController {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mediaDestination: MediaStreamAudioDestinationNode | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private port: MessagePort | null = null;
  private state: AudioWorkletState = 'closed';
  private onStateChange: ((state: AudioWorkletState) => void) | null = null;
  private onStats: ((stats: WorkletStatsReport) => void) | null = null;
  private primingTimeout: ReturnType<typeof setTimeout> | null = null;

  readonly TARGET_FRAMES = 3840; // ~80ms at 48kHz
  readonly PRIMING_TIMEOUT_MS = 5000;

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
      // 1. Create AudioContext
      this.audioContext = new AudioContext({
        sampleRate: 48000,
        latencyHint: 'interactive',
      });

      // Verify the actual sample rate
      if (this.audioContext.sampleRate !== 48000) {
        console.warn(
          `[ProcessAudioController] AudioContext sampleRate is ${this.audioContext.sampleRate}, expected 48000`,
        );
        // For Phase 2D, we reject non-48kHz. Simple resampling could be added later.
        throw new Error(
          `Unsupported sample rate: ${this.audioContext.sampleRate} (expected 48000)`,
        );
      }

      // 2. Load worklet module
      // The worklet file must be bundled alongside the renderer JS.
      // Vite handles this via the URL constructor.
      await this.audioContext.audioWorklet.addModule(
        new URL('./process-pcm-worklet.ts', import.meta.url),
      );

      this.state = 'loaded';
      this.onStateChange?.('loaded');

      // 3. Create worklet node
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        'process-pcm-worklet',
      );
      this.state = 'buffering';
      this.onStateChange?.('buffering');

      // 4. Connect MessagePort to worklet
      this.port = pcmPort;
      this.port.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {
          case 'pcm:handshake':
            // Received from main process PcmBridge — ignore here, we get packets via the port
            break;
          case 'pcm:packet':
            this.handlePcmPacket(msg.packet);
            break;
          case 'pcm:reset':
            this.workletNode?.port.postMessage({ type: 'pcm:reset' });
            break;
        }
      };

      // 5. Listen for worklet messages
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
          case 'pcm:stats':
            this.onStats?.(msg.stats);
            break;
        }
      };

      // 6. Create media destination (NOT connected to destination — no local playback)
      this.mediaDestination = this.audioContext.createMediaStreamDestination();
      this.workletNode.connect(this.mediaDestination);

      // 7. Get audio track
      const tracks = this.mediaDestination.stream.getAudioTracks();
      if (tracks.length !== 1) {
        throw new Error(`Expected 1 audio track, got ${tracks.length}`);
      }
      this.audioTrack = tracks[0];

      // 8. Start priming timeout
      this.primingTimeout = setTimeout(() => {
        if (this.state === 'buffering' || this.state === 'loaded') {
          console.warn(
            '[ProcessAudioController] Priming timeout — starting with partial buffer',
          );
          this.state = 'primed';
          this.onStateChange?.('primed');
        }
      }, this.PRIMING_TIMEOUT_MS);
    } catch (err) {
      this.state = 'error';
      this.onStateChange?.('error');
      await this.close();
      throw err;
    }
  }

  private handlePcmPacket(packet: { pcmData: ArrayBufferLike; frameCount: number }): void {
    if (!this.workletNode) return;

    // Convert ArrayBuffer to Float32Array
    const pcmData = new Float32Array(packet.pcmData);

    // Forward to worklet
    this.workletNode.port.postMessage(
      {
        type: 'pcm:data',
        data: pcmData,
        frameCount: packet.frameCount,
      },
    );
  }

  getTrack(): MediaStreamTrack | null {
    return this.audioTrack;
  }

  getStream(): MediaStream | null {
    return this.mediaDestination?.stream ?? null;
  }

  getState(): AudioWorkletState {
    return this.state;
  }

  async resume(): Promise<void> {
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  async close(): Promise<void> {
    if (this.primingTimeout) {
      clearTimeout(this.primingTimeout);
      this.primingTimeout = null;
    }

    // Disconnect ports
    if (this.port) {
      this.port.close();
      this.port = null;
    }

    // Disconnect worklet
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        /* ignore */
      }
      this.workletNode = null;
    }

    // Close audio context
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.mediaDestination = null;
    this.audioTrack = null;
    this.state = 'closed';
  }
}
