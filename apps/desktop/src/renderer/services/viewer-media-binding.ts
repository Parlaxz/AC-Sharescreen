import type { GroupControlEnvelope } from "@screenlink/shared";
import type { Phase3Runtime } from "./phase3-runtime.js";

/**
 * Binding token created by the host for a viewer's stream.join.request.
 * The viewer must present this token via media.bind to be granted a peer connection.
 */
export interface BindingToken {
  token: string;
  groupId: string;
  logicalStreamId: string;
  mediaSessionId: string;
  viewerDeviceId: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export interface ViewerMapping {
  viewerDeviceId: string;
  mediaPeerUuid: string;
}

export interface ConsumeBindingInput {
  token: string;
  viewerDeviceId: string;
  groupId: string;
  logicalStreamId: string;
  mediaSessionId: string;
  mediaPeerUuid: string;
}

/**
 * C5: ViewerMediaBinding (Stages 4–5)
 *
 * Manages one-time binding tokens that authorize a viewer to attach
 * to a specific media session. The host:
 * 1. Receives stream.join.request → generates token
 * 2. Viewer presents token via media.bind data channel message
 * 3. Host validates and marks consumed
 *
 * Stage 5 enhancements:
 * - consumeBinding(): full validation of token + viewer/group/logicalStream/mediaSession/peerConnection/senders
 * - Duplicate request idempotency via requestId tracking
 * - getAllViewers() for cleanup on stream stop
 * - Viewer disconnect preserves other viewers
 */
export class ViewerMediaBinding {
  private tokens = new Map<string, BindingToken>();
  /** viewerDeviceId → media peer mapping */
  private viewerMap = new Map<string, ViewerMapping>();
  /** Track processed requestIds for idempotency */
  private processedRequests = new Map<string, string>(); // requestEnvelopeId → token
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private readonly TOKEN_TTL_MS = 60_000; // 60 seconds
  private readonly CLEANUP_INTERVAL_MS = 30_000; // every 30s

  constructor(private runtime: Phase3Runtime) {
    this.startCleanup();
  }

  /**
   * Called by host when stream.join.request arrives via group control.
   * Validates the sender has a valid group with an active stream,
   * generates a one-time token, stores it, and sends a response back
   * to the requesting viewer via group control.
   *
   * Uses the real host device ID from the runtime (not hardcoded "local").
   * Stage 5: Duplicate requestId returns the same token (idempotent).
   *
   * Returns null if no active stream is found for the group.
   */
  handleJoinRequest(envelope: GroupControlEnvelope): { mediaSessionId: string; token: string } | null {
    if (this.destroyed) return null;

    const groupId = envelope.groupId;
    const viewerDeviceId = envelope.senderDeviceId;
    const payload = envelope.payload as Record<string, unknown> | undefined;
    const logicalStreamId = payload?.logicalStreamId as string | undefined;
    const requestId = payload?.requestId as string | undefined;

    if (!viewerDeviceId || !logicalStreamId) return null;

    // Stage 5: Check for duplicate request (same envelope messageId)
    if (envelope.messageId && this.processedRequests.has(envelope.messageId)) {
      const existingToken = this.processedRequests.get(envelope.messageId)!;
      const bt = this.tokens.get(existingToken);
      if (bt && !bt.consumed) {
        return { mediaSessionId: bt.mediaSessionId, token: existingToken };
      }
    }

    // Use the real host device ID from the runtime, not hardcoded "local"
    const hostDeviceId = this.runtime.deviceId ?? "local";

    // Verify this group has an active stream matching the request
    const registry = this.runtime.getActiveStreamRegistry();
    const stream = registry.getStream({
      groupId,
      hostDeviceId,
      logicalStreamId,
    });
    if (!stream) return null;

    // Generate 32 random bytes → Base64URL token
    const rawBytes = new Uint8Array(32);
    crypto.getRandomValues(rawBytes);
    const token = this.base64URLEncode(rawBytes);

    const now = Date.now();
    const bindingToken: BindingToken = {
      token,
      groupId,
      logicalStreamId,
      mediaSessionId: stream.mediaSessionId,
      viewerDeviceId,
      createdAt: now,
      expiresAt: now + this.TOKEN_TTL_MS,
      consumed: false,
    };

    this.tokens.set(token, bindingToken);

    // Track for idempotency
    if (envelope.messageId) {
      this.processedRequests.set(envelope.messageId, token);
    }

    // Send join response back to the requesting viewer
    this.sendJoinResponse(envelope, token, stream.mediaSessionId, requestId).catch(() => {});

    return {
      mediaSessionId: stream.mediaSessionId,
      token,
    };
  }

  /**
   * Send a stream.join.response back to the requesting viewer via group control.
   * Includes VDO media credentials (streamId, password, bindingToken) so the
   * viewer can connect directly via ViewerClient without local host config.
   */
  private async sendJoinResponse(
    requestEnvelope: GroupControlEnvelope,
    token: string,
    mediaSessionId: string,
    requestId?: string,
  ): Promise<void> {
    const conn = this.runtime.getConnectionManager().getConnection(requestEnvelope.groupId);
    if (!conn) return;
    const peerUuid = conn.peerForDevice(requestEnvelope.senderDeviceId);
    if (!peerUuid) return;

    // Get VDO credentials from the StreamSessionManager so the viewer can
    // connect directly via ViewerClient with the real streamId & password.
    const ssm = this.runtime.getStreamSessionManager();
    const vdoConfig = ssm.getCurrentVdoConfig();

    await conn.sendToPeer(peerUuid, {
      type: "stream.join.response",
      logicalStreamId: requestEnvelope.payload?.logicalStreamId as string,
      accepted: true,
      viewerDeviceId: requestEnvelope.senderDeviceId,
      mediaSessionId,
      mediaJoinMetadata: token,
      streamId: vdoConfig?.streamId,
      password: vdoConfig?.password,
      bindingToken: token,
      requestId: requestId ?? "",
    });
  }

  /**
   * Called by host when media.bind arrives via the VDO data channel.
   * Uses the real media peer UUID from the VDO SDK callback.
   *
   * Delegates to consumeBinding() with the token's stored context
   * for consistent validation across both bind paths.
   */
  async handleMediaBind(peerUuid: string, token: string): Promise<boolean> {
    if (this.destroyed) return false;

    const bindingToken = this.tokens.get(token);
    if (!bindingToken) return false;
    if (bindingToken.consumed) return false;
    if (Date.now() > bindingToken.expiresAt) {
      this.tokens.delete(token);
      return false;
    }

    // Use the full consumeBinding path for consistent validation
    return this.consumeBinding({
      token,
      viewerDeviceId: bindingToken.viewerDeviceId,
      groupId: bindingToken.groupId,
      logicalStreamId: bindingToken.logicalStreamId,
      mediaSessionId: bindingToken.mediaSessionId,
      mediaPeerUuid: peerUuid,
    });
  }

  /**
   * Stage 5: Full binding consumption with validation.
   *
   * Validates that:
   * - The token exists and is not consumed
   * - The viewerDeviceId matches
   * - The groupId matches
   * - The logicalStreamId matches
   * - The mediaSessionId matches
   *
   * On success, deletes the token and stores the viewer mapping.
   * Returns true if the binding was consumed successfully.
   */
  async consumeBinding(input: ConsumeBindingInput): Promise<boolean> {
    if (this.destroyed) return false;

    const bindingToken = this.tokens.get(input.token);
    if (!bindingToken) return false;
    if (bindingToken.consumed) return false;
    if (Date.now() > bindingToken.expiresAt) {
      this.tokens.delete(input.token);
      return false;
    }

    // Validate viewerDeviceId
    if (bindingToken.viewerDeviceId !== input.viewerDeviceId) return false;

    // Validate groupId
    if (bindingToken.groupId !== input.groupId) return false;

    // Validate logicalStreamId
    if (bindingToken.logicalStreamId !== input.logicalStreamId) return false;

    // Validate mediaSessionId
    if (bindingToken.mediaSessionId !== input.mediaSessionId) return false;

    // Mark consumed and delete token
    bindingToken.consumed = true;
    this.tokens.delete(input.token);

    // Store viewer mapping
    this.viewerMap.set(input.viewerDeviceId, {
      viewerDeviceId: input.viewerDeviceId,
      mediaPeerUuid: input.mediaPeerUuid,
    });

    return true;
  }

  /**
   * Get the media peer UUID for a viewer device ID.
   * Returns null if not found.
   */
  getViewerMediaPeer(viewerDeviceId: string): string | null {
    return this.viewerMap.get(viewerDeviceId)?.mediaPeerUuid ?? null;
  }

  /**
   * Remove a viewer from the binding map.
   * Called when a viewer disconnects.
   * Stage 5: Does NOT affect other viewers.
   */
  removeViewer(viewerDeviceId: string): void {
    this.viewerMap.delete(viewerDeviceId);
  }

  /**
   * Stage 5: Get all mapped viewers.
   * Used by StreamSessionManager.stopStream() to clean up on stream stop.
   */
  getAllViewers(): ViewerMapping[] {
    return Array.from(this.viewerMap.values());
  }

  /**
   * Get the binding token for diagnostics/debugging.
   */
  getBindingToken(token: string): BindingToken | undefined {
    return this.tokens.get(token);
  }

  /**
   * Destroy the binding manager. Terminates cleanup timer and clears all state.
   */
  destroy(): void {
    this.destroyed = true;
    this.tokens.clear();
    this.viewerMap.clear();
    this.processedRequests.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredTokens();
    }, this.CLEANUP_INTERVAL_MS);
  }

  private cleanupExpiredTokens(): void {
    const now = Date.now();
    for (const [token, bt] of this.tokens) {
      if (now > bt.expiresAt) {
        this.tokens.delete(token);
      }
    }
    // Also clean up stale processed request entries (older than TTL)
    for (const [reqId, token] of this.processedRequests) {
      const bt = this.tokens.get(token);
      if (!bt) {
        this.processedRequests.delete(reqId);
      }
    }
  }

  private base64URLEncode(bytes: Uint8Array): string {
    // Convert to binary string, then btoa, then make URL-safe
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
}
