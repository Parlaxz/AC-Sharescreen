# Phase 2A: Audio Capability Detection

## Status

Phase 2A is complete. No audio capture, Discord exclusion, selected-application audio,
PCM transport, or UI audio modes exist yet.

## Native Toolchain

- **Compiler**: MSVC 14.35.32215 (Visual Studio 2022 Community)
- **CMake**: 4.3.3
- **Generator**: Visual Studio 17 2022 (-A x64)
- **Windows SDK**: 10.0.22000.0
- **C++ Standard**: C++20
- **Target**: Windows x64 native executable

## Helper Build Path

```
native/audio-helper/build/Release/screenlink-audio-helper.exe
```

## Commands

| Script | Purpose |
|---|---|
| `pnpm audio-helper:configure` | Run CMake configure |
| `pnpm audio-helper:build` | Build Release configuration |
| `pnpm audio-helper:self-test` | Run native --self-test |
| `pnpm audio-helper:clean` | Remove build directory |
| `pnpm audio-helper:check` | Build + self-test |

## Protocol Version

Current: **0.1.0**

## Capability Response Schema

### --help
Stderr: usage message
Stdout: JSON error with `error: "invalid-arguments"`
Exit: 1

### --version
```json
{
  "protocolVersion": "0.1.0",
  "helperVersion": "0.1.0",
  "status": "ok"
}
```

### --capabilities
```json
{
  "protocolVersion": "0.1.0",
  "helperVersion": "0.1.0",
  "architecture": "x64",
  "status": "ok",
  "operatingSystem": "Windows",
  "osVersion": { "major": 10, "minor": 0, "build": 19045, "revision": 0 },
  "detectionMethod": "RtlGetVersion",
  "detectionSucceeded": true,
  "compiledWindowsSdkVersion": "10.0.22000.0",
  "processLoopbackHeadersAvailable": true,
  "processLoopbackRuntimeSupported": false,
  "applicationLoopbackSupported": false,
  "usable": false,
  "is64BitProcess": true,
  "is64BitOperatingSystem": true,
  "reasonCode": "unsupported-windows-build",
  "reasonMessage": "Windows build 19045 is below the minimum required build 22000 for process-loopback audio."
}
```

### --self-test
```json
{
  "protocolVersion": "0.1.0",
  "helperVersion": "0.1.0",
  "status": "ok",
  "selfTestPassed": true
}
```

## Windows Build Detection

- **Method**: `RtlGetVersion` from `ntdll.dll` (not `GetVersionEx`)
- **Rationale**: `GetVersionEx` is affected by the application manifest and can return
  incorrect values. `RtlGetVersion` always returns the real OS build number.
- **Failure modes**: ntdll.dll not loaded (impossible on Windows), function not found
  (impossible since Windows 2000), status != STATUS_SUCCESS
- **Detection method reported**: `"RtlGetVersion"` on success, `"failed"` on failure

## Minimum Supported Build

- **Constant**: `kMinProcessLoopbackBuild = 22000`
- **Source**: Microsoft Docs — "Loopback Recording"
  https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
- **Note**: Windows 11 / Windows 10 21H2+ (build 22000) is the minimum for process-loopback
  audio via `ActivateAudioInterfaceAsync` with `PROCESS_LOOPBACK`.

## Compile-Time Support Calculation

- Compiled against Windows SDK `10.0.22000.0`
- SDK version passed from CMake (`CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION`) as
  `SCREENLINK_WIN_SDK_VERSION` compile definition
- `processLoopbackHeadersAvailable = (sdkVersion.major >= 10 && sdkVersion.build >= 22000)`
- On this system: `true` (SDK 10.0.22000.0)

## Runtime Support Calculation

- `processLoopbackRuntimeSupported = (osBuild >= 22000)`
- On this system: `false` (build 19045)

## Overall Capability

`usable = compileTime.headersAvailable && runtime.is64BitProcess && runtime.osBuildEligible`

On this system: `false` (build 19045 < 22000)

### Reason Codes

| Code | Meaning |
|---|---|
| `ok` | Fully supported |
| `old-windows-sdk` | SDK < 10.0.22000.0 |
| `not-64-bit-process` | Helper running as 32-bit |
| `unsupported-windows-build` | OS build < 22000 |
| `windows-version-unknown` | Could not detect Windows version |
| `helper-not-found` | Helper binary missing |
| `helper-error` | Helper reported an error |
| `timeout` | Helper did not respond in 5s |
| `nonzero-exit` | Helper exited with error code |
| `empty-output` | Helper produced no stdout |
| `invalid-json` | Helper output not valid JSON |
| `invalid-capability` | Helper output missing required fields |
| `unsupported-protocol` | Protocol version mismatch |

## Windows Version Detection Method

The native helper uses `RtlGetVersion` by dynamically loading it from `ntdll.dll` via
`GetModuleHandleW` + `GetProcAddress`. This approach:

1. Does not require linking against `ntdll.lib` at build time
2. Returns the real OS build number unaffected by shims/manifests
3. Has been available on all NT-based Windows versions
4. Uses the `RTL_OSVERSIONINFOW` structure (not `OSVERSIONINFOEXW`)

## Electron Integration Path

1. Renderer calls `window.screenlink.getAudioCapabilities()`
2. Preload forwards to `ipcRenderer.invoke("get-audio-capabilities")`
3. Main process handler calls `getAudioCapabilities()` from AudioCapabilityService
4. Service spawns `screenlink-audio-helper.exe --capabilities`
5. Helper executes detection, writes JSON to stdout, exits 0
6. Service reads stdout, validates protocol version and required fields
7. Service returns `HelperResult<AudioCapabilityResult>` to renderer

## Timeout Behavior

- Helper call has a **5-second bounded timeout**
- On timeout: child process is killed via `TerminateProcess`, error returned
- No orphaned processes

## Failure-Handling Summary

| Scenario | Error Code | Behavior |
|---|---|---|
| Helper binary not found | `helper-not-found` | Returns error without spawning |
| Spawn fails (EACCES) | `spawn-error` | Returns error |
| Helper hangs | `timeout` | Kills process, returns error |
| Non-zero exit | `nonzero-exit` | Returns stderr content |
| Empty stdout | `empty-output` | Returns error |
| Malformed JSON | `invalid-json` | JSON parse error |
| Unsupported protocol | `unsupported-protocol` | Version mismatch error |
| Helper reports error | `helper-error` | Status field is "error" |
| Missing required fields | `invalid-capability` | Validation type guard fails |

## Remaining Phase 2A Limitations

- No audio capture exists yet (Phase 2B)
- No Discord exclusion exists yet (Phase 3C)
- No selected-application audio exists yet (Phase 2B)
- No PCM transport exists yet (Phase 2C)
- No mixing or resampling (Phase 3A)
- No AudioWorklet integration (Phase 3B)
- No UI audio mode is complete yet (Phase 4)

## Next Step (Phase 2B)

Process-loopback audio capture, named-pipe streaming, and window-to-process mapping.
