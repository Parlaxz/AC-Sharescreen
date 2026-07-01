# Viewer Lifecycle Ownership Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove stale-session lifecycle races so a single active viewer session owns teardown, callbacks, and visible status.

**Architecture:** Keep `ViewerWorkspace` as the session owner, but replace the destroy-promise handoff with one module-level lifecycle queue, per-effect owned-session cleanup, and callback identity guards. Make the visible overlay derive from local session state plus a separate local error channel so stale Zustand `viewStatus` cannot keep the UI stuck on connecting.

**Tech Stack:** TypeScript, React, Zustand, Vitest.

---

### Task 1: Add regression coverage for ownership and status authority

**Files:**
- Modify: `apps/desktop/tests/viewer-workspace-lifecycle.test.ts`

- [ ] Add a failing regression that asserts the lifecycle code uses a module-level queue helper instead of clearing `_globalDestroyPromise` before awaiting it.
- [ ] Add a failing regression that asserts the viewing effect cleanup destroys only `ownedSession`, not a fresh `sessionRef.current`.
- [ ] Add a failing regression that asserts `onStateChange`, `onPauseStateChange`, `onPosterFrameChange`, `onError`, and start-failure handling all guard on `sessionRef.current === session`.
- [ ] Add a failing regression that asserts `displayStatus` is derived from local `sessionState` and that fatal error detail comes from a dedicated local error state rather than store `viewStatus`.

### Task 2: Fix session ownership and stale-callback rejection

**Files:**
- Modify: `apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx`

- [ ] Replace `_globalDestroyPromise` / `lastDestroyRef` destroy handoff with one module-level lifecycle chain helper.
- [ ] Add start-attempt invalidation so cleanup cancels pending async starts before they can claim ownership.
- [ ] Refactor `startViewerSession` / viewing effect cleanup to capture and destroy only the effect-owned session.
- [ ] Guard all `ViewerSession` callbacks and async start failure paths by session identity before mutating React state or store state.

### Task 3: Make visible status follow the active session only

**Files:**
- Modify: `apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx`

- [ ] Add dedicated local viewer error state.
- [ ] Derive `displayStatus` from `sessionStateToViewStatus(sessionState)` for active viewing.
- [ ] Keep mirrored store `viewStatus` updates only as secondary state for external consumers, without allowing it to override the active overlay.
- [ ] Update fatal error rendering to use the dedicated local error message.

### Task 4: Verify focused regressions

**Files:**
- Modify: `apps/desktop/tests/viewer-workspace-lifecycle.test.ts`

- [ ] Run `pnpm --filter @screenlink/desktop exec vitest run tests/viewer-workspace-lifecycle.test.ts` and confirm the new regressions fail before the code fix and pass after it.
- [ ] Run any follow-up focused viewer lifecycle test reruns needed by the final implementation.
