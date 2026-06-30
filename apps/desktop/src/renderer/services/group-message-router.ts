import type { GroupControlEnvelope, GroupControlMessageType, HostQualityLimits } from "@screenlink/shared";
import { parseGroupMessagePayload, createDefaultGroupQualitySettings } from "@screenlink/shared";
import type { GroupSyncService } from "./group-sync-service.js";
import type { ActiveStreamRegistry } from "./active-stream-registry.js";
import type { ViewerMediaBinding } from "./viewer-media-binding.js";
import type { GroupConnectionManager } from "./group-connection-manager.js";
import type { QualityCoordinator, EffectiveQuality } from "./quality-coordinator.js";
import type { Phase3Runtime } from "./phase3-runtime.js";
import { showNotification } from "./notifications.js";

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

export interface RecentMemberEvent {
  type: "joined" | "online";
  memberDeviceId: string;
  memberDisplayName: string;
  at: number;
}

export class GroupMessageRouter {
  private pingTimestamps = new Map<string, number>();
  private pongTimestamps = new Map<string, number>();

  /**
   * Per-group ring buffer of recent member events (joined/online).
   * Used to replay notifications when the local user comes online.
   */
  private recentMemberEvents = new Map<string, RecentMemberEvent[]>();
  private static readonly MAX_RECENT_EVENTS_PER_GROUP = 50;

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
   * Cancel a pending join response waiter. Removes the timer and rejects
   * the pending promise. Idempotent — safe to call after the response
   * already arrived or the timeout fired.
   */
  cancelJoinResponse(requestId: string): void {
    const resolver = this.joinResponseResolvers.get(requestId);
    if (resolver) {
      clearTimeout(resolver.timer);
      this.joinResponseResolvers.delete(requestId);
      resolver.reject(new Error("Join response cancelled"));
    }
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

    // ── group.member.joined / group.member.online → notification ──
    if (type === "group.member.joined") {
      const parsed = parseGroupMessagePayload("group.member.joined", envelope.payload);
      if (!parsed.ok) return;
      const data = parsed.data;

      // Record in per-group ring buffer for replay later.
      let events = this.recentMemberEvents.get(groupId);
      if (!events) {
        events = [];
        this.recentMemberEvents.set(groupId, events);
      }
      events.push({
        type: "joined",
        memberDeviceId: data.memberDeviceId,
        memberDisplayName: data.memberDisplayName,
        at: data.joinedAt,
      });
      if (events.length > GroupMessageRouter.MAX_RECENT_EVENTS_PER_GROUP) {
        events.splice(0, events.length - GroupMessageRouter.MAX_RECENT_EVENTS_PER_GROUP);
      }

      // Fire desktop notification.
      const syncState = this.syncService.getSyncState(groupId);
      const groupName = syncState?.state.name.value ?? groupId;
      showNotification({
        title: "ScreenLink",
        body: `${data.memberDisplayName} joined ${groupName}`,
      });
      return;
    }

    if (type === "group.member.online") {
      const parsed = parseGroupMessagePayload("group.member.online", envelope.payload);
      if (!parsed.ok) return;
      const data = parsed.data;

      // Fire desktop notification.
      const syncState = this.syncService.getSyncState(groupId);
      const groupName = syncState?.state.name.value ?? groupId;
      showNotification({
        title: "ScreenLink",
        body: `${data.memberDisplayName} is online in ${groupName}`,
      });
      return;
    }

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
        // Optional per-attempt session ID. When present, removeViewer()
        // will ignore the message if it does not match the active mapping
        // — preventing a delayed leave from a prior Watch attempt from
        // clobbering a newer rejoin mapping.
        const viewerSessionId = leaveData.data.viewerSessionId;
        // Compare mode: exact media session ID for precise targeting.
        // When present, use removeViewerMapping() instead of the legacy
        // removeViewer() so the leave targets exactly one media session
        // and does not accidentally affect the other variant's binding.
        const mediaSessionId = leaveData.data.mediaSessionId;
        if (viewerDeviceId) {
          if (mediaSessionId) {
            this.viewerBinding.removeViewerMapping(viewerDeviceId, mediaSessionId, viewerSessionId);
          } else {
            this.viewerBinding.removeViewer(viewerDeviceId, viewerSessionId);
          }
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
        const viewerSessionId = bindData.data.viewerSessionId;
        if (peerUuid && token) {
          void this.viewerBinding.handleMediaBind(peerUuid, token, viewerSessionId);
        }
      }
      return;
    }

    // viewer.status → dispatch window event for HostDashboard hook
    if (type === "viewer.status") {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        const parsed = parseGroupMessagePayload("viewer.status", envelope.payload);
        if (parsed.ok) {
          window.dispatchEvent(new CustomEvent("screenlink:viewer-status", {
            detail: parsed.data,
          }));
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
      void this.handleQualityMessage(groupId, type, envelope);
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
      void this.routeStreamMessage(groupId, envelope, r.data);
      return;
    }
  }

  /**
   * Drain and return all recent member events for a group.
   * Used by Phase3Runtime after addGroup to replay queued notifications.
   */
  drainRecentMemberEvents(groupId: string): RecentMemberEvent[] {
    const events = this.recentMemberEvents.get(groupId) ?? [];
    this.recentMemberEvents.delete(groupId);
    return events;
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

  // ── Quality feedback ──────────────────────────────────────────────

  /**
   * Send quality feedback (effective + configured values + clamp reasons)
   * back to the requesting viewer via quality.effective and quality.configured
   * messages. The viewer-side UI uses these to show accepted/capped/rejected
   * feedback for the exact watched stream.
   */
  private async sendQualityFeedback(
    groupId: string,
    viewerDeviceId: string,
    logicalStreamId: string,
    effective: EffectiveQuality,
    configured: EffectiveQuality["configured"],
  ): Promise<void> {
    const conn = this.connManager.getConnection(groupId);
    if (!conn) return;
    const peerUuid = conn.peerForDevice(viewerDeviceId);
    if (!peerUuid) return;

    // Send quality.effective with the effective values (including clamp reasons)
    await conn.sendToPeer(peerUuid, {
      type: "quality.effective",
      streamSessionId: logicalStreamId,
      videoBitrateKbps: effective.effective.videoBitrateKbps,
      maxWidth: effective.effective.maxWidth,
      maxHeight: effective.effective.maxHeight,
      maxFps: effective.effective.maxFps,
      degradationPreference: effective.effective.degradationPreference,
      clampReasons: effective.clampReasons,
    });

    // Send quality.configured with the actual sender-applied values
    await conn.sendToPeer(peerUuid, {
      type: "quality.configured",
      streamSessionId: logicalStreamId,
      videoBitrateKbps: configured?.maxBitrate ? Math.round(configured.maxBitrate / 1000) : undefined,
      maxFramerate: configured?.maxFramerate ?? undefined,
      scaleResolutionDownBy: configured?.scaleResolutionDownBy ?? undefined,
      degradationPreference: configured?.degradationPreference ?? undefined,
    });
  }

  // ── Quality message handling (Stage 6) ───────────────────────

  private async handleQualityMessage(
    groupId: string,
    type: string,
    envelope: GroupControlEnvelope,
  ): Promise<void> {
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
            // Use real group quality defaults from sync service
            const syncState = this.runtime.getSyncService().getSyncState(groupId);
            const quality = syncState?.state?.defaultQuality?.value;
            const groupSettings = quality ?? createDefaultGroupQualitySettings();

            // Use real source dimensions from StreamSessionManager
            const ssm = this.runtime.getStreamSessionManager();
            const actualDims = ssm.getActualCaptureDimensions();
            const sourceDimensions = {
              width: actualDims.width || groupSettings.video.sendWidth || 1920,
              height: actualDims.height || groupSettings.video.sendHeight || 1080,
            };

            // Use real host quality limits from runtime (loaded from persisted settings)
            const runtimeLimits = this.runtime.getHostQualityLimits();
            const hostLimits: HostQualityLimits = {
              maxVideoBitrateKbps: runtimeLimits.maxVideoBitrateKbps,
              maxWidth: runtimeLimits.maxWidth,
              maxHeight: runtimeLimits.maxHeight,
              maxFps: runtimeLimits.maxFps,
              allowViewerQualityRequests: runtimeLimits.allowViewerQualityRequests,
            };

            const effective = this.qualityCoordinator.calculateEffectiveQuality(
              groupSettings,
              hostLimits,
              request,
              sourceDimensions,
            );

            const configured = await this.qualityCoordinator.applyToExactViewer(
              envelope.senderDeviceId,
              envelope.senderDeviceId,
              sender,
              effective.effective,
            ).catch(() => null);

            // Send quality feedback back to the viewer (quality.effective with clamping info)
            if (configured) {
              await this.sendQualityFeedback(
                groupId,
                envelope.senderDeviceId,
                logicalStreamId,
                effective,
                configured,
              ).catch(() => {});
            }
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
          // Use real group quality defaults from sync service
          const syncState = this.runtime.getSyncService().getSyncState(groupId);
          const quality = syncState?.state?.defaultQuality?.value;
          const groupSettings = quality ?? createDefaultGroupQualitySettings();

          // Use real source dimensions from StreamSessionManager
          const ssm = this.runtime.getStreamSessionManager();
          const actualDims = ssm.getActualCaptureDimensions();
          const sourceDimensions = {
            width: actualDims.width || groupSettings.video.sendWidth || 1920,
            height: actualDims.height || groupSettings.video.sendHeight || 1080,
          };

          // Use real host quality limits from runtime (loaded from persisted settings)
          const runtimeLimits = this.runtime.getHostQualityLimits();
          const hostLimits: HostQualityLimits = {
            maxVideoBitrateKbps: runtimeLimits.maxVideoBitrateKbps,
            maxWidth: runtimeLimits.maxWidth,
            maxHeight: runtimeLimits.maxHeight,
            maxFps: runtimeLimits.maxFps,
            allowViewerQualityRequests: runtimeLimits.allowViewerQualityRequests,
          };

          const effective = this.qualityCoordinator.calculateEffectiveQuality(
            groupSettings,
            hostLimits,
            null, // No viewer request → apply group defaults
            sourceDimensions,
          );

          const configured = await this.qualityCoordinator.applyToExactViewer(
            envelope.senderDeviceId,
            envelope.senderDeviceId,
            sender,
            effective.effective,
          ).catch(() => null);

          // Send quality feedback for the clear (reset to group defaults)
          if (configured) {
            await this.sendQualityFeedback(
              groupId,
              envelope.senderDeviceId,
              logicalStreamId,
              effective,
              configured,
            ).catch(() => {});
          }
        }
      }
      return;
    }

    // quality.effective — forward to viewer UI via window events
    if (type === "quality.effective") {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        const parsed = parseGroupMessagePayload("quality.effective", envelope.payload);
        if (parsed.ok) {
          window.dispatchEvent(new CustomEvent("screenlink:quality-effective", {
            detail: parsed.data,
          }));
        }
      }
      return;
    }

    // quality.configured — forward to viewer UI via window events
    if (type === "quality.configured") {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        const parsed = parseGroupMessagePayload("quality.configured", envelope.payload);
        if (parsed.ok) {
          window.dispatchEvent(new CustomEvent("screenlink:quality-configured", {
            detail: parsed.data,
          }));
        }
      }
      return;
    }

    // quality.observed is informational — no UI feedback needed yet
    if (type === "quality.observed") {
      return;
    }
  }

  // ── Private ──────────────────────────────────────────────────

  /**
   * Envelope-group / payload-group safety check. Every stream-scoped
   * message carries a `groupId` field. The envelope itself also carries
   * a `groupId` in the signed header. Both must agree and must match
   * the routing group; otherwise the payload is rejected as a
   * cross-group leak.
   */
  private validatePayloadGroup(
    groupId: string,
    payloadGroup: unknown,
    where: string,
  ): boolean {
    if (typeof payloadGroup !== "string" || payloadGroup.length === 0) return true;
    if (payloadGroup !== groupId) {
      // Surface a safe diagnostic without logging group secrets.
      console.warn(
        `[GroupMessageRouter] ${where}: rejected cross-group payload (routing=${groupId.length} chars, payload=${payloadGroup.length} chars)`,
      );
      return false;
    }
    return true;
  }

  private async routeStreamMessage(
    groupId: string,
    envelope: GroupControlEnvelope,
    _validatedPayload: unknown,
  ): Promise<void> {
    const type = envelope.type;
    const payload = _validatedPayload as Record<string, unknown> | undefined;

    switch (type) {
      case "stream.started": {
        if (!this.validatePayloadGroup(groupId, payload?.groupId, "stream.started")) return;
        this.streamRegistry.handleStarted(payload as never);
        break;
      }

      case "stream.heartbeat": {
        if (!this.validatePayloadGroup(groupId, payload?.groupId, "stream.heartbeat")) return;
        this.streamRegistry.handleHeartbeat(payload as never);
        break;
      }

      case "stream.stopped": {
        if (!this.validatePayloadGroup(groupId, payload?.groupId, "stream.stopped")) return;
        this.streamRegistry.handleStopped(payload as never);
        break;
      }

      case "stream.restarted": {
        if (!this.validatePayloadGroup(groupId, payload?.groupId, "stream.restarted")) return;
        this.streamRegistry.handleStarted(payload as never);
        break;
      }

      case "stream.state.snapshot": {
        const rawStreams = (payload as { streams?: unknown[] } | undefined)?.streams ?? [];
        // Filter the snapshot to only entries whose groupId matches the
        // routing group. Never insert a stream from another group.
        const filtered: unknown[] = [];
        for (const entry of rawStreams) {
          if (!entry || typeof entry !== "object") continue;
          const eg = (entry as { groupId?: unknown }).groupId;
          if (eg === groupId) {
            filtered.push(entry);
          } else {
            console.warn(
              `[GroupMessageRouter] stream.state.snapshot: discarded entry (routing groupId does not match payload groupId)`,
            );
          }
        }
        this.streamRegistry.handleSnapshot(filtered as never);
        break;
      }

      case "stream.state.request":
        // Respond with snapshot of our current streams, scoped to this group.
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

    // Only return streams that belong to this group — never leak
    // streams from other groups into the response.
    const streams = this.streamRegistry.getStreamsByGroup(groupId);
    await conn.sendToPeer(peerUuid, {
      type: "stream.state.snapshot",
      streams,
    });
  }
}
