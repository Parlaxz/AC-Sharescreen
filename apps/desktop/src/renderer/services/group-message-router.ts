import type { GroupControlEnvelope } from "@screenlink/shared";
import type { GroupSyncService } from "./group-sync-service.js";
import type { ActiveStreamRegistry } from "./active-stream-registry.js";
import type { ViewerMediaBinding } from "./viewer-media-binding.js";
import type { GroupConnectionManager } from "./group-connection-manager.js";

/**
 * C1: GroupMessageRouter
 *
 * Sole message handler for GroupConnectionManager.
 * Receives validated GroupControlEnvelopes and routes them
 * to the appropriate service based on envelope type.
 *
 * Routing table:
 *   group.state.*         → GroupSyncService
 *   stream.*              → ActiveStreamRegistry
 *   stream.join.request   → ViewerMediaBinding
 *   media.bind            → ViewerMediaBinding
 *   quality.*             → (future) QualityCoordinator
 *   ping / pong           → connection health tracking
 */
export class GroupMessageRouter {
  private pingTimestamps = new Map<string, number>();
  private pongTimestamps = new Map<string, number>();

  constructor(
    private syncService: GroupSyncService,
    private streamRegistry: ActiveStreamRegistry,
    private connManager: GroupConnectionManager,
    private viewerBinding?: ViewerMediaBinding,
  ) {}

  /**
   * Route a validated GroupControlEnvelope to the appropriate service.
   * Called by GroupConnectionManager's onMessage callback.
   */
  routeMessage(groupId: string, envelope: GroupControlEnvelope): void {
    const type = envelope.type;

    // ── group.state.*, group.member.* → GroupSyncService ──────────
    if (
      type.startsWith("group.state.") ||
      type === "group.member.update"
    ) {
      void this.syncService.handleGroupMessage(groupId, envelope);
      return;
    }

    // ── stream.* → ActiveStreamRegistry ───────────────────────────
    if (type.startsWith("stream.")) {
      void this.routeStreamMessage(groupId, envelope);
      return;
    }

    // ── stream.join.request, media.bind → ViewerMediaBinding ──────
    if (type === "stream.join.request") {
      if (this.viewerBinding) {
        this.viewerBinding.handleJoinRequest(envelope);
      }
      return;
    }

    if (type === "media.bind") {
      if (this.viewerBinding) {
        const peerUuid = envelope.senderDeviceId;
        const token = envelope.payload?.token as string | undefined;
        if (peerUuid && token) {
          void this.viewerBinding.handleMediaBind(peerUuid, token);
        }
      }
      return;
    }

    // ── ping / pong → connection health tracking ──────────────────
    if (type === "ping") {
      const seq = envelope.payload?.seq as number | undefined;
      if (seq !== undefined) {
        this.pingTimestamps.set(`${groupId}:${envelope.senderDeviceId}:${seq}`, Date.now());
        // Respond with pong
        const conn = this.connManager.getConnection(groupId);
        if (conn) {
          const peerUuid = conn.peerForDevice(envelope.senderDeviceId);
          if (peerUuid) {
            void conn.sendToPeer(peerUuid, { type: "pong", seq });
          }
        }
      }
      return;
    }

    if (type === "pong") {
      const seq = envelope.payload?.seq as number | undefined;
      if (seq !== undefined) {
        this.pongTimestamps.set(`${groupId}:${envelope.senderDeviceId}:${seq}`, Date.now());
      }
      return;
    }

    // ── quality.* → (future) QualityCoordinator ───────────────────
    // Currently unhandled — will route to QualityCoordinator in future phase.
  }

  /**
   * Get round-trip time for a given ping to a device.
   * Returns undefined if no matching pong has been received.
   */
  getRoundTripTime(groupId: string, deviceId: string, seq: number): number | undefined {
    const pingKey = `${groupId}:${deviceId}:${seq}`;
    const pingTime = this.pingTimestamps.get(pingKey);
    const pongTime = this.pongTimestamps.get(pingKey);
    if (pingTime !== undefined && pongTime !== undefined) {
      return pongTime - pingTime;
    }
    return undefined;
  }

  // ── Private ──────────────────────────────────────────────────

  private async routeStreamMessage(groupId: string, envelope: GroupControlEnvelope): Promise<void> {
    const type = envelope.type;
    const payload = envelope.payload;

    switch (type) {
      case "stream.started":
        this.streamRegistry.handleStarted(payload as any);
        break;

      case "stream.heartbeat":
        this.streamRegistry.handleHeartbeat(payload as any);
        break;

      case "stream.stopped":
        this.streamRegistry.handleStopped(payload as any);
        break;

      case "stream.state.snapshot":
        this.streamRegistry.handleSnapshot(payload?.streams as any);
        break;

      case "stream.state.request":
        // Respond with snapshot of our current streams
        await this.respondWithSnapshot(groupId, envelope);
        break;

      default:
        // Unknown stream.* types are silently ignored
        break;
    }
  }

  private async respondWithSnapshot(groupId: string, request: GroupControlEnvelope): Promise<void> {
    const conn = this.connManager.getConnection(groupId);
    if (!conn) return;
    const peerUuid = conn.peerForDevice(request.senderDeviceId);
    if (!peerUuid) return;

    const streams = this.streamRegistry.getAllStreams();
    await conn.sendToPeer(peerUuid, {
      type: "stream.state.snapshot",
      streams,
    });
  }
}
