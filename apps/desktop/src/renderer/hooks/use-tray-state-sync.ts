import { useEffect } from "react";
import { useStore } from "../stores/main-store.js";
import type { ScreenLinkAPI } from "../../preload/api-types.js";

function getApi(): ScreenLinkAPI | null {
  return (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink ?? null;
}

/**
 * Sync relevant Zustand store fields to the tray manager in the main
 * process via IPC whenever they change.
 *
 * Notes:
 * - Sends all three values on mount so the tray reflects the current
 *   state even if it changed during a React Strict Mode unmount gap.
 * - Subscribe fires on EVERY store change.  The TrayManager handles
 *   redundant calls as a no-op internally, so no guard is needed here.
 * - Also re-syncs on `visibilitychange` so the tray catches updates
 *   that happened while the window was hidden.
 */
export function useTrayStateSync(): void {
  useEffect(() => {
    function sync() {
      const api = getApi();
      if (!api) return;
      const s = useStore.getState();
      api.traySetSharing(s.isSharing);
      api.traySetViewing(s.isViewing);
      api.traySetViewerCount(s.viewerCount);
    }

    // 1. Current state on mount (catches Strict Mode remount gaps).
    sync();

    // 2. Subscribe to every store change.
    const unsub = useStore.subscribe(sync);

    // 3. Re-sync when window becomes visible (catches stale state from
    //    backgrounded tabs or sleep/wake cycles).
    const onVis = () => { if (document.visibilityState === "visible") sync(); };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
}
