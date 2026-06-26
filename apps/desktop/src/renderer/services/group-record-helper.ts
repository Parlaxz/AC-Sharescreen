import type { GroupRecordDTO, GroupConnectionConfigDTO } from "../../preload/api-types.js";
import { useStore } from "../stores/main-store.js";
import { getRuntime } from "./phase3-runtime.js";
import { getApi } from "./get-api.js";

/**
 * Normalize GroupSharedState members to the store's compact shape.
 */
function normalizeMembers(
  members: Record<string, { deviceId: string; displayName: string }>,
): Record<string, { deviceId: string; displayName: string }> {
  const result: Record<string, { deviceId: string; displayName: string }> = {};
  for (const [k, v] of Object.entries(members)) {
    result[k] = {
      deviceId: v.deviceId ?? k,
      displayName: v.displayName ?? k,
    };
  }
  return result;
}

/**
 * Attach a group record to the Phase3 runtime and renderer store.
 *
 * This is the shared path for both create-group and join-group flows:
 *   1) Acquire the runtime singleton
 *   2) Resolve current device identity
 *   3) Fetch real connection config via preload
 *   4) Validate config
 *   5) Call runtime.addGroup(config, record.sharedState, record.lastClock)
 *   6) Normalize group to Zustand store shape and persist it
 *   7) Select the group and navigate to overview
 *
 * Returns the group ID on success.
 * Throws on any failure (callers should catch and surface to the user).
 */
export async function attachGroupRecordToRuntime(
  record: GroupRecordDTO,
): Promise<string> {
  const api = getApi();
  if (!api) throw new Error("screenlink API not available");

  // Validate the record shape up front. The main-process `GroupStore` always
  // returns records with a `groupId`; anything else would produce an
  // `getGroupConnectionConfig(undefined)` IPC call and leave the renderer in
  // an unrecoverable state.
  const groupId = record.groupId;
  if (typeof groupId !== "string" || groupId.length === 0) {
    throw new Error("Invalid group record: missing groupId");
  }

  // 1) Resolve runtime
  const runtime = getRuntime();
  if (!runtime || runtime.isDestroyed()) {
    throw new Error("Phase3 runtime is not initialized");
  }

  // 2) Resolve device identity
  const identity = await api.getDeviceIdentity();
  const nodeId = identity.deviceId;
  const displayName = identity.displayName;

  // 3) Fetch connection config
  const config = (await api.getGroupConnectionConfig(groupId)) as GroupConnectionConfigDTO | null;
  if (!config) {
    throw new Error(`No connection config found for group ${groupId}`);
  }
  if (!config.controlRoomId || !config.groupSecret) {
    throw new Error(`Invalid connection config for group ${groupId}: missing controlRoomId or groupSecret`);
  }
  // Sanity-check that the config refers to the same group. A mismatched
  // groupId means the persisted store is out of sync with the config blob,
  // and silently accepting it would let the wrong group attach.
  if (config.groupId && config.groupId !== groupId) {
    throw new Error("Group connection config does not match group record");
  }

  // 4) Call runtime.addGroup
  await runtime.addGroup(
    {
      groupId,
      controlRoomId: config.controlRoomId,
      groupSecret: config.groupSecret,
      nodeId,
      displayName,
    },
    record.sharedState,
    record.lastClock,
  );

  // 5) Normalize and persist to Zustand store
  const groupName = record.sharedState.name.value;
  const members = normalizeMembers(record.sharedState.members as unknown as Record<string, { deviceId: string; displayName: string }>);

  const store = useStore.getState();
  const newGroupsById = {
    ...store.groupsById,
    [groupId]: {
      id: groupId,
      name: groupName,
      members,
    },
  };
  const newGroupOrder = store.groupOrder.includes(groupId)
    ? store.groupOrder
    : [...store.groupOrder, groupId];
  store.setGroups(newGroupsById, newGroupOrder);

  // 6) Select and navigate
  store.selectGroup(groupId);

  return groupId;
}

/**
 * Remove a group from the runtime AND the renderer store, clearing
 * all associated connection/online/active-stream state.
 *
 * Returns true on success, false if the group was not found.
 */
export async function detachGroupFromRuntime(groupId: string): Promise<boolean> {
  const store = useStore.getState();

  // 1) Remove from runtime (syncService + connection)
  const runtime = getRuntime();
  if (runtime && !runtime.isDestroyed()) {
    await runtime.removeGroup(groupId);
  }

  // 2) Remove from normalized store
  const newGroupsById = { ...store.groupsById };
  delete newGroupsById[groupId];
  const newGroupOrder = store.groupOrder.filter((id) => id !== groupId);

  // 3) Clear connection state for this group
  const newConnState = { ...store.groupConnectionStateById };
  delete newConnState[groupId];

  // 4) Clear online device state for this group
  const newOnlineDevices = { ...store.onlineDeviceIdsByGroup };
  delete newOnlineDevices[groupId];

  // 5) Clear active stream state for this group
  const newActiveStreams = { ...store.activeStreamsByGroup };
  delete newActiveStreams[groupId];

  // 6) Clear watched streams (no groupId mapping per entry, so clear all)
  const newWatchedStreams: Record<string, { hostDeviceId: string; hostName: string; startedAt: number }> = {};

  // Apply all store changes
  store.setGroups(newGroupsById, newGroupOrder);
  store.setGroupConnectionState(newConnState);
  store.setOnlineDevices(newOnlineDevices);
  store.setActiveStreams(newActiveStreams);
  store.setWatchedStreams(newWatchedStreams);

  // 7) Clear viewing state if this was the active view
  if (store.isViewing) {
    store.setIsViewing(false);
    store.setViewStatus("");
  }

  // 8) Re-select or navigate home
  if (store.selectedGroupId === groupId) {
    const next = newGroupOrder[0] ?? null;
    if (next) {
      store.setSelectedGroupId(next);
    } else {
      store.setSelectedGroupId(null);
      store.navigate("home");
    }
  }

  return true;
}
