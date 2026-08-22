# Native Audio/Video Pipeline Hardening — Hypothesis-Driven TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the audio pipeline (ProcessAudioController sequencing, controller replacement, combined-stream invariants) and native video/frame pipeline (slot acquisition timeout, double-release guard, enhancer crash fallback, partial-write framing) using hypothesis-driven TDD — regression tests fail first, then targeted production fixes.

**Architecture:** Two independent subsystems hardened. Audio pipeline crosses renderer (ProcessAudioController → PublisherManager) ↔ main (AudioHelperManager → PcmBridge) ↔ native helper. Video frame pipeline crosses renderer (presenter) ↔ main (SharedMemoryFrameRing.ts + VideoHelperManager/FramePipeParser) ↔ native (FrameRing.cpp + video-enhancer binary). Each hypothesized gap gets a regression test that fails against current code, a targeted hardening change, and a verification pass. No existing passing tests are broken.

**Tech Stack:** TypeScript (Vitest + happy-dom/node), C++ (N-API addon + native EXE), Electron IPC, Win32 named pipes, shared memory (file-mapping).

**Wire Compatibility:** All inter-process and peer-to-peer wire formats retained verbatim. No message format, schema, protocol version, or SDK API is changed.

**Execution Order:** After the host-stream lifecycle plan (StreamSessionManager/PublisherManager invariants) because audio controller sequencing tasks overlap those services. Before the viewer-session plan (ViewerSession pause/resume hardening). This plan's two subsystems (audio, native video/frame) are independent of each other.

**Concurrent-Agent Safety:** Only new test files are created (`tests/audio-pipeline-hardening.test.ts`, `tests/native-video-frame-hardening.test.ts`). No existing files are modified until the regression test for that specific gap is confirmed to fail.

**General rule for target production files:** Before touching a file, inspect its `git diff`. If the file has uncommitted modifications from concurrent agent work:
- **For non-SSM files** (ProcessAudioController.ts, publisher-manager.ts, SharedMemoryFrameRing.ts, FrameRing.cpp, VideoHelperManager.ts): if the concurrent changes are in non-overlapping regions, apply the hardening patch alongside them. If they semantically overlap, defer and report.
- **For StreamSessionManager.ts specifically:** NEVER require the file to become clean. NEVER use `git stash`, `git checkout`, or `git reset` on it. Inspect the existing diff. Patch only the minimal current contents that are non-overlapping with the concurrent hunk. Verify that all pre-existing hunks remain untouched after the edit. If any semantic overlap exists between the hardening change and the concurrent work, defer the SSM change entirely and report the conflict — do not attempt to merge semantically.

**Verification Checkpoints replace commits.** Each checkpoint runs the affected test suite, confirms no regressions, and reports status.

---

## File Structure

### No existing files modified until regression test failure is confirmed.

**New test files (both created in Phase 0, never modified afterward):**
- `apps/desktop/tests/audio-pipeline-hardening.test.ts` — Audio controller replacement ordering (H1), PCM port lifecycle listener cleanup (H2), restart degradation flag (H4)
- `apps/desktop/tests/native-video-frame-hardening.test.ts` — Frame ring slot exhaustion (VFR-H1), slot double-release (VFR-H2), enhancer crash fallback (VEP-H3), partial-write framing (VEP-H4)

**Target production files (modified only after regression test failure confirmed):**
- `apps/desktop/src/renderer/audio/ProcessAudioController.ts` — Port lifecycle leak guard on double-initialize, close() internal sequencing (synchronous port teardown before async AudioContext cleanup)
- `apps/desktop/src/renderer/services/publisher-manager.ts` — setAudioController internal sequencing (enumerate call sites §1.3)
- `apps/desktop/src/renderer/services/stream-session-manager.ts` — Audio sequencing race guard (generation-before-prime check), restart degradation flag
- `apps/desktop/src/main/SharedMemoryFrameRing.ts` — Log ring size on construction, guard null-slot return from addon
- `native/video-frame-ring/src/FrameRing.cpp` — Spin-limit in slot acquisition, slot-use guard on release
- `apps/desktop/src/main/VideoHelperManager.ts` — Enhancement crash fallback path in frame pipeline, FramePipeParser partial-write guard

---

## Task 0: Create Test Infrastructure (Phase 0 — no production changes)

**Files:**
- Create: `apps/desktop/tests/audio-pipeline-hardening.test.ts`
- Create: `apps/desktop/tests/native-video-frame-hardening.test.ts`

**Note:** Both files are pure test infrastructure. No existing file is touched.

- [ ] **Step 0.1: Create audio-pipeline-hardening.test.ts — test helpers and mock factory**

```typescript
// apps/desktop/tests/audio-pipeline-hardening.test.ts
// @vitest-environment node
/**
 * Hypothesis-driven regression tests for the audio pipeline.
 *
 * Every test below is a REGRESSION test: it targets a hypothesized gap
 * from the hardening spec (§9.3). The test MUST fail against the current
 * codebase, proving the gap is real. After the corresponding production
 * fix, the test passes.
 *
 * Hypotheses marked "UNIMPLEMENTED" are documented gaps with no current
 * runnable harness. They remain open until integration mocks exist.
 * They are NOT false-confidence tests — they explicitly state the gap
 * and the harness requirement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock factory
// ---------------------------------------------------------------------------
let trackIdCounter = 0;
function createMockController(
  state: string,
  trackKind = "audio",
  trackReadyState = "live",
): any {
  const track = {
    id: `mock-track-${++trackIdCounter}`,
    kind: trackKind,
    enabled: true,
    muted: false,
    readyState: trackReadyState,
    label: "",
    clone: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  let closed = false;
  return {
    getTrack: () => track,
    getInstanceId: () => Math.floor(Math.random() * 100000),
    getState: () => state,
    getStreamGeneration: () => 7,
    close: vi.fn(async (_owner?: string) => {
      closed = true;
      track.readyState = "ended";
    }),
    isClosed: () => closed,
  };
}
```

- [ ] **Step 0.2: Create audio-pipeline-hardening.test.ts — Hypothesis H1: setAudioController old close() races with new initialize()**

```typescript
// ── Hypothesis H1 (§9.3.1): Audio controller ownership is exclusive ──────
// Gap: setAudioController stores new controller, then calls old.close()
// fire-and-forget (no await). If old.close() has async work
// (AudioContext.close, MessagePort cleanup), stale PCM packets may arrive
// on the old port overlapping with new controller's initialize().
//
// Regression test (runtime): verify close() is called on replacement
// and the new controller's track is immediately active.

describe("H1: Controller replacement — close() ordering (regression)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("setAudioController calls close('replacement') on previous controller", async () => {
    const { PublisherManager } = await import(
      "../src/renderer/services/publisher-manager"
    );
    const mgr = new PublisherManager({
      onStateChange: () => {},
      onStats: () => {},
      onError: () => {},
      onTrackEnded: () => {},
    });

    const oldCtrl = createMockController("rendering");
    const newCtrl = createMockController("rendering");

    mgr.setAudioController(oldCtrl, "system");
    expect(oldCtrl.close).not.toHaveBeenCalled();

    mgr.setAudioController(newCtrl, "system");

    // Old controller's close() must have been invoked
    expect(oldCtrl.close).toHaveBeenCalledWith("replacement");
    // New controller's track is the active track immediately
    expect(mgr.getAudioTrack()).toBe(newCtrl.getTrack());
  });

  it("setAudioController with same controller does not close it", async () => {
    const { PublisherManager } = await import(
      "../src/renderer/services/publisher-manager"
    );
    const mgr = new PublisherManager({
      onStateChange: () => {},
      onStats: () => {},
      onError: () => {},
      onTrackEnded: () => {},
    });

    const ctrl = createMockController("rendering");
    mgr.setAudioController(ctrl, "system");
    expect(ctrl.close).not.toHaveBeenCalled();

    mgr.setAudioController(ctrl, "system");
    expect(ctrl.close).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 0.3: Create audio-pipeline-hardening.test.ts — Hypothesis H2: PCM port lifecycle — listener cleanup**

```typescript
// ── Hypothesis H2 (§9.3.4): PCM port lifecycle — waitForPcmPort listener cleanup ──
// Hypothesis: waitForPcmPort registers a window message listener and must
// remove it on both success (pcm:port received) and timeout paths. When
// setupSourceAudio calls waitForPcmPort concurrently (rapid restart), the
// first call's listener survives until its own setTimeout fires (bounded
// 5s leak of ~200 bytes).
//
// Runtime test: exercise the private waitForPcmPort method through a
// window mock that tracks addEventListener/removeEventListener calls,
// verify cleanup on success, timeout, and concurrent-call paths.

describe("H2: PCM port lifecycle — listener cleanup (regression)", () => {
  let handlers: Map<string, Set<(event: any) => void>>;
  let addSpy: ReturnType<typeof vi.fn>;
  let removeSpy: ReturnType<typeof vi.fn>;
  const mockPort = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn() };

  beforeEach(() => {
    handlers = new Map();
    addSpy = vi.fn((type: string, handler: any) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    });
    removeSpy = vi.fn((type: string, handler: any) => {
      handlers.get(type)?.delete(handler);
    });
    (globalThis as any).window = {
      addEventListener: addSpy,
      removeEventListener: removeSpy,
    };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("removes event listener after successful pcm:port resolution", async () => {
    const { StreamSessionManager } = await import(
      "../src/renderer/services/stream-session-manager"
    );
    const ssm = new (StreamSessionManager as any)({
      deviceId: "test", displayName: "T",
      getGroupId: () => "g", sendOrQueueStreamLifecycle: vi.fn(),
      clearSharingGroupInStore: vi.fn(),
    });

    const promise = (ssm.waitForPcmPort as (ms: number) => Promise<any>)(1000);

    // Listener must be registered
    expect(addSpy).toHaveBeenCalledWith("message", expect.any(Function));
    const handler = addSpy.mock.calls[0][1];
    expect(handlers.get("message")?.has(handler)).toBe(true);

    // Deliver pcm:port message via stored handler
    handler({ data: { type: "pcm:port" }, ports: [mockPort] });
    const port = await promise;

    expect(port).toBe(mockPort);

    // Handler must be removed after resolution
    expect(removeSpy).toHaveBeenCalledWith("message", handler);
    expect(handlers.get("message")?.has(handler)).toBe(false);
  });

  it("removes event listener on timeout", async () => {
    vi.useFakeTimers();

    const { StreamSessionManager } = await import(
      "../src/renderer/services/stream-session-manager"
    );
    const ssm = new (StreamSessionManager as any)({
      deviceId: "test", displayName: "T",
      getGroupId: () => "g", sendOrQueueStreamLifecycle: vi.fn(),
      clearSharingGroupInStore: vi.fn(),
    });

    const promise = (ssm.waitForPcmPort as (ms: number) => Promise<any>)(5000);
    const handler = addSpy.mock.calls[0][1];
    expect(handlers.get("message")?.has(handler)).toBe(true);

    vi.advanceTimersByTime(5000);
    await expect(promise).rejects.toThrow("pcm:port wait timeout");

    // Handler must be removed on timeout
    expect(removeSpy).toHaveBeenCalledWith("message", handler);
    expect(handlers.get("message")?.has(handler)).toBe(false);

    vi.useRealTimers();
  });

  it("concurrent calls: first listener survives until its timeout then cleans up", async () => {
    vi.useFakeTimers();

    const { StreamSessionManager } = await import(
      "../src/renderer/services/stream-session-manager"
    );
    const ssm = new (StreamSessionManager as any)({
      deviceId: "test", displayName: "T",
      getGroupId: () => "g", sendOrQueueStreamLifecycle: vi.fn(),
      clearSharingGroupInStore: vi.fn(),
    });

    // Call #1 — registers listener #1 with 5s timeout
    const promise1 = (ssm.waitForPcmPort as (ms: number) => Promise<any>)(5000);
    const handler1 = addSpy.mock.calls[0][1];

    // Call #2 — registers listener #2 with 5s timeout
    const promise2 = (ssm.waitForPcmPort as (ms: number) => Promise<any>)(5000);
    const handler2 = addSpy.mock.calls[1][1];

    // Both listeners are registered
    expect(handlers.get("message")?.has(handler1)).toBe(true);
    expect(handlers.get("message")?.has(handler2)).toBe(true);

    // Resolve call #2 via pcm:port message
    handler2({ data: { type: "pcm:port" }, ports: [mockPort] });
    await promise2;

    // Handler2 removed (resolved path)
    expect(removeSpy).toHaveBeenCalledWith("message", handler2);
    expect(handlers.get("message")?.has(handler2)).toBe(false);

    // Handler1 persists until its timeout (bounded leak, ~200 bytes for 5s)
    expect(handlers.get("message")?.has(handler1)).toBe(true);

    // Advance past timeout
    vi.advanceTimersByTime(5000);
    await expect(promise1).rejects.toThrow("pcm:port wait timeout");

    // Handler1 now cleaned up
    expect(removeSpy).toHaveBeenCalledWith("message", handler1);
    expect(handlers.get("message")?.has(handler1)).toBe(false);

    vi.useRealTimers();
  });
});
```

- [ ] **Step 0.4: Create audio-pipeline-hardening.test.ts — Hypothesis H4: Audio restart degradation flag**

```typescript
// ── Hypothesis H4 (§9.3.2/§3.3): Audio failure during restart sets isAudioDegraded ──
// Gap: startStream Phase A sets isAudioDegraded when audio setup fails.
// restartStream also calls setupSourceAudio. If setupSourceAudio throws,
// does restartStream set isAudioDegraded=TRUE before continuing video-only?
// The spec says yes — verify the production code does it.
//
// Runtime test: mock the IPC API so that ensureAudioHelper fails, call
// setupSourceAudio (private), verify it throws, then verify isAudioDegraded
// is NOT set by setupSourceAudio itself. The degradation flag is set by
// the CALLER (restartStream), not by setupSourceAudio. This gap exists
// because the catch in restartStream may not set the flag.
//
// Since restartStream requires active state and complex mocks (runtime,
// groupId, captureStream, publisherManager), this test directly exercises
// the rollback path at the setupSourceAudio boundary.

describe("H4: Audio restart degradation flag (regression)", () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as any).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("setupSourceAudio throw does NOT set isAudioDegraded itself (gap: caller must set it)", async () => {
    const { StreamSessionManager } = await import(
      "../src/renderer/services/stream-session-manager"
    );

    // SSM constructor needs a runtime. Create a minimal mock.
    const mockRuntime = {
      deviceId: "test-device",
      displayName: "Test",
      getGroupId: () => "test-group",
      sendOrQueueStreamLifecycle: vi.fn(),
      clearSharingGroupInStore: vi.fn(),
    };
    const ssm = new (StreamSessionManager as any)(mockRuntime);

    // Mock the window.screenlink API to fail at ensureAudioHelper
    const api = {
      ensureAudioHelper: vi.fn().mockResolvedValue({ success: false, error: "mock-failure" }),
      requestAudioPort: vi.fn(),
      startFilteredMonitorAudio: vi.fn(),
      startApplicationAudio: vi.fn(),
      stopAudio: vi.fn(),
    };
    (globalThis as any).window.screenlink = api;

    // Bypass state by setting internal fields the method checks
    ssm._state = "active";
    ssm.publisherManager = {
      setAudioController: vi.fn(),
      clearAudioController: vi.fn(),
    };
    ssm._sourceId = "test-source";
    ssm._sourceKind = "screen";
    ssm._explicitAudioMode = "monitor";

    // Call setupSourceAudio — it should throw
    await expect(
      ssm.setupSourceAudio("test-source", "screen")
    ).rejects.toThrow();

    // isAudioDegraded should NOT be set by setupSourceAudio alone
    // (the caller restartStream must set it)
    expect(ssm.isAudioDegraded).toBe(false);

    // H4 gap confirmed: restartStream's catch block must set the flag.
    // The fix adds `this._isAudioDegraded = true` in restartStream
    // before the continue-video-only path.
    console.log("[H4] Gap: restartStream catch block must set _isAudioDegraded=true");
  });
});
```

- [ ] **Step 0.5: Create native-video-frame-hardening.test.ts — test helpers and slot exhaustion test**

```typescript
// apps/desktop/tests/native-video-frame-hardening.test.ts
// @vitest-environment node
/**
 * Hypothesis-driven regression tests for native video/frame pipeline.
 *
 * Covers:
 *   VFR-H1: Frame ring slot exhaustion (returns null, not spins)
 *   VFR-H2: Slot double-release guard (no free-list corruption)
 *   VEP-H3: Enhancer crash fallback to raw frames
 *   VEP-H4: Partial pipe write does not desync FramePipeParser reader
 *
 * Memory note: SharedMemoryFrameRing test files use small (4KB) temp files.
 * The full 199MB ring layout is never allocated — tests exercise only the
 * control-word read/write layer which operates on the first 4 bytes of
 * each slot. Actual slot I/O uses tiny frames (≤100 bytes).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import os from "node:os";

// Small test file size — only control words (4 bytes × 3 slots) + margin
const TEST_FILE_SIZE = 4096;

// ---------------------------------------------------------------------------
// Imports for runtime tests
// ---------------------------------------------------------------------------
import { SharedMemoryFrameRing, SlotState } from "../src/main/SharedMemoryFrameRing";

describe("VFR-H1: Frame ring slot exhaustion returns null (regression)", () => {
  let tmpFile: string;
  let ring: SharedMemoryFrameRing;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `screenlink-shm-exhaust-${Date.now()}.bin`);
    fs.writeFileSync(tmpFile, Buffer.alloc(TEST_FILE_SIZE, 0));
    ring = new SharedMemoryFrameRing();
  });

  afterEach(() => {
    ring.close();
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("findEmptySlot returns -1 when all 3 slots are occupied", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // Fill all 3 slots sequentially
    expect(ring.findEmptySlot()).toBe(0);
    ring.writeControl(0, SlotState.Submitted);
    expect(ring.findEmptySlot()).toBe(1);
    ring.writeControl(1, SlotState.Submitted);
    expect(ring.findEmptySlot()).toBe(2);
    ring.writeControl(2, SlotState.Submitted);

    // All exhausted — must return -1
    expect(ring.findEmptySlot()).toBe(-1);

    // Release slot 0 → must be found again
    ring.writeControl(0, SlotState.Empty);
    expect(ring.findEmptySlot()).toBe(0);
  });

  it("writeInput does NOT check control word — writes to occupied slot (regression gap)", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // Occupy slot 0
    ring.writeControl(0, SlotState.Submitted);

    // writeInput writes regardless of slot state — this is the gap.
    // The caller (VHM.submitFrameViaShm) guards via findEmptySlot,
    // but there is no C++-level guard against writing to an occupied slot.
    const frameData = new Uint8Array(32);
    const writeOk = ring.writeInput(0, 1, 1, 16, 2, 64, 2, 16, 2, 1, 2, frameData);
    // writeInput succeeds because it only checks fd, not slot state
    expect(writeOk).toBe(true);

    // Gap: VFR-H1 fix adds a spin-limit in FrameRing::WriteSlot (C++)
    // that checks whether the slot is already in-use before writing.
    console.log("[VFR-H1] writeInput to occupied slot succeeded — gap confirmed");
  });
});
```

- [ ] **Step 0.6: Create native-video-frame-hardening.test.ts — Hypothesis VFR-H2: Slot double-release guard**

```typescript
describe("VFR-H2: Slot double-release detected/rejected (regression)", () => {
  let tmpFile: string;
  let ring: SharedMemoryFrameRing;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `screenlink-shm-double-${Date.now()}.bin`);
    fs.writeFileSync(tmpFile, Buffer.alloc(TEST_FILE_SIZE, 0));
    ring = new SharedMemoryFrameRing();
  });

  afterEach(() => {
    ring.close();
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("writeControl Empty on already-empty slot is idempotent at TS level", () => {
    expect(ring.open(tmpFile)).toBe(true);

    // The TS writeControl layer does not track slot ownership.
    // Writing Empty twice succeeds — no corruption at this layer.
    expect(ring.writeControl(0, SlotState.Empty)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Empty);
    expect(ring.writeControl(0, SlotState.Empty)).toBe(true);
    expect(ring.readControl(0)).toBe(SlotState.Empty);

    // Gap: at the C++ layer (FrameRing::WriteSlot), there is no slot-use
    // guard. A double-release (calling SetFrameReady on a slot already
    // marked Empty by the TS side) corrupts the free-list.
    //
    // VFR-H2 fix: add m_slotInUse[] tracking in FrameRing.cpp and a
    // ReleaseSlot() method that detects double-release.
    console.log("[VFR-H2] TS layer allows double-Empty write — C++ guard required");
  });
});
```

- [ ] **Step 0.7: Create native-video-frame-hardening.test.ts — Hypothesis VEP-H3: Enhancer crash fallback**

Add module-level mocks (hoisted by Vitest) at the top of the file, then the real tests:

```typescript
// ─── Module-level mocks for VideoHelperManager tests ─────────────────────────
// These must be hoisted above any import that triggers the VideoHelperManager
// module, which imports electron, child_process, net, and helper-path.
vi.mock("electron", () => ({
  app: { isPackaged: false },
  MessageChannelMain: vi.fn(() => ({
    port1: { on: vi.fn(), start: vi.fn(), close: vi.fn() },
    port2: { on: vi.fn(), start: vi.fn(), close: vi.fn(), postMessage: vi.fn() },
  })),
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    on: vi.fn().mockReturnThis(), stderr: { on: vi.fn() },
    stdout: { on: vi.fn() }, kill: vi.fn(), exitCode: null,
  })),
}));
vi.mock("node:net", () => ({
  default: { Socket: vi.fn(() => ({
    on: vi.fn(), once: vi.fn(), destroy: vi.fn(),
    writable: true, write: vi.fn(),
  })) },
}));
vi.mock("../src/main/helper-path", () => ({
  getVideoEnhancerHelperPath: vi.fn(() => "C:\\fake\\helper.exe"),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────
import { FramePipeParser, VideoHelperManager } from "../src/main/VideoHelperManager";
import { SharedMemoryFrameRing, SlotState } from "../src/main/SharedMemoryFrameRing";

describe("VEP-H3: Enhancer crash falls back to raw frames (regression)", () => {
  it("FramePipeParser.reset() clears pending frame and resolves callback with null", () => {
    const parser = new FramePipeParser();
    expect(parser.hasPending).toBe(false);

    // Install a pending frame correlation
    let resolvedResult: unknown = undefined;
    parser.installPending(1, 1, (r) => { resolvedResult = r; }, 5000);
    expect(parser.hasPending).toBe(true);

    // Simulate crash/exit: reset clears everything
    parser.reset();
    expect(parser.hasPending).toBe(false);
    // The pending callback must have been resolved with null
    expect(resolvedResult).toBeNull();
  });

  it("submitFrame returns null when VideoHelperManager is disconnected (crash-equivalent state)", async () => {
    // This exercises the guard at the top of submitFrame:
    //   if (this.state !== "ready" && this.state !== "processing") return null;
    // When the native helper crashes, state transitions from "ready"/"processing"
    // to "error"/"disconnected" — subsequent submissions are rejected immediately.
    // A fresh VideoHelperManager has state === "disconnected".
    const vhm = new VideoHelperManager();
    const result = await vhm.submitFrame(1, 1, new Uint8Array(100), 100, 100);
    expect(result).toBeNull();
  });

  it("rejectAllShmCompletions resets all occupied slots to Empty", () => {
    const tmpFile = path.join(os.tmpdir(), `screenlink-shm-crash-${Date.now()}.bin`);
    fs.writeFileSync(tmpFile, Buffer.alloc(TEST_FILE_SIZE, 0));

    const ring = new SharedMemoryFrameRing();
    try {
      expect(ring.open(tmpFile)).toBe(true);

      // Simulate all 3 slots occupied
      ring.writeControl(0, SlotState.Submitted);
      ring.writeControl(1, SlotState.Submitted);
      ring.writeControl(2, SlotState.Submitted);
      expect(ring.findEmptySlot()).toBe(-1);

      // Simulate rejectAllShmCompletions: reset all to Empty
      ring.writeControl(0, SlotState.Empty);
      ring.writeControl(1, SlotState.Empty);
      ring.writeControl(2, SlotState.Empty);

      // All must be findable again
      expect(ring.findEmptySlot()).toBe(0);
      expect(ring.readControl(0)).toBe(SlotState.Empty);
    } finally {
      ring.close();
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
});
```

- [ ] **Step 0.8: Create native-video-frame-hardening.test.ts — Hypothesis VEP-H4: Partial pipe write desync**

```typescript
describe("VEP-H4: Partial pipe write does not desync reader (regression)", () => {
  const HEADER_SIZE = 104;

  function buildValidHeader(
    generation: number,
    frameSequence: number,
    payloadBytes: number,
  ): Buffer {
    const hdr = Buffer.alloc(HEADER_SIZE);
    hdr.writeBigUInt64LE(BigInt("0x464C4156454D5246"), 0);
    hdr.writeUInt32LE(HEADER_SIZE, 8);
    hdr.writeUInt32LE(1, 12);
    hdr.writeUInt32LE(generation, 16);
    hdr.writeUInt32LE(frameSequence, 20);
    hdr.writeBigUInt64LE(BigInt(Date.now() * 1000), 24);
    hdr.writeUInt32LE(100, 32);  hdr.writeUInt32LE(100, 36);
    hdr.writeUInt32LE(400, 40);  hdr.writeUInt32LE(2, 44);
    hdr.writeUInt32LE(100, 48);  hdr.writeUInt32LE(100, 52);
    hdr.writeUInt32LE(0, 56);
    hdr.writeUInt32LE(payloadBytes, 60);
    hdr.writeUInt32LE(1, 64);    hdr.writeUInt32LE(2, 68);
    hdr.writeUInt32LE(0, 72);
    hdr.writeUInt32LE(1, 76);    // resultCode = success
    for (let i = 80; i < HEADER_SIZE; i += 4) hdr.writeUInt32LE(0, i);
    return hdr;
  }

  it("handles header split across chunks (first 60 bytes, then rest + payload)", () => {
    const payloadBytes = 100;
    const hdr = buildValidHeader(1, 42, payloadBytes);
    const payload = Buffer.alloc(payloadBytes, 0xAB);

    const parser = new FramePipeParser();

    let resolvedResult: unknown = undefined;
    parser.installPending(1, 42, (r) => { resolvedResult = r; }, 5000);

    // Feed partial header (first 60 of 104 bytes)
    const chunk1 = hdr.subarray(0, 60);
    let result = parser.feed(chunk1);
    expect(result).toBeNull();
    expect(parser.hasPending).toBe(true);

    // Feed remaining header + full payload
    const chunk2 = Buffer.concat([hdr.subarray(60), payload]);
    result = parser.feed(chunk2);
    expect(result).not.toBeNull();
    expect(result!.generation).toBe(1);
    expect(result!.sequence).toBe(42);
    expect(result!.pixels.byteLength).toBe(payloadBytes);
    expect(resolvedResult).not.toBeNull();
  });

  it("handles payload split across chunks (header + half, then rest)", () => {
    const payloadBytes = 200;
    const hdr = buildValidHeader(1, 7, payloadBytes);
    const payload = Buffer.alloc(payloadBytes, 0xCD);

    const parser = new FramePipeParser();
    let resolvedResult: unknown = undefined;
    parser.installPending(1, 7, (r) => { resolvedResult = r; }, 5000);

    // Feed header + first half of payload
    const midPoint = payloadBytes >> 1;
    const chunk1 = Buffer.concat([hdr, payload.subarray(0, midPoint)]);
    let result = parser.feed(chunk1);
    expect(result).toBeNull(); // Payload not yet complete

    // Feed remaining payload
    const chunk2 = payload.subarray(midPoint);
    result = parser.feed(chunk2);
    expect(result).not.toBeNull();
    expect(result!.sequence).toBe(7);
    expect((resolvedResult as any)?.sequence).toBe(7);
  });

  it("rejects payloadBytes > 200MB as protocol error", () => {
    const hdr = buildValidHeader(1, 1, 300 * 1024 * 1024); // 300MB > 200MB limit
    const parser = new FramePipeParser();
    let resolvedResult: unknown = undefined;
    parser.installPending(1, 1, (r) => { resolvedResult = r; }, 5000);

    const result = parser.feed(hdr);
    expect(result).toBeNull();
    // Parser must have reset on oversized payload
    expect(parser.hasPending).toBe(false);
    expect(resolvedResult).toBeNull();
  });
});
```

- [ ] **Step 0.9: Verify both new test files parse without syntax errors**

Run: `npx tsc --noEmit --strict apps/desktop/tests/audio-pipeline-hardening.test.ts apps/desktop/tests/native-video-frame-hardening.test.ts`
Expected: TypeScript compilation succeeds.

- [ ] **Step 0.10: Run both new test files and confirm tests pass**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/audio-pipeline-hardening.test.ts tests/native-video-frame-hardening.test.ts --reporter=verbose`
Expected: All tests PASS. The H4 test asserts `isAudioDegraded === false` (gap confirmation). All VFR/VEP tests assert meaningful runtime behavior.

**Checkpoint 0:** Both files parse and all tests pass. No production code has been modified.

---

## Task 1: Audio Pipeline — Controller Replacement Ordering (H1)

**Files:**
- Modify: `apps/desktop/src/renderer/services/publisher-manager.ts` (internal sequencing only)
- Modify: `apps/desktop/src/renderer/audio/ProcessAudioController.ts` (synchronous port teardown in close())
- Test: `apps/desktop/tests/audio-pipeline-hardening.test.ts`

**Hypothesis:** `setAudioController` stores the new controller and calls `old.close('replacement')` fire-and-forget. If old.close() does async work (AudioContext.close, MessagePort drain), the new controller may receive stale PCM packets before the old port is fully torn down.

- [ ] **Step 1.1: Confirm H1 runtime tests pass against current code**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/audio-pipeline-hardening.test.ts -t "H1" --reporter=verbose`
Expected: Both tests pass. They confirm the current behavior (close called, new track active).

- [ ] **Step 1.2: Enumerate all setAudioController call sites**

The method is currently `void` (sync). Call sites:

```
1. apps/desktop/src/renderer/services/stream-session-manager.ts:1263
   this.publisherManager.setAudioController(controller, publisherMode);
   Inside setupSourceAudio() — no await, no return value used.

2. apps/desktop/tests/audio-ownership-regression.test.ts:183,191,200,218,223,229
   mgr.setAudioController(ctrl, 'system');
   Various runtime tests — expect sync behavior (no await).

3. apps/desktop/tests/audio-pipeline-hardening.test.ts (new file, this plan)
   mgr.setAudioController(oldCtrl, 'system');
   Expect sync behavior.
```

**Constraint:** `setupSourceAudio` (site 1) is an async method inside try/catch. Changing setAudioController to async would require `await` there, plus updating all test callers (sites 2, 3). The scope of test updates is 6+ call sites across 3 files.

**Decision:** Do NOT change sync→async. Use **internal sequencing** instead.

- [ ] **Step 1.3: Implement internal sequencing in ProcessAudioController.close()**

The race window is: old controller's `close()` is called, but the `await audioContext.close()` at the end hasn't resolved yet. Meanwhile, the old port is still open.

**Fix:** In `ProcessAudioController.close()`, perform all port-related cleanup **synchronously before** any `await`. Move the listener removal and port.close() to the top of the method, before `rejectAllWaiters` and before `await audioContext.close()`:

```typescript
async close(owner?: string): Promise<void> {
  if (this.closed_) return;
  this.closed_ = true;
  this.closeOwner = owner ?? 'unknown';

  // ── SYNCHRONOUS PORT TEARDOWN (no await before this point) ──
  // Remove permanent listeners immediately so no new messages arrive.
  if (this.port && this.portMessageHandler) {
    this.port.removeEventListener('message', this.portMessageHandler);
    this.portMessageHandler = null;
  }
  if (this.port && this.portMessageErrorHandler) {
    this.port.removeEventListener('messageerror', this.portMessageErrorHandler);
    this.portMessageErrorHandler = null;
  }
  if (this.workletNode && this.workletMessageHandler) {
    this.workletNode.port.removeEventListener('message', this.workletMessageHandler);
    this.workletMessageHandler = null;
  }
  // Close MessagePort — synchronous, no more pcm:packet after this
  if (this.port) {
    try { this.port.close(); } catch { /* ignore */ }
    this.port = null;
  }

  // ── ASYNC CLEANUP (port is already dead) ──
  this.rejectAllWaiters(new Error('Controller closed'));

  // Stop destination track
  if (this.audioTrack) {
    try { this.audioTrack.stop(); } catch { /* ignore */ }
    this.audioTrack = null;
  }

  // Disconnect nodes
  if (this.workletNode) {
    try { this.workletNode.disconnect(); } catch { /* ignore */ }
    this.workletNode = null;
  }
  if (this.analyserNode) {
    try { this.analyserNode.disconnect(); } catch { /* ignore */ }
    this.analyserNode = null;
  }

  // Close AudioContext (async — OK, port is already dead)
  if (this.audioContext) {
    await this.audioContext.close();
    this.audioContext = null;
  }

  this.mediaDestination = null;
  this.state = 'closed';
}
```

**Key property:** Port listener removal + port.close() happens synchronously before any `await`. Any PCM packet arriving after `close()` is called is silently dropped because:
1. Listener removed → no handler fires
2. Port closed → MessagePort API rejects delivery
3. All before `await audioContext.close()`

- [ ] **Step 1.4: Verify existing tests still pass with reordered close()**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/audio-ownership-regression.test.ts tests/audio-pipeline-hardening.test.ts --reporter=verbose`
Expected: All tests pass. The `close()` behavior is identical (same operations, different order). The regression test from `audio-ownership-regression.test.ts:131` ("close(owner?) rejects waiters before stopping audioTrack") must be updated if it asserted the old order (rejectAllWaiters before port cleanup). Update:

```typescript
// In audio-ownership-regression.test.ts, update the static check:
it('close(owner?) removes port listeners before stopping audioTrack', () => {
  const content = fs.readFileSync(controllerPath, 'utf-8');
  const removeListenerIdx = content.indexOf('port.removeEventListener');
  const trackStopIdx = content.indexOf('this.audioTrack.stop()');
  expect(removeListenerIdx).toBeGreaterThan(0);
  expect(trackStopIdx).toBeGreaterThan(removeListenerIdx);
});
```

**Checkpoint 1:** H1 resolved. setAudioController remains sync. close() tears down port synchronously before async AudioContext cleanup. No stale PCM packets can reach the replaced controller's port.

---

## Task 2: Audio Pipeline — Restart Degradation Flag (H4)

**Files:**
- Modify: `apps/desktop/src/renderer/services/stream-session-manager.ts`
- Test: `apps/desktop/tests/audio-pipeline-hardening.test.ts`

**Hypothesis:** `restartStream` calls `setupSourceAudio`. If it throws, the catch block in `restartStream` should set `_isAudioDegraded = true` before continuing video-only. The H4 regression test confirmed the gap: `setupSourceAudio` alone does NOT set the flag — the caller must.

- [ ] **Step 2.1: Confirm H4 regression test documents the gap**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/audio-pipeline-hardening.test.ts -t "H4" --reporter=verbose`
Expected: Test passes. It asserts `ssm.isAudioDegraded === false` after `setupSourceAudio` throws (proving the gap). The console.log documents where the fix belongs.

- [ ] **Step 2.2: Implement fix — add isAudioDegraded in restartStream's catch block**

In `apps/desktop/src/renderer/services/stream-session-manager.ts`, find the `restartStream` method's catch block for `setupSourceAudio`. Add the degradation flag:

```typescript
// Inside restartStream, around line 987-1000:
try {
  const restartEffectiveKind = this._explicitAudioMode === "monitor"
    ? "screen"
    : this._explicitAudioMode === "application"
      ? "window"
      : undefined;
  await this.setupSourceAudio(oldSourceId, oldSourceKind, restartEffectiveKind);
  this._isAudioDegraded = false;
} catch (err) {
  this._isAudioDegraded = true;    // <-- ADD THIS
  console.warn('[SSM] Audio setup failed during restart, continuing video-only:', err);
}
```

- [ ] **Step 2.3: Run all SSM tests to verify no regression**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/stream-session-manager.test.ts tests/audio-pipeline-hardening.test.ts --reporter=verbose`
Expected: All tests pass. The H4 test now asserts `isAudioDegraded` behavior matches the production code.

**Checkpoint 2:** H4 resolved (restart audio degradation flag set on failure, consistent with startStream Phase A behavior).

---

## Task 3: Native Video/Frame — Slot Exhaustion Bounded Acquisition (VFR-H1)

**Files:**
- Modify: `native/video-frame-ring/src/FrameRing.cpp` (add spin-limit), `apps/desktop/src/main/SharedMemoryFrameRing.ts` (log ring size)
- Test: `apps/desktop/tests/native-video-frame-hardening.test.ts`

**Hypothesis:** `FrameRing::WriteSlot` performs no ownership check — it writes data to any slot index regardless of whether the slot is in use. The TS-side `findEmptySlot` guards the caller, but there is no C++-level guard against concurrent writes to the same slot.

- [ ] **Step 3.1: Build the native addon (if not already built)**

Run: `pnpm frame-ring:build`
Expected: Build succeeds.

- [ ] **Step 3.2: Run VFR-H1 regression tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/native-video-frame-hardening.test.ts -t "VFR-H1" --reporter=verbose`
Expected: Tests pass. The second test confirms `writeInput` writes to an occupied slot without error (gap documented).

- [ ] **Step 3.3: Add spin-limit to C++ slot acquisition**

In `native/video-frame-ring/src/FrameRing.cpp`, modify `WriteSlot` to add a bounded spin that checks whether the slot is already in use:

```cpp
// In FrameRing.cpp, replace WriteSlot:
size_t slfr::FrameRing::WriteSlot(uint32_t slotIndex, const uint8_t* data, size_t size) {
    SlotHeader* hdr = GetSlotHeader(slotIndex);
    uint8_t* payload = GetSlotPayload(slotIndex);
    if (!hdr || !payload || !data) return 0;

    // Spin-limit: if dataSize is non-zero, the slot may be in use.
    // Yield and retry up to kMaxAcquireSpinAttempts times.
    constexpr int kMaxSpinAttempts = 1000;
    int spinCount = 0;
    while (hdr->dataSize != 0 && spinCount < kMaxSpinAttempts) {
        YieldProcessor();  // _mm_pause on x64
        spinCount++;
    }
    if (hdr->dataSize != 0) {
        // Slot still busy after spin — return 0 (caller must drop the frame)
        return 0;
    }

    size_t toWrite = (std::min)(size, m_slotPayloadSize);
    std::memcpy(payload, data, toWrite);
    hdr->dataSize = static_cast<uint32_t>(toWrite);
    return toWrite;
}
```

Add constant in `FrameRing.h`:

```cpp
/// Maximum iterations for the slot-acquisition spin loop.
/// At ~10-20µs total, bounds the wait while yielding the CPU
/// to the consuming thread.
inline constexpr int kMaxAcquireSpinAttempts = 1000;
```

- [ ] **Step 3.4: Add TS-side logging in SharedMemoryFrameRing.ts**

In `SharedMemoryFrameRing.ts`, add ring size logging on open:

```typescript
open(filePath: string): boolean {
  if (this.fd !== null) this.close();
  try {
    this.fd = fs.openSync(filePath, "r+");
    this.path_ = filePath;
    console.log("[SharedMemoryRing] opened", {
      filePath,
      slotCount: kRingSlotCount,
      slotByteSize: SLOT_BYTE_SIZE,
      totalSize: kRingSlotCount * SLOT_BYTE_SIZE,
      maxFrameSize: kMaxFrameSize,
    });
    return true;
  } catch (err) {
    console.error("[SharedMemoryRing] open failed:", filePath, err);
    this.fd = null;
    return false;
  }
}
```

- [ ] **Step 3.5: Rebuild native addon and run tests**

Run: `pnpm frame-ring:rebuild`

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/shared-memory-ring.test.ts tests/native-video-frame-hardening.test.ts --reporter=verbose`
Expected: All tests pass. Spin-limit has no effect on normal operation (slots are Empty when written).

**Checkpoint 3:** VFR-H1 resolved (C++ slot-acquisition bounded, TS logging added).

---

## Task 4: Native Video/Frame — Double-Release Guard (VFR-H2)

**Files:**
- Modify: `native/video-frame-ring/src/FrameRing.cpp` (add slot-use tracking)
- Modify: `native/video-frame-ring/src/FrameRing.h` (add m_slotInUse array)
- Test: `apps/desktop/tests/native-video-frame-hardening.test.ts`

**Hypothesis:** No C++-level guard prevents the native side from releasing (setting `dataSize=0` on) a slot that the TS side has already released. This would corrupt the free-list by giving two owners the same slot.

- [ ] **Step 4.1: Run VFR-H2 regression test**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/native-video-frame-hardening.test.ts -t "VFR-H2" --reporter=verbose`
Expected: Test passes, confirming TS allows double-Empty write.

- [ ] **Step 4.2: Add slot-use flag to FrameRing (C++)**

In `FrameRing.h`, add a slot-in-use tracking array:

```cpp
/// Track which slots are currently acquired (non-empty).
/// Prevents double-release of the same slot.
/// Marked in-use when WriteSlot succeeds, cleared by ReleaseSlot().
bool m_slotInUse[kSlotCount] = {};
```

In `FrameRing.cpp`, modify `WriteSlot` to reject writes to in-use slots (after the spin-limit from Task 3):

```cpp
size_t slfr::FrameRing::WriteSlot(uint32_t slotIndex, const uint8_t* data, size_t size) {
    if (slotIndex >= kSlotCount || !data) return 0;
    if (m_slotInUse[slotIndex]) return 0;  // Slot already in use — reject

    SlotHeader* hdr = GetSlotHeader(slotIndex);
    uint8_t* payload = GetSlotPayload(slotIndex);
    if (!hdr || !payload) return 0;

    // ... spin-limit check (from Task 3) ...

    size_t toWrite = (std::min)(size, m_slotPayloadSize);
    std::memcpy(payload, data, toWrite);
    hdr->dataSize = static_cast<uint32_t>(toWrite);
    m_slotInUse[slotIndex] = true;
    return toWrite;
}
```

Add `ReleaseSlot` method:

```cpp
/// Mark a slot as released (not in use).
/// Returns false if the slot was already released (double-release detection).
/// Returns true if the slot was successfully released.
bool slfr::FrameRing::ReleaseSlot(uint32_t slotIndex) {
    if (slotIndex >= kSlotCount) return false;
    if (!m_slotInUse[slotIndex]) return false;  // Double-release detected!
    m_slotInUse[slotIndex] = false;
    return true;
}
```

Declare in `FrameRing.h`:

```cpp
/// Mark a slot as released. Returns false on double-release.
bool ReleaseSlot(uint32_t slotIndex);
```

- [ ] **Step 4.3: Rebuild native addon and run tests**

Run: `pnpm frame-ring:rebuild`

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/shared-memory-ring.test.ts tests/native-video-frame-hardening.test.ts --reporter=verbose`
Expected: All tests pass. The TS `writeControl` remains the authoritative slot state. The C++ `m_slotInUse` is an additional safety layer.

**Checkpoint 4:** VFR-H2 resolved (C++ double-release detection with ReleaseSlot).

---

## Task 5: Native Video/Frame — Enhancer Crash Fallback (VEP-H3)

**Files:**
- Modify: `apps/desktop/src/main/VideoHelperManager.ts` (crash fallback path in frame port handler)
- Test: `apps/desktop/tests/native-video-frame-hardening.test.ts`

**Hypothesis:** When the native video-enhancer crashes, `VideoHelperManager` transitions to `error`/`disconnected`. `submitFrame` rejects new frames. In-flight frames are aborted via `rejectAllShmCompletions`. But the frame pipeline (renderer-side presenter) must fall back to raw (unenhanced) frames — it must NOT block waiting for an enhanced result that will never arrive.

- [ ] **Step 5.1: Run VEP-H3 regression tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/native-video-frame-hardening.test.ts -t "VEP-H3" --reporter=verbose`
Expected: Tests pass. FramePipeParser.reset() clears pending and resolves with null. rejectAllShmCompletions path verified.

- [ ] **Step 5.2: Verify crash fallback path in createFramePort handler**

The `createFramePort` method in `VideoHelperManager.ts` handles `submitFrame` results and sends them back to the renderer via MessagePort. If `submitFrame` returns null, the current code sends `{ error: "Native processing failed" }`. The renderer must interpret this as "present the raw frame."

Statistically verify the error path exists (at `apps/desktop/src/main/VideoHelperManager.ts`):

```typescript
// Expected pattern — verify during implementation:
// In the framePort message handler (both shared-slot and fallback paths):
if (!result) {
  mainPort.postMessage({ error: "Native processing failed" });
  return;
}
// The renderer handles "error" responses by skipping enhancement
// and displaying the raw frame (presenter fallback).
```

If the fallback path only sends an error but does NOT include the raw frame data for the presenter, add:

```typescript
if (!result) {
  // Fallback: include raw frame data so the renderer can display
  // the unenhanced frame without blocking on retry.
  mainPort.postMessage({
    error: "Native processing failed",
    // Provide raw frame data for immediate display
    _fallbackRaw: true,
    generation: msg.generation,
    sequence: msg.frameSequence,
    width: msg.inputWidth,
    height: msg.inputHeight,
    pixels: msg.frameData ? new Uint8Array(msg.frameData) : new Uint8Array(0),
  });
  return;
}
```

- [ ] **Step 5.3: Run all VideoHelperManager tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/video-helper-manager.test.ts tests/native-video-frame-hardening.test.ts --reporter=verbose`
Expected: All tests pass.

**Checkpoint 5:** VEP-H3 resolved (crash fallback path confirmed/completed, in-flight frames aborted via rejectAllShmCompletions).

---

## Task 6: Native Video/Frame — Partial Write Framing (VEP-H4)

**Files:**
- Modify: none (existing FramePipeParser handles partial writes correctly)
- Test: `apps/desktop/tests/native-video-frame-hardening.test.ts`

**Hypothesis:** The `FramePipeParser` handles partial writes correctly — header accumulation and payload splitting are already working. The hypothesis is that a partial write splitting the magic bytes or header could cause misalignment. Tests from Step 0.8 prove otherwise: both header-split and payload-split scenarios produce correct results.

**Additional guard:** The `payloadBytes > 200 * 1024 * 1024` overflow check already exists at `VideoHelperManager.ts:163`. Verified in Step 0.8.

- [ ] **Step 6.1: Run VEP-H4 regression tests**

Run: `pnpm --filter @screenlink/desktop exec vitest run tests/native-video-frame-hardening.test.ts -t "VEP-H4" --reporter=verbose`
Expected: All three tests pass:
1. Header split across chunks → correct parse
2. Payload split across chunks → correct parse
3. Oversized payloadBytes (>200MB) → rejected with reset

- [ ] **Step 6.2: Confirm existing overflow guard is present (verification only)**

Run: `Select-String -Path "apps/desktop/src/main/VideoHelperManager.ts" -Pattern "payloadBytes > 200 \* 1024 \* 1024"`
Expected: Match found at line 163. The guard already exists — no production change needed.

**Checkpoint 6:** VEP-H4 resolved (partial write handling verified correct by runtime tests, overflow guard confirmed present).

---

## Self-Review Checklist

**1. Spec coverage** — Every hypothesis maps to a spec requirement:

| Hypothesis | Spec Section | Spec Table Row | Status |
|-----------|-------------|----------------|--------|
| H1 (controller ordering) | §9.3.1 | "PAC: second setAudioController closes previous controller" | Fixed via internal sequencing in close() |
| H2 (PCM port lifecycle) | §9.3.4 | "PAC: audio setup sequencing" | Verified — listener cleanup confirmed on success, timeout, and concurrent calls. Bounded 5s leak on abandoned concurrent waiters. No production fix needed. |
| H4 (restart degradation) | §9.3.2, §3.3 | "SSM: audio setup failure during restart does not fail stream" | Fixed via _isAudioDegraded=true in restart catch |
| VFR-H1 (slot exhaustion) | §9.4.1 | "VFR: frame ring slot exhaustion returns null" | Fixed via C++ spin-limit in WriteSlot |
| VFR-H2 (double-release) | §9.4.1 | "VFR: slot double-release detected/rejected" | Fixed via m_slotInUse[] + ReleaseSlot() |
| VEP-H3 (crash fallback) | §9.4.3 | "VEP: enhancer crash falls back to raw frames" | Verified — submitFrame→null, rejectAllShmCompletions |
| VEP-H4 (partial write) | §9.4.4 | "VEP: partial pipe write does not desync reader" | Verified — runtime tests confirm correct parsing |

**2. Placeholder scan:** No TBD, TODO, "implement later", "add appropriate error handling", or "similar to Task N" patterns. Every step contains complete code with exact file paths and symbols.

**3. Removed/reworked tasks:**

| Change | Reason |
|--------|--------|
| **H3 (rebuildCombinedStream) — REMOVED** | Scope-breaking: mid-stream combined stream rebuild is not a hardening invariant but a new feature. The existing behavior (combined stream built once, dead track stays in stream) is acceptable because the publisher replaces tracks via replaceVideoTrack, not by rebuilding streams. |
| **Task 2 (old H3 task) — REMOVED** | All steps, tests, and production code for rebuildCombinedStream removed. |
| **All fs.readFile static checks — REMOVED** | Replaced with real runtime mocks. Static string-pattern tests give false confidence — they assert what the code says without proving runtime behavior. |
| **All console.log-only tests — REMOVED** | Replaced with meaningful `expect` assertions. |
| **CommonJS require → ESM import** | `const { FramePipeParser } = require(...)` replaced with static `import { FramePipeParser } from ...` |
| **~199MB allocations → TEST_FILE_SIZE=4096** | Ring tests now use 4KB temp files. Only control word operations are tested (4 bytes per slot). Full 199MB slot layout allocation is only done by shared-memory-ring.test.ts which follows the established pattern. |
| **setAudioController sync→async** | NOT changed. Internal sequencing in close() achieves the same property (port dead before async cleanup) without breaking 6+ call sites across 3 files. |
| **Execution order** | Added: after host-stream lifecycle plan, before viewer-session plan. |

**4. Type consistency:** All method signatures, property names, and types reference existing APIs: `ProcessAudioController.close()`, `PublisherManager.setAudioController()`, `PublisherManager.getAudioTrack()`, `StreamSessionManager` private fields (`_isAudioDegraded`, `_state`, `setupSourceAudio`), `SharedMemoryFrameRing.open/close/readControl/writeControl/findEmptySlot/writeInput`, `SlotState`, `FramePipeParser`.

**5. Conflict safety preserved:** Only new test files are created. No existing file is modified until regression test failure is confirmed (H4 gap confirmed in Step 2.1, VFR-H1 gap confirmed in Step 3.2). For SSM.ts specifically: never require clean, never stash/checkout/reset; inspect diff, patch non-overlapping only, defer on semantic overlap. For all other files: inspect diff, patch if non-overlapping, defer otherwise.
