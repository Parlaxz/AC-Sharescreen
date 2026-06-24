import type { GroupSharedState } from "./groups.js";
import type { HybridClock, HybridTimestamp } from "./hybrid-logical-clock.js";
import { mergeGroupSharedState, getGroupStateDelta } from "./groups.js";
import { tickLocal } from "./hybrid-logical-clock.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

export interface ApplyRemoteStateUpdateResult {
  state: GroupSharedState;
  stamp: HybridTimestamp;
  rebroadcast: boolean;
}

/**
 * Apply a remote state update (partial or full) to the local group state.
 * Uses mergeGroupSharedState internally. If a change was detected, the clock
 * is ticked and rebroadcast is set to true (the caller should propagate the
 * merged result to other peers).
 */
export function applyRemoteStateUpdate(
  local: GroupSharedState,
  update: Partial<GroupSharedState>,
  clock: HybridClock,
  now?: number,
): ApplyRemoteStateUpdateResult {
  // Build a full GroupSharedState from the partial update + local fallbacks
  const remoteState: GroupSharedState = {
    schemaVersion: 1,
    groupId: update.groupId ?? local.groupId,
    name: update.name ?? local.name,
    defaultQuality: update.defaultQuality ?? local.defaultQuality,
    members: update.members ?? local.members,
  };

  const result = mergeGroupSharedState(local, remoteState);
  const stamp = tickLocal(clock, now);

  return {
    state: result.state,
    stamp,
    rebroadcast: result.changed,
  };
}

export interface BuildStateUpdateResult {
  delta: Partial<GroupSharedState>;
  stamp: HybridTimestamp;
}

/**
 * Build a state update (delta) from the current local state.
 * Uses the clock to generate a fresh timestamp.
 */
export function buildStateUpdate(
  local: GroupSharedState,
  clock: HybridClock,
  now?: number,
): BuildStateUpdateResult {
  // Use a "null" remote — an empty state — to compute diff against nothing
  const emptyState: GroupSharedState = {
    schemaVersion: 1,
    groupId: local.groupId,
    name: {
      value: "",
      stamp: { wallTimeMs: 0, counter: 0, nodeId: "" },
      valueHash: "",
      updatedByDeviceId: "",
    },
    defaultQuality: {
      value: {
        videoBitrateKbps: 0,
        maxWidth: 0,
        maxHeight: 0,
        maxFps: 0,
        degradationPreference: "balanced",
        contentHint: "detail",
        audioEnabled: false,
      },
      stamp: { wallTimeMs: 0, counter: 0, nodeId: "" },
      valueHash: "",
      updatedByDeviceId: "",
    },
    members: {},
  };

  const stamp = tickLocal(clock, now);
  const delta = getGroupStateDelta(emptyState, local);

  return {
    delta: delta ?? {},
    stamp,
  };
}
