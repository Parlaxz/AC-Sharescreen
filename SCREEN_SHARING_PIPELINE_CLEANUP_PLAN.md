# Screen-Sharing Pipeline Overengineering Audit and Cleanup Plan

## Scope

This document audits the host capture/publication path, viewer lifecycle, group-control transport, stream discovery, viewer binding, quality application, telemetry, persisted settings, and viewer UI. Findings are based on direct source inspection.

Confidence labels:

- **Confirmed**: directly demonstrated by current source.
- **High-confidence risk**: an asynchronous or state-divergence path is present, but runtime timing determines whether it manifests.
- **Cleanup smell**: unnecessary or obsolete complexity with a clear deletion or consolidation path.

## Executive summary

The pipeline does not have one authoritative host session, viewer session, connection-health model, quality model, or telemetry model. Instead, state is copied among large service classes, Zustand, React state, registries, SDK wrappers, and two independent network planes. Recovery is mostly implemented as local retries and reconciliation patches around those copies.

The cleanup should converge on five owners:

1. `HostShareSession`: capture, publication, source switching, and teardown.
2. `ViewerSessionController`: one viewer lifecycle and one immutable UI snapshot.
3. `ConnectionSupervisor`: combined control/media health and automatic recovery.
4. `ViewerSenderController`: the only code allowed to mutate an exact viewer sender.
5. `TelemetryService`: the only `getStats()` polling and history implementation.

Do not begin by splitting files mechanically. First establish these ownership boundaries and characterization tests, then remove obsolete paths.

---

## Overengineering inventory

### O-01 — `Phase3Runtime` is a service locator, lifecycle manager, store adapter, refresh controller, and notification coordinator

**Status:** Confirmed  
**Source:** `apps/desktop/src/renderer/services/phase3-runtime.ts:37-563`, singleton lifecycle at `:565-705`

It constructs and exposes nearly every service, wires callbacks into Zustand, handles notifications, manages identity, performs refresh, coordinates initialization/destruction, and provides publication lookup. Most services reach back through runtime getters, creating circular knowledge rather than explicit dependencies.

### O-02 — The host lifecycle is split across three state machines

**Status:** Confirmed  
**Sources:**

- `stream-session-manager.ts:81-1465`
- `publisher-manager.ts:67-787`
- `main-store.ts:74-130`

`StreamSessionManager`, `PublisherManager`, and Zustand each represent starting/sharing/stopping/error independently. `share-coordinator.ts` manually mirrors service results into the store. These states can disagree.

### O-03 — `StreamSessionManager` mixes too many responsibilities

**Status:** Confirmed  
**Source:** `stream-session-manager.ts:81-1465`

It owns capture, source approval assumptions, quality precedence, native audio setup, VDO credentials, publisher construction, SDK event wiring, registry updates, lifecycle messages, heartbeat/re-announcement timers, metrics history, source switching, restart, stop, and destruction.

### O-04 — `ViewerSession` mixes protocol, SDK, DOM playback, pause, retries, metrics, and recovery

**Status:** Confirmed  
**Source:** `viewer-session.ts:123-1853`

It owns join/bind protocol, `ViewerClient`, video-element attachment, poster capture, pause/resume transactions, stream identity refresh, status reporting, self-view, teardown, and retry policy. Comments and guards document multiple historical races rather than a small enforceable lifecycle.

### O-05 — `ViewerWorkspace` is a second viewer-session controller inside a 2,820-line component

**Status:** Confirmed  
**Source:** `components/workspace/ViewerWorkspace.tsx:1-2820`

It creates/destroys `ViewerSession`, mirrors its state into React and Zustand, serializes lifecycle work, applies quality requests, persists requests, manages telemetry history, detects stream endings, owns enhancement/compare behavior, and renders the UI.

### O-06 — Viewer lifecycle has at least three sources of truth

**Status:** Confirmed  
**Sources:**

- `viewer-session.ts:124-251`
- `ViewerWorkspace.tsx:922-1038`
- `main-store.ts:98-113`

`ViewerSession._state`, React `sessionState/viewStatus/pause/error` state, and Zustand `isViewing/viewStatus/watchingTarget` describe the same lifecycle and are synchronized through callbacks and effects.

### O-07 — Viewer target identity is copied into several representations

**Status:** Confirmed  
**Sources:**

- `viewer-session.ts:197-218`
- `main-store.ts:103-113,173-187`
- `ViewerWorkspace.tsx:1845-1896,2094-2095`
- `active-stream-registry.ts:41-414`

The same group, host, logical stream, and media session exist in the registry, Zustand `watchingTarget`, `watchedStreamsBySessionId`, `ViewerWorkspace` derived state/refs, and `ViewerSession` fields.

### O-08 — A complete dead viewer architecture remains in production source

**Status:** Confirmed cleanup smell  
**Source:** `watched-stream-manager.ts:1-324`; tests in `tests/watched-stream-manager.test.ts`

`WatchedStreamManager` has no production construction or import. Production creates `ViewerSession` directly in `ViewerWorkspace.tsx:962`.

### O-09 — `ViewerMediaBinding` is a 2,121-line multi-domain manager

**Status:** Confirmed  
**Source:** `viewer-media-binding.ts:149-2121`

It owns authorization tokens, join responses, SDK connection lookup, mapping identity, sender resolution, retries, quality reconciliation, pause state, media mode, telemetry pollers, viewer presence, audio cues, and cleanup.

### O-10 — Exact composite mapping and legacy first-match mapping coexist

**Status:** Confirmed  
**Source:** `viewer-media-binding.ts:1419-1521,1584-1646`

New APIs key mappings by viewer and media session. Legacy APIs return the first mapping for a device or skip removal when multiple mappings exist. `group-message-router.ts:787-799` still falls back to the ambiguous legacy lookup.

### O-11 — Compare-mode assumptions remain in host mapping despite compare being viewer-only

**Status:** Confirmed cleanup smell  
**Sources:**

- `phase3-runtime.ts:425-462`
- `viewer-media-binding.ts:578-609,1419-1425`

Runtime states that comparison is viewer-only, but host mapping still preserves multiple media sessions per device for compare mode and retains legacy ambiguity to support both models.

### O-12 — Pause, media-mode, quality, group settings, and publisher setup all mutate sender parameters

**Status:** Confirmed  
**Sources:**

- `quality-coordinator.ts:90-127,483-548`
- `viewer-media-binding.ts:990-1344,1361-1415`
- `group-settings-live-apply.ts:47-114`
- `publisher-manager.ts:459-551,728-777`

There is no serialized sender command owner. Multiple code paths read, modify, and call `setParameters()`, so stale reads and last-writer-wins behavior are inherent.

### O-13 — Resume quality logic is duplicated

**Status:** Confirmed  
**Source:** `viewer-media-binding.ts:1034-1168` and `:1228-1344`

`applyResume` and `applyResumeWithQuality` independently restore active encodings, recalculate effective quality, mutate sender parameters, read back configuration, and send feedback.

### O-14 — Quality precedence is duplicated across host start, restart, source switch, coordinator, router, and UI

**Status:** Confirmed  
**Sources:**

- `stream-session-manager.ts:352-377,663-670,938-957`
- `share-coordinator.ts:177-190`
- `viewer-media-binding.ts:821-856,1063-1101,1254-1302`
- `group-message-router.ts:695-748,818-868`

Each path independently combines session overrides, group defaults, host limits, viewer requests, source dimensions, and hardcoded fallbacks.

### O-15 — Quality has too many authorities and representations

**Status:** Confirmed  
**Sources:** `quality-coordinator.ts`, `group-sync-service.ts`, `share-quality.ts`, `ViewerWorkspace.tsx:1870-2070`

The pipeline separately stores group defaults, per-session overrides, viewer requests, accepted requests, host limits, effective values, configured readback, and observed telemetry. There is no single versioned quality snapshot joining them.

### O-16 — Revision/idempotency machinery exists but is not used by production routing

**Status:** Confirmed cleanup smell  
**Source:** `quality-coordinator.ts:219-289`

`decideViewerRequest()` and `acceptedRequests` implement stale/idempotent/conflict semantics, but production routing calls `handleViewerRequest()` directly at `group-message-router.ts:636-657`. The extra state does not protect the live path.

### O-17 — `QualityCoordinator` stores the same accepted request twice plus an index

**Status:** Confirmed  
**Source:** `quality-coordinator.ts:147-166,252-310`

`viewerRequests`, `acceptedRequests`, and `streamViewerIndex` must remain synchronized. For current usage, one record keyed by exact viewer stream identity is sufficient.

### O-18 — A dead live-apply abstraction remains beside the active quality paths

**Status:** Confirmed cleanup smell  
**Source:** `group-settings-live-apply.ts:1-115`

`GroupSettingsLiveApply` has no production construction/import. Its direct group-default sender mutation would also bypass per-viewer overrides if reintroduced.

### O-19 — Two active telemetry systems poll the same peer connections

**Status:** Confirmed  
**Sources:**

- `media-stats-service.ts:110-306`
- `stream-metrics-service.ts:254-719`
- bindings at `viewer-media-binding.ts:619-633,749-770`

`MediaStatsPoller` runs per-viewer polling every two seconds while `StreamMetricsService` runs centralized polling every second. `MediaStatsPoller` also retains a second legacy SDK poller.

### O-20 — Viewer status is another periodic telemetry projection

**Status:** Confirmed  
**Source:** `viewer-session.ts:1668-1751`

Every viewer sends a two-second status message derived from `StreamMetricsService`; the host then maintains another diagnostics view. This is reasonable as transport, but currently forms another state owner instead of a projection with explicit freshness.

### O-21 — `GroupMessageRouter` is a protocol router plus UI event bus and store writer

**Status:** Confirmed  
**Source:** `group-message-router.ts:73-1055`

It validates/routs protocol messages, owns pending request promises, performs quality policy/application, writes viewer count into Zustand, plays UI sounds, emits browser `CustomEvent`s, and handles ping timestamps.

### O-22 — Browser `CustomEvent`s form an untyped second application bus

**Status:** Confirmed  
**Sources:**

- `group-message-router.ts:383-467,753-775`
- `hooks/use-keyboard-shortcuts.ts:58-216`

Protocol results are converted into global DOM events and then back into component state. This bypasses TypeScript ownership and lifecycle guarantees.

### O-23 — Control connectivity and media connectivity are independent with no combined health state

**Status:** Confirmed  
**Sources:**

- `group-control-connection.ts:155-880`
- `packages/vdo-adapter/src/viewer-client.ts:19-726`
- `viewer-session.ts:1332-1456`

Controls may fail while media continues, or media may freeze while control remains connected. The UI only receives partial state and has no supervisor combining both planes.

### O-24 — Recovery is scattered across SDK retries, generation counters, polling, bounded retries, and manual refresh

**Status:** Confirmed  
**Sources:**

- `viewer-session.ts:136-210,680-700,845-942,1420-1452`
- `viewer-media-binding.ts:660-711`
- `group-connection-manager.ts:193-270`
- `phase3-runtime.ts:506-562`

Each layer attempts local recovery, but no owner decides when a whole viewer session is healthy, degraded, reconnecting, or unrecoverable.

### O-25 — `ensureConnected()` polls despite having connection-state callbacks and contradicts its contract

**Status:** Confirmed  
**Source:** `group-connection-manager.ts:181-270`

Its comments say idle/failed initiates one restart. The implementation rejects immediately for idle and defines unused callback helpers before polling every 200 ms.

### O-26 — Lifecycle delivery has a bespoke in-memory queue with contradictory stop semantics

**Status:** Confirmed  
**Source:** `group-connection-manager.ts:273-500`

The queue deduplicates starts/restarts/stops, expires entries, flushes globally and per-peer, and special-cases standalone stops. This complexity currently causes a real stop-delivery bug documented below.

### O-27 — Stream discovery is represented by both session state and a second mutable registry

**Status:** Confirmed  
**Sources:**

- `stream-session-manager.ts:295-311,507-510`
- `active-stream-registry.ts:41-414`

The local host session is authoritative, but it also writes an announcement into `ActiveStreamRegistry`, which then emits another copy to Zustand.

### O-28 — `ActiveStreamRegistry` has duplicate local and remote mutation paths

**Status:** Confirmed  
**Source:** `active-stream-registry.ts:82-132,264-286`

`handleStarted()` and `registerLocalStream()` both create/update entries and heartbeat state with subtly different tombstone/replacement behavior.

### O-29 — Restart has a second obsolete implementation that can fabricate remote sessions

**Status:** Confirmed cleanup smell with dangerous behavior  
**Source:** `restart-coordinator.ts:320-370`

`restartHostStreams()` is unused in production. For a remote host it generates a random media session ID and broadcasts `stream.restarted` without restarting that host’s publication.

### O-30 — Restart comments reference the dead viewer manager

**Status:** Confirmed cleanup smell  
**Source:** `restart-coordinator.ts:35-49`

The documented recovery architecture still says `WatchedStreamManager` reconnects viewers, but production uses `ViewerSession`.

### O-31 — Store fields/actions exist without a live writer

**Status:** Confirmed cleanup smell  
**Source:** `main-store.ts:113,128-130,160-164,227,234-235,300-303`

Examples include `localStreamSession`; `isSwitchingSource` is read by `HostDashboard` but its store action has no production caller while `StreamSessionManager` owns a separate private switch flag. `watchedStreamsBySessionId` overlaps `watchingTarget` and the registry.

### O-32 — Core domain and settings types are duplicated across boundaries

**Status:** Confirmed  
**Sources:**

- `StreamAnnouncement`: `active-stream-registry.ts:1-28` and `main-store.ts:47-59`
- `PersistedSettings`: `main/settings-store.ts:12-128` and `preload/api-types.ts:464-565`
- `StartShareInput`: `share-quality.ts:210-221` and `share-coordinator.ts:15-24`
- `ShortcutBinding`: main settings, preload API, and `VideoControls.tsx:638-643`

The duplicated `StreamAnnouncement` types already differ in fields. The duplicated settings contract is also missing some main-process quick-share fields in preload.

### O-33 — Defaults are repeated in the main settings store, settings form, store initial state, and quality helpers

**Status:** Confirmed  
**Sources:**

- `main/settings-store.ts:150-204`
- `SettingsPage.tsx:72-111`
- `main-store.ts:197-237`
- `share-quality.ts:14-23`

Changing a default requires synchronized edits across process and UI boundaries.

### O-34 — Adapter host/viewer wrappers duplicate lifecycle utilities

**Status:** Confirmed cleanup smell  
**Sources:**

- `packages/vdo-adapter/src/host-publisher.ts:6-16,127-171,232-252`
- `packages/vdo-adapter/src/viewer-client.ts:7-17,192-243,705-725`

Timeout and codec-preference traversal logic are duplicated. Viewer shutdown also mutates several guessed private SDK reconnect properties at `viewer-client.ts:473-492`, signaling a leaky abstraction.

### O-35 — Backward-compatibility paths remain inside current critical flows

**Status:** Confirmed cleanup smell  
**Examples:**

- Legacy `startShareLegacy`: `share-coordinator.ts:210-224`
- Legacy mapping getters/removal: `viewer-media-binding.ts:1419-1646`
- Password and stream-ID fallbacks: `viewer-session.ts:1361-1375`
- Test-only fake `MediaStream`: `viewer-session.ts:1280-1286`

Compatibility behavior should be isolated at boundaries, not mixed into lifecycle code.

### O-36 — Best-effort catches hide lifecycle failures

**Status:** Confirmed  
**Examples:**

- `stream-session-manager.ts:831-834`
- `share-coordinator.ts:255-265`
- `phase3-runtime.ts:119-121`
- `viewer-session.ts:1046-1051,1770-1793`

Cleanup and delivery failures frequently become silent success states, making state divergence difficult to detect and impossible for UI recovery policy to use.

### O-37 — Historical “Stage/Gate/Phase” implementations remain layered rather than replaced

**Status:** Confirmed cleanup smell  
**Sources:** pervasive comments and parallel implementations in quality, mapping, stats, restart, and viewer lifecycle services.

The issue is not comment style itself. The source preserves old and new paths together: legacy poller plus new telemetry, legacy first-match mapping plus exact mapping, legacy restart plus distributed restart, and dead watched-stream/live-apply services.

---

## Bug inventory

### User-reported bugs

| ID | Symptom | Causal cluster | Current evidence |
|---|---|---|---|
| B-01 | Pausing freezes the latest frame but bandwidth continues | Split local pause/control transaction plus competing sender mutations | Local element pauses before host acknowledgement at `viewer-session.ts:302-370`; sender disable occurs separately at `viewer-media-binding.ts:990-1031`. |
| B-02 | Client refresh/retry button does not work reliably | Fragmented viewer lifecycle/recovery | `ViewerWorkspace.tsx:1024-1038` starts `session.retry()` with `void`, so rejection/completion is not owned by the handler; retry then crosses runtime refresh, registry replacement, teardown, and join. |
| B-03 | Screenshot shows `Pending apply: mapping missing` | Quality request can precede or outlive exact media binding | Produced at `group-message-router.ts:636-679,787-868`; mapping only exists after `viewer-media-binding.ts:514-651`. Ambiguous legacy fallback can select the wrong mapping. |
| B-04 | Settings alternate between preset and requested settings | Multiple quality authorities and uncoordinated sender writers | Group defaults, viewer requests, resume, and live apply use separate paths; see O-12 through O-18. |
| B-05 | After the viewer’s internet drops, media may continue while features stop; no automatic refresh | No combined control/media health supervisor | `viewer-session.ts:1338-1351` treats ended tracks as terminal; automatic retry is limited to initial connect failures at `:1420-1452`. |
| B-06 | UI says bitrate applied but bandwidth does not increase | Requested/effective/configured/observed values are separate and later sender writes can overwrite the value | `ViewerWorkspace.tsx:1870-2070`, `quality-coordinator.ts:373-535`, and multiple writers in O-12. |
| B-07 | A/B testing button should be optional and hidden by default | Isolated missing preference, not architectural | Button is rendered whenever callback exists at `VideoControls.tsx:554-572`; no persisted visibility field exists. |
| B-08 | Frame-rate slider sometimes has no effect | FPS is separately constrained, encoded, clamped, and displayed without closed-loop readback | Capture uses `ideal` and swallows rejection at `stream-session-manager.ts:1331-1371`; sender FPS has multiple writers. |

### Additional confirmed bugs found during the audit

| ID | Bug | Evidence |
|---|---|---|
| B-09 | Normal stop and destroy orphan display-capture video tracks | `PublisherManager.stopCapture()` explicitly leaves video ownership to SSM at `publisher-manager.ts:689-699`; `resetSessionState()` nulls `captureStream` without stopping tracks at `stream-session-manager.ts:1374-1381`. |
| B-10 | Failed startup can also orphan capture tracks and active metrics history | Startup catch calls only `cleanupPublisher()` at `stream-session-manager.ts:511-517`; host metrics starts before capture/publish at `:378-384`. |
| B-11 | Restart creates a new host metrics session without finalizing the old one | New session starts at `stream-session-manager.ts:958-963`; the old history is not finalized in the restart preamble at `:862-872`. |
| B-12 | A queued standalone `stream.stopped` message is discarded on reconnect | Stop removes pending start/restart at `group-connection-manager.ts:475-480`; flush then drops a stop with no pending start at `:342-357` and `:411-420`. A previously delivered start can therefore remain visible until expiry. |
| B-13 | `startStream()` can report success without starting anything | It silently returns in the wrong state at `stream-session-manager.ts:325-327`; `share-coordinator.ts:159-198` then updates the store as though the requested share started. |
| B-14 | Source switch and stop can race | `switchSource()` checks lifecycle after source approval but not after `getDisplayMedia()` or `replaceVideoTrack()` at `stream-session-manager.ts:616-655`; teardown can null/stop publisher state concurrently. |
| B-15 | Publisher track replacement and stop can race across an awaited SDK operation | `publisher-manager.ts:626-658` checks fields before awaiting replacement; `stopCapture()` can clear the same fields at `:661-712`. |
| B-16 | Offline cleanup can leave stale viewer mappings when a device has multiple mappings | Runtime calls `removeViewer(deviceId)` at `phase3-runtime.ts:183-200`; removal intentionally skips multiple mappings at `viewer-media-binding.ts:1626-1645`. |
| B-17 | `isSwitchingSource` UI protection is disconnected from the real switch state | Host UI reads the Zustand field; no production caller invokes `setSwitchingSource`, while SSM has its own private flag. |
| B-18 | Legacy remote restart path can announce nonexistent media credentials | `restart-coordinator.ts:340-364` fabricates a new media session for a remote host without restarting publication. It is currently unused and should be deleted before accidental reuse. |

### Previously suggested findings rejected after direct verification

- `PublisherManager` does **not** double-register `peerDisconnected` in the two normal registration orders; `_peerDisconnectedAttached` guards those paths.
- A replacement-session tombstone bug was not established. Current tombstones are keyed by logical stream identity, so the previously suggested fix would also block the legitimate replacement.

---

## Target architecture

### Host session

`HostShareSession` owns exactly one capture stream and publication:

```text
idle -> starting -> active -> switching | restarting -> stopping -> idle
                                   \-> failed
```

Rules:

- Every transition is serialized through one operation queue.
- The session owns and always stops capture tracks.
- Start returns a typed result; a no-op cannot be mistaken for success.
- Registry/store state is a projection of the session snapshot, never independently mutated by UI code.
- Restart reuses logical identity, replaces media identity, and closes/finalizes the prior publication before opening the next.

### Viewer session

`ViewerSessionController` owns one immutable snapshot:

```ts
interface ViewerSessionSnapshot {
  phase: "idle" | "connecting" | "watching" | "paused" | "reconnecting" | "ended" | "error";
  target: StreamTarget | null;
  controlHealth: "up" | "down" | "recovering";
  mediaHealth: "up" | "stalled" | "down" | "recovering";
  pause: "playing" | "pausing" | "paused" | "resuming";
  error: string | null;
}
```

React subscribes to this snapshot. It does not mirror the state machine into additional lifecycle variables.

### Exact viewer binding

Use one exact key everywhere:

```ts
type ViewerBindingId = {
  viewerDeviceId: string;
  viewerSessionId: string;
  mediaSessionId: string;
};
```

Remove all first-match getters and removers. A command without an exact binding ID is rejected explicitly.

### Sender controller

Only `ViewerSenderController` may call `RTCRtpSender.setParameters()`.

It receives desired state:

```ts
interface DesiredSenderState {
  paused: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  quality: EffectiveQuality;
  revision: number;
}
```

It serializes writes per binding, applies one complete parameter snapshot, reads it back, and emits `requested/effective/configured/observed` together.

### Connection supervisor

One supervisor consumes both control and media events. It detects:

- control disconnected while media remains active;
- media stalled while control remains active;
- both disconnected;
- reconnected SDK with stale binding;
- host publication replacement.

It owns bounded exponential backoff and invokes one full rejoin path when necessary.

### Telemetry

One service polls each exact peer connection once. UI diagnostics, bandwidth display, viewer status, and history are projections of the same samples.

---

## Phased implementation plan

### Phase 0 — Characterize behavior before changing ownership

1. Add deterministic fake peer connections and controllable deferred promises.
2. Add tests for every B-01 through B-18 reproduction that can be automated.
3. Add event traces containing operation ID, viewer binding ID, logical stream ID, media session ID, desired sender revision, and actual sender revision.
4. Record current runtime wiring for every service marked dead before deletion.

**Exit criteria:** each confirmed defect has a failing test or an explicitly documented manual-only reproduction.

### Phase 1 — Fix resource and lifecycle correctness first

1. Make capture ownership explicit in `HostShareSession`/SSM cleanup.
2. Stop all capture tracks on normal stop, destroy, failed start, failed restart, and cancelled source switch.
3. Finalize metrics sessions on every terminal path and before restart replacement.
4. Change `startStream`, `switchSource`, `restartStream`, `stopStream`, and `destroy` to typed, serialized operations.
5. Make destroy asynchronous and await it from runtime destruction.
6. Repair lifecycle queue semantics: a stop for a previously announced stream must be deliverable independently.
7. Await client retry in the UI and surface failure from the same operation.

**Fixes:** B-02, B-09 through B-15.  
**Exit criteria:** no live tracks, publisher, timers, metrics sessions, or queued lifecycle work remain after any terminal path.

### Phase 2 — Delete obsolete and dangerous paths

1. Delete `watched-stream-manager.ts` and its tests.
2. Delete unused `GroupSettingsLiveApply` if runtime wiring remains absent.
3. Delete `RestartCoordinator.restartHostStreams()` and update stale comments.
4. Delete the legacy `MediaStatsPoller.start()` SDK poller.
5. Remove `acceptedRequests/decideViewerRequest` or wire one simplified revision record into the actual route; do not retain unused policy.
6. Remove `localStreamSession`, redundant watched-stream state, and disconnected store actions.
7. Remove legacy mapping getters/removers after converting all callers to exact IDs.
8. Remove unused helpers such as `ViewerSession.resetViewerReady()`.

**Fixes/prevents:** B-03, B-16 through B-18.  
**Exit criteria:** one production viewer implementation, one restart implementation, one mapping API, and no source file kept solely for historical Gate/Stage compatibility.

### Phase 3 — Establish canonical domain contracts

1. Move `StreamAnnouncement`, `PersistedSettings`, `ShortcutBinding`, `StartShareInput`, and quality contracts to shared boundary modules.
2. Generate or import preload/main types from the same definitions.
3. Move defaults into one shared configuration factory.
4. Introduce `StreamTarget`, `ViewerBindingId`, `HostSessionSnapshot`, and `ViewerSessionSnapshot`.
5. Make Zustand store only serializable UI projections; remove service-owned resource representations.

**Exit criteria:** no duplicated domain interfaces or fallback constants across main/preload/renderer.

### Phase 4 — Collapse viewer state ownership

1. Move lifecycle serialization, retry, stream-end detection, target refresh, and connection recovery into `ViewerSessionController`.
2. Replace React lifecycle state variables with one subscribed snapshot.
3. Remove `targetRef`, `startAttemptRef`, module-level lifecycle promise, and duplicate end-detection branches from `ViewerWorkspace` once the controller owns them.
4. Split `ViewerWorkspace` into presentation components only: stage, controls, panels, enhancement surface, and overlays.
5. Replace global quality/pause DOM events with typed controller subscriptions.

**Fixes:** B-02, B-05.  
**Exit criteria:** React cannot independently place the session into connecting/watching/ended; it can only issue commands and render snapshots.

### Phase 5 — Build combined connection recovery

1. Feed group-control state, SDK signaling state, peer-connection state, data-channel state, track liveness, and byte-progress timestamps into `ConnectionSupervisor`.
2. Detect a stalled media stream even when no `ended` event fires.
3. On recoverable loss: enter `reconnecting`, refresh announcement identity without clearing valid registry state, create a new viewer attempt, join, bind, and restore desired pause/media/quality state.
4. Use bounded exponential backoff with cancellation on exit.
5. Distinguish intentional host stop from connectivity loss.
6. Make manual Refresh invoke the same supervisor recovery operation and return an awaited result.

**Fixes:** B-02, B-05.  
**Exit criteria:** temporary loss of either network plane self-recovers; manual refresh is deterministic and reports success/failure.

### Phase 6 — Replace quality arbitration and sender mutations

1. Implement one pure `resolveEffectiveQuality()` using group defaults, optional session override, optional viewer request, host limits, and actual source capabilities.
2. Store one desired-quality record per exact viewer binding with a monotonic revision.
3. Route initial publication, viewer request, group change, resume, media-mode change, reconnect, and source switch through `ViewerSenderController`.
4. Apply pause/media mode and complete quality in one serialized `setParameters()` call.
5. Remove direct sender writes from router, binding manager, live apply, and publisher manager after initial sender registration.
6. Publish one feedback object containing requested, effective, configured readback, observed throughput/FPS, clamp reasons, and revision.
7. Make the UI display requested and actual values distinctly; never label dispatch as applied.
8. Reapply pending desired state automatically when a binding/sender becomes ready and push updated feedback without requiring another user action.

**Fixes:** B-01, B-03, B-04, B-06, B-08.  
**Exit criteria:** exactly one sender writer; settings cannot oscillate; pending mapping automatically resolves or becomes a timed actionable error.

### Phase 7 — Make pause authoritative

1. Define pause success as configured sender readback plus observed outbound media falling below a small control/keepalive threshold.
2. Keep the poster frame as presentation only; do not equate video-element pause with network pause.
3. If sender pause cannot be confirmed, restore playback and show a clear error.
4. Preserve the same exact binding and desired quality through resume.
5. Add timeout/retry policy owned by `ViewerSenderController`, not the UI.

**Fixes:** B-01.  
**Exit criteria:** within the defined timeout, outbound video/audio media bytes stop increasing materially while paused, then resume with the prior effective quality.

### Phase 8 — Consolidate telemetry

1. Retain `StreamMetricsService` or replace it, but make it the sole polling owner.
2. Remove `MediaStatsPoller` and per-binding timers.
3. Register/unregister exact peer connections through session controllers.
4. Derive viewer status and diagnostics from snapshots with freshness timestamps.
5. Use observed data to close the bitrate/FPS feedback loop.

**Fixes:** B-01, B-06, B-08, B-10, B-11.  
**Exit criteria:** one `getStats()` call per peer connection per sample interval and one consistent bandwidth/FPS value across UI and history.

### Phase 9 — Product settings and UI cleanup

1. Add `showCompareControls: boolean` to canonical persisted user settings.
2. Default it to `false` and add a user-settings toggle.
3. Pass the compare callback only when enabled; suppress compare keyboard shortcuts when disabled.
4. Show target, effective, configured, and observed bitrate/FPS together where relevant.
5. Replace `Pending apply: mapping missing` with a bounded state: “Waiting for media connection,” then automatic retry or actionable failure.

**Fixes:** B-03, B-06, B-07, B-08.  
**Exit criteria:** A/B controls are hidden by default and all quality controls communicate actual outcomes.

### Phase 10 — Split large modules along established ownership

After behavior is centralized, split—not before:

- `Phase3Runtime` -> composition root plus explicit adapters.
- `StreamSessionManager` -> `HostShareSession`, capture adapter, audio adapter, lifecycle announcer.
- `ViewerMediaBinding` -> token authorizer, exact binding repository, sender controller, presence projection.
- `GroupMessageRouter` -> pure typed protocol dispatch; no Zustand, sounds, or DOM events.
- `ViewerWorkspace` -> rendering components and controller hooks.

**Exit criteria:** modules have one reason to change; no new manager may own a copy of another manager’s lifecycle state.

---

## Verification matrix

| Scenario | Required result |
|---|---|
| Start then stop | OS capture indicator disappears; all capture tracks are ended; no active publisher/history/timer remains. |
| Failed publish after capture | Capture and audio resources close; history is finalized as failed/interrupted. |
| Pause | Poster appears, sender readback is inactive, and observed media bitrate falls to the agreed threshold. |
| Resume | Same binding resumes and prior effective quality is restored exactly once. |
| Quality request before bind | Request remains desired state, auto-applies after exact sender registration, and feedback updates without another click. |
| Group preset change with viewer override | Effective policy is deterministic; no alternating sender values. |
| Raise bitrate/FPS | UI distinguishes requested/effective/configured/observed; configured sender and observations update or show the precise clamp/constraint. |
| Viewer network loss | Combined health enters reconnecting and automatically rejoins with bounded backoff. |
| Manual refresh | One awaited recovery operation runs and returns truthful status; it does not destructively clear valid state first. |
| Stop while control is disconnected | Stop is delivered after reconnect or snapshot reconciliation immediately removes the stale stream. |
| Source switch concurrent with stop | Operations serialize; no replacement occurs after teardown and both old/new capture tracks close. |
| Multiple viewers | Every sender command uses an exact binding ID; one viewer’s state never affects another. |
| Compare preference disabled | Button and keyboard shortcuts are absent; normal viewer mapping remains single-session. |

## Recommended delivery order

1. Phases 0-1: correctness and resource safety.
2. Phase 2: delete dead/dangerous paths to reduce the change surface.
3. Phases 3-5: canonical contracts, viewer ownership, recovery.
4. Phases 6-8: quality/sender and telemetry consolidation.
5. Phase 9: requested product behavior and truthful UX.
6. Phase 10: final structural split after ownership is proven.

Avoid a full rewrite. Keep the existing VDO adapter and protocol schemas initially, place characterization tests around them, and migrate one ownership boundary at a time.

## Implementation progress

- **Phase 0 — completed:** Added deterministic deferred, media, sender, peer, and event-trace fixtures in `apps/desktop/tests/pipeline-phase0-test-helpers.ts`; added 38 characterization tests for B-01 through B-18 coverage, manual-only reproductions, and dead-service wiring in `apps/desktop/tests/pipeline-characterization-phase0.test.ts`. Focused test command passed: `pnpm exec vitest run tests/pipeline-characterization-phase0.test.ts`.
- **Phase 1 — completed:** `StreamSessionManager` lifecycle operations are serialized and typed, capture tracks are stopped on terminal paths, metrics are finalized on failure/stop/restart/destroy, publisher replacement has a post-await race guard, standalone lifecycle stops survive reconnect, runtime destruction awaits host teardown, and viewer retry is awaited with surfaced failure. Focused verification passed: 8 files / 202 tests (`pipeline-characterization-phase0`, `stream-session-manager`, `publisher-manager`, `group-control-lifecycle-queue`, `phase3-runtime`, `viewer-session`, `viewer-workspace-lifecycle`, `group-connection-manager-hardening`). No deviations accepted.
- **Phase 2 — completed:** Deleted the dead viewer/live-apply/dashboard paths, fabricated remote restart method, unused quality revision/mapping/retry/legacy poller helpers, and disconnected store projections/actions. Converted live mapping cleanup to exact viewer/session/media identities and removed duplicate watched-stream end detection. Static production scan is clean; focused verification passed 19 files / 450 tests, including affected audio route suites.
- **Phase 3 — in progress:** Establish canonical domain contracts and shared defaults.
- **Phase 3 — completed:** Added shared `StreamAnnouncement`, `PersistedSettings`, `ShortcutBinding`, `StartShareInput`, `StreamTarget`, `ViewerBindingId`, `HostSessionSnapshot`, and `ViewerSessionSnapshot` contracts; migrated main/preload/renderer duplicates; consolidated quality/settings defaults through shared factories; preserved migrations and IPC shapes. Verification passed: shared defaults/contracts 3 files / 34 tests, desktop settings/quality/store 6 files / 47 tests, shared full suite 19 files / 323 tests, and all desktop TypeScript projects.
- **Phase 4 — completed:** Moved viewer lifecycle serialization, retry, stream-end detection, target refresh, and typed quality/pause feedback into `ViewerSessionController`; replaced local lifecycle state with its subscribed snapshot; removed `targetRef`, `startAttemptRef`, the module-level lifecycle queue, duplicate end detection, and dead quality/pause DOM-event paths; extracted presentation-only viewer overlays while retaining the existing stage, controls, panels, and enhancement components. Verification passed: 4 files / 154 tests (`viewer-session-controller`, `viewer-workspace-lifecycle`, `viewer-session`, `group-message-router`) and all desktop TypeScript projects. Oracle acceptance review passed.
- **Phase 5 — completed:** Added a pure bounded backoff and `ConnectionSupervisor`; wired controller health polling for group control, peer media, and cumulative inbound bytes; added pause-aware stall detection, bounded cancellable automatic recovery, intentional-stop suppression, generation-safe teardown, target refresh that preserves valid registry state, and a shared awaited `recover()` command for manual Retry. Viewer metrics now use the viewer history role. Verification passed: 5 files / 137 tests (`connection-supervisor`, `viewer-session-controller`, `viewer-session-controller-health`, `viewer-workspace-lifecycle`, `group-refresh-rate-limit`) and all desktop TypeScript projects. Three Oracle gates passed; real network loss/rejoin remains manual-only.
- **Phase 6 — completed:** Added one shared pure quality resolver and monotonic per-binding request revisions; introduced `ViewerSenderController` with exact binding IDs, serialized desired-state writes, readback, feedback, and reconnect reapply; migrated all viewer quality/pause/media-mode writes out of binding/router/publisher paths; removed duplicate paused state; and made requested-vs-actual UI feedback truthful. Verification passed: 6 files / 177 tests including Phase 0 characterization (38/38), all desktop TypeScript projects, and static sender ownership scan. Three Oracle gates passed; only two QualityCoordinator host compatibility helpers remain as deferred non-viewer writes.
- **Phase 7 — completed:** Made pause authoritative through configured sender readback and observed outbound media behavior.
- **Phase 7A — completed:** Added configurable bounded timeout and truthful failure/readback handling to `ViewerSenderController.applyPause()`/`applyResume()`, preserving exact binding, quality, and media state on failure. Verification passed 6 files / 176 tests and all desktop TypeScript projects. Oracle gate passed.
- **Phase 7B — completed:** Confirmed paused state with exact-binding host outbound-media observation and bounded rollback.
- **Phase 7B — completed:** Added exact-binding peer-connection registration, required host outbound `bytesSent` observation across audio/video, elapsed-time threshold/window confirmation, truthful missing-PC/stats failures, and dual-sender rollback. Verification passed 7 files / 255 tests and all desktop TypeScript projects; Oracle gate passed, with only defensive PC-registration fixes applied afterward.
- **Phase 7C — completed:** Added injected-clock observation, bounded rollback retries and media-mode writes, exact-binding pause→reregister→resume coverage, and protocol failure propagation. Final Oracle acceptance passed; real SDK stats timing remains manual-only.
- **Phase 8 — completed:** Consolidated recurring telemetry ownership in `StreamMetricsService`, removed `MediaStatsPoller` runtime ownership and per-binding timers, projected inbound-only cumulative bytes for controller health, and routed host diagnostics through canonical connection snapshots. Verification passed 7 files / 220 tests and all desktop TypeScript projects; final Oracle acceptance passed.
- **Phase 9 — completed:** Added canonical `showCompareControls` persistence with false legacy default, gated compare controls, and made requested/effective/configured/observed quality feedback and waiting/error states truthful. Verification passed 8 files / 110 desktop tests, shared defaults 12/12, all desktop TypeScript projects, and the WCAG-oriented Oracle review.
- **Phase 10 — completed:** Extracted `ViewerStatusOverlay`, `StreamAnnouncer`, and `GroupMessageRouter` side-effect callbacks while preserving behavior and runtime wiring. Verification passed 9 files / 312 tests and all desktop TypeScript projects; final Oracle acceptance passed.
