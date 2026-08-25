/**
 * Deep-link routing for screenlink://group?... invite URLs.
 *
 * URLs reach the main process via cold-start argv, the "second-instance"
 * event (warm start), or macOS "open-url". The router forwards them to the
 * renderer on DEEP_LINK_CHANNEL; URLs that arrive before the renderer is
 * armed are buffered and flushed later.
 */

export const DEEP_LINK_CHANNEL = "deep-link:join";

const DEDUPE_WINDOW_MS = 5_000;
const MAX_BUFFERED = 5;

/** All argv entries that look like screenlink:// URLs (scheme match is case-insensitive). */
export function extractScreenLinkUrls(argv: string[]): string[] {
  return argv.filter(
    (arg) => typeof arg === "string" && arg.toLowerCase().startsWith("screenlink://"),
  );
}

export class DeepLinkRouter {
  private readonly sendToRenderer: (channel: string, payload: string) => void;
  private queue: string[] = [];
  private armed = false;
  private lastEnqueued: string | null = null;
  private lastEnqueuedAt = 0;

  constructor(sendToRenderer: (channel: string, payload: string) => void) {
    this.sendToRenderer = sendToRenderer;
  }

  /**
   * Accept an incoming URL. Consecutive identical URLs within a short window
   * are collapsed (OS relays can fire twice). Before flush() arms the router
   * URLs are buffered; afterwards they are sent immediately.
   */
  enqueue(url: string): void {
    try {
      if (!url) return;
      const now = Date.now();
      if (url === this.lastEnqueued && now - this.lastEnqueuedAt < DEDUPE_WINDOW_MS) return;
      this.lastEnqueued = url;
      this.lastEnqueuedAt = now;

      if (this.armed) {
        this.send(url);
        return;
      }
      this.queue.push(url);
      if (this.queue.length > MAX_BUFFERED) {
        this.queue.splice(0, this.queue.length - MAX_BUFFERED);
      }
    } catch (err) {
      console.warn("[ScreenLink] deep-link enqueue failed:", err);
    }
  }

  /**
   * Arm the router and push buffered URLs to the renderer (FIFO, capped).
   * Buffered URLs stay queued until drainPending() — if the renderer missed
   * the push (subscribed late), it can still pull them via get-pending.
   */
  flush(): void {
    try {
      this.armed = true;
      const batch = this.queue.slice(0, MAX_BUFFERED);
      for (const url of batch) this.send(url);
    } catch (err) {
      console.warn("[ScreenLink] deep-link flush failed:", err);
    }
  }

  setRendererReady(): void {
    this.flush();
  }

  /** Return every buffered URL (sent or not) and clear the buffer. */
  drainPending(): string[] {
    try {
      const pending = this.queue;
      this.queue = [];
      return pending;
    } catch (err) {
      console.warn("[ScreenLink] deep-link drain failed:", err);
      return [];
    }
  }

  private send(url: string): void {
    try {
      this.sendToRenderer(DEEP_LINK_CHANNEL, url);
    } catch (err) {
      console.warn("[ScreenLink] deep-link send failed:", err);
    }
  }
}
