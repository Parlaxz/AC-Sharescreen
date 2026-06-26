import { useEffect, useState } from "react";
import { useStore, type Page } from "./stores/main-store.js";
import { GroupOverview } from "./components/workspace/GroupOverview.js";
import { HostDashboard } from "./components/workspace/HostDashboard.js";
import { ShareSetup } from "./components/workspace/ShareSetup.js";
import { CreateGroupDialog } from "./components/workspace/CreateGroupDialog.js";
import { JoinGroupDialog } from "./components/workspace/JoinGroupDialog.js";
import { HomePage } from "./routes/HomePage.js";
import { GroupsWorkspace } from "./components/workspace/GroupsWorkspace.js";
import { QualityPresetsPage } from "./components/workspace/QualityPresetsPage.js";
import { SettingsPage } from "./components/workspace/SettingsPage.js";
import { GroupSettingsPage } from "./components/workspace/GroupSettingsPage.js";
import { DiagnosticsPage } from "./components/workspace/DiagnosticsPage.js";
import { QuickShareDialog } from "./components/workspace/QuickShareDialog.js";
import { About } from "./routes/About.js";
import { ComponentGallery } from "./routes/ComponentGallery.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "./components/layout/AppShell.js";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts.js";
import { usePreloadEvents } from "./hooks/use-preload-events.js";
import { initializeAppRuntime } from "./services/initialize-app-runtime.js";
import { acquirePhase3Runtime, releasePhase3Runtime } from "./services/phase3-runtime.js";
import type { ScreenLinkAPI } from "../preload/api-types.js";

export function App() {
  // Fix 2: If ?gallery=1 is in the URL, render ComponentGallery ONLY (no AppShell)
  const isGalleryMode = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("gallery") === "1";
  if (isGalleryMode) {
    return <ComponentGallery />;
  }

  const currentPage = useStore((state) => state.currentPage);
  const isSharing = useStore((state) => state.isSharing);
  const sharingGroupId = useStore((state) => state.sharingGroupId);
  const selectedGroupId = useStore((state) => state.selectedGroupId);

  // Host dashboard only renders automatically when:
  //  - a stream is active; AND
  //  - the user has selected the group the stream is publishing to.
  // Selecting another group while streaming shows that group's normal
  // Overview. The local stream still belongs to the original group.
  const hostInSelectedGroup =
    isSharing &&
    sharingGroupId !== null &&
    selectedGroupId === sharingGroupId;

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
        // Host dashboard only renders when the user is currently on
        // the group the active share is publishing to. Selecting a
        // different group while sharing shows that group's Overview.
        if (hostInSelectedGroup) {
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
