import { useEffect } from "react";
import { useStore, type Page } from "./stores/main-store.js";
import { Dashboard } from "./routes/Dashboard.js";
import { SourcePicker } from "./routes/SourcePicker.js";
import { Groups } from "./routes/Groups.js";
import { QualityPresets } from "./routes/QualityPresets.js";
import { Settings } from "./routes/Settings.js";
import { Diagnostics } from "./routes/Diagnostics.js";
import { About } from "./routes/About.js";
import type { GroupSharedState, HybridTimestamp } from "@screenlink/shared";
import type { SyncPersistenceAdapter } from "./services/group-sync-service.js";
import { acquirePhase3Runtime, releasePhase3Runtime } from "./services/phase3-runtime.js";
import type { ScreenLinkAPI } from "../preload/api-types.js";

const NAV_ITEMS: { page: Page; label: string }[] = [
  { page: "dashboard", label: "Dashboard" },
  { page: "groups", label: "Groups" },
  { page: "quality-presets", label: "Quality Presets" },
  { page: "settings", label: "Settings" },
  { page: "diagnostics", label: "Diagnostics" },
  { page: "about", label: "About" },
];

/**
 * Initialize the Phase3 runtime on app startup:
 *   1) Get device identity (fail fast if unavailable – no runtime leak)
 *   2) Acquire Phase3 runtime with persistence adapter
 *   3) List all groups from the persistence layer
 *   4) Populate normalized store (groupsById/groupOrder) BEFORE starting connections
 *   5) Start runtime connections for all groups
 *
 * Exported for testability. App.tsx calls this inside its mount effect
 * and handles cancellation via the returned runtime's lifecycle.
 */
export async function initializeAppRuntime(api: ScreenLinkAPI): Promise<void> {
  // Wire SyncPersistenceAdapter using preload API methods
  const persistence: SyncPersistenceAdapter = {
    persistState: (groupId: string, state: GroupSharedState) =>
      api.updateGroupSharedState(groupId, state) as Promise<void>,
    persistClock: (groupId: string, clock: HybridTimestamp) =>
      api.updateGroupClock(groupId, clock) as Promise<void>,
  };

  // Step 1: Get identity BEFORE acquiring the runtime.
  // If identity is unavailable, return immediately – no runtime to leak.
  const identity = await api.getDeviceIdentity();
  if (!identity) {
    console.warn("[App] Device identity unavailable – skipping runtime startup");
    return;
  }

  // Step 2: Acquire the runtime (now that we know we can use it)
  const runtime = await acquirePhase3Runtime(persistence);

  // Step 3: List all groups
  const records = (await api.listGroups()) as Array<{
    groupId: string;
    sharedState: GroupSharedState;
    lastClock: HybridTimestamp;
  }>;

  // Step 4: Populate normalized store BEFORE starting any connections.
  // This ensures Groups.tsx (store-driven) has data immediately.
  const store = useStore.getState();
  const groupsById: Record<string, { id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> }> = {};
  const groupOrder: string[] = [];
  for (const r of records) {
    groupsById[r.groupId] = {
      id: r.groupId,
      name: r.sharedState.name.value,
      members: Object.fromEntries(
        Object.entries(r.sharedState.members).map(([k, v]) => [
          k,
          { deviceId: v.deviceId, displayName: v.displayName },
        ]),
      ),
    };
    if (!groupOrder.includes(r.groupId)) groupOrder.push(r.groupId);
  }
  store.setGroups(groupsById, groupOrder);

  // Step 5: Start runtime connections for all groups
  for (const r of records) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const config = (await api.getGroupConnectionConfig(r.groupId)) as {
      groupId: string;
      controlRoomId: string;
      groupSecret: string;
      nodeId: string;
    } | null;
    if (config) {
      await runtime.addGroup(
        {
          groupId: config.groupId,
          controlRoomId: config.controlRoomId,
          groupSecret: config.groupSecret,
          nodeId: identity.deviceId,
          displayName: identity.displayName,
        },
        r.sharedState as GroupSharedState,
        r.lastClock as HybridTimestamp,
      );
    }
  }
}

export function App() {
  const currentPage = useStore((state) => state.currentPage);
  const navigate = useStore((state) => state.navigate);

  useEffect(() => {
    const api = (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink;
    if (!api) {
      console.warn("[App] screenlink API not available – running outside Electron?");
      return;
    }
    void initializeAppRuntime(api).catch((err: unknown) => {
      console.error("[App] Runtime startup failed:", err);
      void releasePhase3Runtime();
    });
    return () => {
      void releasePhase3Runtime();
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
