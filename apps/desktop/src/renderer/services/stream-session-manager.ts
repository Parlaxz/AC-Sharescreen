import type { Phase3Runtime } from "./phase3-runtime.js";

/**
 * Stream session state machine:
 *   idle → starting → active → stopping → idle
 *   active → restarting → active
 *   any → failed → idle
 *   any → destroyed (terminal)
 */
export type StreamSessionState =
  | "idle"
  | "starting"
  | "active"
  | "restarting"
  | "stopping"
  | "failed"
  | "destroyed";

export interface StartStreamInput {
  groupId: string;
  sourceId: string;
  sourceName: string;
  sourceKind: string;
  track: MediaStreamTrack;
}

/**
 * C4: StreamSessionManager
 *
 * Owns ONE local host stream (single-source assumption).
 * Manages the lifecycle: stream announcements, heartbeats, and restart.
 *
 * VDO publishing is managed separately by PublisherManager.
 * StreamSessionManager is the control-plane counterpart.
 */
export class StreamSessionManager {
  private _state: StreamSessionState = "idle";
  private groupId: string | null = null;
  private logicalStreamId: string | null = null;
  private mediaSessionId: string | null = null;
  private startedAt: number = 0;
  private streamRevision: number = 0;
  private heartbeatSeq: number = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentTrack: MediaStreamTrack | null = null;
  private destroyed = false;

  constructor(
    private runtime: Phase3Runtime,
  ) {}

  get state(): StreamSessionState {
    return this._state;
  }

  get currentGroupId(): string | null {
    return this.groupId;
  }

  get currentLogicalStreamId(): string | null {
    return this.logicalStreamId;
  }

  get currentMediaSessionId(): string | null {
    return this.mediaSessionId;
  }

  /**
   * Start a new stream session.
   * Transitions: idle/failed → starting → active
   */
  async startStream(input: StartStreamInput): Promise<void> {
    if (this._state !== "idle" && this._state !== "failed") return;
    if (this.destroyed) return;

    this._state = "starting";
    this.groupId = input.groupId;
    this.logicalStreamId = crypto.randomUUID();
    this.mediaSessionId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.streamRevision++;
    this.heartbeatSeq = 0;
    this.currentTrack = input.track;

    try {
      // 1. Announce stream.started to group
      const connManager = this.runtime.getConnectionManager();
      await connManager.broadcast(this.groupId, {
        type: "stream.started",
        logicalStreamId: this.logicalStreamId,
        mediaSessionId: this.mediaSessionId,
        groupId: this.groupId,
        hostDeviceId: "local",
        sourceKind: input.sourceKind,
        sourceName: input.sourceName,
        startedAt: this.startedAt,
        appliedSettingsRevision: 0,
        heartbeatSequence: this.heartbeatSeq,
        streamRevision: this.streamRevision,
        mediaJoinMetadata: "",
        replacesSessionId: null,
      });

      // 4. Start heartbeat timer (every 10s)
      this.startHeartbeat();

      this._state = "active";
    } catch (err) {
      this._state = "failed";
      throw err;
    }
  }

  /**
   * Stop the current stream session.
   * Transitions: active → stopping → idle
   */
  async stopStream(): Promise<void> {
    if (this._state !== "active" && this._state !== "failed") return;
    if (this.destroyed) return;

    this._state = "stopping";
    this.stopHeartbeat();

    try {
      // Announce stream.stopped
      if (this.groupId && this.logicalStreamId) {
        const connManager = this.runtime.getConnectionManager();
        await connManager.broadcast(this.groupId, {
          type: "stream.stopped",
          groupId: this.groupId,
          hostDeviceId: "local",
          logicalStreamId: this.logicalStreamId,
        });
      }

      this.reset();
      this._state = "idle";
    } catch (err) {
      this.reset();
      this._state = "idle";
    }
  }

  /**
   * Restart stream with a new media session (e.g., after source change).
   * Transitions: active → starting → active (new mediaSessionId)
   */
  async restartStream(newMediaSessionId: string): Promise<void> {
    if (this._state !== "active") return;
    if (this.destroyed) return;

    const oldState = {
      groupId: this.groupId!,
      logicalStreamId: this.logicalStreamId!,
      oldMediaSessionId: this.mediaSessionId!,
    };

    this._state = "restarting";
    this.stopHeartbeat();
    this.mediaSessionId = newMediaSessionId;
    this.startedAt = Date.now();
    this.streamRevision++;
    this.heartbeatSeq = 0;

    try {
      const connManager = this.runtime.getConnectionManager();

      // Announce restart
      await connManager.broadcast(oldState.groupId, {
        type: "stream.restarted",
        logicalStreamId: oldState.logicalStreamId,
        mediaSessionId: newMediaSessionId,
        previousMediaSessionId: oldState.oldMediaSessionId,
        groupId: oldState.groupId,
        hostDeviceId: "local",
        startedAt: this.startedAt,
        appliedSettingsRevision: 0,
        heartbeatSequence: this.heartbeatSeq,
        streamRevision: this.streamRevision,
      });

      this.startHeartbeat();
      this._state = "active";
    } catch (err) {
      this._state = "failed";
      throw err;
    }
  }

  /**
   * Destroy the session manager. Terminal state — no further operations allowed.
   */
  destroy(): void {
    this.destroyed = true;
    this.stopHeartbeat();
    this.reset();
    this._state = "destroyed";
  }

  // ── Private ──────────────────────────────────────────────────

  private reset(): void {
    this.groupId = null;
    this.logicalStreamId = null;
    this.mediaSessionId = null;
    this.startedAt = 0;
    this.currentTrack = null;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, 10_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (this._state !== "active" || !this.groupId || !this.logicalStreamId) return;
    if (this.destroyed) return;

    this.heartbeatSeq++;
    const connManager = this.runtime.getConnectionManager();
    await connManager.broadcast(this.groupId, {
      type: "stream.heartbeat",
      groupId: this.groupId,
      hostDeviceId: "local",
      logicalStreamId: this.logicalStreamId,
      mediaSessionId: this.mediaSessionId,
      heartbeatSequence: this.heartbeatSeq,
      appliedSettingsRevision: 0,
    });
  }
}
