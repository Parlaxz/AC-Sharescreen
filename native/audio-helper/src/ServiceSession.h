#ifndef SCREENLINK_AUDIO_SERVICE_SESSION_H
#define SCREENLINK_AUDIO_SERVICE_SESSION_H

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

#include "LoopbackCapture.h"   // AudioPacket, CaptureConfig
#include "PipeTransport.h"     // PcmPipeWriter
#include "SyntheticSource.h"   // SyntheticConfig

namespace screenlink::audio {

/// Configuration for the service session (--serve mode).
struct ServiceConfig {
    std::string controlPipeName;
    std::string pcmPipeName;
    std::string sessionId;
    std::string authToken;
    uint32_t parentPid = 0;
};

/// Persistent service daemon that creates two named pipes (control + PCM),
/// accepts connections from Electron, processes JSON control commands,
/// and streams PCM audio packets.
class ServiceSession {
public:
    explicit ServiceSession(ServiceConfig config);
    ~ServiceSession();

    /// Run the service. Blocks until shutdown.
    int Run();

private:
    // Thread entry points
    void ControlThread();
    void PcmConnectThread();
    void ParentMonitorThread();

    // Capture runner threads
    void RunSyntheticCapture(SyntheticConfig cfg);
    void RunProcessCapture(CaptureConfig cfg);

    // Control command handlers
    void HandleHello(const std::string& payload, std::string& response);
    void HandleGetVersion(const std::string& payload, std::string& response);
    void HandleGetCapabilities(const std::string& payload, std::string& response);
    void HandleGetState(const std::string& payload, std::string& response);
    void HandleStartSynthetic(const std::string& payload, std::string& response);
    void HandleStartProcessCapture(const std::string& payload, std::string& response);
    void HandleStopCapture(const std::string& payload, std::string& response);
    void HandleGetDiagnostics(const std::string& payload, std::string& response);
    void HandlePing(const std::string& payload, std::string& response);
    void HandleShutdown(const std::string& payload, std::string& response);

    /// Dispatch a parsed control request to the appropriate handler.
    /// Returns true if the command was recognised, false otherwise.
    bool DispatchCommand(const std::string& command,
                         const std::string& payload,
                         std::string& response);

    /// Validate auth token and sessionId from a request.
    bool ValidateRequest(const std::string& authToken, const std::string& sessionId);

    /// Capture callback — converts AudioPacket to PcmPacket and enqueues.
    bool OnCapturePacket(const AudioPacket& packet);

    /// Build a JSON error response.
    std::string MakeErrorResponse(const std::string& errorCode);

    /// Session state string conversion.
    static const char* StateToString();

    /// Current session state.
    enum class SessionState {
        kIdle,
        kStarting,
        kCapturing,
        kStopping,
        kError
    };

    ServiceConfig config_;

    // Control
    std::atomic<bool> running_{true};
    void* controlPipe_ = nullptr;

    // Threads
    std::thread controlThread_;
    std::thread pcmConnectThread_;
    std::thread monitorThread_;
    std::thread captureThread_;

    // State
    std::atomic<SessionState> state_{SessionState::kIdle};
    std::atomic<uint32_t> streamGeneration_{0};
    std::string activeSourceType_;  // "synthetic", "process", or ""
    std::mutex stateMutex_;         // protects activeSourceType_

    // PCM writer (handles its own pipe creation and write thread)
    PcmPipeWriter pcmWriter_;

    // Diagnostics
    std::atomic<uint64_t> totalPackets_{0};
    std::atomic<uint64_t> totalPayloadBytes_{0};
    std::atomic<uint64_t> totalControlRequests_{0};
    std::atomic<uint64_t> failedControlRequests_{0};
    std::chrono::steady_clock::time_point startTime_;

    // Parent process handle
    void* parentProcessHandle_ = nullptr;
};

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_SERVICE_SESSION_H
