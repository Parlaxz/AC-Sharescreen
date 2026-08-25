// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractScreenLinkUrls,
  DeepLinkRouter,
  DEEP_LINK_CHANNEL,
} from "../src/main/deep-link.js";

describe("extractScreenLinkUrls", () => {
  it("picks screenlink:// args case-insensitively", () => {
    const argv = [
      "SCREENLINK://group?id=abc",
      "screenlink://group?id=def",
      "ScreenLink://group?id=ghi",
    ];
    expect(extractScreenLinkUrls(argv)).toEqual([
      "SCREENLINK://group?id=abc",
      "screenlink://group?id=def",
      "ScreenLink://group?id=ghi",
    ]);
  });

  it("preserves argv order", () => {
    const argv = [
      "--flag",
      "screenlink://group?id=first",
      "other.exe",
      "screenlink://group?id=second",
    ];
    expect(extractScreenLinkUrls(argv)).toEqual([
      "screenlink://group?id=first",
      "screenlink://group?id=second",
    ]);
  });

  it("ignores non-matching args", () => {
    const argv = [
      "app.exe",
      "--verbose",
      "https://example.com/group?id=x",
      "screenlink:/malformed",
      "notascreenlink://group?id=y",
    ];
    expect(extractScreenLinkUrls(argv)).toEqual([]);
  });

  it("returns [] for empty argv", () => {
    expect(extractScreenLinkUrls([])).toEqual([]);
  });
});

describe("DeepLinkRouter", () => {
  let sendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    sendToRenderer = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers URLs before flush and delivers them FIFO on flush", () => {
    const router = new DeepLinkRouter(sendToRenderer);
    router.enqueue("screenlink://group?id=1");
    router.enqueue("screenlink://group?id=2");
    router.enqueue("screenlink://group?id=3");

    // Nothing sent while disarmed.
    expect(sendToRenderer).not.toHaveBeenCalled();

    router.flush();

    expect(sendToRenderer).toHaveBeenCalledTimes(3);
    expect(sendToRenderer).toHaveBeenNthCalledWith(1, DEEP_LINK_CHANNEL, "screenlink://group?id=1");
    expect(sendToRenderer).toHaveBeenNthCalledWith(2, DEEP_LINK_CHANNEL, "screenlink://group?id=2");
    expect(sendToRenderer).toHaveBeenNthCalledWith(3, DEEP_LINK_CHANNEL, "screenlink://group?id=3");
  });

  it("dedupes consecutive identical URLs within the dedup window", () => {
    const router = new DeepLinkRouter(sendToRenderer);
    router.enqueue("screenlink://group?id=same");
    // OS relays can fire twice within milliseconds — collapsed.
    router.enqueue("screenlink://group?id=same");

    router.flush();
    expect(sendToRenderer).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledWith(DEEP_LINK_CHANNEL, "screenlink://group?id=same");

    // After the dedup window elapses the same URL is accepted again.
    vi.advanceTimersByTime(5_001);
    router.enqueue("screenlink://group?id=same");
    expect(sendToRenderer).toHaveBeenCalledTimes(2);
  });

  it("does not dedupe distinct consecutive URLs", () => {
    const router = new DeepLinkRouter(sendToRenderer);
    router.enqueue("screenlink://group?id=a");
    router.enqueue("screenlink://group?id=b");

    router.flush();
    expect(sendToRenderer).toHaveBeenCalledTimes(2);
  });

  it("caps buffered URLs at 5 (oldest dropped)", () => {
    const router = new DeepLinkRouter(sendToRenderer);
    for (let i = 1; i <= 7; i++) {
      router.enqueue(`screenlink://group?id=${i}`);
    }

    // The buffer kept only the newest 5.
    expect(router.drainPending()).toEqual([
      "screenlink://group?id=3",
      "screenlink://group?id=4",
      "screenlink://group?id=5",
      "screenlink://group?id=6",
      "screenlink://group?id=7",
    ]);

    // A router that flushes instead of draining delivers the same capped batch.
    const flushRouter = new DeepLinkRouter(sendToRenderer);
    for (let i = 1; i <= 7; i++) {
      flushRouter.enqueue(`screenlink://group?id=${i}`);
    }
    flushRouter.flush();
    expect(sendToRenderer).toHaveBeenCalledTimes(5);
    expect(sendToRenderer).toHaveBeenNthCalledWith(1, DEEP_LINK_CHANNEL, "screenlink://group?id=3");
    expect(sendToRenderer).toHaveBeenLastCalledWith(DEEP_LINK_CHANNEL, "screenlink://group?id=7");
  });

  it("drainPending returns and clears the pending buffer", () => {
    const router = new DeepLinkRouter(sendToRenderer);
    router.enqueue("screenlink://group?id=x");
    router.enqueue("screenlink://group?id=y");

    expect(router.drainPending()).toEqual([
      "screenlink://group?id=x",
      "screenlink://group?id=y",
    ]);
    expect(router.drainPending()).toEqual([]);
  });

  it("sends immediately once armed, on DEEP_LINK_CHANNEL with the URL string", () => {
    const router = new DeepLinkRouter(sendToRenderer);
    router.setRendererReady(); // arms the router

    router.enqueue("screenlink://group?id=warm");
    expect(sendToRenderer).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledWith(
      DEEP_LINK_CHANNEL,
      "screenlink://group?id=warm",
    );
    expect(typeof DEEP_LINK_CHANNEL).toBe("string");
  });
});
