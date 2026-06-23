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

} // anonymous namespace

CompileTimeSupport DetectCompileTimeSupport() {
  CompileTimeSupport result;

#ifdef SCREENLINK_WIN_SDK_VERSION
  result.windowsSdkVersion = SCREENLINK_WIN_SDK_VERSION;
  auto parts = ParseVersionString(SCREENLINK_WIN_SDK_VERSION);

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

  result.is64BitProcess = (sizeof(void*) == 8);

  BOOL isWow64 = FALSE;
  if (result.is64BitProcess) {
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
// Uses the same production activation path (ActivateProcessLoopback)
// with WRL agile handler, official SDK types, WAVEFORMATEXTENSIBLE,
// LOOPBACK|EVENTCALLBACK|AUTOCONVERTPCM flags, and event-driven capture.
//
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
      // Documented-supported build -- no probe needed
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

    // ── Experimental candidate build: perform real probe using production path ──
    result.probed = true;

    // Initialize COM for this probe thread (MTA required for process-loopback)
    HRESULT comHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(comHr)) {
      result.failureReason = "CoInitializeEx(MTA) failed: " + HresultHex(comHr);
      cachedResult = result;
      return;
    }

    {
      auto ar = ActivateProcessLoopback(
          GetCurrentProcessId(),
          AcLoopbackMode::kIncludeTargetProcessTree,
          5000);

      // Transfer all per-stage HRESULTs to the probe result
      result.activateCallHrHex = HresultHex(ar.activateCallHr);
      result.getActivateResultCallHrHex = HresultHex(ar.getActivateResultCallHr);
      result.activationResultHrHex = HresultHex(ar.activationResultHr);
      result.initializeHrHex = HresultHex(ar.initializeHr);
      result.getCaptureClientHrHex = HresultHex(ar.getCaptureClientHr);
      result.setEventHandleHrHex = HresultHex(ar.setEventHandleHr);
      result.startHrHex = HresultHex(ar.startHr);

      if (!ar.succeeded) {
        result.failureReason = ar.failureReason;
        result.failureStage = ActivationStageToString(ar.stage);
      } else {
        result.succeeded = true;
      }
      // ar destructor releases COM objects before CoUninitialize
    }

    CoUninitialize();
    cachedResult = result;
  });

  return cachedResult;
}

// ── UncachedProbeProcessLoopback ──
//
// Development-only direct probe that bypasses call_once caching.
// Uses the exact same production activation path.
// Result is NOT cached. Safe to call repeatedly.

ProcessLoopbackProbeResult UncachedProbeProcessLoopback() {
  ProcessLoopbackProbeResult result;
  result.probed = true;

  auto osInfo = DetectWindowsVersion();
  if (!osInfo.succeeded) {
    result.failureReason = "OS version detection failed";
    return result;
  }

  HRESULT comHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comHr)) {
    result.failureReason = "CoInitializeEx(MTA) failed: " + HresultHex(comHr);
    return result;
  }

  {
    auto ar = ActivateProcessLoopback(
        GetCurrentProcessId(),
        AcLoopbackMode::kIncludeTargetProcessTree,
        5000);

    result.activateCallHrHex = HresultHex(ar.activateCallHr);
    result.getActivateResultCallHrHex = HresultHex(ar.getActivateResultCallHr);
    result.activationResultHrHex = HresultHex(ar.activationResultHr);
    result.initializeHrHex = HresultHex(ar.initializeHr);
    result.getCaptureClientHrHex = HresultHex(ar.getCaptureClientHr);
    result.setEventHandleHrHex = HresultHex(ar.setEventHandleHr);
    result.startHrHex = HresultHex(ar.startHr);

    if (!ar.succeeded) {
      result.failureReason = ar.failureReason;
      result.failureStage = ActivationStageToString(ar.stage);
    } else {
      result.succeeded = true;
    }
  }

  CoUninitialize();
  return result;
}

AudioCapability ComputeCapability(const CompileTimeSupport& ct,
                                   const RuntimeSupport& rt,
                                   const ProcessLoopbackProbeResult& probe) {
  AudioCapability cap;
  cap.compileTime = ct;
  cap.runtime = rt;
  cap.probeResult = probe;

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
    cap.usable = true;
    cap.experimentalCandidate = false;
    cap.reasonCode = "ok";
    cap.reasonMessage = "Process-loopback audio is supported (documented).";
  } else if (rt.osBuildExperimentalCandidate && probe.succeeded) {
    cap.usable = false;
    cap.experimentalCandidate = true;
    cap.reasonCode = "experimental-runtime-supported";
    cap.reasonMessage = "Process-loopback audio is experimentally supported on build "
        + std::to_string(rt.osBuildNumber)
        + " (runtime probe succeeded).";
  } else if (rt.osBuildExperimentalCandidate && probe.probed && !probe.succeeded) {
    cap.usable = false;
    cap.experimentalCandidate = false;
    cap.reasonCode = "experimental-probe-failed";
    cap.reasonMessage = "Process-loopback runtime probe failed on build "
        + std::to_string(rt.osBuildNumber) + ": " + probe.failureReason;
  } else if (!rt.osBuildEligible && rt.osBuildNumber > 0) {
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
