import { useStore } from "../stores/main-store.js";
import {
  buildEnvelope,
  validateEnvelopeTimestamp,
  isDuplicateMessage,
  generateMessageId,
  ControlEnvelope,
  ControlMessageType,
  MAX_CONTROL_PAYLOAD_BYTES,
  DEDUP_WINDOW_MS,
} from "@screenlink/shared";
import type { DegradationPreference } from "@screenlink/vdo-adapter";

/** Connection role for a given peer UUID. */
type ConnectionRole = "viewer" | "publisher" | "unknown";

/** Shorthand for the screenlink API from the window object. */
function getApi() {
  return (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
}

function notifyPairingUpdated(): void {
  window.dispatchEvent(new CustomEvent("screenlink:pairing-updated"));
}

function patchVdoNinjaSdk(Ctor: InstanceType<typeof window.VDONinjaSDK> extends never ? any : any): void {
  const proto = Ctor?.prototype as Record<string, unknown> | undefined;
  if (!proto || proto.__screenlinkPatchedFindConnection) return;

  if (typeof proto._getConnection === "function" && typeof proto._findConnection !== "function") {
    proto._findConnection = function findConnection(uuid: string) {
      return (this as { _getConnection?: (id: string, type?: string) => unknown })._getConnection?.(uuid);
    };
  }

  proto.__screenlinkPatchedFindConnection = true;
}

class ControlConnection {
  private sdk: InstanceType<typeof window.VDONinjaSDK> | null = null;
  private seenMessageIds = new Set<string>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeRetryTimer: ReturnType<typeof setInterval> | null = null;
  private peerUuid: string | null = null;
  /** Maps peer UUID → role for correct sendData routing. */
  private peerRoles = new Map<string, ConnectionRole>();
  private localDeviceId = "";
  private localDisplayName = "";
  private pairId = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnected = false;
  private isDestroyed = false;

  /** Start the control connection using stored pairing config */
  async start(): Promise<void> {
    const api = getApi();
    if (!api) return;

    const config = await api.getPairingConfig();
    const pairSecret = await api.getPairSecret();

    if (!config || !pairSecret) {
      useStore.getState().setPairingState("unpaired");
      return;
    }

    const cfg = config as Record<string, unknown>;
    this.localDeviceId = (cfg.localDeviceId as string) || crypto.randomUUID();
    this.localDisplayName = (cfg.localDisplayName as string) || "ScreenLink User";
    this.pairId = (cfg.pairId as string) || "";

    // ── Preload trusted remote identity from persisted config ──────────
    // This ensures the Dashboard/Settings UI shows the correct friend name
    // on app restart before any handshake occurs.
    const persistedRemoteDeviceId = cfg.remoteDeviceId as string | undefined;
    const persistedRemoteDisplayName = cfg.remoteDisplayName as string | undefined;
    const lifecycle = (cfg.pairingLifecycle as string) || "";

    if (persistedRemoteDeviceId && persistedRemoteDisplayName) {
      useStore.getState().setFriendInfo(persistedRemoteDeviceId, persistedRemoteDisplayName);
    }

    // Set store pairing state based on persisted lifecycle.
    // IMPORTANT: Do NOT transition to PAIR_CONNECTED_UNCONFIRMED here —
    // that only happens when a real data channel opens.
    if (lifecycle === "PAIRED_ONLINE") {
      useStore.getState().setPairingState("PAIRED_OFFLINE");
    } else if (lifecycle === "PAIRED_OFFLINE") {
      useStore.getState().setPairingState("PAIRED_OFFLINE");
    } else if (lifecycle === "PAIR_CREATED_WAITING_FOR_IMPORT") {
      useStore.getState().setPairingState("PAIR_CREATED_WAITING_FOR_IMPORT");
    } else if (lifecycle === "PAIR_IMPORTED_CONNECTING") {
      useStore.getState().setPairingState("PAIR_IMPORTED_CONNECTING");
    } else {
      // Fallback for any other/empty lifecycle
      useStore.getState().setPairingState("PAIR_IMPORTED_CONNECTING");
    }

    await this.connectToVDO(pairSecret);
  }

  private async connectToVDO(pairSecret: string): Promise<void> {
    try {
      const Ctor = window.VDONinjaSDK ?? window.VDONinja;
      if (!Ctor) throw new Error("VDO.Ninja SDK not loaded");

      patchVdoNinjaSdk(Ctor);

      this.sdk = new Ctor({
        host: "wss://wss.vdo.ninja",
        password: pairSecret,
        salt: "vdo.ninja",
        debug: true,
        turnServers: null,
        forceTURN: false,
        maxReconnectAttempts: 10,
        reconnectDelay: 1000,
      });

      // Set up event listeners
      this.sdk.on("connected", () => {
        console.log("[Control] Connected to VDO.Ninja signaling");
        this.isConnected = true;
        // NOTE: Do NOT transition to PAIR_CONNECTED_UNCONFIRMED here.
        // Signaling connection is not the same as peer connection.
        // Stay in current lifecycle (PAIR_CREATED_WAITING_FOR_IMPORT,
        // PAIR_IMPORTED_CONNECTING, or PAIRED_OFFLINE) until a real
        // data channel opens.
      });

      this.sdk.on("disconnected", () => {
        console.log("[Control] Disconnected from signaling");
        this.isConnected = false;
        this.peerUuid = null;
        this.peerRoles.clear();
        this.stopHandshakeRetry();

        // Transition to PAIRED_OFFLINE if trusted identity exists,
        // or stay in pre-handshake states otherwise.
        const currentState = useStore.getState().pairingState;
        if (
          currentState === "PAIRED_ONLINE" ||
          currentState === "PAIR_CONNECTED_UNCONFIRMED"
        ) {
          useStore.getState().setPairingState("PAIRED_OFFLINE");
          // Persist offline lifecycle so restart shows correct state
          this.persistLifecycle("PAIRED_OFFLINE");
        }

        // Do NOT blank friend info — trusted remote identity remains visible.
        useStore.getState().setRemoteShareState("remote-offline");
      });

      // When a data channel opens, track its role
      this.sdk.on("dataChannelOpen", (data: unknown) => {
        const evt = (data as CustomEvent).detail || data;
        const uuid = typeof evt === "object"
          ? (evt as Record<string, unknown>).uuid as string
          : "";
        const role = (typeof evt === "object"
          ? (evt as Record<string, unknown>).type as string
          : "") as ConnectionRole;

        console.log("[Control] Data channel opened, peer UUID:", uuid?.slice(0, 8), "role:", role);
        this.peerUuid = uuid;

        if (role === "viewer" || role === "publisher") {
          this.peerRoles.set(uuid, role);
        }

        // NOW we have a real peer — transition to PAIR_CONNECTED_UNCONFIRMED
        useStore.getState().setPairingState("PAIR_CONNECTED_UNCONFIRMED");

        // Send hello/request immediately, then retry until paired.
        this.sendHello();
        const req = buildEnvelope("state.request", this.localDeviceId, {});
        this.sendMessage(req);
        this.startHandshakeRetry();
      });

      this.sdk.on("dataChannelClose", () => {
        console.log("[Control] Data channel closed");
        this.peerUuid = null;
        this.stopHandshakeRetry();
        useStore.getState().setRemoteShareState("remote-offline");
        // Do NOT blank friend info — trusted remote identity stays visible.
        const currentState = useStore.getState().pairingState;
        if (currentState === "PAIRED_ONLINE" || currentState === "PAIR_CONNECTED_UNCONFIRMED") {
          useStore.getState().setPairingState("PAIRED_OFFLINE");
          this.persistLifecycle("PAIRED_OFFLINE");
        }
      });

      this.sdk.on("dataReceived", (data: unknown) => {
        this.handleMessage(data);
      });

      this.sdk.on("peerConnected", (...args: unknown[]) => {
        console.log("[Control] Peer connected:", args);
      });

      this.sdk.on("peerDisconnected", (uuid: string) => {
        console.log("[Control] Peer disconnected:", uuid);
        if (this.peerUuid === uuid) {
          this.peerUuid = null;
          this.peerRoles.delete(uuid);
          this.stopHandshakeRetry();
          useStore.getState().setRemoteShareState("remote-offline");
          // Do NOT blank friend info — trusted remote identity stays visible.
          const currentState = useStore.getState().pairingState;
          if (currentState === "PAIRED_ONLINE") {
            useStore.getState().setPairingState("PAIRED_OFFLINE");
            this.persistLifecycle("PAIRED_OFFLINE");
          }
        }
      });

      this.sdk.on("error", (err: unknown) => {
        console.error("[Control] SDK error:", err);
        useStore.getState().setPairingState("error");
      });

      this.sdk.on("connectionFailed", () => {
        console.error("[Control] Connection failed");
        useStore.getState().setPairingState("error");
      });

      // Connect to signaling
      await this.sdk.connect();
      console.log("[Control] SDK connect() completed");

      // Step 1: Join the pair room
      await this.sdk.joinRoom({ room: this.pairId });
      console.log("[Control] Joined room:", this.pairId);

      // Step 2: Announce our presence (data-only, no media)
      const myStreamID = await this.sdk.announce({
        streamID: this.localDeviceId,
        room: this.pairId,
        label: this.localDisplayName,
      });
      console.log("[Control] Announced as:", myStreamID);

      // Step 3: Listen for remote peer streams and view them.
      // Friend identity is NOT set here — only from validated peer.hello.

      this.sdk.on("listing", (data: unknown) => {
        const evt = (data as CustomEvent).detail || data;
        const list = (evt as Record<string, unknown>).list as Array<unknown> || [];
        console.log("[Control] Room listing:", list.length, "streams");
        for (const item of list) {
          const streamInfo = typeof item === "string" ? { streamID: item } : item as Record<string, unknown>;
          const sid = streamInfo.streamID as string;
          if (sid && sid !== myStreamID) {
            console.log("[Control] Found remote stream, viewing:", sid.slice(0, 16));
            this.viewRemoteStream(sid);
          }
        }
      });

      this.sdk.on("videoaddedtoroom", (data: unknown) => {
        const evt = (data as CustomEvent).detail || data;
        const sid = (evt as Record<string, unknown>).streamID as string;
        if (sid && sid !== myStreamID) {
          console.log("[Control] New stream in room, viewing:", sid.slice(0, 16));
          this.viewRemoteStream(sid);
        }
      });

      if (this.sdk.streams) {
        for (const [sid] of this.sdk.streams) {
          if (sid && sid !== myStreamID) {
            console.log("[Control] Existing stream, viewing:", sid.slice(0, 16));
            this.viewRemoteStream(sid);
          }
        }
      }

      // Dedup cleanup every 5 minutes
      this.dedupCleanupTimer = setInterval(() => {
        this.seenMessageIds.clear();
      }, 5 * 60 * 1000);

    } catch (err) {
      console.error("[Control] Failed to connect:", err);
      useStore.getState().setPairingState("error");
      this.scheduleReconnect();
    }
  }

  /** Persist a lifecycle transition to the main process. */
  private persistLifecycle(lifecycle: string): void {
    const api = getApi();
    api?.setPairingLifecycle(lifecycle).then(() => {
      notifyPairingUpdated();
    }).catch(() => {});
  }

  private startHandshakeRetry(): void {
    this.stopHandshakeRetry();
    this.handshakeRetryTimer = setInterval(() => {
      if (!this.sdk || !this.peerUuid) return;
      if (useStore.getState().pairingState === "PAIRED_ONLINE") {
        this.stopHandshakeRetry();
        return;
      }

      this.sendHello();
      const req = buildEnvelope("state.request", this.localDeviceId, {});
      this.sendMessage(req);
    }, 1000);
  }

  private stopHandshakeRetry(): void {
    if (this.handshakeRetryTimer) {
      clearInterval(this.handshakeRetryTimer);
      this.handshakeRetryTimer = null;
    }
  }

  private async viewRemoteStream(hashedStreamId: string): Promise<void> {
    if (!this.sdk) return;
    try {
      await this.sdk.view(hashedStreamId, {
        audio: false,
        video: false,
        label: this.localDisplayName,
      });
      console.log("[Control] View request sent for stream:", hashedStreamId.slice(0, 16));
    } catch (err) {
      console.warn("[Control] Failed to view remote stream:", err);
    }
  }

  private sendHello(): void {
    if (!this.sdk) return;
    const envelope = buildEnvelope("peer.hello", this.localDeviceId, {
      deviceId: this.localDeviceId,
      displayName: this.localDisplayName,
      protocolVersion: 1,
      appVersion: "0.1.0",
      isCurrentlySharing: useStore.getState().localShareState === "sharing",
    });
    this.sendMessage(envelope);
  }

  sendStateResponse(): void {
    const st = useStore.getState();
    const payload: Record<string, unknown> = {
      isSharing: st.localShareState === "sharing",
    };
    if (st.localShareState === "sharing") {
      payload.mediaSessionId = st.localMediaSessionId;
      payload.streamId = st.localStreamId;
      payload.mediaPassword = st.localMediaPassword;
      payload.captureWidth = st.captureWidth;
      payload.captureHeight = st.captureHeight;
      payload.captureFps = st.captureFps;
      payload.systemAudio = false;
      payload.contentHint = "detail";
    }
    const envelope = buildEnvelope("state.response", this.localDeviceId, payload);
    this.sendMessage(envelope);
  }

  sendShareStarted(): void {
    const st = useStore.getState();
    const payload = {
      mediaSessionId: st.localMediaSessionId,
      streamId: st.localStreamId,
      mediaPassword: st.localMediaPassword,
      captureWidth: st.captureWidth,
      captureHeight: st.captureHeight,
      captureFps: st.captureFps,
      systemAudio: false,
      contentHint: "detail",
    };
    const envelope = buildEnvelope("share.started", this.localDeviceId, payload);
    this.sendMessage(envelope);
  }

  sendShareStopped(): void {
    const st = useStore.getState();
    const envelope = buildEnvelope("share.stopped", this.localDeviceId, {
      mediaSessionId: st.localMediaSessionId,
    });
    this.sendMessage(envelope);
  }

  sendPing(): void {
    const envelope = buildEnvelope("ping", this.localDeviceId, {});
    this.sendMessage(envelope);
  }

  // ── Message handling ─────────────────────────────────────

  private handleMessage(data: unknown): void {
    try {
      let envelope: ControlEnvelope;
      let transportUuid = "";

      if (data instanceof CustomEvent) {
        const detail = (data as CustomEvent).detail as Record<string, unknown>;
        transportUuid = (detail?.uuid as string | undefined) ?? "";
        envelope = ((detail?.data as ControlEnvelope | undefined) ?? detail) as ControlEnvelope;
      } else {
        const payload = data as Record<string, unknown>;
        transportUuid = (payload?.uuid as string | undefined) ?? "";
        envelope = ((payload?.data as ControlEnvelope | undefined) ?? payload) as ControlEnvelope;
      }

      if (!envelope?.screenlink) return;

      if (envelope.screenlink.version !== 1) return;
      if (envelope.screenlink.senderDeviceId === this.localDeviceId) return;
      if (!validateEnvelopeTimestamp(envelope)) {
        console.warn("[Control] Rejected message with invalid timestamp");
        return;
      }
      if (isDuplicateMessage(this.seenMessageIds, envelope)) return;
      this.seenMessageIds.add(envelope.screenlink.messageId);

      const type = envelope.screenlink.type;
      const payload = envelope.screenlink.payload || {};

      switch (type) {
        case "peer.hello":
          this.handlePeerHello(payload, envelope.screenlink.senderDeviceId, transportUuid);
          const response = buildEnvelope("peer.hello.response", this.localDeviceId, {
            deviceId: this.localDeviceId,
            displayName: this.localDisplayName,
            protocolVersion: 1,
            appVersion: "0.1.0",
            isCurrentlySharing: useStore.getState().localShareState === "sharing",
          });
          this.sendMessage(response);
          this.sendStateResponse();
          break;

        case "peer.hello.response":
          this.handlePeerHello(payload, envelope.screenlink.senderDeviceId, transportUuid);
          break;

        case "state.request":
          this.sendStateResponse();
          break;

        case "state.response":
          this.handleStateResponse(payload);
          break;

        case "share.started":
          this.handleShareStarted(payload);
          break;

        case "share.updated":
          this.handleShareStarted(payload);
          break;

        case "share.stopped":
          this.handleShareStopped(payload);
          break;

        case "quality.request":
          this.handleQualityRequest(payload);
          break;

        case "quality.applied":
          console.log("[Control] Remote peer applied quality:", payload);
          break;

        case "quality.rejected":
          console.log("[Control] Remote peer rejected quality:", payload);
          break;

        case "ping": {
          const pong = buildEnvelope("pong", this.localDeviceId, {});
          this.sendMessage(pong);
          break;
        }

        case "pong":
          break;
      }
    } catch (err) {
      console.error("[Control] Failed to handle message:", err);
    }
  }

  private handlePeerHello(payload: Record<string, unknown>, senderDeviceId: string, transportUuid = ""): void {
    const deviceId = (payload.deviceId as string) || senderDeviceId;
    const displayName = (payload.displayName as string) || "Friend";
    const isSharing = payload.isCurrentlySharing === true;

    console.log(`[Control] Peer hello from "${displayName}" (${deviceId.slice(0, 8)}...) sharing=${isSharing}`);

    const api = getApi();
    if (!api) return;

    // Call IPC — returns authoritative result with acceptance + current state
    api.updateRemoteIdentity(deviceId, displayName).then((result) => {
      if (result.accepted && result.pairingLifecycle) {
        if (transportUuid) {
          this.peerUuid = transportUuid;
        }
        this.stopHandshakeRetry();
        notifyPairingUpdated();

        // Update store from the authoritative IPC result
        useStore.getState().setFriendInfo(
          result.remoteDeviceId || deviceId,
          result.remoteDisplayName || displayName,
        );
        useStore.getState().setPairingState("PAIRED_ONLINE");

        console.log("[Control] Peer hello accepted — now PAIRED_ONLINE");
      } else {
        // Rejected (trust mismatch) — do NOT claim online
        console.log("[Control] Peer hello rejected:", result.reason);
      }

      if (isSharing) {
        const req = buildEnvelope("state.request", this.localDeviceId, {});
        this.sendMessage(req);
      }
    }).catch((err: unknown) => {
      console.warn("[Control] Failed to persist remote identity:", err);
    });
  }

  private handleStateResponse(payload: Record<string, unknown>): void {
    const isSharing = payload.isSharing === true;
    useStore.getState().setFriendSharing(isSharing);

    if (isSharing && payload.streamId && payload.mediaPassword) {
      useStore.getState().setRemoteMediaCredentials(
        (payload.mediaSessionId as string) || "",
        payload.streamId as string,
        payload.mediaPassword as string,
      );
      useStore.getState().setRemoteShareState("remote-share-available");
    } else {
      useStore.getState().clearRemoteMediaCredentials();
      useStore.getState().setRemoteShareState("remote-online-idle");
    }
  }

  private handleShareStarted(payload: Record<string, unknown>): void {
    const streamId = payload.streamId as string;
    const password = payload.mediaPassword as string;
    const sessionId = (payload.mediaSessionId as string) || crypto.randomUUID();

    if (streamId && password) {
      useStore.getState().setRemoteMediaCredentials(sessionId, streamId, password);
      useStore.getState().setFriendSharing(true);
      useStore.getState().setRemoteShareState("remote-share-available");
    }
  }

  private handleShareStopped(payload: Record<string, unknown>): void {
    useStore.getState().clearRemoteMediaCredentials();
    useStore.getState().setFriendSharing(false);
    useStore.getState().setRemoteShareState("remote-online-idle");
  }

  private async handleQualityRequest(payload: Record<string, unknown>): Promise<void> {
    const st = useStore.getState();

    if (!st.allowRemoteQualityRequests) {
      const rejected = buildEnvelope("quality.rejected", this.localDeviceId, {
        requestId: payload.requestId || "",
        code: "REMOTE_QUALITY_DISABLED",
        message: "Remote quality requests are disabled by the host",
      });
      this.sendMessage(rejected);
      return;
    }

    // Get the video sender from the active publisher
    const { getVideoSender, getPublisherConnection, applyQualityToSender } = await import("@screenlink/vdo-adapter");

    // Try to find a publisher SDK connection from window global
    const sdkGlobal = (window as unknown as { __screenlinkPublisherSdk?: { connections: Map<string, unknown> } }).__screenlinkPublisherSdk;
    if (!sdkGlobal) {
      const rejected = buildEnvelope("quality.rejected", this.localDeviceId, {
        requestId: payload.requestId || "",
        code: "NO_SDK",
        message: "No active publisher SDK found",
      });
      this.sendMessage(rejected);
      return;
    }

    let videoSender: RTCRtpSender | undefined;
    for (const [uuid] of sdkGlobal.connections) {
      try {
        const pc = getPublisherConnection(sdkGlobal, uuid);
        videoSender = getVideoSender(pc);
        if (videoSender) break;
      } catch {}
    }

    if (!videoSender) {
      const rejected = buildEnvelope("quality.rejected", this.localDeviceId, {
        requestId: payload.requestId || "",
        code: "NO_SENDER_AVAILABLE",
        message: "No active video sender to configure",
      });
      this.sendMessage(rejected);
      return;
    }

    const result = await applyQualityToSender(videoSender, {
      videoCeilingKbps: (payload.videoCeilingKbps as number) || 1000,
      maxFps: (payload.maxFps as number) || 30,
      targetWidth: (payload.targetWidth as number) || 1280,
      targetHeight: (payload.targetHeight as number) || 720,
      degradationPreference: (payload.degradationPreference as DegradationPreference) || "balanced",
    });

    if ("success" in result && result.success) {
      const applied = buildEnvelope("quality.applied", this.localDeviceId, {
        requestId: payload.requestId || "",
        requested: payload,
        applied: {
          configuredBitrate: result.configuredBitrate,
          scale: result.scale,
        },
      });
      this.sendMessage(applied);
    } else {
      const rejected = buildEnvelope("quality.rejected", this.localDeviceId, {
        requestId: payload.requestId || "",
        code: "APPLY_FAILED",
        message: (result as { error: string }).error,
      });
      this.sendMessage(rejected);
    }
  }

  // ── Send ─────────────────────────────────────────────────

  private sendMessage(envelope: ControlEnvelope): void {
    if (!this.sdk) return;

    if (!this.peerUuid && this.sdk.connections) {
      for (const [uuid] of this.sdk.connections) {
        if (uuid !== this.localDeviceId) {
          this.peerUuid = uuid;
          break;
        }
      }
    }

    if (!this.peerUuid) {
      console.warn("[Control] No peer UUID, cannot send message yet");
      return;
    }

    const payloadSize = JSON.stringify(envelope).length;
    if (payloadSize > MAX_CONTROL_PAYLOAD_BYTES) {
      console.warn("[Control] Message too large, not sending");
      return;
    }

    try {
      this.sdk.sendData(envelope, {
        uuid: this.peerUuid,
        preference: "all",
        allowFallback: true,
      });
    } catch (err) {
      console.error("[Control] Failed to send message:", err);
    }
  }

  // ── Reconnect ─────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.isDestroyed) return;
    this.reconnectTimer = setTimeout(() => {
      if (!this.isDestroyed) {
        this.start();
      }
    }, 5000);
  }

  // ── Restart ────────────────────────────────────────────────

  /**
   * Safely tear down and restart the control connection.
   * This is called after create/import/clear so that both sides
   * connect to the VDO control room without requiring app restart.
   *
   * Idempotent — safe to call multiple times. If the SDK is already
   * active it is destroyed first, then start() is called fresh.
   */
  async restart(): Promise<void> {
    // Tear down existing connection fully
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.dedupCleanupTimer) clearInterval(this.dedupCleanupTimer);
    this.stopHandshakeRetry();
    if (this.sdk) {
      try { this.sdk.disconnect(); } catch {}
      this.sdk = null;
    }
    this.peerUuid = null;
    this.peerRoles.clear();
    this.seenMessageIds.clear();
    this.isConnected = false;
    // Reset destroyed flag so start() can proceed
    this.isDestroyed = false;
    // Start fresh
    await this.start();
  }

  // ── Cleanup ───────────────────────────────────────────────

  destroy(): void {
    this.isDestroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.dedupCleanupTimer) clearInterval(this.dedupCleanupTimer);
    this.stopHandshakeRetry();
    if (this.sdk) {
      try { this.sdk.disconnect(); } catch {}
      this.sdk = null;
    }
    this.peerUuid = null;
    this.peerRoles.clear();
    this.seenMessageIds.clear();
    this.isConnected = false;
  }

  isActive(): boolean {
    return this.isConnected && this.sdk !== null;
  }

  getPeerUuid(): string | null {
    return this.peerUuid;
  }
}

let instance: ControlConnection | null = null;

export function getControlConnection(): ControlConnection {
  if (!instance) {
    instance = new ControlConnection();
  }
  return instance;
}

/**
 * Safely restart the control connection singleton.
 * Safe to call even if the connection was never started or was destroyed.
 */
export async function restartControlConnection(): Promise<void> {
  const ctrl = getControlConnection();
  await ctrl.restart();
}

export function destroyControlConnection(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
