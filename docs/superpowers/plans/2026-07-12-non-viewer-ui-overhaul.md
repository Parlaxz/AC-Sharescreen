# ScreenLink Non-Viewer UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every active ScreenLink page except the viewer workspace visually cohesive, accessible, responsive, and functionally reliable.

**Architecture:** Preserve the current Electron/React/Zustand/IPC architecture. Improve the product incrementally: establish shared page composition, repair active page behavior, normalize dialogs/forms, then validate the complete non-viewer surface. `ViewerWorkspace.tsx` and `viewer-workspace-lifecycle.test.ts` are protected concurrent-work files and must not be changed.

**Tech Stack:** React 19, TypeScript, Electron preload IPC, Zustand, Tailwind CSS v4, Radix-based Watermelon components, Motion, Vitest, React Testing Library.

---

## File Structure

- Create `apps/desktop/src/renderer/components/layout/PageHeader.tsx` for shared page title, description, status, and actions.
- Create `apps/desktop/src/renderer/components/layout/PageSection.tsx` for consistent section hierarchy without introducing a new primitive library.
- Create `apps/desktop/src/renderer/components/AppErrorBoundary.tsx` for renderer-level recovery.
- Modify active shell/page/dialog components only under `apps/desktop/src/renderer/components` and `apps/desktop/src/renderer/routes`.
- Add focused tests under `apps/desktop/tests` targeting the active components rather than superseded routes.
- Do not modify `apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx` or `apps/desktop/tests/viewer-workspace-lifecycle.test.ts`.

### Task 1: Baseline and protected-file guard

**Files:**
- Inspect: `apps/desktop/src/renderer/components/workspace/*.tsx`
- Inspect: `apps/desktop/src/renderer/components/layout/*.tsx`
- Inspect: `apps/desktop/src/renderer/routes/HomePage.tsx`
- Inspect: `apps/desktop/src/renderer/routes/About.tsx`

- [ ] Run `git diff -- apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx apps/desktop/tests/viewer-workspace-lifecycle.test.ts` and preserve the output as the protected baseline.
- [ ] Run `pnpm --filter @screenlink/desktop typecheck`; record any pre-existing failures before editing.
- [ ] Run `pnpm --filter @screenlink/desktop test`; record any pre-existing failures before editing.
- [ ] Inventory each active page's actions, async states, empty states, and preload dependencies in the working audit notes.

### Task 2: Shared page composition and renderer recovery

**Files:**
- Create: `apps/desktop/src/renderer/components/layout/PageHeader.tsx`
- Create: `apps/desktop/src/renderer/components/layout/PageSection.tsx`
- Create: `apps/desktop/src/renderer/components/AppErrorBoundary.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Test: `apps/desktop/tests/app-error-boundary.test.tsx`
- Test: `apps/desktop/tests/page-layout-components.test.tsx`

- [ ] Write failing tests proving page headers expose one heading, descriptions remain associated, actions render in a stable container, and render failures show recovery UI.
- [ ] Run `pnpm --filter @screenlink/desktop test -- app-error-boundary.test.tsx page-layout-components.test.tsx`; expect failures because the components do not exist.
- [ ] Implement `PageHeader` with `title`, `description`, optional `eyebrow`, `status`, and `actions` props using ScreenLink tokens and Watermelon composition.
- [ ] Implement `PageSection` with `title`, optional `description`, optional `actions`, and children; avoid nested dashboard-card styling.
- [ ] Implement a class error boundary with concise failure copy, a retry action that clears boundary state, and a return-home action that calls the existing store navigation.
- [ ] Wrap the active page region in `App.tsx` with the boundary while leaving root dialogs and the viewer lifecycle untouched.
- [ ] Re-run the focused tests and expect all to pass.

### Task 3: Shell, navigation, and global dialogs

**Files:**
- Modify: `apps/desktop/src/renderer/components/layout/AppShell.tsx`
- Modify: `apps/desktop/src/renderer/components/layout/TitleBar.tsx`
- Modify: `apps/desktop/src/renderer/components/layout/GroupRail.tsx`
- Modify: `apps/desktop/src/renderer/components/layout/GroupDashboard.tsx`
- Modify: `apps/desktop/src/renderer/components/layout/UserDock.tsx`
- Modify: `apps/desktop/src/renderer/components/layout/ContextPanel.tsx`
- Modify: `apps/desktop/src/renderer/components/CommandPalette.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/CreateGroupDialog.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/JoinGroupDialog.tsx`
- Test: `apps/desktop/tests/active-shell-navigation.test.tsx`
- Test: `apps/desktop/tests/group-dialogs-active.test.tsx`

- [ ] Write failing tests for selected navigation state, accessible icon buttons, dialog submit/cancel behavior, duplicate-submit prevention, and visible async errors.
- [ ] Run the two focused test files and confirm the new assertions fail.
- [ ] Normalize shell spacing, selected states, tooltips, status text, overflow behavior, and compact-width handling using existing tokens.
- [ ] Ensure create/join actions disable while pending, retain user input on recoverable failure, close only after success, and expose errors with `role="alert"`.
- [ ] Verify command palette items navigate and close, and that unavailable actions communicate why they are disabled.
- [ ] Run focused tests and expect all to pass.

### Task 4: Home, Group Overview, and Host Dashboard

**Files:**
- Modify: `apps/desktop/src/renderer/routes/HomePage.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/GroupOverview.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/HostDashboard.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/BandwidthGraphModal.tsx`
- Test: `apps/desktop/tests/home-page-active.test.tsx`
- Test: `apps/desktop/tests/group-overview-active.test.tsx`
- Test: `apps/desktop/tests/host-dashboard-active.test.tsx`

- [ ] Write failing tests for actionable no-group/no-stream states, share initiation, host stop/pause/settings controls, viewer count/status, loading skeletons, and bandwidth modal semantics.
- [ ] Run the three focused tests and confirm failures identify the missing states.
- [ ] Apply `PageHeader` and `PageSection`; prioritize one primary action per state and replace plain loading text with stable skeleton composition.
- [ ] Preserve existing host and group business logic while adding pending/disabled/error feedback around async controls.
- [ ] Make dense technical metrics scannable with mono numeric values and plain-language labels without creating analytics-dashboard blocks.
- [ ] Run focused tests and expect all to pass.

### Task 5: Share Setup and Quick Share

**Files:**
- Modify: `apps/desktop/src/renderer/components/workspace/ShareSetup.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/QuickShareDialog.tsx`
- Test: `apps/desktop/tests/share-setup-active.test.tsx`
- Test: `apps/desktop/tests/quick-share-dialog-active.test.tsx`

- [ ] Write failing tests for source loading/failure/empty states, source selection, audio mode, preset selection, start-share pending state, retry, cancel, and keyboard-safe dialog behavior.
- [ ] Run focused tests and confirm they fail on the unhandled states.
- [ ] Align both flows around the same step hierarchy and terminology while preserving each trigger and existing coordinator calls.
- [ ] Disable start until required input is valid, block duplicate starts, show actionable source/API errors, and preserve selections after recoverable failures.
- [ ] Ensure scroll containment and footer actions remain reachable in compact-height windows.
- [ ] Run focused tests and expect all to pass.

### Task 6: User Settings, Group Settings, and Quality Presets

**Files:**
- Modify: `apps/desktop/src/renderer/components/workspace/SettingsPage.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/GroupSettingsPage.tsx`
- Modify: `apps/desktop/src/renderer/components/workspace/QualityPresetsPage.tsx`
- Test: `apps/desktop/tests/settings-page-active.test.tsx`
- Test: `apps/desktop/tests/group-settings-page-active.test.tsx`
- Test: `apps/desktop/tests/quality-presets-page-active.test.tsx`

- [ ] Write failing tests for initial loading, API failure/retry, dirty state, save success/failure, validation, destructive confirmation, preset create/edit/delete, and default-preset behavior.
- [ ] Run focused tests and confirm the assertions fail where active pages lack coverage.
- [ ] Organize settings into predictable sections with concise help text, stable labels, and a persistent save-status pattern.
- [ ] Prevent accidental loss by making dirty state visible and keeping values after failed saves.
- [ ] Give destructive group and preset actions explicit confirmation and ensure pending operations cannot be repeated.
- [ ] Keep advanced technical settings visually secondary but discoverable; preserve all existing schema and IPC field names.
- [ ] Run focused tests and expect all to pass.

### Task 7: Diagnostics and About

**Files:**
- Modify: `apps/desktop/src/renderer/components/workspace/DiagnosticsPage.tsx`
- Modify: `apps/desktop/src/renderer/routes/About.tsx`
- Reference: `apps/desktop/src/renderer/routes/Diagnostics.tsx`
- Reference: `apps/desktop/src/preload/api-types.ts`
- Test: `apps/desktop/tests/diagnostics-page-active.test.tsx`
- Test: `apps/desktop/tests/about-page-active.test.tsx`

- [ ] Write failing tests proving Diagnostics reads real app information from `window.screenlink`, handles API absence/failure, copies or exports diagnostics with feedback, and never displays hardcoded fake log entries.
- [ ] Run focused tests and confirm failures against the current placeholder state.
- [ ] Port only the verified real-IPC behavior from the superseded diagnostics route into the active page, matching current preload type signatures.
- [ ] Present runtime, media, and system health as readable sections with clear healthy/warning/error states and meaningful empty capture history.
- [ ] Normalize About page hierarchy, version/build presentation, external-link semantics, and update entry points using existing APIs.
- [ ] Run focused tests and expect all to pass.

### Task 8: Accessibility and responsive audit fixes

**Files:**
- Modify: active files touched in Tasks 2-7 only
- Test: `apps/desktop/tests/non-viewer-accessibility.test.tsx`

- [ ] Add failing checks for duplicate/missing headings, unnamed icon controls, dialog labels, alert/status regions, focus restoration, and clipped action regions.
- [ ] Run the accessibility-focused test and confirm failures.
- [ ] Fix semantics and keyboard behavior with existing Radix/Watermelon primitives; do not introduce a second library.
- [ ] Review compact desktop layout at approximately 1024×700 and large layout at 1600×1000 using an isolated browser/Electron target when available.
- [ ] Correct overflow, wrapping, action placement, and minimum sizing without changing the viewer page.
- [ ] Re-run accessibility tests and expect all to pass.

### Task 9: Full verification and regression guard

**Files:**
- Verify: all changed files
- Protect: `apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx`
- Protect: `apps/desktop/tests/viewer-workspace-lifecycle.test.ts`

- [ ] Run `pnpm --filter @screenlink/desktop typecheck`; expect exit code 0.
- [ ] Run `pnpm --filter @screenlink/desktop test`; expect all tests to pass.
- [ ] Run `pnpm --filter @screenlink/desktop build`; expect renderer, main, and preload builds to succeed.
- [ ] Run `git diff --check`; expect no whitespace errors.
- [ ] Compare protected viewer-file diffs to the Task 1 baseline and confirm this work introduced no changes.
- [ ] Review changed UI against `apps/desktop/docs/UI_GUARDRAILS.md`: Watermelon composition, ScreenLink tokens, 4px spacing, approved radii, reduced motion, and no dashboard blocks.
- [ ] Perform a final code-quality review for unnecessary duplication, stale branches, inconsistent copy, missing failures, and untested active behavior.

## Execution Notes

- Do not commit unless the user explicitly requests it.
- Keep writer ownership non-overlapping: shell/shared composition first, then page groups in parallel only after shared APIs stabilize.
- Browser validation must use an isolated target or wait until the Playwright instance used by other agents is free.
