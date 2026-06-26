import { attachGroupRecordToRuntime } from "./group-record-helper.js";
import { getApi } from "./get-api.js";

/**
 * Create a new group via the preload API, attach it to the runtime,
 * update the store, and navigate to its overview.
 *
 * Returns the new group ID on success.
 * Throws if the API is unavailable or the request fails.
 */
export async function createGroupAction(groupName: string): Promise<string> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  // Call the real createGroup IPC handler.
  // Real shape: { record: GroupRecordDTO, invite: string, link: string }
  const response = await api.createGroup({ groupName });

  // Attach the group record to runtime + renderer store
  const groupId = await attachGroupRecordToRuntime(response.record);

  return groupId;
}

/**
 * Join a group via invite link through the preload API, attach it to
 * the runtime, update the store, and navigate to its overview.
 *
 * Returns the joined group ID on success.
 * Throws if the API is unavailable or the request fails.
 */
export async function joinGroupAction(inviteLink: string): Promise<string> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  // Call the real joinGroup IPC handler.
  // Real shape: GroupRecordDTO (the record directly)
  const record = await api.joinGroup({ link: inviteLink });

  // Attach the group record to runtime + renderer store
  const groupId = await attachGroupRecordToRuntime(record);

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
