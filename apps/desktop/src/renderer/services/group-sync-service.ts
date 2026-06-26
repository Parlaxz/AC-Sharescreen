import type {
  GroupSharedState,
  GroupMemberRecord,
  HybridTimestamp,
  HybridClock,
  GroupControlEnvelope,
  LwwRegister,
  GroupQualitySettings,
} from "@screenlink/shared";
import {
  mergeGroupSharedState,
  getGroupStateDelta,
  applyGroupStateDelta,
  createHybridClock,
  tickLocal,
  mergeRemote,
  canonicalJsonHash,
  createDefaultGroupQualitySettings,
  compareHybridTimestamp,
  parseGroupMessagePayload,
} from "@screenlink/shared";
import type { GroupConnectionManager } from "./group-connection-manager.js";

export interface SyncPersistenceAdapter {
  persistState: (groupId: string, state: GroupSharedState) => Promise<void>;
  persistClock: (groupId: string, clock: HybridTimestamp) => Promise<void>;
}

export interface GroupStateSummary {
  groupId: string;
  nameStamp: HybridTimestamp | null;
  nameHash: string | null;
  qualityStamp: HybridTimestamp | null;
  qualityHash: string | null;
  memberVersions: Record<string, { profileStamp: HybridTimestamp; displayName: string }>;
  stateHash: string;
}

export interface SyncState {
  groupId: string;
  state: GroupSharedState;
  clock: HybridClock;
  lastSyncAt: number;
  isSynchronized: boolean;
}

export class GroupSyncService {
  private syncStates = new Map<string, SyncState>();
  private antiEntropyTimers = new Map<string, ReturnType<typeof setInterval>>();
  private connManager: GroupConnectionManager;
  private onStateUpdated: ((groupId: string, state: GroupSharedState) => void) | null = null;
  private persistence: SyncPersistenceAdapter | undefined;

  constructor(connManager: GroupConnectionManager, persistence?: SyncPersistenceAdapter) {
    this.connManager = connManager;
    this.persistence = persistence;
    // NOTE: Message registration is now handled by GroupMessageRouter (C1).
    // GroupMessageRouter calls handleGroupMessage() for group.state.* messages.
  }

  setOnStateUpdated(cb: (groupId: string, state: GroupSharedState) => void): void {
    this.onStateUpdated = cb;
  }

  getSyncState(groupId: string): SyncState | null {
    return this.syncStates.get(groupId) ?? null;
  }

  async initializeGroup(
    groupId: string,
    initialState: GroupSharedState,
    persistedStamp: HybridTimestamp | undefined,
    localDeviceId: string,
    localDisplayName: string,
  ): Promise<void> {
    const clock = createHybridClock(localDeviceId, persistedStamp);
    let memberInserted = false;

    // If the local device is not yet in the member records, add it
    if (!initialState.members[localDeviceId]) {
      memberInserted = true;
      const stamp = tickLocal(clock);
      initialState = {
        ...initialState,
        members: {
          ...initialState.members,
          [localDeviceId]: {
            deviceId: localDeviceId,
            displayName: localDisplayName,
            firstSeenAt: Date.now(),
            profileStamp: stamp,
          },
        },
      };
    }

    this.syncStates.set(groupId, {
      groupId,
      state: initialState,
      clock,
      lastSyncAt: Date.now(),
      isSynchronized: true,
    });

    // Persist the updated state and clock when a local member was freshly
    // inserted, completing BEFORE the caller starts the connection (B5).
    if (this.persistence && memberInserted) {
      await this.persistence.persistState(groupId, initialState);
      await this.persistence.persistClock(groupId, clock);
    }

    // Always publish the resulting state to the renderer store so the
    // membership view reflects the local member even when the local
    // device was already present in the persisted state. Two-PC sync
    // requires the local view to be authoritative from the first frame.
    this.onStateUpdated?.(groupId, initialState);

    this.startAntiEntropy(groupId);
  }

  removeGroup(groupId: string): void {
    this.syncStates.delete(groupId);
    this.stopAntiEntropy(groupId);
  }

  /**
   * Local edits return a *value delta* — only the value field is
   * required. The service fills in the stamp, hash, and updatedBy
   * metadata so callers cannot accidentally supply stale stamps.
   */
  async performLocalEdit(
    groupId: string,
    updater: (state: GroupSharedState) => {
      name?: { value: string };
      defaultQuality?: { value: GroupQualitySettings };
      members?: Record<string, GroupMemberRecord>;
    },
  ): Promise<void> {
    const sync = this.syncStates.get(groupId);
    if (!sync) return;

    const now = Date.now();
    // Exactly one HLC tick per local edit (no mergeRemote)
    const localTick = tickLocal(sync.clock, now);

    const delta = updater(sync.state);
    const patches: Partial<GroupSharedState> = {};

    if (delta.name !== undefined) {
      patches.name = { value: delta.name.value, stamp: localTick, valueHash: await canonicalJsonHash(delta.name.value), updatedByDeviceId: sync.clock.nodeId } as LwwRegister<string>;
    }
    if (delta.defaultQuality !== undefined) {
      patches.defaultQuality = { value: delta.defaultQuality.value, stamp: localTick, valueHash: await canonicalJsonHash(delta.defaultQuality.value), updatedByDeviceId: sync.clock.nodeId } as LwwRegister<GroupQualitySettings>;
    }
    if (delta.members !== undefined) {
      patches.members = delta.members;
    }

    const newState = applyGroupStateDelta(sync.state, patches);

    // Persist before broadcasting
    if (this.persistence) {
      await this.persistence.persistState(groupId, newState);
      await this.persistence.persistClock(groupId, sync.clock);
    }

    sync.state = newState;
    sync.lastSyncAt = now;

    this.onStateUpdated?.(groupId, newState);

    // Broadcast the delta
    await this.broadcastDelta(groupId, patches, localTick);
  }

  async updateDisplayName(groupId: string, newDisplayName: string): Promise<void> {
    const sync = this.syncStates.get(groupId);
    if (!sync) return;
    const nodeId = sync.clock.nodeId;
    const now = Date.now();
    // Exactly one HLC tick per local edit (no mergeRemote)
    const stamp = tickLocal(sync.clock, now);

    const existingMember = sync.state.members[nodeId];
    const updatedMember: GroupMemberRecord = {
      deviceId: nodeId,
      displayName: newDisplayName,
      firstSeenAt: existingMember?.firstSeenAt ?? now,
      profileStamp: stamp,
    };

    const newState = applyGroupStateDelta(sync.state, {
      members: { [nodeId]: updatedMember },
    });

    // Persist before broadcasting
    if (this.persistence) {
      await this.persistence.persistState(groupId, newState);
      await this.persistence.persistClock(groupId, sync.clock);
    }

    sync.state = newState;
    sync.lastSyncAt = now;

    this.onStateUpdated?.(groupId, newState);
    await this.broadcastDelta(
      groupId,
      { members: { [nodeId]: updatedMember } },
      stamp,
    );
  }

  destroy(): void {
    for (const gid of this.syncStates.keys()) {
      this.stopAntiEntropy(gid);
    }
    this.syncStates.clear();
  }

  // ── Public ───────────────────────────────────────────────────

  /**
   * Handles a group control message dispatched by GroupMessageRouter.
   * Processes group.state.*, group.member.update, and related messages.
   */
  async handleGroupMessage(groupId: string, envelope: GroupControlEnvelope): Promise<void> {
    const sync = this.syncStates.get(groupId);
    if (!sync) return;

    const type = envelope.type;
    const logicalStamp = envelope.logicalStamp;
    const now = Date.now();

    if (type === "group.state.update") {
      // ── Schema validation (typed via GroupControlPayloadMap) ──────
      const parsed = parseGroupMessagePayload("group.state.update", envelope.payload);
      if (!parsed.ok) return;
      const partialState = parsed.data.state as Partial<GroupSharedState> | undefined;
      if (!partialState) return;

      // Build a full GroupSharedState from the partial + local fallbacks
      const remoteState: GroupSharedState = {
        schemaVersion: 1,
        groupId: partialState.groupId ?? sync.state.groupId,
        name: partialState.name ?? sync.state.name,
        defaultQuality: partialState.defaultQuality ?? sync.state.defaultQuality,
        members: partialState.members ?? sync.state.members,
      };

      // Apply remote state update using mergeGroupSharedState
      try {
        const oldState = sync.state;
        const result = mergeGroupSharedState(oldState, remoteState);
        if (result.changed) {
          // Advance clock past envelope logical stamp and all nested timestamps (B6)
          // Find max timestamp across name, defaultQuality, and members
          let maxNestedStamp = logicalStamp;
          if (partialState.name?.stamp && compareHybridTimestamp(partialState.name.stamp, maxNestedStamp) > 0) {
            maxNestedStamp = partialState.name.stamp;
          }
          if (partialState.defaultQuality?.stamp && compareHybridTimestamp(partialState.defaultQuality.stamp, maxNestedStamp) > 0) {
            maxNestedStamp = partialState.defaultQuality.stamp;
          }
          if (partialState.members) {
            for (const m of Object.values(partialState.members)) {
              const member = m as GroupMemberRecord;
              if (member.profileStamp && compareHybridTimestamp(member.profileStamp, maxNestedStamp) > 0) {
                maxNestedStamp = member.profileStamp;
              }
            }
          }

          mergeRemote(sync.clock, maxNestedStamp, now);

          // Persist (B5)
          if (this.persistence) {
            await this.persistence.persistState(groupId, result.state);
            await this.persistence.persistClock(groupId, sync.clock);
          }

          sync.state = result.state;
          sync.lastSyncAt = now;
          this.onStateUpdated?.(groupId, sync.state);

          // Rebroadcast delta from old state to merged result (B8)
          const conn = this.connManager.getConnection(groupId);
          if (conn) {
            const delta = getGroupStateDelta(oldState, result.state);
            if (delta) {
              await conn.broadcast({
                type: "group.state.update",
                state: delta,
              });
            }
          }
        } else if (logicalStamp) {
          // Even if nothing changed, advance clock to stay monotonic
          mergeRemote(sync.clock, logicalStamp, now);
          if (this.persistence) {
            await this.persistence.persistClock(groupId, sync.clock);
          }
        }
      } catch {
        // Ignore invalid state updates
      }
    }

    if (type === "group.state.summary") {
      // ── Schema validation (typed via GroupControlPayloadMap) ──────
      const parsed = parseGroupMessagePayload("group.state.summary", envelope.payload);
      if (!parsed.ok) return;
      const summary = parsed.data.summary;
      if (!summary) return;

      const conn = this.connManager.getConnection(groupId);
      if (!conn) return;

      // Compare lightweight summary fields (typed via GroupStateSummarySchema)
      let needsFullSync = false;
      const ourState = sync.state;

      if (summary.nameStamp && summary.nameHash) {
        const nameCmp = compareHybridTimestamp(summary.nameStamp, ourState.name.stamp);
        if (nameCmp > 0) {
          needsFullSync = true;
        } else if (nameCmp === 0 && summary.nameHash !== ourState.name.valueHash) {
          needsFullSync = true;
        }
      }

      if (!needsFullSync && summary.qualityStamp && summary.qualityHash) {
        const qualityCmp = compareHybridTimestamp(summary.qualityStamp, ourState.defaultQuality.stamp);
        if (qualityCmp > 0) {
          needsFullSync = true;
        } else if (qualityCmp === 0 && summary.qualityHash !== ourState.defaultQuality.valueHash) {
          needsFullSync = true;
        }
      }

      if (!needsFullSync && summary.memberVersions) {
        for (const [deviceId, remoteVer] of Object.entries(summary.memberVersions)) {
          const localMember = ourState.members[deviceId];
          if (!localMember) {
            needsFullSync = true;
            break;
          }
          const memberCmp = compareHybridTimestamp(remoteVer.profileStamp, localMember.profileStamp);
          if (memberCmp > 0) {
            needsFullSync = true;
            break;
          }
        }
      }

      if (needsFullSync) {
        const peerUuid = conn.peerForDevice(envelope.senderDeviceId);
        if (peerUuid && peerUuid.length > 0) {
          await conn.sendToPeer(peerUuid, { type: "group.state.request" });
        }
      }
    }

    if (type === "group.state.request") {
      // Respond with our full state (B15: check peer UUID is non-empty)
      const conn = this.connManager.getConnection(groupId);
      if (conn) {
        const peerUuid = conn.peerForDevice(envelope.senderDeviceId);
        if (peerUuid && peerUuid.length > 0) {
          await conn.sendToPeer(peerUuid, {
            type: "group.state.update",
            state: sync.state,
          });
        }
      }
    }

    if (type === "group.member.update") {
      // ── Schema validation (typed via GroupControlPayloadMap) ──────
      const parsed = parseGroupMessagePayload("group.member.update", envelope.payload);
      if (!parsed.ok) return;
      const memberRecord = parsed.data.member;

      // ── Sender authenticity check ─────────────────────────────────
      if (memberRecord.deviceId !== envelope.senderDeviceId) return;

      const existing = sync.state.members[memberRecord.deviceId];
      if (!existing) {
        // New member — always accept
        mergeRemote(sync.clock, memberRecord.profileStamp, now);
        sync.state = applyGroupStateDelta(sync.state, {
          members: { [memberRecord.deviceId]: memberRecord },
        });

        // Persist
        if (this.persistence) {
          await this.persistence.persistState(groupId, sync.state);
          await this.persistence.persistClock(groupId, sync.clock);
        }
        sync.lastSyncAt = now;
        this.onStateUpdated?.(groupId, sync.state);

        // Rebroadcast accepted delta once
        await this.broadcastDelta(
          groupId,
          { members: { [memberRecord.deviceId]: memberRecord } },
          memberRecord.profileStamp,
        );
      } else {
        // Compare logical time only (wallTimeMs + counter), ignoring nodeId.
        // This matches the compareLogicalTime logic in mergeGroupSharedState.
        const logicalCmp = this.compareLogicalTimeOnly(memberRecord.profileStamp, existing.profileStamp);
        if (logicalCmp > 0) {
          // Remote is strictly newer — accept
          mergeRemote(sync.clock, memberRecord.profileStamp, now);
          sync.state = applyGroupStateDelta(sync.state, {
            members: { [memberRecord.deviceId]: memberRecord },
          });

          // Persist
          if (this.persistence) {
            await this.persistence.persistState(groupId, sync.state);
            await this.persistence.persistClock(groupId, sync.clock);
          }
          sync.lastSyncAt = now;
          this.onStateUpdated?.(groupId, sync.state);

          // Rebroadcast accepted delta once
          await this.broadcastDelta(
            groupId,
            { members: { [memberRecord.deviceId]: memberRecord } },
            memberRecord.profileStamp,
          );
        } else if (logicalCmp === 0 && memberRecord.displayName !== existing.displayName) {
          // Equal logical time, different value — deterministic tiebreaker
          // Lower nodeId wins (same rule as mergeGroupSharedState)
          if (memberRecord.profileStamp.nodeId < existing.profileStamp.nodeId) {
            mergeRemote(sync.clock, memberRecord.profileStamp, now);
            sync.state = applyGroupStateDelta(sync.state, {
              members: { [memberRecord.deviceId]: memberRecord },
            });

            if (this.persistence) {
              await this.persistence.persistState(groupId, sync.state);
              await this.persistence.persistClock(groupId, sync.clock);
            }
            sync.lastSyncAt = now;
            this.onStateUpdated?.(groupId, sync.state);

            await this.broadcastDelta(
              groupId,
              { members: { [memberRecord.deviceId]: memberRecord } },
              memberRecord.profileStamp,
            );
          }
        }
        // logicalCmp < 0: local is newer — ignore
      }
    }
  }

  /**
   * Compare two timestamps by logical time only (wallTimeMs + counter),
   * ignoring nodeId. Returns -1, 0, or 1. This matches the internal
   * compareLogicalTime used by mergeGroupSharedState in groups.ts.
   */
  private compareLogicalTimeOnly(
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

  private async broadcastDelta(
    groupId: string,
    delta: Partial<GroupSharedState>,
    stamp: HybridTimestamp,
  ): Promise<void> {
    const conn = this.connManager.getConnection(groupId);
    if (!conn) return;

    // Include full state for simplicity in this iteration
    await conn.broadcast({
      type: "group.state.update",
      state: delta,
      stamp,
    });
  }

  private startAntiEntropy(groupId: string): void {
    this.stopAntiEntropy(groupId);
    const timer = setInterval(() => {
      void this.runAntiEntropy(groupId);
    }, 30_000);
    this.antiEntropyTimers.set(groupId, timer);
  }

  private stopAntiEntropy(groupId: string): void {
    const timer = this.antiEntropyTimers.get(groupId);
    if (timer) {
      clearInterval(timer);
      this.antiEntropyTimers.delete(groupId);
    }
  }

  private async runAntiEntropy(groupId: string): Promise<void> {
    const sync = this.syncStates.get(groupId);
    if (!sync) return;
    const now = Date.now();
    sync.lastSyncAt = now;
    const conn = this.connManager.getConnection(groupId);
    if (conn && conn.state === "connected") {
      const memberVersions: Record<string, { profileStamp: HybridTimestamp; displayName: string }> = {};
      for (const [deviceId, member] of Object.entries(sync.state.members)) {
        memberVersions[deviceId] = {
          profileStamp: member.profileStamp,
          displayName: member.displayName,
        };
      }
      // Compute hash of complete canonical shared state (not just nameHash)
      const stateHash = await canonicalJsonHash(sync.state);
      const summary: GroupStateSummary = {
        groupId,
        nameStamp: sync.state.name.stamp,
        nameHash: sync.state.name.valueHash,
        qualityStamp: sync.state.defaultQuality.stamp,
        qualityHash: sync.state.defaultQuality.valueHash,
        memberVersions,
        stateHash,
      };
      await conn.broadcast({
        type: "group.state.summary",
        summary,
      });
    }
  }
}
