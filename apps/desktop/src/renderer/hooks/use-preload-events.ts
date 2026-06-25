import { useEffect } from "react";
import { useStore } from "../stores/main-store.js";
import { stopShare } from "../services/share-coordinator.js";
import type { ScreenLinkAPI } from "../../preload/api-types.js";

type PreloadEventApi = Pick<ScreenLinkAPI, "onOpenSourcePicker" | "onStopSharing" | "onOpenDiagnostics">;

interface PreloadEventHandlers {
  onOpenSourcePicker: () => void;
  onStopSharing: () => void | Promise<void>;
  onOpenDiagnostics: () => void;
}

export function subscribeToPreloadEvents(
  api: PreloadEventApi | undefined,
  handlers: PreloadEventHandlers,
): () => void {
  if (!api) {
    return () => {};
  }

  const unsubOpenSourcePicker = api.onOpenSourcePicker(handlers.onOpenSourcePicker);
  const unsubStopSharing = api.onStopSharing(() => {
    void handlers.onStopSharing();
  });
  const unsubOpenDiagnostics = api.onOpenDiagnostics(handlers.onOpenDiagnostics);

  return () => {
    unsubOpenSourcePicker();
    unsubStopSharing();
    unsubOpenDiagnostics();
  };
}

/**
 * Subscribe to main-process (tray-originated) events forwarded through
 * the preload bridge.
 *
 * - `open-source-picker` → open the ShareSetup dialog
 * - `stop-sharing`       → stop the active share via the coordinator
 * - `open-diagnostics`   → navigate to the diagnostics page
 *
 * Cleanup functions ensure no listener leaks on unmount.
 */
export function usePreloadEvents(): void {
  useEffect(() => {
    const api = (
      window as unknown as { screenlink?: PreloadEventApi }
    ).screenlink;

    return subscribeToPreloadEvents(api, {
      onOpenSourcePicker: () => {
        useStore.getState().setOpenShareSetup(true);
      },
      onStopSharing: () =>
        stopShare().catch((error) => {
          console.error("[usePreloadEvents] stopShare failed", error);
        }),
      onOpenDiagnostics: () => {
        useStore.getState().navigate("diagnostics");
      },
    });
  }, []);
}
