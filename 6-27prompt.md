use Subagent driven implementation and programming

Repair and fully complete the failed ScreenLink bandwidth/graph and NVIDIA RTX Video Super Resolution implementations.

The Quick Share and Quick Join shortcut feature is reported working. Preserve it and run regression tests, but do not redesign it.

Do not create a new branch or worktree unless explicitly instructed outside this prompt.

This is not a request to continue the previous agents’ checklist mechanically. Their completion claims are untrusted. Diagnose the actual repository state, prove each runtime path, remove false implementations, and deliver working behavior.

Do not ask the user to choose the next step. Execute the full task and return a deliverable.

NON-NEGOTIABLE RULES

* Do not trust comments, filenames, UI labels, test names, or previous reports as proof.
* Do not call ordinary bilinear, bicubic, Lanczos, CUDA, or NPP resizing NVIDIA VSR.
* Do not silence unused functional parameters with underscore prefixes.
* Do not declare a backend active until one processed output frame is visibly presented.
* Do not keep two bandwidth systems active.
* Do not use a hidden PopoverTrigger to fake centering.
* Do not declare visual success from component unit tests.
* Do not classify an error in these features as “pre-existing” without proving it reproduces on the parent commit.
* Do not weaken tests to fit broken behavior.
* Do not leave placeholder controls enabled.
* Do not report completion from mocked tests.
* Preserve unrelated behavior and the functioning per-group shortcuts.
* Prefer the simplest direct architecture that satisfies the requirements.

PHASE 0 — FREEZE AND AUDIT THE REAL REPOSITORY STATE

Do not edit code during this phase.

Use an Explorer subagent dedicated only to repository archaeology.

Record:

* current branch
* current HEAD SHA
* HEAD~1 SHA
* HEAD~2 SHA
* staged changes
* unstaged changes
* untracked files
* ignored generated native files relevant to this work

Run and retain the complete output of:

* git status --short
* git status
* git log -5 --oneline --decorate
* git show --format=fuller --find-renames --find-copies --stat HEAD
* git show --format=fuller --find-renames --find-copies HEAD
* git show --format=fuller --find-renames --find-copies --stat HEAD~1
* git show --format=fuller --find-renames --find-copies HEAD~1
* git diff --find-renames --find-copies HEAD~2..HEAD
* git diff --stat
* git diff
* git diff --cached
* git ls-files --others --exclude-standard
* git diff --check

Read every file changed by HEAD and HEAD~1 in full.

Read every currently modified, staged, or untracked source file in full.

Specifically determine:

* Whether the bandwidth, RTX, and shortcut work is committed or only present in the working tree.
* Whether preload/index.ts was rewritten wholesale.
* Whether any pre-existing preload API disappeared.
* Whether multiple versions of settings, protocols, or backend interfaces coexist.
* Whether generated native files are mistakenly tracked.
* Whether any source file has encoding damage.
* Whether the previous agents overwrote unrelated work.

Produce a file-by-file audit before editing.

PHASE 1 — PARALLEL EXPLORER INVESTIGATION

Launch separate Explorer subagents in parallel.

EXPLORER A — BANDWIDTH DATA FLOW

Trace every runtime path involving:

* RTCPeerConnection.getStats
* createBandwidthTracker or equivalent
* StreamMetricsService
* viewer bandwidth pill
* graph history
* host sender stats
* per-viewer stats
* viewer status reports
* connection diagnostics
* persistence
* completed history
* markers
* pause/reconnect state

For every getStats call, report:

* owner
* polling interval
* connection being polled
* statistics selected
* units produced
* baseline owner
* consumers

Answer explicitly:

* Is any connection polled more than once?
* Are bits and bytes mixed?
* Are raw and aggregated histories in the same unit?
* Are Date.now and performance.now values mixed?
* Is history based on actual cumulative counters or repeated cached rates?
* Are video and audio collected independently?
* Are transport counters separate from RTP payload counters?
* Is there one baseline per peer connection and SSRC?
* Does pause state reach telemetry?
* Does reconnect rebaseline?
* Does the selected viewer alter the displayed data?
* Which compatibility APIs remain live?

EXPLORER B — BANDWIDTH MATHEMATICS AND PERSISTENCE

Audit:

* first-sample behavior
* counter resets
* SSRC changes
* elapsed-time calculations
* active duration
* wall duration
* session totals
* 30-second average
* EWMA
* peaks
* five-second aggregation
* thirty-second aggregation
* bucket boundary deltas
* history retention
* persistence schema
* history migration
* checkpoint behavior

Construct numerical examples proving whether each calculation is correct.

Use irregular intervals such as:

* 800 ms
* 1,200 ms
* 2,500 ms
* partial final bucket
* pause during a bucket
* counter reset between buckets

EXPLORER C — MARKER PRODUCERS AND RENDERING

List every marker type in the type system.

For each type, identify:

* actual producer
* authoritative event
* history/session ID
* timestamp clock
* duplicate suppression
* persistence behavior
* rendering path
* selected-viewer filtering

Do not count a union member or rendering component as a producer.

Trace markers through:

event → service method → storage → snapshot → range filter → cluster → Recharts reference → tooltip

Prove why current markers are absent or incorrectly positioned.

EXPLORER D — VIEWER PANEL GEOMETRY

Trace:

* Settings trigger
* Diagnostics trigger
* Bandwidth trigger
* Popover root
* trigger/anchor
* content portal
* collision boundary
* viewer-stage container
* bottom control bar
* fullscreen container
* open-state ownership
* auto-hide lock

Identify:

* hidden triggers
* zero-sized anchors
* hardcoded translations
* independent booleans
* open-state races
* overlay or dialog remnants
* fullscreen coordinate changes
* Windows scaling risks

EXPLORER E — RTX RENDERER PATH

Trace one frame from:

HTMLVideoElement
→ frame callback
→ frame extraction
→ backend
→ preload
→ IPC
→ main process
→ helper manager
→ binary transport
→ native input
→ actual processing
→ native output
→ main process
→ renderer
→ canvas
→ visible presentation

At every boundary state:

* exact function
* argument types
* ownership
* copy
* allocation
* asynchronous operation
* generation check
* failure behavior

Mark every missing edge.

EXPLORER F — RTX CONTROL PROTOCOL

Compare TypeScript and C++ message schemas field by field.

Audit:

* command envelope
* payload nesting
* protocol version
* session ID
* authentication token
* request ID
* response ID
* configure fields
* mode type
* quality type
* pixel format
* dimensions
* diagnostics
* error response
* shutdown response

Produce a compatibility matrix showing every mismatch.

Inspect whether concurrent commands on one socket can consume each other’s responses.

EXPLORER G — NATIVE IMPLEMENTATION

Inspect all native video-enhancer files.

Search for:

* stub
* placeholder
* TODO
* FIXME
* future phase
* bilinear
* NPP
* fake headers
* SDK-less
* hardcoded capability
* always unavailable
* unused frame ring
* per-frame vector allocation
* static 4K buffers
* missing cleanup
* integer overflow
* unchecked stride
* unchecked payload size

Determine:

* Whether actual NVIDIA VFX headers are used.
* Whether actual VFX libraries are linked.
* Whether an actual effect is created.
* Whether the model path is set.
* Whether NvCVImage buffers are bound.
* Whether the effect is loaded.
* Whether NvVFX_Run is called.
* Whether errors use the SDK error-string function.
* Whether any CUDA/NPP operation is being mislabeled as VSR.

EXPLORER H — BUILD, PACKAGING, AND TESTS

Trace:

* run-desktop.bat
* native helper build scripts
* root package scripts
* desktop package scripts
* CMake configuration
* electron-builder configuration
* extraResources
* packaged helper resolution
* installer
* uninstall
* update layout
* third-party notices

Audit every bandwidth and RTX test.

Classify tests as:

* pure unit
* mocked integration
* process integration
* native integration
* real VFX integration
* UI geometry
* real-machine manual

Identify every behavior that currently has no meaningful test.

ORACLE GATE 1 — ROOT-CAUSE REVIEW

After all Explorer reports, invoke Oracle.

Provide Oracle:

* complete commit and working-tree audit
* bandwidth ownership graph
* mathematical examples
* marker producer matrix
* panel geometry graph
* RTX frame graph
* protocol compatibility matrix
* native SDK audit
* build/package audit
* test classification

Oracle must decide:

* which previous code is correct and reusable
* which code must be removed
* which compatibility layers must be retired
* the single bandwidth owner
* the exact timestamp contract
* the exact panel-anchor design
* whether the existing native transport is salvageable
* whether a real VFX SDK build is currently possible
* the minimum correct renderer/native architecture

Do not begin broad implementation before Oracle completes this review.

PHASE 2 — RESTORE A TRUSTWORTHY BUILD BASELINE

Use Fixer.

Before feature work:

* Restore all missing preload APIs.
* Resolve TypeScript errors properly.
* Do not prefix functional parameters with underscores merely to compile.
* Preserve Quick Share and Quick Join.
* Run shortcut regression tests.
* Ensure existing WebGL Native, Bicubic, Lanczos, and FSR modes still work.
* Remove accidentally duplicated type definitions.
* Reconcile incompatible processor constructor generations.
* Make git diff --check pass.

The application must launch before proceeding.

PHASE 3 — REPLACE BANDWIDTH WITH ONE AUTHORITATIVE COLLECTOR

Use one collector per active peer connection.

The collector must call getStats once per sampling interval and produce one complete observation.

For a viewer, collect:

* inbound video bytes
* inbound audio bytes
* optional candidate-pair transport bytes
* video SSRC
* audio SSRC
* width
* height
* received FPS
* decoded FPS when distinct
* dropped frames
* freeze count where available
* packets received
* packets lost
* jitter
* RTT
* codec
* direct/relay state
* configured bitrate
* effective bitrate
* playback state

For a host, collect separately for every viewer sender connection:

* outbound video bytes
* outbound audio bytes
* sender SSRC
* configured/effective bitrate
* resolution
* FPS
* codec
* RTT
* direct/relay state
* viewer-reported received state where available

Use a stable connection ID, not display name.

Remove the legacy viewer tracker after every consumer is migrated.

Remove compatibility methods after proving no consumer remains.

Do not let the graph, compact bandwidth pill, and diagnostics independently poll the same connection.

CANONICAL UNITS

Use:

* rate: bits per second
* cumulative traffic: bytes
* wall timestamps: epoch milliseconds
* interval calculations: monotonic milliseconds

Required explicit names:

* videoBitsPerSecond
* audioBitsPerSecond
* mediaBitsPerSecond
* transportBitsPerSecond
* configuredVideoBitsPerSecond
* effectiveVideoBitsPerSecond
* cumulativeVideoBytes
* cumulativeAudioBytes
* cumulativeTransportBytes
* timestampMs
* monotonicTimestampMs
* intervalMs

No rate value may be displayed as KB/s or MB/s.

Display rate as:

* kbps below 1 Mbps
* Mbps at or above 1 Mbps

Display totals as:

* KB
* MB
* GB

BASELINE RULES

First observation:

* records counters
* records identities
* records monotonic time
* contributes zero throughput
* contributes zero session bytes

Rebaseline independently for audio and video when:

* counter decreases
* SSRC changes
* sender/receiver changes
* peer connection changes
* source replacement recreates counters
* reconnect recreates counters

Do not lose unaffected media when only one counter resets.

PAUSE RULES

Track:

* wall duration
* active duration
* current pause start
* accumulated pause duration

An ongoing pause must be included when calculating current active duration.

No stale rate may be repeated during a pause.

A deliberate pause does not inject artificial zero samples into active average.

AVERAGES

Session active average:

total observed bits / active elapsed seconds

Thirty-second average:

sum of actual bits transferred in the last thirty seconds / actual active interval duration

Do not average averages.

PEAK

Maintain an explicit running session peak.

Do not derive session peak only from retained raw history.

PHASE 4 — REBUILD HISTORY AND PERSISTENCE

Use:

* one-second raw observations for five minutes
* five-second aggregates for thirty minutes
* thirty-second aggregates for full session

Every aggregate contains:

* startTimestampMs
* endTimestampMs
* intervalMs
* minBitsPerSecond
* maxBitsPerSecond
* weightedAverageBitsPerSecond
* byteDelta
* latest metadata
* state transitions

Compute weighted average from bits and elapsed duration.

Preserve cross-boundary byte deltas.

All bucket timestamps are epoch timestamps.

Monotonic values must never be placed in timestampMs fields.

Persist:

* complete session totals
* running peak
* aggregates
* markers
* relevant metadata
* schema version

Add migrations for old byte-rate history or discard incompatible incomplete records explicitly.

Do not silently reinterpret old byte rates as bit rates.

PHASE 5 — IMPLEMENT REAL EVENT MARKERS

Wire authoritative producers.

Viewer markers:

* pause after successful pause
* resume after successful resume
* reconnect started
* reconnect completed
* quality request changed
* effective bitrate changed
* resolution changed after baseline
* FPS changed after baseline
* codec changed after baseline
* direct/relay transition
* stream/source switch
* requested enhancement backend changed
* active enhancement backend changed
* enhancement fallback

Host markers:

* preset changed
* bitrate changed
* resolution changed
* FPS changed
* codec changed
* source switched
* viewer joined
* viewer left
* direct/relay transition
* per-viewer quality applied

For sampled values:

* establish initial baseline
* normalize value
* emit only on actual change
* suppress repeated markers

Store markers using absolute epoch timestampMs.

Use stable marker IDs.

Persist markers.

MARKER RENDERING

Use one absolute timestamp X domain for:

* raw samples
* five-second buckets
* thirty-second buckets
* markers

Markers must work in:

* 60 seconds
* 5 minutes
* 30 minutes
* Session

Do not require raw samples to exist.

Cluster markers occurring within two seconds.

Cluster UI must list every event in the cluster.

PHASE 6 — COMPLETE PER-VIEWER GRAPH BEHAVIOR

All Viewers:

* chart uses aggregate sender rate
* summary uses aggregate rate and total
* peak is peak aggregate
* viewer count is real

Selected Viewer:

* chart changes to that viewer
* summary changes to that viewer
* health changes to that viewer
* markers filter to that viewer where applicable
* received-status report reflects that viewer

Do not combine viewers by display name.

Handle viewer leave and rejoin as distinct connection identities.

PHASE 7 — REBUILD THE GRAPH ON THE CANONICAL MODEL

Time ranges:

* 60 seconds
* 5 minutes
* 30 minutes
* Session

All ranges use bits per second.

No range switch may change the apparent value by a factor of eight.

Default:

* smoothed total media rate
* configured target

Optional:

* raw total
* video
* audio
* effective sender limit
* transport estimate

Summary:

* current
* weighted thirty-second average
* running session peak
* session total
* estimated usage per hour
* wall-clock duration
* active duration where useful

Tooltip:

* exact local date/time
* total rate
* video rate
* audio rate
* target
* effective limit
* cumulative bytes
* resolution
* FPS
* loss
* RTT
* jitter
* codec
* connection type
* state

Unavailable values remain null and are omitted or shown as an em dash.

Connection Health must respect:

* selected time range
* selected viewer
* exact timestamp domain

PHASE 8 — REBUILD THE VIEWER PANEL ARCHITECTURE

Create one authoritative state:

activePanel:

* null
* settings
* diagnostics
* bandwidth

Opening one closes the previous panel.

Escape closes the active panel.

Viewer-control auto-hide is disabled whenever activePanel is not null.

Do not use a huge timeout as a panel lock.

Use the original settings-cog popover visual pattern.

All three panels:

* no overlay
* no dimming
* no Dialog
* no Sheet
* appear above the viewer controls
* use the same center anchor
* use consistent animation and surface styling

Expose and use a real PopoverAnchor from the Watermelon/Radix wrapper.

Place one visible-layout anchor at the horizontal center of the viewer stage or control bar.

Do not use:

* hidden trigger
* opacity-zero button
* zero-size trigger
* arbitrary translate values
* separate fake center triggers

Widths:

* Settings: approximately 750 px
* Diagnostics: approximately 750 px
* Bandwidth: approximately 950 px
* maximum: calc(100vw - 32px)

Use ScrollArea and an available-height maximum.

GEOMETRY VALIDATION

Measure bounding rectangles.

When not collision-clamped:

abs(panelCenterX - viewerCenterX) <= 2 CSS px

Validate:

* windowed
* fullscreen
* narrow window
* ultrawide
* 100% scaling
* 125% scaling
* 150% scaling
* 200% scaling

Capture screenshots or report measured rectangles.

PHASE 9 — RESET RTX TO A TRUTHFUL STATE

Before implementing real processing:

* Remove or quarantine fake VSR behavior.
* Remove CPU bilinear code from the NVIDIA-success path.
* Remove SDK-less fake headers from the functional VFX build.
* Remove no-op submitFrame.
* Remove “active NVIDIA” states based only on selection or GPU presence.
* Disable unsupported RTX controls until capability is proven.
* Preserve WebGL fallback.

The UI may truthfully display:

Requested: NVIDIA RTX Video
Active: WebGL FSR
Reason: VFX SDK build/runtime/model unavailable

It may not display NVIDIA as active before a processed frame is presented.

PHASE 10 — UNIFY THE CONTROL PROTOCOL

Choose one exact JSON envelope and use it on both sides.

Recommended shape:

* id
* command
* protocolVersion
* sessionId
* authToken
* payload

Every request has a unique ID.

Every response contains:

* matching ID
* success
* result or error
* native error code
* native error message

Implement either:

* one serialized command queue, or
* request-ID correlation with one socket data dispatcher

Do not attach one independent data listener per command.

Reconcile field types exactly.

Use string enums or numeric enums, not both.

Validate:

* protocol version
* authentication
* dimensions
* mode
* quality
* pixel format
* output mode

Do not mark helper ready unless hello and configure both return successful validated responses.

PHASE 11 — IMPLEMENT REAL NVIDIA VFX PROCESSING

A functional NVIDIA build must use the actual NVIDIA Video Effects SDK.

At minimum, verify the installed SDK’s official sample and use the correct equivalents of:

* NvVFX_CreateEffect
* NvVFX_SetString for model directory where required
* NvVFX_SetU32 / NvVFX_SetF32 for supported parameters
* NvVFX_SetImage for input and output NvCVImage
* NvVFX_Load
* NvVFX_Run
* NvCV_GetErrorStringFromCode
* NvVFX_DestroyEffect

Verify exact VSR selector and mode/quality parameters against the installed SDK version and official sample.

Do not guess selectors.

Do not use NPP resizing as the effect.

NPP/CUDA may be used only for:

* format conversion
* staging
* copying
* GPU buffer management

CAPABILITY MEANS EFFECT-CREATION CAPABILITY

available=true requires:

* supported Windows/x64
* NVIDIA adapter
* acceptable driver
* VFX-enabled helper build
* runtime DLLs load
* model directory exists
* real effect creation succeeds
* required parameters are accepted
* NvVFX_Load succeeds

Report exact reason otherwise:

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

PHASE 12 — REPLACE THE FAKE FRAME RING WITH REAL BOUNDED TRANSPORT

The existing process-local ring is not cross-process shared memory.

Either:

A. Implement a real named shared-memory mapping with validated slot ownership and signaling.

Or:

B. Use one persistent bounded binary frame pipe for the initial CPU-staging proof.

Oracle must approve the simpler correct option.

Requirements:

* no JSON frame payloads
* no Base64
* no unbounded invoke queue
* no per-frame process connection
* no per-frame large vector allocation
* one frame in native inference
* at most one latest pending frame
* newest frame wins
* reusable input/output storage
* generation and sequence attached
* strict header and payload validation

Validate:

* magic
* header size
* wire version
* session identity
* generation
* sequence
* width
* height
* stride
* pixel format
* payload size
* output dimensions
* multiplication overflow
* maximum allocation

PHASE 13 — COMPLETE RENDERER FRAME EXTRACTION

Verify the exact Electron/Chromium version.

Use the simplest supported reusable path.

Investigate in this order:

1. VideoFrame from HTMLVideoElement with copyTo into reusable RGBA/BGRA storage.
2. ImageBitmap/OffscreenCanvas.
3. Measured canvas readback fallback.

Requirements:

* use actual decoded source dimensions
* process only new decoded frames
* close VideoFrame/ImageBitmap resources
* reuse buffers
* preserve aspect ratio
* instrument extraction time
* do not queue frames
* do not obscure original video until first successful output

PHASE 14 — COMPLETE OUTPUT RETURN AND PRESENTATION

Native output must return:

* generation
* sequence
* width
* height
* stride
* pixel format
* output bytes or shared output slot
* native processing timings

Renderer must:

* reject stale generation
* reject stale sequence
* upload output to a visible surface
* present it in the viewer
* preserve original video audio
* preserve fullscreen
* preserve resize
* preserve mute and volume
* preserve stream quality state

NVIDIA becomes active only after successful visible presentation.

PHASE 15 — REPAIR PROCESSOR LIFECYCLE

Backend swap must be serialized:

1. stop scheduling
2. increment generation
3. flush old pending work
4. await old backend destruction
5. create new backend
6. initialize
7. apply settings
8. resume
9. mark active only after first presented output

Correct statistics:

* submitted
* completed
* presented
* failed
* processor-coalesced
* native-backpressure-dropped
* stale-discarded
* fallback count

Do not count a failed frame as processed.

Design requestVideoFrameCallback scheduling so dropped decoded frames can be measured or clearly document what can and cannot be observed.

PHASE 16 — IMPLEMENT THE FULL FALLBACK CHAIN

Fallback order:

1. NVIDIA RTX Video
2. WebGL FSR
3. WebGL Lanczos
4. original video

Handle:

* capability unavailable
* initialization failure
* configure failure
* frame extraction failure
* repeated processing failure
* helper timeout
* helper crash
* WebGL context loss

Use bounded retry and restart behavior.

Do not fall back permanently from one isolated transient frame unless the error is unrecoverable.

Create enhancement backend/fallback graph markers.

PHASE 17 — BUILD AND PACKAGING

Development launcher must:

* build audio helper
* build VFX-enabled video helper when SDK prerequisites exist
* clearly report unavailable prerequisites
* never claim “native helper built” when only audio built
* launch the application successfully

CMake must:

* explicitly discover VFX headers and libraries
* fail or produce an unavailable non-VFX build truthfully
* use /W4 /WX
* link required libraries
* define model/runtime paths explicitly

Production packaging must include the video helper only when valid.

Add:

* helper resource path
* packaged path resolver
* installer inclusion
* uninstall cleanup
* update layout
* path-with-spaces tests

Do not distribute proprietary runtime/model files until redistribution rights are verified.

Document:

* file
* version
* source
* checksum when shipped
* license
* redistribution status

PHASE 18 — REQUIRED TESTS

BANDWIDTH

Test:

* exact bit-rate calculation
* no factor-of-eight range transition
* independent audio/video baselines
* SSRC reset
* counter decrease
* peer replacement
* irregular intervals
* weighted average
* ongoing pause
* completed pause
* running peak beyond five minutes
* bucket boundary bytes
* raw/medium/long consistency
* persistence round-trip
* old-schema migration
* one poll per connection
* per-viewer aggregation
* selected-viewer filtering
* viewer leave/rejoin
* null unavailable metrics

MARKERS

Trigger every authoritative event through the real owner.

Assert:

* one marker
* correct session/viewer
* epoch timestamp
* correct label/detail
* no duplicate unchanged-value marker
* persistence
* 30-minute visibility
* Session visibility
* cluster detail preservation
* exact X alignment

POPOVERS

Test:

* one active panel
* Escape
* keyboard toggles
* auto-hide lock
* no overlay
* real shared anchor
* no hidden trigger
* measured center geometry
* fullscreen
* DPI scaling

RTX UNIT AND INTEGRATION

Test:

* protocol envelope compatibility
* request/response IDs
* authentication
* configure type compatibility
* malformed command
* invalid frame header
* invalid stride
* oversized frame
* frame ring bounds
* one in flight
* newest frame wins
* stale generation
* helper timeout
* helper crash
* serialized backend swap
* truthful active state
* fallback chain

REAL PIXEL PROOF

A mocked helper test is insufficient.

On the available RTX machine:

* use a known input frame
* extract real pixels
* submit real bytes
* invoke actual VFX
* return real output
* verify output dimensions
* verify nonzero output
* verify output checksum differs from input
* present output visibly
* record input/output checksums
* capture comparison screenshot
* record actual SDK effect and version
* record p50/p95/max timings

Test:

* 480p15 to 1080p
* 720p30 to 1080p
* mode changes
* quality changes
* helper termination
* recovery
* fullscreen
* stream switch

ORACLE GATE 2 — BANDWIDTH

Provide Oracle:

* final collector ownership
* units contract
* mathematical tests
* marker producer matrix
* persistence format
* range screenshots
* popover rectangle measurements

Resolve every material issue.

ORACLE GATE 3 — RTX REAL-PIXEL PROOF

Provide Oracle:

* actual VFX API call path
* effect selector
* model path
* capability output
* input checksum
* output checksum
* output screenshot
* timing breakdown
* transport implementation
* fallback test
* build/package path

Oracle must reject completion if any processing step is mocked, bilinear, or NPP-only.

FINAL VALIDATION

Run the exact repository commands discovered during audit.

At minimum:

* git diff --check
* all shared tests
* all adapter tests
* all main-process tests
* all preload tests
* all renderer tests
* full desktop test command
* TypeScript build/typecheck
* lint
* audio native build and self-tests
* video native build and tests
* run-desktop.bat
* real two-instance launch
* production desktop build
* packaged helper discovery
* installer build where supported

Quick shortcut regression:

* Quick Share from tray
* Quick Join from tray
* shortcut persistence
* shortcut unregister on exit

FINAL ACCEPTANCE

Bandwidth is not complete until:

* one telemetry system remains
* rates are bits per second everywhere
* range values remain consistent
* per-viewer selection changes data
* all required markers have producers
* markers survive long ranges
* panels are measured centered
* runtime screenshots confirm behavior

RTX is not complete until:

* actual VFX effect creation succeeds
* actual frame bytes reach native
* actual NvVFX processing runs
* actual output bytes return
* output is visibly presented
* active status is truthful
* fallback works
* development build includes helper
* packaged discovery works
* real-machine evidence exists

When the VFX SDK, runtime, models, or redistribution rights are unavailable:

* do not fake completion
* keep NVIDIA unavailable
* keep WebGL fallback functional
* report the exact blocker and evidence
* do not substitute ordinary resizing

FINAL REPORT

Return:

* starting branch and SHA
* audited HEAD and HEAD~1
* ending SHA
* commits created
* initial staged/unstaged/untracked state
* final git status
* complete initial defect matrix
* files retained
* files removed
* files rewritten
* bandwidth ownership diagram
* units contract
* mathematical validation
* marker producer locations
* marker behavior by range
* per-viewer behavior
* panel anchor architecture
* DOM rectangle measurements
* screenshots
* RTX end-to-end call graph
* protocol schema
* real NVIDIA API functions called
* effect selector
* capability output
* frame extraction method
* transport method
* input/output checksums
* processing timings
* dropped/backpressure counts
* fallback results
* development build result
* production build result
* packaged result
* installer result
* test commands and exact counts
* real-machine validation
* licensing status
* Oracle findings from all gates
* remaining external blockers

Do not end with a plan, a question, “scaffolding complete,” or mocked test results.

Deliver either:

1. A fully working, verified implementation meeting every applicable gate, or
2. A truthful partial result where RTX remains visibly unavailable and the exact external SDK/runtime/model blocker is documented.

Never present stubs, bilinear scaling, CUDA/NPP-only scaling, mocked output, or an unavailable helper as NVIDIA RTX Video Super Resolution.
