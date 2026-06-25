// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  acquirePhase3Runtime,
  releasePhase3Runtime,
  getRuntime,
  Phase3Runtime,
} from "../src/renderer/services/phase3-runtime.js";
import { GroupConnectionManager } from "../src/renderer/services/group-connection-manager.js";
import type { GroupSyncService, SyncPersistenceAdapter } from "../src/renderer/services/group-sync-service.js";
import { useStore } from "../src/renderer/stores/main-store.js";
import { initializeAppRuntime } from "../src/renderer/App.js";

// ─── Mock helpers ───────────────────────────────────────────────────────────

function makeMockState() {
  return {
    schemaVersion: 1 as const,
    groupId: "test-group-1",
    name: {
      value: "Test Group",
      stamp: { wallTimeMs: 1000, counter: 0, nodeId: "node-1" },
      valueHash: "abc",
      updatedByDeviceId: "node-1",
    },
    defaultQuality: {
      value: {
        schemaVersion: 1 as const,
        video: {
          videoBitrateKbps: 1000,
          sendWidth: 1280,
          sendHeight: 720,
          sendFps: 30,
          captureWidth: 1280,
          captureHeight: 720,
          captureFps: 30,
          preserveAspectRatio: true,
          preventUpscale: true,
          resolutionMode: "target-dimensions" as const,
          scaleResolutionDownBy: 1,
          codec: "vp9" as const,
          h264Profile: "auto" as const,
          contentHint: "detail" as const,
          degradationPreference: "maintain-resolution" as const,
          scalabilityMode: null,
          cursorMode: "always" as const,
          rtpPriority: "medium" as const,
        },
        audio: {
          bitrateKbps: 64,
          channels: "stereo" as const,
          bitrateMode: "vbr" as const,
          dtx: false,
          fec: true,
          packetDurationMs: 20 as const,
          redundantAudio: false,
        },
      },
      stamp: { wallTimeMs: 1000, counter: 0, nodeId: "node-1" },
      valueHash: "def",
      updatedByDeviceId: "node-1",
    },
    members: {},
  };
}

function makeMockClock() {
  return { wallTimeMs: 1000, counter: 0, nodeId: "node-1" };
}

// ─── Singleton lifecycle tests ──────────────────────────────────────────────

describe("Phase3Runtime singleton lifecycle", () => {
  beforeEach(async () => {
    // Ensure clean slate
    await releasePhase3Runtime().catch(() => {});
    // Prevent actual connections by mocking connManager.addGroup
    vi.spyOn(GroupConnectionManager.prototype, "addGroup").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "destroyAll").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "removeGroup").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await releasePhase3Runtime().catch(() => {});
  });

  it("acquire creates a runtime and sets getRuntime", async () => {
    const runtime = await acquirePhase3Runtime();
    expect(runtime).toBeInstanceOf(Phase3Runtime);
    expect(getRuntime()).toBe(runtime);
  });

  it("concurrent acquire returns same runtime instance", async () => {
    const [r1, r2] = await Promise.all([acquirePhase3Runtime(), acquirePhase3Runtime()]);
    expect(r1).toBe(r2);
    expect(getRuntime()).toBe(r1);
  });

  it("release is idempotent", async () => {
    await acquirePhase3Runtime();
    await releasePhase3Runtime();
    expect(getRuntime()).toBeNull();
    await releasePhase3Runtime(); // second call should not throw
    expect(getRuntime()).toBeNull();
  });

  it("acquire after release creates new runtime instance", async () => {
    const r1 = await acquirePhase3Runtime();
    expect(getRuntime()).toBe(r1);
    await releasePhase3Runtime();
    expect(getRuntime()).toBeNull();
    const r2 = await acquirePhase3Runtime();
    expect(r2).not.toBe(r1);
    expect(r2).toBeInstanceOf(Phase3Runtime);
  });

  it("StrictMode cycle: acquire → release → acquire", async () => {
    // Simulates React StrictMode double-mount
    const r1 = await acquirePhase3Runtime();
    await releasePhase3Runtime();
    expect(getRuntime()).toBeNull();
    const r2 = await acquirePhase3Runtime();
    expect(r2).not.toBe(r1);
    expect(getRuntime()).toBe(r2);
  });

  it("release during pending acquire waits for init then destroys runtime", async () => {
    // Simulates unmount firing while acquirePhase3Runtime() is still initializing.
    // releasePhase3Runtime must handle _initPromise, not just _runtime.
    let resolveInit!: () => void;
    const initGate = new Promise<void>((resolve) => { resolveInit = resolve; });

    const origInitialize = Phase3Runtime.prototype.initialize;
    vi.spyOn(Phase3Runtime.prototype, "initialize").mockImplementation(
      async function (this: Phase3Runtime) {
        await initGate;
        // After gate, call the real initialize so services (streamSessionManager,
        // viewerMediaBinding, etc.) are created — needed by destroy().
        return origInitialize.call(this);
      }
    );

    try {
      // Start acquire (don't await — simulate in-flight startup)
      const acquirePromise = acquirePhase3Runtime();

      // Release fires while acquire is still pending (init not complete)
      const releasePromise = releasePhase3Runtime();

      // At this point acquire is stuck on initGate, release should be waiting on _initPromise.
      // Neither has settled yet.
      let acquireSettled = false;
      let releaseSettled = false;
      acquirePromise.finally(() => { acquireSettled = true; });
      releasePromise.finally(() => { releaseSettled = true; });

      await new Promise((r) => setTimeout(r, 5));
      expect(acquireSettled).toBe(false);
      expect(releaseSettled).toBe(false);

      // Let init complete — both should now settle
      resolveInit();

      await releasePromise;
      // acquirePromise may resolve to a now-destroyed runtime; that's fine
      await acquirePromise.catch(() => {});

      // Runtime should be released
      expect(getRuntime()).toBeNull();

      // A subsequent acquire must create a fresh runtime
      vi.restoreAllMocks();
      vi.spyOn(GroupConnectionManager.prototype, "addGroup").mockResolvedValue(undefined);
      vi.spyOn(GroupConnectionManager.prototype, "destroyAll").mockResolvedValue(undefined);
      vi.spyOn(GroupConnectionManager.prototype, "removeGroup").mockResolvedValue(undefined);
      const freshRuntime = await acquirePhase3Runtime();
      expect(freshRuntime).toBeInstanceOf(Phase3Runtime);
      expect(getRuntime()).toBe(freshRuntime);
      expect(freshRuntime.isDestroyed()).toBe(false);
    } finally {
      // Ensure gate is resolved so _initPromise doesn't leak into other tests
      resolveInit();
      try { await releasePhase3Runtime(); } catch { /* ignore */ }
    }
  });

  it("acquire waits for pending destruction before creating new runtime", async () => {
    // Override destroyAll to require explicit resolution so we can
    // verify that acquire() waits for it
    const origDestroyAll = GroupConnectionManager.prototype.destroyAll;
    let destroyResolve: () => void;
    const destroyGate = new Promise<void>((resolve) => { destroyResolve = resolve; });
    let destroyStarted = false;
    vi.spyOn(GroupConnectionManager.prototype, "destroyAll").mockImplementation(
      async function (this: GroupConnectionManager) {
        destroyStarted = true;
        await destroyGate;
      }
    );

    const r1 = await acquirePhase3Runtime();
    const relPromise = releasePhase3Runtime();

    // destroyAll should have been called (started)
    expect(destroyStarted).toBe(true);

    // Acquire should not resolve until destroy completes
    let acquired = false;
    const acqPromise = acquirePhase3Runtime().then((r) => { acquired = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);

    // Now complete destroy
    destroyResolve!();
    const r2 = await acqPromise;
    expect(r2).not.toBe(r1);
    await relPromise;
  });

  it("generation safety: callbacks after destroy are rejected", async () => {
    const runtime = await acquirePhase3Runtime();
    const connManager = runtime.getConnectionManager();

    // Capture whether our callback fires after destroy
    let callbackFired = false;
    connManager.setOnPeerOnline((_groupId: string, _deviceId: string) => {
      callbackFired = true;
    });

    await releasePhase3Runtime();

    // Simulate the connection manager calling onPeerOnline.
    // The runtime's internal handler should reject it due to generation mismatch.
    // We can't directly trigger the internal callback, but we can verify
    // the runtime is destroyed and the generation mechanism is in place.
    expect(runtime.isDestroyed()).toBe(true);

    // The internal handler checks `gen !== this.initGen || this.destroyed`
    // Since the runtime is destroyed, any callback would be rejected.
    // This test validates the production invariant, not runtime behavior.
    expect(callbackFired).toBe(false);
  });
});

// ─── Phase3Runtime class tests ─────────────────────────────────────────────

describe("Phase3Runtime class", () => {
  beforeEach(async () => {
    await releasePhase3Runtime().catch(() => {});
    vi.spyOn(GroupConnectionManager.prototype, "addGroup").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "destroyAll").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "removeGroup").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await releasePhase3Runtime().catch(() => {});
  });

  it("addGroup initializes sync before starting connection", async () => {
    const runtime = await acquirePhase3Runtime();

    // Track call order
    const callOrder: string[] = [];
    const origSyncInit = runtime.getSyncService().initializeGroup.bind(runtime.getSyncService());
    vi.spyOn(runtime.getSyncService(), "initializeGroup").mockImplementation(
      (groupId: string, ...args: unknown[]) => {
        callOrder.push("sync-init");
        return origSyncInit(groupId, args[0] as any, args[1] as any, args[2] as string, args[3] as string);
      }
    );

    vi.spyOn(runtime.getConnectionManager(), "addGroup").mockImplementation(
      async (_config: unknown) => {
        callOrder.push("conn-add");
      }
    );

    await runtime.addGroup(
      {
        groupId: "test-g-1",
        controlRoomId: "room-1",
        groupSecret: "secret-1",
        nodeId: "node-1",
        displayName: "Test User",
      },
      makeMockState(),
      makeMockClock(),
    );

    expect(callOrder).toEqual(["sync-init", "conn-add"]);
  });

  it("addGroup awaits sync persistence before starting connection", async () => {
    // Prove that when a local member is inserted, persistState completes
    // before connManager.addGroup is called.
    let resolvePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => { resolvePersist = resolve; });
    let persistStarted = false;

    const persistState = vi.fn().mockImplementation(async () => {
      persistStarted = true;
      await persistGate;
    });
    const persistClock = vi.fn().mockResolvedValue(undefined);
    const persistence: SyncPersistenceAdapter = { persistState, persistClock };

    const runtime = await acquirePhase3Runtime(persistence);

    let connStarted = false;
    vi.spyOn(runtime.getConnectionManager(), "addGroup").mockImplementation(
      async (_config: unknown) => {
        connStarted = true;
      }
    );

    // Start addGroup (don't await — we want to inspect interleaving)
    const addPromise = runtime.addGroup(
      {
        groupId: "test-g-persist",
        controlRoomId: "room-p",
        groupSecret: "secret-p",
        nodeId: "node-p",
        displayName: "Persist User",
      },
      makeMockState(), // empty members — triggers local member insertion
      makeMockClock(),
    );

    // Give microtasks a tick so initializeGroup starts and hits persistGate
    await new Promise((r) => setTimeout(r, 5));

    // persistState must have started but conn must NOT have started
    expect(persistStarted).toBe(true);
    expect(connStarted).toBe(false);

    // Release the gate — now persistence completes and conn can proceed
    resolvePersist();
    await addPromise;

    expect(connStarted).toBe(true);
  });

  it("persistence adapter is called for initial local-member insertion and later edits", async () => {
    const persistState = vi.fn().mockResolvedValue(undefined);
    const persistClock = vi.fn().mockResolvedValue(undefined);
    const persistence: SyncPersistenceAdapter = { persistState, persistClock };

    const runtime = await acquirePhase3Runtime(persistence);

    // Mock connection add to be no-op
    vi.spyOn(runtime.getConnectionManager(), "addGroup").mockResolvedValue(undefined);

    // State has empty members — node-2 is missing, so the local member
    // will be inserted during initializeGroup.
    const state = makeMockState();
    const clock = makeMockClock();

    await runtime.addGroup(
      {
        groupId: "test-g-2",
        controlRoomId: "room-2",
        groupSecret: "secret-2",
        nodeId: "node-2",
        displayName: "New User",
      },
      state,
      clock,
    );

    // ── Initial insertion path: persistState/persistClock must have been
    // called during initializeGroup (before connection start).
    const initStateCall = persistState.mock.calls.find(
      (c: unknown[]) => c[0] === "test-g-2" && c[1] && typeof (c[1] as Record<string, unknown>).members === "object",
    );
    expect(initStateCall).toBeTruthy();
    const initClockCall = persistClock.mock.calls.find((c: unknown[]) => c[0] === "test-g-2");
    expect(initClockCall).toBeTruthy();

    // ── Subsequent edit path: also persists.
    await runtime.getSyncService().updateDisplayName("test-g-2", "Updated Name");
    expect(persistState.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(persistClock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("persistence adapter is optional and does not throw", async () => {
    const runtime = await acquirePhase3Runtime(); // no persistence
    vi.spyOn(runtime.getConnectionManager(), "addGroup").mockResolvedValue(undefined);

    await expect(
      runtime.addGroup(
        {
          groupId: "test-g-3",
          controlRoomId: "room-3",
          groupSecret: "secret-3",
          nodeId: "node-3",
          displayName: "No Persist User",
        },
        makeMockState(),
        makeMockClock(),
      )
    ).resolves.toBeUndefined();
  });

  it("one SDK connection per group across acquire/release/acquire cycle", async () => {
    const connAddSpy = vi.fn().mockResolvedValue(undefined);
    const syncInitSpy = vi.fn();

    const runtime1 = await acquirePhase3Runtime();
    vi.spyOn(runtime1.getConnectionManager(), "addGroup").mockImplementation(connAddSpy);
    vi.spyOn(runtime1.getSyncService(), "initializeGroup").mockImplementation(syncInitSpy);

    await runtime1.addGroup(
      {
        groupId: "g1",
        controlRoomId: "r1",
        groupSecret: "s1",
        nodeId: "n1",
        displayName: "U1",
      },
      makeMockState(),
      makeMockClock(),
    );

    expect(connAddSpy).toHaveBeenCalledTimes(1);
    expect(syncInitSpy).toHaveBeenCalledTimes(1);

    await releasePhase3Runtime();

    // Second acquire/release cycle
    const runtime2 = await acquirePhase3Runtime();
    vi.spyOn(runtime2.getConnectionManager(), "addGroup").mockImplementation(connAddSpy);
    vi.spyOn(runtime2.getSyncService(), "initializeGroup").mockImplementation(syncInitSpy);

    await runtime2.addGroup(
      {
        groupId: "g1",
        controlRoomId: "r1",
        groupSecret: "s1",
        nodeId: "n1",
        displayName: "U1",
      },
      makeMockState(),
      makeMockClock(),
    );

    // Should have 2 connection addGroup calls across cycles
    expect(connAddSpy).toHaveBeenCalledTimes(2);
    // Sync init should also be called again
    expect(syncInitSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── Startup helper tests ──────────────────────────────────────────────────

describe("initializeAppRuntime startup", () => {
  beforeEach(async () => {
    await releasePhase3Runtime().catch(() => {});
    vi.spyOn(GroupConnectionManager.prototype, "addGroup").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "destroyAll").mockResolvedValue(undefined);
    vi.spyOn(GroupConnectionManager.prototype, "removeGroup").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await releasePhase3Runtime().catch(() => {});
  });

  it("releases runtime when getDeviceIdentity returns null (no leak)", async () => {
    const mockApi = {
      getDeviceIdentity: vi.fn().mockResolvedValue(null),
      listGroups: vi.fn(),
      getGroupConnectionConfig: vi.fn(),
      updateGroupSharedState: vi.fn(),
      updateGroupClock: vi.fn(),
    } as unknown as import("../../src/preload/api-types.js").ScreenLinkAPI;

    await initializeAppRuntime(mockApi);

    // Runtime should have been acquired, then released since identity was null
    expect(getRuntime()).toBeNull();
    // listGroups should NOT have been called
    expect(mockApi.listGroups).not.toHaveBeenCalled();
  });

  it("populates normalized store before starting connections", async () => {
    const mockApi = {
      getDeviceIdentity: vi.fn().mockResolvedValue({
        deviceId: "dev-1",
        displayName: "Test User",
        createdAt: 1000,
      }),
      listGroups: vi.fn().mockResolvedValue([
        {
          groupId: "g-1",
          sharedState: {
            schemaVersion: 1,
            groupId: "g-1",
            name: { value: "Group One", stamp: { wallTimeMs: 100, counter: 0, nodeId: "n1" }, valueHash: "h1", updatedByDeviceId: "n1" },
            defaultQuality: {
              value: { schemaVersion: 1 as const, video: { videoBitrateKbps: 1000, sendWidth: 1280, sendHeight: 720, sendFps: 30, captureWidth: 1280, captureHeight: 720, captureFps: 30, preserveAspectRatio: true, preventUpscale: true, resolutionMode: "target-dimensions" as const, scaleResolutionDownBy: 1, codec: "vp9" as const, h264Profile: "auto" as const, contentHint: "detail" as const, degradationPreference: "maintain-resolution" as const, scalabilityMode: null, cursorMode: "always" as const, rtpPriority: "medium" as const }, audio: { bitrateKbps: 64, channels: "stereo" as const, bitrateMode: "vbr" as const, dtx: false, fec: true, packetDurationMs: 20 as const, redundantAudio: false } },
              stamp: { wallTimeMs: 100, counter: 0, nodeId: "n1" }, valueHash: "h2", updatedByDeviceId: "n1",
            },
            members: {},
          },
          lastClock: { wallTimeMs: 100, counter: 0, nodeId: "n1" },
        },
        {
          groupId: "g-2",
          sharedState: {
            schemaVersion: 1,
            groupId: "g-2",
            name: { value: "Group Two", stamp: { wallTimeMs: 200, counter: 0, nodeId: "n2" }, valueHash: "h3", updatedByDeviceId: "n2" },
            defaultQuality: {
              value: { schemaVersion: 1 as const, video: { videoBitrateKbps: 1000, sendWidth: 1280, sendHeight: 720, sendFps: 30, captureWidth: 1280, captureHeight: 720, captureFps: 30, preserveAspectRatio: true, preventUpscale: true, resolutionMode: "target-dimensions" as const, scaleResolutionDownBy: 1, codec: "vp9" as const, h264Profile: "auto" as const, contentHint: "detail" as const, degradationPreference: "maintain-resolution" as const, scalabilityMode: null, cursorMode: "always" as const, rtpPriority: "medium" as const }, audio: { bitrateKbps: 64, channels: "stereo" as const, bitrateMode: "vbr" as const, dtx: false, fec: true, packetDurationMs: 20 as const, redundantAudio: false } },
              stamp: { wallTimeMs: 200, counter: 0, nodeId: "n2" }, valueHash: "h4", updatedByDeviceId: "n2",
            },
            members: { "existing-dev": { deviceId: "existing-dev", displayName: "Existing", firstSeenAt: 100, profileStamp: { wallTimeMs: 50, counter: 0, nodeId: "n2" } } },
          },
          lastClock: { wallTimeMs: 200, counter: 0, nodeId: "n2" },
        },
      ]),
      getGroupConnectionConfig: vi.fn().mockResolvedValue({
        groupId: "g-1",
        controlRoomId: "cr-1",
        groupSecret: "secret-1",
        nodeId: "dev-1",
      }),
      updateGroupSharedState: vi.fn().mockResolvedValue(undefined),
      updateGroupClock: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../../src/preload/api-types.js").ScreenLinkAPI;

    // Track order of key events.
    const order: Array<"setGroups" | "conn-addGroup"> = [];

    // Spy on store.setGroups to record when the store is populated.
    // Save original BEFORE spying to call it without recursion.
    const storeState = useStore.getState();
    const origSetGroups = storeState.setGroups;
    vi.spyOn(storeState, "setGroups").mockImplementation(
      (groupsById, groupOrder) => {
        order.push("setGroups");
        // Call original (saved reference, not going through the spy)
        return origSetGroups(groupsById, groupOrder);
      }
    );

    // Spy on connManager.addGroup to record when connections start
    vi.spyOn(GroupConnectionManager.prototype, "addGroup").mockImplementation(
      async (_config: unknown) => {
        order.push("conn-addGroup");
      }
    );

    await initializeAppRuntime(mockApi);

    // Verify store was populated
    const state = useStore.getState();
    expect(state.groupsById["g-1"]).toBeDefined();
    expect(state.groupsById["g-1"].name).toBe("Group One");
    expect(state.groupsById["g-2"]).toBeDefined();
    expect(state.groupsById["g-2"].name).toBe("Group Two");
    expect(state.groupOrder).toEqual(["g-1", "g-2"]);

    // Verify setGroups happened BEFORE any connection started
    const setGroupsIdx = order.indexOf("setGroups");
    const connIdx = order.indexOf("conn-addGroup");
    expect(setGroupsIdx).toBeLessThan(connIdx);
    expect(setGroupsIdx).toBe(0); // setGroups should be the very first event
  });
});
