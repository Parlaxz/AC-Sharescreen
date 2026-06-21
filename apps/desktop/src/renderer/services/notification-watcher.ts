import { useStore } from "../stores/main-store.js";
import { showNotification } from "./notifications.js";

/**
 * Watch store state changes and fire notifications as needed.
 * Call this once when the app starts. Returns an unsubscribe function.
 */
export function startNotificationWatcher(): () => void {
  const store = useStore;

  const unsubscribe = store.subscribe((state, prevState) => {
    const s = state as Record<string, unknown>;
    const p = prevState as Record<string, unknown>;

    // Friend came online
    const pairingState = s.pairingState as string;
    const prevPairing = p.pairingState as string;
    if (pairingState === "PAIRED_ONLINE" && prevPairing !== "PAIRED_ONLINE" && prevPairing !== "") {
      const friendName = (s.friendDisplayName as string) || "Friend";
      if (s.notifyWhenFriendShares) {
        showNotification({
          title: "ScreenLink",
          body: `${friendName} is now online`,
        });
      }
    }

    // Friend started sharing
    const remoteState = s.remoteShareState as string;
    const prevRemote = p.remoteShareState as string;
    if (remoteState === "remote-share-available" && prevRemote !== "remote-share-available" && prevRemote !== "") {
      const friendName = (s.friendDisplayName as string) || "Friend";
      if (s.notifyWhenFriendShares) {
        showNotification({
          title: "ScreenLink",
          body: `${friendName} started sharing their screen`,
          onClick: () => {
            // Auto-watch is handled by the store subscription
          },
        });
      }
    }

    // Friend stopped sharing
    if ((remoteState === "remote-online-idle" || remoteState === "remote-offline") &&
        prevRemote === "remote-share-available") {
      const friendName = (s.friendDisplayName as string) || "Friend";
      if (s.notifyWhenFriendShares) {
        showNotification({
          title: "ScreenLink",
          body: `${friendName} stopped sharing`,
        });
      }
    }
  });

  return unsubscribe;
}
