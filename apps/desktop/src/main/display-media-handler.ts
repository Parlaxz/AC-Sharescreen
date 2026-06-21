import { desktopCapturer, BrowserWindow } from "electron";

let approvedSourceId: string | null = null;
let systemAudioEnabled = false;

/**
 * Set the approved capture source ID that will be used by the display media
 * request handler. Set to null to prevent any capture.
 */
export function setApprovedSource(sourceId: string | null): void {
  approvedSourceId = sourceId;
}

/**
 * Enable or disable system audio loopback in the display media stream.
 */
export function setSystemAudioEnabled(enabled: boolean): void {
  systemAudioEnabled = enabled;
}

/**
 * Register the display-media-request handler on the given window.
 * When the renderer calls getDisplayMedia, this handler provides the
 * pre-approved source without showing the system picker.
 */
export function registerDisplayMediaHandler(window: BrowserWindow): void {
  window.webContents.session.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      if (!approvedSourceId) {
        callback({ video: undefined, audio: undefined });
        return;
      }

      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });

      const matchedSource = sources.find((s) => s.id === approvedSourceId);
      if (!matchedSource) {
        approvedSourceId = null;
        callback({ video: undefined, audio: undefined });
        // Notify renderer that the source is no longer available
        window.webContents.send("source-lost", { sourceId: approvedSourceId });
        return;
      }

      callback({
        video: matchedSource,
        audio: systemAudioEnabled ? ("loopback" as const) : undefined,
      });
    },
    { useSystemPicker: false },
  );
}
