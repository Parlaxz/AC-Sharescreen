import { useEffect, useRef } from "react";
import { useStore } from "../stores/main-store.js";
import type { ScreenLinkAPI } from "../../preload/api-types.js";

function getApi(): ScreenLinkAPI | null {
  return (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink ?? null;
}

export function useTrayStateSync(): void {
  const prevSharing = useRef(false);
  const prevViewing = useRef(false);
  const prevViewerCount = useRef(0);

  useEffect(() => {
    const unsub = useStore.subscribe((state) => {
      const api = getApi();
      if (!api) return;

      if (state.isSharing !== prevSharing.current) {
        prevSharing.current = state.isSharing;
        api.traySetSharing(state.isSharing);
      }
      if (state.isViewing !== prevViewing.current) {
        prevViewing.current = state.isViewing;
        api.traySetViewing(state.isViewing);
      }
      if (state.viewerCount !== prevViewerCount.current) {
        prevViewerCount.current = state.viewerCount;
        api.traySetViewerCount(state.viewerCount);
      }
    });

    return unsub;
  }, []);
}
