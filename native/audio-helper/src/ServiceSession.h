#ifndef SCREENLINK_AUDIO_SERVICE_SESSION_H
#define SCREENLINK_AUDIO_SERVICE_SESSION_H

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

#include <vector>

#include "LoopbackCapture.h"       // AudioPacket, CaptureConfig
#include "PipeTransport.h"         // PcmPipeWriter
#include "SyntheticSource.h"       // SyntheticConfig
#include "AudioSessionMonitor.h"   // AudioSessionMonitor, AudioSessionInfo
#include "MultiSourceMixer.h"      // MultiSourceMixer, MixerDiagnostics
#include "ApplicationCaptureSource.h" // ApplicationCaptureSource
#include "EndpointLoopbackSource.h"   // EndpointLoopbackSource

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

    // Phase 2E: Multi-source audio mixer handlers
    void HandleEnumerateAudioSessions(const std::string& payload, std::string& response);
    void HandleStartApplicationAudio(const std::string& payload, std::string& response);
    void HandleStartFilteredMonitorAudio(const std::string& payload, std::string& response);
    void HandleStartEndpointLoopback(const std::string& payload, std::string& response);
    void HandleGetMixerState(const std::string& payload, std::string& response);
    void HandleGetMixerDiagnostics(const std::string& payload, std::string& response);

    /// Dispatch a parsed control request to the appropriate handler.
    /// Returns true if the command was recognised, false otherwise.
    bool DispatchCommand(const std::string& command,
                         const std::string& payload,
                         std::string& response);

    /// Validate auth token and sessionId from a request.
    bool ValidateRequest(const std::string& authToken, const std::string& sessionId);

    /// Stop all Phase 2E multi-source mixer resources.
    void StopPhase2EResources();

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
        kError   // Permanent unrecoverable error state
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
    // Pipeline counters
    std::atomic<uint64_t> capturePacketsProduced_{0};
    std::atomic<uint64_t> captureBytesProduced_{0};
    std::atomic<uint64_t> sourcePacketsEnqueued_{0};

    // Phase 3: Endpoint loopback counters
    std::atomic<uint64_t> endpointPacketsCaptured_{0};
    std::atomic<uint64_t> endpointNonZeroPackets_{0};
    std::atomic<uint64_t> endpointSilentPackets_{0};
    std::atomic<uint64_t> mixerFeedPackets_{0};
    std::atomic<uint64_t> mixerOutputPackets_{0};
    std::atomic<uint64_t> mixerNonZeroOutputPackets_{0};
    std::atomic<uint64_t> onCaptureAccepted_{0};
    std::atomic<uint64_t> onCaptureRejectedState_{0};

    // Phase 2F: Production diagnostics
    uint32_t helperStartCount_ = 0;
    uint64_t lastErrorTimestamp_ = 0; // 100ns QPC timestamp of last error
    std::chrono::steady_clock::time_point startTime_;

    // Parent process handle
    void* parentProcessHandle_ = nullptr;

    // Phase 2E: Multi-source audio mixer
    std::unique_ptr<AudioSessionMonitor> sessionMonitor_;
    std::unique_ptr<MultiSourceMixer> mixer_;
    std::vector<std::unique_ptr<ApplicationCaptureSource>> captureSources_;
    std::unique_ptr<EndpointLoopbackSource> endpointSource_;
};

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_SERVICE_SESSION_H
