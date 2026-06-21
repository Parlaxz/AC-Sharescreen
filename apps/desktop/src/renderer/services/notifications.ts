/**
 * Desktop notification helper for ScreenLink.
 * Uses Electron's Notification API through the renderer.
 *
 * In Electron with contextIsolation, the Notification API is available
 * in the renderer process and creates native Windows notifications.
 */

interface NotificationOptions {
  title: string;
  body: string;
  onClick?: () => void;
  silent?: boolean;
}

const recentNotifications = new Set<string>();
const DEDUP_WINDOW_MS = 30_000; // 30 seconds

/**
 * Show a native Windows notification.
 * Deduplicates identical notifications within a 30-second window.
 */
export function showNotification(options: NotificationOptions): void {
  const key = `${options.title}|${options.body}`;
  const now = Date.now();

  // Dedup
  if (recentNotifications.has(key)) return;
  recentNotifications.add(key);
  setTimeout(() => recentNotifications.delete(key), DEDUP_WINDOW_MS);

  try {
    if (!("Notification" in window)) {
      console.warn("[Notifications] Not supported in this environment");
      return;
    }

    if (Notification.permission === "denied") return;

    if (Notification.permission === "default") {
      Notification.requestPermission().then(permission => {
        if (permission === "granted") {
          createNotification(options);
        }
      });
      return;
    }

    createNotification(options);
  } catch (err) {
    console.warn("[Notifications] Failed to show notification:", err);
  }
}

function createNotification(options: NotificationOptions): void {
  const notification = new Notification(options.title, {
    body: options.body,
    silent: options.silent ?? false,
    icon: undefined, // Electron will use the app icon
  });

  if (options.onClick) {
    notification.onclick = () => {
      options.onClick!();
      notification.close();
    };
  }

  // Auto-close after 10 seconds
  setTimeout(() => notification.close(), 10000);
}
