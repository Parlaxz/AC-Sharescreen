import { HostPublisher } from "@screenlink/vdo-adapter";
import type { MediaStatsSnapshot } from "./media-stats-service.js";
import type { ProcessAudioController } from "../audio/ProcessAudioController.js";

export type AudioState = "disabled" | "active" | "error";

export type PublisherState =
  | "idle"
  | "selecting-source"
  | "starting"
  | "sharing"
  | "stopping"
  | "error";

export interface PublisherConfig {
  sourceId: string;
  password: string;
  streamId: string;
  videoBitrate: number;
  videoWidth: number;
  videoHeight: number;
  videoFps: number;
}

export interface PublisherEvents {
  onStateChange: (state: PublisherState) => void;
  onStats: (stats: MediaStatsSnapshot) => void;
  onError: (error: Error) => void;
  onTrackEnded: () => void;
}

export class PublisherManager {
  private publisher: HostPublisher | null = null;
  private captureStream: MediaStream | null = null;
  private audioController: ProcessAudioController | null = null;
  private combinedStream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private state: PublisherState = "idle";
  private _audioState: AudioState = "disabled";
  private events: PublisherEvents;
  private config: PublisherConfig | null = null;
  private stopping_: boolean = false;
  private stopPromise_: Promise<void> | null = null;
  private static nextId = 0;
  private readonly instanceId: number;
  private appliedAudioMode: 'none' | 'system' | 'application' | 'monitor' | 'test-tone' = 'none';

  constructor(events: PublisherEvents) {
    PublisherManager.nextId++;
    this.instanceId = PublisherManager.nextId;
    this.events = events;
    console.log(`[PublisherManager] constructed id=${this.instanceId}`);
  }

  getState(): PublisherState {
    return this.state;
  }

  getPublisher(): HostPublisher | null {
    return this.publisher;
  }

  getCaptureStream(): MediaStream | null {
    return this.captureStream;
  }

  getAudioTrack(): MediaStreamTrack | null {
    return this.audioController?.getTrack() ?? this.audioTrack;
  }

  getAudioState(): AudioState {
    return this._audioState;
  }

  getInstanceId(): number {
    return this.instanceId;
  }

  setAudioController(controller: ProcessAudioController, mode: 'system' | 'application' | 'monitor' | 'test-tone'): void {
    const previous = this.audioController;

    this.audioController = controller;
    this.audioTrack = controller.getTrack();
    this.appliedAudioMode = mode;
    this._audioState = "active";

    console.log('[PublisherManager] controllerSet', {
      managerInstanceId: this.instanceId,
      controllerId: controller.getInstanceId?.() ?? 'unknown',
      mode,
      hasAudioTrack: this.audioTrack !== null,
      audioTrackReadyState: this.audioTrack?.readyState ?? null,
    });

    if (previous && previous !== controller) {
      previous.close('replacement').catch(() => {});
    }
  }

  /** Remove a previously set audio controller without closing it (caller owns teardown). */
  clearAudioController(): void {
    this.audioController = null;
    this.audioTrack = null;
    this.appliedAudioMode = 'none';
    this._audioState = "disabled";
  }

  private buildCombinedStream(): MediaStream {
    const videoTracks = this.captureStream?.getVideoTracks() ?? [];
    const audioController = this.audioController;
    const audioTrack = audioController?.getTrack() ?? null;

    console.log('[PublisherManager] audio input', {
      managerInstanceId: this.instanceId,
      hasAudioController: audioController !== null,
      controllerId: audioController?.getInstanceId?.() ?? null,
      appliedAudioMode: this.appliedAudioMode,
      hasAudioTrack: audioTrack !== null,
      audioTrack: audioTrack ? {
        id: audioTrack.id,
        kind: audioTrack.kind,
        enabled: audioTrack.enabled,
        muted: audioTrack.muted,
        readyState: audioTrack.readyState,
      } : null,
    });

    const stream = new MediaStream();

    if (videoTracks.length > 0) {
      stream.addTrack(videoTracks[0]);
    }

    if (audioTrack) {
      if (audioTrack.kind !== 'audio') {
        throw new Error('publisher-audio-track-wrong-kind');
      }
      if (audioTrack.readyState !== 'live') {
        throw new Error(`publisher-audio-track-${audioTrack.readyState}`);
      }
      const ctrlState = audioController?.getState();
      if (ctrlState === 'rendering' || ctrlState === 'primed') {
        stream.addTrack(audioTrack);
      } else {
        console.warn('[PublisherManager] Audio track is live but controller state is',
          ctrlState, '- skipping audio from combined stream');
      }
    }

    return stream;
  }

  private setState(newState: PublisherState): void {
    this.state = newState;
    this.events.onStateChange(newState);
  }

  async startCapture(config: PublisherConfig): Promise<MediaStream> {
    this.config = config;
    this.setState("selecting-source");

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      this.captureStream = stream;
      this.setState("starting");

      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        this.stopCapture().catch(() => {});
        this.events.onTrackEnded();
      });

      return stream;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setState("error");
      this.events.onError(error);
      throw error;
    }
  }

  async startPublishing(stream: MediaStream, config: PublisherConfig): Promise<void> {
    // If we have an audio controller, build a combined stream with video + audio
    if (this.audioController) {
      this.combinedStream = this.buildCombinedStream();
      stream = this.combinedStream;
    }

    // Publication invariant: if audio mode was applied, audio track must be present
    if (this.appliedAudioMode !== 'none' && !stream.getAudioTracks().length) {
      throw new Error(`audio-track-missing-before-publish:${this.appliedAudioMode}`);
    }

    console.log('[PublisherManager] combined stream', {
      managerInstanceId: this.instanceId,
      videoTracks: stream.getVideoTracks().length,
      audioTracks: stream.getAudioTracks().length,
      controllerId: this.audioController?.getInstanceId?.() ?? null,
    });

    // Log combined stream contents for diagnostics
    console.table(
      stream.getTracks().map((track) => ({
        id: track.id,
        kind: track.kind,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        label: track.label,
      })),
    );

    const publisher = new HostPublisher();

    console.log('[PublisherManager] Connecting publisher...');
    await publisher.createAndConnect({ password: config.password });

    console.log('[PublisherManager] Publishing stream...');
    await publisher.publish(stream, {
      streamID: config.streamId,
      label: "ScreenLink Host",
      password: config.password,
      videoBitrate: config.videoBitrate,
      videoResolution: {
        width: config.videoWidth,
        height: config.videoHeight,
        frameRate: config.videoFps,
      },
      audioBitrate: 64000, // 64 kbps for Opus stereo
    });

    this.publisher = publisher;
    this.config = config;
    this.setState("sharing");

    // Log audio sender presence immediately after publish
    try {
      const sdk = publisher.getSDK();
      if (sdk) {
        const entries = Array.from(sdk.connections.entries());
        const senders = entries.flatMap(([, g]) => {
          const pc = g.publisher?.pc;
          return pc ? pc.getSenders() : [];
        });
        console.table(
          senders.map((s) => ({
            kind: s.track?.kind,
            trackId: s.track?.id,
            enabled: s.track?.enabled,
            readyState: s.track?.readyState,
          })),
        );
      }
    } catch (err) {
      console.warn("[PublisherManager] Sender diagnostic failed:", err);
    }
  }

  async stopCapture(): Promise<void> {
    // Return existing promise if already stopping (awaitable idempotency)
    if (this.stopping_) {
      return this.stopPromise_;
    }
    this.stopping_ = true;
    this.setState("stopping");

    this.stopPromise_ = (async () => {
      try {
        // 1. Stop publisher first (before its media tracks die)
        if (this.publisher) {
          await this.publisher.stopPublishing();
          await this.publisher.disconnect();
          this.publisher = null;
        }

        // 2. Stop audio controller
        if (this.audioController) {
          console.log('[PublisherManager] closing audio controller', {
            managerInstanceId: this.instanceId,
            controllerId: this.audioController.getInstanceId?.() ?? 'unknown',
          });
          await this.audioController.close('shutdown');
          this.audioController = null;
        }

        // 3. Stop combined stream tracks
        if (this.combinedStream) {
          this.combinedStream.getTracks().forEach(t => t.stop());
          this.combinedStream = null;
        }

        // 4. Stop capture stream tracks
        this.captureStream?.getTracks().forEach(t => t.stop());
        this.captureStream = null;
        this.audioTrack = null;
        this.appliedAudioMode = 'none';
        this._audioState = "disabled";
        this.config = null;

        this.setState("idle");
      } finally {
        this.stopping_ = false;
        this.stopPromise_ = null;
      }
    })();

    return this.stopPromise_;
  }

  async setQuality(bitrate: number, width: number, height: number, fps: number): Promise<void> {
    if (!this.publisher || !this.config) return;
    const sdk = this.publisher.getSDK();
    if (!sdk) return;

    for (const [, group] of sdk.connections) {
      const pc = group.publisher?.pc;
      if (!pc) continue;
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (!sender) continue;

      const params = sender.getParameters();
      if (!Array.isArray(params.encodings) || params.encodings.length === 0) continue;

      const encoding = params.encodings[0];
      if (encoding) {
        encoding.maxBitrate = bitrate * 1000;
        encoding.maxFramerate = fps;
      }

      try {
        await sender.setParameters(params);
      } catch (err) {
        console.warn("[PublisherManager] setParameters failed:", err);
        return;
      }
      const readback = sender.getParameters();
      const appliedBitrate = readback.encodings?.[0]?.maxBitrate ?? 0;
      if (appliedBitrate !== bitrate * 1000) {
        console.warn("[PublisherManager] setParameters readback mismatch");
      }
    }
  }

  hasAudio(): boolean {
    const track = this.audioController?.getTrack() ?? this.audioTrack;
    return track?.readyState === "live";
  }

  destroy(): void {
    this.stopCapture().catch(() => {});
  }
}
