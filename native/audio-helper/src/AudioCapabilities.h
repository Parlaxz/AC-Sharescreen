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
  bool osBuildEligible = false;           // build >= kMinProcessLoopbackBuild (documented support)
  bool osBuildExperimentalCandidate = false; // build >= kExperimentalProcessLoopbackFloor && < kMinProcessLoopbackBuild
  uint32_t osBuildNumber = 0;
  bool is64BitProcess = false;
  bool is64BitOperatingSystem = false;
};

/// Result of a real runtime probe for process-loopback support.
/// The probe activates the VAD\Process_Loopback virtual device and
/// attempts IAudioClient::Start to confirm the API actually works.
struct ProcessLoopbackProbeResult {
  bool probed = false;           // true if probe was actually attempted
  bool succeeded = false;       // true if probe passed through IAudioClient::Start
  std::string failureReason;    // human-readable failure if !succeeded
  HRESULT lastHr = S_OK;        // last HRESULT from the probe chain
};

struct AudioCapability {
  CompileTimeSupport compileTime;
  RuntimeSupport runtime;
  ProcessLoopbackProbeResult probeResult;
  bool usable = false;                        // documented-supported (build >= 20348)
  bool experimentalCandidate = false;          // build in [19041, 20347] and probe passed
  bool endpointLoopbackSupported = false;
  std::string reasonCode;
  std::string reasonMessage;
};

CompileTimeSupport DetectCompileTimeSupport();

RuntimeSupport DetectRuntimeSupport(const WindowsVersionResult& osInfo);

/// Perform a real runtime probe for process-loopback support.
/// Activates the VAD\Process_Loopback virtual device targeting the
/// helper's own PID, initializes IAudioClient, and attempts Start().
/// The probe is bounded (5s activation timeout + 2s start timeout).
/// Thread-safe: uses call_once for synchronized one-time execution.
/// Result is cached for the helper's lifetime.
ProcessLoopbackProbeResult ProbeProcessLoopbackRuntime();

AudioCapability ComputeCapability(const CompileTimeSupport& ct,
                                   const RuntimeSupport& rt,
                                   const ProcessLoopbackProbeResult& probe);

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_CAPABILITIES_H
