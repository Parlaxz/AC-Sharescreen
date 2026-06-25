import { useEffect, useState } from "react";
import { useStore, type Page } from "./stores/main-store.js";
import { GroupOverview } from "@/components/workspace/GroupOverview";
import { HostDashboard } from "@/components/workspace/HostDashboard";
import { ShareSetup } from "@/components/workspace/ShareSetup";
import { CreateGroupDialog } from "@/components/workspace/CreateGroupDialog";
import { JoinGroupDialog } from "@/components/workspace/JoinGroupDialog";
import { HomePage } from "./routes/HomePage.js";
import { GroupsWorkspace } from "@/components/workspace/GroupsWorkspace";
import { QualityPresetsPage } from "@/components/workspace/QualityPresetsPage";
import { SettingsPage } from "@/components/workspace/SettingsPage";
import { GroupSettingsPage } from "@/components/workspace/GroupSettingsPage";
import { DiagnosticsPage } from "@/components/workspace/DiagnosticsPage";
import { QuickShareDialog } from "@/components/workspace/QuickShareDialog";
import { About } from "./routes/About.js";
import { ComponentGallery } from "./routes/ComponentGallery.js";
import { CommandPalette } from "@/components/CommandPalette";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { usePreloadEvents } from "@/hooks/use-preload-events";
import type { GroupSharedState, HybridTimestamp } from "@screenlink/shared";
import type { SyncPersistenceAdapter } from "./services/group-sync-service.js";
import { acquirePhase3Runtime, releasePhase3Runtime } from "./services/phase3-runtime.js";
import type { ScreenLinkAPI } from "../preload/api-types.js";

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
export async function initializeAppRuntime(
  api: ScreenLinkAPI,
  shouldAbort: () => boolean = () => false,
): Promise<void> {
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

  if (shouldAbort()) {
    return;
  }

  // Step 4: Populate normalized store BEFORE starting any connections.
  // This ensures Groups.tsx (store-driven) has data immediately.
  const store = useStore.getState();
  const groupsById: Record<string, { id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> }> = {};
  const groupOrder: string[] = [];
  for (const r of records) {
    if (shouldAbort()) {
      return;
    }

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

  // Auto-select first group if none selected
  if (!store.selectedGroupId && groupOrder.length > 0) {
    store.setSelectedGroupId(groupOrder[0]);
  }

  // Step 5: Start runtime connections for all groups
  for (const r of records) {
    if (shouldAbort()) {
      return;
    }

    try {
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
    } catch (err) {
      console.warn(`[App] Failed to initialize group ${r.groupId}:`, err);
    }
  }
}

export function App() {
  // Fix 2: If ?gallery=1 is in the URL, render ComponentGallery ONLY (no AppShell)
  const isGalleryMode = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("gallery") === "1";
  if (isGalleryMode) {
    return <ComponentGallery />;
  }

  const currentPage = useStore((state) => state.currentPage);
  const isSharing = useStore((state) => state.isSharing);

  // Command palette state (Ctrl+K)
  const [commandOpen, setCommandOpen] = useState(false);
  const [quickShareOpen, setQuickShareOpen] = useState(false);

  // Activate keyboard shortcuts
  useKeyboardShortcuts();

  // Subscribe to main-process tray events
  usePreloadEvents();

  // Listen for quick-share:open event from global shortcut or tray
  useEffect(() => {
    const api = (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink;
    if (!api) return;
    const unsub = api.onQuickShareOpen(() => {
      setQuickShareOpen(true);
    });
    return unsub;
  }, []);

  // Listen for custom Ctrl+K toggle event from the hook
  useEffect(() => {
    const handler = () => setCommandOpen((prev) => !prev);
    window.addEventListener("screenlink:toggle-command-palette", handler);
    return () => window.removeEventListener("screenlink:toggle-command-palette", handler);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Expose store for audit harness (browser-only, dev)
    if ((window as unknown as { __SCREENLINK_AUDIT_MODE__?: boolean }).__SCREENLINK_AUDIT_MODE__) {
      (window as unknown as { __SCREENLINK_STORE__?: typeof useStore }).__SCREENLINK_STORE__ = useStore;
    }

    const api = (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink;
    if (!api) {
      console.warn("[App] screenlink API not available – running outside Electron?");
      return;
    }
    void initializeAppRuntime(api, () => cancelled).catch((err: unknown) => {
      if (cancelled) {
        return;
      }
      console.error("[App] Runtime startup failed:", err);
      void releasePhase3Runtime();
    });
    return () => {
      cancelled = true;
      void releasePhase3Runtime();
    };
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case "home":
        return <HomePage />;
      case "overview":
        // When sharing, render HostDashboard instead of GroupOverview
        if (isSharing) {
          return <HostDashboard />;
        }
        return <GroupOverview />;
      case "host":
        return <HostDashboard />;
      case "viewer":
        return <GroupsWorkspace />;
      case "share-setup":
        return <ShareSetup />;
      case "quality-presets":
        return <QualityPresetsPage />;
      case "group-settings":
        return <GroupSettingsPage />;
      case "user-settings":
        return <SettingsPage />;
      case "diagnostics":
        return <DiagnosticsPage />;
      case "about":
        return <About />;
      default:
        return <HomePage />;
    }
  };

  return (
    <TooltipProvider>
      <Toaster />
      <AppShell>
        <main className="h-full overflow-auto">{renderPage()}</main>
      </AppShell>
      {/* ShareSetup dialog — rendered at root level so it can be
          triggered from GroupOverview, UserDock, and SourcePicker */}
      <ShareSetup />
      <CreateGroupDialog />
      <JoinGroupDialog />
      {/* Command palette (Ctrl+K, Section 14) */}
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      {/* Quick Share dialog */}
      <QuickShareDialog open={quickShareOpen} onOpenChange={setQuickShareOpen} />
      {/* Accessibility live regions (Section 14) */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        role="status"
      >
        {isSharing ? "Sharing active" : "Not sharing"}
      </div>
      <div
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
        role="alert"
      >
        {/* Connection state changes rendered dynamically */}
      </div>
    </TooltipProvider>
  );
}
