// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StreamSessionManager } from "../src/renderer/services/stream-session-manager.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeMockRuntime(): Phase3Runtime {
  const registry = {
    registerLocalStream: vi.fn(),
    handleStopped: vi.fn(),
    getStream: vi.fn().mockReturnValue(null),
    getAllStreams: vi.fn().mockReturnValue([]),
    getStreamsByGroup: vi.fn().mockReturnValue([]),
  };
  const connManager = {
    broadcast: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue(null),
  };
  const viewerBinding = {
    removeViewer: vi.fn(),
    rejectPending: vi.fn(),
    getAllViewers: vi.fn().mockReturnValue([] as Array<{ viewerDeviceId: string; mediaPeerUuid: string }>),
  };
  return {
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ({}),
    getViewerMediaBinding: () => viewerBinding,
    viewerBinding, // expose for test assertions
  } as unknown as Phase3Runtime & { viewerBinding: typeof viewerBinding };
}

/**
 * Setup navigator.mediaDevices mock for node environment.
 * Uses Object.defineProperty since globalThis.navigator is read-only.
 */
function mockNavigatorMediaDevices(): void {
  const origNavigator = (globalThis as any).navigator;
  if (origNavigator && origNavigator.mediaDevices) return; // already exists

  const mockMediaDevices = {
    getDisplayMedia: vi.fn().mockRejectedValue(new Error("No display media in test env")),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  };

  if (origNavigator) {
    (origNavigator as any).mediaDevices = mockMediaDevices;
  } else {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: mockMediaDevices },
      writable: true,
      configurable: true,
    });
  }
}

describe("StreamSessionManager (Stage 4)", () => {
  let ssm: StreamSessionManager;
  let runtime: Phase3Runtime;

  beforeEach(() => {
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── StartStreamInput shape ─────────────────────────────────────────

  it("accepts StartStreamInput with source object", () => {
    const input = {
      groupId: "test-group-1",
      source: {
        id: "source-1",
        name: "My Screen",
        kind: "screen" as const,
        displayId: "display-1",
        fingerprint: "fp-123",
      },
    };
    expect(input.groupId).toBe("test-group-1");
    expect(input.source.name).toBe("My Screen");
    expect(input.source.kind).toBe("screen");
    expect(input.source.displayId).toBe("display-1");
    expect(input.source.fingerprint).toBe("fp-123");
  });

  // ── State transitions ─────────────────────────────────────────────

  it("starts in idle state", () => {
    expect(ssm.state).toBe("idle");
  });

  it("fails startStream when getDisplayMedia fails (node env)", async () => {
    mockNavigatorMediaDevices();
    await expect(ssm.startStream({
      groupId: "test-g-1",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).rejects.toThrow();
    expect(ssm.state).toBe("failed");
  });

  it("rejects startStream when not idle or failed", async () => {
    (ssm as any)._state = "active";
    expect(ssm.state).toBe("active");

    await expect(ssm.startStream({
      groupId: "test-g-1",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).resolves.toBeUndefined();
    expect(ssm.state).toBe("active");
  });

  it("rejects startStream when destroyed", async () => {
    ssm.destroy();
    await expect(ssm.startStream({
      groupId: "test-g-1",
      source: { id: "s1", name: "Screen", kind: "screen", displayId: null, fingerprint: null },
    })).resolves.toBeUndefined();
    expect(ssm.state).toBe("destroyed");
  });

  // ── Stop stream ──────────────────────────────────────────────────

  it("stopStream is idempotent when already idle", async () => {
    await expect(ssm.stopStream()).resolves.toBeUndefined();
    expect(ssm.state).toBe("idle");
  });

  it("stopStream broadcasts stream.stopped and cleans up when active", async () => {
    const connManager = runtime.getConnectionManager();
    const registry = runtime.getActiveStreamRegistry();

    (ssm as any)._state = "active";
    (ssm as any).groupId = "test-g-1";
    (ssm as any).logicalStreamId = "ls-1";
    (ssm as any).mediaSessionId = "ms-1";
    (ssm as any)._hostDeviceId = "dev-1";
    (ssm as any)._hostDisplayName = "Host";

    await ssm.stopStream();

    expect(connManager.broadcast).toHaveBeenCalledWith("test-g-1", expect.objectContaining({
      type: "stream.stopped",
      groupId: "test-g-1",
    }));
    expect(registry.handleStopped).toHaveBeenCalledWith({
      groupId: "test-g-1",
      hostDeviceId: "dev-1",
      logicalStreamId: "ls-1",
    });
    expect(ssm.state).toBe("idle");
  });

  // ── SetDeviceIdentity ────────────────────────────────────────────

  it("setDeviceIdentity stores device identity", () => {
    ssm.setDeviceIdentity("dev-123", "Alice");
    expect(ssm.hostDeviceId).toBe("dev-123");
    expect(ssm.hostDisplayName).toBe("Alice");
  });

  // ── PublisherManager access ──────────────────────────────────────

  it("getPublisherManager returns null before startStream", () => {
    expect(ssm.getPublisherManager()).toBeNull();
  });

  it("getCurrentVdoConfig returns null before startStream", () => {
    expect(ssm.getCurrentVdoConfig()).toBeNull();
  });

  // ── setAudioController ───────────────────────────────────────────

  it("setAudioController does not throw when publisher manager is null", () => {
    expect(() => ssm.setAudioController(null as any, "none")).not.toThrow();
  });

  // ── Destroy ──────────────────────────────────────────────────────

  it("destroy transitions to destroyed state", () => {
    ssm.destroy();
    expect(ssm.state).toBe("destroyed");
  });

  it("destroy is idempotent", () => {
    ssm.destroy();
    ssm.destroy();
    expect(ssm.state).toBe("destroyed");
  });

  // ── Restart ──────────────────────────────────────────────────────

  it("restartStream requires active state", async () => {
    await expect(ssm.restartStream("new-media-session")).resolves.toBeUndefined();
    expect(ssm.state).toBe("idle");
  });

  it("restartStream is no-op when destroyed", async () => {
    ssm.destroy();
    await expect(ssm.restartStream("new-ms-id")).resolves.toBeUndefined();
    expect(ssm.state).toBe("destroyed");
  });

  // ── StreamAnnouncement building ──────────────────────────────────

  it("buildAnnouncement includes all required fields", () => {
    (ssm as any)._state = "active";
    (ssm as any).groupId = "g-1";
    (ssm as any).logicalStreamId = "ls-1";
    (ssm as any).mediaSessionId = "ms-1";
    (ssm as any)._hostDeviceId = "dev-1";
    (ssm as any)._hostDisplayName = "Host";
    (ssm as any).startedAt = 1000;
    (ssm as any).heartbeatSeq = 1;
    (ssm as any).streamRevision = 1;

    const ann = (ssm as any).buildAnnouncement();
    expect(ann).toMatchObject({
      logicalStreamId: "ls-1",
      mediaSessionId: "ms-1",
      groupId: "g-1",
      hostDeviceId: "dev-1",
      hostDisplayName: "Host",
      heartbeatSequence: 1,
      streamRevision: 1,
    });
  });

  // ── Heartbeat ────────────────────────────────────────────────────

  it("sendHeartbeat is no-op when not active", async () => {
    await expect((ssm as any).sendHeartbeat()).resolves.toBeUndefined();
  });

  it("sendHeartbeat broadcasts to the group when active", async () => {
    const connManager = runtime.getConnectionManager();
    (ssm as any)._state = "active";
    (ssm as any).groupId = "g-1";
    (ssm as any).logicalStreamId = "ls-1";
    (ssm as any).mediaSessionId = "ms-1";
    (ssm as any)._hostDeviceId = "dev-1";
    (ssm as any)._hostDisplayName = "Host";

    await (ssm as any).sendHeartbeat();

    expect(connManager.broadcast).toHaveBeenCalledWith("g-1", expect.objectContaining({
      type: "stream.heartbeat",
      groupId: "g-1",
      hostDeviceId: "dev-1",
      heartbeatSequence: 1,
    }));
  });

  it("stopStream calls getAllViewers on viewerMediaBinding", async () => {
    // The mock returns the same viewerBinding object each time
    const { viewerBinding } = runtime as unknown as { viewerBinding: { getAllViewers: ReturnType<typeof vi.fn> } };
    (ssm as any)._state = "active";
    (ssm as any).groupId = "g-1";
    (ssm as any).logicalStreamId = "ls-1";
    (ssm as any).mediaSessionId = "ms-1";
    (ssm as any)._hostDeviceId = "dev-1";

    await ssm.stopStream();

    expect(viewerBinding.getAllViewers).toHaveBeenCalled();
  });
});
