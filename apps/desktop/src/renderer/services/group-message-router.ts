import type { GroupControlEnvelope, GroupControlMessageType, HostQualityLimits, RemoteInputKey } from "@screenlink/shared";
import {
  parseGroupMessagePayload,
  createDefaultGroupQualitySettings,
  REMOTE_INPUT_SHORTCUTS,
} from "@screenlink/shared";
import { StreamViewerReadyPayloadSchema } from "../../../../../packages/shared/src/group-control-messages.js";
import type { GroupSyncService } from "./group-sync-service.js";
import type { ActiveStreamRegistry } from "./active-stream-registry.js";
import type { ViewerMediaBinding, ViewerPresence } from "./viewer-media-binding.js";
import type { ReconcileResult, ViewerMapping } from "./viewer-media-binding.js";
import type { GroupConnectionManager } from "./group-connection-manager.js";
import type { QualityCoordinator, EffectiveQuality } from "./quality-coordinator.js";
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
export interface ViewerPauseResultData {
  groupId: string;
  logicalStreamId: string;
  mediaSessionId: string;
  viewerSessionId: string;
  viewerDeviceId: string;
  operationId: string;
  paused: boolean;
  success: boolean;
  failureReason?: string;
}

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

/**
 * Optional callbacks for UI side effects.
 * When provided, the router delegates notifications, sounds, viewer-count
 * updates, and viewer-status events to these callbacks instead of
 * directly calling Zustand, window.dispatchEvent, uiSoundService, etc.
 * When omitted, the side effects are silently no-ops — making the router
 * testable without a browser/Electron environment.
 */
export interface GroupMessageRouterCallbacks {
  /** Fired when a viewer presence cue fires (join/leave sound + viewer count update) */
  onViewerCue?: (name: "user-join" | "user-leave", presence: ViewerPresence) => void;
  /** Called instead of showNotification() for member joined/online events */
  showNotification?: (notification: { title: string; body: string }) => void;
  /** Fired when a remote member announces its departure via group.member.left */
  onMemberLeft?: (groupId: string, deviceId: string) => void;
  /** Called with parsed viewer.status payload instead of window.dispatchEvent */
  onViewerStatus?: (data: unknown) => void;
}

export class GroupMessageRouter {
  private pingTimestamps = new Map<string, number>();
  private pongTimestamps = new Map<string, number>();
  private viewerInputTimestamps = new Map<string, number>();
  private static readonly VIEWER_INPUT_THROTTLE_MS = 60;

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

  /** Pending viewer pause result resolvers keyed by operationId */
  private viewerPauseResultResolvers = new Map<string, {
    resolve: (data: ViewerPauseResultData) => void;
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
    private callbacks?: GroupMessageRouterCallbacks,
  ) {
    // Wire viewer presence cue callbacks through injected callbacks.
    // When callbacks.onViewerCue is provided, it receives join/leave cues
    // for sound playback and viewer-count updates.
    if (this.viewerBinding) {
      this.viewerBinding.onViewerCue = (name, presence) => {
        this.callbacks?.onViewerCue?.(name, presence);
      };
    }
  }

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
   * Wait for a viewer.pause.result matching the given operationId.
   * Returns a promise that resolves with the result data or rejects
   * after the timeout (default 30 seconds).
   */
  waitForViewerPauseResult(operationId: string, timeoutMs = 30_000): Promise<ViewerPauseResultData> {
    const existing = this.viewerPauseResultResolvers.get(operationId);
    if (existing) {
      throw new Error("Duplicate waitForViewerPauseResult for operationId");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.viewerPauseResultResolvers.delete(operationId);
        reject(new Error(`Viewer pause result timeout for operation ${operationId.slice(0, 8)}`));
      }, timeoutMs);
      this.viewerPauseResultResolvers.set(operationId, { resolve, reject, timer });
    });
  }

  /**
   * Cancel a pending viewer pause result waiter. Removes the timer and rejects
   * the pending promise. Idempotent — safe to call after the result
   * already arrived or the timeout fired.
   */
  cancelViewerPauseResult(operationId: string): void {
    const resolver = this.viewerPauseResultResolvers.get(operationId);
    if (resolver) {
      clearTimeout(resolver.timer);
      this.viewerPauseResultResolvers.delete(operationId);
      resolver.reject(new Error("Viewer pause result cancelled"));
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

      // Fire desktop notification via injected callback.
      const syncState = this.syncService.getSyncState(groupId);
      const groupName = syncState?.state.name.value ?? groupId;
      this.callbacks?.showNotification?.({
        title: "ScreenLink",
        body: `${data.memberDisplayName} joined ${groupName}`,
      });
      return;
    }

    if (type === "group.member.online") {
      const parsed = parseGroupMessagePayload("group.member.online", envelope.payload);
      if (!parsed.ok) return;
      const data = parsed.data;

      // Fire desktop notification via injected callback.
      const syncState = this.syncService.getSyncState(groupId);
      const groupName = syncState?.state.name.value ?? groupId;
      this.callbacks?.showNotification?.({
        title: "ScreenLink",
        body: `${data.memberDisplayName} is online in ${groupName}`,
      });
      return;
    }

    // ── group.member.left → sync service (tombstone merge) + notification ──
    if (type === "group.member.left") {
      const parsed = parseGroupMessagePayload("group.member.left", envelope.payload);
      if (!parsed.ok) return;
      const data = parsed.data;

      void this.syncService.handleGroupMessage(groupId, envelope);

      const syncState = this.syncService.getSyncState(groupId);
      const groupName = syncState?.state.name.value ?? groupId;
      this.callbacks?.showNotification?.({
        title: "ScreenLink",
        body: `${data.memberDisplayName} left ${groupName}`,
      });
      this.callbacks?.onMemberLeft?.(groupId, data.memberDeviceId);
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
            // Use presence-aware removal so explicit leave can fire the leave cue immediately.
            this.viewerBinding.removeViewerWithPresence(
              viewerDeviceId, mediaSessionId, viewerSessionId,
            );
          } else if (viewerSessionId) {
            // No mediaSessionId but viewerSessionId provided: find the mapping
            // by viewerSessionId and use exact removal (B-16).
            const allViewers = this.viewerBinding.getAllViewers();
            const mapping = allViewers.find(
              (m) => m.viewerDeviceId === viewerDeviceId && m.viewerSessionId === viewerSessionId,
            );
            if (mapping) {
              this.viewerBinding.removeViewerWithPresence(
                viewerDeviceId, mapping.mediaSessionId, viewerSessionId,
              );
            }
          } else {
            // Legacy fallback: remove all bindings for this device (best-effort).
            const allViewers = this.viewerBinding.getAllViewers();
            for (const v of allViewers) {
              if (v.viewerDeviceId === viewerDeviceId) {
                this.viewerBinding.removeViewerMapping(v.viewerDeviceId, v.mediaSessionId, v.viewerSessionId);
              }
            }
          }
        }
      }
      return;
    }

    // stream.restart.request → RestartCoordinator
    if (type === "stream.restart.request") {
      void this.handleRestartRequest(groupId, envelope);
      return;
    }

    // stream.restart.result → RestartCoordinator
    if (type === "stream.restart.result") {
      void this.handleRestartResult(envelope);
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

    // stream.inputPermissionsChanged → update the matching announcement.
    if (type === "stream.inputPermissionsChanged") {
      const parsed = parseGroupMessagePayload(type, envelope.payload);
      if (!parsed.ok) return;
      if (envelope.groupId !== groupId) return;
      if (!this.validatePayloadGroup(groupId, parsed.data.groupId, type)) return;
      this.streamRegistry.updateInputPermissions(
        parsed.data.groupId,
        parsed.data.logicalStreamId,
        parsed.data.permissions,
      );
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

    // viewer.status → notify via injected callback (HostDashboard hook)
    if (type === "viewer.status") {
      const parsed = parseGroupMessagePayload("viewer.status", envelope.payload);
      if (parsed.ok) {
        this.callbacks?.onViewerStatus?.(parsed.data);
      }
      return;
    }

    // viewer.pause.request → host-side pause/resume handling (exact routing)
    if (type === "viewer.pause.request") {
      if (this.viewerBinding) {
        const parsed = parseGroupMessagePayload("viewer.pause.request", envelope.payload);
        if (parsed.ok) {
          const data = parsed.data;
          void (async () => {
            const result = await this.viewerBinding!.handleViewerPaused(
              data.viewerDeviceId,
              data.mediaSessionId,
              data.paused,
            );

            const conn = this.connManager.getConnection(groupId);
            const peerUuid = conn?.peerForDevice(data.viewerDeviceId);
            if (!conn || !peerUuid) return;

            const success = result.status === "applied";
            const failureReason = success
              ? undefined
              : result.status === "apply-failed"
                ? result.error
                : result.status === "sender-not-ready"
                  ? "sender not ready"
                  : "mapping missing";

            await Promise.resolve(conn.sendToPeer(peerUuid, {
              type: "viewer.pause.result",
              groupId: data.groupId,
              logicalStreamId: data.logicalStreamId,
              mediaSessionId: data.mediaSessionId,
              viewerSessionId: data.viewerSessionId,
              viewerDeviceId: data.viewerDeviceId,
              operationId: data.operationId,
              paused: success ? data.paused : !data.paused,
              success,
              ...(failureReason ? { failureReason } : {}),
            })).catch(() => {});
          })();
        }
      }
      return;
    }

    // viewer.pause.result → resolve pending waiter
    if (type === "viewer.pause.result") {
      const parsed = parseGroupMessagePayload("viewer.pause.result", envelope.payload);
      if (!parsed.ok) return;
      const resultData = parsed.data;
      const operationId = resultData.operationId;
      const resolver = this.viewerPauseResultResolvers.get(operationId);
      if (resolver) {
        clearTimeout(resolver.timer);
        this.viewerPauseResultResolvers.delete(operationId);
        resolver.resolve({
          groupId: resultData.groupId,
          logicalStreamId: resultData.logicalStreamId,
          mediaSessionId: resultData.mediaSessionId,
          viewerSessionId: resultData.viewerSessionId,
          viewerDeviceId: resultData.viewerDeviceId,
          operationId: resultData.operationId,
          paused: resultData.paused,
          success: resultData.success,
          failureReason: resultData.failureReason,
        });
      }
      return;
    }

    // viewer.media.request → host-side media mode control (audio/video enable)
    if (type === "viewer.media.request") {
      if (this.viewerBinding) {
        const parsed = parseGroupMessagePayload("viewer.media.request", envelope.payload);
        if (parsed.ok) {
          const data = parsed.data;
          const mapping = this.findViewerMappingForLogicalStream(
            this.viewerBinding,
            data.viewerDeviceId,
            data.logicalStreamId,
          );
          if (mapping) {
            void this.viewerBinding.handleViewerMediaRequest(
              data.viewerDeviceId,
              mapping.mediaSessionId,
              data.audioEnabled,
              data.videoEnabled,
            );
          }
        }
      }
      return;
    }

    // viewer.input.request → authorize against the host's current policy and
    // invoke the existing preload shortcut IPC. The request carries no policy;
    // permissions are always read from the local StreamSessionManager.
    if (type === "viewer.input.request") {
      void this.handleViewerInputRequest(groupId, envelope);
      return;
    }

    // stream.viewer.ready → host-side viewer presence + audio cue
    if ((type as string) === "stream.viewer.ready") {
      const parsed = StreamViewerReadyPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return;
      const data = parsed.data;

      if (this.viewerBinding) {
        this.viewerBinding.handleViewerReady(
          data.viewerDeviceId,
          data.viewerSessionId,
          data.mediaSessionId,
          data.logicalStreamId,
          data.presentation,
        );
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

      // Apply quality to the exact viewer sender.
      // The request is already stored above. Now try to apply it:
      // 1. Try the cached sender first (fast path)
      // 2. If the cached sender is null, attempt reconciliation which
      //    re-resolves from the live SDK connection (fix for the race
      //    where bind completed before the sender was ready)
      // 3. If still no sender, the request remains stored and will be
      //    applied when peerConnected fires via reconciliation.
      if (this.runtime) {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        const mapping = this.findViewerMappingForLogicalStream(viewerBinding, envelope.senderDeviceId, logicalStreamId);
        if (!mapping) {
          await this.sendQualityPendingResponse(groupId, envelope.senderDeviceId, logicalStreamId, "mapping missing");
          return;
        }

        const result = await viewerBinding.reconcileViewerQuality(
          envelope.senderDeviceId,
          mapping.mediaSessionId,
        );
        await this.respondToReconcileResult(groupId, envelope.senderDeviceId, logicalStreamId, result);
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

      // Clear quality on the exact viewer sender (reset to group defaults).
      // Try the cached sender first; if null, attempt reconciliation which
      // re-resolves from the live SDK connection.
      if (this.runtime) {
        const viewerBinding = this.runtime.getViewerMediaBinding();
        const mapping = this.findViewerMappingForLogicalStream(viewerBinding, envelope.senderDeviceId, logicalStreamId);
        if (!mapping) {
          await this.sendQualityPendingResponse(groupId, envelope.senderDeviceId, logicalStreamId, "mapping missing");
          return;
        }

        if (this.qualityCoordinator) {
          const result = await viewerBinding.reconcileViewerQuality(
            envelope.senderDeviceId,
            mapping.mediaSessionId,
          );
          if (result.status === "applied") {
            // After reconciliation, re-apply group defaults (null request = defaults)
            const freshMapping = viewerBinding.getViewerMapping(envelope.senderDeviceId, mapping.mediaSessionId);
            const sender = freshMapping?.videoSender;
            if (sender) {
              const syncState = this.runtime.getSyncService().getSyncState(groupId);
              const quality = syncState?.state?.defaultQuality?.value;
              const groupSettings = quality ?? createDefaultGroupQualitySettings();
              const ssm = this.runtime.getStreamSessionManager();
              const actualDims = ssm.getActualCaptureDimensions();
              const sourceDimensions = {
                width: actualDims.width || groupSettings.video.sendWidth || 1920,
                height: actualDims.height || groupSettings.video.sendHeight || 1080,
              };
              const runtimeLimits = this.runtime.getHostQualityLimits();
              const hostLimits: HostQualityLimits = {
                maxVideoBitrateKbps: runtimeLimits.maxVideoBitrateKbps,
                maxWidth: runtimeLimits.maxWidth,
                maxHeight: runtimeLimits.maxHeight,
                maxFps: runtimeLimits.maxFps,
                allowViewerQualityRequests: runtimeLimits.allowViewerQualityRequests,
              };
              const effective = this.qualityCoordinator.calculateEffectiveQuality(
                groupSettings, hostLimits, null, sourceDimensions,
              );
              const configured = await this.qualityCoordinator.applyToExactViewer(
                envelope.senderDeviceId, envelope.senderDeviceId, sender, effective.effective,
              ).catch(() => null);
              if (configured) {
                await this.sendQualityFeedback(
                  groupId, envelope.senderDeviceId, logicalStreamId, effective, configured,
                ).catch(() => {});
              }
            }
          } else {
            await this.respondToReconcileResult(groupId, envelope.senderDeviceId, logicalStreamId, result);
          }
        }
      }
      return;
    }

    // quality.effective — forward to controller subscribers (Phase 4)
    if (type === "quality.effective") {
      const parsed = parseGroupMessagePayload("quality.effective", envelope.payload);
      if (parsed.ok) {
        const { getActiveController } = await import("./viewer-session-controller.js");
        getActiveController()?.publishQuality({ type: "effective", data: parsed.data as Record<string, unknown> });
      }
      return;
    }

    // quality.configured — forward to controller subscribers (Phase 4)
    if (type === "quality.configured") {
      const parsed = parseGroupMessagePayload("quality.configured", envelope.payload);
      if (parsed.ok) {
        const { getActiveController } = await import("./viewer-session-controller.js");
        getActiveController()?.publishQuality({ type: "configured", data: parsed.data as Record<string, unknown> });
      }
      return;
    }

    // quality.observed is informational — no UI feedback needed yet
    if (type === "quality.observed") {
      return;
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private findViewerMappingForLogicalStream(
    viewerBinding: ViewerMediaBinding,
    viewerDeviceId: string,
    logicalStreamId: string,
  ): ViewerMapping | null {
    const allViewers = viewerBinding.getAllViewers();

    // Exact lookup by device ID + logical stream ID. No legacy first-match
    // fallback — every quality path must resolve to exactly one mapping (B-03).
    return allViewers.find(
      (mapping) => mapping.viewerDeviceId === viewerDeviceId && mapping.logicalStreamId === logicalStreamId,
    ) ?? null;
  }

  private async handleViewerInputRequest(
    groupId: string,
    envelope: GroupControlEnvelope,
  ): Promise<void> {
    if (!this.runtime) return;
    const parsed = parseGroupMessagePayload("viewer.input.request", envelope.payload);
    if (!parsed.ok) return;
    const data = parsed.data;
    if (envelope.groupId !== groupId) return;
    if (!this.validatePayloadGroup(groupId, data.groupId, "viewer.input.request")) return;
    if (envelope.senderDeviceId !== data.viewerDeviceId) return;

    const session = this.runtime.getStreamSessionManager();
    if (
      session.state !== "active" ||
      session.currentGroupId !== groupId ||
      session.currentLogicalStreamId !== data.logicalStreamId
    ) return;

    const permissions = session.getInputPermissions();
    const permissionKey: Record<RemoteInputKey, keyof typeof permissions> = {
      ArrowLeft: "arrowLeft",
      ArrowRight: "arrowRight",
      Space: "space",
      d: "d",
      s: "s",
    };
    if (!permissions[permissionKey[data.key]]) return;

    const throttleKey = `${groupId}:${data.viewerDeviceId}`;
    const now = Date.now();
    const previous = this.viewerInputTimestamps.get(throttleKey);
    if (previous !== undefined && now - previous < GroupMessageRouter.VIEWER_INPUT_THROTTLE_MS) return;
    this.viewerInputTimestamps.set(throttleKey, now);

    const api = typeof window !== "undefined"
      ? (window as unknown as { screenlink?: { sendShortcut: (binding: { modifiers: never[]; key: string }) => Promise<{ success: boolean }> } }).screenlink
      : null;
    if (!api?.sendShortcut) return;
    await api.sendShortcut({ modifiers: [], key: REMOTE_INPUT_SHORTCUTS[data.key] }).catch(() => {});
  }

  private async respondToReconcileResult(
    groupId: string,
    viewerDeviceId: string,
    logicalStreamId: string,
    result: ReconcileResult,
  ): Promise<void> {
    if (result.status === "applied") return;

    const reason = result.status === "apply-failed"
      ? `application failed: ${result.error}`
      : result.status === "sender-not-ready"
        ? "sender not ready, will apply on connect"
        : "mapping missing";

    await this.sendQualityPendingResponse(groupId, viewerDeviceId, logicalStreamId, reason);
  }

  private async sendQualityPendingResponse(
    groupId: string,
    viewerDeviceId: string,
    logicalStreamId: string,
    reason: string,
  ): Promise<void> {
    if (!this.runtime || !this.qualityCoordinator) return;

    const request = this.qualityCoordinator.getViewerRequest(
      groupId,
      logicalStreamId,
      viewerDeviceId,
    );
    const syncState = this.runtime.getSyncService().getSyncState(groupId);
    const quality = syncState?.state?.defaultQuality?.value;
    const groupSettings = quality ?? createDefaultGroupQualitySettings();
    const ssm = this.runtime.getStreamSessionManager();
    const actualDims = ssm.getActualCaptureDimensions?.() ?? {};
    const sourceDimensions = {
      width: actualDims.width || groupSettings.video.sendWidth || 1920,
      height: actualDims.height || groupSettings.video.sendHeight || 1080,
    };
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
    const conn = this.runtime.getConnectionManager().getConnection(groupId);
    const peerUuid = conn?.peerForDevice(viewerDeviceId);
    if (conn && peerUuid) {
      await conn.sendToPeer(peerUuid, {
        type: "quality.effective",
        streamSessionId: logicalStreamId,
        videoBitrateKbps: effective.effective.videoBitrateKbps,
        maxWidth: effective.effective.maxWidth,
        maxHeight: effective.effective.maxHeight,
        maxFps: effective.effective.maxFps,
        degradationPreference: effective.effective.degradationPreference,
        clampReasons: [...effective.clampReasons, reason],
      }).catch(() => {});
    }
  }

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

  // ── Restart handling (Stage 14 / Gate 10) ────────────────────────────

  /**
   * Receive a stream.restart.request from a remote peer and perform
   * a real lifecycle restart via RestartCoordinator -> StreamSessionManager.
   * Sends stream.restart.result back to the requesting peer.
   */
  private async handleRestartRequest(
    groupId: string,
    envelope: GroupControlEnvelope,
  ): Promise<void> {
    if (!this.runtime) return;
    const parsed = parseGroupMessagePayload("stream.restart.request", envelope.payload);
    if (!parsed.ok) return;
    const data = parsed.data;

    // Defense-in-depth: reject cross-group payloads
    if (!this.validatePayloadGroup(groupId, data.groupId, "stream.restart.request")) return;

    const coordinator = this.runtime.getRestartCoordinator();

    let accepted = false;
    let success = false;
    let reason: string | undefined;
    let logicalStreamId = "";

    try {
      const result = await coordinator.handleIncomingRestartRequest(
        data.commandId,
        data.groupId,
        data.targetSettingsStamp,
        data.targetSettingsHash,
        data.requestedByDeviceId,
      );
      accepted = result.accepted;
      success = result.success;
      reason = result.reason;
      logicalStreamId = result.logicalStreamIds?.[0]
        ?? this.runtime.getStreamSessionManager().currentLogicalStreamId
        ?? "";
    } catch (err) {
      accepted = false;
      success = false;
      reason = String((err as Error)?.message ?? err);
    }

    const conn = this.connManager.getConnection(groupId);
    if (!conn) return;
    const peerUuid = conn.peerForDevice(envelope.senderDeviceId);
    if (!peerUuid) return;

    await conn.sendToPeer(peerUuid, {
      type: "stream.restart.result",
      commandId: data.commandId,
      groupId: data.groupId,
      hostDeviceId: this.runtime.deviceId ?? "local",
      logicalStreamId,
      accepted,
      success,
      ...(reason ? { failureReason: reason } : {}),
    }).catch(() => {});
  }

  /**
   * Receive a stream.restart.result from a host we asked to restart.
   * Forwards to RestartCoordinator for per-host status tracking.
   */
  private async handleRestartResult(envelope: GroupControlEnvelope): Promise<void> {
    if (!this.runtime) return;
    const parsed = parseGroupMessagePayload("stream.restart.result", envelope.payload);
    if (!parsed.ok) return;
    const data = parsed.data;

    const coordinator = this.runtime.getRestartCoordinator();
    coordinator.handleRestartResult(
      data.commandId,
      data.hostDeviceId,
      data.logicalStreamId,
      data.accepted,
      data.success,
      data.failureReason,
    );
  }
}
