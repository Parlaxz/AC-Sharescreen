import type { GroupControlEnvelope, GroupControlMessageType } from "@screenlink/shared";
import { parseGroupMessagePayload, createDefaultGroupQualitySettings, createDefaultHostQualityLimits } from "@screenlink/shared";
import type { GroupSyncService } from "./group-sync-service.js";
import type { ActiveStreamRegistry } from "./active-stream-registry.js";
import type { ViewerMediaBinding } from "./viewer-media-binding.js";
import type { GroupConnectionManager } from "./group-connection-manager.js";
import type { QualityCoordinator } from "./quality-coordinator.js";
import type { Phase3Runtime } from "./phase3-runtime.js";

/**
 * C1: GroupMessageRouter (Stages 4–5)
 *
 * Sole message handler for GroupConnectionManager.
 * Receives validated GroupControlEnvelopes and routes them
 * to the appropriate service based on envelope type.
 *
 * Routing order (Stage 5: exact types first, then generic):
 *   group.state.*, group.member.update   → GroupSyncService
 *   stream.join.request                   → ViewerMediaBinding (host handles join)
 *   stream.join.response                  → (viewer handles accepted response)
 *   stream.leave                          → ViewerMediaBinding (cleanup)
 *   stream.restart.request                → (future: restart handling)
 *   stream.restart.result                 → (future: restart result)
 *   stream.restarted                      → ActiveStreamRegistry (replacement)
 *   media.bind                            → ViewerMediaBinding (token consumption)
 *   quality.*                             → (future) QualityCoordinator
 *   ping / pong                           → connection health tracking
 *   stream.* (generic)                    → ActiveStreamRegistry (lifecycle)
 */
export interface JoinResponseData {
  logicalStreamId: string;
  accepted: boolean;
  viewerDeviceId: string;
  mediaJoinMetadata?: string;
  mediaSessionId?: string;
  /** VDO stream ID for connecting the ViewerClient */
  streamId?: string;
  /** VDO password for connecting the ViewerClient */
  password?: string;
  /** Binding token for media.bind (same as mediaJoinMetadata, explicit) */
  bindingToken?: string;
  reason?: string;
  requestId?: string;
}

export class GroupMessageRouter {
  private pingTimestamps = new Map<string, number>();
  private pongTimestamps = new Map<string, number>();

  /** Pending join request resolvers keyed by requestId */
  private joinResponseResolvers = new Map<string, {
    resolve: (data: JoinResponseData) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /** Stage 6: Quality coordinator for quality message routing */
  private qualityCoordinator: QualityCoordinator | null = null;

  /** Runtime reference for accessing viewer binding and stats service */
  private runtime: Phase3Runtime | null = null;

  constructor(
    private syncService: GroupSyncService,
    private streamRegistry: ActiveStreamRegistry,
    private connManager: GroupConnectionManager,
    private viewerBinding?: ViewerMediaBinding,
  ) {}

  /**
   * Set the runtime reference for accessing viewer binding and stats service.
   */
  setRuntime(runtime: Phase3Runtime): void {
    this.runtime = runtime;
  }

  /**
   * Stage 6: Set the quality coordinator for quality message routing.
   * Called after construction when the quality coordinator is available.
   */
  setQualityCoordinator(coordinator: QualityCoordinator): void {
    this.qualityCoordinator = coordinator;
  }

  /**
   * Wait for a stream.join.response matching the given requestId.
   * Returns a promise that resolves with the response data or rejects
   * after the timeout (default 30 seconds).
   */
  waitForJoinResponse(requestId: string, timeoutMs = 30_000): Promise<JoinResponseData> {
    return new Promise((resolve, reject) => {
      // Check if already resolved
      const existing = this.joinResponseResolvers.get(requestId);
      if (existing) {
        reject(new Error("Duplicate waitForJoinResponse for requestId"));
        return;
      }
      const timer = setTimeout(() => {
        this.joinResponseResolvers.delete(requestId);
        reject(new Error(`Join response timeout for request ${requestId.slice(0, 8)}`));
      }, timeoutMs);
      this.joinResponseResolvers.set(requestId, { resolve, reject, timer });
    });
  }

  /**
   * Route a validated GroupControlEnvelope to the appropriate service.
   * Called by GroupConnectionManager's onMessage callback.
   * Validates payload against schema before routing to prevent malformed
   * data from reaching services.
   */
  routeMessage(groupId: string, envelope: GroupControlEnvelope): void {
    const type = envelope.type;

    // ── Schema validation for ALL message types — top-level guard.
    //    Handlers below re-parse with the literal type so the payload
    //    is correctly narrowed to GroupControlPayloadMap[T] instead of
    //    a discriminated union.
    if (!parseGroupMessagePayload(type, envelope.payload).ok) return;

    // ── group.state.*, group.member.* → GroupSyncService ──────────
    if (
      type.startsWith("group.state.") ||
      type === "group.member.update"
    ) {
      void this.syncService.handleGroupMessage(groupId, envelope);
      return;
    }

    // ── Stage 5: Exact match types BEFORE generic stream.* ─────────
    // This ensures stream.join.request, stream.leave, media.bind etc.
    // are not caught by the generic stream.* catch-all below.

    // stream.join.request → ViewerMediaBinding (host-side join handling)
    if (type === "stream.join.request") {
      if (this.viewerBinding) {
        this.viewerBinding.handleJoinRequest(envelope);
      }
      return;
    }

    // stream.join.response → resolve pending join request
    if (type === "stream.join.response") {
      const parsed = parseGroupMessagePayload("stream.join.response", envelope.payload);
      if (!parsed.ok) return;
      const joinData = parsed.data;
      const requestId = joinData.requestId;
      if (requestId) {
        const resolver = this.joinResponseResolvers.get(requestId);
        if (resolver) {
          clearTimeout(resolver.timer);
          this.joinResponseResolvers.delete(requestId);
          resolver.resolve({
            logicalStreamId: joinData.logicalStreamId,
            accepted: joinData.accepted,
            viewerDeviceId: joinData.viewerDeviceId,
            mediaJoinMetadata: joinData.mediaJoinMetadata,
            mediaSessionId: joinData.mediaSessionId,
            streamId: joinData.streamId,
            password: joinData.password,
            bindingToken: joinData.bindingToken,
            reason: joinData.reason,
            requestId: joinData.requestId,
          });
        }
      }
      return;
    }

    // stream.leave → ViewerMediaBinding (viewer disconnect cleanup)
    if (type === "stream.leave") {
      if (this.viewerBinding) {
        const leaveData = parseGroupMessagePayload("stream.leave", envelope.payload);
        if (!leaveData.ok) return;
        const viewerDeviceId = leaveData.data.viewerDeviceId;
        if (viewerDeviceId) {
          this.viewerBinding.removeViewer(viewerDeviceId);
        }
      }
      return;
    }

    // stream.restart.request → (future: forward to stream manager)
    if (type === "stream.restart.request") {
      // Future: forward to StreamSessionManager or QualityCoordinator
      return;
    }

    // stream.restart.result → (future: handle restart outcome)
    if (type === "stream.restart.result") {
      return;
    }

    // stream.restarted → ActiveStreamRegistry (handles as replacement via replacesSessionId)
    // The expanded StreamRestartedPayloadSchema now includes all StreamAnnouncement fields
    // (groupId, hostDeviceId, heartbeatSequence, streamRevision, replacesSessionId, etc.),
    // so handleStarted correctly identifies it as a replacement, not a new stream.
    if (type === "stream.restarted") {
      const r = parseGroupMessagePayload("stream.restarted", envelope.payload);
      if (!r.ok) return;
      void this.streamRegistry.handleStarted(r.data as never);
      return;
    }

    // media.bind → ViewerMediaBinding (token consumption via actual media peer UUID)
    if (type === "media.bind") {
      if (this.viewerBinding) {
        const bindData = parseGroupMessagePayload("media.bind", envelope.payload);
        if (!bindData.ok) return;
        const peerUuid = envelope.senderDeviceId;
        const token = bindData.data.token;
        if (peerUuid && token) {
          void this.viewerBinding.handleMediaBind(peerUuid, token);
        }
      }
      return;
    }

    // ── quality.* → QualityCoordinator (Stage 6) ──────────────────
    if (
      type.startsWith("quality.viewer.") ||
      type === "quality.effective" ||
      type === "quality.configured" ||
      type === "quality.observed"
    ) {
      this.handleQualityMessage(groupId, type, envelope);
      return;
    }

    // ── ping / pong → connection health tracking ──────────────────
    if (type === "ping") {
      const pingData = parseGroupMessagePayload("ping", envelope.payload);
      if (!pingData.ok) return;
      const seq = pingData.data.seq;
      this.pingTimestamps.set(`${groupId}:${envelope.senderDeviceId}:${seq}`, Date.now());
      // Respond with pong
      const conn = this.connManager.getConnection(groupId);
      if (conn) {
        const peerUuid = conn.peerForDevice(envelope.senderDeviceId);
        if (peerUuid) {
          void conn.sendToPeer(peerUuid, { type: "pong", seq });
        }
      }
      return;
    }

    if (type === "pong") {
      const pongData = parseGroupMessagePayload("pong", envelope.payload);
      if (!pongData.ok) return;
      const seq = pongData.data.seq;
      this.pongTimestamps.set(`${groupId}:${envelope.senderDeviceId}:${seq}`, Date.now());
      return;
    }

    // ── Generic stream.* → ActiveStreamRegistry (lifecycle) ──────
    if (type.startsWith("stream.")) {
      const r = parseGroupMessagePayload(type, envelope.payload);
      if (!r.ok) return;
      void this.routeStreamMessage(type, envelope, r.data);
      return;
    }
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

  // ── Quality message handling (Stage 6) ───────────────────────

  private handleQualityMessage(
    groupId: string,
    type: string,
    envelope: GroupControlEnvelope,
  ): void {
    if (!this.qualityCoordinator) {
      return; // No coordinator configured yet, silently ignore
    }

    if (type === "quality.viewer.request") {
      const parsed = parseGroupMessagePayload("quality.viewer.request", envelope.payload);
      if (!parsed.ok) return;
      const data = parsed.data;
      // The streamSessionId from the quality payload serves as the logicalStreamId
      // for storage key construction.
      const logicalStreamId = data.streamSessionId;
      this.qualityCoordinator.handleViewerRequest(
        groupId,
        logicalStreamId,
        envelope.senderDeviceId,
        {
          streamSessionId: data.streamSessionId,
          requestId: data.requestId,
          revision: data.revision,
          videoBitrateKbps: data.videoBitrateKbps,
          maxWidth: data.maxWidth,
          maxHeight: data.maxHeight,
          maxFps: data.maxFps,
          degradationPreference: data.degradationPreference,
        },
      );

      // Apply quality to the exact viewer sender
      if (this.runtime) {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        const sender = viewerBinding.getViewerVideoSender(envelope.senderDeviceId);
        if (sender && this.qualityCoordinator) {
          // Get the stored viewer request and compute effective quality
          const request = this.qualityCoordinator.getViewerRequest(
            groupId,
            logicalStreamId,
            envelope.senderDeviceId,
          );
          if (request) {
            const groupSettings = createDefaultGroupQualitySettings();
            const hostLimits = createDefaultHostQualityLimits();
            const sourceDimensions = { width: 1920, height: 1080 };

            const effective = this.qualityCoordinator.calculateEffectiveQuality(
              groupSettings,
              hostLimits,
              request,
              sourceDimensions,
            );

            this.qualityCoordinator.applyToExactViewer(
              envelope.senderDeviceId,
              envelope.senderDeviceId,
              sender,
              effective.effective,
            ).catch(() => {});
          }
        }
      }
      return;
    }

    if (type === "quality.viewer.clear") {
      const parsed = parseGroupMessagePayload("quality.viewer.clear", envelope.payload);
      if (!parsed.ok) return;
      const data = parsed.data;
      const logicalStreamId = data.streamSessionId;
      this.qualityCoordinator.handleViewerClear(
        groupId,
        logicalStreamId,
        envelope.senderDeviceId,
      );

      // Clear quality on the exact viewer sender (reset to group defaults)
      if (this.runtime) {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        const sender = viewerBinding.getViewerVideoSender(envelope.senderDeviceId);
        if (sender && this.qualityCoordinator) {
          const groupSettings = createDefaultGroupQualitySettings();
          const hostLimits = createDefaultHostQualityLimits();
          const sourceDimensions = { width: 1920, height: 1080 };

          const effective = this.qualityCoordinator.calculateEffectiveQuality(
            groupSettings,
            hostLimits,
            null, // No viewer request → apply group defaults
            sourceDimensions,
          );

          this.qualityCoordinator.applyToExactViewer(
            envelope.senderDeviceId,
            envelope.senderDeviceId,
            sender,
            effective.effective,
          ).catch(() => {});
        }
      }
      return;
    }

    // quality.effective, quality.configured, quality.observed are
    // informational broadcasts — the coordinator may track them in future.
  }

  // ── Private ──────────────────────────────────────────────────

  private async routeStreamMessage(
    groupId: string,
    envelope: GroupControlEnvelope,
    _validatedPayload: unknown,
  ): Promise<void> {
    const type = envelope.type;

    switch (type) {
      case "stream.started":
        this.streamRegistry.handleStarted(_validatedPayload as never);
        break;

      case "stream.heartbeat":
        this.streamRegistry.handleHeartbeat(_validatedPayload as never);
        break;

      case "stream.stopped":
        this.streamRegistry.handleStopped(_validatedPayload as never);
        break;

      case "stream.state.snapshot": {
        const snapshotPayload = _validatedPayload as { streams: unknown[] };
        this.streamRegistry.handleSnapshot(snapshotPayload?.streams as never ?? []);
        break;
      }

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
