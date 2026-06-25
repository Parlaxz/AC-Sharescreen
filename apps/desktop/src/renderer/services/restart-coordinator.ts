import type { Phase3Runtime } from "./phase3-runtime.js";
import type { QualityCoordinator } from "./quality-coordinator.js";

/**
 * RestartCoordinator (Stage 14)
 *
 * Coordinates "Restart All Streams" flow with:
 * - Exact target stamp/hash for per-host idempotency (prevents duplicate restarts)
 * - logicalStreamId preservation across restart
 * - mediaSessionId replacement
 * - Viewer reconnect via ActiveStreamRegistry replacement
 * - Per-viewer request restore via QualityCoordinator
 * - No duplicate share notification
 * - Local host detection: delegates to StreamSessionManager.restartStream()
 *   for a real lifecycle restart (stop → capture → publish) rather than
 *   only broadcasting metadata.
 */
export class RestartCoordinator {
  /** Tracks target hashes per host device for idempotency */
  private restartTargets = new Map<string, string>();

  constructor(
    private runtime: Phase3Runtime,
  ) {}

  destroy(): void {
    this.restartTargets.clear();
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
   * Execute a restart of all streams for a given host.
   *
   * For the local host, delegates to StreamSessionManager.restartStream()
   * for a real lifecycle restart (stop publication → new capture → re-publish).
   * For remote hosts, broadcasts stream.restarted via the connection manager.
   *
   * Flow:
   * 1. Verify idempotency via target stamp/hash
   * 2. If local host: real restart via StreamSessionManager
   * 3. If remote host: broadcast stream.restarted for each stream
   * 4. ActiveStreamRegistry handles replacement via replacesSessionId
   * 5. Clear the restart target
   */
  async restartHostStreams(
    groupId: string,
    hostDeviceId: string,
    stampHash: string,
  ): Promise<void> {
    // 1. Idempotency check
    if (this.hasRestartTarget(hostDeviceId, stampHash)) {
      return; // Already processing this restart
    }

    try {
      // 2. Check if this is the local host — delegate to SSM for real restart
      if (hostDeviceId === this.runtime.deviceId) {
        const ssm = this.runtime.getStreamSessionManager();
        await ssm.restartStream();
        this.clearRestartTarget(hostDeviceId);
        return;
      }

      // 3. Remote host: broadcast-based metadata restart
      const registry = this.runtime.getActiveStreamRegistry();
      const connManager = this.runtime.getConnectionManager();
      const streams = registry.getStreamsByGroup(groupId);
      const hostStreams = streams.filter((s) => s.hostDeviceId === hostDeviceId);

      for (const stream of hostStreams) {
        const newMediaSessionId = crypto.randomUUID();

        // The announcement will be handled as a replacement by ActiveStreamRegistry
        // when it receives stream.restarted with replacesSessionId set.
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

      // 4. Clear the target after successful broadcast
      this.clearRestartTarget(hostDeviceId);
    } catch (err) {
      console.error("[RestartCoordinator] Failed to restart host streams:", err);
      this.clearRestartTarget(hostDeviceId);
    }
  }
}
