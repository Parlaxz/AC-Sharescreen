import { useStore } from "../stores/main-store.js";
import { getRuntime } from "./phase3-runtime.js";
import type { StreamAnnouncement } from "@screenlink/shared";

export function startViewingStream(stream: StreamAnnouncement): void {
  const state = useStore.getState();
  state.setWatchingTarget({
    groupId: stream.groupId,
    logicalStreamId: stream.logicalStreamId,
    mediaSessionId: stream.mediaSessionId,
    hostDeviceId: stream.hostDeviceId,
    hostName: stream.hostDisplayName,
    startedAt: stream.startedAt,
    sourceName: stream.sourceName,
    sourceKind: stream.sourceKind,
  });
  state.setIsViewing(true);
  state.setViewStatus("connecting");
  state.navigate("viewer");
}

export function navigateToGroupOverview(): void {
  const state = useStore.getState();
  state.navigate("overview");
  const groupId = state.selectedGroupId;
  if (groupId) {
    const runtime = getRuntime();
    if (runtime) {
      void runtime.requestGroupSync(groupId);
    }
  }
}
