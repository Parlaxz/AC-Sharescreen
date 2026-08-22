// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GroupConnectionManager } from "../src/renderer/services/group-connection-manager.js";
import { GroupControlConnection } from "../src/renderer/services/group-control-connection.js";

// Mock GroupControlConnection to avoid SDK dependency
vi.mock("../src/renderer/services/group-control-connection.js", () => ({
  GroupControlConnection: vi.fn(() => {
    let _state: string = "idle";
    return {
      get state() { return _state; },
      set state(s: string) { _state = s; },
      start: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue({ attempted: 1, sent: 1, failed: 0 }),
      sendToPeer: vi.fn().mockResolvedValue(true),
      get connectedPeers() { return []; },
      peerForDevice: vi.fn().mockReturnValue(null),
    };
  }),
}));

/** Insert a controllable mock connection directly into the private connections Map. */
function injectConnection(gcm: GroupConnectionManager, groupId: string, initialState: string): { setState: (s: string) => void; getState: () => string } {
  const ctrl = { _state: initialState };
  const mockConn = {
    get state() { return ctrl._state; },
    set state(s: string) { ctrl._state = s; },
    start: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue({ attempted: 1, sent: 1, failed: 0 }),
    sendToPeer: vi.fn().mockResolvedValue(true),
    get connectedPeers() { return [] as string[]; },
    peerForDevice: vi.fn().mockReturnValue(null),
  };
  (gcm as unknown as { connections: Map<string, unknown> }).connections.set(groupId, mockConn);
  return {
    setState: (s: string) => { ctrl._state = s; },
    getState: () => ctrl._state,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ensureConnected behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe("GroupConnectionManager — ensureConnected behavior", () => {
  let gcm: GroupConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    gcm = new GroupConnectionManager();
  });

  afterEach(async () => {
    await gcm.destroyAll().catch(() => {});
  });

  it("CHARACTERIZATION: ensureConnected rejects for unknown group", async () => {
    await expect(gcm.ensureConnected("nonexistent-group")).rejects.toThrow(
      "The selected group is not connected"
    );
  });

  it("CHARACTERIZATION: ensureConnected resolves immediately when already connected", async () => {
    injectConnection(gcm, "existing-group", "connected");
    await expect(gcm.ensureConnected("existing-group", 5_000)).resolves.toBeUndefined();
  });

  it("CHARACTERIZATION: ensureConnected rejects immediately for idle connection", async () => {
    vi.useFakeTimers();
    try {
      injectConnection(gcm, "idle-group", "idle");
      // The idle path rejects immediately via the "idle" branch (not after timeout)
      await expect(gcm.ensureConnected("idle-group", 1_000)).rejects.toThrow(
        "The selected group is not connected"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("CHARACTERIZATION: ensureConnected rejects after timeout for starting connection", async () => {
    vi.useFakeTimers();
    try {
      injectConnection(gcm, "starting-group", "starting");
      const promise = gcm.ensureConnected("starting-group", 500);
      vi.advanceTimersByTime(600);
      await expect(promise).rejects.toThrow("The selected group is not connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("CHARACTERIZATION: ensureConnected rejects when connection is destroyed", async () => {
    injectConnection(gcm, "destroyed-group", "destroyed");
    await expect(gcm.ensureConnected("destroyed-group")).rejects.toThrow(
      "The selected group is not connected"
    );
  });

  it("CHARACTERIZATION: isConnected returns false for non-existent group", () => {
    expect(gcm.isConnected("nonexistent")).toBe(false);
  });

  it("CHARACTERIZATION: getConnection returns null for non-existent group", () => {
    expect(gcm.getConnection("nonexistent")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Pending lifecycle queue behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe("GroupConnectionManager — pending lifecycle queue", () => {
  let gcm: GroupConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    gcm = new GroupConnectionManager();
  });

  afterEach(async () => {
    await gcm.destroyAll().catch(() => {});
  });

  it("CHARACTERIZATION: clearPendingForStream with no queue does not throw", () => {
    expect(() => gcm.clearPendingForStream("nonexistent-group", "stream-1")).not.toThrow();
  });

  it("CHARACTERIZATION: clearPendingForGroup with no queue does not throw", () => {
    expect(() => gcm.clearPendingForGroup("nonexistent-group")).not.toThrow();
  });

  it("CHARACTERIZATION: clearAllPending does not throw when empty", () => {
    expect(() => gcm.clearAllPending()).not.toThrow();
  });

  it("CHARACTERIZATION: flushPendingLifecycle with no queue does not throw", async () => {
    await expect(gcm.flushPendingLifecycle("nonexistent-group")).resolves.toBeUndefined();
  });

  it("CHARACTERIZATION: flushPendingLifecycleToPeer with no queue does not throw", async () => {
    await expect(gcm.flushPendingLifecycleToPeer("nonexistent-group", "peer-uuid")).resolves.toBeUndefined();
  });

  it("CHARACTERIZATION: broadcast for non-existent group returns zero counts", async () => {
    const result = await gcm.broadcast("nonexistent", { type: "test" });
    expect(result).toEqual({ attempted: 0, sent: 0, failed: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. State management
// ═══════════════════════════════════════════════════════════════════════════════

describe("GroupConnectionManager — state management", () => {
  let gcm: GroupConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    gcm = new GroupConnectionManager();
  });

  afterEach(async () => {
    await gcm.destroyAll().catch(() => {});
  });

  it("CHARACTERIZATION: states returns empty map initially", () => {
    const states = gcm.states;
    expect(states.size).toBe(0);
  });

  it("CHARACTERIZATION: removeGroup with no active connection does not throw", async () => {
    await expect(gcm.removeGroup("nonexistent")).resolves.toBeUndefined();
  });
});
