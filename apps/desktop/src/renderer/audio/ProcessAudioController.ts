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
  private currentStreamGeneration: number = -1;
  private diagMessagesReceived = 0;
  private diagPacketsReceived = 0;
  private diagBytesReceived = 0;
  private diagResetMessages = 0;

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

      // Strong reference to prevent GC
      this.port = pcmPort;

      // Explicitly start the port (required when using addEventListener)
      this.port.start();

      // Send ready handshake to main process
      this.port.postMessage({ type: 'pcm:ready' });

      this.port.addEventListener('message', (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        this.diagMessagesReceived++;

        switch (msg.type) {
          case 'pcm:handshake':
            // Ignore — handshake from main
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

      // Note: priming is NOT awaited here. The consumer is ready, but
      // no PCM can arrive until the producer starts. Call waitUntilPrimed()
      // after starting the native capture producer.
    } catch (err) {
      this.state = 'error';
      this.onStateChange?.('error');
      await this.close();
      throw err;
    }
  }

  private handlePcmPacket(packet: any): void {
    if (!this.workletNode) return;

    // Validate stream generation
    if (this.currentStreamGeneration < 0) {
      this.currentStreamGeneration = packet.streamGeneration;
    } else if (packet.streamGeneration !== this.currentStreamGeneration) {
      // Old generation — discard
      return;
    }

    // Forward continuity metadata
    if (packet.flags & 2 || packet.droppedPackets > 0) {
      this.workletNode.port.postMessage({ type: 'pcm:discontinuity' });
    }

    // Forward PCM data with transfer list for zero-copy
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

  getState(): AudioWorkletState {
    return this.state;
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
   * The native capture producer MUST already be running — no PCM can
   * arrive and trigger priming until the producer is active.
   * Rejects with a timeout error if priming does not complete within
   * PRIMING_TIMEOUT_MS (5s).
   */
  async waitUntilPrimed(): Promise<void> {
    if (this.state === 'primed') return;
    if (!this.workletNode) throw new Error('Worklet not initialized');

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.workletNode!.port.onmessage = null;
        this.state = 'error';
        this.onStateChange?.('error');
        reject(new Error('Priming timeout: no PCM received within 5000ms'));
      }, this.PRIMING_TIMEOUT_MS);

      const originalHandler = this.workletNode!.port.onmessage;
      this.workletNode!.port.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'pcm:primed') {
          clearTimeout(timeout);
          this.state = 'primed';
          this.onStateChange?.('primed');
          this.workletNode!.port.onmessage = originalHandler;
          resolve();
        } else if (originalHandler) {
          originalHandler(event);
        }
      };
    });
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
