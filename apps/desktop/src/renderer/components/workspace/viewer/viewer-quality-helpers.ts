export function getViewerQualityDispatchError(
  runtime: unknown,
  watchingTarget: { logicalStreamId: string } | null | undefined,
): string | null {
  if (!runtime || !watchingTarget) {
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
