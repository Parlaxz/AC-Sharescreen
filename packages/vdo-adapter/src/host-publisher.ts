import { CompatibilityError } from "@screenlink/shared";
import type { VDONinjaSDK, PublishOptions, SDKEvent } from "./sdk-types.js";
import { getSDKConstructor } from "./sdk-version.js";
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

export interface HostPublisherOptions {
  host?: string;
  password: string;
  debug?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  /** Stage 8: Requested video codec ("auto", "VP9", "H264", "VP8", "AV1") */
  requestedCodec?: string;
}

export class HostPublisher {
  private sdk: VDONinjaSDK | null = null;
  private pendingHandlers = new Map<SDKEvent, Set<(...args: unknown[]) => void>>();
  /** Stage 8: Tracked requested codec for applying preferences on new connections */
  private _requestedCodec: string = "auto";
  /** Set when the SDK fires the `connected` event (WebSocket opened). Used for error classification. */
  private _webSocketConnected = false;
  /**
   * Bound handler for SDK "error" events that filters out expected
   * RTCErrorEvent "Close called" errors during teardown.
   */
  private _boundErrorHandler: ((...args: unknown[]) => void) | null = null;

  /** Register an event handler. Safe to call before createAndConnect. */
  on(event: SDKEvent, handler: (...args: unknown[]) => void): void {
    if (this.sdk) {
      this.sdk.on(event, handler);
    }
    if (!this.pendingHandlers.has(event)) {
      this.pendingHandlers.set(event, new Set());
    }
    this.pendingHandlers.get(event)!.add(handler);
  }

  off(event: SDKEvent, handler: (...args: unknown[]) => void): void {
    if (this.sdk) {
      this.sdk.off(event, handler);
    }
    this.pendingHandlers.get(event)?.delete(handler);
  }

  async createAndConnect(options: HostPublisherOptions): Promise<void> {
    const Ctor = getSDKConstructor();
    if (!Ctor) {
      throw new CompatibilityError("SDK constructor not found on window.VDONinjaSDK");
    }

    this.sdk = new Ctor({
      host: options.host ?? "wss://wss.vdo.ninja",
      password: options.password,
      salt: "vdo.ninja",
      debug: options.debug ?? false,
      turnServers: null,
      forceTURN: false,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
      reconnectDelay: options.reconnectDelay ?? 1000,
      autoPingViewer: false,
    });

    if (!this.sdk) {
      throw new CompatibilityError("SDK constructor returned null/undefined");
    }

    console.log('[HostPublisher] SDK created, type:', typeof this.sdk, 'has publish:', typeof this.sdk.publish);

    // Register any handlers that were queued before SDK creation
    for (const [event, handlers] of this.pendingHandlers) {
      for (const handler of handlers) {
        this.sdk.on(event, handler);
      }
    }

    // Stage 8: Register peerConnected handler to apply codec preferences
    // on new viewer connections as they are established.
    this._requestedCodec = options.requestedCodec ?? "auto";
    this.sdk.on("peerConnected", (_uuid: unknown) => {
      this.applyCodecPreferencesOnExistingConnections();
    });

    // Suppress expected RTCErrorEvent "Close called" errors that fire when
    // data channels are closed during normal SDK teardown.
    this._boundErrorHandler = (...args: unknown[]): void => {
      const event = args[0];
      if (event && typeof event === "object") {
        const err = (event as { error?: Error }).error;
        if (err instanceof Error && err.message.includes("Close called")) {
          return;
        }
      }
      console.warn("[HostPublisher] SDK error event:", event);
    };
    this.sdk.on("error", this._boundErrorHandler);

    // Track WebSocket connection status so connectWithTimeout() can classify
    // whether the signaling handshake ever started.
    this._webSocketConnected = false;
    this.sdk.on("connected", () => {
      this._webSocketConnected = true;
    });

    await this.connectWithTimeout(35_000);

    console.log('[HostPublisher] SDK connected, sdk still set:', this.sdk !== null);
  }

  /**
   * Connect to the VDO signaling server with a bounded timeout, early
   * failure on reconnectFailed, and explicit disconnect teardown.
   */
  private async connectWithTimeout(maxMs: number): Promise<void> {
    const sdk = this.sdk!;

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
   * Publish a MediaStream and apply codec preferences before the offer is generated.
   * Stage 8: Passes videoCodec hint to SDK and applies codec preferences to any
   * existing publisher transceivers immediately after publish.
   */
  async publish(stream: MediaStream, options: PublishOptions): Promise<void> {
    if (!this.sdk) throw new CompatibilityError("Not connected");

    // Stage 8: Apply codec preferences to any pre-existing publisher transceivers.
    this.applyCodecPreferencesOnExistingConnections();

    await withTimeout(this.sdk.publish(stream, {
      ...options,
      // Pass videoCodec hint if requested, so the SDK can prefer it
      // during initial offer generation.
      videoCodec: this._requestedCodec !== "auto" ? this._requestedCodec : undefined,
    }), 10000, "SDK publish timed out");

    // Stage 8: Apply preferences again after publish to catch transceivers
    // created during the publish call.
    this.applyCodecPreferencesOnExistingConnections();
  }

  /**
   * Replace the video track being published.
   * Delegates directly to the SDK's public replaceTrack API.
   * Throws if not connected.
   */
  async replaceVideoTrack(oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack): Promise<void> {
    if (!this.sdk) throw new CompatibilityError("Not connected");
    await this.sdk.replaceTrack(oldTrack, newTrack);
  }

  async stopPublishing(): Promise<void> {
    if (!this.sdk) return;
    await this.sdk.stopPublishing();
  }

  async disconnect(): Promise<void> {
    if (!this.sdk) return;
    if (this._boundErrorHandler) {
      try { this.sdk.off("error", this._boundErrorHandler); } catch { /* ignore */ }
      this._boundErrorHandler = null;
    }
    await this.sdk.disconnect();
    this.sdk = null;
  }

  getSDK(): VDONinjaSDK | null {
    return this.sdk;
  }

  /**
   * Apply codec preferences on all existing publisher transceivers.
   * Stage 8: Uses sender/receiver intersection with auto-order.
   * Called from peerConnected handler AND after publish/view to catch
   * connections created during the initial setup.
   */
  private applyCodecPreferencesOnExistingConnections(): void {
    if (!this.sdk) return;
    try {
      for (const [, group] of this.sdk.connections) {
        const pc = group.publisher?.pc;
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
