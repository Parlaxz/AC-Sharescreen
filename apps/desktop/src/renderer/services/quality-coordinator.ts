import {
  type GroupQualitySettings,
  type HostQualityLimits,
  type ViewerQualityRequest,
  calculateEffectiveQuality as sharedCalculateEffectiveQuality,
} from "@screenlink/shared";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EffectiveQuality {
  requested: Partial<ViewerQualityRequest> | null;
  effective: {
    videoBitrateKbps: number;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    degradationPreference: string;
  };
  configured: {
    // what was actually applied to the sender
    maxBitrate: number;
    maxFramerate: number;
    scaleResolutionDownBy: number;
    degradationPreference: string;
    priority: string;
  } | null;
  clampReasons: string[];
}

/**
 * Minimal record of an accepted viewer request revision for idempotency
 * in the production quality route. Replaces the removed
 * decideViewerRequest/acceptedRequests machinery (Phase 2).
 */
export interface AcceptedRequestRecord {
  requestId: string;
  revision: number;
}

// ─── Shared Sender-Setting Utilities ───────────────────────────────────────

export interface SenderSettingsInput {
  /** Video bitrate in kbps (converted to B/s internally) */
  maxBitrate: number;
  /** Maximum framerate */
  maxFramerate: number;
  /** Degradation preference ("balanced", "maintain-resolution", "maintain-framerate") */
  degradationPreference?: string;
  /** Scale resolution down by factor (>=1) */
  scaleResolutionDownBy?: number;
}

export interface SenderSettingsReadback {
  /** Actual applied max bitrate in bps */
  maxBitrate: number;
  /** Actual applied max framerate */
  maxFramerate: number;
  /** Actual applied scale resolution down by */
  scaleResolutionDownBy: number;
  /** Applied degradation preference */
  degradationPreference: string;
  /** Sender encoding priority */
  priority: string;
}

/**
 * Apply sender encoding settings to an RTCRtpSender and read back the
 * actual applied values. This is the canonical low-level implementation
 * used by PublisherManager (applyVideoSenderSettings).
 *
 * Preserves existing encoding fields not specified in `settings` (e.g.
 * priority, codec payload type, header extensions).
 */
export async function applySenderSettings(
  sender: RTCRtpSender,
  settings: SenderSettingsInput,
): Promise<SenderSettingsReadback> {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const enc = params.encodings[0]!;

  // Preserve existing priority
  const existingPriority = enc.priority;

  enc.maxBitrate = settings.maxBitrate * 1000;
  enc.maxFramerate = settings.maxFramerate;
  if (settings.degradationPreference) {
    (params as unknown as { degradationPreference: RTCDegradationPreference }).degradationPreference =
      settings.degradationPreference as RTCDegradationPreference;
  }
  if (settings.scaleResolutionDownBy !== undefined && settings.scaleResolutionDownBy >= 1) {
    enc.scaleResolutionDownBy = settings.scaleResolutionDownBy;
  }
  // Restore priority (was preserved above)
  enc.priority = existingPriority ?? "medium";

  await sender.setParameters(params);

  // Read back actual configured values
  const readback = sender.getParameters();
  return {
    maxBitrate: readback.encodings?.[0]?.maxBitrate ?? 0,
    maxFramerate: readback.encodings?.[0]?.maxFramerate ?? 0,
    scaleResolutionDownBy: readback.encodings?.[0]?.scaleResolutionDownBy ?? 1,
    degradationPreference: settings.degradationPreference ?? "balanced",
    priority: readback.encodings?.[0]?.priority ?? "medium",
  };
}

/** Composite key for viewer request storage: groupId::logicalStreamId::viewerDeviceId */
function viewerRequestKey(groupId: string, logicalStreamId: string, viewerDeviceId: string): string {
  return `${groupId}::${logicalStreamId}::${viewerDeviceId}`;
}

// ─── QualityCoordinator ─────────────────────────────────────────────────────

export class QualityCoordinator {
  /**
   * Minimum revision record for idempotency in the production route.
   * Keyed by groupId::logicalStreamId::viewerDeviceId.
   */
  private acceptedRevisions = new Map<string, AcceptedRequestRecord>();

  /**
   * Stored viewer requests keyed by composite key.
   * Stage 6: Session request storage keyed by groupId + logicalStreamId + viewerDeviceId.
   */
  private viewerRequests = new Map<string, ViewerQualityRequest>();

  /**
   * Handle an incoming viewer quality request from the group message router.
   * Stage 6: Routes the message to the quality coordinator's internal storage
   * using the correct composite key: groupId + logicalStreamId + viewerDeviceId.
   *
   * The router provides the resolved logicalStreamId (from the payload's
   * streamSessionId or registry context) so the key is always correct.
   *
   * **Monotonic revision / idempotency guarantees:**
   * - If the incoming `revision` is **strictly less than** the stored accepted
   *   revision for the same key, the request is **rejected** (no state change).
   * - If the incoming `revision` **equals** the stored accepted revision **and**
   *   the `requestId` matches, the store is **left unchanged** (idempotent no-op).
   * - If the incoming `revision` is **greater than** the stored accepted revision,
   *   the request is **accepted** and the stored revision advances.
   *
   * Simplified Phase 2: stores the request and records the accepted revision
   * for idempotency. The full decideViewerRequest/acceptedRequests machinery
   * has been removed — the production route (handleViewerRequest) is the only
   * entry point and stores the revision directly.
   */
  handleViewerRequest(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
    payload: {
      streamSessionId: string;
      requestId: string;
      revision: number;
      videoBitrateKbps: number;
      maxWidth: number;
      maxHeight: number;
      maxFps: number;
      degradationPreference: string;
    },
  ): void {
    const key = viewerRequestKey(groupId, logicalStreamId, viewerDeviceId);
    const current = this.acceptedRevisions.get(key);

    // Stale revision check: reject if incoming < stored
    if (current && payload.revision < current.revision) {
      return;
    }

    // Idempotency check: no-op if equal revision with same requestId
    if (current && payload.revision === current.revision && current.requestId === payload.requestId) {
      return;
    }

    const request: ViewerQualityRequest = {
      streamSessionId: payload.streamSessionId,
      requestId: payload.requestId,
      revision: payload.revision,
      videoBitrateKbps: payload.videoBitrateKbps,
      maxWidth: payload.maxWidth,
      maxHeight: payload.maxHeight,
      maxFps: payload.maxFps,
      degradationPreference: payload.degradationPreference as ViewerQualityRequest["degradationPreference"],
      requestedAt: Date.now(),
    };

    // Store the accepted revision for idempotency
    this.acceptedRevisions.set(key, { requestId: payload.requestId, revision: payload.revision });
    this.viewerRequests.set(key, request);
  }

  /**
   * Handle an incoming quality.viewer.clear message.
   * Removes the stored request for the given composite key.
   * Stage 6: Does NOT call handleViewerRequest (which stores), truly clears.
   */
  handleViewerClear(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
  ): void {
    const key = viewerRequestKey(groupId, logicalStreamId, viewerDeviceId);
    this.viewerRequests.delete(key);
    this.acceptedRevisions.delete(key);
  }

  /**
   * Get a stored viewer request by composite key.
   * Returns null if no request exists for the given key.
   */
  getViewerRequest(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
  ): ViewerQualityRequest | null {
    const key = viewerRequestKey(groupId, logicalStreamId, viewerDeviceId);
    return this.viewerRequests.get(key) ?? null;
  }

  /**
   * Get the accepted revision record for a composite key.
   * Used by the production quality route for idempotency checks
   * (replaces the removed getAcceptedRequest).
   */
  getAcceptedRevision(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
  ): AcceptedRequestRecord | null {
    return this.acceptedRevisions.get(viewerRequestKey(groupId, logicalStreamId, viewerDeviceId)) ?? null;
  }

  /**
   * Calculate effective quality for a viewer by combining group defaults,
   * the viewer's request (if any and allowed), schema ranges, host limits, and source
   * dimensions.
   *
   * Delegates to the shared pure resolver {@link sharedCalculateEffectiveQuality}
   * for all quality-arbitration logic. This method exists for backward compatibility
   * and adds the `configured: null` field expected by callers.
   *
   * Stage 6:
   * - Delegates to shared pure resolver.
   * - Enforce `allowViewerQualityRequests === false` rejection path.
   * - Correct resolution scaling: use actual source width/height and prevent upscale.
   */
  calculateEffectiveQuality(
    groupSettings: GroupQualitySettings,
    hostLimits: HostQualityLimits,
    viewerRequest: ViewerQualityRequest | null,
    sourceDimensions: { width: number; height: number },
  ): EffectiveQuality {
    const resolved = sharedCalculateEffectiveQuality(
      groupSettings,
      hostLimits,
      viewerRequest,
      sourceDimensions,
    );
    return {
      ...resolved,
      configured: null, // filled in after sender application
    };
  }

  /**
   * Apply effective quality to an RTCRtpSender by setting encoding parameters.
   * Stage 6: Read back actual configured values from sender.getParameters();
   * do not hardcode scale=1. Preserves unrelated sender parameters (priority,
   * codec preferences, header extensions, etc.) that were set externally.
   */
  async applyToSender(
    sender: RTCRtpSender,
    effective: EffectiveQuality["effective"],
  ): Promise<EffectiveQuality["configured"]> {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const enc = params.encodings[0]!;

    // Preserve existing priority — do not hardcode "medium"
    const existingPriority = enc.priority;

    enc.maxBitrate = effective.videoBitrateKbps * 1000;
    enc.maxFramerate = effective.maxFps;

    // Stage 6: Fix maxWidth/maxWidth → maxWidth bug.
    // Compute scale from source track settings down to effective target.
    // Apply scaling exactly once: if the viewer explicitly requested dimensions,
    // calculate one source-to-target scaleResolutionDownBy.
    // Do NOT compound with a prior group-level scale — the effective maxWidth/maxHeight
    // from calculateEffectiveQuality already represent the final target when viewer
    // explicitly requests those dimensions.
    const settings = sender.track?.getSettings();
    const sourceWidth = settings?.width ?? 1920;
    const sourceHeight = settings?.height ?? 1080;
    if (effective.maxWidth > 0 && effective.maxHeight > 0 && sourceWidth > 0 && sourceHeight > 0) {
      const widthScale = sourceWidth / effective.maxWidth;
      const heightScale = sourceHeight / effective.maxHeight;
      enc.scaleResolutionDownBy = Math.max(1, widthScale, heightScale);
    } else {
      enc.scaleResolutionDownBy = 1;
    }

    // degradationPreference is a top-level RTCRtpSendParameters field, NOT per-encoding.
    // Setting it on the encoding level is incorrect — Chromium may ignore or throw.
    (params as unknown as { degradationPreference: RTCDegradationPreference }).degradationPreference =
      effective.degradationPreference as RTCDegradationPreference;
    // Preserve existing priority rather than overwriting it
    enc.priority = existingPriority ?? "medium";

    await sender.setParameters(params);

    // Read back actual configured values
    const readback = sender.getParameters();
    return {
      maxBitrate: readback.encodings?.[0]?.maxBitrate ?? 0,
      maxFramerate: readback.encodings?.[0]?.maxFramerate ?? 0,
      scaleResolutionDownBy: readback.encodings?.[0]?.scaleResolutionDownBy ?? 1,
      degradationPreference: effective.degradationPreference,
      priority: readback.encodings?.[0]?.priority ?? "medium",
    };
  }

  /**
   * Apply effective quality to an exact viewer identified by viewerDeviceId + mediaPeerUuid.
   * Stage 6: Apply only to the exact viewer's RTCRtpSender.
   */
  async applyToExactViewer(
    _viewerDeviceId: string,
    _mediaPeerUuid: string,
    sender: RTCRtpSender,
    effective: EffectiveQuality["effective"],
  ): Promise<EffectiveQuality["configured"]> {
    return this.applyToSender(sender, effective);
  }
}
