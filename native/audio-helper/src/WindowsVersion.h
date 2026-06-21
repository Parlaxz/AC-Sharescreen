#ifndef SCREENLINK_AUDIO_WINDOWS_VERSION_H
#define SCREENLINK_AUDIO_WINDOWS_VERSION_H

#include <cstdint>
#include <string>

namespace screenlink::audio {

struct WindowsVersionResult {
  uint32_t major = 0;
  uint32_t minor = 0;
  uint32_t build = 0;
  uint32_t revision = 0;
  bool succeeded = false;
  std::string detectionMethod;
  std::string failureReason;
};

WindowsVersionResult DetectWindowsVersion();

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_WINDOWS_VERSION_H
