# Phase 2B — Supported-Machine Test Plan

This document describes tests that can **only** be run on a Windows machine with
build >= 20348 (the process-loopback runtime minimum for `--capture-test`).

## Prerequisites

1. **Windows build >= 20348**
   - Windows Server 2022 (build 20348) or later
   - Windows 11 (build 22000) or later
   - Verify: `winver` or the helper's own `--capabilities` command.

2. **Helper binary built**
   ```powershell
   cd native/audio-helper
   cmake -B build -S . -A x64
   cmake --build build --config Release -- /nologo
   ```
   Binary at: `build/Release/screenlink-audio-helper.exe`

3. **Helper self-test passes** (basic sanity before running capture tests)
   ```powershell
   .\build\Release\screenlink-audio-helper.exe --self-test
   ```

4. **WAV playback tool** (any of the following):
   - Windows Media Player (`wmplayer.exe`)
   - VLC media player
   - Audacity
   - `ffprobe` or a hex dump tool to inspect WAV headers

5. **An audio-producing application** for capture tests:
   - Browser playing audio (Chrome, Edge, Firefox — YouTube, Spotify Web, etc.)
   - Media player (VLC, Windows Media Player, foobar2000)
   - Communication app (Discord, Teams, Zoom, Slack)

## Test 1: Verify `IsProcessLoopbackSupported` returns true

Run the self-test — it includes a deterministic check:

```powershell
.\build\Release\screenlink-audio-helper.exe --self-test
```

**Expected**: Exit code 0, stdout contains `"selfTestPassed": true`.

**What it verifies**: The helper's `IsProcessLoopbackSupported()` function (used
internally) returns a consistent `true` value on a supported build.

---

## Test 2: Capture from a known audio-producing app (include mode)

1. Open a browser and play audio (e.g., YouTube).
2. Find the PID of the browser tab's process:
   ```powershell
   .\build\Release\screenlink-audio-helper.exe --enumerate-sources
   # Look for entries where hasAudio=true
   ```
   Or use Task Manager (`tasklist /FI "IMAGENAME eq chrome.exe"`).

3. Run capture (5-second include-mode capture):
   ```powershell
   .\build\Release\screenlink-audio-helper.exe --capture-test <pid> --duration-ms 5000 --output youtube-test.wav
   ```

**Expected**:
- Exit code 0
- stdout contains `"status": "ok"`, `"framesCaptured"` > 0, `"bytesWritten"` > 44
- File `youtube-test.wav` exists and is playable (contains audio content, not silence)
- File size > 44 bytes (WAV header)

---

## Test 3: Exclude mode capture

1. With the same audio-producing application running:
   ```powershell
   .\build\Release\screenlink-audio-helper.exe --capture-test <pid> --duration-ms 5000 --output exclude-test.wav --mode exclude
   ```

**Expected**:
- Exit code 0
- stdout contains `"status": "ok"`
- File `exclude-test.wav` exists
- Audio content should be the system mix **minus** the target process's audio
  (i.e., captures everything else playing on the system)

---

## Test 4: Short duration edge case (100 ms)

```powershell
.\build\Release\screenlink-audio-helper.exe --capture-test <pid> --duration-ms 100 --output short-test.wav
```

**Expected**:
- Exit code 0
- `"framesCaptured"` corresponds to ~100 ms at 48000 Hz = ~4800 frames
- File exists and is valid WAV (can open header)

---

## Test 5: Verify WAV file header

Use `ffprobe` or a hex dump to inspect the captured WAV's header:

```powershell
# With ffprobe:
ffprobe -show_streams youtube-test.wav

# With PowerShell hex dump:
$bytes = [System.IO.File]::ReadAllBytes("youtube-test.wav")
# RIFF header at offset 0
Write-Host "RIFF: $([char]$bytes[0])$([char]$bytes[1])$([char]$bytes[2])$([char]$bytes[3])"
# Sample rate at offset 24 (4 bytes, little-endian)
$sampleRate = [System.BitConverter]::ToUInt32($bytes, 24)
Write-Host "Sample rate: $sampleRate Hz"
# Channels at offset 22 (2 bytes, little-endian)
$channels = [System.BitConverter]::ToUInt16($bytes, 22)
Write-Host "Channels: $channels"
# Bits per sample at offset 34 (2 bytes, little-endian)
$bitsPerSample = [System.BitConverter]::ToUInt16($bytes, 34)
Write-Host "Bits per sample: $bitsPerSample"
```

**Expected WAV format**:
| Field | Expected Value | Offset |
|---|---|---|
| RIFF header | `RIFF` (0x52494646) | 0 |
| Format tag | `WAVE` (0x57415645) | 8 |
| Audio format | 3 (IEEE float) | 20 |
| Channels | 2 (stereo) | 22 |
| Sample rate | 48000 | 24 |
| Bits per sample | 32 | 34 |

---

## Test 6: Enumerate sources and verify Electron detection

```powershell
.\build\Release\screenlink-audio-helper.exe --enumerate-sources
```

**Expected**:
- Exit code 0
- stdout contains `"status": "ok"`
- `"sourceCount"` > 0
- Known Electron apps (Discord, Slack, VS Code, Teams, Spotify) should have:
  - `"isElectron": true`
  - `"electronConfidence": "process-name"` or `"low"`
  - `"hasAudio": true` when the window is visible and non-cloaked

**Manual verification**: Cross-reference with Task Manager — confirm that the
helper detected the correct Electron apps on your system.

---

## Test 7: Process tree resolution for Electron apps

Find a known Electron app's PID from Test 6 output, then:

```powershell
.\build\Release\screenlink-audio-helper.exe --resolve-process-tree <pid>
```

**Expected**:
- Exit code 0
- stdout contains `"status": "ok"`
- `"processChainDepth"` >= 1
- The first entry in `"processes"` has `"processId"` matching the requested PID
- Subsequent entries are the parent, grandparent, etc. (if any)
- Each entry has non-empty `"processName"` and `"processPath"`

For a typical Electron app launched from Explorer, the chain might look like:
```
PID 1234 (electron.exe) → PID 4321 (cmd.exe) → PID 8888 (explorer.exe)
```

---

## How to Verify Results

### Play the WAV file
```powershell
Start-Process .\youtube-test.wav
```
Or open in Audacity/VLC to visually inspect the waveform.

### Check file size
```powershell
(Get-Item .\youtube-test.wav).Length
```
Minimum size = 44 bytes (header only, empty capture). A real 5-second capture at
48000 Hz stereo 32-bit float = 44 + (48000 × 5 × 2 × 4) = 1,920,044 bytes (~1.83 MB).

### Inspect header integrity
Use the hex dump PowerShell snippet from Test 5 above.

### Verify no silent capture
Open the WAV in an audio editor. If the waveform is flat, the capture did not
pick up audio — check that the target process was actually producing audio.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `error: "audio-device-not-available"` | No active audio renderer on the system | Ensure speakers/headphones are plugged in and audio is playing |
| `error: "com-initialization-failed"` | COM not initialized or fails | Run from a normal user desktop session (not a service or WinRM) |
| `error: "unsupported-windows-build"` | Build < 20348 | Run `winver` to confirm build. Process-loopback requires >= 20348 |
| `error: "missing-pid-argument"` | PID not provided | Add the PID: `--capture-test 1234` |
| `"framesCaptured": 0` | No audio data captured | Confirm the target process is actively producing audio |
| `"framesCaptured"` too low | Duration too short | Increase `--duration-ms` (min recommended: 1000) |
| Helper crashes on start | Missing VC++ redist or corrupted binary | Rebuild from source: `cmake --build build --config Release` |
| `"isElectron": false` for known Electron app | Process name doesn't match heuristic | The helper checks for "electron" in the process name. If the app uses a custom executable name (e.g., `discord.exe`), confidence may be `"low"` (path-based detection) |
| Enumeration returns 0 windows | Running as a different session (e.g., service) | Run from an interactive user desktop session |
| WAV file sounds like static/noise | Format mismatch; data was written incorrectly | Verify WAV header with the hex dump snippet — should be 48000 Hz, stereo, 32-bit float |

## Test Results Recording

Use this table to record results when running on a supported machine:

| Test # | Description | Expected Result | Actual Result | Pass/Fail |
|---|---|---|---|---|
| 1 | `--self-test` passes | Exit 0, `selfTestPassed: true` | | |
| 2 | Capture from audio app (include) | Non-empty WAV, exit 0 | | |
| 3 | Capture from audio app (exclude) | Non-empty WAV, exit 0 | | |
| 4 | Short duration (100ms) | ~4800 frames, exit 0 | | |
| 5 | WAV header integrity | 48000 Hz, stereo, 32-bit float | | |
| 6 | Source enumeration + Electron | Known Electron apps detected | | |
| 7 | Process tree resolution | Chain includes target PID | | |

**Date tested**: \
**Windows build**: \
**Helper version**: \
**Tester**:
