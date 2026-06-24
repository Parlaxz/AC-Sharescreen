import React, { useEffect, useRef } from "react";
import { useStore, type Page } from "./stores/main-store.js";
import { Dashboard } from "./routes/Dashboard.js";
import { SourcePicker } from "./routes/SourcePicker.js";
import { Groups } from "./routes/Groups.js";
import { QualityPresets } from "./routes/QualityPresets.js";
import { Settings } from "./routes/Settings.js";
import { Diagnostics } from "./routes/Diagnostics.js";
import { About } from "./routes/About.js";
import { GroupConnectionManager } from "./services/group-connection-manager.js";
import { GroupSyncService } from "./services/group-sync-service.js";
import { ActiveStreamRegistry } from "./services/active-stream-registry.js";

const NAV_ITEMS: { page: Page; label: string }[] = [
  { page: "dashboard", label: "Dashboard" },
  { page: "groups", label: "Groups" },
  { page: "quality-presets", label: "Quality Presets" },
  { page: "settings", label: "Settings" },
  { page: "diagnostics", label: "Diagnostics" },
  { page: "about", label: "About" },
];

let groupConnectionManager: GroupConnectionManager | null = null;
let groupSyncService: GroupSyncService | null = null;
let activeStreamRegistry: ActiveStreamRegistry | null = null;

export function getGroupConnectionManager(): GroupConnectionManager | null {
  return groupConnectionManager;
}

export function getGroupSyncService(): GroupSyncService | null {
  return groupSyncService;
}

export function getActiveStreamRegistry(): ActiveStreamRegistry | null {
  return activeStreamRegistry;
}

export function App() {
  const currentPage = useStore((state) => state.currentPage);
  const navigate = useStore((state) => state.navigate);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const connManager = new GroupConnectionManager();
    const syncService = new GroupSyncService(connManager);
    const streamRegistry = new ActiveStreamRegistry();

    groupConnectionManager = connManager;
    groupSyncService = syncService;
    activeStreamRegistry = streamRegistry;

    // Wire group connection state updates to store
    connManager.setOnStatesChanged((states) => {
      const stateById: Record<string, { groupId: string; state: string; onlinePeers: string[]; error: string | null }> = {};
      for (const [groupId, s] of states) {
        stateById[groupId] = s;
      }
      useStore.getState().setGroupConnectionState(stateById);
    });

    connManager.setOnPeerOnline((groupId, deviceId, displayName) => {
      const store = useStore.getState();
      const byGroup = { ...store.onlineDeviceIdsByGroup };
      if (!byGroup[groupId]) byGroup[groupId] = [];
      if (!byGroup[groupId].includes(deviceId)) {
        byGroup[groupId] = [...byGroup[groupId], deviceId];
      }
      store.setOnlineDevices(byGroup);
    });

    connManager.setOnPeerOffline((groupId, deviceId) => {
      const store = useStore.getState();
      const byGroup = { ...store.onlineDeviceIdsByGroup };
      if (byGroup[groupId]) {
        byGroup[groupId] = byGroup[groupId].filter((d) => d !== deviceId);
      }
      store.setOnlineDevices(byGroup);
    });

    // Listen for stream announcements
    streamRegistry.onUpdate((update) => {
      const store = useStore.getState();
      const byGroup = {
        ...store.activeStreamsByGroup,
        [update.stream.groupId]: streamRegistry.getStreamsByGroup(update.stream.groupId),
      };
      store.setActiveStreams(byGroup);
    });

    // Wire sync service updates to store
    syncService.setOnStateUpdated((groupId, state) => {
      const store = useStore.getState();
      const groupsById = { ...store.groupsById };
      const order = [...store.groupOrder];
      groupsById[groupId] = {
        id: groupId,
        name: state.name.value,
        members: Object.fromEntries(
          Object.entries(state.members).map(([k, v]) => [k, { deviceId: v.deviceId, displayName: v.displayName }]),
        ),
      };
      if (!order.includes(groupId)) order.push(groupId);
      store.setGroups(groupsById, order);
    });

    // Load existing groups from main process
    const api = (window as unknown as { screenlink?: import("../preload/api-types.js").ScreenLinkAPI }).screenlink;
    if (api) {
      api.listGroups().then((records: unknown[]) => {
        for (const r of records as Array<{ groupId: string; sharedState: { name: { value: string }; members: Record<string, unknown>; defaultQuality: unknown }; lastClock: { wallTimeMs: number; counter: number; nodeId: string } }>) {
          const identity = useStore.getState().sourceId ? { deviceId: "local" } : null;
          if (!identity) {
            // Get identity from main process
            api.getDeviceIdentity().then((id) => {
              const configPromise = api.getGroupConnectionConfig(r.groupId);
              configPromise.then((config) => {
                if (config) {
                  const c = config as { groupId: string; controlRoomId: string; groupSecret: string; nodeId: string };
                  connManager.addGroup({
                    groupId: c.groupId,
                    controlRoomId: c.controlRoomId,
                    groupSecret: c.groupSecret,
                    nodeId: id.deviceId,
                    displayName: id.displayName,
                  }).catch(() => {});
                  syncService.initializeGroup(r.groupId, r.sharedState as never, r.lastClock as never);
                }
              }).catch(() => {});
            }).catch(() => {});
          }
        }
      }).catch(() => {});
    }

    return () => {
      streamRegistry.destroy();
      syncService.destroy();
      connManager.destroyAll().catch(() => {});
      groupConnectionManager = null;
      groupSyncService = null;
      activeStreamRegistry = null;
    };
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case "dashboard":
        return <Dashboard />;
      case "source-picker":
        return <SourcePicker />;
      case "groups":
        return <Groups />;
      case "quality-presets":
        return <QualityPresets />;
      case "settings":
        return <Settings />;
      case "diagnostics":
        return <Diagnostics />;
      case "about":
        return <About />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>ScreenLink</h2>
        </div>
        <nav>
          {NAV_ITEMS.map(({ page, label }) => (
            <a
              key={page}
              className={currentPage === page ? "active" : ""}
              onClick={() => navigate(page)}
            >
              {label}
            </a>
          ))}
        </nav>
      </aside>
      <main className="main-content">{renderPage()}</main>
    </div>
  );
}
