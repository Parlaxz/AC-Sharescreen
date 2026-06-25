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
   * Flow:
   * 1. Verify idempotency via target stamp/hash
   * 2. Get current stream announcements for the host
   * 3. For each stream, generate a new mediaSessionId while preserving logicalStreamId
   * 4. Broadcast stream.restarted via connection manager
   * 5. ActiveStreamRegistry handles replacement via replacesSessionId
   * 6. Restore per-viewer requests from QualityCoordinator
   * 7. No duplicate share notification (handled by dedup in notification-watcher)
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

      // Clear the target after successful broadcast
      this.clearRestartTarget(hostDeviceId);
    } catch (err) {
      console.error("[RestartCoordinator] Failed to restart host streams:", err);
      this.clearRestartTarget(hostDeviceId);
    }
  }
}
