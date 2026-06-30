# Easy Compare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-logical-share dual-variant Easy Compare publishing/viewing with live per-variant updates, dual telemetry, and safe fallback behavior while preserving normal sharing.

**Architecture:** Keep normal `StreamSessionManager` as the existing single-share path, add `CompareSessionManager` as a dedicated compare-mode runtime, and route publication/binding/viewing by exact `mediaSessionId`. Preserve one active-stream announcement by carrying compare metadata for variant B while variant A remains the backward-compatible primary stream.

**Tech Stack:** TypeScript, React, Electron, VDO adapter, existing Watermelon UI, existing metrics/quality/enhancement services.

---

### Task 1: Protocol and transport-safe compare types

**Files:**
- Modify: `packages/shared/src/group-control-messages.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/compare-config.ts`
- Modify: `packages/shared/tests/group-control-messages.test.ts`
- Create: `packages/shared/tests/compare-config.test.ts`

- [ ] Add canonical compare transport types, validation, and parser coverage.
- [ ] Extend `stream.started`, `stream.join.request`, `stream.join.response`, `stream.leave`, `stream.bind.ack`, `viewer.status`, and `viewer.paused` with optional compare/media-session correlation.
- [ ] Add `compare.variant.updated` schema and exports.

### Task 2: Safety fixes for concurrent sessions and exact bindings

**Files:**
- Modify: `apps/desktop/src/renderer/services/viewer-session.ts`
- Modify: `apps/desktop/src/renderer/services/viewer-media-binding.ts`
- Modify: `apps/desktop/src/renderer/services/phase3-runtime.ts`
- Modify: `apps/desktop/tests/viewer-session.test.ts`
- Modify: `apps/desktop/tests/viewer-media-binding.test.ts`

- [ ] Make `ViewerSession` generations instance-local.
- [ ] Make `ViewerMediaBinding` composite-keyed by viewer device + media session with exact cleanup helpers and unique-human counting.
- [ ] Add runtime publication resolver by exact `mediaSessionId`.

### Task 3: Publisher/event/live-setting foundations

**Files:**
- Modify: `apps/desktop/src/renderer/services/publisher-manager.ts`
- Modify: `apps/desktop/src/renderer/services/group-settings-live-apply.ts`
- Modify: `apps/desktop/src/renderer/services/quality-coordinator.ts`
- Create: `apps/desktop/tests/publisher-manager.test.ts`
- Modify: `apps/desktop/tests/group-settings-live-apply.test.ts`

- [ ] Fix pre/post-start peer-disconnect event attachment.
- [ ] Replace misleading quality setter with explicit sender-setting application and reuse across normal/compare live apply.
- [ ] Add coverage for event attachment, multi-sender apply, late-join application, and audio ownership.

### Task 4: Compare host runtime and dual-track pipeline

**Files:**
- Create: `apps/desktop/src/renderer/services/compare-session-manager.ts`
- Create: `apps/desktop/src/renderer/services/compare-variant-track-pipeline.ts`
- Modify: `apps/desktop/src/renderer/services/stream-session-manager.ts`
- Modify: `apps/desktop/src/renderer/services/active-stream-registry.ts`
- Modify: `apps/desktop/src/renderer/services/group-message-router.ts`
- Modify: `apps/desktop/src/renderer/services/viewer-media-binding.ts`
- Create: `apps/desktop/tests/compare-session-manager.test.ts`
- Create: `apps/desktop/tests/compare-variant-track-pipeline.test.ts`

- [ ] Add compare session lifecycle, one shared capture/audio owner, two publishers, one active-stream announcement, one heartbeat, exact cleanup, and variant rebuild behavior.
- [ ] Add dual output-track pipeline with safe independent replacement.
- [ ] Route joins/binds/leaves/resolution to the exact media session.

### Task 5: Compare viewer composition, shortcuts, telemetry, and host UI

**Files:**
- Modify: `apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/viewer/EnhancedVideoSurface.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/viewer/VideoControls.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/viewer/ViewerPanelShell.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/ShareSetup.tsx`
- Modify: `apps/desktop/src/renderer/stores/main-store.ts`
- Modify: `apps/desktop/src/renderer/hooks/use-keyboard-shortcuts.ts`
- Modify: `apps/desktop/src/renderer/services/stream-metrics-service.ts`
- Modify: `apps/desktop/src/renderer/services/media-stats-service.ts`
- Modify: bandwidth graph UI files under `apps/desktop/src/renderer/components/workspace/viewer/`
- Modify: NVIDIA settings/backend files as needed for single-helper validation
- Modify/Add: related viewer/telemetry/UI/NVIDIA tests under `apps/desktop/tests/`

- [ ] Compose dual variant viewer panes that stay mounted across A-only/B-only/split.
- [ ] Add overlays, divider, fullscreen/pause behavior, and compare hotkeys without conflicting with Space/Tab.
- [ ] Extend share setup with Easy Compare controls and per-variant live state.
- [ ] Add dual-series metrics and variant-specific markers.
- [ ] Enforce max one NVIDIA compare variant and remove dev-only hotkey conflict.

### Task 6: Verification, runtime validation, regression repair

**Files:**
- Modify: `.slim/deepwork/easy-compare.md`

- [ ] Run required package tests, typecheck, build, native builds/self-tests, and focused reruns after fixes.
- [ ] Run Alice/Bob(/Charlie) runtime validation flows and capture results.
- [ ] Repair regressions until the full verification matrix is green or a proven external blocker remains.
