#ifndef SCREENLINK_AUDIO_SESSION_MONITOR_H
#define SCREENLINK_AUDIO_SESSION_MONITOR_H

#include <cstdint>
#include <string>
#include <vector>

namespace screenlink::audio {

/// Information about a single audio render session.
struct AudioSessionInfo {
    uint32_t pid = 0;
    uint64_t creationTimeUtc100ns = 0;
    std::string executablePath;
    std::string executableName;
    bool systemSound = false;         // PID 0 or system
    bool identityValidated = false;   // creation time successfully queried
    std::string errorReason;
};

/// Enumerates Windows render audio sessions using Core Audio APIs.
///
/// Thread safety: NOT thread-safe. All calls should be made from the same
/// thread that called Initialize().
class AudioSessionMonitor {
public:
    AudioSessionMonitor();
    ~AudioSessionMonitor();

    // Initialize COM and enumerate sessions. Returns false on failure.
    bool Initialize();

    // Enumerate all current render audio sessions.
    std::vector<AudioSessionInfo> EnumerateSessions();

    // Stop and release COM resources.
    void Stop();

private:
    bool comInitialized_ = false;
    void* deviceEnumerator_ = nullptr;    // IMMDeviceEnumerator*
    void* audioSessionManager_ = nullptr; // IAudioSessionManager2*
};

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_SESSION_MONITOR_H
