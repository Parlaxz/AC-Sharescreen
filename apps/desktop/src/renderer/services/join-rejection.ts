/**
 * Host-side stream.join.response rejection reasons that mean the share
 * itself is gone (the host stopped sharing), as opposed to a transient
 * viewer/host problem. The viewer treats these as a graceful "stream
 * ended" signal rather than a fatal playback error.
 */

/** Host's own publication for this stream is inactive (SSM owns it but is not live). */
export const JOIN_REJECTION_SHARE_INACTIVE = "This share is no longer active";

/** No active stream found in SSM or the registry for the requested stream. */
export const JOIN_REJECTION_NO_ACTIVE_SHARE = "There is no active share for this stream";

/**
 * Whether a join rejection reason indicates the host's share has ended.
 * Matches case-insensitively on the stable phrases so minor wording
 * changes (or older hosts) still classify correctly.
 */
export function isShareEndedRejection(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase();
  return (
    normalized.includes("no longer active") ||
    normalized.includes("no active share")
  );
}
