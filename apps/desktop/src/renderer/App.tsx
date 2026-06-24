import React, { useEffect } from "react";
import { useStore, type Page } from "./stores/main-store.js";
import { Dashboard } from "./routes/Dashboard.js";
import { SourcePicker } from "./routes/SourcePicker.js";
import { Groups } from "./routes/Groups.js";
import { QualityPresets } from "./routes/QualityPresets.js";
import { Settings } from "./routes/Settings.js";
import { Diagnostics } from "./routes/Diagnostics.js";
import { About } from "./routes/About.js";

// Phase 3: removed Friends, Viewers, Source, Quality (legacy) tabs.
// Source picker is now an internal page invoked from the Dashboard.
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

  // Source picker is internal-only — when navigated to via legacy state
  // we still render it, but it is not in the sidebar.
  useEffect(() => {
    if (currentPage === "source-picker") {
      // Stay on source-picker; user must press Change Source from Dashboard
    }
  }, [currentPage]);

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
