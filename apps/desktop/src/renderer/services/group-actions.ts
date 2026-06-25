import type { ScreenLinkAPI } from "../../preload/api-types.js";
import { useStore } from "../stores/main-store.js";

/**
 * Get the preload ScreenLinkAPI bridge.
 * Returns null if running outside Electron or if window is unavailable.
 */
function getApi(): ScreenLinkAPI | null {
  try {
    return (
      (window as unknown as { screenlink?: ScreenLinkAPI }).screenlink ?? null
    );
  } catch {
    // window may not be defined (e.g. Node.js test environment)
    return null;
  }
}

/**
 * Create a new group via the preload API, then update the store
 * and navigate to its overview.
 *
 * Returns the new group ID on success.
 * Throws if the API is unavailable or the request fails.
 */
export async function createGroupAction(groupName: string): Promise<string> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  // Call the real createGroup IPC handler
  const result = (await api.createGroup({ groupName })) as {
    groupId: string;
    sharedState: {
      name: { value: string };
      members: Record<string, unknown>;
    };
  };

  const groupId = result.groupId;
  const groupName_ = result.sharedState.name.value;
  const members = result.sharedState.members;

  // Normalize members to the store's shape
  const normalizedMembers: Record<
    string,
    { deviceId: string; displayName: string }
  > = {};
  for (const [k, v] of Object.entries(members)) {
    const m = v as { deviceId?: string; displayName?: string };
    normalizedMembers[k] = {
      deviceId: m.deviceId ?? k,
      displayName: m.displayName ?? k,
    };
  }

  // Update store
  const store = useStore.getState();
  const newGroupsById = {
    ...store.groupsById,
    [groupId]: {
      id: groupId,
      name: groupName_,
      members: normalizedMembers,
    },
  };
  const newGroupOrder = [...store.groupOrder, groupId];
  store.setGroups(newGroupsById, newGroupOrder);

  // Select the new group and navigate to overview
  store.selectGroup(groupId);

  return groupId;
}

/**
 * Join a group via invite link through the preload API, then update
 * the store and navigate to its overview.
 *
 * Returns the joined group ID on success.
 * Throws if the API is unavailable or the request fails.
 */
export async function joinGroupAction(inviteLink: string): Promise<string> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  // Call the real joinGroup IPC handler
  const result = (await api.joinGroup({ link: inviteLink })) as {
    groupId: string;
    sharedState: {
      name: { value: string };
      members: Record<string, unknown>;
    };
  };

  const groupId = result.groupId;
  const groupName = result.sharedState.name.value;
  const members = result.sharedState.members;

  // Normalize members
  const normalizedMembers: Record<
    string,
    { deviceId: string; displayName: string }
  > = {};
  for (const [k, v] of Object.entries(members)) {
    const m = v as { deviceId?: string; displayName?: string };
    normalizedMembers[k] = {
      deviceId: m.deviceId ?? k,
      displayName: m.displayName ?? k,
    };
  }

  // Update store
  const store = useStore.getState();
  const newGroupsById = {
    ...store.groupsById,
    [groupId]: {
      id: groupId,
      name: groupName,
      members: normalizedMembers,
    },
  };
  const newGroupOrder = store.groupOrder.includes(groupId)
    ? store.groupOrder
    : [...store.groupOrder, groupId];
  store.setGroups(newGroupsById, newGroupOrder);

  // Select the joined group and navigate to overview
  store.selectGroup(groupId);

  return groupId;
}

/**
 * Fetch the list of quality presets from the preload API.
 * Returns an array of preset records.
 * Throws if the API is unavailable or the request fails.
 */
export async function fetchQualityPresets(): Promise<
  Array<{ id: string; name: string; settings: unknown }>
> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  const presets = (await api.listQualityPresets()) as Array<{
    id: string;
    name: string;
    settings: unknown;
  }>;
  return presets;
}

/**
 * Create a quality preset via the preload API.
 * Returns the created preset record.
 */
export async function createQualityPreset(input: {
  name: string;
  settings: unknown;
}): Promise<{ id: string; name: string; settings: unknown }> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  const result = (await api.createQualityPreset(input)) as {
    id: string;
    name: string;
    settings: unknown;
  };
  return result;
}

/**
 * Update a quality preset via the preload API.
 * Returns the updated preset record, or null if not found.
 */
export async function updateQualityPreset(
  id: string,
  input: { name?: string; settings?: unknown },
): Promise<{ id: string; name: string; settings: unknown } | null> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  const result = (await api.updateQualityPreset(id, input)) as {
    id: string;
    name: string;
    settings: unknown;
  } | null;
  return result;
}

/**
 * Delete a quality preset via the preload API.
 * Returns true if deleted.
 */
export async function deleteQualityPreset(id: string): Promise<boolean> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  return api.deleteQualityPreset(id);
}

/**
 * Duplicate a quality preset via the preload API.
 * Returns the duplicated preset record, or null if source not found.
 */
export async function duplicateQualityPreset(
  id: string,
  newName: string,
): Promise<{ id: string; name: string; settings: unknown } | null> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  const result = (await api.duplicateQualityPreset(id, newName)) as {
    id: string;
    name: string;
    settings: unknown;
  } | null;
  return result;
}

/**
 * Export a quality preset to a portable string.
 * Returns the export string, or null if not found.
 */
export async function exportQualityPreset(
  id: string,
): Promise<string | null> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  return api.exportQualityPreset(id);
}

/**
 * Import a quality preset from a portable string.
 * Returns the imported preset record.
 */
export async function importQualityPreset(
  exportString: string,
): Promise<{ id: string; name: string; settings: unknown }> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  const result = (await api.importQualityPreset(exportString)) as {
    id: string;
    name: string;
    settings: unknown;
  };
  return result;
}
