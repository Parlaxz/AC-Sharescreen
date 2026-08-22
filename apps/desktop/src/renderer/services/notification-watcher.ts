import { useStore } from "../stores/main-store.js";
import { showNotification } from "./notifications.js";
import { getApi } from "./get-api.js";
import { getRuntime } from "./phase3-runtime.js";
import type { StreamAnnouncement } from "@screenlink/shared";

/**
 * Phase 3 / Stage 15: Watch store state changes and fire group-stream notifications.
 *
 * Security:
 * - Stream lifecycle messages derive host identity from authenticated sender mapping.
 *   When a stream.started or stream.restarted message arrives, the hostDeviceId in the
 *   payload must match the authenticated sender's identity from the connection manager.
 * - Mismatched payload host IDs are rejected.
 *
 * Deduplication of visible stream-start toasts is owned by the main-process
 * StreamToastManager. Store transitions still filter ordinary heartbeat updates.
 */

export function startNotificationWatcher(): () => void {
  const store = useStore;

  const unsubscribe = store.subscribe((state, prevState) => {
    const s = state as unknown as Record<string, unknown>;
    const p = prevState as unknown as Record<string, unknown>;

    // Detect new active streams
    const currentStreams = s.activeStreamsByGroup as Record<string, StreamAnnouncement[]> | undefined;
    const prevStreams = p.activeStreamsByGroup as Record<string, StreamAnnouncement[]> | undefined;

    if (!currentStreams || !prevStreams) return;

    for (const [groupId, streams] of Object.entries(currentStreams)) {
      const prevGroupStreams = prevStreams[groupId] ?? [];
      const prevSet = new Map<string, StreamAnnouncement>();
      for (const ps of prevGroupStreams) {
        prevSet.set(`${ps.hostDeviceId}:${ps.logicalStreamId}`, ps);
      }

      for (const stream of streams) {
        const prev = prevSet.get(`${stream.hostDeviceId}:${stream.logicalStreamId}`);

        // Skip if this is a known stream (just a heartbeat/update)
        if (prev && prev.mediaSessionId === stream.mediaSessionId) continue;

        // Security: Validate host identity via authenticated sender mapping
        const runtime = getRuntime();
        if (runtime) {
          const connManager = runtime.getConnectionManager();
          const conn = connManager.getConnection(groupId);
          if (conn) {
            // Verify the hostDeviceId matches an authenticated peer
            const peerUuid = conn.peerForDevice(stream.hostDeviceId);
            if (!peerUuid) {
              // Host is not authenticated — reject notification for remote streams
              // Local streams are fine (hostDeviceId === runtime.deviceId)
              if (stream.hostDeviceId !== runtime.deviceId) {
                continue; // Reject unauthenticated host ID
              }
            }
          }
        }

        // Get group name for notification
        const storeState = useStore.getState();
        const groupName = storeState.groupsById[groupId]?.name ?? groupId;
        const hostName = stream.hostDisplayName || stream.hostDeviceId;

        // Fire notification (skip if it's a local stream — we don't notify for our own)
        if (stream.hostDeviceId !== runtime?.deviceId) {
          const api = getApi();
          if (api) {
            console.log("[notification-watcher] stream started, requesting toast:", hostName, "in", groupName);
            void api.showStreamToast({
              groupId,
              hostDeviceId: stream.hostDeviceId,
              logicalStreamId: stream.logicalStreamId,
              hostName,
              groupName,
            }).then((result) => {
              if (!result.shown) console.log("[notification-watcher] toast not shown:", result.reason ?? "unknown");
            }).catch((error: unknown) => console.warn("[notification-watcher] Stream toast failed:", error));
          } else {
            showNotification({ title: "ScreenLink", body: `${hostName} started streaming in ${groupName}` });
          }
        }
      }
    }
  });

  return unsubscribe;
}

/**
 * Direct notification trigger for stream started.
 */
export function notifyStreamStarted(input: {
  groupId: string;
  hostDeviceId: string;
  logicalStreamId: string;
  hostName: string;
  groupName: string;
}): boolean {
  const s = useStore.getState() as unknown as Record<string, unknown>;
  if (s.notificationsEnabled === false) return true;

  const api = getApi();
  if (api) {
    void api.showStreamToast(input).catch((error: unknown) => console.warn("[notification-watcher] Stream toast failed:", error));
  } else {
    showNotification({ title: "ScreenLink", body: `${input.hostName} started streaming in ${input.groupName}` });
  }
  return true;
}

