# ScreenLink Audio Sharing — Design Document

> **Status:** Approved by user 2026-06-21
> **Starting commit:** cf70c42
> **Designer:** Based on user-provided specification, refined via collaborative review

## Architecture

The audio-sharing system uses a separate native Windows x64 helper executable (`screenlink-audio-helper.exe`) rather than a Node native addon or Electron's built-in loopback. This isolates native audio failures from Electron, avoids Electron ABI coupling, and allows independent testing.

The helper communicates with the Electron main process via two named pipes (one control, one binary PCM). The main process relays PCM to the renderer via MessagePorts. The renderer uses an AudioWorklet + ring buffer + MediaStreamAudioDestinationNode to produce an audio track that gets combined with the video track and published through a single VDO.Ninja session.

## Refined Implementation Phases

### Phase 1: Foundational Corrections + PublisherManager

**Gates:** 1-5

Steps:
1. **Characterization tests first** — write tests that capture current behavior before any refactoring
2. **PublisherManager extraction** — extract one authoritative owner for publisher SDK instance, capture stream, video/audio tracks, media session ID, stream credentials, peer connections, video/audio senders, stats poller, quality settings, and cleanup lifecycle from `Dashboard.tsx`
3. **Fix quality application** — `setParameters()` must be awaited, verified by reading back params, and confirmed via `getStats()`. Never return `{ success: true }` without verification.
4. **Fix relay detection** — resolve selected/nominated ICE candidate pair, check only that pair's candidate type. Report TURN relay only when selected candidate type is `relay`.
5. **Fix remembered-source matching** — require exact source ID match or one unique fingerprint match (displayId for screens; HWND/PID for windows). Never match by title alone. Reject ambiguous matches.
6. **Control-channel tests + disable fallback** — Write connectivity tests for Alice-first, Bob-first, simultaneous startup, restart, and reconnect. After all pass, set `allowFallback: false`.

### Phase 2A: Native Helper — Capabilities + Window Resolution

**Gate:** 6

- Windows build detection (`BuildNumber >= 22000` for process-loopback support)
- Native window enumeration with HWND, PID, creation time, executable path, title, bounds, cloaked state
- Unique Electron-source-to-HWND/PID/process-tree mapping
- PID reuse protection via process creation time

### Phase 2B: Native Helper — Include/Exclude Process Loopback

**Gate:** 6

- `ActivateAudioInterfaceAsync` + `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`
- Include one process tree capture
- Exclude one process tree capture
- Timestamped PCM output (QPC-based)
- Negotiated format (resample to 48kHz stereo float32)
- Silent target handling (no-error on silence)
- Clean stop (no orphaned processes)
- 30-minute standalone stability test

### Phase 2C: Native Helper — General Filtered Mixer

**Gate:** 9

- Audio session enumeration (via `IAudioSessionManager2`)
- Multiple included process trees
- Discord identification (Discord.exe, DiscordPTB.exe, DiscordCanary.exe, DiscordDevelopment.exe via executable basename + metadata)
- ScreenLink playback exclusion (self-identification)
- Dynamic session graph (add/remove sources on app start/stop)
- Software mixer (sum permitted stereo streams)
- Resampler (format conversion to 48kHz float32)

### Phase 3: Electron PCM Bridge

**Gate:** 7

- Main-process `AudioHelperManager` (path resolution, spawn, pipe I/O, monitoring, bounded restart)
- Versioned binary protocol (control messages with request/ID/response, PCM packets with magic/version/flags/seq/timestamp/format)
- Preload API additions (typed, narrow interface — no arbitrary process execution)
- Renderer `ProcessAudioController` (MessagePort receive, bounded ring buffer, AudioWorklet)
- AudioWorkletProcessor (pull from ring buffer, fill AudioWorklet output)
- MediaStreamAudioDestinationNode → audio track

### Phase 4: Combined Media + Application-Only Audio

**Gate:** 8

- Application-window source → resolve process tree → start include-process-tree capture
- Wait for valid audio track (bounded timeout)
- Construct combined MediaStream (video track + audio track)
- Publish through PublisherManager
- Prove: remote receives selected application audio only; Discord and unrelated apps are excluded

### Phase 5: Whole-Monitor Filtered Audio

**Gate:** 9

- Monitor source → enumerate active audio sessions → resolve to process trees → general mixer
- Discord exclusion and ScreenLink self-exclusion
- Dynamic updates when apps start/stop producing audio
- Combined MediaStream construction and publishing
- Prove: remote receives non-Discord, non-ScreenLink audio only

### Phase 6: Synchronization + Packaging + Endurance

**Gate:** 10

- A/V sync: native QPC timestamps → AudioWorklet presentation → drift correction (0.995-1.005x resampling)
- Audio state machine (idle → resolving → starting → buffering → active → reconnecting → error → stopping)
- Audio statistics (separate audio outbound/inbound stats via getStats)
- UI: audio mode controls, excluded applications, real diagnostics
- Packaging: CMake build → pnpm pipeline → electron-builder (exe as extraResource, outside ASAR)
- Endurance: 30-minute sync test, 8-hour stability test
- Manual tests per specification (10 test scenarios)

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Audio capture architecture | Separate native executable | Isolates failures, no Electron ABI coupling, independently testable |
| IPC transport | Named pipes (binary control + binary PCM) | Efficient, secure (per-user ACL), no base64/JSON overhead for PCM |
| PCM transport to renderer | MessagePort (transferable ArrayBuffer) | Avoids repeated JSON serialization, zero-copy for typed arrays |
| Renderer audio output | AudioWorklet + MediaStreamAudioDestinationNode | Low-latency, avoids deprecated ScriptProcessorNode, feeds directly into WebRTC |
| Excluded app identification | Executable basename + product metadata + process ancestry | More reliable than PID alone, survives app restarts |
| Exclusion mechanism | General filtered mixer (include permitted trees) | Correct by construction — cannot accidentally include excluded app |
| Mapped PCM format | 48 kHz, stereo, float32, 10ms packets | Standard WebRTC-friendly format, resampled in helper |
| Sync correction | Bounded resampling (0.995-1.005x) | Prevents drift without abrupt sample drops/insertions |

## File Structure Changes

```
native/audio-helper/
  CMakeLists.txt
  src/
    main.cpp
    Protocol.h
    NamedPipeServer.h / .cpp
    WindowCatalog.h / .cpp
    ProcessTree.h / .cpp
    AudioSessionCatalog.h / .cpp
    ProcessLoopbackCapture.h / .cpp
    Mixer.h / .cpp
    Resampler.h / .cpp

apps/desktop/src/main/
  audio-helper-manager.ts          (NEW)

apps/desktop/src/renderer/
  services/
    publisher-manager.ts           (NEW — extracted from Dashboard.tsx)
    process-audio-controller.ts    (NEW)
    audio-state-machine.ts         (NEW)
  audio/
    audio-worklet-processor.ts     (NEW)

apps/desktop/src/preload/
  index.ts                         (MODIFY — add audio API)
  api-types.ts                     (MODIFY — add audio API types)

apps/desktop/src/main/
  main.ts                          (MODIFY — register audio helper)
  ipc-handlers.ts                  (MODIFY — audio IPC handlers)
  display-media-handler.ts         (MODIFY — audio mode support)

apps/desktop/src/renderer/
  stores/main-store.ts             (MODIFY — audio state)
  routes/Dashboard.tsx             (MODIFY — use PublisherManager, audio UI)
  routes/Quality.tsx               (MODIFY — per-preset audio mode)
  routes/Settings.tsx              (MODIFY — excluded apps)
  services/media-stats-service.ts  (MODIFY — audio stats)

apps/desktop/src/main/
  settings-store.ts                (MODIFY — audio settings)
  capture-source-manager.ts        (MODIFY — native window resolution)

packages/shared/src/
  presets.ts                       (MODIFY — audio mode in presets)
  settings.ts                      (MODIFY — audio settings schema)
  control-protocol.ts              (MODIFY — audio in control messages)
```

## Validation Gates

| Gate | Criteria | Phase |
|---|---|---|
| 1 | Existing video-only behavior passes after PublisherManager extraction | Phase 1 |
| 2 | Quality changes are awaited and verified, not falsely acknowledged | Phase 1 |
| 3 | Selected ICE candidate-pair detection is correct | Phase 1 |
| 4 | Remembered-source matching requires a unique match | Phase 1 |
| 5 | Control connectivity works with signaling fallback disabled | Phase 1 |
| 6 | Standalone native include/exclude capture works for 30 min | Phase 2B |
| 7 | Binary PCM reaches AudioWorklet with bounded buffering, no leaks | Phase 3 |
| 8 | Remote receives selected-application audio only | Phase 4 |
| 9 | Remote receives monitor audio excluding Discord + ScreenLink | Phase 5 |
| 10 | Sync, reconnect, packaging, endurance tests pass | Phase 6 |
