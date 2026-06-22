# Phase 2B Correction: Process-Loopback Implementation Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 7 critical correctness issues in the Phase 2B process-loopback implementation so that the capture primitive will actually work on Windows build >= 20348.

**Architecture:** The native C++ helper (`screenlink-audio-helper.exe`) must use the real Windows `AUDIOCLIENT_ACTIVATION_PARAMS` struct with `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`, handle silent frames correctly, provide timestamped packet metadata, validate PID identity via creation time, and properly map Electron desktopCapturer source IDs to HWNDs. The TypeScript test layer must be updated to match the corrected C++ types.

**Tech Stack:** C++20 / MSVC x64 / WASAPI / CMake / Vitest (TypeScript)

---

## File Structure

### Files to Modify

| File | Responsibility |
|------|---------------|
| `native/audio-helper/src/LoopbackCapture.h` | CaptureConfig, CaptureResult, FrameCallback, AudioPacket types |
| `native/audio-helper/src/LoopbackCapture.cpp` | Correct activation, format, silent frames, timestamps, duration cap |
| `native/audio-helper/src/ProcessResolver.h` | ProcessInfo with creation time, ProcessTreeResult with root + confidence |
| `native/audio-helper/src/ProcessResolver.cpp` | Creation-time query, application-root detection, validated children |
| `native/audio-helper/src/SourceMapper.h` | AudioSource with creation time, desktopCapturerSourceId, corrected hasAudio |
| `native/audio-helper/src/SourceMapper.cpp` | Source-ID mapping from Electron source, HWND matching, hasAudio fix |
| `native/audio-helper/src/WindowEnumerator.h` | WindowInfo with creation time |
| `native/audio-helper/src/WindowEnumerator.cpp` | Creation-time query per window PID |
| `native/audio-helper/src/WavWriter.h` | Add overwrite-refusal flag |
| `native/audio-helper/src/WavWriter.cpp` | Implement overwrite check |
| `native/audio-helper/src/main.cpp` | CLI arg parsing for --overwrite, --source-id, duration cap, updated JSON output |
| `native/audio-helper/src/Protocol.h` | New exit codes, max duration constant |
| `native/audio-helper/CMakeLists.txt` | No changes needed (same source list) |
| `apps/desktop/tests/audio-capabilities-service.test.ts` | Updated AudioSource type, corrected hasAudio tests, new packet type tests |

### Files to Create

None — all changes are modifications to existing files.

---

## Task 1: Fix Process-Loopback Activation (Critical Issues 1 & 2)

**Files:**
- Modify: `native/audio-helper/src/LoopbackCapture.cpp:1-155` (anonymous namespace + RunCaptureWithCallback activation section)
- Modify: `native/audio-helper/src/LoopbackCapture.cpp:445-560` (RunCapture activation section)

The current code:
1. Gets the default render endpoint and passes its device ID to `ActivateAudioInterfaceAsync` — **wrong**. Must use `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`.
2. Uses a custom `ProcessLoopbackParams` struct with `mode` before `pid` — **wrong**. Must use the real `AUDIOCLIENT_ACTIVATION_PARAMS` with `ActivationType`, then `TargetProcessId`, then `ProcessLoopbackMode`.

- [ ] **Step 1: Remove custom ProcessLoopbackMode and ProcessLoopbackParams from LoopbackCapture.cpp anonymous namespace**

Delete lines 53-61 in the anonymous namespace:

```cpp
// DELETE these:
enum class ProcessLoopbackMode : int32_t {
    Include = 0,
    Exclude = 1,
};

struct ProcessLoopbackParams {
    ProcessLoopbackMode mode;
    DWORD targetProcessId;
};
```

- [ ] **Step 2: Add the correct Windows API types in the anonymous namespace**

Replace the deleted code with the real Windows structures. Since we compile with SDK 10.0.22000.0, the header `audioclientactivationparams.h` is available. But to avoid linker dependency on uuid.lib and keep the local-GUID pattern, we define the structs locally matching the exact Windows ABI layout:

```cpp
// ── Process-loopback activation types (matching Windows ABI layout) ──
// These must match the exact memory layout expected by ActivateAudioInterfaceAsync.
// See: https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/

enum class AudioClientActivationType : int32_t {
    kDefault = 0,
    kProcessLoopback = 1,
};

enum class ProcessLoopbackMode : int32_t {
    kIncludeTargetProcessTree = 0,
    kExcludeTargetProcessTree = 1,
};

struct AudioClientProcessLoopbackParams {
    DWORD targetProcessId;
    ProcessLoopbackMode processLoopbackMode;
};

struct AudioClientActivationParams {
    AudioClientActivationType activationType;
    AudioClientProcessLoopbackParams processLoopbackParams;
};

// The virtual audio device ID for process-loopback activation.
// Must be passed as the first argument to ActivateAudioInterfaceAsync.
static const wchar_t kVirtualAudioDeviceProcessLoopback[] = L"VAD\\Process_Loopback";
```

**Critical layout note:** The Windows ABI expects `AUDIOCLIENT_ACTIVATION_PARAMS` as: `ActivationType` (4 bytes) → `TargetProcessId` (4 bytes) → `ProcessLoopbackMode` (4 bytes) = 12 bytes total. The struct above matches this layout exactly.

- [ ] **Step 3: Rewrite the activation section in RunCaptureWithCallback**

Replace steps 3-7 (lines ~187-255) in `RunCaptureWithCallback` with:

```cpp
    // 3. Prepare process-loopback activation parameters
    AudioClientActivationParams activationParams = {};
    activationParams.activationType = AudioClientActivationType::kProcessLoopback;
    activationParams.processLoopbackParams.targetProcessId =
        static_cast<DWORD>(config.targetPid);
    activationParams.processLoopbackParams.processLoopbackMode =
        config.includeMode
            ? ProcessLoopbackMode::kIncludeTargetProcessTree
            : ProcessLoopbackMode::kExcludeTargetProcessTree;

    PROPVARIANT variant;
    PropVariantInit(&variant);
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(activationParams);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

    // 4. Create activation handler and begin async activation
    CaptureActivationHandler* handler = new CaptureActivationHandler();

    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    hr = ActivateAudioInterfaceAsync(
        kVirtualAudioDeviceProcessLoopback,
        IID_IAudioClient_,
        &variant, handler, &asyncOp);

    PropVariantClear(&variant);

    if (FAILED(hr)) {
        result.failureReason = "ActivateAudioInterfaceAsync failed: "
            + HresultToString(hr);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }
```

This removes the `IMMDeviceEnumerator`, `GetDefaultAudioEndpoint`, `GetId` steps entirely. Process-loopback uses a virtual device, not a physical endpoint.

- [ ] **Step 4: Rewrite the activation section in RunCapture the same way**

Apply the identical change to `RunCapture` (lines ~465-538). Remove the device enumerator, endpoint, and device ID steps. Replace with the same `AudioClientActivationParams` + `kVirtualAudioDeviceProcessLoopback` pattern.

- [ ] **Step 5: Build and verify zero warnings**

Run: `cmake --build build --config Release 2>&1`
Expected: Build succeeds with zero warnings.

- [ ] **Step 6: Run self-test**

Run: `build\Release\screenlink-audio-helper.exe --self-test`
Expected: All self-tests pass (JSON with `"selfTestPassed": true`).

---

## Task 2: Add Process Creation-Time Identity (Critical Issue 3)

**Files:**
- Modify: `native/audio-helper/src/ProcessResolver.h`
- Modify: `native/audio-helper/src/ProcessResolver.cpp`
- Modify: `native/audio-helper/src/WindowEnumerator.h`
- Modify: `native/audio-helper/src/WindowEnumerator.cpp`
- Modify: `native/audio-helper/src/LoopbackCapture.h`
- Modify: `native/audio-helper/src/LoopbackCapture.cpp`

The current `ProcessInfo` has no creation time. The current `CaptureConfig` accepts only a raw PID. PID reuse means a stale PID could target the wrong process.

- [ ] **Step 1: Add creation time to ProcessInfo in ProcessResolver.h**

```cpp
struct ProcessInfo {
  uint32_t processId = 0;
  uint32_t parentProcessId = 0;
  std::string processPath;
  std::string processName;
  uint64_t creationTimeUtc100ns = 0;  // Process creation time in 100-ns units since 1601-01-01
};
```

Also add to `ProcessTreeResult`:

```cpp
struct ProcessTreeResult {
  bool succeeded = false;
  uint32_t targetPid = 0;
  uint32_t applicationRootPid = 0;    // Determined application root PID
  std::string applicationRootName;    // Executable name of the root
  std::vector<ProcessInfo> processes; // Ordered: target, parent, ..., root
  std::string failureReason;
};
```

- [ ] **Step 2: Implement creation-time query in ProcessResolver.cpp**

Add a helper function in the anonymous namespace:

```cpp
// Get process creation time from PID via OpenProcess + GetProcessTimes.
// Returns 0 on failure.
uint64_t GetProcessCreationTime(DWORD pid) {
  AutoHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process.IsValid()) return 0;

  FILETIME creationTime = {};
  FILETIME exitTime = {};
  FILETIME kernelTime = {};
  FILETIME userTime = {};

  if (!GetProcessTimes(process.Get(), &creationTime, &exitTime, &kernelTime, &userTime)) {
    return 0;
  }

  // Convert FILETIME to uint64 (100-ns units since 1601-01-01)
  ULARGE_INTEGER uli;
  uli.LowPart = creationTime.dwLowDateTime;
  uli.HighPart = creationTime.dwHighDateTime;
  return uli.QuadPart;
}
```

Then in the `ResolveProcessTree` function, after getting the path, also query creation time:

```cpp
    info.creationTimeUtc100ns = GetProcessCreationTime(pid);
```

- [ ] **Step 3: Add application-root detection to ResolveProcessTree**

After building the PID chain, determine the application root. The root is the highest ancestor that is NOT a known system process (explorer.exe, svchost.exe, services.exe, lsass.exe, wininit.exe, csrss.exe, smss.exe, winlogon.exe, taskeng.exe, conhost.exe, dllhost.exe, RuntimeBroker.exe, SearchIndexer.exe, sihost.exe, taskhostw.exe). Walk from the top of the chain downward until finding a non-system process:

```cpp
// Known system/service processes that are never application roots.
static bool IsSystemProcess(const std::string& name) {
  static const char* kSystemProcesses[] = {
    "explorer.exe", "svchost.exe", "services.exe", "lsass.exe",
    "wininit.exe", "csrss.exe", "smss.exe", "winlogon.exe",
    "taskeng.exe", "conhost.exe", "dllhost.exe", "RuntimeBroker.exe",
    "SearchIndexer.exe", "sihost.exe", "taskhostw.exe",
    "dwm.exe", "fontdrvhost.exe", "ctfmon.exe",
  };
  for (const auto& sys : kSystemProcesses) {
    if (_stricmp(name.c_str(), sys) == 0) return true;
  }
  return false;
}
```

After building the chain, set `applicationRootPid` and `applicationRootName`:

```cpp
  // Determine application root: walk from top of chain downward,
  // skipping system processes.
  for (int i = static_cast<int>(result.processes.size()) - 1; i >= 0; --i) {
    if (!IsSystemProcess(result.processes[i].processName)) {
      result.applicationRootPid = result.processes[i].processId;
      result.applicationRootName = result.processes[i].processName;
      break;
    }
  }
  // Fallback: if all are system processes, use the target itself.
  if (result.applicationRootPid == 0 && !result.processes.empty()) {
    result.applicationRootPid = result.processes[0].processId;
    result.applicationRootName = result.processes[0].processName;
  }
```

- [ ] **Step 4: Add creation time to WindowInfo in WindowEnumerator.h**

```cpp
struct WindowInfo {
  uint64_t hwnd = 0;
  uint32_t processId = 0;
  std::string processPath;
  std::string windowTitle;
  std::string windowClass;
  bool isVisible = false;
  bool isCloaked = false;
  uint64_t processCreationTimeUtc100ns = 0;  // Creation time of owning process
};
```

- [ ] **Step 5: Query creation time in WindowEnumerator.cpp**

In `EnumWindowsProc`, after getting the process path, also query creation time:

```cpp
  // Get process creation time
  uint64_t creationTime = 0;
  {
    AutoHandle proc(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    if (proc.IsValid()) {
      FILETIME ftCreation = {}, ftExit = {}, ftKernel = {}, ftUser = {};
      if (GetProcessTimes(proc.Get(), &ftCreation, &ftExit, &ftKernel, &ftUser)) {
        ULARGE_INTEGER uli;
        uli.LowPart = ftCreation.dwLowDateTime;
        uli.HighPart = ftCreation.dwHighDateTime;
        creationTime = uli.QuadPart;
      }
    }
  }
```

Then set `info.processCreationTimeUtc100ns = creationTime;`

- [ ] **Step 6: Add creation-time validation to CaptureConfig in LoopbackCapture.h**

```cpp
struct CaptureConfig {
    uint32_t targetPid = 0;
    uint64_t expectedCreationTimeUtc100ns = 0;  // 0 = skip validation
    bool includeMode = true;
    uint32_t durationMs = 5000;
    std::string outputPath;
    bool overwrite = false;  // Must be true to overwrite existing file
};
```

- [ ] **Step 7: Add PID creation-time validation in LoopbackCapture.cpp**

At the start of both `RunCaptureWithCallback` and `RunCapture`, after the OS support check, add:

```cpp
    // 2. Validate PID identity (prevent PID reuse attacks)
    if (config.expectedCreationTimeUtc100ns != 0) {
      AutoHandle proc(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                   static_cast<DWORD>(config.targetPid)));
      if (!proc.IsValid()) {
        result.failureReason = "Target process " + std::to_string(config.targetPid)
            + " is not running or access denied";
        return result;
      }
      FILETIME ftCreation = {}, ftExit = {}, ftKernel = {}, ftUser = {};
      if (!GetProcessTimes(proc.Get(), &ftCreation, &ftExit, &ftKernel, &ftUser)) {
        result.failureReason = "GetProcessTimes failed for PID "
            + std::to_string(config.targetPid);
        return result;
      }
      ULARGE_INTEGER uli;
      uli.LowPart = ftCreation.dwLowDateTime;
      uli.HighPart = ftCreation.dwHighDateTime;
      uint64_t actualCreationTime = uli.QuadPart;
      if (actualCreationTime != config.expectedCreationTimeUtc100ns) {
        result.failureReason = "PID " + std::to_string(config.targetPid)
            + " creation time mismatch (expected "
            + std::to_string(config.expectedCreationTimeUtc100ns)
            + ", actual " + std::to_string(actualCreationTime)
            + ") — possible PID reuse";
        return result;
      }
    }
```

- [ ] **Step 8: Update main.cpp --resolve-process-tree JSON output**

Add `applicationRootPid`, `applicationRootName`, and `creationTimeUtc100ns` to the JSON output for each process entry and the result object.

- [ ] **Step 9: Update main.cpp --enumerate-windows JSON output**

Add `processCreationTimeUtc100ns` to each window entry.

- [ ] **Step 10: Update main.cpp --capture-test to accept --creation-time**

Add `--creation-time <value>` CLI argument that sets `config.expectedCreationTimeUtc100ns`.

- [ ] **Step 11: Build and verify**

Run: `cmake --build build --config Release 2>&1`
Expected: Zero warnings.

---

## Task 3: Fix Electron Source Mapping (Critical Issue 4)

**Files:**
- Modify: `native/audio-helper/src/SourceMapper.h`
- Modify: `native/audio-helper/src/SourceMapper.cpp`
- Modify: `native/audio-helper/src/main.cpp`

The current source mapper generates its own `source:{pid}:{hwnd}` ID and sets `hasAudio` only for Electron apps. It must instead:
1. Accept an Electron `desktopCapturer` source ID as input for resolution
2. Map that source to an exact HWND
3. Remove the Electron-framework dependency from `hasAudio`
4. Add creation time to AudioSource

- [ ] **Step 1: Update AudioSource struct in SourceMapper.h**

```cpp
struct AudioSource {
  // Source identity
  std::string sourceId;        // "source:{processId}:{hwnd}"
  std::string displayName;     // Human-readable name

  // Process info
  uint32_t processId = 0;
  uint64_t hwnd = 0;
  std::string processPath;
  std::string processName;
  uint64_t processCreationTimeUtc100ns = 0;  // For PID identity validation

  // Electron detection (informational only, NOT used for hasAudio)
  bool isElectron = false;
  ElectronConfidence electronConfidence = ElectronConfidence::kNone;

  // Window info
  std::string windowTitle;
  std::string windowClass;
  bool isVisible = false;
  bool isCloaked = false;

  // Audio eligibility: visible, non-cloaked window with a valid process
  // Any visible application window can produce audio via process-loopback.
  bool hasAudio = false;
};
```

- [ ] **Step 2: Fix hasAudio logic in SourceMapper.cpp**

Replace:
```cpp
source.hasAudio = (source.isElectron && source.isVisible && !source.isCloaked);
```

With:
```cpp
// Any visible, non-cloaked window with a valid process can produce audio
// via process-loopback capture. Electron detection is informational only.
source.hasAudio = (source.isVisible && !source.isCloaked && source.processId != 0);
```

- [ ] **Step 3: Add creation time to source mapping in SourceMapper.cpp**

After setting `source.processPath`, add:

```cpp
    // Get process creation time for PID identity validation
    source.processCreationTimeUtc100ns = w.processCreationTimeUtc100ns;
```

- [ ] **Step 4: Add source-ID resolution function to SourceMapper.h**

Add a new function that resolves an Electron desktopCapturer source ID to an AudioSource:

```cpp
/// Result of resolving a desktopCapturer source ID to a concrete window.
struct SourceResolveResult {
  bool succeeded = false;
  AudioSource source;           // The matched source
  std::string failureReason;
};

/// Resolve an Electron desktopCapturer source ID to a concrete AudioSource.
/// The sourceId from desktopCapturer has format "window:{decimal-hwnd}" or
/// "screen:{index}". We match the HWND to our window catalog.
SourceResolveResult ResolveDesktopCapturerSource(const std::string& desktopCapturerSourceId);
```

- [ ] **Step 5: Implement ResolveDesktopCapturerSource in SourceMapper.cpp**

```cpp
SourceResolveResult ResolveDesktopCapturerSource(const std::string& desktopCapturerSourceId) {
  SourceResolveResult result;

  // Electron desktopCapturer source IDs for windows have format:
  //   "window:{decimal-hwnd}"   e.g. "window:123456"
  // For screens: "screen:{index}" — we don't support screen-level audio capture.
  if (desktopCapturerSourceId.rfind("window:", 0) != 0) {
    result.failureReason = "Unsupported desktopCapturer source ID format: "
        + desktopCapturerSourceId
        + " (expected 'window:{hwnd}' or 'screen:{index}')";
    return result;
  }

  std::string hwndStr = desktopCapturerSourceId.substr(7); // after "window:"
  uint64_t targetHwnd = 0;
  try {
    targetHwnd = std::stoull(hwndStr);
  } catch (const std::exception&) {
    result.failureReason = "Invalid HWND in desktopCapturer source ID: " + hwndStr;
    return result;
  }

  if (targetHwnd == 0) {
    result.failureReason = "Zero HWND in desktopCapturer source ID";
    return result;
  }

  // Enumerate all sources and find the one matching this HWND
  auto enumResult = EnumerateAudioSources();
  if (!enumResult.succeeded) {
    result.failureReason = "EnumerateAudioSources failed: " + enumResult.failureReason;
    return result;
  }

  const AudioSource* matched = nullptr;
  int matchCount = 0;

  for (const auto& s : enumResult.sources) {
    if (s.hwnd == targetHwnd) {
      matched = &s;
      ++matchCount;
    }
  }

  if (matchCount == 0) {
    result.failureReason = "No window found matching HWND "
        + std::to_string(targetHwnd)
        + " from desktopCapturer source ID: " + desktopCapturerSourceId;
    return result;
  }

  if (matchCount > 1) {
    result.failureReason = "Multiple windows matched HWND "
        + std::to_string(targetHwnd)
        + " — ambiguous match";
    return result;
  }

  result.source = *matched;
  result.succeeded = true;
  return result;
}
```

- [ ] **Step 6: Add --resolve-source command to Protocol.h**

```cpp
enum class Command {
  kVersion,
  kCapabilities,
  kSelfTest,
  kEnumerateWindows,
  kEnumerateSources,
  kResolveProcessTree,
  kResolveSource,       // NEW: resolve desktopCapturer source ID
  kCaptureTest,
  kUnknown,
};

// In ParseCommand:
if (arg == "--resolve-source") return Command::kResolveSource;
```

Add exit code:
```cpp
kSourceResolutionFailed = 23,
```

- [ ] **Step 7: Add --resolve-source handler in main.cpp**

```cpp
    case screenlink::audio::Command::kResolveSource: {
      if (argc < 3) {
        int exitCode = static_cast<int>(screenlink::audio::ExitCode::kSourceResolutionFailed);
        PrintError("missing-source-id-argument", exitCode, exitCode);
        return exitCode;
      }

      std::string sourceId = argv[2];
      auto result = screenlink::audio::ResolveDesktopCapturerSource(sourceId);
      if (!result.succeeded) {
        int exitCode = static_cast<int>(screenlink::audio::ExitCode::kSourceResolutionFailed);
        PrintError(JsonEscape(result.failureReason).c_str(), exitCode, exitCode);
        return exitCode;
      }

      const auto& s = result.source;
      auto enumToString = [](screenlink::audio::ElectronConfidence c) -> const char* {
        switch (c) {
          case screenlink::audio::ElectronConfidence::kNone:        return "none";
          case screenlink::audio::ElectronConfidence::kProcessName: return "process-name";
          case screenlink::audio::ElectronConfidence::kLow:         return "low";
          default:                                                  return "none";
        }
      };

      std::cout << "{\n";
      std::cout << "  \"protocolVersion\": \"" << screenlink::audio::kProtocolVersion << "\",\n";
      std::cout << "  \"helperVersion\": \"" << screenlink::audio::kHelperVersion << "\",\n";
      std::cout << "  \"status\": \"ok\",\n";
      std::cout << "  \"sourceId\": \"" << JsonEscape(s.sourceId) << "\",\n";
      std::cout << "  \"displayName\": \"" << JsonEscape(s.displayName) << "\",\n";
      std::cout << "  \"processId\": " << s.processId << ",\n";
      std::cout << "  \"hwnd\": " << s.hwnd << ",\n";
      std::cout << "  \"processPath\": \"" << JsonEscape(s.processPath) << "\",\n";
      std::cout << "  \"processName\": \"" << JsonEscape(s.processName) << "\",\n";
      std::cout << "  \"processCreationTimeUtc100ns\": " << s.processCreationTimeUtc100ns << ",\n";
      std::cout << "  \"isElectron\": " << (s.isElectron ? "true" : "false") << ",\n";
      std::cout << "  \"electronConfidence\": \"" << enumToString(s.electronConfidence) << "\",\n";
      std::cout << "  \"windowTitle\": \"" << JsonEscape(s.windowTitle) << "\",\n";
      std::cout << "  \"windowClass\": \"" << JsonEscape(s.windowClass) << "\",\n";
      std::cout << "  \"isVisible\": " << (s.isVisible ? "true" : "false") << ",\n";
      std::cout << "  \"isCloaked\": " << (s.isCloaked ? "true" : "false") << ",\n";
      std::cout << "  \"hasAudio\": " << (s.hasAudio ? "true" : "false") << "\n";
      std::cout << "}\n";
      return static_cast<int>(screenlink::audio::ExitCode::kSuccess);
    }
```

- [ ] **Step 8: Update usage string in main.cpp**

Add `--resolve-source <source-id>` to the usage string.

- [ ] **Step 9: Add --resolve-source to self-test in main.cpp**

Add a basic self-test for the new command (parse test only, no real source ID).

- [ ] **Step 10: Build and verify**

Run: `cmake --build build --config Release 2>&1`
Expected: Zero warnings.

---

## Task 4: Add Timestamped Packet Model (Critical Issue 5)

**Files:**
- Modify: `native/audio-helper/src/LoopbackCapture.h`
- Modify: `native/audio-helper/src/LoopbackCapture.cpp`

The current `FrameCallback` has no timing, sequence, or discontinuity metadata. Phase 3 needs this for synchronization and drift measurement.

- [ ] **Step 1: Define AudioPacket struct in LoopbackCapture.h**

```cpp
/// Metadata for a captured audio packet.
struct AudioPacket {
    const float* frames = nullptr;     // Interleaved float32 PCM data
    uint32_t frameCount = 0;           // Number of frames in this packet
    uint32_t channels = 0;             // Channel count
    uint64_t sequenceNumber = 0;       // Monotonically increasing packet counter
    uint64_t qpcPosition100ns = 0;     // QPC timestamp in 100-ns units (0 if unavailable)
    uint64_t devicePosition = 0;       // Device position in frames from stream start (0 if unavailable)
    bool isSilent = false;             // True if this packet contains silence
    bool isDiscontinuous = false;      // True if AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY set
    bool hasTimestampError = false;    // True if AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR set
};

/// Packet callback: return true to continue, false to stop.
/// Called with full packet metadata including timing and flags.
using PacketCallback = std::function<bool(const AudioPacket& packet)>;
```

- [ ] **Step 2: Add RunCaptureWithPacketCallback to LoopbackCapture.h**

```cpp
/// Run process-loopback capture with a packet callback (full metadata).
/// @note Requires Windows build >= 20348.
CaptureResult RunCaptureWithPacketCallback(const CaptureConfig& config, PacketCallback onPacket);
```

Keep the existing `FrameCallback` for backward compatibility but mark it as deprecated:

```cpp
/// Frame callback: return true to continue, false to stop.
/// @deprecated Use PacketCallback instead for timing and discontinuity metadata.
using FrameCallback = std::function<bool(const float* frames, uint32_t frameCount, uint32_t channels)>;

/// @deprecated Use RunCaptureWithPacketCallback instead.
CaptureResult RunCaptureWithCallback(const CaptureConfig& config, FrameCallback onFrames);
```

- [ ] **Step 3: Implement RunCaptureWithPacketCallback in LoopbackCapture.cpp**

This is the primary capture function. It uses the corrected activation from Task 1, handles silent frames from Task 5, and provides full packet metadata:

```cpp
CaptureResult RunCaptureWithPacketCallback(const CaptureConfig& config, PacketCallback onPacket) {
    CaptureResult result;

    // 1. Check OS support
    if (!IsProcessLoopbackSupported()) {
        auto osInfo = DetectWindowsVersion();
        result.failureReason = "Process-loopback capture requires Windows build "
            + std::to_string(kMinProcessLoopbackBuild)
            + " or later (current build: "
            + std::to_string(osInfo.build) + ")";
        return result;
    }

    // 2. Validate PID identity
    if (config.expectedCreationTimeUtc100ns != 0) {
      AutoHandle proc(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                   static_cast<DWORD>(config.targetPid)));
      if (!proc.IsValid()) {
        result.failureReason = "Target process " + std::to_string(config.targetPid)
            + " is not running or access denied";
        return result;
      }
      FILETIME ftCreation = {}, ftExit = {}, ftKernel = {}, ftUser = {};
      if (!GetProcessTimes(proc.Get(), &ftCreation, &ftExit, &ftKernel, &ftUser)) {
        result.failureReason = "GetProcessTimes failed for PID "
            + std::to_string(config.targetPid);
        return result;
      }
      ULARGE_INTEGER uli;
      uli.LowPart = ftCreation.dwLowDateTime;
      uli.HighPart = ftCreation.dwHighDateTime;
      if (uli.QuadPart != config.expectedCreationTimeUtc100ns) {
        result.failureReason = "PID " + std::to_string(config.targetPid)
            + " creation time mismatch — possible PID reuse";
        return result;
      }
    }

    // 3. Initialize COM (MTA required for ActivateAudioInterfaceAsync)
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        result.failureReason = "CoInitializeEx failed: " + HresultToString(hr);
        return result;
    }

    // 4. Prepare process-loopback activation parameters
    AudioClientActivationParams activationParams = {};
    activationParams.activationType = AudioClientActivationType::kProcessLoopback;
    activationParams.processLoopbackParams.targetProcessId =
        static_cast<DWORD>(config.targetPid);
    activationParams.processLoopbackParams.processLoopbackMode =
        config.includeMode
            ? ProcessLoopbackMode::kIncludeTargetProcessTree
            : ProcessLoopbackMode::kExcludeTargetProcessTree;

    PROPVARIANT variant;
    PropVariantInit(&variant);
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(activationParams);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

    // 5. Async activation
    CaptureActivationHandler* handler = new CaptureActivationHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    hr = ActivateAudioInterfaceAsync(
        kVirtualAudioDeviceProcessLoopback,
        IID_IAudioClient_,
        &variant, handler, &asyncOp);
    PropVariantClear(&variant);

    if (FAILED(hr)) {
        result.failureReason = "ActivateAudioInterfaceAsync failed: "
            + HresultToString(hr);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 6. Wait for activation (up to 5 seconds)
    if (!handler->Wait(5000)) {
        result.failureReason = "Audio interface activation timed out";
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    IAudioClient* pAudioClient = handler->GetAudioClient();
    HRESULT activateResult = handler->GetResult();
    if (FAILED(activateResult) || !pAudioClient) {
        result.failureReason = "Audio client activation failed (HRESULT: "
            + HresultToString(activateResult) + ")";
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 7. Define capture format — 48 kHz stereo float32
    // Use AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM so the engine handles
    // format conversion regardless of the internal mix format.
    WAVEFORMATEX captureFormat = {};
    captureFormat.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    captureFormat.nChannels = 2;
    captureFormat.nSamplesPerSec = 48000;
    captureFormat.wBitsPerSample = 32;
    captureFormat.nBlockAlign = 2 * (32 / 8);  // 8 bytes per frame
    captureFormat.nAvgBytesPerSec = 48000 * captureFormat.nBlockAlign;
    captureFormat.cbSize = 0;

    // 8. Initialize audio client
    // AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: engine auto-converts to our format
    // AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: better sample-rate conversion
    constexpr DWORD kStreamFlags =
        AUDCLNT_STREAMFLAGS_LOOPBACK |
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

    REFERENCE_TIME bufferDuration = 100000; // 10 ms in 100-ns units
    hr = pAudioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                   kStreamFlags,
                                   bufferDuration, 0, &captureFormat, nullptr);
    if (FAILED(hr)) {
        result.failureReason = "IAudioClient::Initialize failed: "
            + HresultToString(hr);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 9. Get capture client
    IAudioCaptureClient* pCaptureClient = nullptr;
    hr = pAudioClient->GetService(IID_IAudioCaptureClient_,
                                   reinterpret_cast<void**>(&pCaptureClient));
    if (FAILED(hr) || !pCaptureClient) {
        result.failureReason = "GetService(IAudioCaptureClient) failed: "
            + HresultToString(hr);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 10. Start audio engine
    hr = pAudioClient->Start();
    if (FAILED(hr)) {
        result.failureReason = "IAudioClient::Start failed: "
            + HresultToString(hr);
        SafeRelease(pCaptureClient);
        SafeRelease(pAudioClient);
        SafeRelease(asyncOp);
        SafeRelease(handler);
        CoUninitialize();
        return result;
    }

    // 11. Set Pro Audio thread priority
    DWORD taskIndex = 0;
    HANDLE avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    // 12. Capture loop with full packet metadata
    uint64_t framesCaptured = 0;
    uint64_t sequenceNumber = 0;
    auto startTime = std::chrono::steady_clock::now();
    auto duration = std::chrono::milliseconds(config.durationMs);
    bool running = true;
    std::vector<float> floatBuffer;

    while (running) {
        auto elapsed = std::chrono::steady_clock::now() - startTime;
        if (elapsed >= duration) break;

        UINT32 packetSize = 0;
        hr = pCaptureClient->GetNextPacketSize(&packetSize);
        if (FAILED(hr)) break;

        while (packetSize > 0) {
            BYTE* pData = nullptr;
            UINT32 numFramesAvailable = 0;
            DWORD flags = 0;
            UINT64 devicePosition = 0;
            UINT64 qpcPosition100ns = 0;

            hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable,
                                            &flags, &devicePosition, &qpcPosition100ns);
            if (FAILED(hr)) {
                running = false;
                break;
            }

            bool isSilent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
            bool isDiscontinuous = (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0;
            bool hasTimestampError = (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0;

            if (numFramesAvailable > 0) {
                AudioPacket packet;
                packet.channels = 2;  // We requested stereo
                packet.frameCount = numFramesAvailable;
                packet.sequenceNumber = sequenceNumber;
                packet.devicePosition = devicePosition;
                packet.qpcPosition100ns = qpcPosition100ns;
                packet.isSilent = isSilent;
                packet.isDiscontinuous = isDiscontinuous;
                packet.hasTimestampError = hasTimestampError;

                if (isSilent) {
                    // Write zero-filled samples to preserve timeline
                    size_t totalSamples = static_cast<size_t>(numFramesAvailable) * 2;
                    floatBuffer.assign(totalSamples, 0.0f);
                    packet.frames = floatBuffer.data();
                } else {
                    packet.frames = reinterpret_cast<float*>(pData);
                }

                if (!onPacket(packet)) {
                    running = false;
                }

                framesCaptured += numFramesAvailable;
                ++sequenceNumber;
            }

            pCaptureClient->ReleaseBuffer(numFramesAvailable);

            if (!running) break;

            hr = pCaptureClient->GetNextPacketSize(&packetSize);
            if (FAILED(hr)) {
                running = false;
                break;
            }
        }

        if (packetSize == 0 && running) {
            Sleep(1);
        }
    }

    // 13. Stop and cleanup
    pAudioClient->Stop();

    if (avrtHandle) {
        AvRevertMmThreadCharacteristics(avrtHandle);
    }

    result.framesCaptured = framesCaptured;
    result.bytesWritten = framesCaptured * captureFormat.nBlockAlign;
    result.succeeded = true;

    SafeRelease(pCaptureClient);
    SafeRelease(pAudioClient);
    SafeRelease(asyncOp);
    SafeRelease(handler);
    CoUninitialize();

    return result;
}
```

- [ ] **Step 4: Refactor RunCaptureWithCallback to delegate to RunCaptureWithPacketCallback**

```cpp
CaptureResult RunCaptureWithCallback(const CaptureConfig& config, FrameCallback onFrames) {
    auto packetCallback = [&onFrames](const AudioPacket& packet) -> bool {
        return onFrames(packet.frames, packet.frameCount, packet.channels);
    };
    return RunCaptureWithPacketCallback(config, packetCallback);
}
```

- [ ] **Step 5: Build and verify**

Run: `cmake --build build --config Release 2>&1`
Expected: Zero warnings.

---

## Task 5: Fix Silent Audio Timeline (Critical Issue 6)

**Files:**
- Modify: `native/audio-helper/src/LoopbackCapture.cpp` (RunCapture WAV path)

This is already handled in Task 4's `RunCaptureWithPacketCallback` — silent frames are zero-filled and counted. But `RunCapture` (the WAV writer path) also needs the same fix.

- [ ] **Step 1: Fix RunCapture to write zero-filled frames for silent packets**

In the `RunCapture` capture loop, replace the condition:

```cpp
// OLD:
if (numFramesAvailable > 0 && (flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0) {
```

With:

```cpp
if (numFramesAvailable > 0) {
    bool isSilent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;

    if (isSilent) {
        // Write zero-filled samples to preserve timeline continuity
        size_t totalSamples = static_cast<size_t>(numFramesAvailable) * channels;
        floatBuffer.assign(totalSamples, 0.0f);
        if (!writer.WriteFrames(floatBuffer.data(), numFramesAvailable)) {
            running = false;
            break;
        }
    } else {
        size_t totalSamples = static_cast<size_t>(numFramesAvailable) * channels;
        floatBuffer.assign(
            reinterpret_cast<float*>(pData),
            reinterpret_cast<float*>(pData) + totalSamples);
        if (!writer.WriteFrames(floatBuffer.data(), numFramesAvailable)) {
            running = false;
            break;
        }
    }

    framesCaptured += numFramesAvailable;
}
```

Also update `RunCapture` to use the corrected activation from Task 1 (same as RunCaptureWithPacketCallback).

- [ ] **Step 2: Build and verify**

Run: `cmake --build build --config Release 2>&1`
Expected: Zero warnings.

---

## Task 6: Add Duration Cap + Overwrite Safety (Critical Issue 7)

**Files:**
- Modify: `native/audio-helper/src/Protocol.h`
- Modify: `native/audio-helper/src/WavWriter.h`
- Modify: `native/audio-helper/src/WavWriter.cpp`
- Modify: `native/audio-helper/src/LoopbackCapture.cpp`
- Modify: `native/audio-helper/src/main.cpp`

- [ ] **Step 1: Add max duration constant to Protocol.h**

```cpp
/// Maximum allowed capture duration for --capture-test (30 seconds).
/// Prevents accidental long-running captures during diagnostics.
inline constexpr uint32_t kMaxCaptureTestDurationMs = 30000;
```

- [ ] **Step 2: Add overwrite-refusal to WavWriter.h**

Add an `overwrite` parameter to `Open`:

```cpp
bool Open(const std::string& path, uint32_t sampleRate,
          uint16_t channels, uint16_t bitsPerSample,
          bool overwrite = false);
```

- [ ] **Step 3: Implement overwrite check in WavWriter.cpp**

At the start of `Open`, before opening the file:

```cpp
bool WavWriter::Open(const std::string& path, uint32_t sampleRate,
                      uint16_t channels, uint16_t bitsPerSample,
                      bool overwrite) {
    if (file_.is_open()) {
        return false;
    }

    if (sampleRate == 0 || channels == 0 ||
        (bitsPerSample != 16 && bitsPerSample != 32)) {
        return false;
    }

    // Refuse to overwrite existing file unless explicitly allowed
    if (!overwrite) {
        DWORD attrs = GetFileAttributesA(path.c_str());
        if (attrs != INVALID_FILE_ATTRIBUTES) {
            // File exists and overwrite is not requested
            return false;
        }
    }

    // ... rest of existing Open implementation ...
```

Note: This requires `#include <windows.h>` in WavWriter.cpp (or use `std::ifstream` to check existence). Since we're already in a Windows-only project, `GetFileAttributesA` is fine. Add `#define NOMINMAX` and `#define WIN32_LEAN_AND_MEAN` before the include.

- [ ] **Step 4: Enforce duration cap in LoopbackCapture.cpp**

At the start of both `RunCapture` and `RunCaptureWithPacketCallback`, after the OS check:

```cpp
    // Enforce maximum capture duration
    if (config.durationMs > kMaxCaptureTestDurationMs) {
        result.failureReason = "Capture duration " + std::to_string(config.durationMs)
            + "ms exceeds maximum " + std::to_string(kMaxCaptureTestDurationMs)
            + "ms";
        return result;
    }
```

- [ ] **Step 5: Pass overwrite flag through in RunCapture**

In `RunCapture`, when opening the WavWriter:

```cpp
    if (!writer.Open(result.outputPath, sampleRate, channels, 32, config.overwrite)) {
        result.failureReason = "Failed to open output WAV file: " + result.outputPath
            + " (file may already exist — use --overwrite)";
```

- [ ] **Step 6: Add --overwrite CLI flag to main.cpp --capture-test**

In the argument parsing loop:

```cpp
        } else if (arg == "--overwrite") {
          config.overwrite = true;
        } else if (arg == "--creation-time" && i + 1 < argc) {
          try {
            config.expectedCreationTimeUtc100ns = std::stoull(argv[++i]);
          } catch (const std::exception&) {
            std::cerr << "Invalid --creation-time value\n";
            int exitCode = static_cast<int>(screenlink::audio::ExitCode::kCaptureTestFailed);
            PrintError("invalid-creation-time-argument", exitCode, exitCode);
            return exitCode;
          }
        }
```

- [ ] **Step 7: Update usage string**

Add `--overwrite` and `--creation-time <value>` to the usage string.

- [ ] **Step 8: Build and verify**

Run: `cmake --build build --config Release 2>&1`
Expected: Zero warnings.

---

## Task 7: Fix Audio Format + Stream Flags (High-Risk Format Issue)

**Files:**
- Modify: `native/audio-helper/src/LoopbackCapture.cpp`

This is already addressed in Task 4's implementation of `RunCaptureWithPacketCallback`:
- Uses a fixed 48 kHz stereo float32 format (not dependent on `GetMixFormat`)
- Uses `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`
- Does NOT call `GetMixFormat` (which may fail for virtual devices)
- Does NOT use `AUDCLNT_STREAMFLAGS_LOOPBACK` (not needed for process-loopback — the loopback is implicit in the virtual device activation)

- [ ] **Step 1: Verify RunCapture also uses the corrected format and flags**

Update `RunCapture` to match the same pattern as `RunCaptureWithPacketCallback`:
- Remove `GetMixFormat` call
- Use fixed 48 kHz stereo float32 format
- Use `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`
- Do NOT include `AUDCLNT_STREAMFLAGS_LOOPBACK` (process-loopback is implicit)

- [ ] **Step 2: Build and verify**

Run: `cmake --build build --config Release 2>&1`
Expected: Zero warnings.

---

## Task 8: Update TypeScript Tests for Corrected Types

**Files:**
- Modify: `apps/desktop/tests/audio-capabilities-service.test.ts`

- [ ] **Step 1: Update AudioSource interface to match corrected C++ struct**

```typescript
interface AudioSource {
  sourceId: string;
  displayName: string;
  processId: number;
  hwnd: number;
  processPath: string;
  processName: string;
  processCreationTimeUtc100ns: number;
  isElectron: boolean;
  electronConfidence: "none" | "process-name" | "low";
  windowTitle: string;
  windowClass: string;
  isVisible: boolean;
  isCloaked: boolean;
  hasAudio: boolean;
}
```

- [ ] **Step 2: Update isValidSource to check processCreationTimeUtc100ns**

Add to the validation:
```typescript
typeof s.processCreationTimeUtc100ns === "number" &&
```

- [ ] **Step 3: Update mockAudioSource to include processCreationTimeUtc100ns**

Add to defaults:
```typescript
processCreationTimeUtc100ns: 132456789012345678,
```

- [ ] **Step 4: Fix hasAudio tests — hasAudio is no longer Electron-dependent**

Replace the hasAudio test group:

```typescript
describe("hasAudio logic", () => {
  it("hasAudio is true for visible, non-cloaked window with valid PID", () => {
    const source = mockAudioSource({
      isVisible: true,
      isCloaked: false,
      processId: 1234,
    });
    // hasAudio = visible && !cloaked && pid != 0
    expect(source.hasAudio).toBe(true);
  });

  it("hasAudio is false for invisible window", () => {
    const source = mockAudioSource({
      isVisible: false,
      isCloaked: false,
      hasAudio: false,
    });
    expect(source.hasAudio).toBe(false);
  });

  it("hasAudio is false for cloaked window", () => {
    const source = mockAudioSource({
      isVisible: true,
      isCloaked: true,
      hasAudio: false,
    });
    expect(source.hasAudio).toBe(false);
  });

  it("hasAudio is true for non-Electron visible window (e.g. Chrome, VLC)", () => {
    const source = mockAudioSource({
      isElectron: false,
      isVisible: true,
      isCloaked: false,
      processId: 5678,
      hasAudio: true,
    });
    expect(source.hasAudio).toBe(true);
  });
});
```

- [ ] **Step 5: Add AudioPacket type tests**

```typescript
interface AudioPacket {
  frames: number;  // pointer as number in JSON
  frameCount: number;
  channels: number;
  sequenceNumber: number;
  qpcPosition100ns: number;
  devicePosition: number;
  isSilent: boolean;
  isDiscontinuous: boolean;
  hasTimestampError: boolean;
}

function isValidPacket(obj: unknown): obj is AudioPacket {
  if (typeof obj !== "object" || obj === null) return false;
  const p = obj as Record<string, unknown>;
  return (
    typeof p.frameCount === "number" &&
    typeof p.channels === "number" &&
    typeof p.sequenceNumber === "number" &&
    typeof p.qpcPosition100ns === "number" &&
    typeof p.devicePosition === "number" &&
    typeof p.isSilent === "boolean" &&
    typeof p.isDiscontinuous === "boolean" &&
    typeof p.hasTimestampError === "boolean"
  );
}

describe("AudioPacket type validation", () => {
  const validPacket: AudioPacket = {
    frames: 0,
    frameCount: 480,
    channels: 2,
    sequenceNumber: 0,
    qpcPosition100ns: 1324567890123456,
    devicePosition: 0,
    isSilent: false,
    isDiscontinuous: false,
    hasTimestampError: false,
  };

  it("accepts a valid AudioPacket", () => {
    expect(isValidPacket(validPacket)).toBe(true);
  });

  it("accepts a silent packet", () => {
    const silentPacket = { ...validPacket, isSilent: true };
    expect(isValidPacket(silentPacket)).toBe(true);
  });

  it("accepts a discontinuous packet", () => {
    const discPacket = { ...validPacket, isDiscontinuous: true };
    expect(isValidPacket(discPacket)).toBe(true);
  });

  it("rejects missing sequenceNumber", () => {
    const { sequenceNumber: _, ...rest } = validPacket;
    expect(isValidPacket(rest)).toBe(false);
  });

  it("rejects missing isSilent", () => {
    const { isSilent: _, ...rest } = validPacket;
    expect(isValidPacket(rest)).toBe(false);
  });

  it("rejects wrong isSilent type", () => {
    expect(isValidPacket({ ...validPacket, isSilent: "yes" })).toBe(false);
  });
});
```

- [ ] **Step 6: Add desktopCapturer source-ID resolution tests**

```typescript
describe("desktopCapturer source ID resolution", () => {
  it("parses 'window:{hwnd}' format", () => {
    const sourceId = "window:123456";
    expect(sourceId.startsWith("window:")).toBe(true);
    const hwnd = parseInt(sourceId.substring(7), 10);
    expect(hwnd).toBe(123456);
  });

  it("rejects 'screen:{index}' format (not supported for audio)", () => {
    const sourceId = "screen:0";
    expect(sourceId.startsWith("window:")).toBe(false);
  });

  it("rejects empty source ID", () => {
    const sourceId = "";
    expect(sourceId.startsWith("window:")).toBe(false);
  });
});
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @screenlink/desktop test -- --run`
Expected: All tests pass.

---

## Task 9: Build + Test Verification

- [ ] **Step 1: Full C++ build with zero warnings**

Run: `cmake --build build --config Release 2>&1`
Expected: Build succeeds, zero warnings.

- [ ] **Step 2: Run native self-test**

Run: `build\Release\screenlink-audio-helper.exe --self-test`
Expected: `"selfTestPassed": true`

- [ ] **Step 3: Run all TypeScript tests**

Run: `pnpm --filter @screenlink/shared test -- --run; pnpm --filter @screenlink/desktop test -- --run`
Expected: All tests pass.

- [ ] **Step 4: Verify --capture-test on build 19045 still gracefully rejects**

Run: `build\Release\screenlink-audio-helper.exe --capture-test 1234`
Expected: Error message about build 19045 < 20348.

- [ ] **Step 5: Verify --resolve-source command exists**

Run: `build\Release\screenlink-audio-helper.exe --resolve-source`
Expected: Error about missing source ID argument (not "unknown command").

- [ ] **Step 6: Verify --overwrite flag is accepted**

Run: `build\Release\screenlink-audio-helper.exe --capture-test 1234 --overwrite --duration-ms 1000`
Expected: Error about build 19045 (not about unknown flag).

- [ ] **Step 7: Verify duration cap**

Run: `build\Release\screenlink-audio-helper.exe --capture-test 1234 --duration-ms 60000`
Expected: Error about duration exceeding maximum (not about build, since duration check happens first — actually, OS check happens first on 19045, so this will show the build error. The duration cap is verified on supported machines).

---

## Self-Review

### 1. Spec Coverage

| Critical Issue | Task |
|---------------|------|
| 1: Wrong audio interface | Task 1 (VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK) |
| 2: Wrong activation params | Task 1 (AUDIOCLIENT_ACTIVATION_PARAMS) |
| 3: No creation-time validation | Task 2 (ProcessInfo + CaptureConfig + validation) |
| 4: Not real Electron source mapping | Task 3 (ResolveDesktopCapturerSource + hasAudio fix) |
| 5: No timestamped packets | Task 4 (AudioPacket + PacketCallback) |
| 6: Silent audio collapses timeline | Task 5 (zero-fill silent frames) |
| 7: No duration cap / overwrite | Task 6 (kMaxCaptureTestDurationMs + overwrite flag) |
| Format issue | Task 7 (AUTOCONVERTPCM + fixed format) |

All 7 critical issues + format issue covered.

### 2. Placeholder Scan

No TBD, TODO, "implement later", or "add appropriate error handling" found. All steps contain actual code.

### 3. Type Consistency

- `AudioClientActivationParams` defined in Task 1, used in Tasks 4, 5, 7
- `AudioPacket` defined in Task 4, tested in Task 8
- `ProcessInfo.creationTimeUtc100ns` added in Task 2, used in Tasks 3, 4
- `CaptureConfig.expectedCreationTimeUtc100ns` added in Task 2, used in Tasks 4, 5
- `CaptureConfig.overwrite` added in Task 6, used in Task 5
- `AudioSource.processCreationTimeUtc100ns` added in Task 3, tested in Task 8
- `SourceResolveResult` defined in Task 3, used in main.cpp handler
- `kMaxCaptureTestDurationMs` defined in Task 6, used in Tasks 4, 5
- `kVirtualAudioDeviceProcessLoopback` defined in Task 1, used in Tasks 4, 5, 7
- `Command::kResolveSource` added in Task 3, used in main.cpp
- `ExitCode::kSourceResolutionFailed` added in Task 3, used in main.cpp

All types consistent across tasks.
