export interface StreamAnnouncement {
  logicalStreamId: string;
  mediaSessionId: string;
  groupId: string;
  hostDeviceId: string;
  hostDisplayName: string;
  sourceKind: string;
  sourceName: string;
  startedAt: number;
  appliedSettingsRevision: number;
  heartbeatSequence: number;
  /** Per-viewer join metadata (not the actual media secret) */
  mediaJoinMetadata: string;
  replacesSessionId: string | null;
}

interface InternalStream {
  announcement: StreamAnnouncement;
  lastHeartbeatAt: number;
  stopped: boolean;
}

export interface StreamUpdate {
  type: "new" | "updated" | "stopped" | "replaced";
  stream: StreamAnnouncement;
}

export class ActiveStreamRegistry {
  private streams = new Map<string, InternalStream>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(update: StreamUpdate) => void>();
  private heartbeatIntervalMs: number;
  private expiryMs: number;

  constructor(heartbeatIntervalMs = 10_000, expiryMs = 30_000) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.expiryMs = expiryMs;
    this.startHeartbeatCheck();
  }

  onUpdate(cb: (update: StreamUpdate) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(update: StreamUpdate): void {
    for (const cb of this.listeners) {
      try { cb(update); } catch { /* ignore listener errors */ }
    }
  }

  private key(groupId: string, hostDeviceId: string, logicalStreamId: string): string {
    return `${groupId}:${hostDeviceId}:${logicalStreamId}`;
  }

  handleStarted(data: StreamAnnouncement): void {
    if (data.replacesSessionId) {
      // This is a restart — remove old stream and mark as replaced
      for (const [k, s] of this.streams) {
        if (!s.stopped &&
            s.announcement.groupId === data.groupId &&
            s.announcement.hostDeviceId === data.hostDeviceId &&
            s.announcement.logicalStreamId === data.logicalStreamId &&
            !s.announcement.replacesSessionId) {
          // Same logical stream, update announcement
          s.announcement = { ...data };
          s.lastHeartbeatAt = Date.now();
          this.emit({ type: "replaced", stream: data });
          return;
        }
      }
    }

    const k = this.key(data.groupId, data.hostDeviceId, data.logicalStreamId);
    const existing = this.streams.get(k);
    if (existing && !existing.stopped) {
      existing.announcement = { ...data };
      existing.lastHeartbeatAt = Date.now();
      this.emit({ type: "updated", stream: data });
      return;
    }

    this.streams.set(k, {
      announcement: data,
      lastHeartbeatAt: Date.now(),
      stopped: false,
    });
    this.emit({ type: "new", stream: data });
  }

  handleHeartbeat(heartbeat: {
    groupId: string;
    hostDeviceId: string;
    logicalStreamId: string;
    mediaSessionId: string;
    heartbeatSequence: number;
    appliedSettingsRevision?: number;
  }): void {
    for (const [k, s] of this.streams) {
      if (!s.stopped &&
          s.announcement.groupId === heartbeat.groupId &&
          s.announcement.hostDeviceId === heartbeat.hostDeviceId &&
          s.announcement.logicalStreamId === heartbeat.logicalStreamId) {
        s.lastHeartbeatAt = Date.now();
        s.announcement.heartbeatSequence = heartbeat.heartbeatSequence;
        if (heartbeat.appliedSettingsRevision !== undefined) {
          s.announcement.appliedSettingsRevision = heartbeat.appliedSettingsRevision;
        }
        return;
      }
    }
  }

  handleStopped(stop: {
    groupId: string;
    hostDeviceId: string;
    logicalStreamId: string;
  }): void {
    for (const [k, s] of this.streams) {
      if (!s.stopped &&
          s.announcement.groupId === stop.groupId &&
          s.announcement.hostDeviceId === stop.hostDeviceId &&
          s.announcement.logicalStreamId === stop.logicalStreamId) {
        s.stopped = true;
        this.emit({ type: "stopped", stream: { ...s.announcement } });
        return;
      }
    }
  }

  getStreamsByGroup(groupId: string): StreamAnnouncement[] {
    const result: StreamAnnouncement[] = [];
    for (const s of this.streams.values()) {
      if (!s.stopped && s.announcement.groupId === groupId) {
        result.push({ ...s.announcement });
      }
    }
    return result;
  }

  getAllStreams(): StreamAnnouncement[] {
    const result: StreamAnnouncement[] = [];
    for (const s of this.streams.values()) {
      if (!s.stopped) result.push({ ...s.announcement });
    }
    return result;
  }

  getStream(key: { groupId: string; hostDeviceId: string; logicalStreamId: string }): StreamAnnouncement | null {
    for (const s of this.streams.values()) {
      if (!s.stopped &&
          s.announcement.groupId === key.groupId &&
          s.announcement.hostDeviceId === key.hostDeviceId &&
          s.announcement.logicalStreamId === key.logicalStreamId) {
        return { ...s.announcement };
      }
    }
    return null;
  }

  getGroupKeys(groupId: string): Array<{ hostDeviceId: string; logicalStreamId: string }> {
    const result: Array<{ hostDeviceId: string; logicalStreamId: string }> = [];
    for (const s of this.streams.values()) {
      if (!s.stopped && s.announcement.groupId === groupId) {
        result.push({
          hostDeviceId: s.announcement.hostDeviceId,
          logicalStreamId: s.announcement.logicalStreamId,
        });
      }
    }
    return result;
  }

  // Snapshot recovery after reconnect
  handleSnapshot(streams: StreamAnnouncement[]): void {
    const now = Date.now();
    for (const stream of streams) {
      const k = this.key(stream.groupId, stream.hostDeviceId, stream.logicalStreamId);
      const existing = this.streams.get(k);
      if (!existing || existing.stopped || existing.lastHeartbeatAt < now - this.expiryMs) {
        this.streams.set(k, {
          announcement: stream,
          lastHeartbeatAt: now,
          stopped: false,
        });
        this.emit({ type: "new", stream: { ...stream } });
      }
    }
  }

  destroy(): void {
    this.listeners.clear();
    this.streams.clear();
    this.stopHeartbeatCheck();
  }

  private startHeartbeatCheck(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const expireBefore = now - this.expiryMs;
      for (const [k, s] of this.streams) {
        if (!s.stopped && s.lastHeartbeatAt < expireBefore) {
          s.stopped = true;
          this.emit({ type: "stopped", stream: { ...s.announcement } });
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeatCheck(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
