#ifndef SCREENLINK_APPLICATION_CAPTURE_SOURCE_H
#define SCREENLINK_APPLICATION_CAPTURE_SOURCE_H

#include <atomic>
#include <cstdint>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>

#include "LoopbackCapture.h" // AudioPacket, PacketCallback

namespace screenlink::audio {

/// Result of the application capture startup handshake.
enum class AppCaptureStartResult {
    Success,                // WASAPI fully initialized and capturing
    AlreadyRunning,         // Start() called while already running
    ThreadCreationFailed,    // std::thread creation failed
    ActivationFailed,       // ActivateProcessLoopback failed
    CaptureInitFailed,      // RunCaptureWithPacketCallback failed early
    Cancelled,              // Stop() called during startup
};

/// Structured outcome of Start() — success/failure with reason.
struct AppCaptureStartOutcome {
    AppCaptureStartResult result = AppCaptureStartResult::Success;
    std::string failureReason;  // Human-readable detail for diagnostics
};

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
    /// Blocks until WASAPI initialization completes or fails (5s timeout).
    /// @param pid Target process ID
    /// @param creationTimeUtc100ns Validated creation time (0 = skip validation)
    /// @param onPacket Callback for captured AudioPackets
    /// @return Outcome with success/failure and reason
    AppCaptureStartOutcome Start(uint32_t pid, uint64_t creationTimeUtc100ns,
                                  std::function<bool(const AudioPacket&)> onPacket);

    /// Stop the capture and join the thread.
    /// Safe to call while capture thread is blocked on WASAPI.
    void Stop();

    bool IsRunning() const { return running_.load(); }
    uint32_t GetPid() const { return pid_; }

private:
    void CaptureThread(uint32_t pid, uint64_t creationTimeUtc100ns,
                       std::function<bool(const AudioPacket&)> onPacket);

    void SignalStartupComplete(AppCaptureStartResult result, std::string reason);

    uint32_t pid_ = 0;
    uint64_t creationTimeUtc100ns_ = 0;
    std::atomic<bool> running_{false};
    std::thread captureThread_;

    // Readiness handshake
    std::mutex startupMutex_;
    std::condition_variable startupCv_;
    AppCaptureStartOutcome startupOutcome_;
    bool startupComplete_ = false;
};

} // namespace screenlink::audio

#endif // SCREENLINK_APPLICATION_CAPTURE_SOURCE_H
