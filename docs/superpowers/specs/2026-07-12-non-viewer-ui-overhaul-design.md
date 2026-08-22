# ScreenLink Non-Viewer UI Overhaul

## Scope

Improve every active renderer page and global dialog except the viewer workspace. Preserve the current Electron, React, Zustand, IPC, and media-runtime architecture. Do not modify `ViewerWorkspace.tsx` or its lifecycle test because they contain concurrent work.

The active surface includes Home, Group Overview, Host Dashboard, Share Setup, Quality Presets, Group Settings, User Settings, Diagnostics, About, the application shell, and root-level dialogs. Legacy superseded routes are not redesign targets.

## Success Criteria

- Every visible non-viewer page has consistent hierarchy, spacing, typography, controls, and feedback.
- Navigation and all primary page actions work through the existing store and preload APIs.
- Loading, empty, error, disabled, success, and destructive states are explicit and actionable.
- Keyboard focus, labels, live feedback, contrast, reduced motion, and compact desktop layouts are handled.
- Active components receive focused functional tests; typecheck, tests, and production build pass.
- No second component library, new routing system, or unrelated runtime refactor is introduced.

## Chosen Approach

Use a system-first incremental overhaul. First standardize reusable page composition and shared interaction patterns with existing Watermelon primitives and ScreenLink tokens. Then improve each active page and dialog while preserving its existing business logic. Finally repair verified functional defects and add tests around active components.

This is safer than a full rewrite and more coherent than isolated cosmetic patches.

## Visual Direction

ScreenLink should feel like a focused professional desktop utility rather than an analytics dashboard. Pages use a restrained dark palette, compact controls, strong information hierarchy, and limited purposeful motion. Primary actions remain obvious without turning every section into a competing card.

Common composition:

1. A concise page header with title, contextual description, status, and primary action when relevant.
2. A readable content column with grouped sections and stable spacing.
3. Consistent interactive states using existing Watermelon components.
4. Technical values in Geist Mono; all other interface text in Instrument Sans.
5. ScreenLink color, radius, and spacing tokens only.

## Functional Design

- Preserve Zustand page switching and existing IPC boundaries.
- Replace Diagnostics placeholder information with real preload data and clear unavailable states.
- Add an application error boundary that offers a safe recovery path instead of a blank renderer.
- Verify shell navigation, tray/preload event navigation, host controls, settings persistence, group actions, preset CRUD, source selection, and dialog close/cancel flows.
- Prevent duplicate submissions, communicate async progress, surface errors near the triggering action, and preserve user input on recoverable failures.
- Keep viewer-specific rendering and lifecycle behavior unchanged.

## Page Priorities

1. Shared shell and composition primitives.
2. Host Dashboard and Group Overview because they carry the main product workflow.
3. Share Setup and Quick Share because they gate successful sharing.
4. User Settings, Group Settings, and Quality Presets because they contain dense forms and persistence behavior.
5. Diagnostics, Home, About, command palette, and group dialogs.

## Accessibility and Responsive Behavior

- Maintain visible focus states and logical tab order.
- Use native or Radix semantics for controls and dialogs.
- Ensure icon-only actions have accessible names and useful tooltips.
- Use status and alert semantics for asynchronous feedback.
- Keep touch/click targets practical for desktop use and avoid controls that become clipped at compact window sizes.
- Respect the existing reduced-motion policy.

## Error Handling

Page-level async operations distinguish initial loading, refresh, empty results, recoverable errors, and unavailable Electron APIs. Errors provide a retry or next step where possible. Destructive actions require explicit confirmation when loss is meaningful. The app-level error boundary handles unexpected render failures without masking operation-specific errors.

## Testing

- Add focused React Testing Library coverage for active workspace components and dialogs.
- Test success, failure, disabled, and empty states for critical actions.
- Verify navigation and preload-event behavior without altering viewer lifecycle tests.
- Run renderer/main/preload typecheck, focused tests during implementation, the full Vitest suite, and production build.
- Perform UI review at compact and large desktop dimensions without competing for the Playwright instance currently used by other agents; use an isolated browser target or defer browser automation until available.

## Non-Goals

- Viewer workspace redesign or viewer lifecycle changes.
- Authentication, accounts, or onboarding systems that do not exist in the product.
- Replacing Zustand navigation with a router.
- Removing legacy files unless required to fix an active build or test conflict.
- Broad media pipeline or IPC protocol refactors.
