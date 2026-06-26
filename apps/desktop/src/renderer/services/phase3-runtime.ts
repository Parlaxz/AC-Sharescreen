import { GroupConnectionManager } from "./group-connection-manager.js";
import { GroupSyncService, type SyncPersistenceAdapter } from "./group-sync-service.js";
import { ActiveStreamRegistry } from "./active-stream-registry.js";
import { GroupMessageRouter, type JoinResponseData } from "./group-message-router.js";
import { StreamSessionManager } from "./stream-session-manager.js";
import { ViewerMediaBinding } from "./viewer-media-binding.js";
import { RestartCoordinator } from "./restart-coordinator.js";
import { QualityCoordinator } from "./quality-coordinator.js";
import { MediaStatsPoller } from "./media-stats-service.js";
import { showNotification } from "./notifications.js";
import type { GroupSharedState, HybridTimestamp } from "@screenlink/shared";

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
  private mediaStatsService!: MediaStatsPoller;
  private destroyed = false;
  private initialized = false;
  private initGen = 0;
  private destroyPromise: Promise<void> | null = null;
  private _deviceId: string | null = null;
  private _displayName: string | null = null;

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

    this.connManager.setOnStatesChanged((states) => {
      if (gen !== this.initGen || this.destroyed) return;
      const stateById: Record<string, { groupId: string; state: string; onlinePeers: string[]; error: string | null }> = {};
      for (const [groupId, s] of states) {
        stateById[groupId] = s;
      }
      store.getState().setGroupConnectionState(stateById);
    });

    this.connManager.setOnPeerOnline((groupId, deviceId, displayName) => {
      if (gen !== this.initGen || this.destroyed) return;
      const s = store.getState();
      const byGroup = { ...s.onlineDeviceIdsByGroup };
      if (!byGroup[groupId]) byGroup[groupId] = [];
      if (!byGroup[groupId].includes(deviceId)) {
        byGroup[groupId] = [...byGroup[groupId], deviceId];
      }
      s.setOnlineDevices(byGroup);

      // After peer connects, send stream.state.request to discover their streams (C2.3)
      const conn = this.connManager.getConnection(groupId);
      if (conn) {
        const peerUuid = conn.peerForDevice(deviceId);
        if (peerUuid) {
          void conn.sendToPeer(peerUuid, {
            type: "stream.state.request",
          }).catch(() => {});
        }
      }
    });

    this.connManager.setOnPeerOffline((groupId, deviceId) => {
      if (gen !== this.initGen || this.destroyed) return;
      const s = store.getState();
      const byGroup = { ...s.onlineDeviceIdsByGroup };
      if (byGroup[groupId]) {
        byGroup[groupId] = byGroup[groupId].filter((d) => d !== deviceId);
      }
      s.setOnlineDevices(byGroup);

      // Remove viewer binding when peer goes offline
      this.viewerMediaBinding.removeViewer(deviceId);
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

    // Wire sync service updates to store
    this.syncService.setOnStateUpdated((groupId, state) => {
      if (gen !== this.initGen || this.destroyed) return;
      const s = store.getState();
      const groupsById = { ...s.groupsById };
      const order = [...s.groupOrder];
      groupsById[groupId] = {
        id: groupId,
        name: state.name.value,
        members: Object.fromEntries(
          Object.entries(state.members).map(([k, v]) => [k, { deviceId: v.deviceId, displayName: v.displayName }]),
        ),
      };
      if (!order.includes(groupId)) order.push(groupId);
      s.setGroups(groupsById, order);
    });

    // ── Create Phase 3 services (C2, C7) ──────────────────────────────

    // Create QualityCoordinator and MediaStatsPoller
    this.qualityCoordinator = new QualityCoordinator();
    this.mediaStatsService = new MediaStatsPoller();

    // Create ViewerMediaBinding
    this.viewerMediaBinding = new ViewerMediaBinding(this);

    // Create GroupMessageRouter as the SOLE message handler (C1)
    this.messageRouter = new GroupMessageRouter(
      this.syncService,
      this.activeStreamRegistry,
      this.connManager,
      this.viewerMediaBinding,
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
    config: { groupId: string; controlRoomId: string; groupSecret: string; nodeId: string; displayName: string },
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

    // Step 2: Initialize sync state FIRST so messages arriving after connection
    // start have a valid sync state to work with.  Await sync init (including
    // any persistence of a freshly inserted local member) before connecting.
    await this.syncService.initializeGroup(config.groupId, state, clock, config.nodeId, config.displayName);

    // Step 5: Start the connection
    await this.connManager.addGroup(config);

    const conn = this.connManager.getConnection(config.groupId);

    // Step 6: Broadcast member presence notifications.
    // The local user "joined" the group and is now "online".
    if (conn && conn.state === "connected") {
      void conn.broadcastMemberJoined(config.nodeId, config.displayName).catch(() => {});
      void conn.broadcastMemberOnline(config.nodeId, config.displayName).catch(() => {});
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

    // Step 8: Replay any queued member events that arrived during startup
    // (e.g. "member.joined" notifications from peers we connected to).
    const groupName = syncState?.state.name.value ?? config.groupId;
    const recentEvents = this.messageRouter.drainRecentMemberEvents(config.groupId);
    for (const evt of recentEvents) {
      showNotification({
        title: "ScreenLink",
        body: evt.type === "joined"
          ? `${evt.memberDisplayName} joined ${groupName}`
          : `${evt.memberDisplayName} is online in ${groupName}`,
      });
    }
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
      this.streamSessionManager.destroy();
      this.viewerMediaBinding.destroy();
      this.restartCoordinator.destroy();
      this.syncService.destroy();
      await this.connManager.destroyAll();
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

  getMediaStatsService(): MediaStatsPoller {
    return this.mediaStatsService;
  }

  /**
   * Wait for a stream.join.response matching the given requestId.
   * Delegates to GroupMessageRouter's pending request resolution.
   * Used by Dashboard to complete the viewer join flow.
   */
  waitForJoinResponse(requestId: string, timeoutMs?: number): Promise<JoinResponseData> {
    return this.messageRouter.waitForJoinResponse(requestId, timeoutMs);
  }
}

// ─── Singleton accessor (async acquire/release) ─────────────────────────────

let _runtime: Phase3Runtime | null = null;
let _initPromise: Promise<Phase3Runtime> | null = null;
let _destroyPromise: Promise<void> | null = null;

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

  // If startup is still in progress, wait for it then destroy.
  // This handles the case where cleanup fires before acquirePhase3Runtime
  // finishes initializing (e.g. StrictMode unmount during pending acquire).
  if (_initPromise) {
    const runtime = await _initPromise;
    _initPromise = null; // prevent further reuse of this promise
    _runtime = null;
    await runtime.destroy();
    return;
  }

  const runtime = _runtime;
  if (!runtime || runtime.isDestroyed()) return;

  // Start destruction, tracking the promise
  _destroyPromise = (async () => {
    _runtime = null;
    await runtime.destroy();
  })();

  await _destroyPromise;
  _destroyPromise = null;
}

/**
 * Synchronously get the current runtime, or null if none is active.
 */
export function getRuntime(): Phase3Runtime | null {
  return _runtime;
}
