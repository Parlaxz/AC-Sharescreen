// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";

const mocks = vi.hoisted(() => ({
  detachGroupFromRuntime: vi.fn(async () => undefined),
  leaveGroup: vi.fn(async () => undefined),
  showNotification: vi.fn(),
}));

vi.mock("../src/renderer/services/group-record-helper.js", () => ({
  detachGroupFromRuntime: mocks.detachGroupFromRuntime,
}));

vi.mock("../src/renderer/services/get-api.js", () => ({
  getApi: () => ({ leaveGroup: mocks.leaveGroup }),
}));

vi.mock("../src/renderer/services/notifications.js", () => ({
  showNotification: mocks.showNotification,
}));

type FakeConn = {
  state: string;
  connectedPeers: string[];
  rawDataPeerUuids: string[];
};

function makeFakeConn(overrides?: Partial<FakeConn>): FakeConn {
  return {
    state: "connected",
    connectedPeers: [],
    rawDataPeerUuids: [],
    ...overrides,
  };
}

const SELF_DEVICE_ID = "self-device";

function makeFakeSync() {
  return {
    state: {
      name: { value: "Test Group" },
      members: {
        me: {
          deviceId: SELF_DEVICE_ID,
          displayName: "Me",
          firstSeenAt: 1,
          profileStamp: { wallTimeMs: 1, counter: 0, nodeId: SELF_DEVICE_ID },
        },
        other: {
          deviceId: "other",
          displayName: "Other",
          firstSeenAt: 1,
          profileStamp: { wallTimeMs: 1, counter: 0, nodeId: "other" },
        },
      },
    },
  };
}

function makeRuntime(opts?: {
  conn?: FakeConn | null;
  getConnection?: (groupId: string) => FakeConn | null | undefined;
}) {
  const announceLocalLeave = vi.fn(async () => true);
  const getSyncState = vi.fn(() => makeFakeSync());
  const runtime = {
    getConnectionManager: () => ({
      getConnection:
        opts?.getConnection ??
        (() => (opts?.conn === undefined ? makeFakeConn() : opts.conn)),
    }),
    getSyncService: () => ({ announceLocalLeave, getSyncState }),
    getActiveStreamRegistry: () => ({ getStreamsByGroup: () => [] }),
  } as unknown as Phase3Runtime;
  return { runtime, announceLocalLeave, getSyncState };
}

async function importWatcher(): Promise<
  typeof import("../src/renderer/services/defunct-group-watch.js")
> {
  return await import("../src/renderer/services/defunct-group-watch.js");
}

describe("watchGroupForDefunct", () => {
  let groupIdCounter = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    mocks.detachGroupFromRuntime.mockClear();
    mocks.leaveGroup.mockClear();
    mocks.showNotification.mockClear();
    groupIdCounter++;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dissolves after two consecutive qualifying ticks", async () => {
    const gid = `group-dissolve-${groupIdCounter}`;
    const { runtime, announceLocalLeave } = makeRuntime();
    const { watchGroupForDefunct } = await importWatcher();

    watchGroupForDefunct(runtime, gid, { selfDeviceId: SELF_DEVICE_ID });

    // Tick 1: eligible but only one consecutive hit — no dissolve yet.
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(announceLocalLeave).not.toHaveBeenCalled();
    expect(mocks.leaveGroup).not.toHaveBeenCalled();

    // Tick 2: second consecutive qualifying tick → dissolve.
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(announceLocalLeave).toHaveBeenCalledTimes(1);
    expect(announceLocalLeave).toHaveBeenCalledWith(gid);
    expect(mocks.leaveGroup).toHaveBeenCalledTimes(1);
    expect(mocks.leaveGroup).toHaveBeenCalledWith(gid);
    expect(mocks.detachGroupFromRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.detachGroupFromRuntime).toHaveBeenCalledWith(gid);
    expect(mocks.showNotification).toHaveBeenCalledTimes(1);
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "ScreenLink",
        body: expect.stringContaining("Test Group"),
      }),
    );
  });

  it("never dissolves when the local device is the creator", async () => {
    const gid = `group-creator-${groupIdCounter}`;
    const { runtime, announceLocalLeave } = makeRuntime();
    const { watchGroupForDefunct } = await importWatcher();

    watchGroupForDefunct(runtime, gid, {
      selfDeviceId: SELF_DEVICE_ID,
      creatorDeviceId: SELF_DEVICE_ID,
    });

    // Advance past the full poll budget (MAX_TICKS=10 × 2000ms).
    await vi.advanceTimersByTimeAsync(12 * 2_000);
    await Promise.resolve();
    expect(announceLocalLeave).not.toHaveBeenCalled();
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });

  it("never dissolves while raw data peers are present", async () => {
    const gid = `group-rawpeer-${groupIdCounter}`;
    const { runtime, announceLocalLeave } = makeRuntime({
      conn: makeFakeConn({ rawDataPeerUuids: ["raw-peer-1"] }),
    });
    const { watchGroupForDefunct } = await importWatcher();

    watchGroupForDefunct(runtime, gid, { selfDeviceId: SELF_DEVICE_ID });

    await vi.advanceTimersByTimeAsync(12 * 2_000);
    await Promise.resolve();
    expect(announceLocalLeave).not.toHaveBeenCalled();
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });

  it("resets the consecutive counter on a non-qualifying tick and dissolves later", async () => {
    const gid = `group-recover-${groupIdCounter}`;
    let conn = makeFakeConn();
    const { runtime, announceLocalLeave } = makeRuntime({
      getConnection: () => conn,
    });
    const { watchGroupForDefunct } = await importWatcher();

    watchGroupForDefunct(runtime, gid, { selfDeviceId: SELF_DEVICE_ID });

    // Tick 1: qualifying → consecutiveHits = 1.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(announceLocalLeave).not.toHaveBeenCalled();

    // Tick 2: a peer appears → not qualifying, counter resets.
    conn = makeFakeConn({ connectedPeers: ["peer-1"] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(announceLocalLeave).not.toHaveBeenCalled();

    // Tick 3: peer disappears again → consecutiveHits = 1.
    conn = makeFakeConn();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(announceLocalLeave).not.toHaveBeenCalled();

    // Tick 4: second consecutive qualifying tick → dissolve.
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(announceLocalLeave).toHaveBeenCalledTimes(1);
    expect(mocks.leaveGroup).toHaveBeenCalledTimes(1);
    expect(mocks.showNotification).toHaveBeenCalledTimes(1);
  });

  it("aborts quietly when the connection disappears", async () => {
    const gid = `group-abort-${groupIdCounter}`;
    // First tick sees no connection (abort); afterwards a fully qualifying
    // connection reappears — but the watcher must already be gone.
    let calls = 0;
    const { runtime, announceLocalLeave } = makeRuntime({
      getConnection: () => {
        calls++;
        return calls === 1 ? null : makeFakeConn();
      },
    });
    const { watchGroupForDefunct } = await importWatcher();

    watchGroupForDefunct(runtime, gid, { selfDeviceId: SELF_DEVICE_ID });

    // Tick 1: no connection → interval cleared.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(1);

    // Later ticks do nothing: the interval was cleared on abort.
    await vi.advanceTimersByTimeAsync(12 * 2_000);
    await Promise.resolve();
    expect(calls).toBe(1); // nothing polled after abort
    expect(announceLocalLeave).not.toHaveBeenCalled();
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });
});
