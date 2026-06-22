#include "AudioCapabilities.h"
#include "Protocol.h"
#include <windows.h>
#include <sstream>
#include <vector>

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
  } else {
    result.osBuildNumber = 0;
    result.osBuildEligible = false;
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

AudioCapability ComputeCapability(const CompileTimeSupport& ct,
                                   const RuntimeSupport& rt) {
  AudioCapability cap;
  cap.compileTime = ct;
  cap.runtime = rt;

  if (!ct.headersAvailable) {
    cap.usable = false;
    cap.reasonCode = "old-windows-sdk";
    cap.reasonMessage = "Windows SDK " + ct.windowsSdkVersion
      + " does not support process-loopback audio. "
      + "Install Windows SDK 10.0.22000.0 or later.";
  } else if (!rt.is64BitProcess) {
    cap.usable = false;
    cap.reasonCode = "not-64-bit-process";
    cap.reasonMessage = "The audio helper must run as a 64-bit process.";
  } else if (!rt.osBuildEligible && rt.osBuildNumber > 0) {
    cap.usable = false;
    cap.reasonCode = "unsupported-windows-build";
    cap.reasonMessage = "Windows build " + std::to_string(rt.osBuildNumber)
      + " is below the minimum required build "
      + std::to_string(kMinProcessLoopbackBuild)
      + " for process-loopback audio.";
  } else if (!rt.osBuildEligible && rt.osBuildNumber == 0) {
    cap.usable = false;
    cap.reasonCode = "windows-version-unknown";
    cap.reasonMessage = "Could not determine Windows build number.";
  } else {
    cap.usable = true;
    cap.reasonCode = "ok";
    cap.reasonMessage = "Process-loopback audio is supported.";
  }

  return cap;
}

} // namespace screenlink::audio
