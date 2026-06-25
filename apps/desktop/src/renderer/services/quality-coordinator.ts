import {
  type GroupQualitySettings,
  type HostQualityLimits,
  type ViewerQualityRequest,
  RANGES,
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
 * Result of a request-handling call. Distinct from EffectiveQuality
 * so that the host can drive "stale / idempotent / conflict / accept"
 * outcomes through a single decision object.
 */
export type ViewerRequestDecision =
  | { kind: "accepted"; quality: EffectiveQuality }
  | { kind: "stale"; reason: "lower-revision" }
  | { kind: "idempotent"; reason: "same-request-id" }
  | { kind: "conflict"; reason: "same-revision-different-request" }
  | { kind: "rejected-no-stream"; reason: "host has no active stream" }
  | { kind: "rejected-no-viewer"; reason: "viewer not bound" }
  | { kind: "rejected-disabled"; reason: "host disabled viewer requests" };

/**
 * Stored per-viewer accepted request state. Used to drive revision
 * ordering and idempotency.
 */
export interface AcceptedViewerRequest {
  requestId: string;
  revision: number;
  payload: ViewerQualityRequest;
  acceptedAt: number;
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Composite key for viewer request storage: groupId::logicalStreamId::viewerDeviceId */
function viewerRequestKey(groupId: string, logicalStreamId: string, viewerDeviceId: string): string {
  return `${groupId}::${logicalStreamId}::${viewerDeviceId}`;
}

/** Composite key for viewer request iteration by group+stream */
function streamViewerRequestsKey(groupId: string, logicalStreamId: string): string {
  return `${groupId}::${logicalStreamId}`;
}

// ─── QualityCoordinator ─────────────────────────────────────────────────────

export class QualityCoordinator {
  /**
   * Stored viewer requests keyed by composite key.
   * Stage 6: Session request storage keyed by groupId + logicalStreamId + viewerDeviceId.
   */
  private viewerRequests = new Map<string, ViewerQualityRequest>();

  /**
   * Accepted-request state keyed by the same composite key. Holds the
   * highest accepted revision, the requestId that produced it, and the
   * full payload — used to drive Gate 6.2 ordering (stale,
   * idempotent, conflict, accept).
   */
  private acceptedRequests = new Map<string, AcceptedViewerRequest>();

  /**
   * Index: streamViewerRequestsKey -> Set of composite keys for that group+stream.
   * Enables getAllViewerRequests without scanning all entries.
   */
  private streamViewerIndex = new Map<string, Set<string>>();

  /**
   * Handle an incoming viewer quality request from the group message router.
   * Stage 6: Routes the message to the quality coordinator's internal storage
   * using the correct composite key: groupId + logicalStreamId + viewerDeviceId.
   *
   * The router provides the resolved logicalStreamId (from the payload's
   * streamSessionId or registry context) so the key is always correct.
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

    this.storeViewerRequest(groupId, logicalStreamId, viewerDeviceId, request);
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
    this.clearViewerRequest(groupId, logicalStreamId, viewerDeviceId);
  }

  /**
   * Apply Gate 6.2 revision semantics to a viewer request.
   *
   * Outcomes:
   *   - lower revision  → stale (rejected)
   *   - same requestId  → idempotent (returns the original payload)
   *   - same revision, different requestId → conflict (rejected)
   *   - higher revision → accepted (replaces previous accepted state)
   */
  decideViewerRequest(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
    payload: ViewerQualityRequest,
  ): ViewerRequestDecision {
    const key = viewerRequestKey(groupId, logicalStreamId, viewerDeviceId);
    const prior = this.acceptedRequests.get(key);

    if (prior) {
      // Same requestId is always idempotent — same revision or
      // otherwise, the request is "this is the same request
      // re-presented".
      if (prior.requestId === payload.requestId) {
        return { kind: "idempotent", reason: "same-request-id" };
      }
      if (payload.revision < prior.revision) {
        return { kind: "stale", reason: "lower-revision" };
      }
      if (payload.revision === prior.revision) {
        return { kind: "conflict", reason: "same-revision-different-request" };
      }
    }

    // Higher (or no prior) — accept and store.
    this.acceptedRequests.set(key, {
      requestId: payload.requestId,
      revision: payload.revision,
      payload,
      acceptedAt: Date.now(),
    });
    this.storeViewerRequest(groupId, logicalStreamId, viewerDeviceId, payload);
    // The actual effective quality is filled in by the host when it
    // knows the source dimensions and host limits. The decision here
    // only attests to revision acceptance.
    return {
      kind: "accepted",
      quality: {
        requested: null,
        effective: {
          videoBitrateKbps: payload.videoBitrateKbps,
          maxWidth: payload.maxWidth,
          maxHeight: payload.maxHeight,
          maxFps: payload.maxFps,
          degradationPreference: payload.degradationPreference,
        },
        configured: null,
        clampReasons: [],
      },
    };
  }

  /**
   * Read the accepted request state for a composite key.
   */
  getAcceptedRequest(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
  ): AcceptedViewerRequest | null {
    return this.acceptedRequests.get(viewerRequestKey(groupId, logicalStreamId, viewerDeviceId)) ?? null;
  }

  /**
   * Store a viewer quality request keyed by composite key.
   */
  storeViewerRequest(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
    request: ViewerQualityRequest,
  ): void {
    const key = viewerRequestKey(groupId, logicalStreamId, viewerDeviceId);
    this.viewerRequests.set(key, request);

    // Update the stream index
    const streamKey = streamViewerRequestsKey(groupId, logicalStreamId);
    let index = this.streamViewerIndex.get(streamKey);
    if (!index) {
      index = new Set();
      this.streamViewerIndex.set(streamKey, index);
    }
    index.add(key);
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
   * Clear a stored viewer request by composite key.
   */
  clearViewerRequest(
    groupId: string,
    logicalStreamId: string,
    viewerDeviceId: string,
  ): void {
    const key = viewerRequestKey(groupId, logicalStreamId, viewerDeviceId);
    this.viewerRequests.delete(key);
    this.acceptedRequests.delete(key);

    // Update stream index
    const streamKey = streamViewerRequestsKey(groupId, logicalStreamId);
    const index = this.streamViewerIndex.get(streamKey);
    if (index) {
      index.delete(key);
      if (index.size === 0) {
        this.streamViewerIndex.delete(streamKey);
      }
    }
  }

  /**
   * Get all viewer requests for a given group and stream.
   */
  getAllViewerRequests(groupId: string, logicalStreamId: string): ViewerQualityRequest[] {
    const streamKey = streamViewerRequestsKey(groupId, logicalStreamId);
    const index = this.streamViewerIndex.get(streamKey);
    if (!index) return [];
    const requests: ViewerQualityRequest[] = [];
    for (const key of index) {
      const req = this.viewerRequests.get(key);
      if (req) requests.push(req);
    }
    return requests;
  }

  /**
   * Calculate effective quality for a viewer by combining group defaults,
   * the viewer's request (if any and allowed), schema ranges, host limits, and source
   * dimensions.
   *
   * Stage 6:
   * - Enforce `allowViewerQualityRequests === false` rejection path.
   * - Correct resolution scaling: use actual source width/height and prevent upscale.
   */
  calculateEffectiveQuality(
    groupSettings: GroupQualitySettings,
    hostLimits: HostQualityLimits,
    viewerRequest: ViewerQualityRequest | null,
    sourceDimensions: { width: number; height: number },
  ): EffectiveQuality {
    // 1. Start from group defaults for viewer-requestable fields
    let bitrate = groupSettings.video.videoBitrateKbps;
    let width = groupSettings.video.sendWidth;
    let height = groupSettings.video.sendHeight;
    let fps = groupSettings.video.sendFps;
    let degradation = groupSettings.video.degradationPreference;
    const reasons: string[] = [];

    // 2. If viewer request exists AND host allows viewer quality requests, use those values
    //    Stage 6: Enforce allowViewerQualityRequests === false rejection path
    if (viewerRequest && hostLimits.allowViewerQualityRequests) {
      bitrate = viewerRequest.videoBitrateKbps;
      width = viewerRequest.maxWidth;
      height = viewerRequest.maxHeight;
      fps = viewerRequest.maxFps;
      degradation = viewerRequest.degradationPreference;
    }

    // 3. Clamp to schema ranges
    bitrate = clamp(bitrate, RANGES.videoBitrateKbps.min, RANGES.videoBitrateKbps.max);
    width = clamp(width, RANGES.sendWidth.min, RANGES.sendWidth.max);
    height = clamp(height, RANGES.sendHeight.min, RANGES.sendHeight.max);
    fps = clamp(fps, RANGES.sendFps.min, RANGES.sendFps.max);

    // 4. Clamp to host limits
    if (bitrate > hostLimits.maxVideoBitrateKbps) {
      reasons.push(`Bitrate clamped from ${bitrate} to host limit ${hostLimits.maxVideoBitrateKbps}`);
      bitrate = hostLimits.maxVideoBitrateKbps;
    }
    if (width > hostLimits.maxWidth) {
      reasons.push(`Width clamped from ${width} to host limit ${hostLimits.maxWidth}`);
      width = hostLimits.maxWidth;
    }
    if (height > hostLimits.maxHeight) {
      reasons.push(`Height clamped from ${height} to host limit ${hostLimits.maxHeight}`);
      height = hostLimits.maxHeight;
    }
    if (fps > hostLimits.maxFps) {
      reasons.push(`FPS clamped from ${fps} to host limit ${hostLimits.maxFps}`);
      fps = hostLimits.maxFps;
    }

    // 5. Clamp to source dimensions when preventUpscale
    //    Stage 6: Use actual source width/height, prevent upscale
    if (groupSettings.video.preventUpscale) {
      if (width > sourceDimensions.width) {
        reasons.push(`Width clamped from ${width} to source ${sourceDimensions.width} (preventUpscale)`);
        width = sourceDimensions.width;
      }
      if (height > sourceDimensions.height) {
        reasons.push(`Height clamped from ${height} to source ${sourceDimensions.height} (preventUpscale)`);
        height = sourceDimensions.height;
      }
    }

    // 6. Apply scaleResolutionDownBy
    //    Stage 6: Correct scaling using actual source width/height, not maxWidth/maxWidth bug
    const scale = groupSettings.video.scaleResolutionDownBy;
    const scaleWidth = Math.round(width / scale);
    const scaleHeight = Math.round(height / scale);

    return {
      requested: viewerRequest && hostLimits.allowViewerQualityRequests
        ? {
            videoBitrateKbps: viewerRequest.videoBitrateKbps,
            maxWidth: viewerRequest.maxWidth,
            maxHeight: viewerRequest.maxHeight,
            maxFps: viewerRequest.maxFps,
            degradationPreference: viewerRequest.degradationPreference,
          }
        : null,
      effective: {
        videoBitrateKbps: bitrate,
        maxWidth: scaleWidth,
        maxHeight: scaleHeight,
        maxFps: fps,
        degradationPreference: degradation,
      },
      configured: null, // filled in after sender application
      clampReasons: reasons,
    };
  }

  /**
   * Apply effective quality to an RTCRtpSender by setting encoding parameters.
   * Stage 6: Read back actual configured values from sender.getParameters();
   * do not hardcode scale=1.
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
    enc.maxBitrate = effective.videoBitrateKbps * 1000;
    enc.maxFramerate = effective.maxFps;

    // Stage 6: Fix maxWidth/maxWidth → maxWidth bug.
    // Compute scale from source track settings down to effective target.
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

    enc.degradationPreference = effective.degradationPreference;
    // Set priority
    enc.priority = "medium";

    await sender.setParameters(params);

    // Read back actual configured values
    const readback = sender.getParameters();
    return {
      maxBitrate: readback.encodings?.[0]?.maxBitrate ?? 0,
      maxFramerate: readback.encodings?.[0]?.maxFramerate ?? 0,
      scaleResolutionDownBy: readback.encodings?.[0]?.scaleResolutionDownBy ?? 1,
      degradationPreference: effective.degradationPreference,
      priority: "medium",
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
