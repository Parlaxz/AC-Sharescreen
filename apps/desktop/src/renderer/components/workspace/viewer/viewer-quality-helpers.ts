/**
 * Check whether a viewer quality request can be dispatched.
 *
 * Returns a user-facing error string when the request cannot be sent,
 * or null when dispatch is possible.
 *
 * Logs diagnostics to the console so the specific failure reason
 * (missing runtime vs missing watching-target) is visible in log files.
 */
export function getViewerQualityDispatchError(
  runtime: unknown,
  watchingTarget: { logicalStreamId: string } | null | undefined,
): string | null {
  if (!runtime) {
    console.warn(
      "[viewer-quality] dispatch blocked: Phase3Runtime is null",
      new Error().stack?.split("\n").slice(2, 4).join(" "),
    );
    return "Cannot send request — not connected";
  }
  if (!watchingTarget) {
    console.warn(
      "[viewer-quality] dispatch blocked: watchingTarget is null (runtime exists)",
      new Error().stack?.split("\n").slice(2, 4).join(" "),
    );
    return "Cannot send request — not connected";
  }
  return null;
}

export function resolveViewerQualityFeedbackStreamId(input: {
  watchingTargetLogicalStreamId: string | null | undefined;
  currentStreamLogicalStreamId: string | null | undefined;
}): string | null {
  return input.watchingTargetLogicalStreamId
    ?? input.currentStreamLogicalStreamId
    ?? null;
}
