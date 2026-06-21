import { app } from "electron";
import type { WindowManager } from "./window-manager.js";

/**
 * Setup single-instance lock so only one ScreenLink process runs at a time.
 * If another instance is started, the existing one is focused.
 *
 * Pass --multi-instance to allow multiple instances (for testing).
 *
 * @returns false if this is not the primary instance (caller should quit)
 */
export function setupSingleInstance(windowManager: WindowManager): boolean {
  // Allow multiple instances for testing
  if (process.argv.includes("--multi-instance")) {
    return true;
  }

  // Dev profiles use separate namespaces
  const devProfile = getDevProfile();
  if (devProfile) {
    // Profile-based instances are also allowed to multi-instance
    return true;
  }

  const hasLock = app.requestSingleInstanceLock();

  if (!hasLock) {
    app.quit();
    return false;
  }

  app.on("second-instance", () => {
    windowManager.show();
    windowManager.focus();
  });

  return true;
}

export function getDevProfile(): string | null {
  const idx = process.argv.indexOf("--dev-profile");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1] ?? null;
  }

  const inlineArg = process.argv.find((arg) => arg.startsWith("--dev-profile="));
  if (inlineArg) {
    const value = inlineArg.slice("--dev-profile=".length).trim();
    return value || null;
  }

  return null;
}
