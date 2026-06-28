It does not all work yet. At the audited 7826fd5 state, these are the remaining items required to make the features genuinely functional.

1. Put the completed commit chain on the branch actually used

The public main history still ends at 1f6e98b; 7826fd5 exists, but is not currently shown as part of main. Ensure your launcher, builds, and future agents are actually using the branch containing c974516 through 7826fd5, then push/merge that branch into main. Otherwise none of the later repairs are part of the normal synced application.

2. Finish host bandwidth connection lifecycle

The host still polls every publisher connection through the old pollStats() interval and registers those same connections with StreamMetricsService, so each host peer is being polled twice.

It also stores only a set of registered IDs, not the returned unregister callbacks. When a viewer leaves:

The telemetry connection remains registered.
Its history and rate may remain in the aggregate.
The timer may continue polling a dead connection.
A viewer reconnecting under the same UUID may never register its new peer connection.

Replace the set with a map of connection ID to { peerConnection, unregister }, remove the old bitrate polling, unregister disappeared/replaced peers, clear registrations when sharing stops, and finalize/reset the host history session.

3. Give host connections real viewer identities

Host telemetry registrations currently use:

viewerDeviceId: null
displayName: null

even though the same hook later builds a peerUuid → viewerDeviceId map and receives viewer status messages.

Register or update each telemetry connection with:

Viewer device ID.
Display name.
Media peer UUID.
Viewer-reported received status.

Without that, the graph may show internal connection IDs instead of names, and selected-viewer diagnostics cannot reliably combine host-sent stats with that viewer’s received resolution, FPS, paused state, and loss data.

4. Handle viewer peer replacement and reconnect correctly

ViewerWorkspace registers one connection as viewer-${historyId} but never calls replaceConnectionPeer() when the viewing session creates a new RTCPeerConnection.

After reconnect, the metrics service may continue polling the dead original connection. It needs to detect the actual peer object changing and either:

Call replaceConnectionPeer(historyId, connectionId, newPc), or
Unregister and register a generation-specific connection.

Reconnect start and completion must also drive setSessionState("reconnecting") and setSessionState("playing"), not merely add a visual marker.

5. Correct pause/resume ownership

Pause and resume currently:

Add an explicit marker.
Call setSessionState(), which adds another marker.
Do both before session.pause() or session.resume() succeeds.

This can create duplicate markers and false state changes when the media operation fails.

Perform the media operation first. After success, call setSessionState() once and let it own the marker. On resume, force a counter rebaseline so bytes accumulated during the pause are not measured across a long paused interval and then divided by active time.

6. Replace the single video/audio baselines with per-report baselines

The collector can receive multiple video reports, such as simulcast encodings or stale/transitioning reports, but it processes all video observations through one video baseline and all audio observations through one audio baseline.

Each report identity change resets that shared baseline, so multiple reports can repeatedly reset one another and produce zero or unstable values.

Maintain baselines keyed by a stable identity such as:

reportId + SSRC + MID + track identifier

Then sum the exact deltas from active reports. Alternatively, explicitly resolve one authoritative active report per media track. Do not loop several reports through one baseline.

7. Stop reconstructing byte deltas from calculated rates

processCounterWithIdentity() returns only a bitrate. The service then reconstructs transferred bytes using:

rate × actualInterval ÷ 8000

The actualInterval comes from the single video baseline and is reused for audio. This introduces rounding errors and can assign the wrong interval to audio.

Make counter processing return:

{
  bitsPerSecond,
  deltaBytes,
  intervalMs
}

Add deltaBytes directly to totals and buckets. Use each report’s own interval.

8. Correct connection-health extraction

The service currently reads packet loss and jitter from remote-inbound-rtp for all connections and computes totals using packetsReceived, which is not generally the correct source for both directions.

Use:

Viewer inbound: inbound-rtp packets received, packets lost, jitter.
Host outbound: the correlated remote-inbound-rtp report.
Codec: follow codecId to the corresponding codec report instead of expecting mimeType directly on the RTP report.
Candidate path: resolve the selected candidate pair’s local and remote candidate reports.

Otherwise connection health can display null or incorrect loss, codec, jitter, and relay state.

9. Correct partial history buckets

Buckets are aligned to a rounded wall-clock boundary. Their interval is then measured from that rounded boundary rather than from the first actual included sample.

A sample arriving near the end of a five-second bucket can therefore be treated as if it represented almost the whole bucket.

Store:

Actual first sample timestamp.
Actual last sample timestamp.
Sum of exact byte deltas.
Sum of represented active intervals.

Calculate the weighted average from exact bits divided by exact represented time, not from the rounded bucket window.

10. Finish marker correctness

The main marker X-coordinate issue is repaired, and selected-viewer/range filtering is now present. The remaining marker work is:

Remove explicit pause/resume markers and let the successful state transition own them.
Drive reconnect state, not just a “retry initiated” marker.
Replace the meaningless enhancement marker webgl2 → webgl2 with actual requested backend, active backend, and fallback backend.
Feed configured and effective bitrate into sampled-marker generation; they are currently passed as null.
Implement an actual cluster tooltip/popover listing every event. The current code computes a tooltip string but only renders the first label plus +N; the details are not visibly presented.
11. Fix the video-helper startup deadlock

This is a guaranteed blocker.

Native startup waits for the frame pipe first, and only afterward accepts the control pipe. The Electron manager connects the control pipe first, waits for the hello response, and only afterward connects the frame pipe.

So both sides wait forever:

Native: waiting for frame client
Electron: waiting for control handshake response

Accept and authenticate the control connection first, then accept the frame connection; or connect both before waiting for the handshake. Control authentication first is the safer architecture.

12. Add a real frame-processing loop

Even after fixing startup, frames still cannot be processed.

The TypeScript manager directly writes to the frame pipe, but native reads the frame pipe only when it receives a control command named frameAvailable. The manager never sends that command.

Choose one architecture:

Preferred: run a dedicated native frame-pipe worker loop that continuously reads complete frames while the authenticated control session is active.
Alternative: send a correlated frameAvailable command for each frame, but coordinate it without blocking before writing the frame.

The current mixed architecture must be replaced.

13. Return the complete processed output frame

submitFrame() still returns only boolean.

The Node side reads only the result header and leaves the output pixel payload unread in the socket. Those leftover pixels will then be interpreted as the next frame’s header, corrupting the persistent protocol after the first response.

Return:

{
  generation,
  sequence,
  width,
  height,
  stride,
  pixelFormat,
  pixels,
  processingTimeUs
}

Read exactly the full header and exactly payloadBytes before allowing another submission. Use one serialized frame dispatcher rather than adding a new socket data listener per frame.

14. Handle frame-pipe backpressure correctly

socket.write() returning false does not mean the write failed; it means the data was accepted into the socket buffer and the sender should wait for drain.

The current code returns failure after already queuing the frame, which leaves the sender and native receiver out of synchronization.

When write() returns false:

Keep the frame transaction active.
Wait for drain.
Continue reading the matching response.
Do not resend the same bytes.
Reset/destroy the frame socket after a timeout or protocol error.
15. Require successful configuration before reporting ready

Startup currently awaits the configure command but ignores its returned value and unconditionally sets the helper state to ready.

Require a successful correlated response and confirmation of the applied configuration before entering ready. Otherwise an unsupported mode, invalid dimensions, or unavailable runtime can still appear healthy.

16. Implement a real renderer NVIDIA backend

The factory always returns WebGL2ViewerImageBackend, regardless of capability. There is currently no active renderer backend that:

Extracts decoded pixels.
Calls the preload/main helper API.
Receives processed pixels.
Uploads them to the canvas.
Manages one frame in flight.
Rejects stale generations.

Reintroduce a real NvidiaVsrViewerImageBackend only after the transport works. The factory must select it when requested and available rather than merely attaching an NVIDIA-unavailable reason to WebGL.

17. Make backend switching and activation truthful

EnhancedVideoSurface still reports onBackendChange(effective) before awaiting proc.setBackend(), initialization, or first visible output. Although setBackend() now awaits old-backend destruction internally, the caller does not await it.

Make the settings-change effect asynchronous and serialized:

Await backend replacement.
Await initialization.
Process and present the first frame.
Only then report that backend active.
Preserve the original video until that point.
18. Implement the actual NVIDIA Video Effects path

Native currently copies the input bytes unchanged, records the frame as successful, and explicitly says real NVIDIA processing is for a future phase. Output dimensions are forced back to the input dimensions.

The CMake VFX block also contains only commented future include/link instructions.

To make RTX work:

Add actual NVIDIA VFX SDK headers and libraries.
Locate the runtime DLLs and model directory.
Create the real VSR effect.
Bind input and output NvCVImage resources.
Apply supported mode/quality parameters.
Load the effect.
Run it.
Return real output dimensions and pixels.
Report SDK errors accurately.
Stop reporting passthrough frames as successful RTX processing.
19. Implement the real fallback chain

The report’s “factory guards WebGL2 with capability reason” is not the requested fallback chain.

Implement an ordered controller:

NVIDIA VSR
→ WebGL FSR 1
→ WebGL Lanczos 3
→ original video

It must advance through those stages on initialization failure, repeated processing failure, helper crash, and WebGL failure, while preserving the requested backend and exposing the actual active backend and reason. The current factory always returns WebGL2 and does not perform algorithm-level staged fallback.

20. Complete VFX build and packaged-runtime integration

Once real SDK processing exists, finish:

CMake include directories and library linkage.
Model-directory discovery.
Runtime DLL discovery.
Development launcher inclusion.
Packaged helper inclusion.
Installer/update layout.
Redistribution/license handling.

The current CMake file explicitly leaves the actual VFX include and library wiring as future commented work.

The viewer-panel anchoring itself now looks structurally correct; I did not find another obvious source-level blocker there. It still needs one actual Windows visual run to confirm centering and collision behavior, but the remaining substantive implementation work is the bandwidth lifecycle/math above and essentially the entire native RTX frame-processing path.