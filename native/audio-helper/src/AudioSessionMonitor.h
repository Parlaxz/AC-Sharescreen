#ifndef SCREENLINK_AUDIO_SESSION_MONITOR_H
#define SCREENLINK_AUDIO_SESSION_MONITOR_H

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

struct IMMDeviceEnumerator;
struct IAudioSessionManager2;
struct IAudioSessionNotification;
struct IMMNotificationClient;

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

/// Apply the result of a process-creation-time lookup to AudioSessionInfo.
/// When creationTimeUtc100ns is nonzero, the process is alive and identity is
/// validated. When zero, all identity/liveness fields are cleared to false/0.
/// This is the single authoritative state transition for process identity.
void ApplyProcessIdentityResult(
    AudioSessionInfo& info,
    uint64_t creationTimeUtc100ns) noexcept;

/// Check whether AudioSessionInfo has a consistent identity/liveness state.
/// Returns true if identity is not validated, or if all of processAlive,
/// identityValidated, and a nonzero creationTimeUtc100ns agree.
bool HasConsistentProcessIdentity(
    const AudioSessionInfo& info) noexcept;

/// Enumerates Windows render audio sessions using Core Audio APIs.
///
/// Supports live session-change and default-device-change notifications
/// via an optional callback passed to Initialize(). When a new session is
/// created or the default render endpoint changes, the callback is invoked
/// (no heavy work should be done inside it).
///
/// Thread safety: NOT thread-safe. All calls should be made from the same
/// thread that called Initialize().
class AudioSessionMonitor {
public:
    /// Callback invoked when a new session is created or default device changes.
    using AudioSessionChangedCallback = std::function<void()>;

    AudioSessionMonitor();
    ~AudioSessionMonitor();

    /// Initialize COM, register for session/device notifications, and prepare
    /// for enumeration. Optionally accepts a callback for live notifications.
    bool Initialize(AudioSessionChangedCallback onChanged = {});

    /// Get the last error code (HRESULT) from initialization, 0 if succeeded.
    long LastErrorCode() const { return lastErrorCode_; }

    /// Enumerate all current render audio sessions.
    std::vector<AudioSessionInfo> EnumerateSessions();

    /// Stop and release COM resources. Unregisters notification sinks before
    /// releasing their respective parent COM objects.
    void Stop();

    /// Returns true if a default-device-change was detected since last cleared.
    bool ReinitializeRequested() const { return reinitializeRequested_; }

    /// Clear the reinitialize-requested flag.
    void ClearReinitializeRequested() { reinitializeRequested_ = false; }

private:
    bool comInitialized_ = false;
    IMMDeviceEnumerator* deviceEnumerator_ = nullptr;
    IAudioSessionManager2* audioSessionManager_ = nullptr;
    long lastErrorCode_ = 0;              // HRESULT from last failed Initialize() step

    // COM notification sink pointers (created in Initialize, released in Stop)
    IAudioSessionNotification* sessionNotificationSink_ = nullptr;
    IMMNotificationClient* deviceNotificationSink_ = nullptr;

    // Live notification callback (invoked from COM notification threads)
    AudioSessionChangedCallback onChangeCallback_;

    // Set by OnDefaultDeviceChanged to request a full re-enumeration
    std::atomic<bool> reinitializeRequested_{false};
};

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_SESSION_MONITOR_H
