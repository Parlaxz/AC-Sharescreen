import type {
  GroupControlEnvelope,
  GroupControlEnvelopeInput,
  GroupMemberRecord,
  HybridTimestamp,
} from "@screenlink/shared";
import {
  GROUP_PROTOCOL_VERSION,
  buildEnvelope,
  validateEnvelope,
  DedupSet,
} from "@screenlink/shared";
import { getSDKConstructor } from "@screenlink/vdo-adapter";
import { extractPeerUuid, extractDataAndUuid } from "./sdk-event-normalizer.js";

export type ConnectionState = "idle" | "starting" | "connected" | "reconnecting" | "stopping" | "destroyed" | "failed";

export interface ControlMeshDiagnostics {
  connected: boolean;
  peerCount: number;
  peerIds: string[];
  peerRtts: Record<string, number | undefined>;
  signalingServer: string;
  roomId: string;
}

/**
 * Result of a broadcast operation.
 */
export interface BroadcastResult {
  attempted: number;
  sent: number;
  failed: number;
}

export interface GroupControlConnectionOptions {
  groupId: string;
  controlRoomId: string;
  groupSecret: string;
  nodeId: string;
  displayName: string;
  memberRecord: GroupMemberRecord | null;
  onPeerOnline: (deviceId: string, displayName: string) => void;
  onPeerOffline: (deviceId: string) => void;
  onMessage: (envelope: GroupControlEnvelope) => void;
  onStateChange: (state: ConnectionState) => void;
  onError: (error: Error) => void;
  /**
   * Called when a group.hello or group.hello.response is received and the
   * sender identity has been authenticated (HMAC-envelope verified). The
   * callback receives the sender device ID, the member record included in
   * the hello, and the full validated envelope.
   */
  onAuthenticatedHello?: (
    deviceId: string,
    memberRecord: GroupMemberRecord | null,
    envelope: GroupControlEnvelope,
  ) => void;
}

function makeClock(nodeId: string, now?: number): HybridTimestamp {
  return { wallTimeMs: now ?? Date.now(), counter: 0, nodeId };
}

function makeInput(
  type: string,
  senderDeviceId: string,
  groupId: string,
  payload: Record<string, unknown>,
  stamp: HybridTimestamp,
): GroupControlEnvelopeInput {
  return {
    version: GROUP_PROTOCOL_VERSION,
    type: type as GroupControlEnvelopeInput["type"],
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    senderDeviceId,
    groupId,
    logicalStamp: stamp,
    payload,
  };
}

/**
 * The actual shape of the installed `@vdoninja/sdk` 1.3.18 instance.
 *
 * The data-only mesh lifecycle used here is:
 *
 *   1. `autoConnect()`     — combines connect() + joinRoom() + announce()
 *   2. `sendData()`        — push authenticated envelopes to peers
 *
 * The mesh is "connected" only after the SDK signals the mesh is ready.
 * Room identity = controlRoomId; media publication is a separate
 * SDK instance owned by PublisherManager.
 *
 * `autoConnect` returns `{ stop: () => void, streamID: string }`.
 *
 * sendData(payload, options) returns boolean indicating whether anything
 * was accepted for delivery.
 */
type VDONinjaSDKInstance = {
  VERSION?: string;
  state?: {
    connected?: boolean;
    publishing?: boolean;
    viewing?: boolean;
    roomJoined?: boolean;
    room?: string;
  };
  streams?: Map<string, unknown>;
  connections?: Map<string, unknown>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  joinRoom(options: { room: string; password?: string; uuid?: string }): Promise<void>;
  leaveRoom(): Promise<void>;
  announce(options: { streamID?: string }): Promise<string>;
  view(streamId: string, options?: unknown): Promise<unknown>;
  stopViewing(streamId?: string): Promise<void>;
  sendData(payload: unknown, options: {
    uuid: string;
    allowFallback: boolean;
    preference?: string;
  }): boolean;
  autoConnect(options: {
    room: string;
    mode?: "half" | "full";
    view?: { audio?: boolean; video?: boolean };
    password?: string;
    streamID?: string;
    label?: string;
  }): Promise<{ stop: () => void; streamID: string }>;
  addEventListener(event: string, listener: (...args: unknown[]) => void): void;
  removeEventListener(event: string, listener: (...args: unknown[]) => void): void;
};

/** Per-instance event listener references so we can remove them on destroy. */
interface BoundHandlers {
  peerConnected: (event: unknown) => void;
  peerDisconnected: (event: unknown) => void;
  dataChannelOpen: (event: unknown) => void;
  dataChannelClose: (event: unknown) => void;
  dataReceived: (data: unknown, peerUuid?: unknown) => void;
  disconnected: (event: unknown) => void;
  reconnected: (event: unknown) => void;
  reconnectFailed: (event: unknown) => void;
  roomJoined: (event: unknown) => void;
  error: (event: unknown) => void;
}

/** Handle returned by autoConnect — invoked on destroy to clean up the mesh. */
interface MeshStopHandle {
  stop: () => void;
  streamID: string;
}

/** Deadline for sdk.autoConnect() — prevents state being stuck in "starting". */
const AUTO_CONNECT_TIMEOUT_MS = 15_000;

/** Fast-phase interval between hello retries for peers that never completed handshake. */
const HELLO_RETRY_INTERVAL_MS = 2_000;

/**
 * Number of fast-phase hello resends per peer before falling back to the
 * slow steady-state schedule (the peer is never given up on).
 */
const HELLO_MAX_RETRIES = 3;

/** Steady-state interval between hello retries after the fast phase. */
const HELLO_SLOW_RETRY_INTERVAL_MS = 10_000;

export class GroupControlConnection {
  private sdk: VDONinjaSDKInstance | null = null;
  private handlers: BoundHandlers | null = null;
  /** Handle returned by autoConnect — invoked on destroy/teardown. */
  private meshStop: MeshStopHandle | null = null;
  /** Peer UUIDs with an open data channel (raw SDK-level). */
  private rawDataPeers = new Set<string>();
  /** Authenticated peer-UUID → device-ID mapping (post-handshake). */
  private peerToDevice = new Map<string, string>();
  private deviceToPeer = new Map<string, string>();
  /** Last identity claimed by each raw peer UUID (validated hellos). */
  private rawPeerIdentity = new Map<string, string>();
  private _state: ConnectionState = "idle";
  private opts: GroupControlConnectionOptions;
  private destroyed = false;
  private startGeneration = 0;
  private dedupSet = new DedupSet();
  private clock: HybridTimestamp;
  /** Pending hello responses to throttle duplicates. */
  private peersAwaitingHello = new Set<string>();
  /** Hello retry attempts per peer UUID (fast phase counted by HELLO_MAX_RETRIES). */
  private helloRetryAttempts = new Map<string, number>();
  /** Interval timer resending hellos to peers still awaiting a response. */
  private helloRetryTimer: ReturnType<typeof setInterval> | null = null;
  /** Timestamp of the last observed raw-peer activity (route open or authenticated traffic). */
  private lastRawPeerActivityAt = 0;
  /** Timestamp of the last mesh-discovery refresh attempt (cooldown gate). */
  private lastMeshRefreshAt = 0;

  constructor(opts: GroupControlConnectionOptions) {
    this.opts = opts;
    this.clock = makeClock(opts.nodeId);
  }

  get state(): ConnectionState {
    return this._state;
  }

  get groupId(): string {
    return this.opts.groupId;
  }

  /**
   * Authenticated connected peers (device IDs with completed handshake).
   */
  get connectedPeers(): string[] {
    return Array.from(this.peerToDevice.keys());
  }

  /**
   * Raw data-channel peer UUIDs (not yet authenticated).
   */
  get rawDataPeerUuids(): string[] {
    return Array.from(this.rawDataPeers);
  }

  get knownDevices(): Map<string, string> {
    return new Map(this.deviceToPeer);
  }

  getDiagnostics(): ControlMeshDiagnostics {
    return {
      connected: this._state === "connected",
      peerCount: this.peerToDevice.size,
      peerIds: Array.from(this.peerToDevice.keys()),
      peerRtts: {},
      signalingServer: "wss://wss.vdo.ninja",
      roomId: this.opts.controlRoomId,
    };
  }

  peerForDevice(deviceId: string): string | null {
    return this.deviceToPeer.get(deviceId) ?? null;
  }

  deviceForPeer(peerUuid: string): string | null {
    return this.peerToDevice.get(peerUuid) ?? null;
  }

  /**
   * Start the data-only control mesh using the SDK's autoConnect helper:
   *
   *   autoConnect() internally performs:
   *     1. connect()        — establish the signaling WebSocket
   *     2. joinRoom()       — enter the data-only control room
   *     3. announce()       — make this peer discoverable
   *
   * The mesh is considered "connected" once autoConnect resolves.
   *
   * The SDK is constructed with the WebSocket signaling URL at
   * wss://wss.vdo.ninja (never https://api.vdo.ninja). The group
   * secret is used both as the SDK encryption password and the room
   * password. HMAC envelope validation provides the application-level
   * authentication layer.
   */
  async start(): Promise<void> {
    if (this.destroyed) return;
    if (this._state === "starting" || this._state === "connected") return;
    this.startGeneration++;
    const gen = this.startGeneration;
    this.setState("starting");

    // Deadline race state for sdk.autoConnect() — see below.
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const ctor = getSDKConstructor();
      console.log("[group-control] constructing SDK with WebSocket host: wss://wss.vdo.ninja");
      const sdk = new (ctor as unknown as new (opts: unknown) => VDONinjaSDKInstance)({
        host: "wss://wss.vdo.ninja",
        password: this.opts.groupSecret,
        salt: this.opts.groupSecret.slice(0, 16),
        debug: false,
        maxReconnectAttempts: 5,
        reconnectDelay: 2000,
        // Data-only: no auto-pings, no media publication.
      });

      this.sdk = sdk;
      this.setupEventHandlers(gen);

      // Use autoConnect which combines connect() + joinRoom() + announce()
      // with a data-only mesh (audio: false, video: false).
      console.log("[group-control] starting autoConnect (WebSocket + room join + announce)");
      const autoConnectPromise = sdk.autoConnect({
        room: this.opts.controlRoomId,
        mode: "half",
        view: { audio: false, video: false },
        password: this.opts.groupSecret,
        streamID: this.opts.nodeId,
        label: this.opts.displayName,
      });

      // Race autoConnect against a deadline so a never-settling SDK cannot
      // leave the connection stuck in "starting" forever.
      const timeoutPromise = new Promise<never>((_, rejectTimeout) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          rejectTimeout(new Error(`autoConnect did not settle within ${AUTO_CONNECT_TIMEOUT_MS}ms`));
        }, AUTO_CONNECT_TIMEOUT_MS);
      });

      // If autoConnect settles after the timeout already fired, clean up its
      // result — but only when this generation still owns the connection.
      // A newer start()/destroy() owns teardown at that point, and tearing
      // down here would destroy the newer SDK.
      void autoConnectPromise.then(
        (lateResult) => {
          if (!timedOut) return; // winner — handled by the await below
          if (gen !== this.startGeneration || this.destroyed) return;
          try { lateResult.stop(); } catch { /* best effort */ }
          void this.teardownSdk().catch(() => {});
        },
        () => {
          // Late rejection after timeout — the catch below already tore down
          // (or a newer generation owns cleanup). Nothing to do.
        },
      );

      const result = await Promise.race([autoConnectPromise, timeoutPromise]);
      clearTimeout(timeoutHandle);
      if (gen !== this.startGeneration || this.destroyed) {
        result.stop();
        await this.teardownSdk().catch(() => {});
        return;
      }

      this.meshStop = result;
      console.log("[group-control] mesh ready — room:", this.opts.controlRoomId);

      this.setState("connected");
      this.lastRawPeerActivityAt = Date.now();
      // Do NOT broadcastHello here. The first hello is driven by
      // dataChannelOpen so we only send hellos once a usable route exists.
    } catch (err) {
      clearTimeout(timeoutHandle);
      if (this.destroyed || gen !== this.startGeneration) return;
      this.setState("failed");
      const sanitized = err instanceof Error ? err.message : String(err);
      console.error("[group-control] mesh setup failed:", sanitized);
      this.opts.onError(
        err instanceof Error
          ? new Error(`Group control setup failed: ${sanitized}`)
          : new Error(String(err)),
      );
      await this.teardownSdk().catch(() => {});
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.startGeneration++;
    this.setState("destroyed");
    // Invoke the autoConnect stop handle first to clean up the mesh lifecycle
    // (removes event listeners, stops viewing, leaves the room).
    if (this.meshStop) {
      try { this.meshStop.stop(); } catch { /* best effort */ }
      this.meshStop = null;
    }
    await this.teardownSdk();
    this.clearHelloRetryTimer();
    const allDeviceIds = Array.from(this.deviceToPeer.keys());
    this.peerToDevice.clear();
    this.deviceToPeer.clear();
    this.rawPeerIdentity.clear();
    this.peersAwaitingHello.clear();
    this.helloRetryAttempts.clear();
    this.rawDataPeers.clear();
    for (const deviceId of allDeviceIds) {
      this.opts.onPeerOffline(deviceId);
    }
  }

  /**
   * Send an envelope to a specific peer.
   *
   * Returns true if the SDK accepted the message for delivery,
   * false if no SDK, no usable route, or the SDK reported nothing sent.
   */
  async sendToPeer(peerUuid: string, payload: Record<string, unknown>): Promise<boolean> {
    if (!peerUuid || peerUuid.length === 0) {
      console.warn("[group-control] sendToPeer: empty peer UUID");
      return false;
    }
    if (!this.sdk) {
      console.warn("[group-control] sendToPeer: no SDK (not connected)");
      return false;
    }
    // Reject send to peers without a usable raw data-channel route.
    // The peer must have signaled dataChannelOpen (even if not yet
    // authenticated) for us to have confidence data will arrive.
    if (!this.rawDataPeers.has(peerUuid)) {
      console.warn("[group-control] sendToPeer: no usable data-channel route to", peerUuid);
      return false;
    }
    // Strip `type` from the payload — it is used for the envelope's top-level
    // type field and must NOT be in the payload object, or `.strict()` Zod
    // schemas on the receiving end will reject it.
    const { type: _msgType, ...strippedPayload } = payload;
    const input = makeInput(payload.type as string, this.opts.nodeId, this.opts.groupId, strippedPayload, this.clock);
    const envelope = await buildEnvelope(input, this.opts.groupSecret);
    const sent = this.sdk.sendData(envelope as unknown as Record<string, unknown>, {
      uuid: peerUuid,
      preference: "any",
      allowFallback: false,
    });
    if (!sent) {
      console.warn("[group-control] sendToPeer: SDK reported nothing sent to", peerUuid);
    }
    return sent;
  }

  /**
   * Send an envelope to all connected peers.
   *
   * Returns BroadcastResult with counts of attempted/sent/failed peers.
   * Does NOT throw on individual peer failures.
   */
  async broadcast(payload: Record<string, unknown>): Promise<BroadcastResult> {
    if (!this.sdk) {
      console.warn("[group-control] broadcast: no SDK (not connected)");
      return { attempted: 0, sent: 0, failed: 0 };
    }
    // Strip `type` from the payload — it is used for the envelope's top-level
    // type field and must NOT be in the payload object, or `.strict()` Zod
    // schemas on the receiving end will reject it.
    const { type: _msgType, ...strippedPayload } = payload;
    const input = makeInput(payload.type as string, this.opts.nodeId, this.opts.groupId, strippedPayload, this.clock);
    const envelope = await buildEnvelope(input, this.opts.groupSecret);
    const peers = this.connectedPeers;
    if (peers.length === 0) {
      return { attempted: 0, sent: 0, failed: 0 };
    }
    let sent = 0;
    let failed = 0;
    for (const peerUuid of peers) {
      try {
        const ok = this.sdk.sendData(envelope as unknown as Record<string, unknown>, {
          uuid: peerUuid,
          preference: "any",
          allowFallback: false,
        });
        if (ok) sent++; else failed++;
      } catch {
        failed++;
      }
    }
    const result: BroadcastResult = { attempted: peers.length, sent, failed };
    return result;
  }

  async broadcastHello(): Promise<void> {
    const payload: Record<string, unknown> = {
      type: "group.hello",
      deviceId: this.opts.nodeId,
      displayName: this.opts.displayName,
      protocolVersion: GROUP_PROTOCOL_VERSION,
    };
    if (this.opts.memberRecord) {
      payload.member = this.opts.memberRecord;
    }
    const result = await this.broadcast(payload);
    console.log("[group-control] broadcastHello: attempted=", result.attempted, "sent=", result.sent, "failed=", result.failed);
  }

  /**
   * Broadcast a `group.member.joined` notification to all connected peers.
   * The payload does not include a `type` field so that the `.strict()` Zod
   * schema on the receiving end does not reject it.
   */
  async broadcastMemberJoined(memberDeviceId: string, memberDisplayName: string): Promise<BroadcastResult> {
    if (!this.sdk) throw new Error("Not connected");
    const payload: Record<string, unknown> = {
      memberDeviceId,
      memberDisplayName,
      joinedAt: Date.now(),
      groupId: this.opts.groupId,
    };
    const input = makeInput("group.member.joined", this.opts.nodeId, this.opts.groupId, payload, this.clock);
    const envelope = await buildEnvelope(input, this.opts.groupSecret);
    const peers = this.connectedPeers;
    let sent = 0;
    let failed = 0;
    for (const peerUuid of peers) {
      try {
        const ok = this.sdk.sendData(envelope as unknown as Record<string, unknown>, {
          uuid: peerUuid,
          preference: "any",
          allowFallback: false,
        });
        if (ok) sent++; else failed++;
      } catch {
        failed++;
      }
    }
    return { attempted: peers.length, sent, failed };
  }

  /**
   * Broadcast a `group.member.online` notification to all connected peers.
   * The payload does not include a `type` field for strict-schema compatibility.
   */
  async broadcastMemberOnline(memberDeviceId: string, memberDisplayName: string): Promise<BroadcastResult> {
    if (!this.sdk) throw new Error("Not connected");
    const payload: Record<string, unknown> = {
      memberDeviceId,
      memberDisplayName,
      onlineAt: Date.now(),
      groupId: this.opts.groupId,
    };
    const input = makeInput("group.member.online", this.opts.nodeId, this.opts.groupId, payload, this.clock);
    const envelope = await buildEnvelope(input, this.opts.groupSecret);
    const peers = this.connectedPeers;
    let sent = 0;
    let failed = 0;
    for (const peerUuid of peers) {
      try {
        const ok = this.sdk.sendData(envelope as unknown as Record<string, unknown>, {
          uuid: peerUuid,
          preference: "any",
          allowFallback: false,
        });
        if (ok) sent++; else failed++;
      } catch {
        failed++;
      }
    }
    return { attempted: peers.length, sent, failed };
  }

  /**
   * Whether the mesh needs a discovery refresh (MESH-003 self-heal).
   *
   * Zero raw routes for 45s while connected means room-discovery events were
   * missed: vdo.ninja peer announcements are push-only, so once a
   * `peerConnected`/`dataChannelOpen` event is lost nothing else can
   * re-trigger it — hello retries cannot help because there are no routes to
   * retry on. A room rejoin is the only recovery.
   */
  needsMeshRefresh(now: number = Date.now()): boolean {
    return (
      !this.destroyed &&
      this._state === "connected" &&
      this.meshStop !== null &&
      this.sdk !== null &&
      this.rawDataPeers.size === 0 &&
      now - this.lastRawPeerActivityAt > 45_000
    );
  }

  /**
   * Rejoin the control room and re-announce to re-trigger vdo.ninja room
   * discovery after missed peer-announcement events. Rate-limited by a
   * 60s cooldown; generation-guarded so a concurrent start()/destroy()
   * is never disturbed mid-refresh.
   */
  async refreshMeshDiscovery(): Promise<void> {
    const gen = this.startGeneration;
    if (gen !== this.startGeneration || this.destroyed) return;
    if (Date.now() - this.lastMeshRefreshAt < 60_000) return;
    this.lastMeshRefreshAt = Date.now();
    console.warn(
      `[group-control] no peers seen for ${Date.now() - this.lastRawPeerActivityAt}ms — refreshing mesh discovery (rejoin room)`,
    );
    try {
      const sdk = this.sdk;
      if (!sdk) return;
      await sdk.leaveRoom();
      if (gen !== this.startGeneration || this.destroyed) return;
      await sdk.joinRoom({ room: this.opts.controlRoomId, password: this.opts.groupSecret });
      if (gen !== this.startGeneration || this.destroyed) return;
      await sdk.announce({ streamID: this.opts.nodeId });
    } catch (err) {
      console.warn(
        "[group-control] mesh discovery refresh failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Send a `group.member.joined` message to a specific peer without including
   * a `type` field in the payload (strict-schema compatible).
   */
  private async sendMemberJoinedToPeer(peerUuid: string, memberDeviceId: string, memberDisplayName: string): Promise<boolean> {
    if (!this.sdk || !peerUuid) return false;
    const payload: Record<string, unknown> = {
      memberDeviceId,
      memberDisplayName,
      joinedAt: Date.now(),
      groupId: this.opts.groupId,
    };
    const input = makeInput("group.member.joined", this.opts.nodeId, this.opts.groupId, payload, this.clock);
    const envelope = await buildEnvelope(input, this.opts.groupSecret);
    return this.sdk.sendData(envelope as unknown as Record<string, unknown>, {
      uuid: peerUuid,
      preference: "any",
      allowFallback: false,
    });
  }

  /**
   * Send a `group.member.online` message to a specific peer without including
   * a `type` field in the payload (strict-schema compatible).
   */
  private async sendMemberOnlineToPeer(peerUuid: string, memberDeviceId: string, memberDisplayName: string): Promise<boolean> {
    if (!this.sdk || !peerUuid) return false;
    const payload: Record<string, unknown> = {
      memberDeviceId,
      memberDisplayName,
      onlineAt: Date.now(),
      groupId: this.opts.groupId,
    };
    const input = makeInput("group.member.online", this.opts.nodeId, this.opts.groupId, payload, this.clock);
    const envelope = await buildEnvelope(input, this.opts.groupSecret);
    return this.sdk.sendData(envelope as unknown as Record<string, unknown>, {
      uuid: peerUuid,
      preference: "any",
      allowFallback: false,
    });
  }

  /**
   * Send a hello with full member record to a specific peer.
   * Used when a data channel opens or peer connects.
   */
  private async sendHelloToPeer(peerUuid: string): Promise<boolean> {
    const payload: Record<string, unknown> = {
      type: "group.hello",
      deviceId: this.opts.nodeId,
      displayName: this.opts.displayName,
      protocolVersion: GROUP_PROTOCOL_VERSION,
    };
    if (this.opts.memberRecord) {
      payload.member = this.opts.memberRecord;
    }
    const sent = await this.sendToPeer(peerUuid, payload);
    console.log("[group-control] hello sent to peer", peerUuid, "result:", sent);
    return sent;
  }

  /**
   * Validate that envelope.senderDeviceId matches the payload deviceId
   * and (if present) the member record deviceId.
   */
  private validateHelloIdentity(
    envelope: GroupControlEnvelope,
    payloadDeviceId: string,
    member: GroupMemberRecord | null | undefined,
  ): boolean {
    if (envelope.senderDeviceId !== payloadDeviceId) {
      console.warn("[group-control] hello identity mismatch: envelope.senderDeviceId !== payload.deviceId");
      return false;
    }
    if (member && member.deviceId !== payloadDeviceId) {
      console.warn("[group-control] hello identity mismatch: member.deviceId !== payload.deviceId");
      return false;
    }
    return true;
  }

  /**
   * Check whether the sender identity on an envelope matches the established
   * mapping for this peer UUID.
   *
   * Rules:
   * - If the peer UUID is NOT yet mapped, allow the message (identity not yet
   *   established).
   * - If the peer UUID IS mapped, the envelope's senderDeviceId must match
   *   the mapped deviceId.  This applies to ALL message types, including
   *   hello/hello.response (preventing remap attacks).
   *
   * Returns `true` to allow the message, `false` to reject it.
   */
  private checkSenderIdentity(peerUuid: string, envelope: GroupControlEnvelope): boolean {
    const mappedDeviceId = this.peerToDevice.get(peerUuid);
    if (!mappedDeviceId) {
      return true;
    }
    return envelope.senderDeviceId === mappedDeviceId;
  }

  /**
   * Establish or migrate the authenticated device ↔ peer-UUID mapping.
   *
   * - If the device is already mapped to THIS peer UUID, nothing changes.
   * - If it is mapped to a DIFFERENT peer whose data channel is still open,
   *   keep the existing mapping. Duplicate peer connections for the same
   *   device (mesh glare) must not flap online state or steal the routing
   *   target — the first authenticated route wins while it stays usable.
   * - Otherwise (no mapping, or the mapped peer's channel is gone), take
   *   over the mapping.
   *
   * Returns "new" only when a previously-unmapped device gained a mapping,
   * i.e. when onPeerOnline should fire.
   */
  private establishDeviceMapping(uuid: string, deviceId: string): "new" | "kept" {
    const oldPeer = this.deviceToPeer.get(deviceId);
    if (oldPeer === uuid) return "kept";
    if (oldPeer && this.rawDataPeers.has(oldPeer)) {
      return "kept";
    }
    if (oldPeer) {
      this.peerToDevice.delete(oldPeer);
      this.rawPeerIdentity.delete(oldPeer);
    }
    this.peerToDevice.set(uuid, deviceId);
    this.deviceToPeer.set(deviceId, uuid);
    return "new";
  }

  /**
   * Start the hello-retry interval (lazily, once at a time).
   *
   * Every HELLO_RETRY_INTERVAL_MS the tick resends a hello to every peer
   * still in peersAwaitingHello. The first HELLO_MAX_RETRIES attempts run
   * at that fast interval; after that the peer enters a slow steady-state
   * schedule (every HELLO_SLOW_RETRY_INTERVAL_MS) that retries indefinitely
   * while its raw route stays alive — an unacked handshake is never given
   * up on. Route-down or a signaling reconnect re-triggers a fresh fast
   * phase via dataChannelOpen.
   */
  private ensureHelloRetryTimer(): void {
    if (this.helloRetryTimer !== null || this.destroyed) return;
    const genAtCreate = this.startGeneration;
    const slowTicks = Math.max(1, Math.round(HELLO_SLOW_RETRY_INTERVAL_MS / HELLO_RETRY_INTERVAL_MS));
    this.helloRetryTimer = setInterval(() => {
      // Generation guard: a newer start()/destroy() owns hello state now.
      if (genAtCreate !== this.startGeneration || this.destroyed) {
        this.clearHelloRetryTimer();
        return;
      }
      if (this.peersAwaitingHello.size === 0) {
        this.clearHelloRetryTimer();
        return;
      }
      for (const uuid of Array.from(this.peersAwaitingHello)) {
        const attempts = (this.helloRetryAttempts.get(uuid) ?? 0) + 1;
        this.helloRetryAttempts.set(uuid, attempts);
        if (attempts > HELLO_MAX_RETRIES) {
          // Slow phase: keep retrying at HELLO_SLOW_RETRY_INTERVAL_MS for as
          // long as the raw route is alive; route-down removes the peer.
          if (!this.rawDataPeers.has(uuid)) {
            this.removePeerAwaitingHello(uuid);
            continue;
          }
          const slowAttempt = attempts - HELLO_MAX_RETRIES;
          if (slowAttempt === 1) {
            console.log("[group-control] hello still unacked for peer", uuid, ", entering slow retry");
          }
          if (slowAttempt % slowTicks !== 0) continue;
        }
        this.sendHelloToPeer(uuid).catch(() => {});
      }
      if (this.peersAwaitingHello.size === 0) {
        this.clearHelloRetryTimer();
      }
    }, HELLO_RETRY_INTERVAL_MS);
  }

  private clearHelloRetryTimer(): void {
    if (this.helloRetryTimer !== null) {
      clearInterval(this.helloRetryTimer);
      this.helloRetryTimer = null;
    }
  }

  /**
   * Remove a peer from the awaiting-hello set along with its retry counter,
   * and stop the retry timer when no peers remain.
   */
  private removePeerAwaitingHello(uuid: string): void {
    this.peersAwaitingHello.delete(uuid);
    this.helloRetryAttempts.delete(uuid);
    if (this.peersAwaitingHello.size === 0) {
      this.clearHelloRetryTimer();
    }
  }

  /**
   * A peer route (data channel / connection) went down. Clean raw state and,
   * if this was the authenticated route for a device, transparently migrate
   * the mapping to another live raw channel claiming the same identity
   * instead of flapping the member offline→online.
   */
  private handlePeerRouteDown(uuid: string): void {
    this.rawDataPeers.delete(uuid);
    this.removePeerAwaitingHello(uuid);
    this.rawPeerIdentity.delete(uuid);
    const deviceId = this.peerToDevice.get(uuid);
    if (!deviceId) return;

    let replacement: string | null = null;
    for (const [peerUuid, dev] of this.rawPeerIdentity) {
      if (dev === deviceId && this.rawDataPeers.has(peerUuid)) {
        replacement = peerUuid;
        break;
      }
    }

    this.peerToDevice.delete(uuid);
    this.deviceToPeer.delete(deviceId);
    if (replacement) {
      this.peerToDevice.set(replacement, deviceId);
      this.deviceToPeer.set(deviceId, replacement);
    } else {
      this.opts.onPeerOffline(deviceId);
    }
  }

  private setState(s: ConnectionState): void {
    if (this._state !== s) {
      this._state = s;
      this.opts.onStateChange(s);
    }
  }

  private async teardownSdk(): Promise<void> {
    const sdk = this.sdk;
    this.sdk = null;
    if (!sdk) return;

    // No SDK means no hello handshake can complete — stop retrying.
    this.clearHelloRetryTimer();

    // If the meshStop handle still exists (destroy was not called), invoke it.
    if (this.meshStop) {
      try { this.meshStop.stop(); } catch { /* best effort */ }
      this.meshStop = null;
    }

    if (this.handlers) {
      try { sdk.removeEventListener("peerConnected", this.handlers.peerConnected as never); } catch { /* ignore */ }
      try { sdk.removeEventListener("peerDisconnected", this.handlers.peerDisconnected as never); } catch { /* ignore */ }
      try { sdk.removeEventListener("dataChannelOpen", this.handlers.dataChannelOpen as never); } catch { /* ignore */ }
      try { sdk.removeEventListener("dataChannelClose", this.handlers.dataChannelClose as never); } catch { /* ignore */ }
      try { sdk.removeEventListener("dataReceived", this.handlers.dataReceived as never); } catch { /* ignore */ }
      try { sdk.removeEventListener("disconnected", this.handlers.disconnected as never); } catch { /* ignore */ }
      try { sdk.removeEventListener("reconnected", this.handlers.reconnected as never); } catch { /* ignore */ }
      try { sdk.removeEventListener("reconnectFailed", this.handlers.reconnectFailed as never); } catch { /* ignore */ }
      try { sdk.removeEventListener("roomJoined", this.handlers.roomJoined as never); } catch { /* ignore */ }
      try { sdk.removeEventListener("error", this.handlers.error as never); } catch { /* ignore */ }
      this.handlers = null;
    }

    try { await sdk.leaveRoom(); } catch { /* ignore */ }
    try { await sdk.disconnect(); } catch { /* ignore */ }
  }

  /**
   * After an authenticated handshake with a peer, request the
   * complete group and stream state.
   */
  private async requestFullStateFromPeer(peerUuid: string): Promise<void> {
    if (!this.sdk) return;
    try {
      await this.sendToPeer(peerUuid, { type: "group.state.request" });
    } catch { /* best effort */ }
    try {
      await this.sendToPeer(peerUuid, { type: "stream.state.request" });
    } catch { /* best effort */ }
  }

  private setupEventHandlers(gen: number): void {
    const sdk = this.sdk;
    if (!sdk) return;

    const handlers: BoundHandlers = {
      peerConnected: (raw: unknown) => {
        if (gen !== this.startGeneration || this.destroyed) return;
        const { uuid, valid, malformed } = extractPeerUuid(raw);
        if (!valid || !uuid) {
          // Reject events with no valid peer UUID — never accept
          // `[object Object]` as a peer identifier.
          this.opts.onError(new Error(
            malformed
              ? "peerConnected: SDK emitted event without a usable UUID"
              : "peerConnected: empty peer UUID",
          ));
          return;
        }

        console.log("[group-control] peer connected, UUID discovered:", uuid);

      },
      peerDisconnected: (raw: unknown) => {
        if (gen !== this.startGeneration || this.destroyed) return;
        const { uuid } = extractPeerUuid(raw);
        if (!uuid) return;
        this.handlePeerRouteDown(uuid);
      },
      dataChannelOpen: (raw: unknown) => {
        if (gen !== this.startGeneration || this.destroyed) return;
        const { uuid, valid, malformed } = extractPeerUuid(raw);
        if (!valid || !uuid) {
          this.opts.onError(new Error(
            malformed
              ? "dataChannelOpen: SDK emitted event without a usable UUID"
              : "dataChannelOpen: empty peer UUID",
          ));
          return;
        }

        // Track as raw data-channel peer (before authentication).
        if (!this.rawDataPeers.has(uuid)) {
          console.log("[group-control] data channel opened for peer:", uuid);
          this.rawDataPeers.add(uuid);
          this.lastRawPeerActivityAt = Date.now();
        }

        // Send hello directly on data channel open so the peer can
        // immediately map us without waiting for peerConnected.
        if (!this.peerToDevice.has(uuid)) {
          this.peersAwaitingHello.add(uuid);
          this.ensureHelloRetryTimer();
          this.sendHelloToPeer(uuid).catch(() => {});
        }
      },
      dataChannelClose: (raw: unknown) => {
        if (gen !== this.startGeneration || this.destroyed) return;
        const { uuid, valid, malformed } = extractPeerUuid(raw);
        if (!valid || !uuid) {
          this.opts.onError(new Error(
            malformed
              ? "dataChannelClose: SDK emitted event without a usable UUID"
              : "dataChannelClose: empty peer UUID",
          ));
          return;
        }
        this.handlePeerRouteDown(uuid);
      },
      dataReceived: async (dataArg: unknown, peerArg?: unknown) => {
        if (gen !== this.startGeneration || this.destroyed) return;
        const { data, uuid, malformed } = extractDataAndUuid(dataArg, peerArg);
        if (!uuid) {
          this.opts.onError(new Error(
            malformed
              ? "dataReceived: SDK emitted event without a usable UUID"
              : "dataReceived: empty peer UUID",
          ));
          return;
        }

        try {
          const result = await validateEnvelope(data, this.opts.groupId, this.opts.groupSecret, this.dedupSet);
          // Re-check generation/destroyed after the await — the connection may
          // have been restarted or torn down while validation was in flight.
          if (gen !== this.startGeneration || this.destroyed) return;
          if (!result.ok) {
            console.warn("[group-control] envelope validation failed:", result.reason, "type:", (data as Record<string, unknown>)?.type ?? "unknown");
            return;
          }
          const validatedEnvelope = result.data;
          // Any authenticated traffic proves room discovery works.
          this.lastRawPeerActivityAt = Date.now();

          if (!this.checkSenderIdentity(uuid, validatedEnvelope)) {
            console.warn("[group-control] sender identity check failed for", uuid);
            return;
          }

          if (validatedEnvelope.type === "group.hello") {
            const deviceId = validatedEnvelope.senderDeviceId;
            const payloadDeviceId = validatedEnvelope.payload?.deviceId as string | undefined;
            const displayName = validatedEnvelope.payload?.displayName as string;
            if (!deviceId || !payloadDeviceId || !displayName) return;

            // Validate identity: envelope.senderDeviceId === payload deviceId
            const helloMember = validatedEnvelope.payload?.member as GroupMemberRecord | undefined;
            if (!this.validateHelloIdentity(validatedEnvelope, payloadDeviceId, helloMember)) return;

            console.log("[group-control] hello received from", deviceId, "peer", uuid);

            const validatedMember = helloMember && helloMember.deviceId === deviceId
              ? helloMember
              : null;

            this.rawPeerIdentity.set(uuid, deviceId);
            const mappingOutcome = this.establishDeviceMapping(uuid, deviceId);
            // A validated hello (re)maps this peer — start any later retry
            // cycle from a fresh fast phase.
            this.helloRetryAttempts.delete(uuid);

            // Only fire onPeerOnline for genuinely new mappings,
            // not for duplicate hellos (already mapped).
            if (mappingOutcome === "new") {
              this.opts.onPeerOnline(deviceId, displayName);
              console.log("[group-control] member online:", deviceId, displayName);
            }

            // Fire authenticated hello callback for member record merge
            this.opts.onAuthenticatedHello?.(deviceId, validatedMember, validatedEnvelope);

            // Send hello.response with our member record
            const responsePayload: Record<string, unknown> = {
              type: "group.hello.response",
              deviceId: this.opts.nodeId,
              displayName: this.opts.displayName,
              protocolVersion: GROUP_PROTOCOL_VERSION,
            };
            if (this.opts.memberRecord) {
              responsePayload.member = this.opts.memberRecord;
            }

            // If we owe a hello.response, send it now and request full state.
            if (this.peersAwaitingHello.has(uuid)) {
              this.removePeerAwaitingHello(uuid);
              this.sendToPeer(uuid, responsePayload).catch(() => {});
              // After authenticated handshake, request state.
              this.requestFullStateFromPeer(uuid).catch(() => {});
              // Tell the peer we are online now.
              this.sendMemberOnlineToPeer(uuid, this.opts.nodeId, this.opts.displayName).catch(() => {});
            } else if (mappingOutcome === "new") {
              // New peer we already greeted — also request state.
              this.requestFullStateFromPeer(uuid).catch(() => {});
              // Tell the peer we are online now.
              this.sendMemberOnlineToPeer(uuid, this.opts.nodeId, this.opts.displayName).catch(() => {});
            }
            return;
          }

          if (validatedEnvelope.type === "group.hello.response") {
            const deviceId = validatedEnvelope.senderDeviceId;
            const payloadDeviceId = validatedEnvelope.payload?.deviceId as string | undefined;
            if (!deviceId || !payloadDeviceId) return;

            // Validate identity: envelope.senderDeviceId === payload deviceId
            const responseMember = validatedEnvelope.payload?.member as GroupMemberRecord | undefined;
            if (!this.validateHelloIdentity(validatedEnvelope, payloadDeviceId, responseMember)) return;

            console.log("[group-control] hello.response received from", deviceId, "peer", uuid);

            const validatedMember = responseMember && responseMember.deviceId === deviceId
              ? responseMember
              : null;

            this.rawPeerIdentity.set(uuid, deviceId);
            const mappingOutcome = this.establishDeviceMapping(uuid, deviceId);
            // Handshake complete for this peer: stop retrying and reset the
            // counter so any later remap starts a fresh fast phase.
            this.removePeerAwaitingHello(uuid);

            // Only fire onPeerOnline for genuinely new mappings.
            if (mappingOutcome === "new") {
              this.opts.onPeerOnline(deviceId, validatedEnvelope.payload?.displayName as string);
              console.log("[group-control] member online via hello.response:", deviceId);
              // Tell the peer we are online now (first identity mapping).
              this.sendMemberOnlineToPeer(uuid, this.opts.nodeId, this.opts.displayName).catch(() => {});
            }

            // Fire authenticated hello callback for member record merge
            this.opts.onAuthenticatedHello?.(deviceId, validatedMember, validatedEnvelope);

            // After authenticated handshake, request state.
            this.requestFullStateFromPeer(uuid).catch(() => {});
            return;
          }

          this.opts.onMessage(validatedEnvelope);
        } catch {
          // Invalid message
        }
      },
      disconnected: (_raw: unknown) => {
        if (gen !== this.startGeneration || this.destroyed) return;
        this.setState("reconnecting");
        // P2P channels may survive signaling outage — do not clear peer maps
        // or emit peer offline. dataChannelClose handles cleanup when a
        // data channel actually goes down.
      },
      reconnected: (_raw: unknown) => {
        if (gen !== this.startGeneration || this.destroyed) return;
        this.setState("connected");
        console.log("[group-control] signaling reconnected; reconciling data peers");
        // Reconcile surviving raw data peers: for each raw peer without an
        // authenticated mapping, ensure it is awaiting hello and send a fresh
        // hello (retry even if already awaiting, since prior send may have lost).
        for (const peerUuid of this.rawDataPeers) {
          if (!this.peerToDevice.has(peerUuid)) {
            this.peersAwaitingHello.add(peerUuid);
            this.ensureHelloRetryTimer();
            this.sendHelloToPeer(peerUuid).catch(() => {});
          }
        }
        // For mapped peers, request full state so streams can be restored
        // after a transient signaling outage.
        for (const peerUuid of this.peerToDevice.keys()) {
          this.requestFullStateFromPeer(peerUuid).catch(() => {});
        }
      },
      reconnectFailed: (_raw: unknown) => {
        if (gen !== this.startGeneration || this.destroyed) return;
        this.setState("failed");
      },
      roomJoined: (_raw: unknown) => {
        // Informational — the connection is only marked "connected" after
        // announce() resolves, not at roomJoined. Keep this hook so the
        // mesh state can be inspected at the seam.
      },
      error: (event: unknown) => {
        if (gen !== this.startGeneration || this.destroyed) return;
        // RTCErrorEvent with `reason=Close called` fires on RTCDataChannel
        // when close() is called during normal SDK teardown. The SDK
        // re-emits these as its own "error" event — suppress them since
        // they are expected behaviour, not actual errors.
        if (event && typeof event === "object") {
          const err = (event as { error?: Error }).error;
          if (err instanceof Error && err.message.includes("Close called")) {
            return;
          }
        }
        console.warn("[group-control] SDK error event:", event);
      },
    };

    this.handlers = handlers;

    // Use addEventListener (not .on) per SDK 1.3.18 EventTarget surface.
    sdk.addEventListener("peerConnected", handlers.peerConnected as never);
    sdk.addEventListener("peerDisconnected", handlers.peerDisconnected as never);
    sdk.addEventListener("dataChannelOpen", handlers.dataChannelOpen as never);
    sdk.addEventListener("dataChannelClose", handlers.dataChannelClose as never);
    sdk.addEventListener("dataReceived", handlers.dataReceived as never);
    sdk.addEventListener("disconnected", handlers.disconnected as never);
    sdk.addEventListener("reconnected", handlers.reconnected as never);
    sdk.addEventListener("reconnectFailed", handlers.reconnectFailed as never);
    sdk.addEventListener("roomJoined", handlers.roomJoined as never);
    sdk.addEventListener("error", handlers.error as never);
  }
}
