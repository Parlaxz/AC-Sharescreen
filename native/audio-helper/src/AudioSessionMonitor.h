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

    // Phase 2E expanded fields
    std::string sessionId;            // IAudioSessionControl2::GetSessionIdentifier
    std::string sessionInstanceId;    // GetSessionInstanceIdentifier
    uint32_t sessionState = 0;        // AudioSessionState
    uint32_t rootPid = 0;             // resolved application root PID
    uint64_t rootCreationTimeUtc100ns = 0;
    bool excluded = false;            // matched an exclusion rule
    std::string exclusionReason;      // "discord", "screenlink", etc.
    bool processAlive = false;        // process still alive at enumeration time
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
