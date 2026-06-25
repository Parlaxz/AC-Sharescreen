import React, { useEffect, useRef } from "react";
import { useStore, type Page } from "./stores/main-store.js";
import { Dashboard } from "./routes/Dashboard.js";
import { SourcePicker } from "./routes/SourcePicker.js";
import { Groups } from "./routes/Groups.js";
import { QualityPresets } from "./routes/QualityPresets.js";
import { Settings } from "./routes/Settings.js";
import { Diagnostics } from "./routes/Diagnostics.js";
import { About } from "./routes/About.js";
import type { GroupSharedState, HybridTimestamp } from "@screenlink/shared";
import { createRuntime, destroyRuntime } from "./services/phase3-runtime.js";

const NAV_ITEMS: { page: Page; label: string }[] = [
  { page: "dashboard", label: "Dashboard" },
  { page: "groups", label: "Groups" },
  { page: "quality-presets", label: "Quality Presets" },
  { page: "settings", label: "Settings" },
  { page: "diagnostics", label: "Diagnostics" },
  { page: "about", label: "About" },
];

export function App() {
  const currentPage = useStore((state) => state.currentPage);
  const navigate = useStore((state) => state.navigate);

  useEffect(() => {
    const runtime = createRuntime();
    runtime.initialize().then(async () => {
      const api = (window as unknown as { screenlink?: import("../preload/api-types.js").ScreenLinkAPI }).screenlink;
      if (!api) return;
      const identity = await api.getDeviceIdentity();
      if (!identity) return;
      const records = await api.listGroups();
      for (const r of records as Array<{ groupId: string; sharedState: GroupSharedState; lastClock: HybridTimestamp }>) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        const config = await api.getGroupConnectionConfig(r.groupId) as { groupId: string; controlRoomId: string; groupSecret: string; nodeId: string } | null;
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
    });
    return () => { destroyRuntime(); };
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
