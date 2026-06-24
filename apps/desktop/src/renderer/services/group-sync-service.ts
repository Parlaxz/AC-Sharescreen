import type {
  GroupSharedState,
  GroupMemberRecord,
  HybridTimestamp,
  GroupControlEnvelope,
  LwwRegister,
} from "@screenlink/shared";
import {
  mergeGroupSharedState,
  summarizeGroupSharedState,
  getGroupStateDelta,
  applyGroupStateDelta,
  createHybridClock,
  tickLocal,
  mergeRemote,
  makeLww,
  canonicalJsonHash,
  createDefaultGroupQualitySettings,
} from "@screenlink/shared";
import type { GroupConnectionManager } from "./group-connection-manager.js";

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

  constructor(connManager: GroupConnectionManager) {
    this.connManager = connManager;
    this.connManager.setOnMessage((groupId, envelope) => {
      const msg = envelope as GroupControlEnvelope;
      void this.handleMessage(groupId, msg);
    });
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
    persistedStamp?: HybridTimestamp,
  ): void {
    const nodeId = initialState.name.stamp.nodeId || "unknown";
    const clock = createHybridClock(nodeId, persistedStamp);

    // If we're the first member, add ourselves
    if (!initialState.members[nodeId] && nodeId !== "unknown") {
      const stamp = tickLocal(clock);
      initialState = {
        ...initialState,
        members: {
          ...initialState.members,
          [nodeId]: {
            deviceId: nodeId,
            displayName: nodeId,
            firstSeenAt: stamp.wallTimeMs,
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
      patches.defaultQuality = { value: delta.defaultQuality.value, stamp: localTick, valueHash: await canonicalJsonHash(delta.defaultQuality.value), updatedByDeviceId: sync.clock.nodeId } as LwwRegister<any>;
    }
    if (delta.members !== undefined) {
      patches.members = delta.members;
    }

    const newState = applyGroupStateDelta(sync.state, patches);
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

  // ── Private ──────────────────────────────────────────────────

  private async handleMessage(groupId: string, envelope: GroupControlEnvelope): Promise<void> {
    const sync = this.syncStates.get(groupId);
    if (!sync) return;

    const type = envelope.type;

    if (type === "group.state.update" || type === "group.state.summary") {
      const remoteState = envelope.payload?.state as Partial<GroupSharedState> | undefined;
      if (!remoteState) return;

      if (type === "group.state.summary") {
        // Request full state if our state is older
        const conn = this.connManager.getConnection(groupId);
        if (conn) {
          const ourStamp = sync.state.name.stamp;
          const theirStamp = remoteState.name?.stamp;
          if (theirStamp && (theirStamp.wallTimeMs > ourStamp.wallTimeMs ||
            (theirStamp.wallTimeMs === ourStamp.wallTimeMs && theirStamp.counter > ourStamp.counter))) {
            await conn.sendToPeer(
              conn.peerForDevice(envelope.senderDeviceId) ?? "",
              { type: "group.state.request" },
            );
          }
        }
      } else {
        // Apply remote state update
        try {
          const result = mergeGroupSharedState(sync.state, remoteState as GroupSharedState);
          if (result.changed) {
            sync.state = result.state;
            sync.lastSyncAt = Date.now();
            this.onStateUpdated?.(groupId, sync.state);

            // Rebroadcast to help convergence
            const conn = this.connManager.getConnection(groupId);
            if (conn) {
              const delta = getGroupStateDelta(sync.state, result.state);
              if (delta) {
                await conn.broadcast({
                  type: "group.state.update",
                  state: delta,
                });
              }
            }
          }
        } catch {
          // Ignore invalid state updates
        }
      }
    }

    if (type === "group.state.request") {
      // Respond with our full state
      const conn = this.connManager.getConnection(groupId);
      if (conn) {
        await conn.sendToPeer(
          conn.peerForDevice(envelope.senderDeviceId) ?? "",
          {
            type: "group.state.update",
            state: sync.state,
          },
        );
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
        sync.lastSyncAt = Date.now();
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
    // Broadcast a summary so others can request our state if needed
    const conn = this.connManager.getConnection(groupId);
    if (conn && conn.state === "connected") {
      await conn.broadcast({
        type: "group.state.summary",
        state: sync.state,
      });
    }
  }
}
