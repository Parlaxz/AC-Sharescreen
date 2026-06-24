# Phase 2G: Filtered Monitor Audio Mode Completion

**Status:** Complete

## Summary

Phase 2G completes the Filtered Monitor audio mode — the last of three audio-sharing modes
(System Audio, Application Audio, Filtered Monitor). This mode captures audio from all
render processes except those explicitly excluded (Discord, ScreenLink itself), mixes
them into a single stereo stream, and publishes it via the existing PCM pipeline.

## Architecture

### Pipeline

```
AudioSessionMonitor (COM enumeration)
       │
       ▼
FilteredSourcePlanner (deterministic, side-effect-free)
       │
       ▼
FilteredMonitorController (orchestrator)
       │
       ├── manages ProcessLoopbackCapture × N sources
       │
       ▼
MultiSourceMixer (time-aware mixer, 48kHz stereo)
       │
       ▼
PcmBridge → AudioWorklet → MediaStream → WebRTC
```

### Key Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `AudioSessionMonitor` | `AudioSessionMonitor.h/.cpp` | Enumerate Windows audio sessions via Core Audio APIs |
| `FilteredSourcePlanner` | `FilteredSourcePlanner.h/.cpp` | Deterministic session → source mapping, no side effects |
| `FilteredMonitorController` | `FilteredMonitorController.h/.cpp` | State machine: reconcile → capture → mix loop |
| `MultiSourceMixer` | `MultiSourceMixer.h/.cpp` | Thread-safe multi-source audio mixer with headroom |
| `ExclusionPolicy` | `ExclusionPolicy.h/.cpp` | Discord/ScreenLink exclusion detection |
| `ProcessIdentity` | `FilteredMonitorTypes.h` | PID + creation time stable identity |

### Data Flow

1. **Reconcile cycle** (every ~1s): Enumerate sessions, plan sources, diff against active
2. **Source lifecycle**: Add → FeedPacket → Remove (managed by controller)
3. **Mixer output**: 480-frame (10ms) stereo float32 packets at 48kHz
4. **PCM pipeline**: Same as System Audio mode — PcmBridge → MessagePort → AudioWorklet

## Exclusion Policy

- **Discord**: Matches `discord.exe`, `discordptb.exe`, `discordcanary.exe`, `discorddevelopment.exe` (case-insensitive, full filename)
- **ScreenLink**: Matches any executable whose basename contains `screenlink` (case-insensitive, also path-based for `electron.exe` in ScreenLink directory)
- **System sounds**: PIP=0 sessions are always skipped

## MultiSourceMixer

The mixer receives timestamped `AudioPacket`s from multiple process-loopback captures:

- **Time alignment**: Uses QPC-based timestamps to align packets (driver-reported device position as fallback)
- **Headroom**: Applies `1/sqrt(n)` gain for `n` active sources to prevent clipping
- **Queue discipline**: Per-source deques with max 4 packets (~40ms) and 50ms hard age limit
- **Silence fill**: Produces silent frames when a source has no data; sets `isSilent=true` when all sources are silent
- **Zero sources**: Starting the mixer with zero sources produces continuous silence (no error)
- **Thread safety**: `FeedPacket` is lock-free per source; `AddSource`/`RemoveSource` use a global mutex

### Sequence Number Contract

The mixer provides continuous sequence numbers in its output, independent of source
additions/removals. Each 480-frame output packet gets a monotonically increasing
`sequenceNumber` starting from 0.

### Packet Format

```
AudioPacket (output):
  frames:       float* (interleaved stereo, 480 × 2 samples)
  frameCount:   480
  channels:     2
  sequenceNumber: monotonically increasing from 0
  isSilent:     true when zero sources or all sources silent
  sourceId:     always 0 for mixed output
```

## Self-Tests (Phase 2G)

Located in `native/audio-helper/src/Phase2GSelfTest.cpp`.

### Test Categories

| Category | Tests | Description |
|----------|-------|-------------|
| FilteredSourcePlanner | 2 | Empty inventory, system sounds skipped |
| ProcessIdentity | 3 | Equality, IsValid, same-PID different creation time |
| ExclusionPolicy | 2 | Discord variants, ScreenLink exclusion |
| MultiSourceMixer | 5 | Zero sources, sequence numbers, add/remove, unique IDs, packet size |
| Lifecycle | 2 | Double-stop safety, start/stop/start cycle |

### Running

```bash
# Via native helper
screenlink-audio-helper.exe --self-test

# Phase 2G tests run as part of the standard --self-test suite,
# invoked before Phase 2E test sections.
```

## TypeScript Tests

Located in `apps/desktop/tests/audio-phase-2g.test.ts`.

### Test Coverage (20+ tests)

| # | Test | Description |
|---|------|-------------|
| 1 | Separate capability/service protocol constants | `kProtocolVersion` ≠ `kServiceProtocolVersion` |
| 2 | ControlClient sends service protocol 0.3.0 | Hello request uses `serviceProtocolVersion: "0.3.0"` |
| 3 | AudioHelperManager rejects incompatible hello protocol | Throws when helper reports unexpected protocol |
| 4 | Filtered monitor start uses typed ControlClient method | `startFilteredMonitorAudio` calls `SendCommand` |
| 5 | screenLinkPid equals Electron main process.pid | PID sent to helper matches `process.pid` |
| 6 | Positive safe stream-generation validation | `Number.isSafeInteger(gen)` for stream generation |
| 7 | System result pipeline is endpoint-direct | System Audio uses `EndpointLoopbackSource` |
| 8 | Filtered result pipeline is dynamic-process-mix | Filtered uses `MultiSourceMixer` |
| 9 | Capability gating keeps System Audio independent | System Audio does not require process-loopback support |
| 10 | Filtered Monitor requires process-loopback support | Filtered mode checks `cap.processLoopbackRuntimeSupported` |
| 11 | Video-only fallback remains present | Unchanged from Phase 2D |
| 12 | Application Audio remains direct (no mixer) | Validated in IPC handler structure |
| 13 | ServiceSession has one application source, one controller, one endpoint | ServiceSession sources architecture |
| 14 | Duplicate destructor cleanup is removed | No double-cleanup pattern in controller |
| 15 | Monotonic generation has no fetch_sub rollback | Generation is strictly monotonic |
| 16 | New diagnostics are typed | `FilteredMonitorDiagnostics` and `MixerDiagnostics` |
| 17 | Existing audio mode persistence intact | Saved modes still work |
| 18 | Dashboard labels accurately describe System vs Filtered Monitor | UI labels match mode semantics |
| 19 | Application Audio direct pipeline preserved | No mixer in Application Audio path |
| 20 | System Audio ServiceSession handler creates no mixer source | Handler uses endpoint loopback directly |

## Protocol Extension

The control protocol is extended to support Filtered Monitor:

```json
{
  "protocolVersion": "0.2.0",
  "serviceProtocolVersion": "0.3.0",
  "command": "startFilteredMonitorAudio",
  "payload": {
    "screenLinkPid": 12345,
    "excludeDiscord": true,
    "excludeScreenLink": true
  }
}
```

### Version Compatibility

| Protocol | Supported Modes |
|----------|----------------|
| 0.1.0 | Version, Capabilities, Enumerate |
| 0.2.0 | + System Audio, Application Audio |
| 0.3.0 | + Filtered Monitor, structured diagnostics |

## Files Changed

### New Files
- `native/audio-helper/src/Phase2GSelfTest.h` — Self-test header
- `native/audio-helper/src/Phase2GSelfTest.cpp` — Self-test implementation
- `docs/PHASE_2G_AUDIO_MODE_COMPLETION.md` — This document
- `apps/desktop/tests/audio-phase-2g.test.ts` — TypeScript tests

### Modified Files
- `native/audio-helper/CMakeLists.txt` — Added new .cpp files to SOURCES
- `native/audio-helper/src/main.cpp` — Added Phase2G self-test invocation
