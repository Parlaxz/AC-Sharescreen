import type { Phase3Runtime } from "./phase3-runtime.js";
import {
  parseGroupMessagePayload,
  type GroupControlEnvelope,
  type ViewerQualityRequest,
} from "@screenlink/shared";

/**
 * WatchedStreamManager (Gate 5)
 *
 * Owns the lifecycle of every remote stream the local installation is
 * currently watching. Each entry is keyed by
 *   groupId + hostDeviceId + logicalStreamId
 * so the dashboard can render multiple cards simultaneously and the
 * runtime can drive reconnect logic when a stream restarts.
 *
 * Replaces the older single-global-ViewerClient model. Dashboard
 * never instantiates ViewerClient directly; it asks the manager to
 * start, mute, unmute, set volume, and stop watching.
 */
export interface WatchedStreamKey {
  groupId: string;
  hostDeviceId: string;
  logicalStreamId: string;
}

export interface WatchedStreamEntry extends WatchedStreamKey {
  mediaSessionId: string;
  mediaPeerUuid: string | null;
  /** Underlying VDO/Ninja SDK viewer; concrete shape lives in VDO adapter. */
  viewerClient: unknown | null;
  connectionState: "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "failed";
  errorReason: string | null;
  requested: ViewerQualityRequest | null;
  configured: unknown | null;
  observed: unknown | null;
  mute: boolean;
  volume: number;
  /** Last join requestId we sent. Used to correlate join responses. */
  pendingJoinRequestId: string | null;
  /** Bind token issued by the host. */
  pendingBindToken: string | null;
}

function keyOf(k: WatchedStreamKey): string {
  return `${k.groupId}::${k.hostDeviceId}::${k.logicalStreamId}`;
}

export class WatchedStreamManager {
  private entries = new Map<string, WatchedStreamEntry>();
  private destroyed = false;

  constructor(private runtime: Phase3Runtime) {}

  /**
   * Begin watching a remote stream. The manager owns the ViewerClient
   * lifecycle and returns the entry so the UI can render it.
   *
   * The host peer must already be authenticated and mapped in the
   * group control connection. If it is not, this returns
   * `{ ok: false, reason: "host-not-mapped" }` so the dashboard can
   * surface "Host is reconnecting" without broadcasting a join
   * request to the whole group.
   */
  async startWatch(input: WatchedStreamKey & { mediaSessionId: string }): Promise<
    | { ok: true; entry: WatchedStreamEntry }
    | { ok: false; reason: "host-not-mapped" | "already-watching" | "destroyed" }
  > {
    if (this.destroyed) return { ok: false, reason: "destroyed" };
    const k = keyOf(input);
    if (this.entries.has(k)) {
      return { ok: false, reason: "already-watching" };
    }

    // Identify the authenticated host peer.
    const conn = this.runtime.getConnectionManager().getConnection(input.groupId);
    if (!conn) {
      return { ok: false, reason: "host-not-mapped" };
    }
    const peerUuid = conn.peerForDevice(input.hostDeviceId);
    if (!peerUuid) {
      return { ok: false, reason: "host-not-mapped" };
    }

    const requestId = crypto.randomUUID();
    const entry: WatchedStreamEntry = {
      groupId: input.groupId,
      hostDeviceId: input.hostDeviceId,
      logicalStreamId: input.logicalStreamId,
      mediaSessionId: input.mediaSessionId,
      mediaPeerUuid: null,
      viewerClient: null,
      connectionState: "connecting",
      errorReason: null,
      requested: null,
      configured: null,
      observed: null,
      mute: false,
      volume: 1.0,
      pendingJoinRequestId: requestId,
      pendingBindToken: null,
    };
    this.entries.set(k, entry);

    // Targeted join request — never broadcast to the whole group.
    try {
      await conn.sendToPeer(peerUuid, {
        type: "stream.join.request",
        logicalStreamId: input.logicalStreamId,
        viewerDeviceId: this.runtime.deviceId ?? "viewer",
        requestId,
      } as unknown as Record<string, unknown>);
    } catch {
      entry.connectionState = "failed";
      entry.errorReason = "join-request-failed";
    }
    return { ok: true, entry };
  }

  /**
   * Receive a join response from the host. Correlates by requestId.
   * On accept, the entry is moved to "connecting" with bind token
   * and VDO credentials stored for the ViewerClient handshake.
   */
  handleJoinResponse(envelope: GroupControlEnvelope): boolean {
    const parsed = parseGroupMessagePayload("stream.join.response", envelope.payload);
    if (!parsed.ok) return false;
    const data = parsed.data;
    const requestId = data.requestId ?? "";
    if (!requestId) return false;
    const entry = Array.from(this.entries.values()).find(
      (e) => e.pendingJoinRequestId === requestId,
    );
    if (!entry) return false;
    if (data.logicalStreamId !== entry.logicalStreamId) return false;
    if (!data.accepted) {
      entry.connectionState = "failed";
      entry.errorReason = data.reason ?? "rejected";
      return true;
    }
    entry.mediaSessionId = data.mediaSessionId ?? entry.mediaSessionId;
    if (data.bindingToken) {
      entry.pendingBindToken = data.bindingToken;
    }
    // StreamId/password are VDO credentials returned only to this viewer.
    if (data.streamId && data.password) {
      // ViewerClient creation is performed by the runtime layer
      // (Dashboard wiring). The manager only stores the metadata.
      entry.viewerClient = {
        streamId: data.streamId,
        password: data.password,
        // Creation is performed lazily by the runtime in
        // response to the bind acknowledgement.
      };
    }
    return true;
  }

  /**
   * Receive a binding acknowledgement from the host. The host sends
   * this once `media.bind` has been validated; on success the entry
   * is moved to "connected" and the local media element can begin
   * receiving the remote MediaStream.
   */
  handleBindAck(envelope: GroupControlEnvelope): boolean {
    const parsed = parseGroupMessagePayload("stream.bind.ack", envelope.payload);
    if (!parsed.ok) return false;
    const data = parsed.data;
    const entry = this.entries.get(
      keyOf({
        groupId: envelope.groupId,
        hostDeviceId: data.hostDeviceId ?? envelope.senderDeviceId,
        logicalStreamId: data.logicalStreamId,
      }),
    );
    if (!entry) return false;
    if (entry.mediaSessionId !== data.mediaSessionId) return false;
    if (data.viewerDeviceId !== (this.runtime.deviceId ?? "viewer")) return false;
    if (!data.accepted) {
      entry.connectionState = "failed";
      entry.errorReason = data.reason ?? "bind-rejected";
    } else {
      entry.connectionState = "connected";
      entry.mediaPeerUuid = data.boundMediaPeer ?? entry.mediaPeerUuid;
    }
    return true;
  }

  /**
   * Apply a stream.restarted announcement: the logical stream ID
   * stays the same but the mediaSessionId changes. The watched entry
   * transparently reconnects — it keeps the user-visible mute/volume
   * state and re-issues a join request with the new mediaSessionId.
   */
  async handleStreamRestarted(envelope: GroupControlEnvelope): Promise<void> {
    const parsed = parseGroupMessagePayload("stream.restarted", envelope.payload);
    if (!parsed.ok) return;
    const data = parsed.data;
    const entry = this.entries.get(
      keyOf({
        groupId: data.groupId,
        hostDeviceId: data.hostDeviceId,
        logicalStreamId: data.logicalStreamId,
      }),
    );
    if (!entry) return;
    entry.connectionState = "reconnecting";
    entry.mediaSessionId = data.mediaSessionId;
    entry.viewerClient = null;
    entry.pendingBindToken = null;
    // Replay a join request for the new media session.
    const conn = this.runtime.getConnectionManager().getConnection(data.groupId);
    const peerUuid = conn?.peerForDevice(data.hostDeviceId);
    if (conn && peerUuid) {
      const requestId = crypto.randomUUID();
      entry.pendingJoinRequestId = requestId;
      try {
        await conn.sendToPeer(peerUuid, {
          type: "stream.join.request",
          logicalStreamId: data.logicalStreamId,
          viewerDeviceId: this.runtime.deviceId ?? "viewer",
          requestId,
        } as unknown as Record<string, unknown>);
      } catch {
        entry.connectionState = "failed";
        entry.errorReason = "rejoin-failed";
      }
    }
  }

  /**
   * Apply a stream.stopped announcement: tear down the watched entry
   * and clear all resources.
   */
  handleStreamStopped(envelope: GroupControlEnvelope): void {
    const parsed = parseGroupMessagePayload("stream.stopped", envelope.payload);
    if (!parsed.ok) return;
    const data = parsed.data;
    const k = keyOf({
      groupId: data.groupId,
      hostDeviceId: data.hostDeviceId,
      logicalStreamId: data.logicalStreamId,
    });
    const entry = this.entries.get(k);
    if (!entry) return;
    entry.connectionState = "closed";
    this.teardown(entry);
    this.entries.delete(k);
  }

  /**
   * Stop watching. Idempotent. Cleans up the entry, releases any
   * tracked media resources, and preserves mute/volume state only
   * for the call duration (they are not retained across stop).
   */
  stopWatch(input: WatchedStreamKey): void {
    const k = keyOf(input);
    const entry = this.entries.get(k);
    if (!entry) return;
    this.teardown(entry);
    this.entries.delete(k);
  }

  /**
   * Update the requested quality for a watched stream. The host
   * applies the request; the manager also stores the requested
   * settings locally so the UI can show what was requested even
   * before the host responds.
   */
  setRequestedQuality(input: WatchedStreamKey, request: ViewerQualityRequest | null): void {
    const entry = this.entries.get(keyOf(input));
    if (!entry) return;
    entry.requested = request;
  }

  /**
   * Apply a configuration or observation update received from the
   * host. Concrete shape is opaque to the manager — the runtime
   * layer deserializes and stores it for the UI.
   */
  setConfigured(input: WatchedStreamKey, value: unknown): void {
    const entry = this.entries.get(keyOf(input));
    if (entry) entry.configured = value;
  }

  setObserved(input: WatchedStreamKey, value: unknown): void {
    const entry = this.entries.get(keyOf(input));
    if (entry) entry.observed = value;
  }

  setMute(input: WatchedStreamKey, mute: boolean): void {
    const entry = this.entries.get(keyOf(input));
    if (entry) entry.mute = mute;
  }

  setVolume(input: WatchedStreamKey, volume: number): void {
    const entry = this.entries.get(keyOf(input));
    if (entry) entry.volume = Math.max(0, Math.min(1, volume));
  }

  get(input: WatchedStreamKey): WatchedStreamEntry | null {
    return this.entries.get(keyOf(input)) ?? null;
  }

  list(): WatchedStreamEntry[] {
    return Array.from(this.entries.values());
  }

  destroy(): void {
    this.destroyed = true;
    for (const entry of this.entries.values()) {
      this.teardown(entry);
    }
    this.entries.clear();
  }

  private teardown(entry: WatchedStreamEntry): void {
    entry.connectionState = "closed";
    entry.viewerClient = null;
    entry.pendingBindToken = null;
    entry.pendingJoinRequestId = null;
    entry.mediaPeerUuid = null;
  }
}
