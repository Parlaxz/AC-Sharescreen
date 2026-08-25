import { parseGroupInviteLink } from "@screenlink/shared";
import type { ScreenLinkAPI } from "../../preload/api-types.js";
import { joinGroupAction } from "./group-actions.js";

let busy = false;
const handled = new Set<string>();

/**
 * Validate and act on one deep-link URL. Malformed links are ignored with a
 * warning (no dialogs, no side effects). Duplicate deliveries (push + pull)
 * and concurrent joins are collapsed.
 */
export async function processDeepLinkJoin(url: string): Promise<void> {
  if (busy || handled.has(url)) return;
  const invite = parseGroupInviteLink(url);
  if (!invite) {
    console.warn("[DeepLink] Ignoring URL that is not a valid group invite");
    handled.add(url);
    return;
  }
  busy = true;
  handled.add(url);
  try {
    await joinGroupAction(url);
  } catch (err) {
    console.warn("[DeepLink] Join from deep link failed:", err);
  } finally {
    busy = false;
  }
}

/** Subscribe to main-process deep-link pushes. Returns an unsubscribe fn. */
export function subscribeToDeepLinkJoins(api: ScreenLinkAPI): () => void {
  return api.onDeepLinkJoin((url) => {
    void processDeepLinkJoin(url);
  });
}
