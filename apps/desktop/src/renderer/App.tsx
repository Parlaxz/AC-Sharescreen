import React, { useEffect } from "react";
import { useStore, type Page } from "./stores/main-store.js";
import { Dashboard } from "./routes/Dashboard.js";
import { SourcePicker } from "./routes/SourcePicker.js";
import { Quality } from "./routes/Quality.js";
import { Viewers } from "./routes/Viewers.js";
import { Friends } from "./routes/Friends.js";
import { Settings } from "./routes/Settings.js";
import { Diagnostics } from "./routes/Diagnostics.js";
import { About } from "./routes/About.js";
import { getControlConnection, destroyControlConnection } from "./services/control-connection.js";
import { startNotificationWatcher } from "./services/notification-watcher.js";

const NAV_ITEMS: { page: Page; label: string }[] = [
  { page: "dashboard", label: "Dashboard" },
  { page: "source-picker", label: "Source" },
  { page: "quality", label: "Quality" },
  { page: "viewers", label: "Viewers" },
  { page: "friends", label: "Friends" },
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
      case "quality":
        return <Quality />;
      case "viewers":
        return <Viewers />;
      case "friends":
        return <Friends />;
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

  // Start control connection on mount
  useEffect(() => {
    const ctrl = getControlConnection();
    ctrl.start();
    return () => {
      destroyControlConnection();
    };
  }, []);

  // Start notification watcher on mount
  useEffect(() => {
    const unsubscribe = startNotificationWatcher();
    return () => {
      unsubscribe();
    };
  }, []);

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
