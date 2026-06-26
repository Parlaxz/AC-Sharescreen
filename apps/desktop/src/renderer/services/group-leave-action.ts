import { useStore } from "../stores/main-store.js";
import { detachGroupFromRuntime } from "./group-record-helper.js";
import { getApi } from "./get-api.js";

/**
 * Result of leaving a group.
 */
export interface LeaveGroupResult {
  success: boolean;
  groupId: string;
  localOnly?: boolean;
  error?: string;
}

/**
 * Leave a group via the real preload `leaveGroup` IPC, then remove
 * from runtime and renderer store.
 *
 * Sequence:
 *   1) Call persisted leaveGroup IPC
 *   2) Call runtime.removeGroup (sync service + connection)
 *   3) Remove from Zustand store
 *   4) Clear connection-state / online-devices / active-streams for this group
 *   5) Select remaining group or navigate home
 *
 * Returns a `LeaveGroupResult` describing the outcome.
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
    // 1) Call persisted leaveGroup IPC
    await api.leaveGroup(groupId);
  } catch (err) {
    return {
      success: false,
      groupId,
      error: err instanceof Error ? err.message : "Leave group failed",
    };
  }

  // 2-5) Detach from runtime, store, and clear associated state
  await detachGroupFromRuntime(groupId);

  return { success: true, groupId };
}
