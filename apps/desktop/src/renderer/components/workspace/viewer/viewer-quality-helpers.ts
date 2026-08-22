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

type ViewerQualityEffectiveFeedbackInput = {
  videoBitrateKbps?: number | null;
  clampReasons?: string[] | null;
};

type ViewerQualityEffectiveFeedback = {
  accepted: boolean | undefined;
  message: string;
};

const WAITING_QUALITY_REASON_PATTERNS = [
  /^mapping missing$/i,
  /^sender not ready/i,
];

const REJECTED_QUALITY_REASON_PATTERNS = [
  /^application failed:/i,
];

function isWaitingQualityReason(reason: string): boolean {
  return WAITING_QUALITY_REASON_PATTERNS.some((pattern) => pattern.test(reason));
}

function isRejectedQualityReason(reason: string): boolean {
  return REJECTED_QUALITY_REASON_PATTERNS.some((pattern) => pattern.test(reason));
}

function formatViewerQualityKbps(kbps?: number | null): string {
  if (!kbps || kbps <= 0) return "requested rate";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} MB/s`;
  return `${kbps} kb/s`;
}

export function getViewerQualityEffectiveFeedback(
  input: ViewerQualityEffectiveFeedbackInput,
): ViewerQualityEffectiveFeedback {
  const clampReasons = input.clampReasons ?? [];
  const waitingReasons = clampReasons.filter(isWaitingQualityReason);
  const rejectedReasons = clampReasons.filter(isRejectedQualityReason);

  if (waitingReasons.length > 0) {
    // Phase 9: grounded copy — "mapping" is an internal concept.
    return {
      accepted: undefined,
      message: "Waiting for media connection — will apply automatically",
    };
  }

  if (rejectedReasons.length > 0) {
    return {
      accepted: false,
      message: `Could not apply quality: ${rejectedReasons.join("; ")}`,
    };
  }

  if (clampReasons.length > 0) {
    return {
      accepted: true,
      message: `Accepted, capped: ${clampReasons.join("; ")}`,
    };
  }

  return {
    accepted: true,
    message: `Accepted at ${formatViewerQualityKbps(input.videoBitrateKbps)}`,
  };
}
