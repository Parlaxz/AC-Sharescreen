import { desktopCapturer, BrowserWindow } from "electron";

let approvedSourceId: string | null = null;

/**
 * Set the approved capture source ID that will be used by the display media
 * request handler. Set to null to clear (prevent any capture).
 */
export function setApprovedSource(sourceId: string | null): void {
  approvedSourceId = sourceId;
}

/**
 * Register the display-media-request handler on the given window.
 * When the renderer calls getDisplayMedia, this handler provides the
 * pre-approved source without showing the system picker.
 *
 * Safety guarantees:
 * - Never passes explicit undefined in callback shape
 * - Never leaks unhandled rejections (async body wrapped in try/catch)
 * - Callback is settled exactly once
 * - Missing source: sends actual lost source ID before clearing
 */
export function registerDisplayMediaHandler(window: BrowserWindow): void {
  window.webContents.session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // Wrap everything in try/catch to prevent unhandled rejections.
      (async () => {
        if (!approvedSourceId) {
          // No approved source — return empty cancellation object.
          callback({});
          return;
        }

        let sources: Electron.DesktopCapturerSource[];
        try {
          sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: false,
          });
        } catch (err) {
          console.error("[display-media] Enumeration error:", err);
          callback({});
          return;
        }

        const matchedSource = sources.find((s) => s.id === approvedSourceId);
        if (!matchedSource) {
          // Save the missing ID before clearing.
          const lostId = approvedSourceId;
          approvedSourceId = null;
          // Notify renderer with the actual lost source ID.
          window.webContents.send("source-lost", { sourceId: lostId });
          callback({});
          return;
        }

        callback({ video: matchedSource });
      })().catch((err) => {
        console.error("[display-media] Unhandled handler error:", err);
        callback({});
      });
    },
    { useSystemPicker: false },
  );
}
