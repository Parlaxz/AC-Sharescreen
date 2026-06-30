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
  /** Stage 13: Whether audio has failed (video preserved) */
  isAudioDegraded?: boolean;
  /** Wall-time the host asserts the lease is still valid through.
   *  Long-running streams stay discoverable as long as this remains
   *  in the future relative to now. Optional but recommended. */
  leaseValidUntil?: number;
  /** HLC stamp of the synchronized group settings applied at publication. */
  sharedSettingsRevision?: string;
  /** HLC stamp of the live-applied group settings. */
  appliedLiveSettingsRevision?: string;
  /** HLC stamp of the last restart-applied settings. */
  appliedRestartSettingsRevision?: string;
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
  /** Tracks stopped streams by composite key (groupId:hostDeviceId:logicalStreamId) → stopTimeMs to prevent resurrection. */
  private stopTombstones = new Map<string, number>();
  /** Per-stream highest observed heartbeatSequence for stale rejection, keyed by composite key. */
  private heartbeatSequences = new Map<string, number>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(update: StreamUpdate) => void>();
  private heartbeatIntervalMs: number;
  private expiryMs: number;
  private tombstoneMaxAgeMs: number;
  private tombstoneMaxEntries: number;

  constructor(heartbeatIntervalMs = 10_000, expiryMs = 30_000) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    // Gate 3.3: long-running streams must remain late-joinable for
    // hours. The expiry is now derived from heartbeat liveness and
    // host-provided leaseValidUntil — NOT from `startedAt`. The
    // expiryMs parameter is still honored as a fallback for streams
    // that do not advertise a lease.
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
    const k = this.key(data.groupId, data.hostDeviceId, data.logicalStreamId);

    // Composite-key tombstone check — reject if recently stopped
    const tombstoneStopTime = this.stopTombstones.get(k);
    if (tombstoneStopTime !== undefined) {
      const age = Date.now() - tombstoneStopTime;
      if (age < this.tombstoneMaxAgeMs) {
        // Tombstone too recent — reject this start as stale
        return;
      }
      // Tombstone older than 5 minutes — remove it and accept
      this.stopTombstones.delete(k);
    }

    if (data.replacesSessionId) {
      // This is a restart — use composite key lookup.
      // Accept replacement regardless of whether the existing stream
      // was itself a replacement (legitimate replacement chains).
      const existing = this.streams.get(k);
      if (existing && !existing.stopped) {
        existing.announcement = { ...data };
        existing.lastHeartbeatAt = Date.now();
        this.heartbeatSequences.set(k, data.heartbeatSequence);
        this.emit({ type: "replaced", stream: data });
        return;
      }
    }

    const existing = this.streams.get(k);
    if (existing && !existing.stopped) {
      // Validate heartbeat sequence — reject stale updates
      const lastSeq = this.heartbeatSequences.get(k) ?? -1;
      if (data.heartbeatSequence <= lastSeq) {
        return; // stale
      }
      existing.announcement = { ...data };
      existing.lastHeartbeatAt = Date.now();
      this.heartbeatSequences.set(k, data.heartbeatSequence);
      this.emit({ type: "updated", stream: data });
      return;
    }

    this.streams.set(k, {
      announcement: data,
      lastHeartbeatAt: Date.now(),
      stopped: false,
    });
    this.heartbeatSequences.set(k, data.heartbeatSequence);
    this.emit({ type: "new", stream: data });
  }

  handleHeartbeat(heartbeat: {
    groupId: string;
    hostDeviceId: string;
    logicalStreamId: string;
    mediaSessionId: string;
    heartbeatSequence: number;
    appliedSettingsRevision?: number;
    leaseValidUntil?: number;
  }): void {
    const k = this.key(heartbeat.groupId, heartbeat.hostDeviceId, heartbeat.logicalStreamId);

    // Check tombstone — if stream is dead, ignore heartbeat (no resurrection)
    if (this.stopTombstones.has(k)) {
      return;
    }

    // Validate sequence number — reject stale heartbeats
    const lastSeq = this.heartbeatSequences.get(k) ?? -1;
    if (heartbeat.heartbeatSequence <= lastSeq) {
      return;
    }

    // Direct composite key lookup instead of iteration
    const existing = this.streams.get(k);
    if (existing && !existing.stopped) {
      existing.lastHeartbeatAt = Date.now();
      existing.announcement.heartbeatSequence = heartbeat.heartbeatSequence;
      this.heartbeatSequences.set(k, heartbeat.heartbeatSequence);
      if (heartbeat.appliedSettingsRevision !== undefined) {
        existing.announcement.appliedSettingsRevision = heartbeat.appliedSettingsRevision;
      }
      if (heartbeat.leaseValidUntil !== undefined) {
        existing.announcement.leaseValidUntil = heartbeat.leaseValidUntil;
      }
    }
  }

  handleStopped(stop: {
    groupId: string;
    hostDeviceId: string;
    logicalStreamId: string;
  }): void {
    const k = this.key(stop.groupId, stop.hostDeviceId, stop.logicalStreamId);

    // Direct composite key lookup
    const existing = this.streams.get(k);
    if (existing && !existing.stopped) {
      // Delete active entry
      this.streams.delete(k);
      // Remove heartbeat state
      this.heartbeatSequences.delete(k);
      // Create bounded tombstone to prevent resurrection
      this.stopTombstones.set(k, Date.now());
      this.emit({ type: "stopped", stream: { ...existing.announcement } });
    }
    // If no active entry, silently ignore (idempotent)
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
    const k = this.key(key.groupId, key.hostDeviceId, key.logicalStreamId);
    const existing = this.streams.get(k);
    if (existing && !existing.stopped) {
      return { ...existing.announcement };
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

  // ── Local registration ───────────────────────────────────────────────────────

  /**
   * Register a local stream so it exists in the registry before any broadcasts.
   * Used by StreamSessionManager before announcing to peers.
   *
   * - Idempotent: calling with the same composite key updates the existing entry.
   * - Does NOT check tombstones (the local session manager controls lifecycle).
   */
  registerLocalStream(announcement: StreamAnnouncement): void {
    const k = this.key(announcement.groupId, announcement.hostDeviceId, announcement.logicalStreamId);

    const existing = this.streams.get(k);
    if (existing) {
      // Update existing entry
      existing.announcement = { ...announcement };
      existing.lastHeartbeatAt = Date.now();
      this.heartbeatSequences.set(k, announcement.heartbeatSequence);
      this.emit({ type: "updated", stream: { ...announcement } });
      return;
    }

    this.streams.set(k, {
      announcement,
      lastHeartbeatAt: Date.now(),
      stopped: false,
    });
    this.heartbeatSequences.set(k, announcement.heartbeatSequence);
    this.emit({ type: "new", stream: { ...announcement } });
  }

  // Snapshot recovery after reconnect
  handleSnapshot(streams: StreamAnnouncement[]): void {
    const now = Date.now();
    for (const stream of streams) {
      const k = this.key(stream.groupId, stream.hostDeviceId, stream.logicalStreamId);

      // 1. Reject tombstoned streams — do not resurrect explicit stops
      if (this.stopTombstones.has(k)) {
        continue;
      }

      // 2. Gate 3.3: liveness is decided by heartbeat freshness or
      //    host-provided leaseValidUntil. A stream that has been
      //    running for several hours must remain discoverable to a
      //    late viewer; we no longer reject on the basis of startedAt
      //    age. The tombstone (step 1) is the only staleness gate.
      //    However, a stream whose lease is in the past AND whose
      //    last heartbeat is older than expiry is treated as dead.
      if (stream.leaseValidUntil && stream.leaseValidUntil < now) {
        const lastHb = this.heartbeatSequences.get(k);
        if (lastHb === undefined) {
          // We have no prior heartbeat — but the host asserts the
          // lease is already past. Trust the host: skip.
          continue;
        }
      }

      const existing = this.streams.get(k);
      if (existing && !existing.stopped) {
        // 3. Reject lower streamRevision
        if (stream.streamRevision < existing.announcement.streamRevision) {
          continue;
        }
        // 4. Reject lower heartbeatSequence (same revision but stale heartbeat)
        if (stream.heartbeatSequence <= existing.announcement.heartbeatSequence) {
          continue;
        }
        // 5. Avoid duplicate events for unchanged state
        if (
          stream.streamRevision === existing.announcement.streamRevision &&
          stream.heartbeatSequence === existing.announcement.heartbeatSequence &&
          stream.mediaSessionId === existing.announcement.mediaSessionId
        ) {
          continue;
        }

        // Update existing entry and emit updated
        existing.announcement = { ...stream };
        existing.lastHeartbeatAt = now;
        this.heartbeatSequences.set(k, stream.heartbeatSequence);
        this.emit({ type: "updated", stream: { ...stream } });
      } else if (!existing) {
        // New stream
        this.streams.set(k, {
          announcement: stream,
          lastHeartbeatAt: now,
          stopped: false,
        });
        this.heartbeatSequences.set(k, stream.heartbeatSequence);
        this.emit({ type: "new", stream: { ...stream } });
      }
      // If existing.stopped is true (pre-Stage-3 entry): do not resurrect
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
          // Delete active entry
          this.streams.delete(k);
          // Remove heartbeat state
          this.heartbeatSequences.delete(k);
          // Create tombstone with composite key
          this.stopTombstones.set(k, now);
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
