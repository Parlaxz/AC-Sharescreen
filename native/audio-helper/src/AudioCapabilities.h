#ifndef SCREENLINK_AUDIO_CAPABILITIES_H
#define SCREENLINK_AUDIO_CAPABILITIES_H

#include "WindowsVersion.h"
#include <cstdint>
#include <string>

#define WIN32_LEAN_AND_MEAN
#include <windows.h>  // HRESULT

namespace screenlink::audio {

struct CompileTimeSupport {
  bool headersAvailable = false;
  std::string windowsSdkVersion;
  bool processLoopbackDefined = false;
  bool activateAudioInterfaceDefined = false;
};

struct RuntimeSupport {
  bool osBuildEligible = false;
  bool osBuildExperimentalCandidate = false;
  uint32_t osBuildNumber = 0;
  bool is64BitProcess = false;
  bool is64BitOperatingSystem = false;
};

/// Result of a real runtime probe for process-loopback support.
/// The probe activates the VAD\Process_Loopback virtual device using
/// the same production path (WRL agile handler, WAVEFORMATEXTENSIBLE,
/// LOOPBACK|EVENTCALLBACK|AUTOCONVERTPCM flags) and reports each stage.
struct ProcessLoopbackProbeResult {
  bool probed = false;
  bool succeeded = false;
  std::string failureReason;

  // Exact stage where the probe failed (if !succeeded)
  std::string failureStage;
  // Per-stage HRESULTs from the probe
  std::string activateCallHrHex;
  std::string getActivateResultCallHrHex;
  std::string activationResultHrHex;
  std::string initializeHrHex;
  std::string getCaptureClientHrHex;
  std::string setEventHandleHrHex;
  std::string startHrHex;
  std::string stopHrHex;
};

struct AudioCapability {
  CompileTimeSupport compileTime;
  RuntimeSupport runtime;
  ProcessLoopbackProbeResult probeResult;
  bool usable = false;
  bool experimentalCandidate = false;
  bool endpointLoopbackSupported = false;
  std::string reasonCode;
  std::string reasonMessage;
};

CompileTimeSupport DetectCompileTimeSupport();

RuntimeSupport DetectRuntimeSupport(const WindowsVersionResult& osInfo);

/// Perform a real runtime probe for process-loopback support.
/// Uses the same production activation path (WRL agile handler,
/// official SDK types, WAVEFORMATEXTENSIBLE, event-driven).
/// Thread-safe: uses call_once for synchronized one-time execution.
/// Result is cached for the helper's lifetime.
ProcessLoopbackProbeResult ProbeProcessLoopbackRuntime();

/// Development-only uncached probe. Bypasses call_once.
/// Returns per-stage HRESULTs for diagnostics without restarting
/// the helper process. Result is NOT cached.
ProcessLoopbackProbeResult UncachedProbeProcessLoopback();

AudioCapability ComputeCapability(const CompileTimeSupport& ct,
                                   const RuntimeSupport& rt,
                                   const ProcessLoopbackProbeResult& probe);

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_CAPABILITIES_H
