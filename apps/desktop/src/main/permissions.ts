import { BrowserWindow } from "electron";

/**
 * Register a permission request handler that grants media and display-capture
 * permissions while denying all others.
 */
export function registerPermissionHandler(window: BrowserWindow): void {
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ["media", "display-capture"];
      callback(allowed.includes(permission));
    },
  );
}
