import { GroupConnectionManager } from "./group-connection-manager.js";
import { GroupSyncService, type SyncPersistenceAdapter } from "./group-sync-service.js";
import { ActiveStreamRegistry } from "./active-stream-registry.js";
import { GroupMessageRouter, type JoinResponseData, type ViewerPauseResultData } from "./group-message-router.js";
import { StreamSessionManager } from "./stream-session-manager.js";
import { ViewerMediaBinding } from "./viewer-media-binding.js";
import { RestartCoordinator } from "./restart-coordinator.js";
import { QualityCoordinator } from "./quality-coordinator.js";
import { ViewerSenderController } from "./viewer-sender-controller.js";
import { showNotification } from "./notifications.js";
import { uiSoundService } from "./ui-sound-service.js";
import type { GroupSharedState, GroupMemberRecord, HybridTimestamp, HostQualityLimits } from "@screenlink/shared";
import { createDefaultHostQualityLimits, isMemberActive } from "@screenlink/shared";
import type { PublisherManager } from "./publisher-manager.js";
import type { VdoSessionConfig } from "./stream-session-manager.js";

export type GroupSyncRequestResult =
  | { status: "dispatched" }
  | { status: "no-connection" }
  | { status: "suppressed"; reason: "destroyed" | "cooldown" };

/** Optional parameters for requestGroupSync. */
export interface GroupSyncOptions {
  /**
   * When true, the active stream registry is NOT cleared before sync.
   * Used by viewer recovery to preserve still-valid remote streams.
   * @default false
   */
  preserveActiveStreams?: boolean;
}

/**
 * Phase3Runtime owns all Phase 3 services:
 * - GroupConnectionManager
 * - GroupSyncService
 * - ActiveStreamRegistry
 * - GroupMessageRouter (sole message handler)
 * - StreamSessionManager (local host stream)
 * - ViewerMediaBinding (join token management)
 *
 * Design:
 * - Serializes initialization (waits for pending destroy)
 * - Uses generation counters to reject stale callbacks
 * - Safe for StrictMode double-mount in React 18
 * - Accepts optional SyncPersistenceAdapter for group state persistence
 */
export class Phase3Runtime {
  private connManager: GroupConnectionManager;
  private syncService: GroupSyncService;
  private activeStreamRegistry: ActiveStreamRegistry;
  private messageRouter!: GroupMessageRouter;
  private streamSessionManager!: StreamSessionManager;
  private viewerMediaBinding!: ViewerMediaBinding;
  private restartCoordinator!: RestartCoordinator;
  private qualityCoordinator!: QualityCoordinator;
  private viewerSenderController!: ViewerSenderController;
  private destroyed = false;
  private initialized = false;
  private initGen = 0;
  private destroyPromise: Promise<void> | null = null;
  private _deviceId: string | null = null;
  private _displayName: string | null = null;

  /** Host quality limits loaded from persisted settings. Default allows requests. */
  private _hostQualityLimits: HostQualityLimits = createDefaultHostQualityLimits();

  /** Minimum interval between manual refreshes per group (milliseconds). */
  static REFRESH_COOLDOWN_MS = 3000;

  /** Last refresh timestamp per group (for cooldown). */
  private refreshCooldowns = new Map<string, number>();
  /** In-flight refresh promise per group (for deduplication). */
  private refreshInFlight = new Map<string, Promise<GroupSyncRequestResult>>();

  /**
   * Tracks which member device IDs have already produced a "joined"
   * notification per group. Prevents duplicate joined notifications
   * on state sync replay.
   */
  private notifiedJoinedMembers = new Map<string, Set<string>>();

  /**
   * Tracks which device IDs are currently considered "online" for the
   * purpose of online-transition notifications per group.
   */
  private previouslyOnlineMembers = new Map<string, Set<string>>();

  /** Human-readable identity for diagnostics. Not available until addGroup(). */
  get deviceId(): string | null { return this._deviceId; }
  get displayName(): string | null { return this._displayName; }

  updateLocalDisplayName(displayName: string): void {
    this._displayName = displayName;
    if (this._deviceId) {
      this.streamSessionManager.setDeviceIdentity(this._deviceId, displayName);
    }
  }

  constructor(persistence?: SyncPersistenceAdapter) {
    this.connManager = new GroupConnectionManager();
    this.syncService = new GroupSyncService(this.connManager, persistence);
    this.activeStreamRegistry = new ActiveStreamRegistry();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Wait for any pending destroy to complete
    if (this.destroyPromise) {
      await this.destroyPromise;
    }
    const gen = ++this.initGen;

    // Wire group connection state updates to store
    const store = (await import("../stores/main-store.js")).useStore;

    // Load host quality limits from persisted settings
    try {
      const api = (window as unknown as { screenlink?: { getSettings: () => Promise<{ hostQualityLimits?: HostQualityLimits }> } }).screenlink;
      if (api) {
        const settings = await api.getSettings();
        if (settings?.hostQualityLimits) {
          this._hostQualityLimits = settings.hostQualityLimits;
        }
      }
    } catch {
      // Best-effort; defaults are already loaded
    }

    this.connManager.setOnStatesChanged((states) => {
      if (gen !== this.initGen || this.destroyed) return;
      const stateById: Record<string, { groupId: string; state: string; onlinePeers: string[]; error: string | null }> = {};
      const s0 = store.getState();
      const byGroup = { ...s0.onlineDeviceIdsByGroup };
      let onlineChanged = false;
      for (const [groupId, s] of states) {
        // Store-level only: the local device is always "online" from its own
        // view, but it never authenticates a hello with itself, so peers
        // lists only contain remote devices.
        let peers = s.onlinePeers;
        if (s.state === "connected" && this._deviceId && !peers.includes(this._deviceId)) {
          peers = [...peers, this._deviceId];
        }
        stateById[groupId] = { ...s, onlinePeers: peers };

        // Mirror self into onlineDeviceIdsByGroup — MembersList/Groups read
        // THIS field for member-row online dots (remote ids here are managed
        // by the onPeerOnline/onPeerOffline callbacks below).
        if (this._deviceId) {
          const entry = byGroup[groupId] ?? [];
          if (s.state === "connected" && !entry.includes(this._deviceId)) {
            byGroup[groupId] = [...entry, this._deviceId];
            onlineChanged = true;
          } else if (s.state !== "connected" && entry.includes(this._deviceId)) {
            byGroup[groupId] = entry.filter((d) => d !== this._deviceId);
            onlineChanged = true;
          }
        }
      }
      s0.setGroupConnectionState(stateById);
      if (onlineChanged) s0.setOnlineDevices(byGroup);
    });

    this.connManager.setOnPeerOnline((groupId, deviceId, displayName) => {
      if (gen !== this.initGen || this.destroyed) return;
      const s = store.getState();
      const byGroup = { ...s.onlineDeviceIdsByGroup };
      if (!byGroup[groupId]) byGroup[groupId] = [];
      const wasOnline = byGroup[groupId].includes(deviceId);
      if (!wasOnline) {
        byGroup[groupId] = [...byGroup[groupId], deviceId];
      }
      s.setOnlineDevices(byGroup);

      // Online transition notification: fire only on genuine offline→online
      if (!wasOnline && deviceId !== this._deviceId) {
        const prevOnline = this.previouslyOnlineMembers.get(groupId);
        if (prevOnline && !prevOnline.has(deviceId)) {
          prevOnline.add(deviceId);
          const groupName = s.groupsById[groupId]?.name ?? groupId;
          showNotification({
            title: "ScreenLink",
            body: `${displayName} is online in ${groupName}`,
          });
        }
      }

      // After peer connects, send stream.state.request to discover their streams (C2.3)
      const conn = this.connManager.getConnection(groupId);
      if (conn) {
        const peerUuid = conn.peerForDevice(deviceId);
        if (peerUuid) {
          void conn.sendToPeer(peerUuid, {
            type: "stream.state.request",
          }).catch(() => {});

          // Also send our fresh stream state snapshot so the peer immediately
          // learns about active streams without waiting for stream.started.
          const streams = this.activeStreamRegistry.getStreamsByGroup(groupId);
          if (streams.length > 0) {
            void conn.sendToPeer(peerUuid, {
              type: "stream.state.snapshot",
              streams,
            }).catch(() => {});
          }

          // Flush any pending stream lifecycle messages to this new peer.
          // This runs after the hello handshake completes (identity mapping
          // is established), so sendToPeer can resolve the peer UUID.
          void this.connManager.flushPendingLifecycleToPeer(groupId, peerUuid).catch(() => {});
        }
      }

      // Immediate membership propagation kick: exchange anti-entropy
      // summaries right away instead of waiting up to 30s for the timer.
      void this.syncService.requestSync(groupId).catch(() => {});
    });

    this.connManager.setOnPeerOffline((groupId, deviceId) => {
      if (gen !== this.initGen || this.destroyed) return;
      const s = store.getState();
      const byGroup = { ...s.onlineDeviceIdsByGroup };
      if (byGroup[groupId]) {
        byGroup[groupId] = byGroup[groupId].filter((d) => d !== deviceId);
      }
      s.setOnlineDevices(byGroup);

      // Remove from online notification tracking so reconnect fires a new notification
      const prevOnline = this.previouslyOnlineMembers.get(groupId);
      if (prevOnline) {
        prevOnline.delete(deviceId);
      }

      // Remove all viewer bindings for the offline device using exact
      // ViewerBindingId (B-16: avoids skipping multi-mapping devices).
      try {
        const allViewers = this.viewerMediaBinding.getAllViewers();
        for (const v of allViewers) {
          if (v.viewerDeviceId === deviceId) {
            this.viewerMediaBinding.removeViewerMapping(v.viewerDeviceId, v.mediaSessionId, v.viewerSessionId);
          }
        }
      } catch { /* best effort */ }
    });

    // Listen for stream announcements
    this.activeStreamRegistry.onUpdate((update) => {
      if (gen !== this.initGen || this.destroyed) return;
      const s = store.getState();
      const byGroup = {
        ...s.activeStreamsByGroup,
        [update.stream.groupId]: this.activeStreamRegistry.getStreamsByGroup(update.stream.groupId),
      };
      s.setActiveStreams(byGroup);
    });

    // Wire sync service updates to store + joined notification detection
    this.syncService.setOnStateUpdated((groupId, state) => {
      if (gen !== this.initGen || this.destroyed) return;
      const s = store.getState();
      const groupsById = { ...s.groupsById };
      const order = [...s.groupOrder];
      groupsById[groupId] = {
        id: groupId,
        name: state.name.value,
        members: Object.fromEntries(
          Object.entries(state.members)
            .filter(([, v]) => isMemberActive(v))
            .map(([k, v]) => [k, { deviceId: v.deviceId, displayName: v.displayName }]),
        ),
      };
      if (!order.includes(groupId)) order.push(groupId);
      s.setGroups(groupsById, order);

      // Joined notification: fire when a previously unknown member appears in state
      const joinedSet = this.notifiedJoinedMembers.get(groupId);
      if (joinedSet) {
        for (const [deviceId, member] of Object.entries(state.members)) {
          if (deviceId !== this._deviceId && !joinedSet.has(deviceId)) {
            joinedSet.add(deviceId);
            showNotification({
              title: "ScreenLink",
              body: `${member.displayName} joined ${state.name.value}`,
            });
          }
        }
      }
    });

    // Wire authenticated hello callback for remote member record merge
    this.connManager.setOnAuthenticatedHello((groupId, senderDeviceId, member) => {
      if (gen !== this.initGen || this.destroyed) return;
      if (member) {
        void this.syncService.mergeRemoteMember(groupId, member, senderDeviceId);
      }
    });

    // ── Create Phase 3 services (C2, C7) ──────────────────────────────

    // Create QualityCoordinator and ViewerSenderController
    this.qualityCoordinator = new QualityCoordinator();
    this.viewerSenderController = new ViewerSenderController({
      requirePcForObservation: false,
      pauseObservation: {
        sampleIntervalMs: 250,
        confirmationWindowMs: 1500,
        maxBytesPerSecond: 8_000,
      },
    });

    // Create ViewerMediaBinding
    this.viewerMediaBinding = new ViewerMediaBinding(this);

    // Create GroupMessageRouter as the SOLE message handler (C1)
    this.messageRouter = new GroupMessageRouter(
      this.syncService,
      this.activeStreamRegistry,
      this.connManager,
      this.viewerMediaBinding,
      {
        onViewerCue: (name, presence) => {
          void uiSoundService.play(name);
          const count = this.viewerMediaBinding.getActivePresences().length;
          store.setState({ viewerCount: count });
        },
        showNotification: (n) => showNotification(n),
        onMemberLeft: (groupId, deviceId) => {
          const s = store.getState();
          const byGroup = { ...s.onlineDeviceIdsByGroup };
          if (byGroup[groupId]?.includes(deviceId)) {
            byGroup[groupId] = byGroup[groupId].filter((d) => d !== deviceId);
            s.setOnlineDevices(byGroup);
          }
        },
        onViewerStatus: (data) => {
          if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
            window.dispatchEvent(new CustomEvent("screenlink:viewer-status", { detail: data }));
          }
        },
      },
    );
    // Wire QualityCoordinator into the message router
    this.messageRouter.setQualityCoordinator(this.qualityCoordinator);
    this.messageRouter.setRuntime(this);

    this.connManager.setOnMessage((groupId, envelope) => {
      if (gen !== this.initGen || this.destroyed) return;
      this.messageRouter.routeMessage(groupId, envelope as any);
    });

    // Create StreamSessionManager (for local host stream) (C4)
    // VDO publishing is managed externally via PublisherManager.
    this.streamSessionManager = new StreamSessionManager(this);

    // Create RestartCoordinator (Stage 14)
    this.restartCoordinator = new RestartCoordinator(this);

    // Preload UI sound cues (join/leave) so they are ready when the host
    // needs to play them. Idempotent — safe to call multiple times.
    void uiSoundService.preload();

    this.initialized = true;
  }

  /**
   * Add a group connection with proper ordering:
   *   1) Validate (local identity assumptions already available in config)
   *   2) Initialize sync state + clock (BEFORE connection starts)
   *   3) Persist missing local member record (done inside initializeGroup)
   *   4) Register routing (already set up in initialize())
   *   5) Start connection
   *   6) Hello (happens automatically inside connection start)
   *   7) Broadcast state summary / snapshot
   *
   * Messages immediately after connection must not drop due to missing sync state.
   */
  async addGroup(
    config: { groupId: string; controlRoomId: string; groupSecret: string; nodeId: string; displayName: string; creatorDeviceId?: string | null },
    state: GroupSharedState,
    clock: HybridTimestamp,
  ): Promise<void> {
    if (this.destroyed) return;

    // Propagate real device identity to StreamSessionManager on first group.
    // Identity is the same across all groups, so set it once.
    if (!this._deviceId) {
      this._deviceId = config.nodeId;
      this._displayName = config.displayName;
      this.streamSessionManager.setDeviceIdentity(config.nodeId, config.displayName);
    }

    // Pre-populate joined notification tracking with known members from the
    // initial persisted state. This suppresses "joined" notifications for
    // members that are already known at startup.
    const knownMemberIds = new Set(Object.keys(state.members ?? {}));
    this.notifiedJoinedMembers.set(config.groupId, knownMemberIds);

    // Step 2: Initialize sync state FIRST so messages arriving after connection
    // start have a valid sync state to work with.  Await sync init (including
    // any persistence of a freshly inserted local member) before connecting.
    const result = await this.syncService.initializeGroup(
      config.groupId, state, clock, config.nodeId, config.displayName,
    );

    // If a new local member was inserted, mark it as already notified so the
    // local user never receives a "joined" notification about themselves.
    knownMemberIds.add(config.nodeId);

    // Step 5: Start the connection, passing the durable self member record
    // so hellos can carry it for peer introduction.
    await this.connManager.addGroup({
      ...config,
      memberRecord: result.localMember,
    });

    const conn = this.connManager.getConnection(config.groupId);

    // Step 6: Broadcast member joined ONLY when this device genuinely joined
    // for the first time. Do NOT broadcast on restart or reconnect.
    if (conn && conn.state === "connected") {
      if (result.localMemberWasInserted) {
        void conn.broadcastMemberJoined(config.nodeId, config.displayName).catch(() => {});
      }
    }

    // Step 7: Broadcast full state snapshot immediately so peers get our state
    // without waiting for the 30s anti-entropy timer.
    const syncState = this.syncService.getSyncState(config.groupId);
    if (syncState && conn && conn.state === "connected") {
      void conn.broadcast({
        type: "group.state.update",
        state: syncState.state,
      }).catch(() => {});
    }

    // Initial hydration: populate online notification tracking with devices
    // that are already connected. This suppresses "online" notifications for
    // the batch of initial peer connections.
    const onlineState = (await import("../stores/main-store.js")).useStore.getState().onlineDeviceIdsByGroup[config.groupId] ?? [];
    const onlineSet = new Set(onlineState);
    this.previouslyOnlineMembers.set(config.groupId, onlineSet);

    // Defunct-group watcher: sole-survivor joiners self-dissolve groups whose
    // creator and all other members are gone (GRP-011). Loaded lazily to
    // avoid an import cycle (it imports Phase3Runtime as type-only).
    const { watchGroupForDefunct } = await import("./defunct-group-watch.js");
    watchGroupForDefunct(this, config.groupId, {
      selfDeviceId: config.nodeId,
      creatorDeviceId: config.creatorDeviceId ?? null,
    });
  }

  async removeGroup(groupId: string): Promise<void> {
    if (this.destroyed) return;
    this.syncService.removeGroup(groupId);
    await this.connManager.removeGroup(groupId);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.initGen++;
    this.destroyPromise = (async () => {
      this.activeStreamRegistry.destroy();
      await this.streamSessionManager.destroy();
      this.viewerMediaBinding.destroy();
      this.viewerSenderController.destroy();
      this.restartCoordinator.destroy();
      this.syncService.destroy();
      await this.connManager.destroyAll();
      this.notifiedJoinedMembers.clear();
      this.previouslyOnlineMembers.clear();
    })();
    await this.destroyPromise;
  }

  getConnectionManager(): GroupConnectionManager {
    return this.connManager;
  }

  getSyncService(): GroupSyncService {
    return this.syncService;
  }

  getActiveStreamRegistry(): ActiveStreamRegistry {
    return this.activeStreamRegistry;
  }

  getStreamSessionManager(): StreamSessionManager {
    return this.streamSessionManager;
  }

  getRestartCoordinator(): RestartCoordinator {
    return this.restartCoordinator;
  }

  getViewerMediaBinding(): ViewerMediaBinding {
    return this.viewerMediaBinding;
  }

  getQualityCoordinator(): QualityCoordinator {
    return this.qualityCoordinator;
  }

  getViewerSenderController(): ViewerSenderController {
    return this.viewerSenderController;
  }

  /**
   * Resolve the local publication for a given media session.
   *
   * All compare is now viewer-only — this only resolves the normal
   * StreamSessionManager publication.
   *
   * @param mediaSessionId - The media session to resolve.
   * @returns Publication context or null if no matching local publication exists.
   */
  resolveLocalPublication(mediaSessionId: string): {
    mediaSessionId: string;
    logicalStreamId: string;
    publisherManager: PublisherManager;
    vdoConfig: VdoSessionConfig;
  } | null {
    // ── Check normal stream session ────────────────────────────────
    const ssm = this.streamSessionManager;
    if (!ssm) return null;
    const ssmMediaSessionId = ssm.currentMediaSessionId;
    if (!ssmMediaSessionId || ssmMediaSessionId !== mediaSessionId) return null;
    if (ssm.state !== "active" && ssm.state !== "restarting") return null;

    const publisherManager = ssm.getPublisherManager();
    if (!publisherManager) return null;

    const vdoConfig = ssm.getCurrentVdoConfig();
    if (!vdoConfig) return null;

    const logicalStreamId = ssm.currentLogicalStreamId;
    if (!logicalStreamId) return null;

    return {
      mediaSessionId: ssmMediaSessionId,
      logicalStreamId,
      publisherManager,
      vdoConfig,
    };
  }

  /**
   * Wait for a stream.join.response matching the given requestId.
   * Delegates to GroupMessageRouter's pending request resolution.
   * Used by Dashboard to complete the viewer join flow.
   */
  waitForJoinResponse(requestId: string, timeoutMs?: number): Promise<JoinResponseData> {
    return this.messageRouter.waitForJoinResponse(requestId, timeoutMs);
  }

  /**
   * Cancel a pending join response waiter. Removes the timer and rejects
   * the pending promise. Idempotent — safe to call after the response
   * already arrived or the timeout fired.
   */
  cancelJoinResponse(requestId: string): void {
    this.messageRouter.cancelJoinResponse(requestId);
  }

  waitForViewerPauseResult(operationId: string, timeoutMs?: number): Promise<ViewerPauseResultData> {
    return this.messageRouter.waitForViewerPauseResult(operationId, timeoutMs);
  }

  cancelViewerPauseResult(operationId: string): void {
    this.messageRouter.cancelViewerPauseResult(operationId);
  }

  /**
   * Get the current host quality limits (bandwidth caps, resolution limits,
   * and whether viewer quality requests are allowed).
   */
  getHostQualityLimits(): HostQualityLimits {
    return this._hostQualityLimits;
  }

  /**
   * Update the host quality limits from persisted settings.
   * Called during initialization or when settings change.
   */
  setHostQualityLimits(limits: HostQualityLimits): void {
    this._hostQualityLimits = limits;
  }

  /**
   * Manually request a full group sync for the given group.
   * Triggers anti-entropy for group state (name, members, quality)
   * and requests state from all connected peers.
   * Useful when the UI appears stale and the user wants to refresh.
   *
   * Rate-limited per group: calls within REFRESH_COOLDOWN_MS are
   * suppressed. In-flight calls are deduplicated.
   *
   * Returns a truthful dispatch, suppression, or connection outcome.
   *
   * Non-async so suppressed returns are synchronous (async functions
   * always wrap in a new promise).
   */
  requestGroupSync(groupId: string, options?: GroupSyncOptions): GroupSyncRequestResult | Promise<GroupSyncRequestResult> {
    if (this.destroyed) return { status: "suppressed", reason: "destroyed" };

    const inFlight = this.refreshInFlight.get(groupId);
    if (inFlight) return inFlight;

    const now = Date.now();
    const last = this.refreshCooldowns.get(groupId) ?? 0;
    if (now - last < Phase3Runtime.REFRESH_COOLDOWN_MS) return { status: "suppressed", reason: "cooldown" };

    const promise = this.doRequestGroupSync(groupId, options).finally(() => {
      this.refreshCooldowns.set(groupId, Date.now());
      this.refreshInFlight.delete(groupId);
    });
    this.refreshInFlight.set(groupId, promise);
    return promise;
  }

  /**
   * Execute the actual refresh work (not rate-limited).
   * Broadcasts anti-entropy summary and actively requests
   * group + stream state from all connected peers.
   */
  private async doRequestGroupSync(groupId: string, options?: GroupSyncOptions): Promise<GroupSyncRequestResult> {
    if (this.destroyed) return { status: "suppressed", reason: "destroyed" };

    let conn = this.connManager.getConnection(groupId);
    if (!conn || conn.state !== "connected") {
      // Self-heal: attempt one connection recovery round before surfacing
      // the error (covers cold-start timeouts and transient drops).
      try {
        await this.connManager.ensureConnected(groupId);
      } catch {
        return { status: "no-connection" };
      }
      conn = this.connManager.getConnection(groupId);
      if (!conn || conn.state !== "connected") {
        return { status: "no-connection" };
      }
    }

    // Viewer recovery should preserve already-registered remote streams;
    // only clear when the caller wants a full refresh.
    if (!options?.preserveActiveStreams) {
      this.activeStreamRegistry.clearGroupStreams(groupId, this._deviceId ?? undefined);
    }

    await this.syncService.requestSync(groupId);

    for (const peerUuid of conn.connectedPeers) {
      void conn.sendToPeer(peerUuid, { type: "group.state.request" }).catch(() => {});
      void conn.sendToPeer(peerUuid, { type: "stream.state.request" }).catch(() => {});
    }
    void conn.broadcast?.({ type: "group.state.request" })?.catch(() => {});
    void conn.broadcast?.({ type: "stream.state.request" })?.catch(() => {});
    return { status: "dispatched" };
  }
}

// ─── Singleton accessor (async acquire/release) ─────────────────────────────

let _runtime: Phase3Runtime | null = null;
let _initPromise: Promise<Phase3Runtime> | null = null;
let _destroyPromise: Promise<void> | null = null;
let _scheduledRelease: {
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
} | null = null;

const STRICT_MODE_RELEASE_GRACE_MS = 0;

function cancelScheduledRelease(): void {
  const scheduled = _scheduledRelease;
  if (!scheduled) return;
  clearTimeout(scheduled.timer);
  _scheduledRelease = null;
  scheduled.resolve();
}

async function destroyRuntimeNow(): Promise<void> {
  if (_initPromise) {
    const runtime = await _initPromise;
    _initPromise = null;
    _runtime = null;
    await runtime.destroy();
    return;
  }

  const runtime = _runtime;
  if (!runtime || runtime.isDestroyed()) return;

  _runtime = null;
  await runtime.destroy();
}

/**
 * Acquire the Phase3Runtime singleton.
 *
 * Guarantees:
 * - One active runtime max
 * - One init promise max (concurrent acquires share the same initialized runtime)
 * - One destroy promise max
 * - Acquire waits for any pending destruction
 * - No new runtime starts until old group connections fully close
 * - Generation safety preserved via Phase3Runtime.initGen
 */
export async function acquirePhase3Runtime(persistence?: SyncPersistenceAdapter): Promise<Phase3Runtime> {
  cancelScheduledRelease();

  // Wait for any pending destroy to complete before creating a new runtime
  if (_destroyPromise) {
    await _destroyPromise;
    _destroyPromise = null;
  }

  // If a concurrent acquire already started initializing, return the same promise
  if (_initPromise) {
    return _initPromise;
  }

  // If a runtime already exists and is not destroyed, return it
  if (_runtime && !_runtime.isDestroyed()) {
    return _runtime;
  }

  // Create and initialize a new runtime
  _initPromise = (async () => {
    const runtime = new Phase3Runtime(persistence);
    await runtime.initialize();
    _runtime = runtime;
    return runtime;
  })();

  try {
    return await _initPromise;
  } finally {
    _initPromise = null;
  }
}

/**
 * Release (destroy) the Phase3Runtime singleton.
 *
 * Guarantees:
 * - Idempotent: calling multiple times is safe
 * - No detached destruction promise
 * - Waits for full cleanup including all group connections
 * - Handles in-flight startup: if acquirePhase3Runtime is still initializing,
 *   waits for it to complete then destroys the runtime.
 */
export async function releasePhase3Runtime(): Promise<void> {
  // If destruction is already in progress, wait for it
  if (_destroyPromise) {
    await _destroyPromise;
    return;
  }

  if (_scheduledRelease) {
    await _scheduledRelease.promise;
    return;
  }

  let resolveScheduled!: () => void;
  const scheduledPromise = new Promise<void>((resolve) => {
    resolveScheduled = resolve;
  });

  const timer = setTimeout(() => {
    const scheduled = _scheduledRelease;
    _scheduledRelease = null;

    const destroyPromise = (async () => {
      await destroyRuntimeNow();
    })();

    _destroyPromise = destroyPromise;
    void destroyPromise.finally(() => {
      if (_destroyPromise === destroyPromise) {
        _destroyPromise = null;
      }
      scheduled?.resolve();
    });
  }, STRICT_MODE_RELEASE_GRACE_MS);

  _scheduledRelease = {
    timer,
    promise: scheduledPromise,
    resolve: resolveScheduled,
  };

  await scheduledPromise;
}

/**
 * Synchronously get the current runtime, or null if none is active.
 */
export function getRuntime(): Phase3Runtime | null {
  return _runtime;
}
