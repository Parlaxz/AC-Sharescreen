#ifndef SCREENLINK_AUDIO_CAPABILITIES_H
#define SCREENLINK_AUDIO_CAPABILITIES_H

#include "WindowsVersion.h"
#include <cstdint>
#include <string>

namespace screenlink::audio {

struct CompileTimeSupport {
  bool headersAvailable = false;
  std::string windowsSdkVersion;
  bool processLoopbackDefined = false;
  bool activateAudioInterfaceDefined = false;
};

struct RuntimeSupport {
  bool osBuildEligible = false;
  uint32_t osBuildNumber = 0;
  bool is64BitProcess = false;
  bool is64BitOperatingSystem = false;
};

struct AudioCapability {
  CompileTimeSupport compileTime;
  RuntimeSupport runtime;
  bool usable = false;
  std::string reasonCode;
  std::string reasonMessage;
};

CompileTimeSupport DetectCompileTimeSupport();

RuntimeSupport DetectRuntimeSupport(const WindowsVersionResult& osInfo);

AudioCapability ComputeCapability(const CompileTimeSupport& ct,
                                   const RuntimeSupport& rt);

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_CAPABILITIES_H
