#include "AudioCapabilities.h"
#include "ProcessLoopbackActivator.h"
#include "Protocol.h"
#include "WindowsVersion.h"
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <sstream>
#include <vector>
#include <mutex>
#include <atomic>

namespace screenlink::audio {

namespace {

// Minimum SDK build version that defines process-loopback APIs.
// This is the COMPILE-TIME SDK version check, separate from the
// runtime minimum (kMinProcessLoopbackBuild in Protocol.h, currently
// 20348). The SDK that introduced PROCESS_LOOPBACK is 10.0.22000.0,
// so this stays at 22000 regardless of runtime OS build.
inline constexpr uint32_t kMinSdkBuildForProcessLoopback = 22000;

std::vector<uint32_t> ParseVersionString(const std::string& version) {
  std::vector<uint32_t> parts;
  std::stringstream ss(version);
  std::string part;
  while (std::getline(ss, part, '.')) {
    try {
      parts.push_back(static_cast<uint32_t>(std::stoul(part)));
    } catch (...) {
      parts.push_back(0);
    }
  }
  return parts;
}


template <typename T>
void SafeRelease(T*& ptr) {
    if (ptr) {
        ptr->Release();
        ptr = nullptr;
    }
}


#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

} // anonymous namespace

CompileTimeSupport DetectCompileTimeSupport() {
  CompileTimeSupport result;

#ifdef SCREENLINK_WIN_SDK_VERSION
  result.windowsSdkVersion = SCREENLINK_WIN_SDK_VERSION;
  auto parts = ParseVersionString(SCREENLINK_WIN_SDK_VERSION);

  // Windows SDK 10.0.22000.0 is the minimum that defines the
  // process-loopback audio APIs (PROCESS_LOOPBACK constant,
  // ActivateAudioInterfaceAsync with process-loopback support).
  bool sdkHasProcessLoopback = false;
  if (parts.size() >= 3) {
    uint32_t sdkBuild = parts[2];
    sdkHasProcessLoopback = (parts[0] >= 10 && sdkBuild >= kMinSdkBuildForProcessLoopback);
  }

  result.headersAvailable = sdkHasProcessLoopback;
  result.processLoopbackDefined = sdkHasProcessLoopback;
  result.activateAudioInterfaceDefined = sdkHasProcessLoopback;
#else
  result.windowsSdkVersion = "unknown";
  result.headersAvailable = false;
  result.processLoopbackDefined = false;
  result.activateAudioInterfaceDefined = false;
#endif

  return result;
}

RuntimeSupport DetectRuntimeSupport(const WindowsVersionResult& osInfo) {
  RuntimeSupport result;

  if (osInfo.succeeded) {
    result.osBuildNumber = osInfo.build;
    result.osBuildEligible = osInfo.build >= kMinProcessLoopbackBuild;
    result.osBuildExperimentalCandidate =
        osInfo.build >= kExperimentalProcessLoopbackFloor
        && osInfo.build < kMinProcessLoopbackBuild;
  } else {
    result.osBuildNumber = 0;
    result.osBuildEligible = false;
    result.osBuildExperimentalCandidate = false;
  }

  // Check process architecture
  result.is64BitProcess = (sizeof(void*) == 8);

  // Check OS architecture
  BOOL isWow64 = FALSE;
  if (result.is64BitProcess) {
    // A 64-bit process can only run on 64-bit Windows
    result.is64BitOperatingSystem = true;
  } else if (IsWow64Process(GetCurrentProcess(), &isWow64) && isWow64) {
    result.is64BitOperatingSystem = true;
  } else {
    result.is64BitOperatingSystem = false;
  }

  return result;
}

// ── ProbeProcessLoopbackRuntime ──
//
// Performs a real runtime probe for process-loopback support.
// Activates the VAD\Process_Loopback virtual device targeting the
// helper's own PID, initializes IAudioClient, and attempts Start().
// The probe is bounded (5s activation timeout + 2s start timeout).
// Thread-safe: uses call_once for synchronized one-time execution.
// Result is cached for the helper's lifetime.

ProcessLoopbackProbeResult ProbeProcessLoopbackRuntime() {
  static ProcessLoopbackProbeResult cachedResult;
  static std::once_flag probeOnce;

  std::call_once(probeOnce, []() {
    ProcessLoopbackProbeResult result;

    auto osInfo = DetectWindowsVersion();
    if (!osInfo.succeeded) {
      result.probed = false;
      result.failureReason = "OS version detection failed";
      cachedResult = result;
      return;
    }

    if (osInfo.build >= kMinProcessLoopbackBuild) {
      result.probed = false;
      result.succeeded = true;
      cachedResult = result;
      return;
    }

    if (osInfo.build < kExperimentalProcessLoopbackFloor) {
      result.probed = false;
      result.succeeded = false;
      result.failureReason = "Build " + std::to_string(osInfo.build)
          + " is below experimental floor " + std::to_string(kExperimentalProcessLoopbackFloor);
      cachedResult = result;
      return;
    }

    // ── Experimental candidate build: perform real probe ──
    result.probed = true;

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
      result.failureReason = "CoInitializeEx failed: " + std::to_string(hr);
      result.lastHr = hr;
      cachedResult = result;
      return;
    }

    // Use shared activation path (this also verifies GetService works)
    auto ar = ActivateProcessLoopback(
        GetCurrentProcessId(),
        AcLoopbackMode::kIncludeTargetProcessTree,
        5000);

    if (!ar.succeeded) {
      result.failureReason = ar.failureReason;
      result.lastHr = E_FAIL;
      CoUninitialize();
      cachedResult = result;
      return;
    }

    IAudioClient* audioClient = ar.audioClient;
    IAudioCaptureClient* captureClient = ar.captureClient;

    // Start the audio engine
    hr = audioClient->Start();
    if (FAILED(hr)) {
      result.failureReason = "IAudioClient::Start failed: " + std::to_string(hr);
      result.lastHr = hr;
      SafeRelease(captureClient);
      SafeRelease(audioClient);
      CoUninitialize();
      cachedResult = result;
      return;
    }

    // Verify full pipeline: GetNextPacketSize on IAudioCaptureClient
    UINT32 packetSize = 0;
    hr = captureClient->GetNextPacketSize(&packetSize);
    if (FAILED(hr)) {
      result.failureReason = "IAudioCaptureClient::GetNextPacketSize failed: " + std::to_string(hr);
      result.lastHr = hr;
    }

    // Stop the engine
    audioClient->Stop();

    if (SUCCEEDED(hr)) {
      result.succeeded = true;
      result.lastHr = S_OK;
    }

    SafeRelease(captureClient);
    SafeRelease(audioClient);
    CoUninitialize();
    cachedResult = result;
  });

  return cachedResult;
}

AudioCapability ComputeCapability(const CompileTimeSupport& ct,
                                   const RuntimeSupport& rt,
                                   const ProcessLoopbackProbeResult& probe) {
  AudioCapability cap;
  cap.compileTime = ct;
  cap.runtime = rt;
  cap.probeResult = probe;

  // Endpoint loopback (AUDCLNT_STREAMFLAGS_LOOPBACK) is supported on
  // all Windows 10+ builds. It works on Windows Vista and later, but
  // our minimum target is Windows 10 so we always report true when
  // the OS detection succeeded.
  cap.endpointLoopbackSupported = rt.osBuildNumber > 0;

  if (!ct.headersAvailable) {
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "old-windows-sdk";
    cap.reasonMessage = "Windows SDK " + ct.windowsSdkVersion
      + " does not support process-loopback audio. "
      + "Install Windows SDK 10.0.22000.0 or later.";
  } else if (!rt.is64BitProcess) {
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "not-64-bit-process";
    cap.reasonMessage = "The audio helper must run as a 64-bit process.";
  } else if (rt.osBuildEligible) {
    // Documented-supported build (>= 20348)
    cap.usable = true;
    cap.experimentalCandidate = false;
    cap.reasonCode = "ok";
    cap.reasonMessage = "Process-loopback audio is supported (documented).";
  } else if (rt.osBuildExperimentalCandidate && probe.succeeded) {
    // Experimental candidate build (19041–20347) with successful runtime probe
    cap.usable = false;  // not documented-supported
    cap.experimentalCandidate = true;
    cap.reasonCode = "experimental-runtime-supported";
    cap.reasonMessage = "Process-loopback audio is experimentally supported on build "
        + std::to_string(rt.osBuildNumber)
        + " (runtime probe succeeded).";
  } else if (rt.osBuildExperimentalCandidate && probe.probed && !probe.succeeded) {
    // Experimental candidate build but probe failed
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "experimental-probe-failed";
    cap.reasonMessage = "Process-loopback runtime probe failed on build "
        + std::to_string(rt.osBuildNumber) + ": " + probe.failureReason;
  } else if (!rt.osBuildEligible && rt.osBuildNumber > 0) {
    // Build below experimental floor or probe not attempted
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "unsupported-windows-build";
    if (rt.osBuildExperimentalCandidate) {
      cap.reasonMessage = "Windows build " + std::to_string(rt.osBuildNumber)
        + " is between the experimental floor ("
        + std::to_string(kExperimentalProcessLoopbackFloor)
        + ") and the documented minimum ("
        + std::to_string(kMinProcessLoopbackBuild)
        + "), but the runtime probe was not attempted.";
    } else {
      cap.reasonMessage = "Windows build " + std::to_string(rt.osBuildNumber)
        + " is below the minimum required build "
        + std::to_string(kMinProcessLoopbackBuild)
        + " for process-loopback audio.";
    }
  } else if (!rt.osBuildEligible && rt.osBuildNumber == 0) {
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "windows-version-unknown";
    cap.reasonMessage = "Could not determine Windows build number.";
  } else {
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "unknown";
    cap.reasonMessage = "Process-loopback audio is not supported.";
  }

  return cap;
}

} // namespace screenlink::audio
