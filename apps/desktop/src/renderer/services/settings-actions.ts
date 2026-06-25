import type { ScreenLinkAPI, PersistedSettings, QuickShareConfigDTO } from "../../preload/api-types.js";

/**
 * Get the preload ScreenLinkAPI bridge.
 */
function getApi(): ScreenLinkAPI | null {
  try {
    return (
      (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Load persisted user/device settings from the preload API.
 * Returns the full settings object.
 * Throws if the API is unavailable or the request fails.
 */
export async function loadSettings(): Promise<PersistedSettings> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  const settings = (await api.getSettings()) as PersistedSettings;
  return settings;
}

/**
 * Save partial settings via the preload API.
 * Accepts a partial settings object that is merged by the main process.
 * Throws if the API is unavailable or the request fails.
 */
export async function saveSettings(
  partial: Record<string, unknown>,
): Promise<void> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  await api.updateSettings(partial);
}

/**
 * Update the local user's display name via the preload API.
 * Returns the updated device identity.
 */
export async function updateDisplayName(
  displayName: string,
): Promise<{ deviceId: string; displayName: string; createdAt: number }> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  const result = await api.updateDisplayName(displayName);
  return result;
}

/**
 * Toggle group notifications via the preload API.
 */
export async function setGroupNotifications(
  groupId: string,
  enabled: boolean,
): Promise<void> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  await api.setGroupNotifications(groupId, enabled);
}


export async function loadQuickShareConfig(): Promise<QuickShareConfigDTO> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");
  return api.getQuickShareConfig();
}

export async function saveQuickShareConfig(
  partial: Partial<QuickShareConfigDTO>,
): Promise<void> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");
  await api.updateQuickShareConfig(partial);
}
