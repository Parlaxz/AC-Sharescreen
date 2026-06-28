use Subagent driven implementation and programming

Repair the pushed ScreenLink repository completely according to the exact instructions below.

Do not create a new branch or worktree.

Do not ask the user product, architecture, or implementation questions. All decisions are specified here.

Do not use the stale claims in HANDOFF.md as evidence. The current pushed code is the source of truth.

Preserve the working per-group Quick Share and Quick Join feature. Do not redesign it.

Use OMO-Slim subagents exactly as follows:

Explorer:

* Use Explorer for repository archaeology, call-path tracing, dependency tracing, test discovery, and verification before edits.
* Explorer must not invent architecture or product behavior.

Oracle:

* Use Oracle at the explicit review gates below.
* Oracle reviews correctness, lifecycle, risk, and compliance with this exact architecture.
* Oracle may identify defects, but it may not substitute a different architecture.

Fixer:

* Use Fixer for all implementation, test writing, compilation fixes, debugging, runtime defect closure, and build repair.
* Fixer must implement the exact plan below.
* Fixer must not weaken tests or silently reduce scope.

Do not finish with a plan or a question. Perform the work and return the required final report.

CURRENT AUDITED DEFECTS

Treat all of the following as confirmed defects that must be corrected:

1. HANDOFF.md is stale and contradicts the pushed tree.
2. The native video-enhancer target is internally inconsistent:

   * main.cpp references NvidiaVsrContext.
   * NvidiaVsrContext is not coherently included in the target.
   * main.cpp calls ProbeCapability.
   * CapabilityProbe.cpp is excluded from CMake.
   * main.cpp uses SimpleJson functions.
   * SimpleJson.cpp is excluded from CMake.
3. Native processing is CPU bilinear scaling, not NVIDIA VSR.
4. VideoHelperManager.submitFrame ignores every frame argument and returns false.
5. TypeScript passes full named-pipe paths while native code prepends the named-pipe prefix again.
6. TypeScript configure fields are nested in payload while native configure reads the root object.
7. TypeScript uses string mode/quality values while native reads numbers.
8. VideoHelperManager marks the helper ready without validating configure success.
9. Multiple sendCommand listeners share one socket without request correlation or serialization.
10. The renderer NVIDIA backend is a failure-only stub.
11. The factory always returns WebGL even when settings allow NVIDIA selection.
12. NVIDIA controls remain enabled despite no functional NVIDIA backend.
13. Capability augmentation mutates a cached object without reactive notification.
14. Backend selection is reported before initialization and before a frame is presented.
15. ViewerImageProcessor destroys backends asynchronously without serializing replacement.
16. Failed frames are counted as processed.
17. The required NVIDIA → FSR → Lanczos → original fallback chain is absent.
18. StreamMetricsService manufactures one-second samples from a cached rate rather than actual one-second getStats observations.
19. The viewer combines video and audio cumulative bytes into one counter and uses only video SSRC.
20. StreamMetricsService has only one baseline for all media.
21. Host diagnostics sums absolute counters from unrelated peers and feeds them as one cumulative counter.
22. Host rate calculations use Date.now rather than a monotonic clock.
23. Per-viewer histories are not populated.
24. The graph viewer selector is cosmetic.
25. Most telemetry sample fields are null or zero.
26. Ongoing paused duration is not excluded from active duration.
27. Session peak is derived only from the five-minute raw window.
28. New aggregate buckets use a future bucket-boundary end time.
29. The displayed thirty-second average is an arithmetic average of bucket averages.
30. Persistence still uses averageBytesPerSecond and bytesPerSecond with no schema version.
31. Real marker producers are missing.
32. Markers disappear when raw samples expire.
33. Marker and bucket X coordinates use incompatible relative origins.
34. Clustered markers hide all but the first event.
35. Connection Health ignores the selected viewer and selected range.
36. Tooltips show elapsed time rather than exact local time.
37. ViewerPanelShell uses a hidden fake PopoverAnchor.
38. BandwidthGraphModal retains a hidden-trigger fallback.
39. Auto-hide uses a 999999 ms timeout instead of a real lock.
40. No panel geometry tests prove centering.
41. The development, packaged, installer, and licensing paths for the video helper are incomplete.
42. Existing tests do not prove real marker production, per-viewer behavior, panel geometry, native frame transport, real VFX processing, or visible output.

PHASE A — LOCAL REPOSITORY FREEZE

Before editing, use Explorer and record the complete output of:

* git status --short
* git status
* git log -5 --oneline --decorate
* git show --format=fuller --find-renames --find-copies --stat HEAD
* git show --format=fuller --find-renames --find-copies HEAD
* git show --format=fuller --find-renames --find-copies --stat HEAD~1
* git show --format=fuller --find-renames --find-copies HEAD~1
* git diff --find-renames --find-copies HEAD~2..HEAD
* git diff
* git diff --cached
* git ls-files --others --exclude-standard
* git diff --check

Read every file changed by HEAD and HEAD~1 in full.

Read every staged, unstaged, and untracked source file in full.

Verify source-file encoding and remove any accidental BOM or mojibake only when the actual file bytes are damaged.

Do not edit until this audit is complete.

PHASE B — ORACLE GATE 1

Provide Oracle:

* repository audit
* exact current compile graph
* every getStats caller
* bandwidth ownership graph
* marker producer matrix
* panel geometry ownership
* RTX renderer-to-native call graph
* TypeScript/C++ protocol matrix
* native CMake/source consistency report
* build/package paths
* test classification

Oracle must review this exact repair plan.

Resolve any Oracle-discovered defect that does not conflict with this plan.

PHASE C — RESTORE A CLEAN BUILD BASELINE

Use Fixer.

1. Preserve Quick Share and Quick Join files and behavior.
2. Preserve working WebGL Native, Bicubic, Lanczos 3, FSR EASU/RCAS, sharpening, noise protection, compression cleanup, and debanding.
3. Repair the native video-enhancer target:

   * Remove the current inline CPU ProcessingContext from main.cpp.
   * Delete the orphaned NvidiaVsrContext.cpp if it is not the final real VFX implementation.
   * Delete orphaned SharedFrameRing files.
   * Do not leave source files present but excluded without a documented reason.
   * Add SimpleJson.cpp to CMake or replace SimpleJson with one coherent implementation.
   * Make CapabilityProbe declarations and definitions coherent.
   * Make every source referenced by main.cpp part of the target.
4. A non-VFX build must compile and report sdk-not-built.
5. Remove underscore prefixes used solely to hide unused required frame parameters by implementing their behavior.
6. Run:

   * all three TypeScript configurations
   * git diff --check
   * native video configure/build/self-test
   * existing shortcut tests
   * existing WebGL backend tests
7. Do not continue until the app and non-VFX helper build successfully.

Create commit:

fix: restore coherent desktop and video-helper build

PHASE D — CANONICAL BANDWIDTH TYPES

Modify:

* apps/desktop/src/renderer/services/bandwidth-telemetry-types.ts
* apps/desktop/src/renderer/services/stream-metrics-service.ts

Use these structures:

interface CounterIdentity {
reportId: string;
ssrc: number | null;
trackIdentifier: string | null;
mid: string | null;
}

interface MediaCounterObservation {
identity: CounterIdentity;
cumulativeBytes: number;
}

interface PeerTelemetryObservation {
timestampMs: number;
monotonicTimestampMs: number;
video: MediaCounterObservation | null;
audio: MediaCounterObservation | null;
transportCumulativeBytes: number | null;
configuredVideoBitsPerSecond: number | null;
effectiveVideoBitsPerSecond: number | null;
width: number | null;
height: number | null;
framesPerSecond: number | null;
decodedFramesPerSecond: number | null;
droppedFrames: number | null;
freezeCount: number | null;
packetsReceived: number | null;
packetsLost: number | null;
packetLossPercent: number | null;
rttMs: number | null;
jitterMs: number | null;
codec: string | null;
connectionType: "direct" | "turn" | null;
state: "playing" | "paused" | "reconnecting";
}

interface TelemetrySeriesSnapshot {
rawSamples: readonly TelemetrySample[];
mediumBuckets: readonly AggregatedBucket[];
longBuckets: readonly AggregatedBucket[];
markers: readonly TelemetryMarker[];
currentBitsPerSecond: number;
averageBitsPerSecond: number;
peakBitsPerSecond: number;
totalBytes: number;
durationMs: number;
activeDurationMs: number;
configuredBitsPerSecond: number | null;
effectiveBitsPerSecond: number | null;
state: TelemetryState;
}

interface ConnectionTelemetrySnapshot extends TelemetrySeriesSnapshot {
connectionId: string;
viewerDeviceId: string | null;
displayName: string | null;
receivedStatus: ViewerReportedStatus | null;
}

interface BandwidthSnapshot {
historyId: string;
role: "host" | "viewer";
aggregate: TelemetrySeriesSnapshot;
connections: readonly ConnectionTelemetrySnapshot[];
}

All rates are bits per second.

All cumulative values are bytes.

All chart timestamps are epoch milliseconds.

All interval calculations use monotonic milliseconds.

Remove the old flat BandwidthSnapshot shape after every consumer is migrated.

PHASE E — ONE GETSTATS OWNER

StreamMetricsService must own one service-level one-second timer.

Add:

registerConnection(input: {
historyId: string;
connectionId: string;
viewerDeviceId: string | null;
displayName: string | null;
peerConnection: RTCPeerConnection;
direction: "inbound" | "outbound";
configuredVideoBitsPerSecond?: number | null;
effectiveVideoBitsPerSecond?: number | null;
}): () => void

Add:

replaceConnectionPeer(
historyId: string,
connectionId: string,
peerConnection: RTCPeerConnection
): void

Add:

updateViewerReportedStatus(
historyId: string,
connectionId: string,
status: ViewerReportedStatus
): void

The timer must:

1. Skip a tick if the previous full polling pass is still running.
2. Call getStats exactly once for each registered RTCPeerConnection.
3. Parse inbound or outbound video and audio separately.
4. Parse selected candidate-pair transport counters separately when available.
5. Create one PeerTelemetryObservation per connection.
6. Feed the observation directly into that connection’s state.
7. Build the aggregate host sample by summing connection deltas calculated during the same tick.
8. Notify subscribers only after observations are committed.
9. Checkpoint persistence every ten completed ticks.

Viewer connection ID:

viewer:<mediaSessionId>:<peer-generation>

Host connection ID:

host:<viewerDeviceId>:<mediaPeerUuid>

Do not use display name as identity.

Modify ViewerWorkspace:

* Remove bandwidthPollRef.
* Remove its direct getDiagnostics bandwidth polling.
* Register the active viewer peer connection with StreamMetricsService.
* Read the compact bandwidth value and total from the service subscription.
* On peer replacement, call replaceConnectionPeer or unregister/register with a new generation ID.
* On pause, call setSessionState(historyId, "paused").
* On resume, call setSessionState(historyId, "playing") and force all baselines pending.
* On reconnect start, call setSessionState(historyId, "reconnecting").
* On reconnect completion, replace/rebaseline the peer and call playing.

Modify use-host-viewer-diagnostics.ts:

* Remove its direct per-peer bitrate baseline map.
* Do not calculate bitrate using Date.now.
* Register every publisher peer connection with StreamMetricsService.
* Unregister it when the viewer leaves or the peer is replaced.
* Read host-sent statistics from the connection snapshots.
* Continue merging viewer.status received information, but send it into updateViewerReportedStatus.
* Do not sum absolute counters from multiple peers.

Remove obsolete feedHostBytes and feedViewerBytes APIs after all callers are migrated.

Create commit:

fix: replace bandwidth polling with per-connection telemetry

PHASE F — CORRECT COUNTERS AND MATH

For every connection, maintain independent baseline state for:

* video
* audio
* transport

Each baseline stores:

* initialized
* identity
* previous cumulative bytes
* previous monotonic timestamp

First observation:

* initializes the baseline
* contributes zero rate
* contributes zero session bytes

Rebaseline only the affected counter when:

* report ID changes
* SSRC changes
* track identifier changes
* MID changes
* cumulative bytes decrease
* peer connection is replaced

Do not reset audio when only video changes.

Do not reset video when only audio changes.

Calculate:

deltaBytes * 8 / elapsedSeconds

Ignore nonpositive elapsed intervals.

Track:

* wall duration
* active duration
* accumulated completed pause duration
* currently active pause interval

An ongoing pause must be subtracted immediately.

Do not produce samples from stale cached rates.

Maintain an explicit running peak for:

* each connection
* aggregate host series

Session average:

total observed bits / active elapsed seconds

Thirty-second average:

actual bits transferred during the last thirty active seconds /
actual active elapsed seconds represented

Do not average bucket averages.

PHASE G — REBUILD HISTORY

Raw:

* actual one-second observations
* latest five minutes

Medium:

* five-second buckets
* latest thirty minutes

Long:

* thirty-second buckets
* full session

Each bucket must store:

* startTimestampMs
* endTimestampMs
* intervalMs
* minBitsPerSecond
* maxBitsPerSecond
* weightedAverageBitsPerSecond
* byteDelta
* latest resolution
* latest FPS
* latest state
* latest codec
* latest connection type

The bucket start and end are the actual first and last included observation timestamps.

Do not initialize the end to a future bucket boundary.

Carry every observation’s byte delta into exactly one bucket.

Use epoch timestamps in all three tiers.

PHASE H — PERSISTENCE SCHEMA V2

Replace the current persistence record with schema version 2.

Persist:

* schemaVersion: 2
* session identity
* role
* wall duration
* active duration
* total bytes
* running peak
* aggregate raw samples
* aggregate medium buckets
* aggregate long buckets
* connection snapshots/history
* markers
* status
* configured/effective values

Migrate schema-v1 records:

* bytesPerSecond becomes bitsPerSecond by multiplying by 8
* averageBytesPerSecond becomes averageBitsPerSecond by multiplying by 8
* preserve totalBytes
* assign schemaVersion 2
* do not invent unavailable video/audio/health values

Remove legacy field names after migration occurs at the load boundary.

Create commit:

fix: correct telemetry aggregation and persisted history

PHASE I — REAL MARKER PRODUCERS

Use direct calls from authoritative event owners.

ViewerWorkspace must add markers after successful events:

* pause
* resume
* reconnect started
* reconnect completed
* quality request changed
* quality request cleared
* stream switch
* requested enhancement backend changed
* effective enhancement backend changed
* enhancement fallback

The telemetry collector must add sampled-transition markers for:

* configured bitrate
* effective bitrate
* resolution
* FPS
* codec
* direct/TURN

The first sampled value establishes a comparison baseline and does not create a change marker.

Host stream ownership code must add markers for:

* preset changed
* bitrate changed
* resolution changed
* FPS changed
* codec changed
* source switched
* viewer joined
* viewer left
* direct/TURN changed
* per-viewer quality applied

Each marker must contain:

* stable random ID
* historyId
* connectionId or null
* viewerDeviceId or null
* epoch timestampMs
* type
* label
* from
* to
* detail

Do not add the same sampled marker repeatedly when the value has not changed.

Persist all markers.

PHASE J — PER-VIEWER GRAPH

Modify BandwidthGraphModal.tsx.

Select:

* snapshot.aggregate when selectedViewer is "**all**"
* the exact matching ConnectionTelemetrySnapshot otherwise

Use the selected series for:

* current
* 30-second average
* peak
* total
* hourly estimate
* duration
* throughput chart
* connection-health chart
* markers

All Viewers must show the aggregate.

A selected viewer must show only that connection.

A viewer rejoining with a new mediaPeerUuid must be a distinct connection history.

Do not merge by display name.

PHASE K — GRAPH TIMESTAMPS AND MARKERS

ChartDataPoint.time must be the absolute epoch timestampMs.

HealthDataPoint.time must be the absolute epoch timestampMs.

Recharts XAxis must use:

* type="number"
* dataKey="time"
* domain based on selected absolute time range
* a tick formatter that renders elapsed labels if desired

The tooltip must format the actual local date and time.

Marker ReferenceLine x must equal marker.timestampMs.

Do not rebase raw, medium, long, or marker series independently.

Markers must work when raw samples are empty.

Filter markers against the selected absolute domain.

Cluster events within two seconds.

Cluster tooltip must list every event in order with type, from, to, and detail.

Do not display only first marker plus a hidden count.

Connection Health must use the selected range and selected viewer.

Replace French empty-state strings with the existing application language.

Add optional graph series for:

* video
* audio
* effective sender limit
* transport estimate

Keep default display restrained:

* smoothed total
* configured target

Create commit:

feat: complete bandwidth markers and per-viewer graph

PHASE L — REAL PANEL ANCHOR

Modify:

* ViewerPanelShell.tsx
* ViewerWorkspace.tsx
* VideoControls.tsx
* popover.tsx
* BandwidthGraphModal.tsx
* ViewerSettingsPanel.tsx
* DiagnosticsPanel.tsx

Remove every hidden or fake popover trigger/anchor.

ViewerPanelShell must accept the visible controls as children and render:

<Popover open={activePanel !== null} onOpenChange={...}> <PopoverAnchor asChild> <div
   data-viewer-controls-anchor
   className="absolute inset-x-0 bottom-0"
 >
{children} </div> </PopoverAnchor>

<PopoverContent
side="top"
align="center"
collisionPadding={16}
className={...}

>

```
...
```

  </PopoverContent>
</Popover>

The anchor contains the actual visible control bar and spans the viewer width.

Widths:

* Settings: 750px
* Diagnostics: 750px
* Bandwidth: 950px
* all max-width: calc(100vw - 32px)

Use available-height maximum and ScrollArea.

Change useControlsAutoHide to:

useControlsAutoHide({
delayMs: 3000,
locked: activePanel !== null,
})

When locked:

* clear timer
* keep visible
* do not schedule another timer

Only one active panel exists.

Escape closes it.

Opening one closes the prior one.

Remove the non-contentOnly hidden-trigger fallback from BandwidthGraphModal.

Add Playwright geometry tests:

* windowed
* fullscreen
* narrow
* ultrawide
* 100%
* 125%
* 150%
* 200% simulated scaling where possible

Assert:

abs(panelCenterX - viewerCenterX) <= 2 CSS pixels

when not collision-clamped.

Create commit:

fix: anchor viewer panels to visible controls

PHASE M — TRUTHFUL RTX CAPABILITY

Use these exact CMake controls:

* SCREENLINK_ENABLE_NVIDIA_VFX
* NVIDIA_VFX_SDK_ROOT
* NVIDIA_VFX_MODEL_DIR

Default SCREENLINK_ENABLE_NVIDIA_VFX to OFF unless a valid SDK root is explicitly supplied.

Non-VFX build behavior:

* helper compiles
* --capabilities returns available=false
* reason=sdk-not-built
* no bilinear or other resize is reported as VSR
* NVIDIA processing requests fall back to WebGL

Capability reasons:

* unsupported-os
* unsupported-architecture
* not-nvidia
* unsupported-gpu
* driver-too-old
* helper-missing
* helper-failed
* sdk-not-built
* runtime-missing
* model-missing
* effect-creation-failed
* incompatible-runtime

Replace mutable cached capability augmentation with a small external store:

* getSnapshot()
* subscribe()
* probe()
* invalidate()

Use useSyncExternalStore in React.

Disable the NVIDIA option and NVIDIA controls when capability is unavailable.

Show the exact reason.

Do not remove the user’s persisted request.

PHASE N — CONTROL PROTOCOL

Use this exact request:

interface VideoEnhancerRequest {
id: string;
protocolVersion: string;
sessionId: string;
authToken: string;
command:
| "hello"
| "capabilities"
| "configure"
| "frameAvailable"
| "flush"
| "stats"
| "shutdown";
payload: Record<string, unknown>;
}

Use this exact response:

interface VideoEnhancerResponse {
id: string;
success: boolean;
result?: Record<string, unknown>;
error?: {
code: string;
message: string;
};
}

Implement the identical shape in TypeScript and C++.

Use string enums on both sides for:

* processingMode
* qualityLevel
* pixelFormat
* outputMode

Pass bare pipe names to the helper.

Add the \.\pipe\ prefix exactly once inside each process’s pipe-opening helper.

VideoHelperManager must use:

* one socket data dispatcher
* newline-delimited parsing
* one FIFO control-command queue
* one active command at a time
* request ID matching
* five-second timeout
* rejection of mismatched response IDs

Do not attach one data listener per command.

Do not set state ready unless:

* hello succeeds
* configure succeeds
* the response ID matches
* the helper confirms applied configuration

Create commit:

fix: unify video-enhancer protocol and lifecycle

PHASE O — PERSISTENT BOUNDED FRAME TRANSPORT

Use one persistent named frame-pipe connection for the entire helper session.

Do not reconnect for each frame.

Use the existing FrameHeader concept, corrected to include:

* magic
* headerSize
* wireVersion
* session hash or authenticated session identifier
* generation
* frameSequence
* capturedAtUs
* inputWidth
* inputHeight
* inputStride
* pixelFormat
* requestedOutputWidth
* requestedOutputHeight
* processingMode
* qualityLevel
* payloadBytes
* resultCode
* processingTimeUs

Implement readExact and writeAll loops on both Node and C++ sides.

Validate:

* magic
* header size
* version
* generation
* sequence
* dimensions
* stride
* format
* payload bytes
* output bytes
* integer multiplication overflow
* maximum 4K allocation

Use one frame in native inference.

Use at most one latest pending frame in the renderer.

Newest frame wins.

Reuse native input and output vectors/buffers after dimensions stabilize.

Do not allocate new full-frame vectors for every frame.

Implement VideoHelperManager.submitFrame using all arguments.

It must:

* write header
* write input bytes
* read result header
* read output bytes
* validate generation and sequence
* return the output and timings

PHASE P — RENDERER CPU-STAGING PATH

Use VideoFrame constructed from the HTMLVideoElement and VideoFrame.copyTo when supported by the exact Electron/Chromium version.

Use reusable RGBA or BGRA ArrayBuffer storage.

Close VideoFrame resources after copying.

Fallback order for extraction only:

1. VideoFrame.copyTo
2. ImageBitmap/OffscreenCanvas
3. measured canvas readback

Do not Base64-encode frames.

Expose through preload:

videoEnhancer.probeCapability()
videoEnhancer.start(config)
videoEnhancer.submitFrame(frame)
videoEnhancer.reconfigure(config)
videoEnhancer.flush()
videoEnhancer.stop()

Use ipcRenderer.invoke for submitFrame only with exactly one invocation in flight.

Do not queue invocation promises.

Return the native output ArrayBuffer.

Present output through the NVIDIA backend canvas.

Keep the original video element as the audio and decoded-frame source.

Do not hide the original visual until the first processed output is successfully drawn.

PHASE Q — REAL NVIDIA VFX

Replace the stub backend with a real NvidiaVsrViewerImageBackend.

Create native:

* NvidiaVfxContext.h
* NvidiaVfxContext.cpp
* CapabilityProbe.h
* CapabilityProbe.cpp

When SCREENLINK_ENABLE_NVIDIA_VFX=ON:

* include real NVIDIA Video Effects headers
* link the required NVIDIA VFX and NvCV libraries
* discover runtime DLLs
* use NVIDIA_VFX_MODEL_DIR
* create the actual effect
* configure only parameters proven by the installed SDK
* bind real NvCVImage input and output
* load the effect
* run the effect
* use the SDK error-string function
* destroy every SDK resource

Use the installed official SDK sample to obtain the exact VSR selector and supported parameter names.

Do not guess selectors.

Do not implement bilinear, bicubic, Lanczos, CUDA-only, or NPP-only resize as VSR.

NPP/CUDA may only perform staging and format conversion.

Capability available=true only after:

* runtime loads
* model path exists
* effect creation succeeds
* required settings are accepted
* effect load succeeds

Expose supportedModes and supportedQualities from actual capability.

Disable unsupported direct controls.

PHASE R — SERIALIZED BACKEND CONTROLLER

Make backend switching one awaited operation:

1. stop scheduling frames
2. increment generation
3. flush pending work
4. await old backend.destroy()
5. select candidate backend
6. initialize candidate
7. apply settings
8. resume
9. wait for first successful presented frame
10. report it active

Do not call onBackendChange before first presentation.

Track separately:

* requested backend
* active backend
* fallback backend
* fallback reason
* helper state
* first successful presentation timestamp

Increment processed count only after success.

Track:

* submitted
* completed
* presented
* failed
* processor-coalesced
* native-backpressure-dropped
* stale-discarded
* fallback count

PHASE S — FALLBACK ORDER

Implement this exact ordered chain:

1. NVIDIA RTX Video
2. WebGL FSR 1 EASU using current post-processing controls
3. WebGL Lanczos 3 using current post-processing controls
4. original unprocessed video

Apply it for:

* unavailable capability
* startup failure
* configure failure
* extraction failure
* repeated processing failure
* helper timeout
* helper crash
* WebGL context loss

Do not permanently fall back after one isolated transient frame.

Use three consecutive native processing failures as the runtime failure threshold.

Use at most three helper restarts with delays:

* 1 second
* 4 seconds
* 15 seconds

After that, remain on WebGL and show the stable reason.

Create enhancement fallback markers.

Create commit:

feat: complete bounded NVIDIA video-processing pipeline

PHASE T — BUILD AND PACKAGING

Update the normal development launcher to:

1. build audio helper
2. configure/build non-VFX or VFX video helper
3. run native self-tests
4. clearly print separate results
5. launch the desktop app

Never print generic “native helper built” when only audio succeeded.

Update production build scripts.

Add packaged helper to electron-builder extraResources at:

screenlink-video-enhancer.exe

Use one helper-path resolver for:

* capability probe
* VideoHelperManager
* diagnostics
* packaged runtime

Test:

* development path
* packaged path
* missing helper
* path with spaces
* non-ASCII path
* stale helper version

Add installer/uninstaller/update layout handling.

Document every NVIDIA-distributed artifact:

* filename
* version
* source
* checksum
* license
* redistribution status

Do not package NVIDIA runtime or model files until redistribution rights are verified.

Create commit:

build: integrate and validate video-enhancer packaging

PHASE U — REQUIRED TESTS

Add tests for every item below.

Bandwidth:

* one getStats call per PC per tick
* no independent ViewerWorkspace poll
* no independent host diagnostics poll
* first sample baseline
* separate video/audio baselines
* one counter reset does not reset the other
* SSRC/report/track/MID changes
* peer replacement
* transport counters
* irregular 800/1200/2500 ms intervals
* active average
* current ongoing pause
* running peak beyond five minutes
* partial bucket duration
* no boundary byte loss
* schema-v1 migration
* schema-v2 persistence
* host aggregate
* selected viewer
* viewer leave
* viewer rejoin
* independent histories

Markers:

* pause
* resume
* reconnect start
* reconnect completion
* quality request
* effective bitrate
* resolution
* FPS
* codec
* direct/TURN
* stream switch
* source switch
* enhancement request
* active enhancement backend
* enhancement fallback
* viewer join
* viewer leave
* per-viewer quality application
* duplicate suppression
* persistence
* long-range visibility
* cluster details
* selected-viewer filtering

Graph:

* absolute timestamp domain
* exact local tooltip time
* 60s
* 5m
* 30m
* Session
* health range filtering
* aggregate versus viewer filtering
* null values not shown as zero

Panels:

* one active panel
* Escape
* keyboard toggles
* no overlay
* no hidden trigger
* auto-hide lock
* settings geometry
* diagnostics geometry
* bandwidth geometry
* windowed
* fullscreen
* narrow
* ultrawide
* DPI/scaling simulations

Protocol/native:

* matching request IDs
* command queue
* mismatched ID rejection
* payload parsing
* string enum parsing
* authentication
* configure failure prevents ready state
* bare pipe-name normalization
* partial read/write
* invalid header
* invalid stride
* oversized frame
* stale generation
* stale sequence
* one frame in flight
* newest frame
* reusable buffers
* timeout
* crash cleanup
* no orphan process

RTX:

* truthful unavailable state
* NVIDIA controls disabled when unavailable
* live capability notification
* actual backend selection
* serialized backend swap
* no early active report
* first-frame activation
* failed frame not counted processed
* helper crash fallback
* exact fallback order
* native output presentation

Real VFX integration when SDK exists:

* known input checksum
* real effect invocation
* output dimensions
* output checksum differs
* visible comparison screenshot
* 480p15 to 1080p
* 720p30 to 1080p
* low/high quality comparison
* helper termination
* recovery
* fullscreen
* stream switch

Quick Actions regression:

* Quick Share from tray
* Quick Join from tray
* persistence
* unregister on exit

PHASE V — ORACLE REVIEWS

Oracle Gate 2 after bandwidth and panels:

Provide:

* collector ownership map
* mathematical tests
* persistence schema
* marker producer matrix
* per-viewer tests
* graph screenshots
* DOM center measurements

Resolve all material issues.

Oracle Gate 3 after RTX transport:

Provide:

* protocol matrix
* frame path
* lifecycle tests
* output presentation path
* fallback tests
* build integration

Resolve all material issues.

Oracle Gate 4 after real VFX or truthful external block:

Provide:

* SDK API call path
* capability output
* input/output checksums
* screenshots
* timing metrics
* helper package paths
* licensing status

Resolve all material issues.

PHASE W — FINAL VALIDATION

Run and record:

* git diff --check
* shared build and tests
* VDO adapter build and tests
* desktop main tests
* preload tests
* renderer tests
* full desktop test command
* every TypeScript build
* lint
* audio-helper configure/build/self-test
* video-enhancer configure/build/self-test with VFX disabled
* video-enhancer configure/build/self-test with VFX enabled when SDK exists
* run-desktop.bat
* two-instance development launch
* production desktop build
* packaged helper discovery
* installer build

Do not call a failure pre-existing without reproducing it on HEAD~1.

Perform manual validation:

* stable bandwidth across all ranges
* two-viewer selection
* viewer leave without stopping the other
* every marker type that can be manually triggered
* all three centered panels
* fullscreen
* Windows scaling
* Quick Share
* Quick Join
* helper crash fallback
* RTX visual output when SDK is available

PHASE X — FINAL COMMIT AND REPORT

Update HANDOFF.md only after validation.

Do not retain stale completion claims.

Return:

* starting branch and SHA
* ending SHA
* commits created
* initial Git state
* final Git state
* files added
* files modified
* files removed
* full defect-resolution matrix
* bandwidth ownership architecture
* telemetry unit contract
* persistence schema
* marker producer locations
* per-viewer behavior
* panel geometry measurements
* protocol schema
* frame transport
* renderer extraction method
* actual NVIDIA APIs used
* capability result
* input/output checksums
* timing p50/p95/max
* fallback results
* build commands and exact results
* test commands and exact counts
* manual validation
* package/installer validation
* licensing status
* Oracle findings from all gates
* known external blockers
* clean final git status

Do not end with “scaffolding complete,” “mostly complete,” a question, or a proposed next step.

A missing NVIDIA SDK may block only the real VFX execution proof and distributable NVIDIA artifacts. It does not permit leaving the protocol, frame transport, renderer extraction, output presentation, truthful unavailable state, fallback, build integration, markers, per-viewer graph, bandwidth math, or panel geometry unfinished.
