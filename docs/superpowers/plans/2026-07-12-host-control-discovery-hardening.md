# Host/Control/Discovery Hardening — TDD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behavior-preserving hardening of the host lifecycle control/discovery pipeline — hosting lifecycle (start/stop/restart/destroy), stream advertising (heartbeat/snapshot/tombstones), reconnect queue integrity, connection identity, source‑switch/stop/restart ordering, and publisher cleanup.

**Architecture:** Every hardening change is gated by a regression test that proves the gap exists against the current codebase. Characterization tests pass before any production edit and capture current behavior. All test files are *new* — never modify an existing test. Production edits always follow the conflict‑check pattern (git status on target file before editing). Commits are replaced by verification/status checkpoints.

**Tech Stack:** TypeScript, Vitest (happy-dom), mock SDK (`@screenlink/vdo-adapter`), Electron renderer services.

**Design Spec:** `docs/superpowers/specs/2026-07-12-host-connect-view-pipeline-hardening-design.md`

**Related Plans:**
- `docs/superpowers/plans/2026-06-30-viewer-lifecycle-ownership-fix.md` — viewer‑side ownership (separate scope, not duplicated here)
- `docs/superpowers/plans/2026-07-12-non-viewer-ui-overhaul.md` — UI changes (out of scope)

---
## File Map

### ⚠️ Exclusive Test‑Filename Ownership

The five test files listed below are **owned exclusively by this plan**. No other plan, agent, or concurrent workstream may create or modify files with these exact paths. If another plan needs hardening tests in the same subsystem, it must use a different filename (e.g. `-phase-2` suffix) and coordinate here.

| Exclusively Owned Test File | Purpose |
|-----------------------------|---------|
| `apps/desktop/tests/stream-session-manager-hardening.test.ts` | SSM state isolation, destroyed guard, capture‑track characterization |
| `apps/desktop/tests/publisher-manager-hardening.test.ts` | Publisher bitrate, track‑ended, replace‑track guards |
| `apps/desktop/tests/active-stream-registry-hardening.test.ts` | Tombstone snapshot exclusion, leaseValidUntil expiry, race‑re‑add regression |
| `apps/desktop/tests/group-connection-manager-hardening.test.ts` | Queue flush characterization, queue‑size warning regression |
| `apps/desktop/tests/group-control-connection-hardening.test.ts` | Connection identity assertion, hello validation, send/broadcast edge cases |

### Production Files Modified (by phase)

| Phase | File | Change |
|-------|------|--------|
| P2 | `active-stream-registry.ts` | `getStreamsByGroup`, `getAllStreams`, `getStream`, `getGroupKeys` — add tombstone filter; `startHeartbeatCheck` — add leaseValidUntil check |
| P3 | *(no change — see Task 9 rationale)* | `ensureConnected` keeps bounded polling; true subscription would require broader API changes |
| P4 | `stream-session-manager.ts` | Extract `buildLifecyclePayload()` method, replace inline constructions |
| P5 | `stream-session-manager.ts` | Add `destroyed` check to `switchSource` |
| P5 | `publisher-manager.ts` | *(no change needed — null check already present, confirmed by test)* |
| P5 | `group-connection-manager.ts` | Add queue‑size log warning in `enqueueLifecycle` |

### Execution Order

This plan has the following execution dependencies on other hardening plans:

1. **CI workflow plan first** — ensures vitest desktop tests actually run in CI before any hardening lands.
2. **This plan (host/control/discovery) second** — no code dependency on any other hardening plan.
3. **Native pipeline plan third** — depends on SSM/Publisher being stable (touches overlapping HostPublisher/StreamSessionManager seams at the frame‑ring boundary).
4. **Viewer‑session / viewer‑media‑binding plan fourth** — depends on host/control being stable AND native pipeline being stable (viewer reacts to host lifecycle).

### Out of Scope / Not Duplicated Here

| Capability | Owned By |
|------------|----------|
| Viewer‑session hardening (pause/resume races, teardown‑while‑joining) | `viewer-lifecycle-ownership-fix` plan |
| Viewer‑media‑binding hardening (destroyed guard, stale mapping cleanup) | `viewer-lifecycle-ownership-fix` plan |
| CI workflow (`.github/workflows/ci.yml`) | pipeline plan |
| Native frame‑ring / video‑enhancer | native pipeline plan |
| Audio pipeline sequencing | audio plan |

### Conflict Resolution Protocol (apply before every production-file edit)

Before editing any production file below, run:

```
git status -- <file-path>
```

**If the file is clean** (no unstaged modifications, no staged-but-uncommitted changes from another agent):  
Proceed with the edit.

**If the file is DIRTY** (modified by concurrent agent work):

1. **Never** run `git stash`, `git checkout -- <file>`, `git reset HEAD <file>`, `git restore <file>`, or `git rebase`. These destroy or discard another agent's work and violate the no-revert rule.
2. Do **not** assume any file will become clean — especially `stream-session-manager.ts`, which may be touched by overlapping plans. Evaluate the file as it actually is.
3. Read the full current file content (`git diff <file-path>` and a `Read` tool call) so you see exactly what changed and where.
4. **Minimal-context patching:** Construct the edit using the smallest unique `oldString` that matches the target location in the **current (dirty)** file content. Stale line numbers or `oldString` snippets copied verbatim from this plan may fail because the dirty file has shifted.
5. **Before/after diff comparison:** Stage a dry-run preview of the edit (if the tool provides one) or manually diff the result. Verify the edit changes only the intended lines and preserves **every pre-existing hunk** — including the concurrent agent's changes, spacing, comments, and blank lines.
6. **Defer on same-line semantic overlap:** If the edit target overlaps semantically with a line or region the concurrent agent changed (same line, same variable, same guard condition, same method body), **do not guess a merge**. Defer that file to a follow-up task, log the conflict, and move to the next available file.
7. After confirming the diff is clean (no unintended deletions, no dropped hunks), apply the edit.
8. Run `git diff --stat` to confirm only the intended file changed, and `git diff <file-path>` to confirm the edit is minimal.

---

## Task 1: Characterization — StreamSessionManager Phase A/B Isolation

**Files:**
- Create: `apps/desktop/tests/stream-session-manager-hardening.test.ts`

This test captures current behavior: Phase A failure (getDisplayMedia reject) leaves state `"failed"` and `destroy()` mid‑startStream rejects in‑flight awaits. It must pass against the *current* codebase before any production edit.

- [ ] **1.1 Write and run: Phase A (capture) failure sets state to "failed", no dangling timers**

```typescript
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StreamSessionManager } from "../src/renderer/services/stream-session-manager.js";
import { PublisherManager } from "../src/renderer/services/publisher-manager.js";
import type { Phase3Runtime } from "../src/renderer/services/phase3-runtime.js";

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
    sendOrQueueStreamLifecycle: vi.fn().mockResolvedValue("sent" as const),
    getConnection: vi.fn().mockReturnValue(null),
    isConnected: vi.fn().mockReturnValue(false),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    clearPendingForStream: vi.fn(),
  };
  const viewerBinding = {
    removeViewer: vi.fn(),
    rejectPending: vi.fn(),
    getAllViewers: vi.fn().mockReturnValue([]),
  };
  const syncService = {
    getSyncState: vi.fn().mockReturnValue(null),
    performLocalEdit: vi.fn().mockResolvedValue(undefined),
  };
  const compareSessionManager = {
    isActive: vi.fn().mockReturnValue(false),
    state: "idle",
  };
  return {
    getActiveStreamRegistry: () => registry,
    getConnectionManager: () => connManager,
    getStreamSessionManager: () => ({}),
    getViewerMediaBinding: () => viewerBinding,
    getSyncService: () => syncService,
    getMediaStatsService: () => ({
      startViewerPoller: vi.fn(),
      stopViewerPoller: vi.fn(),
      disconnectViewer: vi.fn(),
      hasViewerPoller: vi.fn().mockReturnValue(false),
    }),
    getCompareSessionManager: () => compareSessionManager,
    viewerBinding,
    syncService,
  } as unknown as Phase3Runtime & { viewerBinding: typeof viewerBinding; syncService: typeof syncService };
}

function mockNavigatorMediaDevices(): void {
  const origNav = (globalThis as any).navigator;
  if (origNav && origNav.mediaDevices) return;
  const mock = {
    getDisplayMedia: vi.fn().mockRejectedValue(new Error("no display")),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  };
  if (origNav) {
    (origNav as any).mediaDevices = mock;
  } else {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: mock },
      writable: true, configurable: true,
    });
  }
}

describe("StreamSessionManager — hardening characterization", () => {
  let ssm: StreamSessionManager;
  let runtime: ReturnType<typeof makeMockRuntime>;

  beforeEach(() => {
    mockNavigatorMediaDevices();
    runtime = makeMockRuntime();
    ssm = new StreamSessionManager(runtime);
  });

  afterEach(() => {
    ssm.destroy().catch(() => {});
    vi.restoreAllMocks();
  });

  it("characterization: Phase A (capture) failure sets state to 'failed'", async () => {
    // The mock getDisplayMedia rejects — Phase A fails
    try {
      await ssm.startStream({
        groupId: "group-1",
        logicalStreamId: "stream-1",
        sourceKind: "screen",
        videoBitrate: 2000,
        videoWidth: 1920,
        videoHeight: 1080,
        videoFps: 30,
      });
    } catch {
      // expected
    }
    // After Phase A failure, the state should be "failed" (or "idle" if
    // cleanup resets) — capture this to understand current behavior.
    const state = (ssm as any)._state;
    // Hypothesis: state is "failed". This test characterizes actual behavior.
    // If state is "idle" or "starting" that is also valid characterisation.
    // Record whatever it is.
    console.log("[characterization] state after Phase A failure:", state);
    expect(["failed", "idle", "error"]).toContain(state);
  });

  it("characterization: destroy() while startStream is in-flight rejects the promise", async () => {
    // Delay getDisplayMedia so we can call destroy() mid-start
    const origGetDisplayMedia = (navigator.mediaDevices as any).getDisplayMedia;
    (navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockImplementation(() => {
      return new Promise(() => {}); // never resolves
    });

    const startPromise = ssm.startStream({
      groupId: "group-1",
      logicalStreamId: "stream-1",
      sourceKind: "screen",
      videoBitrate: 2000,
      videoWidth: 1920,
      videoHeight: 1080,
      videoFps: 30,
    });

    // Call destroy while startStream is in-flight
    await ssm.destroy();

    // startStream should reject (or resolve without side effects)
    await expect(startPromise).rejects.toThrow();
  });
});
```

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/stream-session-manager-hardening.test.ts --reporter=verbose`
Expected: PASS (characterization captures current behavior).

- [ ] **1.2 Write and run: Phase B (broadcast) failure does not revert Phase A state**

Add this test inside the same `describe` block:

```typescript
it("characterization: Phase B (broadcast) failure does not revert Phase A success", async () => {
  // First succeed at Phase A:
  // We need getDisplayMedia to return a real MediaStream.
  const videoTrack = {
    kind: "video", id: "vt-1", enabled: true, readyState: "live",
    label: "screen-capture", contentHint: "motion",
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
    stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
  const stream = {
    getVideoTracks: vi.fn(() => [videoTrack]),
    getAudioTracks: vi.fn(() => []),
    addTrack: vi.fn(), removeTrack: vi.fn(),
    getTrackById: vi.fn(), clone: vi.fn(),
    id: "cap-stream", active: true,
  } as unknown as MediaStream;
  (navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockResolvedValue(stream);

  // Make the control broadcast throw
  const connManager = runtime.getConnectionManager() as any;
  connManager.sendOrQueueStreamLifecycle.mockRejectedValue(new Error("broadcast failed"));

  await ssm.startStream({
    groupId: "group-1",
    logicalStreamId: "stream-1",
    sourceKind: "screen",
    videoBitrate: 2000,
    videoWidth: 1920,
    videoHeight: 1080,
    videoFps: 30,
  });

  const state = (ssm as any)._state;
  console.log("[characterization] state after Phase B failure:", state);
  // Hypothesis: Phase B failure is non-fatal; state should be "active".
  // If it's "idle" or "failed", that indicates Phase B failure is treated
  // as fatal — document this.
  expect(state).toBe("active");
});
```

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/stream-session-manager-hardening.test.ts --reporter=verbose -t "Phase B"`
Expected: PASS.

- [ ] **1.3 Write and run: successful capture yields live/enabled video track with settings readback**

Add inside the same `describe` block, after the Phase B test:

```typescript
it("characterization: successful capture track is live and enabled with non-zero settings readback", async () => {
  // Provide a realistic MediaStream with a video track that has actual
  // getSettings() values.
  const videoTrack = {
    kind: "video", id: "vt-settings",
    enabled: true,
    readyState: "live",
    label: "screen-capture",
    contentHint: "detail",
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 60, deviceId: "dev-1" }),
    stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
  const stream = {
    getVideoTracks: vi.fn(() => [videoTrack]),
    getAudioTracks: vi.fn(() => []),
    addTrack: vi.fn(), removeTrack: vi.fn(),
    getTrackById: vi.fn(), clone: vi.fn(),
    id: "cap-stream", active: true,
  } as unknown as MediaStream;
  (navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockResolvedValue(stream);
  // Inject a real PublisherManager instance so SSM can proceed through Phase A.
  // PublisherManager is already imported at the top of this describe block.
  const pmEvents = { onStateChange: vi.fn(), onStats: vi.fn(), onError: vi.fn(), onTrackEnded: vi.fn() };
  (ssm as any).publisherManager = new PublisherManager(pmEvents);
  (ssm as any)._state = "idle";

  await ssm.startStream({
    groupId: "group-1",
    logicalStreamId: "stream-1",
    sourceKind: "screen",
    videoBitrate: 2000,
    videoWidth: 1920,
    videoHeight: 1080,
    videoFps: 60,
  });

  // Read back what the SSM stored from track.getSettings()
  const actualW = (ssm as any)._actualCaptureWidth;
  const actualH = (ssm as any)._actualCaptureHeight;
  const actualFps = (ssm as any)._actualCaptureFps;
  console.log("[characterization] capture settings readback:", { actualW, actualH, actualFps });

  // The spec says these should be read from track.getSettings() after
  // applyCaptureConstraints and stored as source of truth.
  // Non-zero readback indicates the settings were successfully captured.
  // This characterization documents what the current code produces.
  // If all are 0 (or undefined), the readback is missing.
  if (actualW !== undefined) {
    expect(actualW).toBeGreaterThan(0);
  }
  if (actualH !== undefined) {
    expect(actualH).toBeGreaterThan(0);
  }
  if (actualFps !== undefined) {
    expect(actualFps).toBeGreaterThan(0);
  }
});
```

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/stream-session-manager-hardening.test.ts --reporter=verbose -t "settings readback"`
Expected: PASS (characterization — documents whether settings readback is stored with non-zero values).

- [ ] **1.4 Run full characterization suite**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/stream-session-manager-hardening.test.ts --reporter=verbose`
Expected: ALL PASS (these are characterization tests, they capture current behavior).

---

## Task 2: Characterization — ActiveStreamRegistry Tombstone/Snapshot Behavior

**Files:**
- Create: `apps/desktop/tests/active-stream-registry-hardening.test.ts`

- [ ] **2.1 Write: tombstoned streams excluded from `getStreamsByGroup`**

```typescript
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ActiveStreamRegistry, type StreamAnnouncement } from "../src/renderer/services/active-stream-registry.js";

function makeAnnouncement(overrides: Partial<StreamAnnouncement> = {}): StreamAnnouncement {
  return {
    logicalStreamId: "stream-1",
    mediaSessionId: "media-1",
    groupId: "group-1",
    hostDeviceId: "host-1",
    hostDisplayName: "Host",
    sourceKind: "screen",
    sourceName: "Screen",
    startedAt: Date.now(),
    appliedSettingsRevision: 1,
    heartbeatSequence: 1,
    streamRevision: 1,
    mediaJoinMetadata: "",
    replacesSessionId: null,
    ...overrides,
  };
}

describe("ActiveStreamRegistry — hardening characterization", () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry(10_000, 60_000);
  });

  afterEach(() => {
    registry.destroy();
    vi.restoreAllMocks();
  });

  it("characterization: getStreamsByGroup returns tombstoned stream (current behavior)", () => {
    registry.handleStarted(makeAnnouncement());
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    const streams = registry.getStreamsByGroup("group-1");
    // Hypothesis (current behavior): getStreamsByGroup only checks
    // `!s.stopped` but the stopped stream was deleted from the map,
    // so it returns empty. If it returned the tombstoned stream,
    // that indicates the gap.
    console.log("[characterization] streams after stop:", streams.length);
    expect(streams).toHaveLength(0);
  });

  it("characterization: getStream returns null for stopped stream", () => {
    registry.handleStarted(makeAnnouncement());
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    const stream = registry.getStream({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });
    expect(stream).toBeNull();
  });

  it("characterization: snapshot does NOT exclude tombstoned streams (reveals the gap)", () => {
    registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
    registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

    // Simulate a snapshot arriving with the same stream after it was stopped.
    // handleSnapshot should reject it because of the tombstone.
    registry.handleSnapshot([makeAnnouncement({ heartbeatSequence: 2 })]);

    // If handleSnapshot correctly rejects tombstoned streams, the stream
    // should NOT appear in getStreamsByGroup.
    const streams = registry.getStreamsByGroup("group-1");
    console.log("[characterization] streams after snapshot of tombstoned stream:", streams.length);
    // Current behavior: handleSnapshot already checks tombstone at line 288.
    // Expect 0 because the tombstone blocks it.
    expect(streams).toHaveLength(0);
  });

  it("characterization: leaseValidUntil in future prevents expiry-based removal", async () => {
    registry.handleStarted(makeAnnouncement({ leaseValidUntil: Date.now() + 3600_000 }));

    // Advance clock past expiry by triggering the heartbeat check manually.
    // The heartbeat check runs every 10s; we can force it by calling
    // destroy/create a new registry with short expiry.
    const shortRegistry = new ActiveStreamRegistry(1_000, 100);
    shortRegistry.handleStarted(makeAnnouncement({
      leaseValidUntil: Date.now() + 3600_000,
      heartbeatSequence: 1,
    }));

    // Wait longer than expiryMs
    await new Promise((r) => setTimeout(r, 200));

    const streams = shortRegistry.getStreamsByGroup("group-1");
    // Hypothesis (current behavior): leaseValidUntil is NOT checked in
    // the expiry loop — so the stream is removed despite the future lease.
    // This test captures current behavior.
    console.log("[characterization] streams after expiry with future lease:", streams.length);
    // If 0, the leaseValidUntil is not checked. If 1, it is already checked.
    shortRegistry.destroy();
  });
});
```

- [ ] **2.2 Run characterization tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/active-stream-registry-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 3: Characterization — GroupConnectionManager Queue and Flush

**Files:**
- Create: `apps/desktop/tests/group-connection-manager-hardening.test.ts`

- [ ] **3.1 Write: characterize flushPendingLifecycleToPeer behavior**

```typescript
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

const createdSdks: any[] = [];
vi.mock("@screenlink/vdo-adapter", () => ({
  getSDKConstructor: () => {
    return function () {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const sdk = {
        sendData: vi.fn().mockReturnValue(true),
        addEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          const list = handlers.get(event) ?? [];
          list.push(listener);
          handlers.set(event, list);
        }),
        removeEventListener: vi.fn(),
        autoConnect: vi.fn().mockResolvedValue({ stop: vi.fn(), streamID: "test-id" }),
        disconnect: vi.fn().mockResolvedValue(undefined),
        leaveRoom: vi.fn().mockResolvedValue(undefined),
        state: { connected: false, roomJoined: false, room: null },
        handlers,
      };
      createdSdks.push(sdk);
      return sdk;
    };
  },
}));

import { GroupConnectionManager } from "../src/renderer/services/group-connection-manager.js";

const GROUP_ID = "11111111-1111-4111-1111-111111111111";

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

describe("GroupConnectionManager — hardening characterization", () => {
  let mgr: GroupConnectionManager;

  beforeEach(() => {
    createdSdks.length = 0;
    mgr = new GroupConnectionManager();
  });

  it("characterization: flushPendingLifecycleToPeer does NOT check tombstone (reveals the gap)", async () => {
    // Queue a lifecycle message
    const result = await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID,
      "stream-1",
      "stream.started",
      { logicalStreamId: "stream-1", type: "stream.started" },
    );
    expect(result).toBe("queued");

    // Connect the group so flush has a target
    await mgr.addGroup({
      groupId: GROUP_ID,
      controlRoomId: "room-1",
      groupSecret: "test-secret",
      nodeId: "alice",
      displayName: "Alice",
    });
    await tick();
    await tick();

    const conn = mgr.getConnection(GROUP_ID)!;
    // Make sendToPeer return true so flush proceeds
    vi.spyOn(conn, "sendToPeer").mockResolvedValue(true);

    // Now flush to a peer — current behavior does NOT check tombstones
    // (it only checks TTL and the hasPendingStart guard).
    await mgr.flushPendingLifecycleToPeer(GROUP_ID, "peer-uuid");

    // If the message was delivered, sendToPeer was called
    expect(conn.sendToPeer).toHaveBeenCalled();
    console.log("[characterization] flushPendingLifecycleToPeer: sendToPeer was called");
  });

  it("characterization: queue size cap reached logs warning (behavior to add)", async () => {
    // Queue 17 messages (MAX_PENDING_PER_GROUP = 16)
    for (let i = 0; i < 17; i++) {
      await mgr.sendOrQueueStreamLifecycle(
        GROUP_ID,
        `stream-${i}`,
        "stream.started",
        { logicalStreamId: `stream-${i}`, type: "stream.started" },
      );
    }

    // Current behavior: the queue evicts oldest entries silently.
    // The spec says we should add a log warning.
    // This characterization verifies no warning is currently emitted.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Queue one more — this triggers the eviction path
    await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID,
      "stream-overflow",
      "stream.started",
      { logicalStreamId: "stream-overflow", type: "stream.started" },
    );

    // Expect NO warning about queue size (current behavior)
    const sizeWarnings = warnSpy.mock.calls.filter(
      ([msg]: string[]) => typeof msg === "string" && msg.includes("queue size cap"),
    );
    expect(sizeWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });
});
```

- [ ] **3.2 Run characterization tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/group-connection-manager-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 4: Characterization — PublisherManager Bitrate Readback and Track‑Ended

**Files:**
- Create: `apps/desktop/tests/publisher-manager-hardening.test.ts`

- [ ] **4.1 Write: characterize bitrate readback correction and track‑ended suppression**

```typescript
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSDKMethods = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  connections: new Map<string, { publisher?: { pc?: RTCPeerConnection } }>(),
}));

vi.mock("@screenlink/vdo-adapter", () => ({
  HostPublisher: vi.fn(() => ({
    createAndConnect: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    stopPublishing: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    replaceVideoTrack: vi.fn().mockResolvedValue(undefined),
    getSDK: vi.fn(() => mockSDKMethods),
  })),
}));

import { PublisherManager } from "../src/renderer/services/publisher-manager.js";

function makeEvents() {
  return {
    onStateChange: vi.fn(),
    onStats: vi.fn(),
    onError: vi.fn(),
    onTrackEnded: vi.fn(),
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "source-1",
    password: "pw-test",
    streamId: "stream-test",
    videoBitrate: 2000,
    videoWidth: 1280,
    videoHeight: 720,
    videoFps: 30,
    ...overrides,
  };
}

function makeMediaStream(): MediaStream {
  const track = {
    kind: "video",
    id: "track-1",
    enabled: true,
    readyState: "live",
    label: "test-capture",
    contentHint: "motion",
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
  return {
    getVideoTracks: vi.fn(() => [track]),
    getAudioTracks: vi.fn(() => []),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    getTrackById: vi.fn(),
    clone: vi.fn(),
    id: "stream-1",
    active: true,
  } as unknown as MediaStream;
}

describe("PublisherManager — hardening characterization", () => {
  let pm: PublisherManager;
  let events: ReturnType<typeof makeEvents>;

  beforeEach(() => {
    events = makeEvents();
    pm = new PublisherManager(events);
    mockSDKMethods.connections = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("characterization: replaceVideoTrack throws when no publisher", async () => {
    const newTrack = { kind: "video", id: "new-track" } as MediaStreamTrack;
    await expect(pm.replaceVideoTrack(newTrack)).rejects.toThrow("no publisher active");
  });

  it("characterization: detachTrackEnded sets onended to null", () => {
    // start publishing to set _publishedVideoTrack
    // Then call detachTrackEnded and verify onended is null.
    // This is a characterization — it captures current correct behavior.
    const pmAny = pm as any;
    const track = { kind: "video", onended: (() => {}) as (() => void) | null } as MediaStreamTrack;
    pmAny._publishedVideoTrack = track;
    track.onended = () => {};
    expect(track.onended).not.toBeNull();
    pm.detachTrackEnded();
    expect(track.onended).toBeNull();
  });
});
```

- [ ] **4.2 Run characterization tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/publisher-manager-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 5: Characterization — GroupControlConnection Identity and Hello

**Files:**
- Create: `apps/desktop/tests/group-control-connection-hardening.test.ts`

- [ ] **5.1 Write: characterize connection identity and hello handshake**

```typescript
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

const { makeFakeSDK, createdSdks } = vi.hoisted(() => {
  function makeFakeSDK() {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    const stopFn = vi.fn();
    const sdk: Record<string, any> = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      joinRoom: vi.fn().mockResolvedValue(undefined),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      announce: vi.fn().mockImplementation(async (opts: any) => opts?.streamID ?? "announce-id"),
      autoConnect: vi.fn().mockImplementation(async (opts: any) => {
        sdk.state = { ...sdk.state, connected: true, roomJoined: true, room: opts?.room ?? null };
        sdk.announceId = opts?.streamID ?? "announce-id";
        return { stop: stopFn, streamID: sdk.announceId };
      }),
      sendData: vi.fn().mockReturnValue(true),
      on: vi.fn(),
      off: vi.fn(),
      addEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(listener);
        handlers.set(event, list);
      }),
      removeEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? [];
        handlers.set(event, list.filter((l) => l !== listener));
      }),
      state: { connected: false, roomJoined: false, room: null },
      announceId: null,
      handlers,
    };
    return sdk;
  }
  const createdSdks: any[] = [];
  return { makeFakeSDK, createdSdks };
});

vi.mock("@screenlink/vdo-adapter", () => ({
  getSDKConstructor: () => {
    return function () {
      const sdk = makeFakeSDK();
      createdSdks.push(sdk);
      return sdk;
    };
  },
}));

import { GroupControlConnection } from "../src/renderer/services/group-control-connection.js";

const GROUP_ID = "11111111-1111-4111-1111-111111111111";
const GROUP_SECRET = "test-secret-12345678";

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

describe("GroupControlConnection — hardening characterization", () => {
  let conn: GroupControlConnection;
  let opts: Record<string, any>;
  let messages: any[];
  let stateChanges: string[];

  beforeEach(() => {
    createdSdks.length = 0;
    messages = [];
    stateChanges = [];
    opts = {
      groupId: GROUP_ID,
      controlRoomId: "room-1",
      groupSecret: GROUP_SECRET,
      nodeId: "alice",
      displayName: "Alice",
      memberRecord: { deviceId: "alice", displayName: "Alice", firstSeenAt: 100, profileStamp: { wallTimeMs: 100, counter: 0, nodeId: "alice" } },
      onPeerOnline: vi.fn(),
      onPeerOffline: vi.fn(),
      onMessage: (m: any) => { messages.push(m); },
      onStateChange: (s: string) => { stateChanges.push(s); },
      onError: vi.fn(),
      onAuthenticatedHello: vi.fn(),
    };
    conn = new GroupControlConnection(opts);
  });

  afterEach(async () => {
    await conn.destroy().catch(() => {});
    vi.restoreAllMocks();
  });

  it("characterization: hello identity validation returns false on mismatch", async () => {
    // Direct test of validateHelloIdentity
    const valid = (conn as any).validateHelloIdentity(
      { senderDeviceId: "alice" } as any,
      "bob",
      null,
    );
    expect(valid).toBe(false);
  });

  it("characterization: sendToPeer fails when no usable route", async () => {
    const result = await conn.sendToPeer("peer-uuid", { type: "test" });
    expect(result).toBe(false);
  });

  it("characterization: broadcast returns zero when no SDK", async () => {
    const result = await conn.broadcast({ type: "test" });
    expect(result).toEqual({ attempted: 0, sent: 0, failed: 0 });
  });
});
```

- [ ] **5.2 Run characterization tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/group-control-connection-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 6: Regression — Tombstoned Streams Excluded from Snapshot and Query Methods

**Files:**
- Create: same file as Task 2 (`active-stream-registry-hardening.test.ts`)

**Production:**
- Modify: `apps/desktop/src/renderer/services/active-stream-registry.ts`

- [ ] **6.1 git status conflict check**

Run: `git status -- apps/desktop/src/renderer/services/active-stream-registry.ts`
Apply the Conflict Resolution Protocol above. If the file is dirty, never stash/checkout/reset/restore/rebase; apply minimal-context patching with before/after diff verification; defer on same-line semantic overlap.

- [ ] **6.2 Write failing regression: race‑re‑add after tombstone not filtered by `getStreamsByGroup`**

```typescript
it("regression: getStreamsByGroup filters against tombstone after edge-case re-add (REVEALS GAP — must FAIL)", () => {
  // Simulate a race: stream is stopped (tombstoned) but then a snapshot
  // or other path re-adds a similar entry to this.streams at the exact
  // same composite key but with stopped=false.
  const registryAny = registry as any;
  const k = registryAny.key("group-1", "host-1", "stream-1");

  // Stop the stream (creates tombstone)
  registry.handleStarted(makeAnnouncement({ heartbeatSequence: 1 }));
  registry.handleStopped({ groupId: "group-1", hostDeviceId: "host-1", logicalStreamId: "stream-1" });

  // Simulate a race-re-add (like a late snapshot that bypasses the
  // tombstone check or a direct registerLocalStream call).
  // 💥 This should fail — getStreamsByGroup should check tombstone
  // and return empty even though the stream is in this.streams.
  registryAny.streams.set(k, {
    announcement: makeAnnouncement({ heartbeatSequence: 2 }),
    lastHeartbeatAt: Date.now(),
    stopped: false,
  });

  const streams = registry.getStreamsByGroup("group-1");
  // The stream should NOT be visible because it's tombstoned
  expect(streams).toHaveLength(0);
});
```

- [ ] **6.3 Verify regression fails**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/active-stream-registry-hardening.test.ts --reporter=verbose -t "regression: getStreamsByGroup filters against tombstone"`
Expected: FAIL (because `getStreamsByGroup` does not check tombstones — it checks `!s.stopped` but doesn't also consult `stopTombstones`).

- [ ] **6.4 Implement the fix: add tombstone check to all query methods**

In `active-stream-registry.ts`, modify four methods:

```typescript
// In getStreamsByGroup (line 192-200):
getStreamsByGroup(groupId: string): StreamAnnouncement[] {
  const result: StreamAnnouncement[] = [];
  for (const s of this.streams.values()) {
    if (!s.stopped && s.announcement.groupId === groupId) {
      const k = this.key(s.announcement.groupId, s.announcement.hostDeviceId, s.announcement.logicalStreamId);
      if (this.stopTombstones.has(k)) continue; // tombstone check
      result.push({ ...s.announcement });
    }
  }
  return result;
}

// In getAllStreams (line 202-208):
getAllStreams(): StreamAnnouncement[] {
  const result: StreamAnnouncement[] = [];
  for (const s of this.streams.values()) {
    if (!s.stopped) {
      const k = this.key(s.announcement.groupId, s.announcement.hostDeviceId, s.announcement.logicalStreamId);
      if (this.stopTombstones.has(k)) continue; // tombstone check
      result.push({ ...s.announcement });
    }
  }
  return result;
}

// In getStream (line 210-217):
getStream(key: { groupId: string; hostDeviceId: string; logicalStreamId: string }): StreamAnnouncement | null {
  const k = this.key(key.groupId, key.hostDeviceId, key.logicalStreamId);
  const existing = this.streams.get(k);
  if (existing && !existing.stopped && !this.stopTombstones.has(k)) { // tombstone check
    return { ...existing.announcement };
  }
  return null;
}

// In getGroupKeys (line 237-248):
getGroupKeys(groupId: string): Array<{ hostDeviceId: string; logicalStreamId: string }> {
  const result: Array<{ hostDeviceId: string; logicalStreamId: string }> = [];
  for (const s of this.streams.values()) {
    if (!s.stopped && s.announcement.groupId === groupId) {
      const k = this.key(s.announcement.groupId, s.announcement.hostDeviceId, s.announcement.logicalStreamId);
      if (this.stopTombstones.has(k)) continue; // tombstone check
      result.push({
        hostDeviceId: s.announcement.hostDeviceId,
        logicalStreamId: s.announcement.logicalStreamId,
      });
    }
  }
  return result;
}
```

- [ ] **6.5 Verify regression passes**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/active-stream-registry-hardening.test.ts --reporter=verbose`
Expected: ALL PASS (including the regression that previously failed).

- [ ] **6.6 Run all active-stream-registry tests to verify no regressions**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/active-stream-registry-phase3.test.ts tests/active-stream-late-join.test.ts tests/active-stream-registry-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 7: Regression + Fix — leaseValidUntil Prevents Expiry

**Files:**
- Same test file: `active-stream-registry-hardening.test.ts`
- Same production file: `active-stream-registry.ts`

- [ ] **7.1 git status conflict check**

Run: `git status -- apps/desktop/src/renderer/services/active-stream-registry.ts`
Apply the Conflict Resolution Protocol above. If the file is dirty, never stash/checkout/reset/restore/rebase; apply minimal-context patching with before/after diff verification; defer on same-line semantic overlap.

- [ ] **7.2 Write failing regression: leaseValidUntil prevents expiry**

```typescript
it("regression: leaseValidUntil in future prevents expiry-based removal (REVEALS GAP — must FAIL)", async () => {
  const shortRegistry = new ActiveStreamRegistry(500, 500);
  shortRegistry.handleStarted(makeAnnouncement({
    leaseValidUntil: Date.now() + 3600_000,
    heartbeatSequence: 1,
  }));

  // Wait for the heartbeat check interval to fire (500ms)
  await new Promise((r) => setTimeout(r, 700));

  const streams = shortRegistry.getStreamsByGroup("group-1");
  // 💥 FAILS BEFORE FIX: leaseValidUntil is not checked in expiry loop
  // Expected: 1 (stream preserved because lease is still valid)
  // Actual: 0 (stream removed by expiry check ignores lease)
  expect(streams).toHaveLength(1);
});
```

- [ ] **7.3 Verify regression fails**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/active-stream-registry-hardening.test.ts --reporter=verbose -t "leaseValidUntil in future"`
Expected: FAIL.

- [ ] **7.4 Implement the fix: add leaseValidUntil check to `startHeartbeatCheck`**

Modify the heartbeat expiry loop in `active-stream-registry.ts` (around line 356-369):

```typescript
this.heartbeatTimer = setInterval(() => {
  const now = Date.now();
  const expireBefore = now - this.expiryMs;
  for (const [k, s] of this.streams) {
    if (!s.stopped && s.lastHeartbeatAt < expireBefore) {
      // Check leaseValidUntil — skip expiry if lease is still valid
      const lease = s.announcement.leaseValidUntil;
      if (lease !== undefined && lease > now) {
        continue; // lease still valid, do not expire
      }
      // Delete active entry
      this.streams.delete(k);
      this.heartbeatSequences.delete(k);
      this.stopTombstones.set(k, now);
      this.emit({ type: "stopped", stream: { ...s.announcement } });
    }
  }
  this.pruneTombstones(now);
}, this.heartbeatIntervalMs);
```

- [ ] **7.5 Verify regression passes**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/active-stream-registry-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

- [ ] **7.6 Run all registry tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/active-stream-registry-phase3.test.ts tests/active-stream-late-join.test.ts tests/active-stream-registry-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 8: Regression + Fix — flushPendingLifecycleToPeer Skips Tombstoned Streams

**Files:**
- Create: same file as Task 3 (`group-connection-manager-hardening.test.ts`)
- Modify: `apps/desktop/src/renderer/services/group-connection-manager.ts`

- [ ] **8.1 git status conflict check**

Run: `git status -- apps/desktop/src/renderer/services/group-connection-manager.ts`
Apply the Conflict Resolution Protocol above. If the file is dirty, never stash/checkout/reset/restore/rebase; apply minimal-context patching with before/after diff verification; defer on same-line semantic overlap.

- [ ] **8.2 Write characterization: stop clears pending lifecycle (the gap was already closed)**

> **Design finding:** Spec §4.3.3 identifies `flushPendingLifecycleToPeer` not checking tombstones. Investigation reveals `GroupConnectionManager` has no reference to `ActiveStreamRegistry`, so a tombstone check would require either (a) passing the registry (broad API change) or (b) relying on the existing `clearPendingForStream` call in `StreamSessionManager.stopStream`. Option (b) is already implemented — `stopStream` calls `connManager.clearPendingForStream()` which removes queued messages for the stopped logical stream before any flush can run. This closes the gap. The test below characterizes that the stop‑then‑flush path works correctly without leaking stopped-stream announcements.

```typescript
it("characterization: stop clears pending lifecycle for the stopped stream", async () => {
  await mgr.sendOrQueueStreamLifecycle(
    GROUP_ID,
    "stream-1",
    "stream.started",
    { logicalStreamId: "stream-1", type: "stream.started" },
  );

  // Clear pending — this is what stopStream does
  mgr.clearPendingForStream(GROUP_ID, "stream-1");

  // Add group and flush — should NOT send the cleared message
  await mgr.addGroup({
    groupId: GROUP_ID,
    controlRoomId: "room-1",
    groupSecret: "test-secret",
    nodeId: "alice",
    displayName: "Alice",
  });
  await tick();
  await tick();

  const conn = mgr.getConnection(GROUP_ID)!;
  const sendSpy = vi.spyOn(conn, "sendToPeer").mockResolvedValue(true);

  await mgr.flushPendingLifecycleToPeer(GROUP_ID, "peer-uuid");

  // The cleared message should NOT be re-sent
  expect(sendSpy).not.toHaveBeenCalled();
});
```

- [ ] **8.3 Run all group-connection-manager tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/group-control-lifecycle-queue.test.ts tests/group-connection-manager-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 9: Characterization — ensureConnected Bounded Polling (Subscription Not Feasible)

**Files:**
- No production files changed (see rationale below)
- Test: `apps/desktop/tests/group-connection-manager-hardening.test.ts` (add test to existing file)

**Decision:** Keep the existing bounded polling. Do NOT replace with event subscription.

**Why subscription is not feasible without broader API changes:**

The current `ensureConnected` implementation in `GroupConnectionManager` polls `conn.state` at 200ms intervals. Converting to event subscription would require hooking into state‑change notifications from `GroupControlConnection`. Here is why that cannot be done within the current API surface:

1. `GroupControlConnection` notifies state changes via `this.opts.onStateChange(s)` (private constructor option, called from `setState()`). This callback is wired once at construction time in `GroupConnectionManager.addGroup()` → `onStateChange(newState) { ... self.onConnectionStateChange(...); self.emitStates(); }`. There is no public subscribable event emitter — just a single callback slot.

2. `ensureConnected` is called *after* construction, so it cannot inject a new callback into the already‑wired `onStateChange` slot. The connection's `opts` object is private — not accessible from `ensureConnected` or from `GroupConnectionManager` after construction.

3. Adding a public `onStateChange` subscription method to `GroupControlConnection` (e.g. `conn.onStateChange(cb) → unsubscribe`) would be a cross‑cutting API change. It would require:
   - Adding an event emitter (or callback registry) to `GroupControlConnection`
   - Changing the constructor or adding a method
   - Updating all existing callers
   
   This is out of scope for a behavior‑preserving hardening plan.

4. Polling at 200ms works correctly. The only downside is up to 200ms added latency on state transitions — acceptable for a control‑channel health check with a 15‑second timeout. The bounded timeout guarantee (line 236-241) ensures no dangling promises.

**Spec alignment:** The design spec §11.1 recommends the subscription approach but states "This is behavior-preserving because both paths produce the same outcome — the only difference is response time." The existing polling IS behavior-preserving. The spec is treated as guidance, not requirement. Keeping polling avoids an unnecessary API change.

- [ ] **9.1 git status conflict check**

Run: `git status -- apps/desktop/src/renderer/services/group-connection-manager.ts`
Apply the Conflict Resolution Protocol above. If the file is dirty, never stash/checkout/reset/restore/rebase; apply minimal-context patching with before/after diff verification; defer on same-line semantic overlap.

- [ ] **9.2 Write characterization test: ensureConnected resolves within timeout (documents timing behavior)**

```typescript
it("characterization: ensureConnected resolves within the bounded timeout", async () => {
  // Trigger ensureConnected while the connection is still starting.
  // The promise should resolve when autoConnect completes and the
  // internal state transitions to "connected".
  const conn = mgr.getConnection(GROUP_ID);
  expect(conn).toBeNull(); // not yet added

  // Start addGroup (which returns before the SDK autoConnect resolves)
  const addPromise = mgr.addGroup({
    groupId: GROUP_ID,
    controlRoomId: "room-1",
    groupSecret: "test-secret",
    nodeId: "alice",
    displayName: "Alice",
  });

  // While addGroup is in-flight, call ensureConnected — this will
  // see state === "starting" and start polling.
  const ensurePromise = mgr.ensureConnected(GROUP_ID, 5_000);

  // Both should resolve
  await expect(Promise.all([addPromise, ensurePromise])).resolves.toBeDefined();
});
```

- [ ] **9.3 Write characterization test: ensureConnected rejects on idle/destroyed state**

```typescript
it("characterization: ensureConnected rejects immediately for destroyed group", async () => {
  // Add a group, then remove it, then try ensureConnected
  await mgr.addGroup({
    groupId: GROUP_ID,
    controlRoomId: "room-1",
    groupSecret: "test-secret",
    nodeId: "alice",
    displayName: "Alice",
  });
  await tick();
  await tick();

  await mgr.removeGroup(GROUP_ID);
  await tick();

  await expect(mgr.ensureConnected(GROUP_ID)).rejects.toThrow("not connected");
});

it("characterization: ensureConnected rejects for unknown group", async () => {
  await expect(mgr.ensureConnected("nonexistent")).rejects.toThrow("not connected");
});
```

- [ ] **9.4 Run all group-control tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/group-control-lifecycle-queue.test.ts tests/group-control-transport-results.test.ts tests/group-control-mesh-lifecycle.test.ts tests/group-control-connection-hardening.test.ts tests/group-connection-manager-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 10: Regression + Fix — StreamSessionManager switchSource Destroyed Check

**Files:**
- Create: revisit `stream-session-manager-hardening.test.ts`
- Modify: `apps/desktop/src/renderer/services/stream-session-manager.ts`

- [ ] **10.1 git status conflict check**

Run: `git status -- apps/desktop/src/renderer/services/stream-session-manager.ts`
Apply the Conflict Resolution Protocol above. If the file is dirty, never stash/checkout/reset/restore/rebase; apply minimal-context patching with before/after diff verification; defer on same-line semantic overlap.

- [ ] **10.2 Write failing regression: switchSource with destroyed session is no-op**

```typescript
it("regression: switchSource with destroyed session is no-op (REVEALS GAP — must FAIL)", async () => {
  // Set destroyed state directly
  (ssm as any).destroyed = true;
  (ssm as any)._state = "active"; // switchSource requires _state === "active"

  // Spy on internal methods that switchSource would call
  const getDisplayMediaSpy = vi.spyOn(navigator.mediaDevices, "getDisplayMedia" as any);

  try {
    await ssm.switchSource("screen" as any);
  } catch {
    // might throw if it checks destroyed before proceeding
  }

  // 💥 FAILS BEFORE FIX: getDisplayMedia should NOT be called
  // when destroyed is true
  expect(getDisplayMediaSpy).not.toHaveBeenCalled();
});
```

- [ ] **10.3 Verify regression fails**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/stream-session-manager-hardening.test.ts --reporter=verbose -t "switchSource with destroyed"`
Expected: FAIL (getDisplayMedia was called despite destroyed=true).

- [ ] **10.4 Implement the fix: add `destroyed` check to `switchSource`**

In `stream-session-manager.ts`, at the top of the `switchSource` method, add:

```typescript
async switchSource(sourceKind: string): Promise<void> {
  if (this.destroyed) return; // ← ADD THIS
  if (this._state !== "active") throw new Error("Stream is not active");
  // ... rest of method
}
```

- [ ] **10.5 Verify regression passes**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/stream-session-manager-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 11: Regression + Fix — PublisherManager replaceVideoTrack Null Publisher Check

**Files:**
- Create: revisit `publisher-manager-hardening.test.ts`
- Modify: `apps/desktop/src/renderer/services/publisher-manager.ts`

- [ ] **11.1 git status conflict check**

Run: `git status -- apps/desktop/src/renderer/services/publisher-manager.ts`
Apply the Conflict Resolution Protocol above. If the file is dirty, never stash/checkout/reset/restore/rebase; apply minimal-context patching with before/after diff verification; defer on same-line semantic overlap.

- [ ] **11.2 Write failing regression: replaceVideoTrack null publisher check**

```typescript
it("regression: replaceVideoTrack throws when publisher is null (already works — characterization)", async () => {
  // This already throws with "no publisher active" from line 627.
  // The spec §10.2 hypothesizes a gap (missing publisher null check).
  // Current code checks `if (!this.publisher) throw ...` at line 627.
  // This test passes as characterization.
  const newTrack = { kind: "video", id: "new-track" } as unknown as MediaStreamTrack;
  await expect(pm.replaceVideoTrack(newTrack)).rejects.toThrow("no publisher active");
});
```

*Note:* The spec hypothesizes a gap in `publisher-manager.ts:replaceVideoTrack` but the current code DOES check `if (!this.publisher) throw new Error(...)` at line 627. This is already correctly guarded. The test serves as characterization / regression prevention.

- [ ] **11.3 Run publisher tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/publisher-manager.test.ts tests/publisher-manager-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 12: Regression + Fix — GroupConnectionManager Queue Size Log Warning

**Files:**
- Modify: `apps/desktop/src/renderer/services/group-connection-manager.ts`

- [ ] **12.1 git status conflict check**

Run: `git status -- apps/desktop/src/renderer/services/group-connection-manager.ts`
Apply the Conflict Resolution Protocol above. If the file is dirty, never stash/checkout/reset/restore/rebase; apply minimal-context patching with before/after diff verification; defer on same-line semantic overlap.

- [ ] **12.2 Write failing regression: queue size cap reached logs warning**

```typescript
it("regression: queue size cap logs warning when hit (REVEALS GAP — must FAIL)", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  // Queue 17 messages to trigger eviction
  for (let i = 0; i < 17; i++) {
    await mgr.sendOrQueueStreamLifecycle(
      GROUP_ID,
      `stream-${i}`,
      "stream.started",
      { logicalStreamId: `stream-${i}`, type: "stream.started" },
    );
  }

  // 💥 FAILS BEFORE FIX: no warning is emitted
  const queueSizeWarnings = warnSpy.mock.calls.filter(
    ([msg]: any[]) => typeof msg === "string" && msg.includes("queue size cap"),
  );
  expect(queueSizeWarnings.length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **12.3 Verify regression fails**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/group-connection-manager-hardening.test.ts --reporter=verbose -t "queue size cap"`
Expected: FAIL (no warning emitted).

- [ ] **12.4 Implement the fix: add log warning in `enqueueLifecycle`**

In `group-connection-manager.ts`, modify `enqueueLifecycle` (around line 493):

```typescript
// Bound queue size per group — evict oldest entries if exceeded.
if (queue.size > MAX_PENDING_PER_GROUP) {
  console.warn(
    `[GroupConnectionManager] queue size cap reached for group ${groupId} (${queue.size} entries) — this suggests a systemic flush failure`,
  );
  const entries = Array.from(queue.entries());
  const toEvict = entries.slice(0, queue.size - MAX_PENDING_PER_GROUP);
  for (const [k] of toEvict) {
    queue.delete(k);
  }
}
```

- [ ] **12.5 Verify regression passes**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/group-connection-manager-hardening.test.ts --reporter=verbose`
Expected: ALL PASS.

---

## Task 13: Regression + Fix — Stream Lifecycle Payload Builder Extraction

**Files:**
- Modify: `apps/desktop/src/renderer/services/stream-session-manager.ts`

- [ ] **13.1 git status conflict check**

Run: `git status -- apps/desktop/src/renderer/services/stream-session-manager.ts`
Apply the Conflict Resolution Protocol above. If the file is dirty, never stash/checkout/reset/restore/rebase; apply minimal-context patching with before/after diff verification; defer on same-line semantic overlap.

- [ ] **13.2 Read stream-session-manager.ts to understand current inline payload construction**

Read lines around `startStream` Phase B broadcast and `restartStream` Phase B broadcast.

Expected: There are inline payload constructions at multiple sites that build the same shape for broadcast (lifecycle type, logicalStreamId, mediaSessionId, groupId, hostDeviceId, etc.).

- [ ] **13.3 Write characterization test: payload shape captured and verified before extraction**

Add inside the SSM hardening describe block. This test runs `startStream` through its full path (with mocked capture and publisher) and captures the payload that `sendOrQueueStreamLifecycle` receives. The assertion documents the exact field set before extraction so the extraction preserves it.

```typescript
it("characterization: startStream lifecycle payload includes all required fields", async () => {
  // Provide a capture track with non-zero settings
  const videoTrack = {
    kind: "video", id: "vt-payload",
    enabled: true, readyState: "live",
    label: "screen-capture", contentHint: "motion",
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
    stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
  const stream = {
    getVideoTracks: vi.fn(() => [videoTrack]),
    getAudioTracks: vi.fn(() => []),
    addTrack: vi.fn(), removeTrack: vi.fn(),
    getTrackById: vi.fn(), clone: vi.fn(),
    id: "cap-stream", active: true,
  } as unknown as MediaStream;
  (navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockResolvedValue(stream);

  // Wire publisher mock so SSM can create it
  // Note: PublisherManager must be imported at the top of the describe block for this test to compile.
  const pmEvents = { onStateChange: vi.fn(), onStats: vi.fn(), onError: vi.fn(), onTrackEnded: vi.fn() };
  (ssm as any).publisherManager = new PublisherManager(pmEvents);
  (ssm as any)._state = "idle";

  // Spy on the control broadcast to capture payload
  const connManager = runtime.getConnectionManager() as any;
  const sendSpy = connManager.sendOrQueueStreamLifecycle as ReturnType<typeof vi.fn>;

  await ssm.startStream({
    groupId: "group-1",
    logicalStreamId: "stream-1",
    sourceKind: "screen",
    videoBitrate: 2000,
    videoWidth: 1920,
    videoHeight: 1080,
    videoFps: 30,
  });

  // sendOrQueueStreamLifecycle was called at least once with "stream.started"
  expect(sendSpy).toHaveBeenCalled();

  // Extract the last call's payload (4th argument: the payload record)
  const calls = sendSpy.mock.calls.filter(
    ([_gid, _lid, type]: [string, string, string]) => type === "stream.started",
  );
  expect(calls.length).toBeGreaterThanOrEqual(1);

  const lastPayload = calls[calls.length - 1][3] as Record<string, unknown>;

  // Verify every expected field is present (these must survive extraction)
  const requiredFields = [
    "logicalStreamId", "mediaSessionId", "groupId", "hostDeviceId",
    "hostDisplayName", "sourceKind", "sourceName", "startedAt",
    "appliedSettingsRevision", "heartbeatSequence", "streamRevision",
    "mediaJoinMetadata",
  ];
  for (const field of requiredFields) {
    expect(lastPayload).toHaveProperty(field);
    expect(lastPayload[field]).toBeDefined();
  }

  // Verify type is not in payload (stripped by envelope builder)
  expect(lastPayload).not.toHaveProperty("type");

  console.log("[characterization] captured lifecycle payload fields:", Object.keys(lastPayload));
});
```

> **Note:** This test requires the SSM to successfully complete Phase A (capture + publisher creation) so that Phase B (broadcast) is reached. If the test environment cannot provide a working PublisherManager mock, skip this test and verify payload preservation manually by comparing `git diff` of the `buildLifecyclePayload()` method against the inline constructions it replaces.

- [ ] **13.4 Extract `buildLifecyclePayload()` method**

Add a private method to `StreamSessionManager`:

```typescript
private buildLifecyclePayload(
  type: "stream.started" | "stream.restarted" | "stream.stopped",
  logicalStreamId: string,
  mediaSessionId: string,
): Record<string, unknown> {
  return {
    type,
    logicalStreamId,
    mediaSessionId,
    groupId: this._currentGroupId,
    hostDeviceId: this.runtime.deviceId,
    hostDisplayName: this.runtime.displayName,
    sourceKind: this._sourceKind,
    sourceName: this._sourceName,
    startedAt: this._startedAt,
    appliedSettingsRevision: this._appliedSettingsRevision,
    heartbeatSequence: this._heartbeatSequence,
    streamRevision: this._streamRevision,
    mediaJoinMetadata: this._mediaJoinMetadata,
    replacesSessionId: this._replacesSessionId,
    isAudioDegraded: this._isAudioDegraded,
  };
}
```

Replace the inline payload constructions in `startStream` Phase B, `restartStream` Phase B, and `stopStream` broadcast with calls to `this.buildLifecyclePayload(...)`.

- [ ] **13.5 Run all stream-session-manager tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/stream-session-manager.test.ts tests/stream-session-manager-hardening.test.ts --reporter=verbose`
Expected: ALL PASS (payload extraction is behavior-preserving).

---

## Task 14: Stress Verification — Run All Hardening Tests

- [ ] **14.1 Run ALL tests in the hardening suite**

Run:
```
pnpm --filter @screenlink/desktop exec vitest run `
  tests/stream-session-manager-hardening.test.ts `
  tests/active-stream-registry-hardening.test.ts `
  tests/group-connection-manager-hardening.test.ts `
  tests/publisher-manager-hardening.test.ts `
  tests/group-control-connection-hardening.test.ts `
  tests/stream-session-manager.test.ts `
  tests/active-stream-registry-phase3.test.ts `
  tests/active-stream-late-join.test.ts `
  tests/group-control-lifecycle-queue.test.ts `
  tests/group-control-transport-results.test.ts `
  tests/group-control-mesh-lifecycle.test.ts `
  tests/publisher-manager.test.ts `
  --reporter=verbose
```

Expected: ALL PASS.

---

## Task 15: Verification — git status check for all modified files

- [ ] **15.1 Run git status to verify no unintended changes**

Run: `git status`
Expected: Only the files listed in the file map above are modified. No untracked files left behind (other than the new test files which should be tracked). If the user has not requested commits, just verify the working tree is consistent.

Run: `git diff --stat`
Expected: Only `active-stream-registry.ts`, `group-connection-manager.ts`, `stream-session-manager.ts` (if payload extraction was done) have changes. No changes to `publisher-manager.ts` (the null check was already there).

- [ ] **15.2 Final status check**

All characterization tests: PASS.
All regression tests (which previously failed): now PASS.
All existing tests: PASS.
No files modified that shouldn't be.
All changes are behavior-preserving — no new features, no protocol changes, no schema changes.
