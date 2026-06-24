import { useStore } from "../stores/main-store.js";
import { showNotification } from "./notifications.js";

/**
 * Phase 3: Watch store state changes and fire group-stream notifications.
 *
 * Notifies when a remote device in a known group starts a stream. The dedup
 * key is groupId + hostDeviceId + logicalStreamId. Already-known streams,
 * heartbeats, and stream-restart replacements do not re-notify.
 */
export function startNotificationWatcher(): () => void {
  const store = useStore;
  const seenStreams = new Set<string>();

  const unsubscribe = store.subscribe((state, prevState) => {
    const s = state as Record<string, unknown>;
    const p = prevState as Record<string, unknown>;

    // Friend came online — deprecated; do nothing in Phase 3.

    // Stream notifications handled by active-streams subscription.
    // For now this is a no-op while active-stream registry is wired up.
    void s;
    void p;
    void seenStreams;
  });

  return unsubscribe;
}

export function notifyStreamStarted(input: {
  groupId: string;
  hostDeviceId: string;
  logicalStreamId: string;
  hostName: string;
  groupName: string;
}): boolean {
  const key = `${input.groupId}:${input.hostDeviceId}:${input.logicalStreamId}`;
  // De-dupe at module level
  if ((startNotificationWatcher as unknown as Record<string, Set<string>>)["__seen"]) {
    const seen = (startNotificationWatcher as unknown as Record<string, Set<string>>)["__seen"] as Set<string>;
    if (seen.has(key)) return false;
    seen.add(key);
  } else {
    const seen = new Set<string>();
    seen.add(key);
    (startNotificationWatcher as unknown as Record<string, Set<string>>)["__seen"] = seen;
  }
  const s = useStore.getState() as Record<string, unknown>;
  if (s.notificationsEnabled === false) return true;
  showNotification({
    title: "ScreenLink",
    body: `${input.hostName} started streaming in ${input.groupName}`,
  });
  return true;
}
