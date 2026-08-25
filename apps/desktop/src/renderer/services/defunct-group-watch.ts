import type { Phase3Runtime } from "./phase3-runtime.js";
import { detachGroupFromRuntime } from "./group-record-helper.js";
import { getApi } from "./get-api.js";
import { showNotification } from "./notifications.js";

/**
 * Defunct-group watcher (GRP-011 sole-survivor case).
 *
 * When a joiner relaunches into a group whose creator and every other member
 * are gone, the group is defunct: the connection reports "connected" but no
 * peers ever appear. Without intervention the joiner keeps a ghost group
 * forever. The watcher polls briefly after startup and dissolves the group
 * (announce leave + remove persisted record + detach runtime) when it stays
 * peerless.
 *
 * Creators never self-dissolve: they are the authoritative origin of the
 * group record and may simply be offline while others still hold the invite.
 */

const attemptedGroups = new Set<string>();

const POLL_INTERVAL_MS = 2000;
const MAX_TICKS = 10;

export function watchGroupForDefunct(
  runtime: Phase3Runtime,
  groupId: string,
  info: { selfDeviceId: string; creatorDeviceId?: string | null },
): void {
  // Once per app launch per group — repeated addGroup calls must not stack watchers.
  if (attemptedGroups.has(groupId)) return;
  attemptedGroups.add(groupId);

  let ticks = 0;
  let consecutiveHits = 0;

  const timer = setInterval(() => {
    ticks++;

    // Group removed elsewhere — abort quietly.
    const conn = runtime.getConnectionManager().getConnection(groupId);
    if (!conn) {
      clearInterval(timer);
      return;
    }

    if (ticks >= MAX_TICKS) {
      clearInterval(timer);
      return;
    }

    const eligible =
      conn.state === "connected" &&
      conn.connectedPeers.length === 0 &&
      conn.rawDataPeerUuids.length === 0 &&
      hasOtherMembers(runtime, groupId, info.selfDeviceId) &&
      // Joiners have undefined creatorDeviceId ⇒ eligible; creators never self-dissolve.
      (info.creatorDeviceId == null || info.creatorDeviceId !== info.selfDeviceId) &&
      runtime.getActiveStreamRegistry().getStreamsByGroup(groupId).length === 0;

    // Two consecutive qualifying ticks: route flaps on cold start, so a
    // single quiet moment is not proof of defunctness.
    if (!eligible) {
      consecutiveHits = 0;
      return;
    }
    consecutiveHits++;
    if (consecutiveHits < 2) return;

    clearInterval(timer);
    void dissolve(runtime, groupId);
  }, POLL_INTERVAL_MS);

  async function dissolve(rt: Phase3Runtime, gid: string): Promise<void> {
    console.warn(`[defunct-group-watch] Group ${gid} appears defunct (no reachable members); dissolving`);
    try {
      await rt.getSyncService().announceLocalLeave(gid);
    } catch {
      // best-effort; peers may all be gone anyway
    }

    const api = getApi();
    if (api && typeof api.leaveGroup === "function") {
      try {
        await api.leaveGroup(gid);
      } catch {
        // fall through to local detach so the UI never keeps a ghost group
      }
    }
    await detachGroupFromRuntime(gid);

    const syncState = rt.getSyncService().getSyncState(gid);
    const groupName = syncState?.state.name.value ?? gid;
    showNotification({
      title: "ScreenLink",
      body: `"${groupName}" was removed because no other members could be reached.`,
    });
  }
}

/**
 * True when the stored member set records at least one OTHER device — alive
 * or tombstoned. This is the GRP-011 shape: a joiner holding membership for
 * peers that are demonstrably unreachable (empty room, zero raw peers across
 * the poll budget). Tombstoned-only rosters are subsumed by this check.
 */
function hasOtherMembers(
  runtime: Phase3Runtime,
  groupId: string,
  selfDeviceId: string,
): boolean {
  const sync = runtime.getSyncService().getSyncState(groupId);
  if (!sync) return false;
  return Object.values(sync.state.members).some((m) => m.deviceId !== selfDeviceId);
}
