# Phase 2C: Native Helper Service Mode and Local PCM Transport

**Status:** Complete
**Date:** 2026-06-21
**Starting commit:** `9ed1865` (Phase 2B clean)
**Ending commits:** `4dd5a23` (Phase 2C final)
**TypeScript/C++ alignment:** Commit `8fb1c41` (C++ security/ordering), TS alignment above

## Architecture

Two local Windows named pipes:

- **Control pipe** (`\\.\pipe\screenlink-{sessionId}-ctrl`): JSON request/response protocol, message-mode
- **PCM pipe** (`\\.\pipe\screenlink-{sessionId}-pcm`): Binary packet stream, byte-mode

### Flow

```
Electron main process
  → spawns screenlink-audio-helper.exe --serve
  → connects control pipe (message-mode named pipe)
  → performs hello handshake
  → connects PCM pipe (byte-mode named pipe)
  → sends startSynthetic or startProcessCapture
  → helper streams binary AudioPacket records through PCM pipe
  → Electron reads, parses, validates, counts packets (no renderer)
  → stopCapture / shutdown
```

## Control Protocol

**Version:** 0.2.0
**Transport:** Windows named pipe, message mode, JSON-framed

### Request format

```json
{
  "protocolVersion": "0.2.0",
  "requestId": 1,
  "sessionId": "<random-hex>",
  "authToken": "<random-hex>",
  "command": "hello|getVersion|getCapabilities|getState|startSynthetic|startProcessCapture|stopCapture|getDiagnostics|ping|shutdown",
  "payload": {}
}
```

### Response format

```json
{
  "protocolVersion": "0.2.0",
  "requestId": 1,
  "sessionId": "<random-hex>",
  "success": true,
  "state": "idle|starting|capturing|stopping|error",
  "result": {},
  "error": null
}
```

### Commands

| Command | Description | Key payload fields |
|---------|-------------|-------------------|
| hello | Validate handshake | — |
| getVersion | Return version info | — |
| getCapabilities | Same as --capabilities | — |
| getState | Current session state | — |
| startSynthetic | Start synthetic PCM | mode, durationMs, totalPackets, framesPerPacket |
| startProcessCapture | Start real capture | targetPid, expectedCreationTimeUtc100ns, mode |
| stopCapture | Stop active capture | — |
| getDiagnostics | Detailed stats | — |
| ping | Health check | — |
| shutdown | Graceful exit | — |

### States

- `idle`: Connected, no capture active
- `starting`: Capture is starting
- `capturing`: Capture is active, PCM streaming
- `stopping`: Capture is stopping
- `error`: Error state

## PCM Wire Protocol

**Header size:** 68 bytes (packed, little-endian)
**Payload:** Interleaved IEEE float32 PCM samples

### Header layout

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 4 | magic | 0x50434D21 ("PCM!") |
| 4 | 2 | headerSize | 68 |
| 6 | 2 | wireVersion | 1 |
| 8 | 4 | flags | Bitmask (see below) |
| 12 | 8 | sequenceNumber | Monotonic per stream generation |
| 20 | 8 | qpcTimestamp | QPC counter at capture time |
| 28 | 8 | qpcFrequency | QPC frequency (set per packet) |
| 36 | 8 | devicePosition | Audio device position frames (0 for synthetic) |
| 44 | 4 | sampleRate | 48000 |
| 48 | 2 | channels | 2 |
| 50 | 2 | sampleFormat | 0 = IEEE float32 |
| 52 | 4 | frameCount | Frames in this packet |
| 56 | 4 | payloadBytes | Byte count following header |
| 60 | 4 | streamGeneration | Incremented per startCapture/Synthetic |
| 64 | 4 | droppedPackets | Queue overflow count before this packet |

### Flags

| Value | Name | Description |
|-------|------|-------------|
| 1 | kPcmFlagSilent | Packet contains silence (zeros) |
| 2 | kPcmFlagDiscontinuity | Data discontinuity occurred |
| 4 | kPcmFlagTimestampError | Timestamp may be invalid |
| 8 | kPcmFlagSynthetic | Packet is from synthetic source |
| 16 | kPcmFlagEndOfStream | Last packet in stream |

### Constants

- `HEADER_SIZE`: 68 bytes
- `MAX_FRAMES_PER_PACKET`: 960 (20ms at 48kHz)
- `MAX_PAYLOAD_BYTES`: 7680 (960 * 2 * 4)
- `MAX_PACKET_BYTES`: 7748 (68 + 7680)
- Default frame rate: 48000 Hz
- Default channels: 2
- Default frame count: 480 (10ms)
- Default queue size: 15 packets (~150ms)
- Kernel pipe buffer: 64 KB

### QPC Frequency

- The `qpcFrequency` field in each PCM header contains the real `QueryPerformanceFrequency` value obtained at helper startup
- Previously hardcoded at 10 MHz — now dynamically queried via `QueryPerformanceFrequency(&li)`
- This ensures accurate timestamp conversion regardless of hardware
- Both the C++ helper and TypeScript `BinaryPcmParser` use the per-packet frequency for any QPC-to-microsecond conversion

## Byte Order

All integers are little-endian (native x64). Named pipes are local-only — no network byte-order conversion is needed.

## Pipe Security

- Pipe names are randomly generated per session (32 hex chars)
- Format: `\\.\pipe\screenlink-{sessionId}-ctrl` and `\\.\pipe\screenlink-{sessionId}-pcm`
- Session authentication: random auth token validated on every control request
- **Pipe DACL:** Explicit current-user security descriptor created via `CreateWellKnownSid(WinCurrentUserSid)` + `SetSecurityDescriptorDacl(TRUE)`. This replaces the default DACL to ensure no inherited permissions leak to other users.
- **Remote client rejection:** `PIPE_REJECT_REMOTE_CLIENTS` flag is set on both pipes, ensuring only local connections are accepted even if the pipe name is somehow exposed.
- **Client PID validation:** The control pipe validates the client's PID via `GetNamedPipeClientProcessId`. Only the expected parent PID is allowed to connect to the PCM pipe. PCM pipe connections from unexpected PIDs are rejected at the pipe server level.
- No network access: `\\.\pipe\` prefix restricts to local machine
- No global static pipe names

## Session Authentication

Each helper instance receives a random session ID and auth token at launch:

```
--session-id <32-char-hex> --auth-token <32-char-hex>
```

Every control request must include both. The helper validates them before processing.
The auth token is never logged.

## Helper Lifecycle

### Startup

1. Electron generates random session ID and auth token
2. Electron spawns helper with `--serve` and all required arguments
3. Helper validates arguments, creates control and PCM named pipes (server)
4. Helper waits for control connection
5. Electron connects control pipe (retry with 5s timeout)
6. Handshake: Electron sends `hello`, helper responds with version
7. Helper creates PCM pipe server
8. Electron connects PCM pipe (retry with 5s timeout) — **PCM pipe must be connected before startSynthetic/startProcessCapture**
9. Ready for commands
10. Electron sends `startSynthetic` or `startProcessCapture`

> **PCM-first ordering:** The C++ `startSynthetic` command waits up to 1 second for the PCM client to connect before beginning capture. If no PCM client connects within that window, `startSynthetic` returns error `"pcm-not-connected"`. The TypeScript integration test and stability script both connect the PCM pipe **before** sending `startSynthetic` to avoid this delay.

### Capture

1. Electron sends `startSynthetic` or `startProcessCapture`
2. Helper creates new stream generation
3. Helper starts capture thread
4. Capture callback pushes PcmPacket to bounded SPSC queue
5. PCM writer thread reads from queue and writes to PCM pipe
6. Electron reads PCM pipe through BinaryPcmParser streaming parser

### Shutdown

1. Electron sends `stopCapture` (if capturing)
2. Helper stops capture thread, returns to idle
3. Electron sends `shutdown`
4. Helper closes pipes, exits with code 0
5. Electron closes pipe file descriptors

### Parent Loss

- Helper monitors parent PID via `OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject`
- If parent exits, helper detects within 1 second
- Helper stops capture, closes pipes, exits

### Helper Crash

- Electron detects exit via child process `exit` event
- Closes pipe resources
- Rejects pending requests
- Optional: auto-restart with max 3 retries and 5s cooldown
- Does not kill unrelated processes

## Backpressure Policy

### Helper Side (PcmWriter)

- **Maximum queued packets:** 15 (~150ms at 10ms packets)
- **Kernel pipe receive buffer:** 64 KB (reduced from default for tighter latency control)
- **Overflow policy:** Drop oldest queued packets
- **Dropped-packet counter:** `droppedPackets` field in PCM header
- **Next packet after drop:** Marked with discontinuity flag
- **Capture thread:** Never blocks on a full queue (TryPush returns false)
- **Pipe write thread:** Synchronous WriteFile (blocks on kernel pipe buffer)

### Electron Side (BinaryPcmParser)

- **Parser buffer limit:** 1MB (configurable)
- **Overflow:** Error reported via error callback, parser resets
- **After EOS:** Subsequent packets are error-reported
- **Stream generation mismatch:** Packets from old generation are rejected

## Synthetic Source

**Purpose:** Transport testing on machines without process-loopback support (build < 20348)

### Modes

| Mode | Value | Description |
|------|-------|-------------|
| kContinuousTone | 0 | 440Hz A4 sine wave, 0.25 amplitude |
| kSilence | 1 | All-zero frames |
| kToneSilenceTone | 2 | 1/3 tone, 1/3 silence, 1/3 tone |
| kOneDiscontinuity | 3 | Continuous tone with one discontinuity flag |
| kOneSkippedSequence | 4 | Continuous tone with one skipped sequence number |
| kEndOfStream | 5 | Normal packets ending with EndOfStream flag |

### Parameters

- Sample rate: 48000 Hz
- Channels: 2 (stereo interleaved)
- Frame count: 480 (10ms) default
- Amplitude: 0.25 (safe level, no clipping)
- QPC timestamps: Real QueryPerformanceCounter values
- Device position: Accumulated frame count

## Unsupported Real-Capture Behavior

On Windows build 19045 (current dev machine):

- `startProcessCapture` returns error: `{ "unsupported-os", "Build 19045 is below 20348, process-loopback not supported" }`
- No audio activation is attempted
- No PCM stream is started
- `startSynthetic` works normally

## Diagnostics

Tracked per session (via getDiagnostics):

| Field | Description |
|-------|-------------|
| totalPackets | Packets sent to PCM pipe |
| totalPayloadBytes | Raw audio byte count |
| droppedPackets | Packets dropped due to queue overflow |
| queueSize | Current queue depth |
| packetsWritten | Packets successfully written to pipe |
| writeErrors | Pipe write failures |
| totalControlRequests | Control requests processed |
| failedControlRequests | Control requests rejected |
| uptimeMs | Milliseconds since helper started |
| activeSourceType | "synthetic", "process", or empty |
| state | Current session state |
| streamGeneration | Current stream generation |

## Stream Generations

Every `startSynthetic` or `startProcessCapture` creates a new stream generation.
The generation number is an incrementing uint32 in the PCM header.
Electron rejects packets from old generations.

## Process Ownership

- Helper PID recorded at spawn time
- Process creation time recorded (via GetProcessCreationTime)
- Session ID ties helper to its Electron parent
- Parent process monitored via OpenProcess + WaitForSingleObject

## Build Commands

| Command | Description |
|---------|-------------|
| `pnpm audio-helper:check` | Build + self-test |
| `pnpm audio-helper:serve-test` | Run integration tests |
| `pnpm audio-helper:transport-test` | Build + integration tests |
| `pnpm audio-helper:transport-stability` | 30-minute stability test |
| `pnpm test` (or `pnpm vitest run`) | All unit tests |

## Test Results

- **C++ self-tests:** All pass (zero warnings, `/W4 /WX`)
- **TypeScript unit tests:** All pass
- **Integration tests:** Run real helper + named pipes
- **30-minute stability:** See stability test output

### Integration Test Steps

1. Spawn real helper in --serve mode
2. Connect control named pipe
3. Hello handshake
4. Query initial state (getVersion, getCapabilities, getState, ping)
5. **Connect PCM named pipe** (before startSynthetic — PCM-first ordering)
6. Start synthetic capture
7. Read and parse PCM packets
8. Verify sequence integrity
9. Stop capture
10. Shutdown
11. Verify no orphan process

> **PCM-first ordering:** Step 5 (PCM pipe connect) occurs before step 6 (startSynthetic). The C++ helper waits up to 1s for the PCM client; connecting PCM first eliminates this startup delay.

## Files Added

| File | Purpose |
|------|---------|
| `native/audio-helper/src/PipeTransport.h` | PCM wire protocol, packed header, SPSC queue, pipe writer |
| `native/audio-helper/src/PipeTransport.cpp` | Implementation |
| `native/audio-helper/src/SyntheticSource.h` | Deterministic PCM generator |
| `native/audio-helper/src/SyntheticSource.cpp` | Implementation with 6 modes |
| `native/audio-helper/src/ServiceSession.h` | Persistent service mode |
| `native/audio-helper/src/ServiceSession.cpp` | Control server, PCM streaming, lifecycle |
| `apps/desktop/src/main/BinaryPcmParser.ts` | Streaming PCM parser for Electron |
| `apps/desktop/src/main/ControlClient.ts` | Typed control pipe client |
| `apps/desktop/src/main/AudioHelperManager.ts` | Process lifecycle manager |
| `apps/desktop/tests/binary-pcm-parser.test.ts` | 34 parser tests |
| `apps/desktop/tests/binary-pcm-golden.test.ts` | 20+ golden fixture / cross-language header agreement tests |
| `apps/desktop/tests/control-client.test.ts` | 15 protocol tests |
| `apps/desktop/tests/integration/helper-service.test.ts` | Real pipe integration tests (PCM-first ordering) |
| `apps/desktop/scripts/transport-stability.mjs` | 30-minute stability runner (PCM-first ordering) |

## Limitations

- **No AudioWorklet exists yet** — PCM is parsed and counted in Electron main, not rendered
- **No browser audio track exists yet** — no MediaStreamTrack construction
- **No VDO audio publishing exists yet** — PCM does not reach remote peers
- **No Discord exclusion mixer exists yet** — per-application filtering not implemented
- **Real process-loopback capture remains runtime-unverified** until tested on Windows build >= 20348
- **Current machine: Windows 10 build 19045** — only synthetic source works here
- **Node.js fs.openSync/readSync for named pipes** — synchronous I/O in main process; acceptable for Phase 2C

## Next Phase

Phase 2D: Renderer AudioWorklet transport:

1. AudioWorklet processor receives parsed PCM from main process
2. Constructs browser MediaStreamTrack
3. Publishes through VDO.Ninja/WebRTC
4. Multi-application mixer (Discord exclusion)
5. Audio UI (mute, volume, source selection)
