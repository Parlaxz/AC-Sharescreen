export const VIEWER_AUTO_KICK_MS = 15_000;

export function shouldAutoKickViewer(
  viewer: { state: "playing" | "paused" | "reconnecting" | "unknown"; lastStatusAt: number | null },
  now = Date.now(),
): boolean {
  if (viewer.state === "paused" || viewer.lastStatusAt === null) {
    return false;
  }
  return now - viewer.lastStatusAt >= VIEWER_AUTO_KICK_MS;
}

export function shouldShowViewerAfterKick(lastStatusAt: number | null, kickedAt?: number): boolean {
  if (typeof kickedAt !== "number") {
    return true;
  }
  return lastStatusAt !== null && lastStatusAt > kickedAt;
}
