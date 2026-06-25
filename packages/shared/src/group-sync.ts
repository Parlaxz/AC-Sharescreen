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
        schemaVersion: 1,
        video: {
          videoBitrateKbps: 0,
          sendWidth: 0,
          sendHeight: 0,
          sendFps: 0,
          captureWidth: 0,
          captureHeight: 0,
          captureFps: 0,
          preserveAspectRatio: true,
          preventUpscale: true,
          resolutionMode: "target-dimensions",
          scaleResolutionDownBy: 1,
          codec: "vp9",
          h264Profile: "auto",
          contentHint: "detail",
          degradationPreference: "balanced",
          scalabilityMode: null,
          cursorMode: "always",
          rtpPriority: "medium",
        },
        audio: {
          bitrateKbps: 0,
          channels: "stereo",
          bitrateMode: "vbr",
          dtx: false,
          fec: true,
          packetDurationMs: 20,
          redundantAudio: false,
        },
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
