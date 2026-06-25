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

    await withTimeout(this.sdk!.connect(), 15000, "SDK connect timed out — check your internet and that wss://wss.vdo.ninja is reachable");
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
   * Send a media.bind message to the publisher over the VDO data channel.
   * Uses the actual media SDK connection (not the group control channel).
   *
   * The targetUuid should be the publisher's media peer UUID (obtained during
   * the group control join flow). The publisher uses this actual media peer UUID
   * to validate the binding.
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

    await sendControlMessage(this.sdk, payload, targetUuid, "publisher");
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
