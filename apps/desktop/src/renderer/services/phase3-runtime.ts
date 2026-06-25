import { GroupConnectionManager } from "./group-connection-manager.js";
import { GroupSyncService, type SyncPersistenceAdapter } from "./group-sync-service.js";
import { ActiveStreamRegistry } from "./active-stream-registry.js";
import { GroupMessageRouter } from "./group-message-router.js";
import { StreamSessionManager } from "./stream-session-manager.js";
import { ViewerMediaBinding } from "./viewer-media-binding.js";
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
 */
export class Phase3Runtime {
  private connManager: GroupConnectionManager;
  private syncService: GroupSyncService;
  private activeStreamRegistry: ActiveStreamRegistry;
  private messageRouter!: GroupMessageRouter;
  private streamSessionManager!: StreamSessionManager;
  private viewerMediaBinding!: ViewerMediaBinding;
  private destroyed = false;
  private initialized = false;
  private initGen = 0;
  private destroyPromise: Promise<void> | null = null;

  constructor() {
    this.connManager = new GroupConnectionManager();
    this.syncService = new GroupSyncService(this.connManager);
    this.activeStreamRegistry = new ActiveStreamRegistry();
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
          });
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

    // Create ViewerMediaBinding
    this.viewerMediaBinding = new ViewerMediaBinding(this);

    // Create GroupMessageRouter as the SOLE message handler (C1)
    this.messageRouter = new GroupMessageRouter(
      this.syncService,
      this.activeStreamRegistry,
      this.connManager,
      this.viewerMediaBinding,
    );
    this.connManager.setOnMessage((groupId, envelope) => {
      if (gen !== this.initGen || this.destroyed) return;
      this.messageRouter.routeMessage(groupId, envelope as any);
    });

    // Create StreamSessionManager (for local host stream) (C4)
    // VDO publishing is managed externally via PublisherManager.
    this.streamSessionManager = new StreamSessionManager(this);

    this.initialized = true;
  }

  async addGroup(
    config: { groupId: string; controlRoomId: string; groupSecret: string; nodeId: string; displayName: string },
    state: GroupSharedState,
    clock: HybridTimestamp,
  ): Promise<void> {
    if (this.destroyed) return;
    await this.connManager.addGroup(config);
    this.syncService.initializeGroup(config.groupId, state, clock, config.nodeId, config.displayName);
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

  getViewerMediaBinding(): ViewerMediaBinding {
    return this.viewerMediaBinding;
  }
}

// ─── Singleton accessor ─────────────────────────────────────────────────────

let _runtime: Phase3Runtime | null = null;

export function getRuntime(): Phase3Runtime | null {
  return _runtime;
}

export function createRuntime(): Phase3Runtime {
  _runtime = new Phase3Runtime();
  return _runtime;
}

export function destroyRuntime(): void {
  const r = _runtime;
  _runtime = null;
  if (r) {
    void r.destroy();
  }
}
