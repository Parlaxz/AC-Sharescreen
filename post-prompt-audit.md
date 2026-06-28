Synced-change audit
Critical repository-state warning

I audited the six-commit synced range ending at 1f6e98b:

280cd84 — restore build
51ba91b — per-connection telemetry
525e0a8 — canonical bandwidth consumers
59fa9a6 — aggregation and persistence
5553d56 — markers, per-viewer graph, panel anchor
1f6e98b — video-enhancer protocol

However, a final public-repository check now shows main exposing the older 91-commit tree, with c2c7585 as the latest visible commit and no native/video-enhancer directory. The branch page says main was updated June 28, but the commit/tree views do not currently expose the six audited commits. This suggests either a force-push, branch mismatch, or GitHub synchronization inconsistency.

The findings below apply specifically to the synced tree at 1f6e98b. Before giving another agent work, locally run:

git branch --show-current
git rev-parse HEAD
git status --short
git log -10 --oneline --decorate
git branch -vv
git remote -v
git ls-remote origin refs/heads/main

If git rev-parse HEAD is not 1f6e98b174a4f089131b356fae90d46fa9ca9930, preserve the current branch before doing anything else.

Executive verdict

The six synced commits are not a completed implementation.

They contain three categories:

Genuine improvements
One centralized activePanel state exists.
The visible bottom control-bar wrapper is now used as the Radix popover anchor.
The control auto-hide hook has a real locked option instead of relying solely on an enormous timeout.
Canonical bandwidth interfaces were introduced.
A connection-registration API was added to StreamMetricsService.
Request IDs and a command queue were partially added to the video-helper protocol.
Payload extraction on the native control side was improved.
The non-VFX helper can truthfully report an unavailable SDK state in some paths.
Incomplete integrations
The new telemetry collector is not actually registered by the viewer or host.
The graph viewer selector does not select viewer data.
Marker rendering exists without most marker producers.
Persistence is partly migrated but based on incorrect aggregate data.
The capability store exists but is not driving backend selection or UI.
The video protocol was partly normalized, but the frame transaction is impossible.
Hard blockers
RTX cannot process a frame.
The frame command deadlocks by design.
The TypeScript frame header buffer is smaller than the fields written into it.
Native and Node named-pipe paths are constructed differently.
No output pixel buffer returns to the renderer.
Native processing is passthrough or bilinear, not NVIDIA VFX.
The VFX-enabled CMake configuration is ordered incorrectly and does not link the actual SDK.
Bandwidth aggregate histories are not mathematical aggregates.
Viewer and host telemetry are still independently polled outside the new service.
Marker X coordinates and chart X coordinates use different units.
Commit-by-commit verdict
Commit	Claimed purpose	Actual verdict
280cd84	Restore coherent build	Partial. Non-VFX structure improved, but VFX-enabled CMake remains invalid and no real NVIDIA integration exists.
51ba91b	Per-connection telemetry	Scaffold only. Registration API exists, but neither viewer nor host registers its peer connections. Internal async and aggregation bugs remain.
525e0a8	Migrate consumers	Failed migration. Viewer and host retain their old polling paths and consume an unpopulated new service.
59fa9a6	Correct aggregation/persistence	Partial and mathematically incorrect. Buckets, pause math, peak retention, and aggregate series remain wrong.
5553d56	Complete markers, per-viewer graph, panels	Panels mostly improved; markers and per-viewer graph not complete.
1f6e98b	Unify video protocol/lifecycle	Partial control repair but unusable frame path. It introduced request IDs but left a guaranteed frame deadlock, invalid header allocation, and no output transport.
1. Bandwidth collection is not connected
Viewer side

ViewerWorkspace still runs its own one-second diagnostic polling loop. It reads StreamMetricsService.getSnapshot(), but it does not register the active RTCPeerConnection using the new registerConnection() API.

That means the service owns a collector API but has no viewer peer connection to collect from. The compact bandwidth indicator and graph can consequently remain empty or zero even though the old diagnostic poll is still running.

The migration should have removed the direct polling and replaced it with:

const unregister = streamMetrics.registerConnection({
  historyId,
  connectionId,
  peerConnection,
  direction: "inbound",
  ...
});

That never happened.

Host side

use-host-viewer-diagnostics.ts also retains its own interval, iterates publisher peer connections, and invokes its own stats polling.

It still:

Keeps separate byte baselines.
Calculates elapsed time with Date.now().
Sums cumulative counters belonging to unrelated peer connections.
Does not call the new registration API.
Comments as though the service owns collection while continuing to collect outside it.
Consequence

The code now has:

A new collector service with no registered connections.
An old viewer poll.
An old host poll.
A graph subscribing to the new service.
Host diagnostics still populated by the old hook.

This is worse than merely retaining compatibility code: different interfaces are reading different telemetry realities.

2. The service’s asynchronous polling guard does not guard anything

The service sets tickInFlight = true, starts each pollConnection() call without awaiting it, immediately aggregates and notifies, then sets tickInFlight = false.

Conceptually, it does this:

for (const connection of connections) {
  this.pollConnection(connection).catch(...);
}

this.buildAggregate();
this.notify();
this.tickInFlight = false;

The poll promises are still running when aggregation and notification occur.

This produces several defects:

Subscribers receive the previous tick’s values.
Persistence checkpoints stale data.
A second timer tick can begin while the first tick’s getStats() calls are still unresolved.
Multiple observations can complete in nondeterministic order.
tickInFlight gives a false impression of preventing overlap.

It must be:

await Promise.allSettled(
  connections.map((connection) => this.pollConnection(connection))
);

this.buildAggregate();
this.checkpoint();
this.notify();

and tickInFlight must be released in finally.

3. Inbound/outbound stats selection is wrong

The service constructs report-type variables incorrectly and accepts both inbound and outbound reports while collecting an inbound connection.

The effective behavior can process:

inbound-rtp
outbound-rtp

for the same connection instead of selecting exactly one based on direction.

This can result in:

Viewer inbound observations being overwritten by local outbound reports.
Host outbound observations selecting unrelated inbound reports.
Last-iteration-wins behavior based on browser report ordering.
Audio/video rates changing unpredictably between ticks.

The collector must select exactly:

const expectedType =
  direction === "inbound" ? "inbound-rtp" : "outbound-rtp";

and ignore the other RTP direction.

4. Counter identity was designed but never used

The new baseline types contain:

Report ID.
SSRC.
Track identifier.
MID.

But processCounter() receives only cumulative bytes and timestamp. The polling code reads some identity fields but does not pass them through to baseline comparison.

Therefore, it cannot correctly detect:

Sender replacement.
Receiver replacement.
SSRC changes.
Simulcast encoding switches.
Track replacement.
MID changes.
Peer-connection recreation where counters remain numerically increasing.

It only notices a counter decrease.

This permits large false deltas where the new counter happens to be higher than the old counter.

5. Multiple RTP reports are overwritten

The collector loops through matching RTP reports and assigns:

videoCumulative = bytes;

or:

audioCumulative = bytes;

Each new matching report overwrites the prior value.

This is invalid for:

Simulcast.
Multiple outbound encodings.
Multiple audio tracks.
Old inactive reports remaining in getStats().
Browser-dependent report ordering.

It needs one of two explicit rules:

Select the authoritative active RTP report by transceiver/MID/track identity.
Maintain independent baselines per report identity and sum their deltas.

A raw “last report wins” rule cannot be retained.

6. Samples lie about their interval

Counter rates are partially calculated using actual monotonic elapsed time, but the final sample hardcodes:

intervalMs: 1000

regardless of whether getStats() took 800 ms, 1,200 ms, or 2,500 ms.

This corrupts:

Weighted bucket averages.
Estimated transferred bytes.
Active-session average.
Long-session history.
Thirty-second average.
Partial-bucket calculations.

The sample must carry the actual interval represented by its counter delta.

7. Video and audio breakdown is still not exposed

The collector calculates or can calculate separate media rates, but sample creation does not persist meaningful separate:

videoBitsPerSecond
audioBitsPerSecond

The graph explicitly maps video and audio to null.

Therefore the UI controls for video/audio series are either missing or permanently empty.

The telemetry prompt required actual media separation, not merely a total rate.

8. Candidate-pair transport collection is not direction-aware

The transport selection uses a generic bytesReceived ?? bytesSent style path instead of choosing:

bytesReceived for viewer inbound.
bytesSent for host outbound.

That can make host transport estimates use receive traffic and viewer estimates use send traffic, depending on which field is present first.

It also needs candidate-report lookup to resolve:

Local candidate type.
Remote candidate type.
Relay/direct state.

Those values generally live in candidate reports referenced by IDs, not directly in the RTP report.

9. Host “aggregate” history is not an aggregate

The service builds aggregate history by concatenating every connection’s samples and sorting them by time.

For two viewers sampled at approximately the same time, the aggregate history becomes:

viewer A: 2 Mbps
viewer B: 3 Mbps

rather than:

aggregate: 5 Mbps

The graph then sees alternating individual rates, not summed upload.

Related problems:

Aggregate peak is the largest individual viewer peak, not the largest simultaneous sum.
Aggregate current can represent one connection rather than all active connections.
Aggregate medium and long buckets are concatenated rather than summed by interval.
Total bytes may be summed correctly while the line chart remains wrong.

The service must create an aggregate observation each completed poll cycle by summing the deltas from all connections observed in that same cycle.

10. Bucket calculations remain incorrect
Monotonic timestamps are stored in epoch-named fields

aggregateInto() derives a bucket start from sample.monotonicTimestampMs but stores it in fields named:

startTimestampMs
endTimestampMs

An adjustment is applied later in some paths, but this creates two timestamp domains inside the same structure.

Every persisted/chart timestamp should be epoch milliseconds at creation time. Monotonic time should remain in a separate internal-only field.

Partial buckets use the wrong duration

A new bucket can represent one observation but be treated as if it spans its full nominal five- or thirty-second window.

This lowers the weighted rate of partial buckets and makes newest graph values appear artificially small.

Cross-boundary byte accounting is fragile

Bucket byte deltas rely on prior bucket metadata rather than assigning each observation’s already-calculated delta exactly once.

This risks either:

Dropping the first delta after a bucket boundary.
Counting it against the wrong bucket.
Reconstructing deltas from cumulative values whose identity changed.

The connection observation should already carry its byte delta, and aggregation should simply add that delta to the current bucket.

11. Thirty-second average is still an average of averages

The graph calculates the 30-second value by averaging the latest bucket average values by count.

That is not a weighted average.

Example:

Bucket A represents 1 second at 8 Mbps.
Bucket B represents 5 seconds at 2 Mbps.

Arithmetic mean:

(8 + 2) / 2 = 5 Mbps

Correct weighted mean:

(8×1 + 2×5) / 6 = 3 Mbps

The displayed summary can therefore be materially wrong during partial buckets, pauses, reconnects, and delayed polling.

12. Session peak still decays

The displayed peak derives from retained sample history instead of a permanent running maximum.

When an old peak ages out of the five-minute raw window, “Session Peak” can decrease.

A session peak must only stay the same or increase until the session ends.

13. Current pause duration is not fully accounted for

Completed pause intervals are accumulated, but a pause that is currently in progress is not consistently subtracted when calculating active duration.

During a ten-minute active pause, the active duration and active average can continue changing incorrectly until resume.

The calculation needs:

const currentPauseMs =
  pausedAtMonotonicMs === null
    ? 0
    : nowMonotonicMs - pausedAtMonotonicMs;
14. Viewer session lookup can select the wrong stream

The media-session lookup method ignores its supplied media-session ID and returns the first matching or first existing session.

With simultaneous streams, the bandwidth graph can attach to the wrong history.

This is a direct multi-stream correctness defect, not an edge case.

15. Viewer status updates are not reactive

updateViewerReportedStatus() assigns a value to connection state but does not immediately invalidate the snapshot or notify subscribers.

The UI will only see the new received state after some unrelated later telemetry update.

It must rebuild/notify the relevant session as part of the update.

16. Connection markers are duplicated

A connection marker is added to both:

The connection marker list.
The session marker list.

When the aggregate snapshot is created, it starts from session markers and appends every connection’s markers again.

The same marker can therefore appear twice.

Markers should have one storage owner. Aggregate snapshots can derive views by filtering that one canonical collection.

17. Required marker producers still do not exist

ViewerWorkspace still does not call the marker service for its primary lifecycle events. It also does not consistently call telemetry setSessionState() when the local video is paused, resumed, or reconnecting.

Missing real producers include:

Pause.
Resume.
Reconnect started.
Reconnect completed.
Stream switch.
Quality request.
Enhancement requested backend.
Enhancement effective backend.
Enhancement fallback.

The service’s sampled marker support does not replace explicit event ownership.

Reconnect-complete marker is absent

The service handles:

Playing → paused.
Paused → playing.
Any state → reconnecting.

But reconnecting → playing does not get a dedicated completed marker; it falls through generic behavior.

18. Marker X coordinates remain fundamentally wrong

Graph points now use absolute epoch milliseconds:

time: timestampMs

The X axis is numeric and operates in epoch milliseconds.

Markers are still transformed to relative seconds:

(marker.timestampMs - baseTime) / 1000

The marker is then supplied to ReferenceLine.x on an epoch-millisecond axis.

Example:

chart point: 1,782,000,000,000
marker x: 32

That marker will not appear in the visible chart domain.

This directly explains the user-observed absence of markers even if some marker objects exist.

19. Markers disappear after raw history expires

The graph returns no visible markers when rawSamples is empty, even if medium or long history and session markers exist.

Therefore markers cannot work reliably in:

30-minute view.
Session view.
Loaded completed sessions.
Any period after the five-minute raw retention expires.
20. Marker clusters still discard information

A cluster renders the first marker label and +N. There is no complete cluster tooltip listing all events and their before/after values.

A preset application that changes bitrate, codec, resolution, and FPS simultaneously will hide most of those events.

21. The viewer selector remains cosmetic

The graph stores selectedViewer, but calculations continue to use snapshot.aggregate.

The following do not switch to the selected connection:

Summary.
Throughput chart.
Health chart.
Markers.
Total bytes.
Peak.
Average.

So the commit titled “per-viewer graph” did not complete per-viewer behavior.

22. Connection Health ignores selection and time range

Health data is built from aggregate raw samples regardless of:

Selected viewer.
60-second/5-minute/30-minute/Session range.
Medium or long history availability.

The throughput and health tabs can therefore describe different time windows while the UI shows one selected range.

23. Panels: the improvement is real, but unproven

The panel commit is the most successful of the six.

Fixed
One activePanel state.
Actual visible control-bar wrapper used as PopoverAnchor.
Width selection for settings/diagnostics/bandwidth.
A proper locked option in useControlsAutoHide.
No 999999 delay in the primary path.
Remaining issues
No geometry proof

There are no demonstrated tests measuring:

panel center X - viewer center X

under:

Fullscreen.
Windowed mode.
Narrow width.
Windows scaling.
Collision clamping.

The source architecture is now plausible, but “centered” has not been proven.

Nested scroll containers

ViewerPanelShell wraps panel content in a ScrollArea, while bandwidth content also contains its own ScrollArea.

That can cause:

Competing mouse-wheel behavior.
Double scrollbars.
Incorrect available-height calculations.
Sticky elements not sticking to the intended scroll parent.

Only the shell or the panel should own vertical scrolling.

Dead standalone bandwidth popover path

BandwidthGraphModal still contains a non-contentOnly popover rendering path without the shared visible anchor.

That fallback should be deleted to prevent the old architecture from returning through another call site.

24. Video-helper frame submission deadlocks

This is the strongest RTX protocol blocker.

The TypeScript side does:

Send control command frameAvailable.
Await its response.
Only afterward connect/write to the frame pipe.

The native side handles frameAvailable by:

Waiting for a frame-pipe client.
Reading the frame.
Processing it.
Sending the control response.

So:

TypeScript waits for native response.
Native waits for TypeScript frame connection.

Neither can continue.

The correct order is either:

Maintain a persistent frame connection and write the frame before issuing the notification, or
Issue notification without awaiting it, transfer frame, then correlate completion.

A persistent frame connection is simpler and matches the original requirements.

25. The TypeScript frame header buffer is too small

The TypeScript code allocates a 64-byte header but writes fields beyond byte 64.

The corresponding C++ structure is roughly 80 bytes or more depending on packing.

Node’s buffer writes beyond its length will throw a range error. Since submission catches errors and returns failure, this alone is sufficient to make every frame fail.

The wire header needs:

One explicitly packed layout.
One shared constant header size.
Static assertions in C++.
Bounds assertions in TypeScript.
A protocol test that serializes in TS and parses in C++.
26. Named-pipe paths are double-prefixed

TypeScript passes arguments already containing:

\\.\pipe\screenlink-...

Native CreatePipeServer() prepends:

\\.\pipe\

again.

The native server and Node client consequently target different path strings.

Pass bare names across process arguments:

screenlink-video-control-<random>

and add the Windows prefix exactly once inside each process’s pipe utility.

27. Startup reports ready without a successful configure

The manager sends configure and then moves to ready without requiring a successful correlated configure result.

The helper can be shown as ready when:

Configure returned an error.
Mode was invalid.
Quality was invalid.
Dimensions were rejected.
Runtime was unavailable.
The response belonged to another command.

Ready must require:

hello.success === true &&
configure.success === true &&
configure.result.applied === true
28. A timeout destroys the shared control dispatcher

The protocol now has a shared response handler, which is an improvement. But timeout/error cleanup can remove that shared handler rather than removing only the pending request entry.

After the first timeout—highly likely because of the frame deadlock—the control socket remains open but future responses are no longer dispatched.

Only the pending request should be rejected. The global socket parser must remain installed until socket teardown.

29. No output frame is returned

Native writes a response header and output bytes, but the TypeScript API returns Promise<boolean>.

There is no usable renderer-facing result containing:

Output bytes.
Width.
Height.
Stride.
Pixel format.
Sequence.
Generation.
Timings.

Even if native processing worked, the renderer could not display it.

submitFrame() must return something like:

interface ProcessedFrame {
  generation: number;
  sequence: number;
  width: number;
  height: number;
  stride: number;
  pixelFormat: "rgba8" | "bgra8";
  pixels: ArrayBuffer;
  timings: ProcessingTimings;
}
30. The frame pipe is recreated for every frame

The implementation connects, transfers one frame, disconnects, then repeats. Native also disconnects after each processed frame.

That causes:

Named-pipe setup latency every frame.
Extra races.
More handle churn.
More difficult cancellation.
Greater chance of missed frames.
No true one-in-flight persistent transport.

The session needs one persistent frame-pipe connection.

31. Native pipe I/O is not robust

Native ReadFrame() and WriteFrame() rely on one ReadFile or WriteFile call transferring the entire payload.

Windows named-pipe operations may return partial data or ERROR_MORE_DATA, especially for large image buffers.

It needs:

bool ReadExact(HANDLE pipe, void* data, size_t bytes);
bool WriteAll(HANDLE pipe, const void* data, size_t bytes);

with correct handling of:

Partial transfer.
Broken pipe.
ERROR_MORE_DATA.
Cancellation.
Zero-byte progress.
Payload limits.

The control pipe similarly needs a persistent receive buffer capable of retaining partial newline-delimited JSON.

32. Frame validation is far too weak

The native side checks a magic number and rough payload size, but does not comprehensively validate:

Header size.
Protocol version.
Input width and height.
Output width and height.
Stride.
Pixel format.
Payload equals stride × height.
Multiplication overflow.
Generation.
Sequence.
Authenticated session.
Maximum output allocation.

Malformed or mismatched input can allocate incorrect buffers or desynchronize the stream.

33. Native processing is still passthrough, not VSR

The current native processing path copies input to output or uses placeholder behavior. It does not call NVIDIA Video Effects.

The source explicitly leaves real VFX processing for a future phase.

No NvVFX effect call exists in the active implementation.

Therefore:

RTX cannot visually differ from the source.
Output dimensions remain input dimensions.
Quality controls cannot affect processing.
Modes cannot affect processing.
A successful helper response would still not prove VSR.
34. The VFX-enabled CMake path is invalid

The VFX compile-definition block references the target before add_executable() creates it.

Even after fixing order, the build does not yet provide complete:

SDK include directories.
Import libraries.
Runtime library discovery.
Model directory handling.
Packaging.
Version validation.
Redistribution logic.

The non-VFX build may compile, but the actual VFX build path is not complete.

35. The renderer has no NVIDIA backend

The previous NVIDIA renderer backend was removed. The factory’s selection union only handles:

auto
webgl2

and always returns WebGL.

So even if:

Capability succeeds.
Helper starts.
Frame transport works.
Native VFX works.

there is no renderer backend to extract frames, submit them, receive output, and draw output.

36. NVIDIA UI remains visible despite no backend

The settings panel continues showing NVIDIA:

Backend selection.
Mode.
Quality.
Output controls.

Those controls are not tied to a working capability result and do not affect an active native backend.

This is placebo UI and should be disabled with an explicit reason such as:

NVIDIA RTX Video unavailable: SDK support was not built.

until all runtime gates succeed.

37. The reactive capability store is unused

A capability store with subscribe() and getSnapshot() exists, but the backend factory and enhancement surface still use the older capability path.

The store is not the authority for:

Backend selection.
Settings enablement.
Retry.
Invalidation.
UI status.

Additionally, a probe failure can leave an old reason rather than reliably changing to helper-failed.

38. Backend activation is still reported before success

EnhancedVideoSurface calls onBackendChange() immediately after selecting a candidate, before:

Initialization finishes.
A frame is processed.
A frame is presented.

The UI can therefore report a backend as active while output still comes from another path.

The active backend must change only after first successful visible presentation.

39. Backend replacement is not serialized

ViewerImageProcessor.setBackend() destroys the old backend without awaiting completion and immediately proceeds with replacement.

Possible races:

Old backend completion draws after replacement.
Old helper session remains alive.
Old canvas resources are used after destruction.
New and old sessions overlap.
Generation changes do not fully fence asynchronous cleanup.

Backend switching must be one awaited operation.

40. Failed frames are still counted as processed

The processor increments framesProcessed before inspecting result.success.

A backend failing every frame can report an increasing processed count.

Separate:

Submitted.
Completed.
Successfully processed.
Presented.
Failed.
Dropped.
Stale.
41. No fallback chain exists

The required path:

NVIDIA → FSR → Lanczos → original video

is not implemented.

The factory returns WebGL; retry behavior generally recreates WebGL; algorithm-level fallback is not an ordered controller.

The controller needs to distinguish:

Requested backend.
Candidate backend.
Active backend.
Fallback backend.
Fallback reason.
Updated phase matrix
Phase	Status at 1f6e98b	Assessment
0. Repository freeze/audit	Partial	Exact synced SHA audited statically, but public main now appears to point elsewhere. Local Git state must be verified.
1. Explorer and Oracle architecture audit	Missing evidence	No durable Explorer maps or Oracle reports are in the synced deliverable.
2. Clean build baseline	Partial/Unverified	Some source cleanup occurred, but VFX CMake is invalid. No independently verified full build.
3. Authoritative bandwidth collector	Scaffold only	API exists; viewer and host do not register connections. Old polls remain.
4. History and persistence	Partial/Incorrect	Schema work exists, but aggregates, partial buckets, peak, timestamp ownership, and active duration remain wrong.
5. Markers	Mostly missing	Types/rendering exist; producers are absent; coordinate system is broken.
6. Per-viewer graph	Missing	Selector exists but all data remains aggregate.
7. Canonical bandwidth graph	Partial	Basic graph exists; weighted average, health selection, breakdown series, tooltips, and marker range behavior remain incorrect.
8. Viewer panels	Mostly implemented	Real anchor and lock added; geometry tests and scroll cleanup remain.
9. Truthful RTX reset	Partial	Factory stays WebGL, but NVIDIA UI still implies functionality.
10. Control protocol	Partial/Failed	IDs and payload extraction improved; frame flow deadlocks, pipe naming and timeout behavior remain broken.
11. Real NVIDIA VFX	Missing	No SDK effect creation or processing.
12. Bounded frame transport	Broken	Header overflow, deadlock, per-frame connections, unsafe I/O, no output result.
13. Renderer frame extraction	Missing	No NVIDIA renderer backend.
14. Output presentation	Missing	No output pixels return to renderer.
15. Processor lifecycle	Partial/Incorrect	Generation concept exists; replacement is not serialized, counters are wrong.
16. Fallback chain	Missing	No explicit NVIDIA→FSR→Lanczos→original controller.
17. Build and packaging	Incomplete	No valid VFX build or verified packaged-helper/runtime/model path.
18. Tests and runtime proof	Missing/Unverified	Some unit tests may pass, but none prove the broken end-to-end paths.
What should be fixed first

The next implementation must happen in this order.

1. Establish the real branch and SHA

Do not let an agent edit until the public/local branch discrepancy is resolved.

Required result:

local HEAD = intended synced SHA
origin/main = intended synced SHA
working tree clean
2. Make bandwidth collection real before touching graph UI

First:

Register viewer peer connection.
Register every host viewer peer connection.
Remove direct viewer polling.
Remove direct host polling.
Await all polls.
Correct RTP direction.
Use report/SSRC/track/MID identity.
Create real aggregate observations.

Until that is complete, graph debugging is meaningless.

3. Correct the service mathematics

Then:

Actual intervals.
Independent video/audio/transport baselines.
Actual weighted averages.
Running peak.
Ongoing-pause subtraction.
Real aggregate history.
Correct persistence.
4. Connect marker producers

Only after telemetry session identity is reliable:

Wire viewer events.
Wire host events.
Deduplicate.
Use epoch timestamps.
Use one marker store.
5. Fix graph selection and coordinate domain
Resolve selected series first.
Use absolute epoch X values everywhere.
Remove marker rebasing.
Make health range-aware.
Add cluster details.
6. Finish panel proof
Remove nested scroll ownership.
Delete standalone fallback.
Add Playwright bounding-rectangle assertions.
7. Disable false RTX UI before deeper implementation

Until there is a real renderer backend:

Disable NVIDIA selection.
Show sdk-not-built or the exact capability reason.
Do not display NVIDIA as active.
8. Repair protocol and transport independently of VFX

Before NVIDIA SDK work:

Persistent frame pipe.
Correct header size.
Shared header specification.
Correct pipe names.
Remove command/frame deadlock.
Return output pixel data.
Exact read/write loops.
Validation tests.

Use a deterministic passthrough test only to prove transport, and label it transport passthrough, never VSR.

9. Add real renderer extraction and presentation

Prove:

video frame → helper → output bytes → visible canvas

with a known deterministic non-VFX transform or checksum before adding the NVIDIA SDK.

10. Add real VFX last

Only after transport works:

Actual SDK discovery.
Real effect creation.
Model loading.
NvVFX_Run.
Real output checksum.
Visual validation.
Packaging/licensing.
Final assessment

The synced changes are not safe to hand to a mediocre agent as “finish the remaining pieces.”

The most important misleading commit claims are:

“Per-connection telemetry” exists as an API but is not connected to peer connections.
“Consumer migration” did not remove old polling.
“Correct telemetry aggregation” does not create a true aggregate series.
“Complete bandwidth markers” has almost no actual event producers and renders markers in the wrong coordinate unit.
“Per-viewer graph” has a selector that does not select data.
“Unify video protocol” added IDs but left a guaranteed deadlock, invalid frame-header allocation, no output pixel return, and no native renderer path.
Panel centering is the one area that received a materially correct architectural repair, though it still lacks geometric validation.

The RTX feature remains effectively 0% functional end to end. The bandwidth feature has useful data-model scaffolding but is still not trustworthy numerically or operationally. The panel shell is largely structurally corrected but unverified visually.