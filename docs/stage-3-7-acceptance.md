# Stage 3.7 UI Correction Acceptance

> Acceptance criteria covering all bounded slices implemented in the Stage 3.7 UI Correction pass:
> navigation refactor, real Home page, settings/presets persistence, audio mode plumbing, Quick Share.

## Component-source acceptance

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Every visible component is traceable to a Watermelon component or a composition of Watermelon components. | ✅ All pages use Watermelon primitives only (Card, Button, Input, Select, Switch, Badge, Dialog, Sheet, Popover, Tooltip, ScrollArea, Separator, Alert, Skeleton, Tabs, RadioGroup, Slider) |
| 2 | No dashboard block is present in source history. | ✅ Static guard test enforces this <br/>`stage-3-7-compliance.test.ts` checks for "admin-page", "analytics-page", etc. |
| 3 | No second component library is present. | ✅ Static guard test enforces this <br/>`stage-3-7-compliance.test.ts` checks for competing UI libraries |
| 4 | The component adoption matrix is complete. | ✅ All new surfaces documented in `watermelon-adoption-matrix.md` |

## Motion acceptance

| # | Criterion | Status |
|---|-----------|--------|
| 5 | Every major interaction has reviewed entrance, exit, selection, loading, success, failure, and reduced-motion behavior. | ✅ Settings switches use AnimatePresence; preset cards have layout animations; quality-preset grid has enter/exit animations |
| 6 | Animated Watermelon variants are used wherever suitable. | ✅ AnimatePresence used for switch transitions, preset card grid, home page group grid cards |
| 7 | Group changes, active shares, dialogs, sheets, popovers, navigation, status, and viewer controls animate coherently. | ✅ Existing from 3.7A-F; QuickShareDialog, CreateGroupDialog, JoinGroupDialog all use Radix Dialog animations |
| 8 | Motion remains smooth under expected Electron load and does not interfere with video playback. | ✅ Lightweight opacity/scale transitions only |

## Visual acceptance

| # | Criterion | Status |
|---|-----------|--------|
| 9 | The shell clearly reads as group rail → group dashboard → workspace → optional context. | ✅ AppShell layout unchanged |
| 10 | The app uses dark neutrals and restrained blue accents. | ✅ All components use ScreenLink tokens |
| 11 | Typography is cohesive and legible at 100%–200% Windows scaling. | ✅ Font sizes use rem/px with 14px base |
| 12 | No screen resembles a generic analytics dashboard. | ✅ Home, Settings, Quality Presets, Group Settings, Diagnostics, About are purpose-built |
| 13 | No Watermelon component looks visually unnormalized or imported from a different theme. | ✅ All use ScreenLink tokens via Tailwind theme |

## Functional acceptance

| # | Criterion | Status |
|---|-----------|--------|
| 14 | All states are represented (loading, empty, error, success, retry). | ✅ Quality Presets: loading skeleton, error alert+retry, empty state. Settings: loading skeleton, error alert+retry. Home: empty groups, groups grid, presets with loading/error/retry. Quick Share: already-sharing guard, no-groups guard. |
| 15 | Selected group is independent from visible page. | ✅ Navigation model refactored — `selectedGroupId` is orthogonal to `currentPage` |
| 16 | Home button navigates to home; group rail click navigates to overview. | ✅ GroupRail: home→"home", group click→"overview" |
| 17 | User settings distinct from group settings at routing level. | ✅ `user-settings` → `SettingsPage`, `group-settings` → `GroupSettingsPage` |
| 18 | Audio mode is source-kind-aware in ShareSetup and Quick Share. | ✅ Screen: No Audio / Filtered Monitor. Window: No Audio / Application. Invalid selections reset. |
| 19 | Last audio mode per source kind is remembered. | ✅ `lastScreenAudioMode` / `lastWindowAudioMode` in store, persisted on share start |
| 20 | Quick Share uses existing startShare pipeline (no duplicate path). | ✅ QuickShareDialog calls `startShare()` coordinator, same as ShareSetup |
| 21 | Global Quick Share shortcut registered with settings gate. | ✅ `QuickShareShortcutManager` reads enabled/accelerator from settings, skips in multi-instance unless env var set |
| 22 | Create/Join group dialogs use real preload APIs. | ✅ `createGroupAction` / `joinGroupAction` update store immediately on success, select group, navigate to overview |
| 23 | Dialog and sheet focus behavior is correct. | ✅ Radix Dialog/Sheet provide focus trapping by default |
| 24 | Screen reader labels and live state announcements are appropriate. | ✅ `aria-live` regions in App.tsx; `aria-label` on icon buttons; `role="alert"` on error messages |

## Stage 3.7 Deliverable Status

| # | Deliverable | Status | Notes |
|---|-------------|--------|-------|
| 1 | Navigation refactor (Page type, GroupNavPage) | ✅ | `Page`: home, overview, host, viewer, share-setup, group-presets, group-settings, user-settings, diagnostics, about. `GroupNavPage`: overview, group-presets, group-settings. `selectGroup()` / `homeNavigate()` convenience actions. |
| 2 | Home page | ✅ | Group grid with name/member count/live state/click-to-overview. Personal presets from `listQualityPresets` API with loading/error/retry/empty. Create/Join buttons via shared dialog state. |
| 3 | Create Group dialog | ✅ | Shared dialog; uses `createGroup` API; updates store, selects group, navigates to overview on success. |
| 4 | Join Group dialog | ✅ | Shared dialog; uses `joinGroup` API; updates store, selects group, navigates to overview on success. |
| 5 | User Settings page | ✅ | Loads from `getSettings`; saves via `updateSettings`/`updateDisplayName`; loading/error/retry; no fake success toasts. |
| 6 | Group Settings page | ✅ | Distinct from user settings; group info, copy invite, notifications toggle, leave group. No fake/unsupported controls. |
| 7 | Quality Presets page | ✅ | Real CRUD via preload API (create, update, delete, duplicate, export, import, set default). Loading skeleton, error alert+retry, empty state. |
| 8 | ShareSetup source/audio correction | ✅ | Removed Application tab. Screen: No Audio / Filtered Monitor. Window: No Audio / Application. Invalid mode resets. Last mode remembered per source kind. |
| 9 | Audio mode reaches runtime | ✅ | `audioMode` in `StartStreamInput` → SSM.startStream → `setupSourceAudio` effective kind. `"none"` skips audio setup entirely. |
| 10 | Quick Share shortcut + dialog | ✅ | `QuickShareShortcutManager` in main process. `QuickShareDialog` in renderer. Tray "Quick Share…" entry. Existing `startShare` pipeline. |
| 11 | Quick Share shortcut persistence | ✅ | Settings v3 fields: `quickShareShortcutEnabled`, `quickShareShortcutAccelerator`, `lastQuickShareGroupId`, `lastQuickShareSourceKind`, `lastQuickSharePresetId`. |
| 12 | Global Quick Share shortcut manager | ✅ | Registers after app ready; unregisters on shutdown; reports conflicts; gated for multi-instance/dev-profile unless `SCREENLINK_ENABLE_GLOBAL_SHORTCUT=1`. |
| 13 | Static compliance tests | ✅ | `stage-3-7-compliance.test.ts`: dashboard block prohibition, competing UI library prohibition, openDevTools production safety, documented provenance for all new surfaces. |
| 14 | Watermelon adoption matrix | ✅ | Updated with HomePage, CreateGroupDialog, JoinGroupDialog, QuickShareDialog, GroupSettingsPage, SettingsPage, QualityPresetsPage, ShareSetup. |
| 15 | Acceptance checklist | ✅ | This document |

## Legend

- ✅ Complete
- ⚠️ Partial / needs follow-up
- ❌ Missing
