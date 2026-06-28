import { useStore } from "../stores/main-store.js";
import { getRuntime } from "./phase3-runtime.js";

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
