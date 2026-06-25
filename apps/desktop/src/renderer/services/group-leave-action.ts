import type { ScreenLinkAPI } from "../../preload/api-types.js";
import { useStore } from "../stores/main-store.js";

/**
 * Result of leaving a group. When the leave was performed purely
 * locally (e.g. as a safety fallback when no API was available),
 * `localOnly` is set to true so the caller can decide whether to
 * keep the action visible.
 */
export interface LeaveGroupResult {
  success: boolean;
  groupId: string;
  localOnly?: boolean;
  error?: string;
}

/**
 * Get the preload ScreenLinkAPI bridge. Returns null when running
 * outside Electron.
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
 * Leave a group via the real preload `leaveGroup` IPC. On success
 * the group is removed from the renderer store. The currently
 * selected group is replaced with the next available group, or
 * cleared if none remain.
 *
 * Returns a `LeaveGroupResult` describing the outcome. When the
 * preload API does not expose `leaveGroup`, returns
 * `{ success: false, localOnly: true, error: "..." }` so the caller
 * can choose to remove the action entirely.
 */
export async function leaveGroupAction(
  groupId: string,
): Promise<LeaveGroupResult> {
  const store = useStore.getState();
  if (!groupId) {
    return { success: false, groupId, error: "Missing group id" };
  }
  const api = getApi();
  if (!api || typeof api.leaveGroup !== "function") {
    return {
      success: false,
      groupId,
      localOnly: true,
      error: "Leave Group API is unavailable",
    };
  }

  try {
    await api.leaveGroup(groupId);
  } catch (err) {
    return {
      success: false,
      groupId,
      error: err instanceof Error ? err.message : "Leave group failed",
    };
  }

  // Remove from normalized store.
  const newGroupsById: typeof store.groupsById = { ...store.groupsById };
  delete newGroupsById[groupId];
  const newGroupOrder = store.groupOrder.filter((id) => id !== groupId);
  store.setGroups(newGroupsById, newGroupOrder);

  // Re-select another group or navigate home if none remain.
  if (store.selectedGroupId === groupId) {
    const next = newGroupOrder[0] ?? null;
    if (next) {
      store.setSelectedGroupId(next);
    } else {
      store.setSelectedGroupId(null);
      store.navigate("home");
    }
  }

  return { success: true, groupId };
}
