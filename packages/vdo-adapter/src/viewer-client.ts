import { CompatibilityError } from "@screenlink/shared";
import type { VDONinjaSDK, VDONinjaSDKConstructorOptions, SDKEvent } from "./sdk-types.js";
import { getSDKConstructor } from "./sdk-version.js";

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

  async createAndConnect(password: string, options?: Partial<VDONinjaSDKConstructorOptions>): Promise<void> {
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

    await withTimeout(this.sdk!.connect(), 15000, "SDK connect timed out — check your internet and that wss://wss.vdo.ninja is reachable");
  }

  async view(streamId: string, displayName?: string): Promise<void> {
    if (!this.sdk) throw new CompatibilityError("Not connected");
    await withTimeout(
      this.sdk.view(streamId, {
        audio: true,
        video: true,
        label: displayName,
      }),
      30000,
      "SDK view timed out — stream may not exist or credentials are wrong",
    );
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
}
