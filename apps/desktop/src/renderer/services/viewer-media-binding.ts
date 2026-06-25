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

/**
 * C5: ViewerMediaBinding
 *
 * Manages one-time binding tokens that authorize a viewer to attach
 * to a specific media session. The host:
 * 1. Receives stream.join.request → generates token
 * 2. Viewer presents token via media.bind data channel message
 * 3. Host validates and marks consumed
 *
 * This prevents unauthorized viewers from accessing media.
 */
export class ViewerMediaBinding {
  private tokens = new Map<string, BindingToken>();
  /** viewerDeviceId → { mediaPeerUuid, pc } */
  private viewerMap = new Map<
    string,
    { viewerDeviceId: string; mediaPeerUuid: string }
  >();
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
   * generates a one-time token, stores it, and returns the token + mediaSessionId.
   *
   * Returns null if no active stream is found for the group.
   */
  handleJoinRequest(envelope: GroupControlEnvelope): { mediaSessionId: string; token: string } | null {
    if (this.destroyed) return null;

    const groupId = envelope.groupId;
    const viewerDeviceId = envelope.senderDeviceId;
    const payload = envelope.payload as Record<string, unknown> | undefined;
    const logicalStreamId = payload?.logicalStreamId as string | undefined;

    if (!viewerDeviceId || !logicalStreamId) return null;

    // Verify this group has an active stream matching the request
    const registry = this.runtime.getActiveStreamRegistry();
    const stream = registry.getStream({
      groupId,
      hostDeviceId: "local",
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

    return {
      mediaSessionId: stream.mediaSessionId,
      token,
    };
  }

  /**
   * Called by host when media.bind arrives via the data channel.
   * Validates the token, marks it consumed, stores the viewer → mediaPeer mapping.
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

    // Mark consumed
    bindingToken.consumed = true;

    // Store viewer → media peer mapping
    this.viewerMap.set(bindingToken.viewerDeviceId, {
      viewerDeviceId: bindingToken.viewerDeviceId,
      mediaPeerUuid: peerUuid,
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
   */
  removeViewer(viewerDeviceId: string): void {
    this.viewerMap.delete(viewerDeviceId);
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
