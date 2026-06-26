import type { GroupSharedState, HybridTimestamp } from "@screenlink/shared";
import type { ScreenLinkAPI } from "../../preload/api-types.js";
import { useStore } from "../stores/main-store.js";
import { useIdentityStore } from "../stores/identity-store.js";
import type { SyncPersistenceAdapter } from "./group-sync-service.js";
import { acquirePhase3Runtime } from "./phase3-runtime.js";

export async function initializeAppRuntime(
  api: ScreenLinkAPI,
  shouldAbort: () => boolean = () => false,
): Promise<void> {
  const persistence: SyncPersistenceAdapter = {
    persistState: (groupId: string, state: GroupSharedState) =>
      api.updateGroupSharedState(groupId, state) as Promise<void>,
    persistClock: (groupId: string, clock: HybridTimestamp) =>
      api.updateGroupClock(groupId, clock) as Promise<void>,
  };

  const identity = await api.getDeviceIdentity();
  if (!identity) {
    console.warn("[App] Device identity unavailable – skipping runtime startup");
    return;
  }

  useIdentityStore.getState().setLocalIdentity({
    deviceId: identity.deviceId,
    displayName: identity.displayName,
  });

  const runtime = await acquirePhase3Runtime(persistence);
  const records = (await api.listGroups()) as Array<{
    groupId: string;
    sharedState: GroupSharedState;
    lastClock: HybridTimestamp;
  }>;

  if (shouldAbort()) {
    return;
  }

  const store = useStore.getState();
  const groupsById: Record<string, { id: string; name: string; members: Record<string, { deviceId: string; displayName: string }> }> = {};
  const groupOrder: string[] = [];
  for (const record of records) {
    if (shouldAbort()) {
      return;
    }

    groupsById[record.groupId] = {
      id: record.groupId,
      name: record.sharedState.name.value,
      members: Object.fromEntries(
        Object.entries(record.sharedState.members).map(([key, value]) => [
          key,
          { deviceId: value.deviceId, displayName: value.displayName },
        ]),
      ),
    };
    if (!groupOrder.includes(record.groupId)) {
      groupOrder.push(record.groupId);
    }
  }
  store.setGroups(groupsById, groupOrder);

  if (!store.selectedGroupId && groupOrder.length > 0) {
    store.setSelectedGroupId(groupOrder[0]);
  }

  for (const record of records) {
    if (shouldAbort()) {
      return;
    }

    try {
      const config = (await api.getGroupConnectionConfig(record.groupId)) as {
        groupId: string;
        controlRoomId: string;
        groupSecret: string;
        nodeId: string;
      } | null;
      if (config) {
        await runtime.addGroup(
          {
            groupId: config.groupId,
            controlRoomId: config.controlRoomId,
            groupSecret: config.groupSecret,
            nodeId: identity.deviceId,
            displayName: identity.displayName,
          },
          record.sharedState,
          record.lastClock,
        );
      }
    } catch (err) {
      console.warn(`[App] Failed to initialize group ${record.groupId}:`, err);
    }
  }
}
