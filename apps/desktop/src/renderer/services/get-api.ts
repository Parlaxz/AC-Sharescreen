import type { ScreenLinkAPI } from "../../preload/api-types.js";

/**
 * Get the preload ScreenLinkAPI bridge from window.screenlink.
 *
 * Returns null when:
 * - Running outside Electron (window is undefined or missing screenlink)
 * - The preload script has not exposed the API (e.g. test environment)
 *
 * All renderer services should use this single shared accessor rather
 * than duplicating the window cast pattern.
 */
export function getApi(): ScreenLinkAPI | null {
  try {
    return (
      (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink ?? null
    );
  } catch {
    // window may not be defined (e.g. Node.js test environment)
    return null;
  }
}
