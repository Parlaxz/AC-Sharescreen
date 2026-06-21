import { HostPublisher } from "@screenlink/vdo-adapter";
import type { MediaStatsSnapshot } from "./media-stats-service.js";

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
  private audioTrack: MediaStreamTrack | null = null;
  private state: PublisherState = "idle";
  private events: PublisherEvents;
  private config: PublisherConfig | null = null;

  constructor(events: PublisherEvents) {
    this.events = events;
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
    return this.audioTrack;
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
    const publisher = new HostPublisher();

    await publisher.createAndConnect({ password: config.password });
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
    });

    this.publisher = publisher;
    this.config = config;
    this.setState("sharing");
  }

  async stopCapture(): Promise<void> {
    if (this.publisher) {
      await this.publisher.stopPublishing();
      await this.publisher.disconnect();
      this.publisher = null;
    }

    this.captureStream?.getTracks().forEach(t => t.stop());
    this.captureStream = null;
    this.audioTrack = null;
    this.config = null;

    this.setState("idle");
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
    return this.audioTrack !== null && this.audioTrack.readyState === "live";
  }

  destroy(): void {
    this.stopCapture().catch(() => {});
  }
}
