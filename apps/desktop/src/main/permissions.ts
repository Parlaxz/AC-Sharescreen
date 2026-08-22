import { app, BrowserWindow, type WebContents } from "electron";

/**
 * Verify that the requesting webContents was loaded from an app-controlled
 * origin. Without this, any frame that obtains the permission-request bridge
 * (e.g. a compromised remote page in an iframe/webview) could be granted
 * media / display-capture access.
 *
 * - Dev: allow the local dev server, loopback, devtools, and the
 *   screenlink://app/ scheme itself.
 * - Packaged: require the "screenlink://app/" prefix only.
 */
function isAppOrigin(webContents: WebContents): boolean {
  try {
    const url = webContents.getURL();
    if (!url) return false;
    if (app.isPackaged) {
      return url.startsWith("screenlink://app/");
    }
    return (
      url.startsWith("http://localhost") ||
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("devtools://") ||
      url.startsWith("screenlink://app/")
    );
  } catch {
    // If we cannot determine the origin, fail closed.
    return false;
  }
}

/**
 * Register a permission request handler that grants media and display-capture
 * permissions to app-origin content while denying all other permissions and
 * all non-app origins.
 */
export function registerPermissionHandler(window: BrowserWindow): void {
  window.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowedPermissions = ["media", "display-capture"];
      callback(allowedPermissions.includes(permission) && isAppOrigin(webContents));
    },
  );
}
