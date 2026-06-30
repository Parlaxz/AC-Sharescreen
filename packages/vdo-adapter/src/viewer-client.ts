import { CompatibilityError } from "@screenlink/shared";
import type { VDONinjaSDK, VDONinjaSDKConstructorOptions, SDKEvent } from "./sdk-types.js";
import { getSDKConstructor } from "./sdk-version.js";
import { sendControlMessage } from "./send-data.js";
import { applyCodecPreferencesToTransceiverBeforeOffer } from "./codec-capabilities.js";

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export class ViewerClient {
  private sdk: VDONinjaSDK | null = null;
  private pendingHandlers = new Map<SDKEvent, Set<(...args: unknown[]) => void>>();
  private registeredHandlers = new Map<SDKEvent, Set<(...args: unknown[]) => void>>();
  /** Stage 8: Tracked requested codec for applying preferences on new connections */
  private _requestedCodec: string = "auto";

  /**
   * Per-UUID data channel waiter state.
   * Each target UUID gets its own promise so one peer opening cannot
   * consume another peer's waiter. SDK 1.3.18 fires `dataChannelOpen`
   * as a CustomEvent with `event.detail.uuid` or (defensively) a direct
   * string UUID as the first argument.
   */
  private _dataChannelWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private _dataChannelsOpened = new Map<string, number>();
  private _mediaConnectionGeneration = 0;

  /**
   * The VDO stream ID currently being viewed. Stored so that shutdown()
   * can call `stopViewing(activeStreamId)` — SDK 1.3.18 requires the
   * stream ID to mark the disconnect as intentional and to cancel the
   * per-stream retry timer.
   */
  private _activeStreamId: string | null = null;

  /**
   * Internal SDK event handlers that ViewerClient registers itself
   * (peerConnected for codec preferences, dataChannelOpen for waiter
   * resolution). Tracked separately from `registeredHandlers` so
   * shutdown() can remove them — the public on()/off() path does not
   * see them.
   */
  private _internalHandlers: Array<{ event: SDKEvent; handler: (...args: unknown[]) => void }> = [];

  /**
   * Set to true when shutdown() is in progress or has completed.
   * Prevents new view() calls from racing the teardown.
   */
  private _shuttingDown = false;
  private _shutdownPromise: Promise<void> | null = null;

  /**
   * Set to true when the SDK fires the `connected` event (WebSocket opened).
   * Used by connectWithTimeout() to classify timeout errors:
   *   - connected never fired → signaling server unreachable
   *   - connected fired but connect() promise didn't resolve → SDK lifecycle issue
   */
  private _webSocketConnected = false;

  /**
   * True while the user has intentionally paused media playback.
   * The SDK signaling connection stays alive; only the media stream is stopped.
   * Suppresses auto-reconnect and "stream ended" handling during pause.
   */
  private _userPaused = false;

  /**
   * Saved view parameters for resume after a user-initiated pause.
   * Populated by pauseMedia(), consumed and cleared by resumeMedia().
   */
  private _pausedStreamId: string | null = null;

  /** Register an event handler. Safe to call before createAndConnect. */
  on(event: SDKEvent, handler: (...args: unknown[]) => void): void {
    if (this._shuttingDown) return;
    if (this.sdk) {
      this.sdk.on(event, handler);
      if (!this.registeredHandlers.has(event)) {
        this.registeredHandlers.set(event, new Set());
      }
      this.registeredHandlers.get(event)!.add(handler);
    } else {
      // Queue handler for when SDK is created
      if (!this.pendingHandlers.has(event)) {
        this.pendingHandlers.set(event, new Set());
      }
      this.pendingHandlers.get(event)!.add(handler);
    }
  }

  off(event: SDKEvent, handler: (...args: unknown[]) => void): void {
    if (this.sdk) {
      this.sdk.off(event, handler);
    }
    this.registeredHandlers.get(event)?.delete(handler);
    this.pendingHandlers.get(event)?.delete(handler);
  }

  async createAndConnect(password: string, options?: Partial<VDONinjaSDKConstructorOptions> & { requestedCodec?: string }): Promise<void> {
    if (this._shuttingDown || this._shutdownPromise) {
      throw new CompatibilityError("ViewerClient is shutting down — cannot create a new connection");
    }
    const Ctor = getSDKConstructor();
    this.sdk = new Ctor({
      host: options?.host ?? "wss://wss.vdo.ninja",
      password: password,
      salt: "vdo.ninja",
      debug: true,
      turnServers: options?.turnServers ?? null,
      forceTURN: options?.forceTURN ?? false,
      maxReconnectAttempts: options?.maxReconnectAttempts ?? 10,
      reconnectDelay: options?.reconnectDelay ?? 1000,
      autoPingViewer: true,
      autoPingInterval: 10000,
    });

    // Register any handlers that were added before SDK creation
    for (const [event, handlers] of this.pendingHandlers) {
      for (const handler of handlers) {
        this.sdk.on(event, handler);
        if (!this.registeredHandlers.has(event)) {
          this.registeredHandlers.set(event, new Set());
        }
        this.registeredHandlers.get(event)!.add(handler);
      }
    }
    this.pendingHandlers.clear();

    // Stage 8: Register peerConnected handler to apply codec preferences
    // on new peer connections as they are established.
    this._requestedCodec = options?.requestedCodec ?? "auto";
    const peerConnectedHandler = (): void => {
      this.applyCodecPreferencesOnExistingConnections();
    };
    this.sdk.on("peerConnected", peerConnectedHandler);
    this._internalHandlers.push({ event: "peerConnected", handler: peerConnectedHandler });

    // Suppress expected RTCErrorEvent "Close called" errors that fire when
    // data channels are closed during normal SDK teardown.
    const errorHandler = (...args: unknown[]): void => {
      if (this._shuttingDown || this._shutdownPromise) return;
      const event = args[0];
      if (event && typeof event === "object") {
        const err = (event as { error?: Error }).error;
        if (err instanceof Error && err.message.includes("Close called")) {
          return;
        }
      }
      console.warn("[ViewerClient] SDK error event:", event);
    };
    this.sdk.on("error", errorHandler);
    this._internalHandlers.push({ event: "error", handler: errorHandler });

    // Track WebSocket connection status so connectWithTimeout() can classify
    // whether the signaling handshake ever started or got stuck post-connect.
    this._webSocketConnected = false;
    const wsConnectedHandler = (): void => {
      this._webSocketConnected = true;
    };
    this.sdk.on("connected", wsConnectedHandler);
    this._internalHandlers.push({ event: "connected", handler: wsConnectedHandler });

    // Set up dataChannelOpen tracking.
    // In SDK 1.3.18, this fires as a CustomEvent with detail = { uuid }.
    this.setupDataChannelOpenHandler();

    await this.connectWithTimeout(35_000);
  }

  /**
   * Connect to the VDO signaling server with a bounded timeout, early
   * failure on reconnectFailed, and explicit disconnect teardown so the
   * SDK does not continue connecting in the background after an error.
   *
   * Error classification:
   *   - WebSocket `connected` event never fired → signaling server unreachable.
   *   - `connected` fired but connect() promise didn't resolve → SDK lifecycle
   *     or slow-network issue after the WebSocket handshake.
   *   - SDK `reconnectFailed` event fired → all reconnect attempts exhausted,
   *     underlying SDK error is surfaced.
   *   - Generic error from sdk.connect() → passed through as-is.
   */
  private async connectWithTimeout(maxMs: number): Promise<void> {
    const sdk = this.sdk!;

    // Bridge the SDK reconnectFailed event to a promise rejection so we
    // fail early instead of waiting for the full timeout.
    let rejectEarly: ((reason: Error) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onReconnectFailed = (...args: unknown[]): void => {
      const err = args.length > 0 ? args[0] : undefined;
      const msg = err instanceof Error ? err.message : String(err ?? "Reconnect failed");
      rejectEarly?.(new CompatibilityError(msg));
      rejectEarly = null;
    };
    sdk.on("reconnectFailed", onReconnectFailed);

    try {
      const connectPromise: Promise<void> = sdk.connect();

      const earlyExit = new Promise<never>((_, reject) => {
        rejectEarly = reject;

        timer = setTimeout(() => {
          rejectEarly = null;
          let message: string;
          if (this._webSocketConnected) {
            message = "SDK connect timed out — the WebSocket to the signaling server opened but the SDK did not complete initialization within the time limit. This suggests a slow network or an SDK lifecycle issue.";
          } else {
            message = "Connection failed — the WebSocket to the signaling server (wss://wss.vdo.ninja) never opened. The server may be blocked or unreachable.";
          }
          reject(new CompatibilityError(message));
        }, maxMs);
      });

      await Promise.race([connectPromise, earlyExit]);
    } catch (err) {
      // On timeout/error, explicitly disconnect the SDK so it does not
      // continue connecting in the background and race a subsequent retry
      // or teardown.  Without this, the Promise.race-based timeout leaves
      // the connect() promise dangling.
      try {
        await sdk.disconnect();
      } catch {
        // Best-effort cleanup
      }
      throw err;
    } finally {
      clearTimeout(timer);
      sdk.off("reconnectFailed", onReconnectFailed);
      rejectEarly = null;
    }
  }

  /**
   * Register the dataChannelOpen handler that resolves per-UUID waiters.
   * SDK 1.3.18 CustomEvent with detail.uuid pinpoints which peer's channel opened.
   * Defensively also accepts a direct string UUID as the first argument.
   */
  private setupDataChannelOpenHandler(): void {
    if (!this.sdk) return;
    const handler = (...args: unknown[]): void => {
      const uuid = this.extractEventUuid(args[0]);

      if (uuid) {
        this._dataChannelsOpened.set(uuid, this._mediaConnectionGeneration);
        const waiter = this._dataChannelWaiters.get(uuid);
        if (waiter) {
          waiter.resolve();
          this._dataChannelWaiters.delete(uuid);
        }
      }
    };
    this.sdk.on("dataChannelOpen", handler);
    this._internalHandlers.push({ event: "dataChannelOpen", handler });

    const closeHandler = (...args: unknown[]): void => {
      const uuid = this.extractEventUuid(args[0]);
      this.beginNewMediaConnectionGeneration(uuid);
    };
    this.sdk.on("dataChannelClose", closeHandler);
    this._internalHandlers.push({ event: "dataChannelClose", handler: closeHandler });

    const peerDisconnectedHandler = (...args: unknown[]): void => {
      const uuid = this.extractEventUuid(args[0]);
      this.beginNewMediaConnectionGeneration(uuid);
    };
    this.sdk.on("peerDisconnected", peerDisconnectedHandler);
    this._internalHandlers.push({ event: "peerDisconnected", handler: peerDisconnectedHandler });
  }

  private extractEventUuid(raw: unknown): string | undefined {
    if (typeof raw === "string" && raw.trim().length > 0 && raw.trim() !== "[object Object]") {
      return raw.trim();
    }
    if (raw && typeof raw === "object") {
      const detail = (raw as { detail?: { uuid?: string } }).detail;
      if (detail && typeof detail.uuid === "string") {
        return detail.uuid;
      }
    }
    return undefined;
  }

  private beginNewMediaConnectionGeneration(targetUuid?: string): void {
    this._mediaConnectionGeneration++;
    if (targetUuid) {
      this._dataChannelsOpened.delete(targetUuid);
      this._dataChannelWaiters.delete(targetUuid);
      return;
    }
    this._dataChannelsOpened.clear();
    this._dataChannelWaiters.clear();
  }

  /**
   * View a stream and apply codec preferences before the offer is generated.
   * Stage 8: Applies common video codec capabilities (VP9, H.264, VP8 auto-order)
   * on the viewer's transceivers before the SDK generates the offer.
   *
   * Stores the stream ID so that shutdown() can call `stopViewing(streamId)`
   * — SDK 1.3.18 uses that argument to mark the disconnect as intentional
   * and to cancel the per-stream retry timer.
   */
  async view(streamId: string, displayName?: string): Promise<void> {
    if (this._shuttingDown || this._shutdownPromise) {
      throw new CompatibilityError("ViewerClient is shutting down — cannot view a new stream");
    }
    if (!this.sdk) throw new CompatibilityError("Not connected");

    // Remember which stream we are viewing so shutdown() can pass it back
    // to the SDK. Stored before the SDK call so that an error during view()
    // still leaves a recoverable ID for cleanup.
    this._activeStreamId = streamId;

    // Stage 8: Apply codec preferences to any pre-existing viewer transceivers.
    this.applyCodecPreferencesOnExistingConnections();

    try {
      await withTimeout(
        this.sdk.view(streamId, {
          audio: true,
          video: true,
          label: displayName,
        }),
        30000,
        "SDK view timed out — stream may not exist or credentials are wrong",
      );
    } catch (err) {
      // Don't leave a stale active-stream pointer if the view call failed
      this._activeStreamId = null;
      throw err;
    }

    // Stage 8: Apply preferences again after view to catch transceivers
    // created during the view call.
    this.applyCodecPreferencesOnExistingConnections();
  }

  /**
   * Stop viewing the active stream. Backward-compatible wrapper — callers
   * that don't have a stream ID can still invoke this with no argument.
   * The SDK 1.3.18 type signature is `stopViewing(streamId?)` — passing
   * the active stream ID marks the disconnect as intentional and cancels
   * the per-stream retry timer, which is critical to preventing a leave
   * from being followed by an automatic reconnect.
   */
  async stopViewing(): Promise<void> {
    if (!this.sdk) return;
    const streamId = this._activeStreamId;
    try {
      await this.sdk.stopViewing(streamId ?? undefined);
    } finally {
      // Clear the pointer whether or not the SDK call succeeded so a later
      // shutdown() call won't re-target this stream.
      this._activeStreamId = null;
    }
  }

  /**
   * Pause media playback — mark state only, keep the WebRTC connection alive.
   *
   * Unlike the old implementation, this does NOT call stopViewing() on the SDK.
   * The media connection stays intact; the host-side disables the sender
   * encoding (active=false). On resume the host re-enables it with the stored
   * quality configuration.
   *
   * Safe to call when already paused (no-op), when shutting down (no-op), or
   * when no stream is active (no-op).
   *
   * State machine:
   *   playing → pauseMedia() → paused  (connection kept alive)
   *   paused  → pauseMedia() → (no-op, still paused)
   */
  async pauseMedia(): Promise<void> {
    if (this._shuttingDown || this._shutdownPromise) return;
    if (this._userPaused) return;     // already paused — idempotent

    // Save resume parameters (the current stream remains active in the SDK)
    this._pausedStreamId = this._activeStreamId;
    this._userPaused = true;
    // Do NOT call stopViewing() — the WebRTC connection, data channel,
    // sender, binding, and metrics registration all stay alive.
  }

  /**
   * Resume a user-paused media stream — mark state only.
   *
   * The WebRTC connection was never torn down during pause, so no
   * view() call, no fresh token, and no media.bind are needed.
   * The host-side re-activates the sender encoding with the stored
   * quality configuration.
   *
   * State machine:
   *   paused → resumeMedia() → playing  (existing connection reused)
   *
   * @throws CompatibilityError if not paused or shutting down
   */
  async resumeMedia(): Promise<void> {
    if (this._shuttingDown || this._shutdownPromise) {
      throw new CompatibilityError("ViewerClient is shutting down — cannot resume");
    }
    if (!this._userPaused) {
      throw new CompatibilityError("resumeMedia called but viewer was not paused");
    }

    // Restore the active stream ID that was preserved during pause
    this._activeStreamId = this._pausedStreamId;
    this._userPaused = false;
    this._pausedStreamId = null;
    // Do NOT call view() — the existing peer connection and sender are intact.
  }

  /** True while the user has intentionally paused media. */
  get isUserPaused(): boolean {
    return this._userPaused;
  }

  async disconnect(): Promise<void> {
    if (!this.sdk) return;
    await this.sdk.disconnect();
    this.sdk = null;
  }

  /**
   * Idempotent asynchronous shutdown.
   *
   * Marks the shutdown as intentional (via the SDK's _intentionalDisconnect
   * flag, set by stopViewing(streamId) and disconnect()), removes all
   * application- and SDK-owned listeners, clears per-UUID data-channel
   * waiters, and tears the SDK down in a strictly sequential order:
   *
   *   1. stopViewing(activeStreamId) — awaited
   *   2. disconnect()                — awaited
   *
   * Concurrent execution of those two is unsafe: the SDK resets its
   * `_intentionalDisconnect` flag at the end of `stopViewing()`, so a
   * `disconnect()` fired in parallel can race a reconnect attempt.
   *
   * This method does NOT delete the ViewerClient instance; it just
   * tears the underlying SDK state down. After shutdown() the client
   * cannot be reused — create a new one for the next Watch attempt.
   *
   * Safe to call multiple times — repeated invocations await the same
   * teardown promise and return without side effects.
   */
  async shutdown(): Promise<void> {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._shuttingDown = true;

    this._shutdownPromise = (async () => {
      // Capture once: the SDK may be cleared mid-shutdown.
      const sdk = this.sdk;
      const activeStreamId = this._activeStreamId;

      // 0) Best-effort guard against SDK auto-reconnect.
      //    The SDK was constructed with maxReconnectAttempts=10, so even
      //    though stopViewing(streamId) marks the disconnect as intentional
      //    for the SDK's internal state, there is a window between that
      //    call and the subsequent disconnect() where a reconnect timer
      //    could fire.  As a belt-and-suspenders measure we try to set
      //    the runtime reconnect property to 0 on the SDK instance.
      //    Property names vary by SDK build; try common ones.
      if (sdk) {
        const reconnectConfig = sdk as unknown as Record<string, unknown>;
        try {
          reconnectConfig.maxReconnectAttempts = 0;
        } catch { /* best-effort */ }
        try {
          reconnectConfig._maxReconnectAttempts = 0;
        } catch { /* best-effort */ }
        try {
          reconnectConfig.reconnectAttempts = 0;
        } catch { /* best-effort */ }
      }

      // 1) Stop viewing the active stream first. SDK 1.3.18 accepts the
      //    streamID argument, which marks the disconnect as intentional
      //    and cancels the per-stream retry timer so the SDK will NOT
      //    automatically re-invite the viewer after we exit.
      //    Awaited — the SDK resets _intentionalDisconnect at the end of
      //    this call, so we must complete it before moving on.
      if (sdk && activeStreamId) {
        try {
          await sdk.stopViewing(activeStreamId);
        } catch {
          // Best effort — proceed to disconnect regardless.
        }
      } else if (sdk) {
        try {
          await sdk.stopViewing();
        } catch {
          // Best effort
        }
      }
      this._activeStreamId = null;

      // 2) Disconnect from the signaling server. Sequential and awaited.
      //    disconnect() also sets _intentionalDisconnect = true and tears
      //    down the WebSocket, which is the final barrier against
      //    auto-reconnect.
      if (sdk) {
        try {
          await sdk.disconnect();
        } catch {
          // Best effort
        }
      }
      this.sdk = null;

      // 3) Remove all SDK listeners we registered. This includes both
      //    application handlers (added via on()) and the internal
      //    peerConnected / dataChannelOpen handlers we register in
      //    createAndConnect() / setupDataChannelOpenHandler(). Without
      //    this step, a stale SDK instance or a re-entrant event could
      //    resurrect handler state after we null out the SDK.
      if (sdk) {
        for (const { event, handler } of this._internalHandlers) {
          try {
            sdk.off(event, handler);
          } catch {
            // ignore
          }
        }
        for (const [event, handlers] of this.registeredHandlers) {
          for (const handler of handlers) {
            try {
              sdk.off(event, handler);
            } catch {
              // ignore
            }
          }
        }
      }
      this._internalHandlers = [];
      this.registeredHandlers.clear();
      this.pendingHandlers.clear();

      // 4) Clear pause/resume state so a full shutdown does not leave
      //    stale resume parameters behind.
      this._userPaused = false;
      this._pausedStreamId = null;

      // 5) Clear data-channel waiter state. Resolve any outstanding
      //    waiters so any awaiter (e.g. sendMediaBind) wakes up and
      //    observes the shutdown — the generation guard in the caller
      //    prevents it from acting on the resolution.
      for (const waiter of this._dataChannelWaiters.values()) {
        try {
          waiter.resolve();
        } catch {
          // ignore
        }
      }
      this._dataChannelWaiters.clear();
      this._dataChannelsOpened.clear();
    })();

    return this._shutdownPromise;
  }

  getSDK(): VDONinjaSDK | null {
    return this.sdk;
  }

  /** True after shutdown() has been initiated. */
  get isShuttingDown(): boolean {
    return this._shuttingDown;
  }

  /** The currently active VDO stream ID, or null if not viewing. */
  get activeStreamId(): string | null {
    return this._activeStreamId;
  }

  /**
   * Wait for the VDO data channel to open for a specific peer UUID.
   * If the channel is already recorded as open, resolves immediately.
   * Otherwise creates a per-UUID waiter promise that resolves when the
   * next dataChannelOpen event matches this UUID.
   * Times out after `timeout` ms (default 15s).
   *
   * Per-UUID state prevents one peer's dataChannelOpen from racing
   * and consuming another peer's waiter.
   *
   * Safe to call before `createAndConnect` — will wait until SDK is created
   * and the data channel opens.
   */
  async waitForDataChannelOpen(
    targetUuid: string,
    timeout = 15_000,
  ): Promise<void> {
    if (this._shuttingDown || this._shutdownPromise) {
      throw new CompatibilityError("ViewerClient is shutting down");
    }
    const generation = this._mediaConnectionGeneration;

    // Already open for the current media-connection generation
    if (this._dataChannelsOpened.get(targetUuid) === generation) return;

    // Get or create a per-UUID waiter
    let waiter = this._dataChannelWaiters.get(targetUuid);
    if (!waiter) {
      let resolve: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      waiter = { promise, resolve: resolve! };
      this._dataChannelWaiters.set(targetUuid, waiter);
    }

    // Wait for this UUID's data channel to open
    await withTimeout(
      waiter.promise,
      timeout,
      `Data channel open timed out for peer ${targetUuid}`,
    );

    if (this._shuttingDown || this._shutdownPromise) {
      return;
    }

    if (this._dataChannelsOpened.get(targetUuid) !== generation) {
      throw new Error(`Data channel open timed out for peer ${targetUuid}`);
    }
  }

  /**
   * Send a media.bind message to the publisher over the VDO data channel.
   * Uses the actual media SDK connection (not the group control channel).
   *
   * Waits for the data channel to open before sending. Retries on failure
   * with bounded attempts. Does NOT force the deprecated `type: "publisher"`
   * routing — uses `preference: "any"` so the SDK routes through any available
   * data channel.
   *
   * Stage 5: Correct media.bind transport uses the actual media SDK data channel,
   * not the group control envelope senderDeviceId.
   */
  async sendMediaBind(
    targetUuid: string,
    token: string,
    mediaSessionId?: string,
    viewerSessionId?: string,
  ): Promise<void> {
    if (this._shuttingDown || this._shutdownPromise) {
      throw new CompatibilityError("ViewerClient is shutting down");
    }
    if (!this.sdk) throw new CompatibilityError("Not connected");

    const payload: Record<string, unknown> = {
      type: "media.bind",
      token,
      mediaSessionId: mediaSessionId ?? "",
    };
    if (viewerSessionId) {
      payload.viewerSessionId = viewerSessionId;
    }

    // Wait for data channel to open before sending
    await this.waitForDataChannelOpen(targetUuid);

    // Attempt to send with bounded retry
    const maxAttempts = 5;
    const retryDelayMs = 500;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await sendControlMessage(this.sdk, payload, targetUuid, false);
        return; // Success — stop
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
        }
      }
    }

    throw lastError ?? new Error("media.bind send failed after max attempts");
  }

  /**
   * Apply preferred codec order (VP9, H.264, VP8) on all viewer video
   * transceivers. Uses applyCodecPreferencesToTransceiverBeforeOffer for
   * full negotiation pipeline (sender/receiver intersection, auto-order).
   * Stage 8: Called from peerConnected handler AND after view() to catch
   * connections created during the initial setup.
   */
  private applyCodecPreferencesOnExistingConnections(): void {
    if (!this.sdk) return;
    try {
      for (const [, group] of this.sdk.connections) {
        const pc = group.viewer?.pc;
        if (!pc) continue;
        const transceivers = pc.getTransceivers();
        for (const t of transceivers) {
          if (t.receiver?.track?.kind === "video") {
            try {
              applyCodecPreferencesToTransceiverBeforeOffer(t, this._requestedCodec);
            } catch {
              // Browser may reject empty/unsupported codec lists
            }
          }
        }
      }
    } catch {
      // Best effort — codec preferences are optional
    }
  }
}
