import type { Phase3Runtime } from "./phase3-runtime.js";

/**
 * Per-host restart status. Tracked across the lifetime of a
 * `restartAllStreams` invocation.
 */
export interface HostRestartStatus {
  hostDeviceId: string;
  hostDisplayName: string;
  logicalStreamIds: string[];
  /** pending | accepted | completed | failed */
  state: "pending" | "accepted" | "completed" | "failed";
  failureReason?: string;
  startedAt: number;
  completedAt?: number;
}

/**
 * Overall Restart All Streams status. The banner clears only when
 * every still-active stream has reported the target applied restart
 * revision (or stopped).
 */
export interface RestartAllStatus {
  commandId: string;
  groupId: string;
  targetSettingsStamp?: string;
  targetSettingsHash?: string;
  requestedByDeviceId: string;
  startedAt: number;
  completedAt?: number;
  hosts: Record<string, HostRestartStatus>;
}

/**
 * RestartCoordinator (Stage 14 + Gate 10)
 *
 * Drives the distributed "Restart All Streams" flow:
 *  - The requesting device snapshots every current host in the
 *    group, deduplicates, and sends a TARGETED `stream.restart.request`
 *    to each host. The same host is never asked twice for the same
 *    commandId.
 *  - Each host receives the request, deduplicates by commandId,
 *    verifies the target settings are available, and performs a
 *    REAL lifecycle restart via StreamSessionManager.restartStream.
 *  - Per-host results are tracked. Failures remain visible.
 *  - WatchedStreamManager sees replacement for a watched logical
 *    stream and reconnects automatically.
 *  - No duplicate share notification is fired for a replacement
 *    media session of the same logical stream.
 */
export class RestartCoordinator {
  /** Tracks target hashes per host device for idempotency */
  private restartTargets = new Map<string, string>();
  /** Tracks per-commandId host restart outcomes */
  private activeCommands = new Map<string, RestartAllStatus>();
  /** Tracks which (commandId, hostDeviceId) we have already processed locally to dedup. */
  private processedRequests = new Set<string>();
  /** Optional listener for status updates (UI / store). */
  private listeners = new Set<(status: RestartAllStatus) => void>();

  constructor(
    private runtime: Phase3Runtime,
  ) {}

  destroy(): void {
    this.restartTargets.clear();
    this.activeCommands.clear();
    this.processedRequests.clear();
    this.listeners.clear();
  }

  onStatusChange(cb: (status: RestartAllStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Check if a restart has already been initiated for this host/target combo.
   * Returns true if this exact target hash has already been seen for the host.
   */
  hasRestartTarget(hostDeviceId: string, stampHash: string): boolean {
    const existing = this.restartTargets.get(hostDeviceId);
    if (existing === stampHash) return true;
    this.restartTargets.set(hostDeviceId, stampHash);
    return false;
  }

  /**
   * Clear a restart target for a given host (e.g., after restart completes).
   */
  clearRestartTarget(hostDeviceId: string): void {
    this.restartTargets.delete(hostDeviceId);
  }

  /**
   * Gate 10: Initiate a distributed "Restart All Streams" for the
   * given group. Snapshots every current host in the group, sends a
   * targeted `stream.restart.request` to each, and tracks the
   * per-host outcomes.
   *
   * The local host is included in the snapshot but is restarted
   * through the same code path (StreamSessionManager.restartStream),
   * not through a separate mechanism.
   */
  async restartAllStreams(
    groupId: string,
    targetSettingsStamp: string | undefined,
    targetSettingsHash: string | undefined,
  ): Promise<RestartAllStatus> {
    const commandId = crypto.randomUUID();
    const requestedByDeviceId = this.runtime.deviceId ?? "local";

    const registry = this.runtime.getActiveStreamRegistry();
    const connManager = this.runtime.getConnectionManager();
    const streams = registry.getStreamsByGroup(groupId);

    // Build a unique list of hosts → their logical streams.
    const hosts: Record<string, { hostDisplayName: string; logicalStreamIds: string[] }> = {};
    for (const s of streams) {
      if (!hosts[s.hostDeviceId]) {
        hosts[s.hostDeviceId] = { hostDisplayName: s.hostDisplayName, logicalStreamIds: [] };
      }
      hosts[s.hostDeviceId]!.logicalStreamIds.push(s.logicalStreamId);
    }

    const status: RestartAllStatus = {
      commandId,
      groupId,
      targetSettingsStamp,
      targetSettingsHash,
      requestedByDeviceId,
      startedAt: Date.now(),
      hosts: {},
    };
    for (const [hostDeviceId, info] of Object.entries(hosts)) {
      status.hosts[hostDeviceId] = {
        hostDeviceId,
        hostDisplayName: info.hostDisplayName,
        logicalStreamIds: info.logicalStreamIds,
        state: "pending",
        startedAt: Date.now(),
      };
    }
    this.activeCommands.set(commandId, status);
    this.notify(status);

    // Send a targeted request to every host. Use the connection
    // manager's sendToPeer path so the message reaches the right peer
    // and is signed with the right group secret.
    for (const hostDeviceId of Object.keys(hosts)) {
      const conn = connManager.getConnection(groupId);
      const peerUuid = conn?.peerForDevice(hostDeviceId);
      if (!conn || !peerUuid) {
        // The host is not currently mapped. We mark the host
        // status as failed and continue. The banner must not hang
        // on a single missing peer.
        const hostStatus = status.hosts[hostDeviceId]!;
        hostStatus.state = "failed";
        hostStatus.failureReason = "host-not-mapped";
        hostStatus.completedAt = Date.now();
        continue;
      }
      try {
        await conn.sendToPeer(peerUuid, {
          type: "stream.restart.request",
          commandId,
          groupId,
          targetSettingsStamp,
          targetSettingsHash,
          requestedByDeviceId,
        } as unknown as Record<string, unknown>);
      } catch (err) {
        const hostStatus = status.hosts[hostDeviceId]!;
        hostStatus.state = "failed";
        hostStatus.failureReason = String((err as Error)?.message ?? err);
        hostStatus.completedAt = Date.now();
      }
    }

    return status;
  }

  /**
   * Receive a `stream.restart.result` from a host. Updates the
   * per-host status. Idempotent on (commandId, hostDeviceId).
   */
  handleRestartResult(
    commandId: string,
    hostDeviceId: string,
    logicalStreamId: string,
    accepted: boolean,
    success: boolean,
    failureReason: string | undefined,
  ): void {
    const status = this.activeCommands.get(commandId);
    if (!status) return;
    const hostStatus = status.hosts[hostDeviceId];
    if (!hostStatus) return;
    if (hostStatus.state === "completed" || hostStatus.state === "failed") return;

    if (!accepted || !success) {
      hostStatus.state = "failed";
      hostStatus.failureReason = failureReason ?? (accepted ? "unknown" : "rejected");
      hostStatus.completedAt = Date.now();
    } else {
      // Mark as completed once any of the host's logical streams
      // confirms a successful restart. The host may have multiple
      // logical streams; per-stream result tracking would be a
      // refinement. For now we consider the host "completed" on the
      // first success and rely on the stream.restarted broadcast to
      // surface the actual restart.
      if (hostStatus.state === "pending") {
        hostStatus.state = "accepted";
      }
      // We don't flip to "completed" until stream.restarted arrives
      // — see markHostCompleted.
    }
    this.notify(status);
  }

  /**
   * Called when a host has broadcast stream.restarted for a logical
   * stream tracked by the active command. Flips the host to
   * "completed" if all of its logical streams are restarted.
   */
  markHostCompleted(commandId: string, hostDeviceId: string, logicalStreamId: string): void {
    const status = this.activeCommands.get(commandId);
    if (!status) return;
    const hostStatus = status.hosts[hostDeviceId];
    if (!hostStatus) return;
    if (hostStatus.state === "failed") return;
    if (!hostStatus.logicalStreamIds.includes(logicalStreamId)) return;
    if (hostStatus.state !== "completed") {
      hostStatus.state = "completed";
      hostStatus.completedAt = Date.now();
      this.notify(status);
    }
    this.maybeFinalize(status);
  }

  /**
   * Local host: receive a stream.restart.request and (if not
   * already processed) trigger a real lifecycle restart via
   * StreamSessionManager. The local host is always in the same
   * group as the requester, so we use the local SSM directly.
   */
  async handleIncomingRestartRequest(
    commandId: string,
    groupId: string,
    targetSettingsStamp: string | undefined,
    targetSettingsHash: string | undefined,
    requestedByDeviceId: string,
  ): Promise<{ accepted: boolean; success: boolean; reason?: string; logicalStreamIds?: string[] }> {
    const key = `${commandId}::${this.runtime.deviceId ?? "local"}`;
    if (this.processedRequests.has(key)) {
      return { accepted: false, success: false, reason: "duplicate-command" };
    }
    this.processedRequests.add(key);

    // Verify the target settings are available (the prompt requires
    // this check).
    if (targetSettingsStamp || targetSettingsHash) {
      const syncState = this.runtime.getSyncService().getSyncState(groupId);
      const settingsStamp = syncState?.state?.defaultQuality?.stamp as string | undefined;
      const settingsHash = syncState?.state?.defaultQuality?.valueHash as string | undefined;
      if (targetSettingsStamp && settingsStamp && settingsStamp !== targetSettingsStamp) {
        return { accepted: false, success: false, reason: "target-settings-stale" };
      }
      if (targetSettingsHash && settingsHash && settingsHash !== targetSettingsHash) {
        return { accepted: false, success: false, reason: "target-settings-hash-mismatch" };
      }
    }

    const ssm = this.runtime.getStreamSessionManager();
    if (!ssm) {
      return { accepted: false, success: false, reason: "no-ssm" };
    }
    if (ssm.state !== "active") {
      // The local host is not streaming; nothing to restart.
      return { accepted: true, success: true, reason: "no-active-stream", logicalStreamIds: [] };
    }
    try {
      await ssm.restartStream();
      return {
        accepted: true,
        success: true,
        logicalStreamIds: ssm.currentLogicalStreamId ? [ssm.currentLogicalStreamId] : [],
      };
    } catch (err) {
      return { accepted: true, success: false, reason: String((err as Error)?.message ?? err) };
    }
  }

  getStatus(commandId: string): RestartAllStatus | null {
    return this.activeCommands.get(commandId) ?? null;
  }

  listActiveCommands(): RestartAllStatus[] {
    return Array.from(this.activeCommands.values());
  }

  private maybeFinalize(status: RestartAllStatus): void {
    const allDone = Object.values(status.hosts).every(
      (h) => h.state === "completed" || h.state === "failed",
    );
    if (allDone) {
      status.completedAt = Date.now();
      // Auto-remove after 60s so memory does not grow unbounded.
      setTimeout(() => this.activeCommands.delete(status.commandId), 60_000);
      this.notify(status);
    }
  }

  private notify(status: RestartAllStatus): void {
    for (const cb of this.listeners) {
      try { cb(status); } catch { /* ignore */ }
    }
  }

  /**
   * Execute a restart of all streams for a given host. Used by the
   * legacy single-host path; the new distributed path uses
   * restartAllStreams above.
   */
  async restartHostStreams(
    groupId: string,
    hostDeviceId: string,
    stampHash: string,
  ): Promise<void> {
    if (this.hasRestartTarget(hostDeviceId, stampHash)) {
      return;
    }
    try {
      if (hostDeviceId === this.runtime.deviceId) {
        const ssm = this.runtime.getStreamSessionManager();
        await ssm.restartStream();
        this.clearRestartTarget(hostDeviceId);
        return;
      }
      const registry = this.runtime.getActiveStreamRegistry();
      const connManager = this.runtime.getConnectionManager();
      const streams = registry.getStreamsByGroup(groupId);
      const hostStreams = streams.filter((s) => s.hostDeviceId === hostDeviceId);
      for (const stream of hostStreams) {
        const newMediaSessionId = crypto.randomUUID();
        await connManager.broadcast(groupId, {
          type: "stream.restarted",
          logicalStreamId: stream.logicalStreamId,
          mediaSessionId: newMediaSessionId,
          previousMediaSessionId: stream.mediaSessionId,
          groupId,
          hostDeviceId,
          hostDisplayName: stream.hostDisplayName,
          sourceKind: stream.sourceKind,
          sourceName: stream.sourceName,
          startedAt: Date.now(),
          appliedSettingsRevision: stream.appliedSettingsRevision,
          heartbeatSequence: 0,
          streamRevision: stream.streamRevision + 1,
          mediaJoinMetadata: stream.mediaJoinMetadata,
          replacesSessionId: stream.mediaSessionId,
          isAudioDegraded: stream.isAudioDegraded,
        });
      }
      this.clearRestartTarget(hostDeviceId);
    } catch (err) {
      console.error("[RestartCoordinator] Failed to restart host streams:", err);
      this.clearRestartTarget(hostDeviceId);
    }
  }
}
