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
  private _dataChannelsOpened = new Set<string>();

  /** Register an event handler. Safe to call before createAndConnect. */
  on(event: SDKEvent, handler: (...args: unknown[]) => void): void {
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
    this.sdk.on("peerConnected", () => {
      this.applyCodecPreferencesOnExistingConnections();
    });

    // Set up dataChannelOpen tracking.
    // In SDK 1.3.18, this fires as a CustomEvent with detail = { uuid }.
    this.setupDataChannelOpenHandler();

    await withTimeout(this.sdk!.connect(), 15000, "SDK connect timed out — check your internet and that wss://wss.vdo.ninja is reachable");
  }

  /**
   * Register the dataChannelOpen handler that resolves per-UUID waiters.
   * SDK 1.3.18 CustomEvent with detail.uuid pinpoints which peer's channel opened.
   * Defensively also accepts a direct string UUID as the first argument.
   */
  private setupDataChannelOpenHandler(): void {
    if (!this.sdk) return;
    this.sdk.on("dataChannelOpen", (...args: unknown[]) => {
      const raw = args[0];
      let uuid: string | undefined;

      // 1) Direct string UUID (defensive fallback for legacy / tests)
      if (typeof raw === "string" && raw.trim().length > 0 && raw.trim() !== "[object Object]") {
        uuid = raw.trim();
      }
      // 2) EventTarget / CustomEvent with detail.uuid (SDK 1.3.18 standard path)
      else if (raw && typeof raw === "object") {
        const detail = (raw as { detail?: { uuid?: string } }).detail;
        if (detail && typeof detail.uuid === "string") {
          uuid = detail.uuid;
        }
      }

      if (uuid) {
        this._dataChannelsOpened.add(uuid);
        const waiter = this._dataChannelWaiters.get(uuid);
        if (waiter) {
          waiter.resolve();
          this._dataChannelWaiters.delete(uuid);
        }
      }
    });
  }

  /**
   * View a stream and apply codec preferences before the offer is generated.
   * Stage 8: Applies common video codec capabilities (VP9, H.264, VP8 auto-order)
   * on the viewer's transceivers before the SDK generates the offer.
   */
  async view(streamId: string, displayName?: string): Promise<void> {
    if (!this.sdk) throw new CompatibilityError("Not connected");

    // Stage 8: Apply codec preferences to any pre-existing viewer transceivers.
    this.applyCodecPreferencesOnExistingConnections();

    await withTimeout(
      this.sdk.view(streamId, {
        audio: true,
        video: true,
        label: displayName,
      }),
      30000,
      "SDK view timed out — stream may not exist or credentials are wrong",
    );

    // Stage 8: Apply preferences again after view to catch transceivers
    // created during the view call.
    this.applyCodecPreferencesOnExistingConnections();
  }

  async stopViewing(): Promise<void> {
    if (!this.sdk) return;
    await this.sdk.stopViewing();
  }

  async disconnect(): Promise<void> {
    if (!this.sdk) return;
    await this.sdk.disconnect();
    this.sdk = null;
  }

  getSDK(): VDONinjaSDK | null {
    return this.sdk;
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
    // Already open
    if (this._dataChannelsOpened.has(targetUuid)) return;

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
  ): Promise<void> {
    if (!this.sdk) throw new CompatibilityError("Not connected");

    const payload = {
      type: "media.bind",
      token,
      mediaSessionId: mediaSessionId ?? "",
    };

    // Wait for data channel to open before sending
    await this.waitForDataChannelOpen(targetUuid);

    // Attempt to send with bounded retry
    const maxAttempts = 5;
    const retryDelayMs = 500;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await sendControlMessage(this.sdk, payload, targetUuid);
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
