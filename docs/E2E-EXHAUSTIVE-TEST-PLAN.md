# ScreenLink Exhaustive End-to-End Test Plan

## Handoff purpose

This is the implementation plan for a real end-to-end test program for ScreenLink. It is intentionally broader than unit, component, or mocked IPC tests.

The test program must drive the real Windows Electron application through its UI and verify the real network, WebRTC media, native helpers, persistence, teardown, and packaged installer behavior.

The handoff is complete only when another agent can use this document to implement and run the suite without inventing missing requirements.

## Definition of exhaustive

An exhaustive pass must cover:

- Real Electron windows, not only `audit.html` or a browser-rendered React tree.
- Real UI interactions for creating, joining, sharing, watching, leaving, restarting, and quitting.
- At least three independent app identities: Alice (host), Bob (viewer), and Charlie (second viewer/reconnect actor).
- A same-machine multi-instance pass and a two-physical-Windows-machine pass.
- Real screen capture using a visible deterministic fixture window.
- Real audio capture when the machine supports it; an explicit unsupported-audio pass when it does not.
- Actual signaling/WebRTC negotiation through the configured VDO service.
- Assertions on both user-visible state and underlying evidence: media readiness, advancing frames, RTP/audio statistics, group membership, connection state, logs, and process cleanup.
- Clean-profile, persisted-profile, restart, reconnect, failure, and packaged-installer passes.
- Screenshots, logs, console errors, process snapshots, and timing data for every failure.

The existing `scripts/e2e-full-flow.mjs` is only a starting smoke flow. It currently covers launch, Alice create, Bob join, invite capture, and basic peer presence. It is not an exhaustive suite and must not be treated as one.

## Repository baseline

Relevant existing entry points and infrastructure:

- Root scripts: `package.json:7-43`
  - `pnpm build`, `pnpm build:installer`, `pnpm typecheck`, `pnpm test:all`
  - `pnpm desktop:dev:alice`, `desktop:dev:bob`, `desktop:dev:charlie`, `desktop:dev:all`
  - Native helper build/self-test/transport commands.
- Desktop scripts: `apps/desktop/package.json:7-15`
  - Vite/Electron dev, build, packaging, typecheck, and Vitest.
- Existing real-Electron bootstrap: `scripts/e2e-harness.mjs`
  - Currently uses fixed CDP ports and raw CDP evaluation.
- Existing partial scenario: `scripts/e2e-full-flow.mjs`
  - Currently only covers the initial Alice/Bob group flow.
- Existing browser audit: `apps/desktop/audit-renderer.mjs`
  - Useful for layout/console checks, but it runs a normal Chromium audit page and an audit shim, not real Electron/media/network behavior.
- Profile/multi-instance behavior: `apps/desktop/src/main/app-lifecycle.ts`
  - `--dev-profile=<name>` and `--multi-instance` are development/test capabilities.
- Development launcher: `scripts/dev-launcher.ps1`
  - Shared Vite server and known Alice/Bob CDP ports.
- Three-instance launcher: `apps/desktop/scripts/launch-three-dev.ps1`.

The current working tree also contains uncommitted experimental E2E scripts and product fixes. The implementing agent must inspect `git status` first, preserve unrelated work, and keep the E2E implementation separately reviewable.

## Product surface under test

The suite must map every scenario to the actual implementation rather than relying on guessed labels.

### Application and main-process paths

- Startup/single-instance/profile behavior: `apps/desktop/src/main/main.ts`, `app-lifecycle.ts`, `window-manager.ts`.
- Custom protocol and packaged loading: `protocol.ts`.
- IPC/preload boundary: `ipc-handlers.ts`, `apps/desktop/src/preload/index.ts`, `api-types.ts`.
- Capture enumeration and permission flow: `capture-source-manager.ts`, `display-media-handler.ts`, `permissions.ts`.
- Fullscreen suppression: `fullscreen-detector.ts`.
- Tray/close/quit behavior: `tray-manager.ts`, `main.ts`.
- Settings, secure storage, updates, and login startup: `settings-store.ts`, `secure-store.ts`, `update-manager.ts`, `update-ipc.ts`, `login-item-manager.ts`.
- Native audio: `AudioHelperManager.ts`, `ControlClient.ts`, `audio-protocol.ts`, `PcmBridge.ts`, `BinaryPcmParser.ts`, `native/audio-helper`.
- Native video: `VideoHelperManager.ts`, `video-enhancer-protocol.ts`, `SharedMemoryFrameRing.ts`, `native/video-enhancer`, `native/video-frame-ring`.

### Group and membership paths

- Group UI: `GroupsWorkspace.tsx`, `CreateGroupDialog.tsx`, `JoinGroupDialog.tsx`, `InviteDialog.tsx`, `GroupOverview.tsx`, `GroupSettingsPage.tsx`, `MembersList.tsx`.
- Group persistence/API: `group-store.ts`, `group-actions.ts`, `group-record-helper.ts`, `group-sync-service.ts`.
- Invite encoding/decoding: `packages/shared/src/group-link.ts`.
- Connection and recovery: `group-connection-manager.ts`, `group-control-connection.ts`, `connection-supervisor.ts`, `phase3-runtime.ts`.
- Message and stream control: `group-message-router.ts`, `active-stream-registry.ts`, `stream-announcer.ts`.
- Leave/rejection behavior: `group-leave-action.ts`, `join-rejection.ts`.
- Shortcuts: `group-shortcut-manager.ts`, `group-shortcut-service.ts`, `quick-share-shortcut-manager.ts`.

### Sharing and viewer paths

- Share setup: `ShareSetup.tsx`, `share-coordinator.ts`, `share-quality.ts`, `publisher-manager.ts`, `stream-session-manager.ts`.
- Host controls and viewer rows: `HostDashboard.tsx`.
- Active share cards and watch entry point: `GroupOverview.tsx`, `group-navigation.ts`.
- Viewer lifecycle: `ViewerWorkspace.tsx`, `viewer-session.ts`, `viewer-session-controller.ts`, `viewer-sender-controller.ts`, `viewer-media-binding.ts`.
- Viewer controls/settings: `viewer/VideoControls.tsx`, `ViewerSettingsPanel.tsx`, `QualityPopover.tsx`, `ViewerStatusOverlay.tsx`, `StreamSwitcher.tsx`.
- Diagnostics/telemetry: `DiagnosticsPanel.tsx`, `stream-metrics-service.ts`, `media-stats-service.ts`, `connection-supervisor.ts`.
- GPU/image processing: `EnhancedVideoSurface.tsx`, `CompareViewerSurface.tsx`, `viewer-image-processing`, `nvidia-benchmark-service.ts`.
- Notification/toast flow: `notification-watcher.ts`, `stream-toast-manager.ts`, `App.tsx` IPC wiring.

## Required test architecture

### Runner

Implement one formal E2E runner with a single command and machine-readable results. Prefer Playwright Test with Electron/CDP support. If dependency policy prevents that, harden the existing raw-CDP harness behind the same runner interface.

The runner must provide:

- `launchAgent(name, profile, cdpPort, userDataDir)`.
- `connectAgent(name)` and health checks.
- Semantic locators based on `data-testid`, role, accessible name, and labels. Do not use brittle `startsWith(innerText)` selectors as the final implementation.
- `click`, `fill`, `select`, keyboard, clipboard, file, and OS-level interaction helpers.
- `waitForUi`, `waitForGroupState`, `waitForStreamState`, `waitForMedia`, and `waitForProcessState` helpers with diagnostic timeout output.
- Per-test cleanup in `finally`, including child process trees and native helper processes.
- Retries only for infrastructure setup. Product assertion failures must not be silently retried into a pass.
- Test tags: `smoke`, `local-mesh`, `two-machine`, `media`, `audio`, `native`, `packaged`, `resilience`, `security`, `accessibility`, `soak`.

### Stable test hooks

Before writing most scenarios, add stable, production-safe test hooks:

- `data-testid` values for navigation, dialogs, group cards, member rows, share controls, viewer controls, toast actions, settings fields, diagnostics sections, and error states.
- A test-only diagnostics bridge that exposes read-only snapshots of group connection, active streams, viewer state, and helper health. It must not bypass authentication, group control, capture permission, or WebRTC negotiation.
- A test-only way to identify the deterministic fixture source by title/fingerprint, while still selecting it through the real source picker.
- Explicit lifecycle events or log markers for app-ready, group-connected, share-started, share-stopped, viewer-joined, viewer-watching, viewer-reconnecting, and quit-complete.

### Agent model

Every agent has:

- Unique profile and user-data directory.
- Stable display name and device identity.
- Dedicated CDP/debug port.
- Separate main-process log, renderer console log, helper stdout/stderr, and artifact directory.

Use these roles by default:

- Alice: creates the group and hosts the source.
- Bob: joins, receives notifications, and watches.
- Charlie: second viewer, churn/reconnect/kick actor.
- Invalid/temporary agent: optional fourth profile for malformed-link and unauthorized-join checks.

For two-machine runs, run the same agent controller on each PC and synchronize through a small authenticated test coordinator. Do not transfer secrets through ad-hoc clipboard or unlogged shell commands.

### Deterministic media fixture

Create a visible fixture window that:

- Shows a high-contrast frame counter, timestamp, color bars, and a unique agent label.
- Changes frames continuously so a viewer can prove that media is advancing rather than merely attached.
- Emits a deterministic audio tone or spoken marker when audio capture is enabled.
- Can be launched, moved, minimized, restored, and closed by the test runner.

The share test must select this fixture through the real Screen/Window source UI. It must not mock `getDisplayMedia`, inject a fake `MediaStream`, or mark a session as watching without decoded media.

### Artifacts

For each test and agent, retain:

- Start/end timestamps and result.
- Screenshot at every phase boundary and on failure.
- Full-page/window screenshot for toast and fullscreen cases.
- Renderer console, uncaught exception, unhandled rejection, failed request, and CDP protocol logs.
- Main-process and native-helper logs.
- Process tree before launch, during share, after stop, and after quit.
- Group/stream/viewer state snapshots.
- WebRTC `getStats()` snapshots at join, steady state, pause, reconnect, and stop.
- Audio frame/level evidence when audio is enabled.
- Video frame evidence: `readyState`, dimensions, current time, frame callback count, and frame counter progression.
- Installer version, commit SHA, OS build, GPU/codec capabilities, display layout, and network profile.

## Test phases and exit gates

### Phase 0: Environment and build gate

Run before any UI test:

1. `pnpm install --frozen-lockfile`.
2. `pnpm typecheck`.
3. `pnpm build`.
4. `pnpm audio-helper:check`.
5. `pnpm video-enhancer:check`.
6. `pnpm frame-ring:check` where the target machine supports the Electron native build.
7. `pnpm test:all` and `pnpm audio-helper:transport-test`.
8. Verify the expected helper binaries exist and match the app version.
9. Verify the configured VDO signaling endpoint is reachable.
10. Verify Windows capture permission, microphone/loopback permission, firewall rules, and at least one visible screen and window source.

Failure of this phase is an environment failure, not a reason to mark product E2E green.

### Phase 1: Single-agent lifecycle smoke

Run against a clean profile and a persisted profile:

- Launch to the expected Home/Groups UI with no protocol 404, blank shell, or renderer exception.
- Navigate Home, Groups, Quality Presets, Settings, Diagnostics, About, and back.
- Open/close the tray and minimize/restore the window.
- Confirm only the expected ScreenLink process and helpers exist.
- Close the window using the normal close action and confirm the documented tray/quit behavior.
- Use Quit Completely and confirm the Electron process, audio helper, video helper, and child watchdog processes all exit.
- Relaunch and confirm persisted identity/settings load without stale UI or duplicate connections.

### Phase 2: Group creation and management

Required scenarios:

| ID | Flow | Required assertions |
|---|---|---|
| GRP-001 | Create a named group | Group is persisted, selected, overview opens, one control connection is created, and the invite link is copied exactly. |
| GRP-002 | Create with blank/whitespace name | Default group naming is documented and stable; no malformed record is created. |
| GRP-003 | Create with Unicode, punctuation, and long name | UI renders safely, invite remains parseable, and no layout/IPC error occurs. |
| GRP-004 | Copy invite from overview/invite dialog | Clipboard content parses with `parseGroupInviteLink` and contains the expected group identity. |
| GRP-005 | Open/close create, join, invite, and settings dialogs repeatedly | No stale fields, duplicate requests, stuck loading state, or leaked listeners. |
| GRP-006 | Join valid invite through UI | Joined record persists, group overview opens, and Alice receives the new member. |
| GRP-007 | Join via deep link/custom protocol | Protocol route reaches the join flow and never produces packaged `Not Found`. |
| GRP-008 | Join empty, malformed, wrong-secret, expired, and unsupported links | Actionable error is shown; no partial group or connection remains. |
| GRP-009 | Join the same group twice | Operation is idempotent or clearly rejected; no duplicate group rows or connections. |
| GRP-010 | Leave group with cancel and confirm | Cancel preserves membership; confirm removes the record, closes connections, clears streams, and updates both peers. |
| GRP-011 | Leave while disconnected or while a share/view is active | Cleanup completes or reports a bounded error; no orphaned stream/session/helper remains. |
| GRP-012 | Group settings | Notifications, quick-share source, default preset, quick-share shortcut, and quick-join shortcut save and persist after restart. |
| GRP-013 | Invalid shortcut and duplicate shortcut | Validation rejects invalid combinations and prevents accidental duplicate global registrations. |
| GRP-014 | Multiple groups | Group selection, navigation, active streams, and membership remain isolated per group. |

### Phase 3: Membership, mesh, and synchronization

- Alice/Bob/Charlie join the same group and each sees the other two exactly once.
- Verify authenticated hello/control connection state, member records, display names, online/offline transitions, join/leave sounds/notifications, and timestamps.
- Restart one agent while the other two remain online. Confirm reconnection, membership resync, and no duplicate connections.
- Kill the renderer, main process, and helper separately and verify recovery behavior.
- Delay or drop the initial control connection. Confirm bounded retries and eventual recovery rather than permanent `failed` state.
- Remove a group during connection polling. Confirm no late connection start or state resurrection.
- Verify group sync persistence after all agents restart.
- Verify stream announcements are scoped to the correct group and cannot leak across groups.
- Verify stale heartbeats expire a stream, explicit stops create tombstones, and a stopped stream does not resurrect after reconnect.

### Phase 4: Host sharing

For every source kind supported by the current OS, run the real flow:

1. Open Share Setup from the group overview.
2. Enumerate Screen, Window, and Application tabs as supported.
3. Select the deterministic fixture source through the visible source cards.
4. Exercise audio modes `none`, monitor/system audio, and application audio where available.
5. Exercise default quality, each personal preset, and custom quality validation.
6. Start sharing and verify the host dashboard.

Assertions:

- Source cards show current sources and refresh correctly when a window is opened/closed.
- Selection survives source polling and does not select a stale source.
- Invalid quality fields cannot start a share.
- Start has one in-flight request and produces one active media session.
- Group announcement contains the correct group, host, source, logical stream, and media session IDs.
- Host dashboard shows live duration, viewer count, source, current state, and no fake metrics.
- `getDisplayMedia` is fulfilled by the approved source selected through the real picker path.
- Native audio helper starts only when required and reports a valid hello/protocol response.
- Stop confirmation works; cancel leaves the share active; confirm broadcasts a stop and tears down publisher/audio/helper state.
- Restart share produces a new media session and viewers recover according to the documented behavior.
- Switch source changes the selected source while preserving the supported viewer lifecycle.
- Preview, Share again/last-settings, and “no source” error flows work.
- Host shutdown during active sharing ends the share and leaves no process or stream tombstone leak.

### Phase 5: Stream notification and toast

Run on Bob while Alice starts, restarts, and stops sharing:

- New remote stream produces exactly one toast with correct host/group/source data.
- Heartbeats and duplicate announcements do not produce duplicate toasts.
- A changed media session produces a new toast.
- Local streams never notify the local host.
- Unknown or unauthenticated host IDs are rejected.
- Notifications disabled globally or per group suppress the toast without suppressing the stream.
- Fullscreen foreground window suppresses the toast and records the suppression reason.
- Exiting fullscreen allows a later stream/restart to notify.
- Toast is correctly anchored on the active monitor, including multi-monitor layouts and display changes.
- Join/Watch action routes to the correct group/stream only.
- Spoofed IPC sender, malformed payload, XSS-like host name, and expired/deduped action are rejected safely.
- Auto-dismiss destroys the toast window and leaves no hidden Electron window.

### Phase 6: Viewer join and real media

For Bob and then Bob+Charlie:

- Bob opens the active share card and clicks Watch.
- Viewer state progresses through connecting, requesting/accepted, connecting-media, and watching.
- Video element has non-zero dimensions and `readyState >= 3`.
- Video frame callbacks or equivalent frame counter prove frames advance for at least 30 seconds.
- Fixture frame counter observed by Bob advances monotonically.
- WebRTC stats show received video bytes/frames and a negotiated codec.
- Audio element/track is present when enabled; stats show audio packets/bytes and a non-zero level or deterministic audio evidence.
- Viewer can leave/exit and returns to the group overview without stopping Alice’s share.
- Bob’s reconnect/retry action works after a delayed host or delayed signaling path.
- Viewer receives an intentional host stop and exits to the correct ended state.
- Viewer receives a failed join and shows a bounded, actionable error with Retry and Exit behavior.
- Bob and Charlie can watch the same stream concurrently; each has independent state and stats.
- Alice sees both viewers in HostDashboard with correct state, bitrate/quality request data, and viewer count.
- Alice can kick Bob; Bob loses media and exits/reports the kicked state, while Charlie remains connected.

### Phase 7: Viewer controls and advanced media behavior

Exercise every visible control in `VideoControls.tsx`, `ViewerSettingsPanel.tsx`, and related viewer components:

- Play/pause local playback.
- Pause/resume the stream when the feature is supported by the host/control protocol.
- Mute/unmute and volume slider boundaries.
- Discord mute/deafen actions with configured and invalid shortcuts.
- Alt+Tab/window switching action.
- Stream info overlay toggle and every configured field: resolution, FPS, bitrate, dropped frames, network usage, visibility, font/size/opacity/color.
- Stream switcher with multiple active streams and group isolation.
- Diagnostics panel open/close, copy summary, detailed video/audio/connection/codec/quality sections, and open-folder action.
- Viewer settings quality request: preset, resolution, FPS, bitrate, codec/content hint, degradation preference; verify the host receives and applies/rejects it.
- Server-side quality limits prevent invalid/out-of-range requests.
- Fullscreen enter/exit and keyboard escape.
- A/B compare mode and keyboard bindings where enabled.
- GPU image enhancement enable/disable, backend selection, scaler selection, sharpening/noise/compression/debanding values, reset, and persistence.
- NVIDIA capability unavailable, available, benchmark success, benchmark cancel, benchmark failure, export, and recommendation paths.
- Viewer controls auto-hide, keyboard focus, reduced motion, and recovery after panels are opened during reconnect.

### Phase 8: Quality presets and settings

- Create, edit, duplicate, select, clear, and persist personal quality presets.
- Invalid preset values are rejected with no partial save.
- Presets appear in Share Setup and per-group Quick Share defaults.
- Settings page persistence for display name, launch-at-login, auto-resume, notifications, host quality limits, viewer quality requests, default codec, compare controls, Quick Share, Discord controls, stream-info-card fields, and update state.
- Restart and verify every saved setting is restored and applied to the next share/view.
- Test popup uses the real IPC/toast path.
- Settings save failure leaves the prior value and shows an actionable error.

### Phase 9: Shortcuts, quick actions, and deep links

- Configure and clear global Quick Share and Quick Join shortcuts.
- Trigger Quick Share with the configured shortcut and verify the correct group/source/preset.
- Trigger Quick Join with the configured shortcut and verify the selected group.
- Shortcut activation while the app is minimized, in another window, sharing, viewing, or disconnected.
- Shortcut registration failure and conflict handling.
- Deep-link create/join/share routes with valid and invalid URLs.
- Confirm shortcut/deep-link actions cannot select another group or stream through untrusted IDs.

### Phase 10: Diagnostics, history, updates, and support surfaces

- Diagnostics route opens without renderer errors and displays current health.
- Log reader opens available logs, handles missing/rotated/unreadable logs, and does not expose secrets.
- Stream history records start/stop/view events, remains group-scoped, and persists after restart.
- Bandwidth graph/modal opens and updates while media is active.
- About/version surfaces match package/build/helper versions.
- Update available, downloading, installing, error, and no-update states using a controlled test update endpoint or test doubles only at the updater boundary.
- Support/report action opens the expected URL with no secret query data.

### Phase 11: Error, security, and abuse cases

- Malformed IPC payloads for every public preload action.
- Spoofed IPC sender and wrong-window action.
- Invalid group IDs, stream IDs, device IDs, media session IDs, and viewer IDs.
- Unauthorized join/request/kick/quality messages.
- Replay or duplicate control messages.
- XSS payloads in group names, display names, source names, invite text, and stream metadata.
- Clipboard content containing extra text, whitespace, newline, or an unrelated URL.
- Network timeout, signaling outage, malformed helper hello, helper startup timeout, helper crash, corrupted PCM, missing native binary, and unsupported GPU.
- Renderer crash/reload while sharing and while viewing.
- No test may accept a silent failure, infinite spinner, unhandled rejection, or leaked child process as a pass.

### Phase 12: Persistence, restart, and upgrade

- Clean install first launch.
- Relaunch after creating groups, configuring settings, and saving presets.
- Restart during group connect, share setup, active host share, viewer join, steady watching, reconnect, and stop.
- Upgrade from the prior released version with existing groups/settings/history.
- Downgrade/invalid version handling if supported by the release process.
- Verify persisted secrets are not copied into logs or artifacts.
- Verify old/stale state cannot resurrect stopped streams or duplicate group connections.

### Phase 13: Packaging and process hygiene

- Build the Windows installer with `pnpm build:installer`.
- Install into a clean user profile and run the installed binary, not the source Electron executable.
- Repeat the critical create/join/share/watch/stop/leave/quit path against the packaged app.
- Verify custom protocol loading in packaged mode, helper paths, resources, icons, version consistency, and writeable log locations.
- Verify a second packaged launch follows single-instance behavior.
- Verify Quit Completely terminates Electron, audio helper, video helper, frame-ring/native children, and watchdogs within a bounded timeout.
- After every scenario, scan the process tree and named pipes for leftovers.
- Run the packaged smoke path on Windows 10 and Windows 11 where available.

## Failure and resilience matrix

Each critical happy path must have the following perturbations:

1. Signaling delayed before connect.
2. Signaling disconnected after membership is established.
3. Host renderer reload.
4. Viewer renderer reload.
5. Host process termination.
6. Viewer process termination.
7. Audio helper termination.
8. Video helper termination.
9. Source window closed or renamed during setup.
10. Display/fullscreen state changes during notification.
11. One peer leaves during another peer’s join.
12. Share stopped and restarted rapidly.
13. Three viewers join/leave repeatedly.
14. Five-minute steady-state share and viewer soak.
15. Thirty-minute reconnect/churn soak with bounded memory/process counts.

Use a controlled network tool or Windows firewall test profile for network impairment. Every impairment must be logged and restored in cleanup.

## Required commands and run modes

The implementation agent must add a documented command such as:

```text
pnpm e2e:preflight
pnpm e2e:local -- --project=critical
pnpm e2e:two-machine -- --coordinator=<url>
pnpm e2e:packaged -- --installer=<path>
pnpm e2e:soak -- --minutes=30
```

The existing commands remain useful prerequisites:

```text
pnpm typecheck
pnpm build
pnpm test:all
pnpm audio-helper:transport-test
pnpm audio-helper:check
pnpm video-enhancer:check
pnpm build:installer
```

The runner must print a summary grouped by test ID and tag, and write JSON/JUnit output for CI or hand review.

## Acceptance criteria

Do not report “exhaustive E2E passed” until all of the following are true:

- Every matrix item has an automated test or an explicitly documented manual-only reason and procedure.
- The critical path passes on a clean local multi-instance run at least three consecutive times.
- The critical path passes on two physical Windows machines at least three consecutive times.
- The packaged critical path passes on a clean install.
- Real video frames advance and real audio evidence is present for supported audio modes.
- Reconnect, stop, restart, leave, and quit cases pass without orphan processes or stale state.
- No unhandled renderer/main/native errors occur.
- No known flaky test is silently retried into green; flakes are fixed or listed as blocking failures.
- All artifacts are available for failed tests and include enough evidence to reproduce the failure.
- A final report lists pass/fail/blocked for every test ID, OS/build/GPU/network environment, and unresolved defects.

## Implementation order for the next agent

1. Inspect `git status`; isolate the E2E work and preserve existing uncommitted product changes.
2. Add stable selectors, diagnostics snapshots, lifecycle markers, and cleanup hooks.
3. Replace the current fixed-port/raw-text harness with the formal runner and fixture-window app.
4. Implement Phase 0 and Phase 1 first; make startup/cleanup reliable before adding media.
5. Implement GRP/MESH flows with Alice, Bob, and Charlie.
6. Implement real source selection, host sharing, viewer playback, and WebRTC evidence.
7. Add notification, controls, quality, settings, shortcuts, diagnostics, and security matrices.
8. Add fault injection, restart, soak, packaged, and two-machine execution.
9. Run the complete matrix, fix product defects discovered by the tests, and rerun from clean profiles.
10. Produce the final evidence report. Do not commit or release product fixes until separately approved.

## Explicit non-goals

- Calling a large Vitest suite “E2E” because it exercises a service with mocks.
- Marking a viewer as successful because a card or route appeared; media must be proven.
- Bypassing the real capture picker, group authentication, or WebRTC negotiation.
- Treating the browser audit page as a substitute for Electron/main/native testing.
- Ignoring helper processes because the main window closed.
- Hiding flaky tests behind broad retries.
