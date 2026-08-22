# Host/Connect/View Pipeline — Behavior-Preserving Hardening Design

**Date:** 2026-07-12
**Status:** Approved
**Wire Compatibility:** VDO.Ninja SDK 1.3.18 retained unchanged. All message schemas, envelope formats, and protocol versions preserved.

## 1. Scope

Behavior-preserving hardening of the pipeline from host session start through viewer discovery, join, bind, watch, pause/resume, and clean shutdown. No new features. No rewrites. Every invariant added or tightened must be verifiable by test or by static proof that existing behavior is unchanged when the hardening layer is satisfied.

### Explicitly In Scope

- Host stream lifecycle (start, restart, switch-source, stop, destroy)
- Stream discovery and advertising (heartbeat, re-announce, snapshot, tombstone)
- Viewer join/bind/watch flow (request → accept → connect → bind → tracks → playing)
- Play/pause/resume with host acknowledgement
- Viewer disconnect (explicit leave, abrupt drop, host-stop propagation)
- Group control connection reconnect and pending-message flush
- Native frame ring and presenter queue invariants
- Quality/encoding parameter application with readback verification
- Codec preference negotiation
- Audio pipeline hardening: ProcessAudioController lifecycle invariants, audio helper ownership boundary, combined stream soundness, PCM bridge sequencing
- NVIDIA VSR/capture pipeline invariants: frame transport correctness, enhancement backpressure, slot management in native frame ring
- Native video enhancement buffer lifecycle and zero-copy frame transport verification
- Error classification and propagation boundaries
- Test coverage for all of the above, including CI integration
- CI test-gate workflow (new `.github/workflows/ci.yml` on push/PR) — in scope because it is required to verify this pipeline on every change

### Explicitly Out of Scope

- UI changes (viewer workspace, host dashboard, dialogs — covered by separate spec)
- New message types or protocol changes
- SDK version upgrade or SDK adapter refactor
- Broad audio pipeline architecture rewrites (addressed by audio-sharing design; only hardening of existing owned-invariants is in scope)
- Broad NVIDIA VSR pipeline rewrites (addressed by separate phase; only integration-boundary invariants and frame transport hardening are in scope)
- Electron main-process IPC protocol refactors
- Build/packaging changes

### Wire Compatibility Statement

All inter-process and peer-to-peer wire formats are retained verbatim:
- `@screenlink/shared` Zod schemas and control-message type unions
- `GroupControlEnvelope` HMAC-signed format (GROUP_PROTOCOL_VERSION)
- VDO.Ninja SDK 1.3.18 media and data channel APIs
- Native frame ring shared-memory layout (SlotLayout.h)
- Binary PCM protocol version for audio helper
- Native named-pipe control protocol

No wire incompatibility is introduced: peers running the current code will continue to interoperate with hardened instances at all protocol boundaries. Internal bugs — if confirmed by reproducing test — may be fixed by the invariant additions and defensive checks described below. No claim is made that any specific bug has been confirmed without a reproducing test or static verification.

## 2. Architecture Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                     RENDERER PROCESS                             │
│                                                                  │
│  ┌───────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │ GroupControl   │───▶│ GroupMessage     │───▶│ ActiveStream  │  │
│  │ Connection     │    │ Router           │    │ Registry      │  │
│  │ (per group)    │    │ (schema-validated│    │ (tombstone +  │  │
│  │                │    │  dispatch)       │    │  heartbeat)   │  │
│  └───────┬───────┘    └──────────────────┘    └───────┬───────┘  │
│          │                                            │          │
│          ▼                                            ▼          │
│  ┌───────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │ GroupConnection│    │ ViewerMedia      │    │ StreamSession │  │
│  │ Manager        │    │ Binding          │    │ Manager       │  │
│  │ (multi-group)  │    │ (tokens +        │    │ (local host   │  │
│  │ + pendingQueue │    │  mapping)        │    │  lifecycle)   │  │
│  └───────┬───────┘    └───────┬──────────┘    └───────┬───────┘  │
│          │                    │                        │          │
│          ▼                    ▼                        ▼          │
│  ┌───────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │ ViewerSession │    │ PublisherManager │    │ QualityCoord  │  │
│  │ (viewer join  │    │ (HostPublisher   │    │ inator        │  │
│  │  + watch      │    │  + audio track)  │    │ (per-viewer   │  │
│  │  + pause)     │    │                  │    │  requests)    │  │
│  └───────┬───────┘    └───────┬──────────┘    └───────────────┘  │
│          │                    │                                    │
│          ▼                    ▼                                    │
│  ┌──────────────────────────────────────────────────────┐         │
│  │              VDO.Ninja SDK 1.3.18                    │         │
│  │  (media connections, data channels, signaling)       │         │
│  └──────────────────────────────────────────────────────┘         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐         │
│  │         Native Frame Ring (C++ addon)                 │         │
│  │  (SharedMemoryFrameRing.ts + FrameRing.cpp)           │         │
│  └──────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

### Service Ownership

| Service | Owns | Lifespan |
|---------|------|----------|
| `GroupConnectionManager` | N `GroupControlConnection`s, pending-message queues | App lifetime |
| `GroupMessageRouter` | Schema-validated dispatch, response/result waiters, ping/pong RTT | App lifetime |
| `ActiveStreamRegistry` | Global stream discovery, tombstones, heartbeats | App lifetime |
| `StreamSessionManager` | ONE local host session (capture, publish, announce) | Per share session |
| `PublisherManager` | HostPublisher + audio controller + combined stream | Per publish session |
| `ViewerMediaBinding` | Binding tokens, composite-key viewer mappings, sender states | Per host session |
| `ViewerSession` | ONE viewer watch (ViewerClient, video element, pause state) | Per watch session |

> **Note on evidence level:** Every claim below that something is "already done" or "verified" is a hypothesis drawn from code reading, not from test execution or static analysis. Before acting on any such claim as a reason to skip a hardening step, the implementer MUST either:
> 1. Write a reproducing test that confirms the claimed behavior, or
> 2. Perform a targeted code walk (forward slice from callers) that proves the claim holds in all reachable states.
>
> Claims not confirmed by test or proof are treated as open questions and receive the same hardening attention as explicitly marked "Verify:" items.

## 3. Host Lifecycle

### 3.1 State Machine Diagrams

**StreamSessionManager:**
```
                ┌──────────────────────────────────────┐
                │                                      │
                ▼                                      │
  idle ──▶ starting ──▶ active ──▶ stopping ──▶ idle   │
                │          │  ▲                        │
                │          │  │                        │
                │          ▼  │                        │
                │     restarting ──────────────────────┘
                │                                      │
                ▼                                      │
              failed ──▶ idle                          │
                │                                      │
                ▼                                      │
             destroyed (terminal)                      │
                └──────────────────────────────────────┘
```

**PublisherManager:**
```
  idle ──▶ starting ──▶ sharing ──▶ stopping ──▶ idle
                │                      │
                ▼                      ▼
              error                 (cleaned)
```

### 3.2 Hardening: startStream Two-Phase Invariants

**Phase A (critical media, fatal on failure):**
1. Validate state is `idle` or `failed` before proceeding. (Already done.)
2. Generate VDO credentials and PublisherManager BEFORE `getDisplayMedia` to fail fast if SDK cannot construct. (Already done.)
3. Register local stream in registry BEFORE broadcasting `stream.started`. (Already done.)
4. **New invariant:** After `getDisplayMedia`, verify video track `readyState === "live"` and `enabled === true` before proceeding. Log the track label and settings for diagnostics. (Partially done in PublisherManager.startPublishing — clarify ownership: SSM validates capture, PublisherManager validates combined stream pre-publish.)
5. **New invariant:** After `applyCaptureConstraints`, read back actual `width`, `height`, `frameRate` from `track.getSettings()` and store as source of truth. Fail Phase A if readback returns all zeros after a non-zero request (browser bug detection). (Gate 4.4 already does this — harden to treat zero readback as non-fatal warning rather than silent zero.)
6. Audio setup failure MUST NOT fail Phase A — degrade to video-only with `isAudioDegraded = true`. (Already done.)

**Phase B (control announcement, non-fatal):**
1. `connManager.sendOrQueueStreamLifecycle` with `stream.started` is fire-and-forget. If it throws, log warning and continue. (Already done.)
2. **New invariant:** Phase B MUST NOT reference any object whose lifecycle is owned by Phase A (e.g. `captureStream`, `currentTrack`, `publisherManager`). If Phase A succeeded, these are guaranteed live. Defensive null-check before use in Phase B.

### 3.3 Hardening: restartStream Safety

- Clear old `currentTrack.onended` BEFORE calling `getDisplayMedia` (detachTrackEnded pattern already exists). **New:** Verify detach happened by asserting `onended === null` after detach.
- New `mediaSessionId` and new VDO credentials per restart. (Already done.)
- After new capture, re-setup audio with the same `_explicitAudioMode` that was used in the original start. **New:** If audio setup fails during restart, log warning and continue with `isAudioDegraded = true` — do NOT fail the restart (consistent with startStream Phase A audio degradation policy).
- **New invariant:** `restartStream` must set `_state = "active"` only after BOTH Phase A and Phase B succeed. Currently it sets `_state = "active"` after Phase B. Verify this is correct: if Phase B fails (control channel unavailable), the media is still up and the stream should be considered active. YES, Phase B failure is non-fatal.

### 3.4 Hardening: stopStream Cleanup Order

Current order (verify correct):
1. Stop heartbeat and re-announce timers
2. Stop audio helper (best-effort)
3. Reject pending joins, close viewer mappings via `removeMappingsForMediaSessions`
4. Remove local registry entry (immediate)
5. Clear pending lifecycle messages for this stream
6. Queue or broadcast `stream.stopped` (fire-and-forget)
7. Stop publication/capture via `cleanupPublisher()`
8. Reset session state

**New invariant:** Step 1 (timer stop) MUST happen before any async operation that could fail. Already correct — timers are stopped before awaits.

**New invariant:** Step 4 (registry removal) MUST happen before Step 6 (broadcast) so that a peer responding to `stream.state.request` between these steps sees the stream as stopped. Already correct.

**New invariant:** `cleanupPublisher()` (step 7) MUST be idempotent. It currently `await`s `stopCapture()` which guards against double-stop via `stopping_` flag. Verify the guard resets correctly (`stopping_ = false` in finally) so a subsequent `stopStream` can run.

### 3.5 Hardening: destroy Terminal Lifecycle

- `destroy()` sets `_state = "destroyed"` and `destroyed = true`. No further operations allowed.
- **New invariant:** Every public method (`startStream`, `stopStream`, `restartStream`, `switchSource`) must check `this.destroyed` at entry and return immediately. (Already done for most — audit `switchSource` which only checks `_state !== "active"` and `destroyed`.)
- **New invariant:** After `destroy()`, the runtime reference (`this.runtime`) MUST still be valid for cleanup operations, but NO new external operations (no new broadcasts, no new registry mutations) may be initiated. The `clearSharingGroupInStore()` call is acceptable because it is a store write, not a network operation.

## 4. Stream Discovery / Advertising

### 4.1 Heartbeat Protocol

StreamSessionManager sends heartbeats at 10s interval (via `startHeartbeat()`). The heartbeat carries `heartbeatSequence`, `appliedSettingsRevision`, and `leaseValidUntil`.

ActiveStreamRegistry:
- Rejects heartbeats with `heartbeatSequence <= lastSeq` (stale rejection)
- Rejects heartbeats for tombstoned streams (no resurrection)
- Emits `"stopped"` for streams whose last heartbeat is older than `expiryMs` (default 30s)

**Hardening:**
1. **New invariant:** Heartbeat timer MUST be cleared in both `stopStream` and `destroy`. (Already done — `stopHeartbeat()` called in both.)
2. **New invariant:** `leaseValidUntil` in the future MUST prevent expiry-based removal even if heartbeats are delayed. The registry already treats `leaseValidUntil < now` + missing heartbeats as dead. Verify that `leaseValidUntil` in the future acts as a "keep alive even without recent heartbeat" signal. Currently the heartbeat expiry check does NOT examine `leaseValidUntil` — it only checks `lastHeartbeatAt < expireBefore`. **Recommendation:** Add lease-based override: skip expiry for streams whose `leaseValidUntil > now` even if heartbeat is late. This is a behavior-preserving change because currently no stream advertises a future `leaseValidUntil`.
3. **New invariant:** Re-announce timer (15s) and heartbeat timer (10s) should use staggered phase to avoid thundering-herd re-announcements from multiple hosts. (Cosmetic — not critical.)

### 4.2 Stream State Snapshot

On `stream.state.request`, the recipient responds with `stream.state.snapshot` containing all streams scoped to the requesting group. GroupMessageRouter already filters the snapshot to only the routing group's streams (cross-group leak prevention).

**Hardening:**
1. **New invariant:** Snapshot response sender MUST exclude streams whose `stopTombstones` entry is still within `tombstoneMaxAgeMs`. Currently `getStreamsByGroup` only checks `!s.stopped` — it does not consult tombstones. If a stream was stopped within the last 5 minutes, a snapshot could resurrect it in the recipient's registry. Fix: `getStreamsByGroup` (and `getAllStreams`, `getStream`, `getGroupKeys`) should filter against the stop-tombstone map in addition to `stopped` flag. (Critical behavior-preserving fix — prevents stale stream resurrection on snapshot.)
2. **New invariant:** Snapshot handler (`handleSnapshot`) already rejects tombstoned streams. This is correct — but add a log warning when a tombstoned stream appears in a snapshot (indicates sender has not yet learned of the stop).

### 4.3 Reconnect Flush

When `GroupConnectionManager` detects a state transition to `"connected"`, it calls `flushPendingLifecycle()` for that group. This broadcasts all queued lifecycle messages that are still within TTL (5 minutes).

**Hardening:**
1. **New invariant:** `flushPendingLifecycle` MUST skip messages whose `enqueuedAt` is older than `PENDING_TTL_MS`. (Already done.)
2. **New invariant:** `flushPendingLifecycle` MUST skip `stream.stopped` if there is no pending start/restart for the same logical stream. (Already done.)
3. **New invariant:** `flushPendingLifecycleToPeer` (called on peer hello) MUST NOT re-announce streams that the registry already reports as stopped (tombstone check). Currently it only checks the local pending queue and TTL. **Fix:** check the ActiveStreamRegistry tombstone before flushing to a specific peer.
4. **New invariant:** Queue size cap per group (MAX_PENDING_PER_GROUP = 16) already exists. Add a metric/log warning when the cap is hit — it suggests a systemic flush failure.

## 5. Viewer Join/Bind/Watch Lifecycle

### 5.1 Join Flow (ViewerSession.runJoinFlow)

```
  connecting ──▶ requesting-join ──▶ waiting-for-host ──▶ accepted
       │                │                   │
       ▼                ▼                   ▼
     error            error               error
       │                                     │
       ▼                                     ▼
  accepted ──▶ connecting-media ──▶ watching
                    │                   │
                    ▼                   ▼
                  error               error
```

Key invariants (mostly already implemented):
- Response waiter registered BEFORE sending the request (avoids race)
- Generation counter checked after every await (abandoned-flow prevention)
- `stream.join.request` carries `viewerSessionId` for disambiguation
- `media.bind` sent AFTER `view()` completes
- Data channel open awaited before sending bind (with bounded timeout + retry)

**Hardening:**
1. **New invariant:** Registration of the join response waiter and sending of `stream.join.request` must be atomic with respect to generation bumps. Currently there is a generation check between steps (line 1167). If `destroy()` or `retry()` bumps generation between `conn.sendToPeer` and `this.setState("waiting-for-host")`, the old flow continues with a stale response. **Fix:** Verify the generation check at line 1167 (after send, before awaiting response) is sufficient — it is. The only gap is between `setState("requesting-join")` and `conn.sendToPeer`. Move the generation check to AFTER the send and BEFORE registering the waiter. The waiter registration is already after the generation check at line 1167.
2. **New invariant:** `viewerClient.createAndConnect(password)` must time out if the VDO signaling server does not respond within 35 seconds. (Already done via `connectWithTimeout`.)
3. **New invariant:** `viewerClient.view(streamId)` must time out (30s). (Already done via `withTimeout`.)
4. **New invariant:** Bounded retry (5 attempts, 500ms × attempt# backoff) for `sendMediaBind`. (Already done.)
5. **New invariant:** After receiving `watching` state, start status interval (2s). Cancel on stop/destroy. (Already done.)

### 5.2 media.bind Protocol (Stage 5)

The viewer sends `media.bind` over the VDO data channel (not group control). The host's PublisherManager receives it via the SDK `dataReceived` event and routes to `ViewerMediaBinding.handleMediaBind`.

**Hardening:**
1. **New invariant:** `handleMediaBind` MUST validate the binding token against ALL stored fields: `viewerDeviceId`, `viewerSessionId` (when present), `groupId`, `logicalStreamId`, `mediaSessionId`, `expiresAt`. (Already done in `consumeBinding`.)
2. **New invariant:** Token TTL is 60 seconds. Cleanup interval runs every 30 seconds. Verify the cleanup removes expired tokens. (Already done.)
3. **New invariant:** When a media.bind arrives and the token exists but the viewer already has a mapping for a DIFFERENT media session on the same logical stream, the old mapping is cleaned up. (Already done — lines 585-593.)
4. **New invariant:** Sender resolution retry: if the video sender is not available at bind time, retry 40 times at 50ms intervals (~2s). (Already done.)

### 5.3 Abandoned-Flow Prevention (Generation Counter)

Every `start()` call on ViewerSession bumps `_nextGeneration`. After every `await` in `runJoinFlow()`, the flow checks `isCurrent()` which verifies `_generation === _nextGeneration && !_destructed`.

**Hardening:**
1. **New invariant:** The generation counter is per-instance (not static). Two ViewerSession instances can coexist without interfering. (Already done — changed from static.)
2. **New invariant:** tearDown (beginTeardown) bumps generation before touching ViewerClient, so any in-flight join flow on the same instance is abandoned before SDK shutdown. (Already done.)
3. **New invariant:** Pause generation (`_nextPauseGeneration`) is also per-instance, preventing one session's pause from invalidating another's resume. (Already done.)
4. **New invariant:** Audio pipeline (ProcessAudioController) must NOT depend on ViewerSession generation for lifecycle — audio is owned by StreamSessionManager, not ViewerSession. (Verify: ProcessAudioController state machine is independent. OK.)

### 5.4 Self-View Path

When `hostDeviceId === runtime.deviceId`, ViewerSession skips the VDO relay and uses the capture stream directly from StreamSessionManager.

**Hardening:**
1. **New invariant:** Self-view must not send `stream.join.request` or any media.bind messages. (Already done — early return in `runJoinFlow`.)
2. **New invariant:** Self-view must not attempt to send `viewer.pause.request` to the host (it IS the host). (Already done — `pause()` checks `hostDeviceId === getRuntime()?.deviceId`.)
3. **New invariant:** Self-view retry: if the capture stream is not yet available, retry up to 3 times with 2s delay. (Already done.)
4. **New invariant:** Self-view must not create a ViewerClient. (Already done.)

## 6. Play / Pause / Resume

### 6.1 State Machine

**ViewerSession pause state (viewer-side):**
```
  playing ──▶ pausing ──▶ paused  (after host acknowledgment)
    ▲                        │
    │                        │
    └────────────────────────┘  (host failure/timeout → revert to playing)
               │
               ▼
  paused ──▶ resuming ──▶ playing  (after host acknowledgment)
               │
               └───────────▶ paused  (host failure → revert to paused)
```

**ViewerMediaBinding pause state (host-side):**
```
  (sender active) ──▶ applyPause() ──▶ sender encodings active=false
  (sender inactive) ──▶ applyResume() ──▶ restore prior active state
```

### 6.2 Protocol

Viewer sends `viewer.pause.request` with `operationId` over group control. Host applies encoding changes and responds with `viewer.pause.result` with the same `operationId`. Viewer awaits the result (5s timeout).

**Hardening:**
1. **New invariant:** The `operationId` must be a UUID generated per pause/resume call. (Already done — `crypto.randomUUID()`.)
2. **New invariant:** Response must validate all identity fields: `groupId`, `logicalStreamId`, `mediaSessionId`, `viewerSessionId`, `viewerDeviceId`, `pauseGeneration`. (Already done in `assertPauseResult`.)
3. **New invariant:** Self-view pause is local-only (no host message). (Already done.)
4. **New invariant:** Poster frame is captured BEFORE sending pause request so the last frame is visible during pause. (Already done.)
5. **New invariant:** Paused sender state is stored per composite key `(viewerDeviceId, mediaSessionId)` so compare-mode viewers are handled independently. (Already done.)
6. **New invariant:** After resume host acknowledgment, clear poster frame only when the video element fires `playing` — not before. (Already done — `addEventListener("playing", ...)`.)

### 6.3 Hardening: Race Conditions

1. **Rapid pause → pause:** The second call returns immediately (idempotent guard). (Already done.)
2. **Rapid resume → resume:** The second call is a no-op (state isn't `"paused"`). (Already done.)
3. **Rapid pause → resume → pause:** The middle resume invalidates the first pause via generation counter. The final pause waits for the resume to settle (via `_pauseState === "resuming"` guard). (Already done — but verify the generation check after `await` in `resume()` at line 415 is sufficient to prevent the second pause from racing.)
4. **Pause while not watching:** `pause()` checks `this._destructed || !this.viewerClient` at entry. (Already done.)
5. **Pause during teardown:** `beginTeardown` calls `cancelPendingPauseResult`. The in-flight pause `await` will reject with `"Viewer pause result cancelled"`. (Already done.)
6. **New invariant:** Poster frame lifecycle: captured on pause, cleared on resume's `playing` event, cleared on `stop()`, cleared on `destroy()`. Verify all paths. `destroy()` calls `clearPosterFrame()`. `stop()` calls `clearPosterFrame()`. `resume()` success path clears on `playing`. Good.
7. **New invariant:** Poster frame must not hold a reference to a stale video element. `capturePosterFrame()` reads `this.videoElement` synchronously. If `bindVideoElement` is called during pause, the poster captures from the old element. Acceptable — the UI handles rebinding.

## 7. Reconnect / Shutdown

### 7.1 Group Control Reconnect

SDK auto-reconnect is configured with `maxReconnectAttempts: 10, reconnectDelay: 1000`. The `GroupControlConnection` state machine transitions to `"reconnecting"` during automatic reconnect attempts and `"connected"` when the mesh is re-established.

**Hardening:**
1. **New invariant:** On state transition to `"connected"`, `GroupConnectionManager` flushes pending lifecycle messages and re-announces the local stream if the StreamSessionManager is active. (Already done via `onConnectionStateChange`.)
2. **New invariant:** During reconnect, incoming messages are buffered/queued. Currently there is no explicit inbound message queue — the SDK may buffer events internally. **Verify:** Does the SDK deliver messages that arrived during disconnect after reconnect? If not, the flush mechanism is the sole recovery path. (SDK 1.3.18 data-only mesh behavior: messages sent while disconnected are lost. The flush mechanism correctly covers this.)
3. **New invariant:** `ensureConnected()` must reject after timeout (15s) and not leave dangling promises. (Already done — polling with 200ms interval, timer at timeoutMs.)
4. **New invariant:** `ensureConnected()` must not create duplicate SDK instances. (Already done — operates on existing connection.)

### 7.2 Viewer Media Reconnect

The VDO SDK manages media connection reconnect internally (`maxReconnectAttempts: 10`). ViewerClient does NOT explicitly handle reconnect — it relies on the SDK.

**Hardening:**
1. **New invariant:** On SDK `peerDisconnected` event (viewer-side), the viewer should attempt a full retry (via `ViewerSession.retry()`) rather than waiting for SDK auto-reconnect. Because... the SDK's media reconnect will re-invite the viewer, but the host-side `mediaSessionId` may have changed during the disconnect (host restarted). The retry flow re-resolves stream state from the registry and requests fresh credentials.
   - Current behavior: `handleRemoteTrackEnded` debounces for 2s then calls `stop()`. This means the viewer stops watching after the debounce — it does NOT automatically retry.
   - **Recommendation:** After remote track ends (host stopped), if the stop was NOT user-initiated, attempt auto-retry (once) after a brief delay. The existing `_autoRetried` flag already supports one-shot auto-retry on connect timeout — extend this pattern to cover host-side stream stops that are actually restarts. This is behavior-preserving because the current behavior (stop without retry) is the safe fallback; adding one auto-retry with the existing flag preserves the no-spin property.

2. **New invariant:** `shutdown()` must be strictly sequential: `stopViewing(streamId)` (awaited) → `disconnect()` (awaited). (Already done — the sequential design is explicitly documented and verified.)
3. **New invariant:** `shutdown()` must suppress SDK auto-reconnect by zeroing reconnect properties on the SDK instance. (Already done — belt-and-suspenders in `shutdown()`.)
4. **New invariant:** `sendMediaBind` must fail fast if viewerClient is shutting down. (Already done — checks `_shuttingDown || _shutdownPromise`.)

### 7.3 Host Shutdown Propagation

When the host stops sharing (`StreamSessionManager.stopStream` or `destroy`):
1. Registry entry is removed immediately (steps 4/5 in stopStream)
2. `stream.stopped` is broadcast/queued (step 6)
3. Viewer mappings are closed (step 3)
4. Publisher stops (step 7)

Viewers detect the stop via:
- Remote track `ended` event (if media connection active)
- Registry snapshot inconsistency (on next heartbeat check)
- `stream.stopped` message over group control

**Hardening:**
1. **New invariant:** `stream.stopped` must be broadcast BEFORE `PublisherManager.stopCapture()` so the group control channel is still healthy. The current order is: close mappings (3), remove registry (4), clear pending (5), broadcast stopped (6), stop publisher (7). This is correct — broadcast happens while the control channel is up.
2. **New invariant:** After host stop, any pending join requests (received during the stop window) must be rejected with an explanatory message. Currently `handleJoinRequest` checks `ssmValid` and `registryValid` — after stop, both will be false, and the join will be rejected. Verify the rejection message is user-facing (not a crash).

## 8. Codec / Quality / Encoding

### 8.1 Codec Preference Negotiation

Applied via `applyCodecPreferencesToTransceiverBeforeOffer` (shared utility). The pipeline:
1. `HostPublisher.publish()` calls `applyCodecPreferencesOnExistingConnections` before and after SDK publish.
2. `HostPublisher.connect` registers `peerConnected` handler to apply preferences on new connections.
3. `ViewerClient.createAndConnect` registers the same handler.
4. `ViewerClient.view()` applies preferences before and after SDK view.

**Hardening:**
1. **New invariant:** Codec preference application must be guarded against empty capability arrays (browser returns `null` for `getCapabilities`). (Already done via early return on `null`.)
2. **New invariant:** `setCodecPreferences([])` must never be called — it throws in Chrome. (Already guarded by `targetCodecs.length > 0` check.)
3. **New invariant:** The auto-order (VP9 → H.264 → VP8) matches the SDK's default preference. Verify no user-facing change. (The order is already documented as auto-order.)
4. **New invariant:** Explicit codec request (e.g. "H264") that is unavailable must fall back to auto-order. (Already done with `fallbackReason`.)

### 8.2 Quality Application Pipeline

Flow: ViewerRequest → QualityCoordinator.calculateEffectiveQuality → applyToExactViewer → readback verification → quality feedback messages.

**Hardening:**
1. **New invariant:** `applyToExactViewer` must return the actual readback from `sender.getParameters()` after `setParameters()`, not just `{ success: true }`. (Already done in `applySenderSettings`.)
2. **New invariant:** Post-publish bitrate enforcement: verify the sender encoding's `maxBitrate` matches the requested value * 1000. If not, correct it. (Already done in PublisherManager.startPublishing lines 508-551.)
3. **New invariant:** Bitrate readback mismatch correction should be bounded (not an infinite loop). (Already done — one attempt.)
4. **New invariant:** `degradationPreference` is a top-level `RTCRtpSendParameters` field, not per-encoding. (Already documented and handled correctly.)
5. **New invariant:** Quality feedback messages (`quality.effective`, `quality.configured`) must use the correct `streamSessionId` (which equals `logicalStreamId`). Verify this is consistent across all send sites. (Audit: GroupMessageRouter uses `logicalStreamId`, ViewerMediaBinding uses `mapping.logicalStreamId`. Consistent.)
6. **New invariant:** The quality coordinator's `getViewerRequest` lookup by `(groupId, logicalStreamId, viewerDeviceId)` must be consistent with the viewer's actual identity. Any mismatch results in the viewer seeing stale quality data. (Verify: the stored request key matches the query key.)

### 8.3 Sender Parameter Readback

`readSenderParameters` and `applyQualityToSender` in `sender-parameters.ts` provide a structured pipeline with error codes.

**Hardening:**
1. **New invariant:** `applyQualityToSender` must verify that `sender.getParameters` returns an object with `encodings` array. If not, return `ENCODING_PARAMETERS_UNAVAILABLE`. (Already done.)
2. **New invariant:** `applyQualityToSender` must compute `scaleResolutionDownBy` from actual track settings, not from requested dimensions. (Already done — uses `sender.track?.getSettings()`.)
3. **New invariant:** `setParameters` calls must be wrapped in try-catch. (Already done.)
4. **New invariant:** Readback verification after `setParameters` must not consider the operation failed if readback throws — the set may have succeeded but getParameters is momentarily unavailable. (Already handled — returns success with configured bitrate when readback throws.)

## 9. Native Frame Transport / Audio Pipeline / Video Enhancement

### 9.1 SharedMemoryFrameRing

The C++ FrameRing addon provides a shared-memory slot-based ring buffer for zero-copy video frame transport from the capture process to the renderer. The TypeScript `SharedMemoryFrameRing.ts` wraps the addon.

**Hardening:**
1. **New invariant:** Slot acquisition (getSlot) must time out after a bounded wait. Currently the addon uses a spin-wait with `YieldProcessor` — if no slot is available, it spins. **Recommendation:** Add a built-in spin limit (~1000 iterations ≈ 10-20µs) and return null/error after that so the JS layer can decide whether to drop the frame or retry.
2. **New invariant:** Frame release (releaseSlot) must be idempotent. The JS wrapper should never call release on an already-released slot. (Verify in the addon: double-release would corrupt the free-list. **Recommendation:** Add a slot-use counter or boolean flag that is checked before release.)
3. **New invariant:** The frame ring's size (slot count, slot size) must be logged at construction so diagnostics can distinguish between "ring too small" and "producer too fast".
4. **New invariant:** The presenter queue (consumer side) must coalesce pending frames: if a new frame arrives while the previous one hasn't been presented, the old one should be skipped (dropped) to avoid backlog. (Already implemented in `presenter-queue-coalesce.test.ts` — verify the production code matches.)

### 9.2 Presenter Queue Coalescing

The frame presenter reads from the ring and renders to a canvas. A coalescing queue prevents frame accumulation when the render loop is slower than the producer.

**Hardening:**
1. **New invariant:** The presenter must always present the most recent frame, skipping intermediates. (Verified in tests.)
2. **New invariant:** The presenter must not hold a frame reference after presenting it (release the slot back to the ring). (Verify: the release happens in a finally block after canvas drawImage.)
3. **New invariant:** The presenter must handle the case where the ring has no new frames (idle producer) — the last presented frame stays on screen. (Acceptable behavior — the canvas retains the previous draw.)

### 9.3 Audio Pipeline Hardening (ProcessAudioController + Helper Ownership)

The audio pipeline crosses three processes: native helper (named pipes) → Electron main (MessagePort relay) → renderer (ProcessAudioController → AudioWorklet → MediaStreamAudioDestinationNode → combined MediaStream). The existing audio-sharing design covers the full architecture; this section hardens the integration boundaries that touch the host/connect/view pipeline.

**Hypothesized invariants (require test or static confirmation):**

1. **Audio controller ownership is exclusive.** `PublisherManager.setAudioController()` replaces the previous controller by calling `previous.close('replacement')`. Verify: the old controller's `close()` fully releases the PCM MessagePort and does not leave dangling `onmessage` handlers that would write to a defunct ring buffer.

2. **Audio start sequencing.** In `StreamSessionManager.setupSourceAudio()`:
   - Audio helper is ensured before the PCM port is requested. (Hypothesis: order is correct — `ensureAudioHelper` → `requestAudioPort` → `waitForPcmPort`.)
   - `setStreamGeneration` is called BEFORE `waitUntilPrimed()`, not after. (Hypothesis: the comment at line 1247-1249 says this is intentional — confirm by test that priming does not consume samples from a generation that was not yet set.)
   - If `waitUntilPrimed()` times out, the controller and helper are torn down, `isAudioDegraded` is set, and the stream continues video-only. (Hypothesis: this matches Phase A degradation policy.)

3. **Combined stream building.** `PublisherManager.buildCombinedStream()` validates:
   - Audio track `kind === 'audio'` (throws `publisher-audio-track-wrong-kind` otherwise).
   - Audio track `readyState === 'live'` (throws `publisher-audio-track-<state>` otherwise).
   - Controller state is `'rendering'` or `'primed'` before adding the track.
   These invariants prevent publishing a dead or uninitialized audio track. (Hypothesis: all three guards are present; confirm they fire correctly when audio is degraded mid-stream.)

4. **PCM port lifecycle.** The `waitForPcmPort` promise resolves once via `window.addEventListener('message', handler)` with the handler removed after firing. Verify: multiple calls to `setupSourceAudio` (restart) do not leak event listeners — the `removeEventListener` in the handler covers the success case, and the `setTimeout` cleanup covers the timeout case. `pcm:port` events received after timeout are silently dropped (no listener).

5. **Audio helper stop during stream stop.** `stopStream()` calls `api.stopAudio()` (best-effort try/catch). Verify: if the helper was already stopped (e.g. crashed and was not restarted), the stop call does not throw or leave the helper in a double-free state. The helper's `--stop` named-pipe command is idempotent on the native side.

### 9.4 Video Enhancement Pipeline Hardening (NVIDIA VSR + Native Transport)

The video enhancement pipeline uses a separate native helper (`screenlink-video-enhancer.exe`) for NVIDIA VSR (Video Super Resolution) processing, communicating via the same named-pipe control protocol as the audio helper. Frame data moves through the SharedMemoryFrameRing (producer) → presenter queue (consumer) → enhancement processing → display.

**Hypothesized invariants (require test or static confirmation):**

1. **Enhancement buffer lifecycle.** The video enhancer receives frames from the frame ring and returns enhanced frames. Verify: the slot for an in-flight enhancement is not released back to the ring until enhancement completes or times out. A double-release would corrupt the ring's free-list.

2. **Backpressure.** If the video enhancer is slower than the capture rate, the presenter queue coalesces frames (drops intermediates) rather than blocking the producer. (Hypothesis: coalescing is already tested in `presenter-queue-coalesce.test.ts`; verify the production code path matches the test assumptions.)

3. **Enhancer crash recovery.** If the video enhancer process exits unexpectedly, the capture pipeline continues with raw (unenhanced) frames. The `video-enhancer-protocol.ts` handler detects the exit via pipe closure and notifies the renderer. (Hypothesis: the fallback to raw frames exists; verify it does not leave stale enhanced-frame references in the presenter.)

4. **Native transport framing.** The binary protocol between the main process and the enhancer uses a length-prefixed frame format. Verify: the reader cannot be tricked by partial writes — all reads use the framed length to wait for the complete payload before parsing.

## 10. Error Handling / Invariants

### 10.1 Error Classification

| Category | Examples | Handling |
|----------|----------|----------|
| Fatal (media) | Capture fails, SDK connect fails | Phase A failure → full stop, user-facing error |
| Non-fatal (control) | Broadcast fails, flush fails | Phase B failure → log, queue, retry on reconnect |
| Expected (teardown) | RTCErrorEvent "Close called" during shutdown | Suppressed (already done in HostPublisher and ViewerClient) |
| Transient (network) | SDK reconnect failed, timeout | Automatic retry (SDK internal), or trigger viewer retry |
| Programming error | Null runtime, missing handler, invalid state | Defensive check → log → no-op (never crash the renderer) |

### 10.2 Defensive Checks

**New required pattern:** Every public method on service classes must follow this guard order:

```
if (this.destroyed) return (or throw if caller must know)
if (state check fails) return (or reject with typed error)
// proceed
```

Currently most services follow this pattern. The gaps below are hypotheses from code reconnaissance — each requires a reproducing regression test (confirmed fail before fix) before the guard is added.

| File | Method | Hypothesized Gap |
|------|--------|---------------|
| `StreamSessionManager` | `switchSource` | Missing `destroyed` check at entry (only checks `_state !== "active"`) |
| `PublisherManager` | `replaceVideoTrack` | Missing `publisher` null check before SDK call |
| `ViewerMediaBinding` | `handleJoinRequest` | No null-check on `payload` before field access (line 192 reads `payload?.logicalStreamId` — safe, but `payload` is cast without runtime check) |
| `ViewerMediaBinding` | `consumeBinding` | Missing `destroyed` check (only in `handleMediaBind` and `handleJoinRequest`) |
| `ActiveStreamRegistry` | `handleSnapshot` | Null-check on `streams` array elements — already done (line 932) |
| `GroupConnectionManager` | `broadcast` | Missing null-check on connection state before calling `conn.broadcast` (already done — returns `{ attempted: 0, sent: 0, failed: 0 }` if no connection) |

### 10.3 Cross-Group Leak Prevention

GroupMessageRouter already has `validatePayloadGroup()` which checks that the payload's `groupId` matches the routing `groupId`. Applied to `stream.started`, `stream.heartbeat`, `stream.stopped`, `stream.restarted`, and `stream.state.snapshot`.

**Hardening:**
1. **New invariant:** Every `stream.*` message handler must call `validatePayloadGroup`. Currently only handled `stream.started`, `stream.heartbeat`, `stream.stopped`, `stream.restarted` in `routeStreamMessage` have the check. The `stream.state.request` handler does not validate payload group because the payload is empty — the routing groupId in the envelope IS the group scope.
2. **New invariant:** `handleSnapshot` filters entries by `groupId` — this is correct. Also verify that `respondWithSnapshot` uses `getStreamsByGroup(groupId)` which is correctly scoped. (Both already done.)

### 10.4 Timer and Promise Cleanup

Every timer (`setTimeout`, `setInterval`) must be tracked and cleared on destroy/stop. Every promise rejection must be caught.

**Hardening audit:**

| Service | Timer/Promise | Cleanup verified |
|---------|--------------|------------------|
| StreamSessionManager | Heartbeat interval | `stopHeartbeat()` in stopStream/destroy |
| StreamSessionManager | Re-announce interval | `stopReannounce()` in stopStream/destroy |
| StreamSessionManager | Play retry ready timeout | Fire-and-forget, bounded by 3s |
| ViewerSession | Readiness timeout | `cancelReadinessTimer()` in beginTeardown |
| ViewerSession | Status interval | `clearStatusInterval()` in beginTeardown |
| ViewerSession | Remote-track-ended debounce | `cancelRemoteTrackEndedTimer()` in beginTeardown |
| ViewerSession | Play() retry promise | Chained onto `_playPromise`, serialized |
| ViewerSession | Self-view retry timer | `cancelSelfViewRetryTimer()` in beginTeardown, reset in start |
| ViewerMediaBinding | Token cleanup interval | `startCleanup()` in constructor, interval cleared in destroy |
| ViewerMediaBinding | Sender retry resolution | `clearInterval` after max attempts or success |
| GroupConnectionManager | ensureConnected polling timer | Timeout clears polling loop |
| GroupMessageRouter | Join response timeout | Timer in resolver, cleared on response or cancel |
| GroupMessageRouter | Viewer pause timeout | Timer in resolver, cleared on result or cancel |
| ActiveStreamRegistry | Heartbeat expiry check | Interval in constructor, stopped in destroy |

**Hypothesis:** All timers are tracked and cleaned up. This must be confirmed by test (e.g. inject a timer callback after destroy, verify it does not fire). The identified risk of untracked `setTimeout` calls in Promise chains (`.catch(() => {})` without a stored handle) is bounded because the promise scope dies with the operation — confirm by test that no timer fires after the owning session reaches `destroyed` or `ended` state.

## 11. Targeted Simplification

These simplifications reduce maintenance surface and improve robustness without behavioral change:

### 11.1 Consolidate ensureConnected Implementation

`GroupConnectionManager.ensureConnected()` currently uses polling (`setTimeout(poll, 200)`) instead of subscribing to the connection's `onStateChange` callback. This works correctly but adds unnecessary latency and complexity.

**Recommendation:** Replace the polling loop with a subscription to `conn.onStateChange` (which is already wired through `GroupControlConnectionOptions`). The method still respects the timeout. This is behavior-preserving because both paths produce the same outcome — the only difference is response time (polling = up to 200ms latency, subscription = next event cycle).

**Non-goal:** Do NOT change the public API signature or the timing guarantees (callers depend on the 15s default timeout).

### 11.2 Extract Stream Lifecycle Payload Builder

The `buildAnnouncement()` private method in `StreamSessionManager` constructs the `StreamAnnouncement` for registration. The same structure is built inline in `startStream` Phase B and `restartStream` Phase B for the control broadcast payload.

**Recommendation:** Extract a single private `buildLifecyclePayload(type, logicalStreamId, mediaSessionId)` method that returns `Record<string, unknown>`. Use it in all three places. This reduces the risk of field omissions between registration and broadcast.

**Non-goal:** Do NOT change the payload key names or values. The method is an internal extraction.

### 11.3 Unify Error Message Constants

The string `"The selected group is not connected. Reconnect to the group and try again."` appears once as `GROUP_NOT_CONNECTED` in `group-connection-manager.ts`. Other services use inline strings for similar conditions.

**Recommendation:** Define a `ConnectionErrors` constants object in `@screenlink/shared` (or locally) and reference it across all services. This is purely a hygiene improvement — no behavior change.

**Non-goal:** Do not introduce an error code enum or change how errors are surfaced to the UI.

### 11.4 Inline the PendingLifecycleMessage Interface to Its Only Consumer

`PendingLifecycleMessage` is defined and used exclusively within `group-connection-manager.ts`. No other file imports it. The type can remain where it is.

**Non-goal:** No change needed.

## 12. Tests / Verification / CI Gap

### 12.1 Test Inventory

Existing tests relevant to this pipeline:

| Test File | Covers | Gaps |
|-----------|--------|------|
| `tests/stream-session-manager.test.ts` | State transitions, start/stop/restart, constraints | No Phase A/B failure isolation tests, no audio degradation tests |
| `tests/publisher-manager.test.ts` | Publish, stop, replaceTrack, audio controller | No bitrate readback/correction tests, no peerConnected handler tests |
| `tests/viewer-session.test.ts` | Join flow, pause/resume, retry, generation counter | No abort-flow test (rapid destroy while joining), no self-view path tests |
| `tests/viewer-media-binding.test.ts` | Token lifecycle, consumeBinding, pause/resume sender state | No stale-mapping-cleanup test for rejoins with different mediaSessionId |
| `tests/active-stream-registry-phase3.test.ts` | Heartbeat, tombstone, snapshot, expiry | No tombstone-cross-snapshot test, no leaseValidUntil test |
| `tests/group-message-router.test.ts` | Message routing, schema validation, join response timeout | No cross-group payload test, no viewer.status routing test |
| `tests/group-control-lifecycle-queue.test.ts` | Pending lifecycle queue, TTL, flush | No flushPendingLifecycleToPeer test, no reconnect-flush ordering test |
| `tests/group-control-transport-results.test.ts` | Broadcast results, sendToPeer | No ensureConnected timeout test |
| `tests/presenter-queue-coalesce.test.ts` | Frame coalescing | Presenter integration with ring |
| `tests/active-stream-late-join.test.ts` | Late-join discovery | N/A |
| `tests/watch-stream-flow.test.ts` | Full viewer watch flow | N/A |
| `tests/viewer-lifecycle-phase3.test.ts` | Viewer lifecycle end-to-end | N/A |
| `tests/quality-coordinator.test.ts` | Quality calculation, application | N/A |
| `tests/quality-coordinator-revision.test.ts` | Settings revision coordination | N/A |
| `tests/group-control-mesh-lifecycle.test.ts` | Mesh connect/disconnect | N/A |
| `tests/audio-ownership-regression.test.ts` | Audio controller lifecycle | No ProcessAudioController sequencing tests (ensure → port → generation → prime) |
| `tests/audio-startup-order.test.ts` | Audio startup sequencing | No combined-stream invariants test |
| `tests/audio-phase-2g.test.ts` | Audio mode switching | No mid-stream audio degradation recovery tests |
| `tests/nvidia-capture-lifecycle.test.ts` | NVIDIA capture pipeline | No enhancement-buffer double-release test |
| `tests/nvidia-vsr-backpressure-coalesce.test.ts` | VSR backpressure/coalescing | No crash-fallback-to-raw test |
| `tests/shared-memory-ring.test.ts` | Frame ring operations | No slot-exhaustion timeout test |
| `tests/video-enhancer-protocol-types.test.ts` | Enhancement protocol types | No partial-write framing test |

### 12.2 New Test Requirements (TDD)

These tests verify the invariants documented above. Two test categories exist:

**Characterization tests** capture current behavior before any hardening changes. They are written against the current codebase and must pass before any production edit is made. They serve as a safety net proving the test is valid and the behavior is understood.

**Regression tests** reproduce a specific hypothesized gap (e.g. a race, a missing guard, a timer leak). They are written to fail against the current codebase — the failure proves the gap is real. After the corresponding hardening change, the regression test passes, confirming the fix.

No production edit is made until the corresponding regression test exists and is confirmed to fail.

| Test | What It Verifies | Priority |
|------|-----------------|----------|
| SSM: Phase A failure leaves state=failed, no dangling timers | `startStream` with mock getDisplayMedia that rejects | High |
| SSM: Phase B failure does not revert Phase A success | Mock broadcast to throw, verify state=active after | High |
| SSM: destroy() while starting rejects all awaits | Call destroy() mid-startStream, verify no side effects | High |
| SSM: switchSource with destroyed session is no-op | Set destroyed=true before call, verify no SDK calls | Medium |
| PM: bitrate readback correction on mismatch | Mock sender with wrong maxBitrate, verify correction | Medium |
| PM: track-ended during switchSource is suppressed | Call detachTrackEnded, fire onended, verify no stopStream | High |
| VMB: consumeBinding with destroyed=true returns false | Set destroyed, call consumeBinding | High |
| VMB: stale mapping cleanup on rejoin with new mediaSessionId | Create mapping A, bind with mediaSessionId B, verify A deleted | High |
| VMB: sender retry stops after max attempts | Mock resolveSendersForMapping to always return false | High |
| ASR: tombstoned streams excluded from snapshot | Stop stream, call getStreamsByGroup, verify excluded | High |
| ASR: leaseValidUntil in future prevents expiry | Set lease, advance clock past expiryMs, verify stream kept | Medium |
| GCM: flushPendingLifecycleToPeer skips tombstoned streams | Tombstone stream, flush to peer, verify no broadcast | Medium |
| VS: simultaneous pause+resume+race checks generation | Fire pause, before ack fire resume, verify correct terminal state | High |
| VS: remote-track-ended during pause is no-op | Enter paused state, fire ended event, verify no stop | High |
| VS: teardown while joining abandons flow without orphan SDK | Call destroy() mid-join, verify no ViewerClient leak | High |
| VS: self-view retry exhausts without infinite loop | Set capture stream unavailable, call start, verify max retries | Medium |
| PAC: audio setup sequencing (ensure → port → generation → prime → attach) | Mock IPC calls, verify order and error cleanup | High |
| PAC: second setAudioController closes previous controller | Create two controllers, verify first.close() called | High |
| PAC: combined stream rejects dead audio track | Build with dead track, verify throws specific error | Medium |
| PM: audio controller `close()` releases port on replacement | Mock controller, call setAudioController, verify old.close | High |
| SSM: audio setup failure during restart does not fail stream | Mock IPC to reject audio, verify isAudioDegraded and state=active | High |
| VFR: frame ring slot exhaustion returns null | Exhaust all slots, verify next getSlot returns null | Medium |
| VFR: slot double-release detected/rejected | Release same slot twice, verify no corruption | Medium |
| VEP: enhancer crash falls back to raw frames | Mock enhancer exit, verify presenter renders raw frame | Medium |
| VEP: partial pipe write does not desync reader | Send partial frame, verify reader waits for complete payload | Low |

### 12.3 CI Gap and Resolution

**Current CI:** The root `pnpm test` script (defined in the root `package.json`) is `pnpm --filter @screenlink/shared test` — it runs only the shared package's tests, NOT the desktop tests that cover the host/connect/view pipeline. The GitHub release workflow (`.github/workflows/release.yml`) runs `pnpm typecheck` and `pnpm test -- --reporter=verbose`. There is no CI for the main branch on push/PR — the existing workflow is manual-only (`workflow_dispatch`). Desktop tests are therefore never run in CI today.

**Gap:** Desktop tests (the vitest suites in `apps/desktop/tests/`) are absent from CI. Regressions in the host/connect/view pipeline escape until a release is manually built.

**Resolution (in scope — Phase 10):**
- Add a `ci.yml` workflow triggered on `push` and `pull_request` to `main`.
- The workflow must use a command that runs desktop tests. Options (choose one):
  a) `pnpm --filter @screenlink/desktop exec vitest run` — desktop tests only, no build needed for unit tests.
  b) `pnpm -r test` — all workspace packages' tests.
  c) `pnpm test:all` — a new root script that covers all packages.
- The workflow uses `windows-latest`, Node 24, pnpm 10 (same as release).
- No build or packaging is necessary — typecheck + targeted test execution is sufficient.
- Packaging/release artifact workflows (`release.yml`, electron-builder config, installer scripts) remain out of scope.
- This is the single highest-ROI change for regression prevention.

### 12.4 Test Infrastructure Notes

- Tests run in Vitest with happy-dom (no real browser). SDK constructs must be mocked.
- Most services accept runtime via constructor or a global `getRuntime()` — tests should provide a mock runtime.
- VDO SDK is mocked at the module level (`@screenlink/vdo-adapter`).
- Electron APIs (`window.screenlink`) are mocked via global overrides.
- MediaStream and MediaStreamTrack are not available in happy-dom — tests use mock implementations.

## 13. Rollout Sequence

All changes are behavior-preserving — they add or tighten invariants without changing observable behavior when the invariants hold. Rollout is therefore low-risk and can proceed in any order. However, ordering by dependency minimizes churn.

### Phase 1: Test Foundation (no production code changes)

**Files to create:**
- `tests/stream-session-manager-hardening.test.ts` — Phase A/B isolation, destroy-while-starting, switch-source-destroyed
- `tests/publisher-manager-hardening.test.ts` — bitrate readback correction, track-ended suppression
- `tests/viewer-media-binding-hardening.test.ts` — destroyed guard, stale mapping cleanup, sender retry exhaustion
- `tests/active-stream-registry-hardening.test.ts` — tombstone snapshot exclusion, leaseValidUntil
- `tests/viewer-session-hardening.test.ts` — pause/resume race, teardown-while-joining, remote-ended during pause, self-view retry exhaustion
- `tests/group-connection-manager-hardening.test.ts` — flush-to-peer tombstone skip, ensureConnected timeout

Characterization tests must pass against the current codebase (proving the test is valid and the behavior is understood). Regression tests reproduce a hypothesized gap — they are written to fail against the current codebase, confirming the gap is real before any production edit.

### Phase 2: ActiveStreamRegistry Tombstone Snapshot Filter

**Files to modify:**
- `active-stream-registry.ts` — `getStreamsByGroup`, `getAllStreams`, `getStream`, `getGroupKeys`: add tombstone check in addition to `stopped` flag

**Verification:** New tombstone snapshot exclusion test passes. All existing active-stream-registry tests pass.

### Phase 3: ensureConnected Subscription (simplification)

**Files to modify:**
- `group-connection-manager.ts` — Replace polling loop with state-change subscription

**Verification:** Existing group-control tests pass. Timing-sensitive tests may need tolerance adjustment (polling was 200ms, subscription is event-driven).

### Phase 4: Stream Lifecycle Payload Builder Extraction (simplification)

**Files to modify:**
- `stream-session-manager.ts` — Extract `buildLifecyclePayload()`, replace inline constructions

**Verification:** All stream-session-manager tests pass. Payload shape verified by snapshot comparison.

### Phase 5: Defensive Check Gaps

**Files to modify:**
- `stream-session-manager.ts` — Add `destroyed` check to `switchSource`
- `publisher-manager.ts` — Add `publisher` null check to `replaceVideoTrack`
- `viewer-media-binding.ts` — Add `destroyed` check to `consumeBinding`
- `group-connection-manager.ts` — Verify `broadcast` null check (already present)

**Verification:** New tests for each guard pass. All existing tests pass.

### Phase 6: Pause/Resume Generation Coordination Verification

**Files to modify:**
- `viewer-session.ts` — Verify pause generation check in `resume()` at line 415 is sufficient for rapid pause→resume→pause sequences. Add second guard in `pause()` if needed (check `isPauseGenerationCurrent` after awaiting resumption).

**Verification:** New pause/resume race test passes. All viewer-session tests pass.

### Phase 7: Viewer Auto-Retry on Host Restart

**Files to modify:**
- `viewer-session.ts` — Extend `_autoRetried` flag to cover remote-track-ended path (host restart detection vs genuine stop)

**Verification:** New remote-track-ended-during-restart test passes. Existing viewer-session tests pass.

### Phase 8: Audio Pipeline Hardening

**Hypothesis-driven:** Each item targets a hypothesized invariant from §9.3. Write the regression test first (confirming the gap), then add the hardening guard.

**Files to modify (hypothesized):**
- `stream-session-manager.ts` — Audio sequencing guards (generation-before-prime, timeout cleanup)
- `publisher-manager.ts` — Combined-stream invariant enforcement, controller close() verification
- `ProcessAudioController.ts` — Port lifecycle leak guard, close() idempotency

**Verification:** New audio sequencing, controller replacement, and combined-stream invariant tests pass.

### Phase 9: Native Video/Frame Hardening

Merges the former separate frame-ring and video-enhancement phases into one coherent phase. Slot acquisition in `FrameRing.cpp` is also the transport substrate for enhancement frames, so making them a single phase avoids ordering bugs.

**Files to modify:**
- `native/video-frame-ring/src/FrameRing.cpp` — Add spin-limit to slot acquisition, slot-use guard to release
- `apps/desktop/src/main/SharedMemoryFrameRing.ts` — Log ring size on construction, handle null-slot return from addon
- `apps/desktop/src/main/video-enhancer-protocol.ts` — Partial-write framing guard
- `apps/desktop/src/renderer/services/...` — Enhancement crash fallback path

**Verification:** New slot-exhaustion, double-release, enhancer-crash-fallback, and partial-write tests pass. All existing frame-ring and presenter tests pass.

### Phase 10: CI Integration

**Files to create:**
- `.github/workflows/ci.yml` — push + PR to main
- Must use `pnpm --filter @screenlink/desktop exec vitest run` (or `pnpm -r test`) — NOT root `pnpm test` which only covers @screenlink/shared
- windows-latest, Node 24, pnpm 10

## 14. Concurrent-Agent Safety

Other agents are actively editing the repository in the same working tree. The following rules protect concurrent work:

1. **This file only.** This design document is the only file created by this spec. It cannot conflict with any concurrent edit by another agent.
2. **Never undo concurrent work.**
   - Never git reset, revert, checkout, stash, or otherwise discard another agent's changes.
   - Never overwrite an existing file that another agent modified.
   - Never edit a file without checking its current state first.
3. **Check before each implementation lane.** Before touching any target file in a rollout phase:
   - Run `git status` to verify the file has no uncommitted modifications from another agent.
   - If the target file IS dirty (modified by concurrent work), read the diff and either:
     a) Integrate the hardening change alongside the concurrent change without discarding either, or
     b) Defer the file to a follow-up phase that coordinates with the other lane.
   - If the target file is clean, proceed.
4. **Wire compatibility is explicitly retained.** No message format, schema, protocol version, or SDK API is changed. A hardened host must interoperate with an unhardened viewer and vice versa.
5. **New test files only.** Tests in this spec are new files — they never modify existing test files. The only exception is simplification changes (Phases 3, 4) which modify production source files — these are deferred to implementation time and MUST follow the conflict check above.
6. **CI workflow addition (Phase 10) is a new file.** It does not modify the existing `release.yml`.

## 15. References

### Source Files (Hotspots)

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/renderer/services/group-control-connection.ts` | VDO SDK data-only mesh lifecycle, HMAC envelope transfer |
| `apps/desktop/src/renderer/services/group-connection-manager.ts` | Multi-group connection ownership, pending-message queue, reconnect flush |
| `apps/desktop/src/renderer/services/group-message-router.ts` | Schema-validated dispatch, cross-group guard, response waiters, quality routing |
| `apps/desktop/src/renderer/services/stream-session-manager.ts` | One local host stream lifecycle (capture → publish → announce → stop) |
| `apps/desktop/src/renderer/services/publisher-manager.ts` | HostPublisher wrapper, combined stream, audio controller, sender diagnostics |
| `apps/desktop/src/renderer/services/viewer-session.ts` | One viewer watch lifecycle (join → bind → watch → pause → stop) |
| `apps/desktop/src/renderer/services/viewer-media-binding.ts` | Binding tokens, composite-key viewer mapping, sender resolution, pause/resume encoding |
| `apps/desktop/src/renderer/services/active-stream-registry.ts` | Global stream discovery, tombstone, heartbeat expiry, snapshot recovery |
| `packages/vdo-adapter/src/host-publisher.ts` | VDO SDK host connection, publish, codec preferences |
| `packages/vdo-adapter/src/viewer-client.ts` | VDO SDK viewer connection, view, shutdown, data channel, media.bind |
| `packages/vdo-adapter/src/codec-capabilities.ts` | Codec capability intersection, auto-order, preference application |
| `packages/vdo-adapter/src/sender-parameters.ts` | Quality parameter application with readback verification |
| `native/video-frame-ring/src/FrameRing.cpp` | C++ shared-memory slot-based ring buffer |
| `apps/desktop/src/main/SharedMemoryFrameRing.ts` | TypeScript wrapper for native frame ring addon |
| `apps/desktop/src/renderer/services/viewer-frame-timing.ts` | rVFC-based displayed FPS measurement |
| `apps/desktop/src/renderer/audio/ProcessAudioController.ts` | Renderer-side audio pipeline (MessagePort → ring buffer → AudioWorklet) |
| `apps/desktop/src/main/AudioHelperManager.ts` | Main-process audio helper lifecycle (spawn, pipe I/O, monitoring, restart) |
| `apps/desktop/src/main/video-enhancer-protocol.ts` | Main-process video enhancer control protocol |
| `apps/desktop/src/main/VideoHelperManager.ts` | Main-process video helper lifecycle |
| `native/video-enhancer/src/...` | Native video enhancement pipeline (NVIDIA VSR) |
| `apps/desktop/src/renderer/services/viewer-image-processing/` | Viewer-side image processing backends (WebGL2, NVIDIA, fallback chain) |

### Test Files

| File | What It Covers |
|------|----------------|
| `tests/stream-session-manager.test.ts` | SSM state transitions |
| `tests/publisher-manager.test.ts` | Publisher lifecycle |
| `tests/viewer-session.test.ts` | Viewer join/watch/pause/resume |
| `tests/viewer-media-binding.test.ts` | Token and mapping lifecycle |
| `tests/active-stream-registry-phase3.test.ts` | Registry lifecycle |
| `tests/group-message-router.test.ts` | Message dispatch and routing |
| `tests/group-control-lifecycle-queue.test.ts` | Pending queue and flush |
| `tests/presenter-queue-coalesce.test.ts` | Frame coalescing |
| `tests/quality-coordinator.test.ts` | Quality calculation |
| `tests/quality-coordinator-revision.test.ts` | Settings revision coordination |
| `tests/audio-ownership-regression.test.ts` | Audio controller lifecycle and ownership handoff |
| `tests/audio-startup-order.test.ts` | Audio sequencing (ensure → port → generation → prime) |
| `tests/audio-phase-2g.test.ts` | Audio mode switching and degradation |
| `tests/nvidia-capture-lifecycle.test.ts` | NVIDIA capture and enhancement pipeline |
| `tests/nvidia-vsr-backpressure-coalesce.test.ts` | VSR backpressure and frame coalescing |
| `tests/shared-memory-ring.test.ts` | Shared memory frame ring operations |
| `tests/video-enhancer-protocol-types.test.ts` | Enhancement binary protocol type safety |

### Design Documents

| File | Scope |
|------|-------|
| `docs/architecture.md` | Overall ScreenLink architecture |
| `docs/superpowers/specs/2026-06-21-audio-sharing-design.md` | Audio pipeline (separate scope, referenced for transport dependencies) |
| `docs/superpowers/specs/2026-06-27-host-viewer-information-design.md` | Host diagnostics (viewer.status messages, HostDashboard) |
