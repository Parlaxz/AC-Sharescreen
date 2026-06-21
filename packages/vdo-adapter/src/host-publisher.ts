import { CompatibilityError } from "@screenlink/shared";
import type { VDONinjaSDK, PublishOptions, SDKEvent } from "./sdk-types.js";
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

export interface HostPublisherOptions {
  host?: string;
  password: string;
  debug?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
}

export class HostPublisher {
  private sdk: VDONinjaSDK | null = null;
  private pendingHandlers = new Map<SDKEvent, Set<(...args: unknown[]) => void>>();

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

    // Register any handlers that were queued before SDK creation
    for (const [event, handlers] of this.pendingHandlers) {
      for (const handler of handlers) {
        this.sdk.on(event, handler);
      }
    }

    await withTimeout(this.sdk!.connect(), 15000, "SDK connect timed out — check your internet and that wss://wss.vdo.ninja is reachable");
  }

  async publish(stream: MediaStream, options: PublishOptions): Promise<void> {
    if (!this.sdk) throw new CompatibilityError("Not connected");
    await withTimeout(this.sdk.publish(stream, options), 10000, "SDK publish timed out");
  }

  async stopPublishing(): Promise<void> {
    if (!this.sdk) return;
    await this.sdk.stopPublishing();
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
