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
  streamRevision: number;
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
  /** Tracks stopped streams by logicalStreamId → stopTimeMs to prevent resurrection. */
  private stopTombstones = new Map<string, number>();
  /** Per-stream highest observed heartbeatSequence for stale rejection. */
  private heartbeatSequences = new Map<string, number>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(update: StreamUpdate) => void>();
  private heartbeatIntervalMs: number;
  private expiryMs: number;
  private tombstoneMaxAgeMs: number;
  private tombstoneMaxEntries: number;

  constructor(heartbeatIntervalMs = 10_000, expiryMs = 30_000) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.expiryMs = expiryMs;
    this.tombstoneMaxAgeMs = 5 * 60 * 1000; // 5 minutes
    this.tombstoneMaxEntries = 100;
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
    const tombstoneStopTime = this.stopTombstones.get(data.logicalStreamId);
    if (tombstoneStopTime !== undefined) {
      const age = Date.now() - tombstoneStopTime;
      if (age < this.tombstoneMaxAgeMs) {
        // Tombstone too recent — reject this start as stale
        return;
      }
      // Tombstone older than 5 minutes — remove it and accept
      this.stopTombstones.delete(data.logicalStreamId);
    }

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
      // Validate heartbeat sequence — reject stale updates
      const lastSeq = this.heartbeatSequences.get(data.logicalStreamId) ?? -1;
      if (data.heartbeatSequence <= lastSeq) {
        return; // stale
      }
      existing.announcement = { ...data };
      existing.lastHeartbeatAt = Date.now();
      this.heartbeatSequences.set(data.logicalStreamId, data.heartbeatSequence);
      this.emit({ type: "updated", stream: data });
      return;
    }

    this.streams.set(k, {
      announcement: data,
      lastHeartbeatAt: Date.now(),
      stopped: false,
    });
    this.heartbeatSequences.set(data.logicalStreamId, data.heartbeatSequence);
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
    // Check tombstone — if stream is dead, ignore heartbeat (no resurrection)
    if (this.stopTombstones.has(heartbeat.logicalStreamId)) {
      return;
    }

    // Validate sequence number — reject stale heartbeats
    const lastSeq = this.heartbeatSequences.get(heartbeat.logicalStreamId) ?? -1;
    if (heartbeat.heartbeatSequence <= lastSeq) {
      return;
    }

    for (const [k, s] of this.streams) {
      if (!s.stopped &&
          s.announcement.groupId === heartbeat.groupId &&
          s.announcement.hostDeviceId === heartbeat.hostDeviceId &&
          s.announcement.logicalStreamId === heartbeat.logicalStreamId) {
        s.lastHeartbeatAt = Date.now();
        s.announcement.heartbeatSequence = heartbeat.heartbeatSequence;
        this.heartbeatSequences.set(heartbeat.logicalStreamId, heartbeat.heartbeatSequence);
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
        // Add to tombstone map to prevent resurrection
        this.stopTombstones.set(stop.logicalStreamId, Date.now());
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
    this.stopTombstones.clear();
    this.heartbeatSequences.clear();
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
          this.stopTombstones.set(s.announcement.logicalStreamId, now);
          this.emit({ type: "stopped", stream: { ...s.announcement } });
        }
      }
      // Prune old tombstones
      this.pruneTombstones(now);
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeatCheck(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Remove tombstones older than tombstoneMaxAgeMs.
   * Bound tombstone map to at most tombstoneMaxEntries entries.
   */
  private pruneTombstones(now: number): void {
    const cutoff = now - this.tombstoneMaxAgeMs;
    for (const [id, stopTime] of this.stopTombstones) {
      if (stopTime < cutoff) {
        this.stopTombstones.delete(id);
      }
    }
    // Enforce max entries — evict oldest if over limit
    if (this.stopTombstones.size > this.tombstoneMaxEntries) {
      const sorted = [...this.stopTombstones.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, sorted.length - this.tombstoneMaxEntries);
      for (const [id] of toRemove) {
        this.stopTombstones.delete(id);
      }
    }
  }
}
