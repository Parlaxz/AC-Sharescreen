import type {
  GroupSharedState,
  GroupMemberRecord,
  HybridTimestamp,
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
  makeLww,
  canonicalJsonHash,
  createDefaultGroupQualitySettings,
  compareHybridTimestamp,
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
  clock: HybridTimestamp;
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

  initializeGroup(
    groupId: string,
    initialState: GroupSharedState,
    persistedStamp: HybridTimestamp | undefined,
    localDeviceId: string,
    localDisplayName: string,
  ): void {
    const clock = createHybridClock(localDeviceId, persistedStamp);

    // If the local device is not yet in the member records, add it
    if (!initialState.members[localDeviceId]) {
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
      clock: clock as unknown as HybridTimestamp,
      lastSyncAt: Date.now(),
      isSynchronized: true,
    });

    this.startAntiEntropy(groupId);
  }

  removeGroup(groupId: string): void {
    this.syncStates.delete(groupId);
    this.stopAntiEntropy(groupId);
  }

  async performLocalEdit(
    groupId: string,
    updater: (state: GroupSharedState) => Partial<GroupSharedState>,
  ): Promise<void> {
    const sync = this.syncStates.get(groupId);
    if (!sync) return;

    const now = Date.now();
    const localTick = tickLocal(sync.clock as any, now);
    sync.clock = mergeRemote(sync.clock as any, localTick, now) as unknown as HybridTimestamp;

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
    const stamp = tickLocal(sync.clock as any, now);

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
    sync.clock = mergeRemote(sync.clock as any, stamp, now) as unknown as HybridTimestamp;

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
      const remoteState = envelope.payload?.state as Partial<GroupSharedState> | undefined;
      if (!remoteState) return;

      // Apply remote state update
      try {
        const oldState = sync.state;
        const result = mergeGroupSharedState(oldState, remoteState as GroupSharedState);
        if (result.changed) {
          // Advance clock past remote stamp (B6)
          if (logicalStamp) {
            sync.clock = mergeRemote(sync.clock as any, logicalStamp, now) as unknown as HybridTimestamp;
          }

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
          sync.clock = mergeRemote(sync.clock as any, logicalStamp, now) as unknown as HybridTimestamp;
        }
      } catch {
        // Ignore invalid state updates
      }
    }

    if (type === "group.state.summary") {
      const summary = envelope.payload?.summary as GroupStateSummary | undefined;
      if (!summary) return;
      const conn = this.connManager.getConnection(groupId);
      if (!conn) return;

      // Compare lightweight summary fields
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
      const memberRecord = envelope.payload?.member as GroupMemberRecord | undefined;
      if (!memberRecord || !memberRecord.deviceId) return;

      const existing = sync.state.members[memberRecord.deviceId];
      if (!existing || memberRecord.profileStamp.wallTimeMs > existing.profileStamp.wallTimeMs) {
        sync.state = applyGroupStateDelta(sync.state, {
          members: { [memberRecord.deviceId]: memberRecord },
        });
        sync.lastSyncAt = now;
        this.onStateUpdated?.(groupId, sync.state);
      }
    }
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
    sync.lastSyncAt = Date.now();
    const conn = this.connManager.getConnection(groupId);
    if (conn && conn.state === "connected") {
      const memberVersions: Record<string, { profileStamp: HybridTimestamp; displayName: string }> = {};
      for (const [deviceId, member] of Object.entries(sync.state.members)) {
        memberVersions[deviceId] = {
          profileStamp: member.profileStamp,
          displayName: member.displayName,
        };
      }
      const summary: GroupStateSummary = {
        groupId,
        nameStamp: sync.state.name.stamp,
        nameHash: sync.state.name.valueHash,
        qualityStamp: sync.state.defaultQuality.stamp,
        qualityHash: sync.state.defaultQuality.valueHash,
        memberVersions,
        stateHash: sync.state.name.valueHash,
      };
      await conn.broadcast({
        type: "group.state.summary",
        summary,
      });
    }
  }
}
