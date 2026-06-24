import { z } from "zod";
import type { HybridTimestamp } from "./hybrid-logical-clock.js";
import type { GroupQualitySettings } from "./quality-settings.js";
import { HybridTimestampSchema } from "./hybrid-logical-clock.js";
import { GroupQualitySettingsSchema } from "./quality-settings.js";
import { compareHybridTimestamp } from "./hybrid-logical-clock.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface LwwRegister<T> {
  value: T;
  stamp: HybridTimestamp;
  valueHash: string;
  updatedByDeviceId: string;
}

export interface GroupMemberRecord {
  deviceId: string;
  displayName: string;
  firstSeenAt: number;
  profileStamp: HybridTimestamp;
}

export interface GroupSharedState {
  schemaVersion: 1;
  groupId: string;
  name: LwwRegister<string>;
  defaultQuality: LwwRegister<GroupQualitySettings>;
  members: Record<string, GroupMemberRecord>;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

export const LwwRegisterSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.object({
    value: valueSchema,
    stamp: HybridTimestampSchema,
    valueHash: z.string(),
    updatedByDeviceId: z.string(),
  });

export const GroupMemberRecordSchema = z.object({
  deviceId: z.string(),
  displayName: z.string().min(1).max(100),
  firstSeenAt: z.number().int().positive(),
  profileStamp: HybridTimestampSchema,
});

export const GroupSharedStateSchema: z.ZodType<GroupSharedState> = z.object({
  schemaVersion: z.literal(1),
  groupId: z.string().uuid(),
  name: LwwRegisterSchema(z.string()),
  defaultQuality: LwwRegisterSchema(GroupQualitySettingsSchema),
  members: z.record(z.string(), GroupMemberRecordSchema),
});

// ─── Canonical JSON hashing ────────────────────────────────────────────────

/**
 * Compute a SHA-256 hex digest of a value's canonical JSON representation.
 * "Canonical" means sorted keys at every object level.
 */
export async function canonicalJsonHash(value: unknown): Promise<string> {
  const json = canonicalJsonStringify(value);
  const encoder = new TextEncoder();
  const data = encoder.encode(json);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Make an LWW register value.
 */
export function makeLww<T>(
  value: T,
  stamp: HybridTimestamp,
  updatedByDeviceId: string,
): LwwRegister<T> {
  return {
    value,
    stamp,
    valueHash: "", // Will be filled after async computation
    updatedByDeviceId,
  };
}

/**
 * Create an LWW register with hash computed asynchronously.
 */
export async function makeLwwWithHash<T>(
  value: T,
  stamp: HybridTimestamp,
  updatedByDeviceId: string,
): Promise<LwwRegister<T>> {
  const valueHash = await canonicalJsonHash(value);
  return { value, stamp, valueHash, updatedByDeviceId };
}

// ─── Merge ─────────────────────────────────────────────────────────────────

export interface MergeResult {
  state: GroupSharedState;
  changed: boolean;
  conflicts: Array<{ field: string; reason: string }>;
}

/**
 * Compare only the logical time portion of two HybridTimestamps, ignoring
 * nodeId. Returns -1, 0, or 1.
 */
function compareLogicalTime(
  a: HybridTimestamp,
  b: HybridTimestamp,
): number {
  if (a.wallTimeMs !== b.wallTimeMs) {
    return a.wallTimeMs < b.wallTimeMs ? -1 : 1;
  }
  if (a.counter !== b.counter) {
    return a.counter < b.counter ? -1 : 1;
  }
  return 0;
}

/**
 * Merge a remote GroupSharedState into the local state using LWW for name and
 * defaultQuality, and per-device LWW for member records.
 *
 * LWW comparison uses only logical time (wallTimeMs + counter). When logical
 * time is equal, stamps are considered concurrent: if values differ, a conflict
 * is reported and the lower nodeId wins deterministically.
 */
export function mergeGroupSharedState(
  local: GroupSharedState,
  remote: GroupSharedState,
): MergeResult {
  const conflicts: Array<{ field: string; reason: string }> = [];
  let changed = false;

  // Start with a copy of local
  const state: GroupSharedState = {
    schemaVersion: 1,
    groupId: local.groupId,
    name: { ...local.name },
    defaultQuality: { ...local.defaultQuality },
    members: { ...local.members },
  };

  // Merge name (LWW by logical time)
  const nameCmp = compareLogicalTime(
    remote.name.stamp,
    local.name.stamp,
  );
  if (nameCmp > 0) {
    state.name = { ...remote.name };
    changed = true;
  } else if (nameCmp === 0) {
    // Concurrent updates: check for value conflict
    if (remote.name.valueHash !== local.name.valueHash) {
      conflicts.push({
        field: "name",
        reason: "Concurrent update with equal stamp but different value hash",
      });
      // Deterministic tiebreaker: lower nodeId wins
      if (remote.name.stamp.nodeId < local.name.stamp.nodeId) {
        state.name = { ...remote.name };
        changed = true;
      }
    }
  }

  // Merge defaultQuality (LWW by logical time)
  const qualityCmp = compareLogicalTime(
    remote.defaultQuality.stamp,
    local.defaultQuality.stamp,
  );
  if (qualityCmp > 0) {
    state.defaultQuality = { ...remote.defaultQuality };
    changed = true;
  } else if (qualityCmp === 0) {
    if (remote.defaultQuality.valueHash !== local.defaultQuality.valueHash) {
      conflicts.push({
        field: "defaultQuality",
        reason: "Concurrent update with equal stamp but different value hash",
      });
      if (remote.defaultQuality.stamp.nodeId < local.defaultQuality.stamp.nodeId) {
        state.defaultQuality = { ...remote.defaultQuality };
        changed = true;
      }
    }
  }

  // Merge members (per-device LWW by logical time)
  const allDeviceIds = new Set([
    ...Object.keys(local.members),
    ...Object.keys(remote.members),
  ]);

  for (const deviceId of allDeviceIds) {
    const localMember = local.members[deviceId];
    const remoteMember = remote.members[deviceId];

    if (!localMember && remoteMember) {
      // New member from remote
      state.members[deviceId] = { ...remoteMember };
      changed = true;
    } else if (localMember && !remoteMember) {
      // Local member not in remote — preserve
      state.members[deviceId] = { ...localMember };
    } else if (localMember && remoteMember) {
      // Both exist — LWW on profileStamp
      const stampCmp = compareLogicalTime(
        remoteMember.profileStamp,
        localMember.profileStamp,
      );
      if (stampCmp > 0) {
        state.members[deviceId] = { ...remoteMember };
        changed = true;
      } else if (stampCmp === 0) {
        if (remoteMember.displayName !== localMember.displayName) {
          conflicts.push({
            field: `members.${deviceId}`,
            reason: "Concurrent member update with equal stamp but different displayName",
          });
          if (remoteMember.deviceId < localMember.deviceId) {
            state.members[deviceId] = { ...remoteMember };
            changed = true;
          }
        }
      }
      // else local is newer — keep as is
    }
  }

  return { state, changed, conflicts };
}

// ─── Summary / Delta ───────────────────────────────────────────────────────

export interface GroupSummary {
  groupId: string;
  name: string;
  memberCount: number;
  revision: number;
}

/**
 * Compute a summary of the group state.
 * Revision is derived from the wallTimeMs of the name stamp (as a proxy).
 */
export function summarizeGroupSharedState(
  state: GroupSharedState,
): GroupSummary {
  return {
    groupId: state.groupId,
    name: state.name.value,
    memberCount: Object.keys(state.members).length,
    revision: state.name.stamp.wallTimeMs,
  };
}

/**
 * Compare two group summaries.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Ordered by revision descending, then groupId ascending.
 */
export function compareGroupSummary(
  a: GroupSummary,
  b: GroupSummary,
): number {
  if (a.revision !== b.revision) {
    return a.revision > b.revision ? -1 : 1;
  }
  if (a.groupId !== b.groupId) {
    return a.groupId < b.groupId ? -1 : 1;
  }
  return 0;
}

/**
 * Compute the delta from local state to remote state.
 * Returns null if they are equal; otherwise returns a partial GroupSharedState
 * with only the differing fields set.
 */
export function getGroupStateDelta(
  local: GroupSharedState,
  remote: GroupSharedState,
): Partial<GroupSharedState> | null {
  const delta: Partial<GroupSharedState> = {};
  let hasDelta = false;

  if (
    local.name.value !== remote.name.value ||
    compareHybridTimestamp(local.name.stamp, remote.name.stamp) !== 0
  ) {
    delta.name = remote.name;
    hasDelta = true;
  }

  if (
    local.defaultQuality.value !== remote.defaultQuality.value ||
    compareHybridTimestamp(local.defaultQuality.stamp, remote.defaultQuality.stamp) !== 0
  ) {
    delta.defaultQuality = remote.defaultQuality;
    hasDelta = true;
  }

  // Check members
  const allDeviceIds = new Set([
    ...Object.keys(local.members),
    ...Object.keys(remote.members),
  ]);
  const memberDelta: Record<string, GroupMemberRecord> = {};

  for (const deviceId of allDeviceIds) {
    const localMember = local.members[deviceId];
    const remoteMember = remote.members[deviceId];

    if (!localMember && remoteMember) {
      memberDelta[deviceId] = remoteMember;
      hasDelta = true;
    } else if (localMember && remoteMember) {
      if (
        localMember.displayName !== remoteMember.displayName ||
        compareHybridTimestamp(localMember.profileStamp, remoteMember.profileStamp) !== 0
      ) {
        memberDelta[deviceId] = remoteMember;
        hasDelta = true;
      }
    }
    // If local has a member that remote doesn't, no delta needed for that member
  }

  if (Object.keys(memberDelta).length > 0) {
    delta.members = memberDelta;
  }

  return hasDelta ? delta : null;
}

/**
 * Apply a partial delta to a local GroupSharedState, returning a new state.
 */
export function applyGroupStateDelta(
  local: GroupSharedState,
  delta: Partial<GroupSharedState>,
): GroupSharedState {
  const state: GroupSharedState = {
    schemaVersion: 1,
    groupId: delta.groupId ?? local.groupId,
    name: delta.name ?? { ...local.name },
    defaultQuality: delta.defaultQuality ?? { ...local.defaultQuality },
    members: { ...local.members },
  };

  // Merge member deltas
  if (delta.members) {
    for (const [deviceId, member] of Object.entries(delta.members)) {
      state.members[deviceId] = member;
    }
  }

  return state;
}
