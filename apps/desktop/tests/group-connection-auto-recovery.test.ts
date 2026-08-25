// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GroupConnectionManager } from "../src/renderer/services/group-connection-manager.js";

type FakeConn = {
  groupId: string;
  state: string;
  destroyed: boolean;
  connectedPeers: string[];
  start: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function makeFakeConn(groupId: string, state = "failed"): FakeConn {
  const conn: FakeConn = {
    groupId,
    state,
    destroyed: false,
    connectedPeers: [],
    start: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
  conn.destroy.mockImplementation(() => {
    conn.state = "destroyed";
    // Match the real GroupControlConnection.destroy(): Promise<void> contract —
    // destroyAll() chains .catch() on the return value.
    return Promise.resolve();
  });
  return conn;
}

function inject(gcm: GroupConnectionManager, conn: FakeConn): void {
  (gcm as unknown as { connections: Map<string, FakeConn> }).connections.set(conn.groupId, conn);
}

describe("GroupConnectionManager â€” failed-connection auto-recovery", () => {
  let gcm: GroupConnectionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    gcm = new GroupConnectionManager();
  });

  afterEach(() => {
    gcm.destroyAll();
    vi.useRealTimers();
  });

  it("schedules a retry when a connection enters the failed state", async () => {
    const conn = makeFakeConn("g1", "failed");
    inject(gcm, conn);

    (gcm as unknown as { scheduleFailedRetry: (id: string) => void }).scheduleFailedRetry("g1");
    expect(conn.start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(conn.start).toHaveBeenCalledTimes(1);
  });

  it("escalates backoff across repeated failures and gives up after the cap", async () => {
    const conn = makeFakeConn("g1", "failed");
    inject(gcm, conn);
    const sched = (gcm as unknown as { scheduleFailedRetry: (id: string) => void })
      .scheduleFailedRetry.bind(gcm);

    // Each attempt must be scheduled after the previous one fires â€” a
    // schedule request while a retry is pending collapses into it.
    const steps = [2_000, 4_000, 8_000, 15_000, 15_000];
    for (let i = 0; i < steps.length; i++) {
      sched("g1");
      await vi.advanceTimersByTimeAsync(steps[i]);
      expect(conn.start).toHaveBeenCalledTimes(i + 1);
    }

    // Cap reached â€” no further retries scheduled.
    sched("g1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(conn.start).toHaveBeenCalledTimes(steps.length);
  });

  it("clears pending retries when the group is removed", async () => {
    const conn = makeFakeConn("g1", "failed");
    inject(gcm, conn);

    (gcm as unknown as { scheduleFailedRetry: (id: string) => void }).scheduleFailedRetry("g1");
    await gcm.removeGroup("g1");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(conn.start).not.toHaveBeenCalled();
  });

  it("clears retries when the connection reports connected", async () => {
    const conn = makeFakeConn("g1", "failed");
    inject(gcm, conn);

    (gcm as unknown as { scheduleFailedRetry: (id: string) => void }).scheduleFailedRetry("g1");
    conn.state = "connected";
    // Connected transition clears the retry via clearFailedRetry.
    (
      gcm as unknown as {
        clearFailedRetry: (id: string) => void;
      }
    ).clearFailedRetry("g1");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(conn.start).not.toHaveBeenCalled();
  });
});

describe("GroupConnectionManager â€” ensureConnected recovery for failed connections", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("nudges a failed connection via start() and resolves once it connects", async () => {
    const gcm = new GroupConnectionManager();
    const conn = makeFakeConn("g1", "failed");
    inject(gcm, conn);

    conn.start.mockImplementation(async () => {
      conn.state = "starting";
      // Simulate the mesh coming up shortly after the restart nudge.
      setTimeout(() => {
        conn.state = "connected";
      }, 300);
    });

    await expect(gcm.ensureConnected("g1", 5_000)).resolves.toBeUndefined();
    expect(conn.start).toHaveBeenCalled();
    gcm.destroyAll();
  });

  it("rejects within the budget when the connection never recovers", async () => {
    const gcm = new GroupConnectionManager();
    const conn = makeFakeConn("g1", "failed");
    inject(gcm, conn);

    await expect(gcm.ensureConnected("g1", 1_000)).rejects.toThrow(/not connected/i);
    gcm.destroyAll();
  });
});

describe("GroupConnectionManager â€” connection churn stress", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("concurrent ensureConnected callers trigger exactly one start", async () => {
    const gcm = new GroupConnectionManager();
    const conn = makeFakeConn("g1", "idle");
    inject(gcm, conn);

    let releaseStart: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseStart = r; });
    conn.start.mockImplementation(() => {
      conn.state = "starting";
      return gate.then(() => {
        conn.state = "connected";
      });
    });

    const calls = Array.from({ length: 10 }, () => gcm.ensureConnected("g1", 5_000));

    // Poll interval is 200ms; give the nudges time to fire exactly once.
    await vi.waitFor(() => expect(conn.start).toHaveBeenCalledTimes(1));

    releaseStart();
    await Promise.all(calls.map((p) => expect(p).resolves.toBeUndefined()));
    expect(conn.start).toHaveBeenCalledTimes(1);
    gcm.destroyAll();
  });

  it("removeGroup during active recovery rejects cleanly with no late start", async () => {
    vi.useFakeTimers();
    const gcm = new GroupConnectionManager();
    const conn = makeFakeConn("g1", "failed");
    inject(gcm, conn);

    const pending = gcm.ensureConnected("g1", 15_000);
    const expectation = expect(pending).rejects.toThrow(/not connected/i);

    await vi.advanceTimersByTimeAsync(200); // first poll nudges start once
    const callsAtRemoval = conn.start.mock.calls.length;
    expect(callsAtRemoval).toBe(1);

    await gcm.removeGroup("g1"); // destroys conn -> state "destroyed"

    await vi.advanceTimersByTimeAsync(60_000);
    await expectation;
    // No late start after removal — the removed connection stays dead.
    expect(conn.start).toHaveBeenCalledTimes(callsAtRemoval);
  });
});

