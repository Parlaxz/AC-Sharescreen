# Audio Implementation Baseline

Date: 2026-06-21
Commit: cf70c42 (main)
Git: clean working tree

## Current Versions

| Component | Version |
|---|---|
| Node.js | 25.2.1 |
| pnpm | 10.0.0 |
| Electron | 42.4.1 |
| Chromium | (Electron 42) |
| TypeScript | ^5.7.0 |
| VDO.Ninja SDK | 1.3.18 |
| electron-builder | 25.1.8 |
| Windows Build | 10.0.19045 (22H2) |
| Windows SDK | 10.0.22000.0 |
| MSVC | 14.35.32215 |
| CMake | 4.3.3 |
| Architecture | AMD64 |

## Build & Test Status

- **build:shared**: passes
- **build:vdo-adapter**: passes
- **test:run**: 8 test files, 111 tests, all pass

## What Currently Works

### Media Pipeline
- Screen sharing via HostPublisher (VDO.Ninja SDK wrapper)
- Remote viewing via ViewerClient
- getDisplayMedia-based capture with pre-approved source via `setDisplayMediaRequestHandler`
- Source enumeration via `desktopCapturer.getSources()` (screens + windows)
- Source picker UI with thumbnails, periodic refresh (5s)
- Source fingerprint generation and persistence

### Pairing
- Full lifecycle: create → export code → import → confirm → paired
- VDO.Ninja data channel for control messages (announce/joinRoom)
- 12 control message types: peer.hello, peer.hello.response, state.request, state.response, share.started, share.stopped, share.updated, quality.request, quality.applied, quality.rejected, ping, pong
- State machine: PAIR_CREATED_WAITING_FOR_IMPORT, PAIR_IMPORTED_CONNECTING, PAIR_CONNECTED_UNCONFIRMED, PAIRED_ONLINE, PAIRED_OFFLINE
- Encrypted pair secret storage via Electron safeStorage
- Dev profile isolation (alice/bob with separate userData)
- Multi-instance support (`--multi-instance`)

### UI & UX
- Dashboard with sharing/viewing status
- Quality presets (5 presets + custom sliders)
- Source picker (screens + windows with thumbnails)
- Settings page
- Fullscreen viewer (native Electron toggle)
- Close-to-tray
- Launch at login
- Tray with sharing/viewing state

### Infrastructure
- pnpm monorepo (shared, vdo-adapter, desktop)
- Vite + TypeScript + React 19 + Zustand
- Atomic settings persistence with backup
- Electron-builder packaging (NSIS + portable)
- Shared package with Zod schemas, URL builders, IDs, presets, control protocol, bitrate calculator

## What Is Stubbed / Placeholder

### `display-media-handler.ts` System Audio
- `systemAudioEnabled` boolean passes `"loopback"` to `getDisplayMedia` callback
- This is Electron's basic unfiltered system audio loopback
- Captures ALL system audio — no application filtering, no Discord exclusion
- Not actually used by any caller (Dashboard always passes `audio: false`)

### `control-connection.ts` applyQualityToSender (line 597)
- Stub: always returns `true` without actually applying parameters
- Never resolves the RTCRtpSender or calls setParameters

### `sender-parameters.ts` applyQualityToSender
- `setParameters()` is called with `.catch(() => {})` — error is silently swallowed
- Return value promises `{ success: true }` before setParameters resolves
- Does not read back parameters or verify via getStats

### `media-stats-service.ts` Relay Detection (line 167-173)
- Sets `isRelay = true` if ANY candidate (local or remote) has `candidateType === "relay"`
- Does not check only the **selected** candidate pair
- Could falsely report TURN relay when a relay candidate exists but is not selected

### `media-stats-service.ts` Audio Statistics
- No audio statistics collected (video-only: `kind === "video"`)
- No audio-specific fields (audioLevel, totalAudioEnergy, concealedSamples, etc.)

### `capture-source-manager.ts` Window Fingerprint Matching (line 78-83)
- Falls back to matching by `name` only when displayId match fails
- No process tree validation, no HWND resolution, no PID verification

## What Is Missing vs Specification

| Requirement | Status |
|---|---|
| Authoritative publisher manager (single owner of media lifecycle) | Missing — Dashboard refs own publisher, stream, tracks independently |
| Real quality application (await+verify setParameters) | Missing — stub in control-connection, silent catch in sender-parameters |
| Control channel allowFallback:false | Uses `allowFallback: true` |
| Direct-vs-TURN via selected candidate pair | Bug — checks all candidates |
| Remembered source unique match | Window fallback matches by name only |
| Audio preset accuracy (audio != active track) | No audio presets applied |
| Windows application loopback capture | Entirely missing |
| Native audio helper executable | Entirely missing |
| Window-to-process mapping | Entirely missing |
| Discord identification/exclusion | Entirely missing |
| ScreenLink self-exclusion | Entirely missing |
| General filtered mixer (multiple exclusions) | Entirely missing |
| Audio state machine | Entirely missing |
| AudioWorklet pipeline | Entirely missing |
| Combined audio/video MediaStream | Missing — audio: false in getDisplayMedia |
| A/V synchronization | Entirely missing |
| Audio statistics (separate audio/video) | Missing |
| Audio mode controls in UI | Entirely missing |
| Excluded-applications UI | Entirely missing |
| Windows build version detection | Entirely missing |
| Native helper packaging | Entirely missing |
| Audio helper lifecycle management (main process) | Entirely missing |
| Preload audio API | Entirely missing |
| Diagnostic recording | Entirely missing |

## Files Involved

### Will be created
- `native/audio-helper/CMakeLists.txt`
- `native/audio-helper/src/main.cpp`
- `native/audio-helper/src/Protocol.h`
- `native/audio-helper/src/NamedPipeServer.h` / `.cpp`
- `native/audio-helper/src/WindowCatalog.h` / `.cpp`
- `native/audio-helper/src/ProcessTree.h` / `.cpp`
- `native/audio-helper/src/AudioSessionCatalog.h` / `.cpp`
- `native/audio-helper/src/ProcessLoopbackCapture.h` / `.cpp`
- `native/audio-helper/src/Mixer.h` / `.cpp`
- `native/audio-helper/src/Resampler.h` / `.cpp`
- `apps/desktop/src/main/audio-helper-manager.ts`
- `apps/desktop/src/renderer/services/process-audio-controller.ts`
- `apps/desktop/src/renderer/audio/audio-worklet-processor.ts` (or .js)
- `apps/desktop/src/renderer/services/audio-state-machine.ts`
- `apps/desktop/src/renderer/services/publisher-manager.ts`
- Additional test files

### Will be modified
- `apps/desktop/src/main/main.ts` — register audio helper manager, new IPC
- `apps/desktop/src/main/ipc-handlers.ts` — audio-related IPC handlers
- `apps/desktop/src/main/display-media-handler.ts` — audio mode support
- `apps/desktop/src/preload/index.ts` — audio API exposure
- `apps/desktop/src/preload/api-types.ts` — audio API types
- `apps/desktop/src/renderer/stores/main-store.ts` — audio state
- `apps/desktop/src/renderer/routes/Dashboard.tsx` — audio UI, combined stream
- `apps/desktop/src/renderer/routes/Quality.tsx` — per-preset audio mode
- `apps/desktop/src/renderer/routes/Settings.tsx` — excluded apps
- `apps/desktop/src/renderer/services/media-stats-service.ts` — audio stats
- `apps/desktop/src/renderer/services/control-connection.ts` — audio in share messages
- `apps/desktop/src/main/settings-store.ts` — audio settings
- `packages/shared/src/presets.ts` — audio mode in presets
- `packages/shared/src/settings.ts` — audio settings schema
- `packages/vdo-adapter/src/sender-parameters.ts` — await+verify setParameters
- `packages/vdo-adapter/src/connection-access.ts` — audio sender access
- `apps/desktop/src/main/capture-source-manager.ts` — native window resolution
- `apps/desktop/src/main/app-lifecycle.ts` — helper lifecycle (maybe)
- `package.json` — build scripts for native helper

## Prior Implementation Notes

No prior audio implementation exists. The project was initialized with screen sharing and pairing only.
