#ifndef SCREENLINK_APPLICATION_CAPTURE_SOURCE_H
#define SCREENLINK_APPLICATION_CAPTURE_SOURCE_H

#include <atomic>
#include <cstdint>
#include <functional>
#include <thread>

#include "LoopbackCapture.h" // AudioPacket, PacketCallback

namespace screenlink::audio {

/// Wraps one process-loopback capture instance running in its own thread.
/// Each ApplicationCaptureSource captures audio from one specific process
/// and forwards packets to a shared mixer via a callback.
///
/// Thread safety:
///   - Start/Stop: call from a single thread, not concurrently
///   - The onPacket callback is called from the capture thread
class ApplicationCaptureSource {
public:
    ApplicationCaptureSource();
    ~ApplicationCaptureSource();

    /// Start capturing audio from the specified process.
    /// @param pid Target process ID
    /// @param creationTimeUtc100ns Validated creation time (0 = skip validation)
    /// @param onPacket Callback for captured AudioPackets
    /// @return true if capture thread started successfully
    ///
    /// Note: Start() can fail (e.g., thread creation failure). The caller MUST
    /// check the return value. Full activation acknowledgment (e.g., waiting for
    /// the capture loop to begin processing) is not yet implemented; callers
    /// should treat a return of true as "thread started" but not necessarily
    /// "capture is actively producing packets."
    bool Start(uint32_t pid, uint64_t creationTimeUtc100ns,
               std::function<bool(const AudioPacket&)> onPacket);

    /// Stop the capture and join the thread.
    void Stop();

    bool IsRunning() const { return running_.load(); }
    uint32_t GetPid() const { return pid_; }

private:
    void CaptureThread(uint32_t pid, uint64_t creationTimeUtc100ns,
                       std::function<bool(const AudioPacket&)> onPacket);

    uint32_t pid_ = 0;
    uint64_t creationTimeUtc100ns_ = 0;
    std::atomic<bool> running_{false};
    std::thread captureThread_;
};

} // namespace screenlink::audio

#endif // SCREENLINK_APPLICATION_CAPTURE_SOURCE_H
