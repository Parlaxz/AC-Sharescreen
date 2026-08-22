// @vitest-environment node
/**
 * Focused tests for ViewerSession host peer resolution — the bounded wait
 * added to runJoinFlow() so a transient null from conn.peerForDevice()
 * does not immediately fail with "host not connected".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Hoisted mock setup ────────────────────────────────────────────────────
const mockViewerClientMethods = vi.hoisted(() => ({
  createAndConnect: vi.fn(),
  view: vi.fn(),
  stopViewing: vi.fn(),
  disconnect: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getSDK: vi.fn(),
  sendMediaBind: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

const mockRuntimeMethods = vi.hoisted(() => ({
  getConnectionManager: vi.fn(),
  getStreamSessionManager: vi.fn(),
  waitForJoinResponse: vi.fn(),
  cancelJoinResponse: vi.fn(),
  waitForViewerPauseResult: vi.fn(),
  cancelViewerPauseResult: vi.fn(),
  isDestroyed: vi.fn(),
  deviceId: "my-device",
  displayName: "Test Viewer",
}));

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  getRuntime: vi.fn(),
}));

vi.mock("@screenlink/vdo-adapter", () => ({
  ViewerClient: vi.fn(() => ({
    createAndConnect: mockViewerClientMethods.createAndConnect,
    view: mockViewerClientMethods.view,
    stopViewing: mockViewerClientMethods.stopViewing,
    disconnect: mockViewerClientMethods.disconnect,
    shutdown: mockViewerClientMethods.shutdown,
    getSDK: mockViewerClientMethods.getSDK,
    sendMediaBind: mockViewerClientMethods.sendMediaBind,
    on: mockViewerClientMethods.on,
    off: mockViewerClientMethods.off,
  })),
}));

import { getRuntime } from "../src/renderer/services/phase3-runtime.js";
import { ViewerSession } from "../src/renderer/services/viewer-session.js";

function makeMockRuntime() {
  const sendToPeer = vi.fn().mockResolvedValue(undefined);
  const conn = {
    sendToPeer,
    peerForDevice: vi.fn().mockReturnValue("peer-uuid-host"),
  };
  const connManager = { getConnection: vi.fn().mockReturnValue(conn) };
  const ssm = { getCaptureStream: vi.fn().mockReturnValue(null) };
  return {
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ssm,
    waitForJoinResponse: mockRuntimeMethods.waitForJoinResponse,
    cancelJoinResponse: mockRuntimeMethods.cancelJoinResponse,
    waitForViewerPauseResult: mockRuntimeMethods.waitForViewerPauseResult,
    cancelViewerPauseResult: mockRuntimeMethods.cancelViewerPauseResult,
    deviceId: mockRuntimeMethods.deviceId,
    displayName: mockRuntimeMethods.displayName,
    isDestroyed: mockRuntimeMethods.isDestroyed,
    __conn: conn,
    __sendToPeer: sendToPeer,
  };
}

const BASE_OPTIONS = {
  groupId: "g-1",
  hostDeviceId: "host-1",
  logicalStreamId: "ls-1",
  mediaSessionId: "ms-1",
  hostName: "Host",
};

describe("ViewerSession — host peer resolution (bounded wait)", () => {
  let session: ViewerSession;
  let runtime: ReturnType<typeof makeMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = makeMockRuntime();
    (getRuntime as ReturnType<typeof vi.fn>).mockReturnValue(runtime);
    mockRuntimeMethods.isDestroyed.mockReturnValue(false);
    session = new ViewerSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    session.destroy();
    vi.restoreAllMocks();
  });

  // ── Test 1: Immediate mapping fast path ─────────────────────────────

  it("returns peer immediately when already mapped — no delay in join flow", async () => {
    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "ls-1",
      password: "vdo-password",
    });
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-1", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);

    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    await session.start(BASE_OPTIONS);

    expect(errors).toEqual([]);
    expect(session.state).not.toBe("error");
    // Verify stream.join.request was sent (proves peer was resolved)
    expect(runtime.__sendToPeer).toHaveBeenCalledWith(
      "peer-uuid-host",
      expect.objectContaining({ type: "stream.join.request" }),
    );
  });

  // ── Test 2: Mapping appears during bounded wait ─────────────────────

  it("waits for host peer UUID to appear and then proceeds", async () => {
    vi.useFakeTimers();
    const peerForDevice = vi.fn()
      .mockReturnValueOnce(null)       // fast path in waitForHostPeer
      .mockReturnValueOnce(null)       // 1st poll
      .mockReturnValueOnce("peer-uuid-host"); // 2nd poll — found!
    runtime.__conn.peerForDevice = peerForDevice;

    mockRuntimeMethods.waitForJoinResponse.mockResolvedValue({
      accepted: true,
      mediaJoinMetadata: "test-token",
      mediaSessionId: "ms-1",
      streamId: "ls-1",
      password: "vdo-password",
    });
    mockViewerClientMethods.createAndConnect.mockResolvedValue(undefined);
    mockViewerClientMethods.view.mockResolvedValue(undefined);
    mockViewerClientMethods.getSDK.mockReturnValue({
      connections: new Map([["pub-uuid-1", { viewer: null, publisher: null }]]),
    });
    mockViewerClientMethods.sendMediaBind.mockResolvedValue(undefined);

    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    const startPromise = session.start(BASE_OPTIONS);

    // Advance timers past two poll intervals (fast path failed, two polls needed)
    await vi.advanceTimersByTimeAsync(300);

    // Now the peer should have been resolved and the flow continued
    await startPromise;

    expect(errors).toEqual([]);
    expect(session.state).not.toBe("error");
    // stream.join.request must have been sent (proves wait → continue)
    expect(runtime.__sendToPeer).toHaveBeenCalledWith(
      "peer-uuid-host",
      expect.objectContaining({ type: "stream.join.request" }),
    );
  });

  // ── Test 3: Mapping never appears → "host not connected" error ──────

  it("errors with 'host not connected' after the bounded wait times out", async () => {
    vi.useFakeTimers();
    runtime.__conn.peerForDevice = vi.fn().mockReturnValue(null);

    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    const stateChanges: string[] = [];
    session.onStateChange = (s) => stateChanges.push(s);

    const startPromise = session.start(BASE_OPTIONS);

    // Advance timers past the 5-second timeout
    await vi.advanceTimersByTimeAsync(5_100);

    await startPromise;

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toBe("host not connected");
    expect(session.state).toBe("error");
    // Should have gone through connecting → requesting-join → error
    expect(stateChanges).toContain("error");
  });

  // ── Test 4: Destroy during the wait → no error surfaced ────────────

  it("destroy during peer wait leaves session ended and does not surface error", async () => {
    vi.useFakeTimers();
    runtime.__conn.peerForDevice = vi.fn().mockReturnValue(null);

    const errors: string[] = [];
    session.onError = (e) => errors.push(e);

    const startPromise = session.start(BASE_OPTIONS);

    // Advance one poll interval so the wait loop is inside its first await
    await vi.advanceTimersByTimeAsync(150);

    // Destroy while the wait loop is still polling
    const destroyPromise = session.destroy();

    // Advance remaining time past the timeout — the wait loop should detect
    // the session is no longer current and bail without setting error.
    await vi.advanceTimersByTimeAsync(5_000);

    await startPromise;
    await destroyPromise;

    // No error should have been surfaced — isCurrent() guard prevented it
    expect(errors).toEqual([]);
    // Session should be in ended state (from destroy), not error
    expect(session.state).toBe("ended");
  });
});
