import { toast } from "sonner";

/**
 * One shared helper for copying a group's invite link. Uses the
 * real preload `getGroupInvite` API to obtain the link and the
 * preload `clipboardWriteText` API to place it on the OS clipboard.
 *
 * Returns `true` only when both steps succeed. The caller's UI may
 * show an actionable error or fall back to its own dialog when this
 * returns `false`.
 */
export interface InviteCopyDeps {
  getGroupInvite: (groupId: string) => Promise<{ link: string } | null>;
  clipboardWriteText: (
    text: string,
  ) => Promise<{ success: boolean; length: number }>;
}

export interface InviteCopyResult {
  success: boolean;
  link: string | null;
  error?: string;
}

/**
 * Resolve a group's invite link from the preload API and copy it
 * to the OS clipboard. Never fabricates the URL.
 */
export async function copyGroupInvite(
  groupId: string,
  deps: InviteCopyDeps,
): Promise<InviteCopyResult> {
  if (!groupId || typeof groupId !== "string") {
    return { success: false, link: null, error: "Missing group id" };
  }
  let link: string | null = null;
  try {
    const invite = await deps.getGroupInvite(groupId);
    if (invite && typeof invite.link === "string" && invite.link.length > 0) {
      link = invite.link;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to resolve invite";
    return { success: false, link: null, error: msg };
  }
  if (!link) {
    return { success: false, link: null, error: "No invite available for this group" };
  }
  try {
    const result = await deps.clipboardWriteText(link);
    if (!result?.success) {
      return { success: false, link, error: "Clipboard write was rejected" };
    }
    return { success: true, link };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Clipboard write failed";
    return { success: false, link, error: msg };
  }
}

/**
 * Get the screenlink preload API as a typed dependency bag, or null
 * if the API is not available.
 */
export function getInviteCopyDeps(): InviteCopyDeps | null {
  try {
    const api = (window as unknown as {
      screenlink?: {
        getGroupInvite?: (id: string) => Promise<{ link: string } | null>;
        clipboardWriteText?: (text: string) => Promise<{ success: boolean; length: number }>;
      };
    }).screenlink;
    if (
      !api ||
      typeof api.getGroupInvite !== "function" ||
      typeof api.clipboardWriteText !== "function"
    ) {
      return null;
    }
    return {
      getGroupInvite: api.getGroupInvite.bind(api),
      clipboardWriteText: api.clipboardWriteText.bind(api),
    };
  } catch {
    return null;
  }
}

/**
 * Convenience: resolve deps and copy the invite for the given
 * group. Shows a toast on success or failure. Returns the result.
 */
export async function copyGroupInviteFromUi(
  groupId: string,
  successMessage = "Invite link copied",
): Promise<InviteCopyResult> {
  const deps = getInviteCopyDeps();
  if (!deps) {
    toast.error("Invite copy is unavailable");
    return { success: false, link: null, error: "API unavailable" };
  }
  const result = await copyGroupInvite(groupId, deps);
  if (result.success) {
    toast.success(successMessage);
  } else {
    toast.error(result.error ?? "Failed to copy invite");
  }
  return result;
}
