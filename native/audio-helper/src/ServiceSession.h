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
#include "FilteredMonitorController.h" // FilteredMonitorController, FilteredMonitorDiagnostics

namespace screenlink::audio {

/// Configuration for the service session (--serve mode).
struct ServiceConfig {
    std::string controlPipeName;
    std::string pcmPipeName;
    std::string sessionId;
    std::string authToken;
    uint32_t parentPid = 0;
};

/// Request context passed to all command handlers.
struct CommandContext {
    uint64_t requestId = 0;
    std::string sessionId;
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
    void HandleHello(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleGetVersion(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleGetCapabilities(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleGetState(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleStartSynthetic(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleStartProcessCapture(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleStopCapture(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleGetDiagnostics(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandlePing(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleShutdown(const CommandContext& ctx, const std::string& payload, std::string& response);

    // Source resolution (shared with CLI --resolve-source)
    void HandleResolveSource(const CommandContext& ctx, const std::string& payload, std::string& response);

    // Audio source handlers
    void HandleEnumerateAudioSessions(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleStartApplicationAudio(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleStartFilteredMonitorAudio(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleStartEndpointLoopback(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleGetMixerState(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleGetMixerDiagnostics(const CommandContext& ctx, const std::string& payload, std::string& response);
    void HandleGetEndpointDiagnostics(const CommandContext& ctx, const std::string& payload, std::string& response);

    /// Dispatch a parsed control request to the appropriate handler.
    /// Returns true if the command was recognised, false otherwise.
    bool DispatchCommand(const CommandContext& ctx,
                         const std::string& command,
                         const std::string& payload,
                         std::string& response);

    /// Validate auth token and sessionId from a request.
    bool ValidateRequest(const std::string& authToken, const std::string& sessionId);

    /// Stop all active audio capture resources.
    void StopAudioResources();

    /// Capture callback — converts AudioPacket to PcmPacket and enqueues.
    /// @param expectedGeneration The stream generation this source was started with.
    ///        Rejected if zero or != active generation.
    bool OnCapturePacket(uint32_t expectedGeneration, const AudioPacket& packet);

    /// Allocate a monotonically increasing stream generation that is never zero.
    /// Handles uint32 wrap by skipping zero.
    uint32_t AllocateNextGeneration();

    /// Invalidate the active stream generation (called at start of stop).
    /// Future packets with this generation will be rejected.
    /// Does not affect the next allocatable generation.
    void InvalidateGeneration();

    /// Build a JSON error response.
    std::string MakeErrorResponse(const CommandContext& ctx, const std::string& errorCode);

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

    // Generation management: separated allocator and active generation
    // nextGeneration_ is monotonically increasing, never returns 0, survives stops
    // activeGeneration_ is the generation the current capture accepts, 0 = none active
    std::atomic<uint32_t> nextGeneration_{1};  // starts at 1 so first alloc returns 1
    std::atomic<uint32_t> activeGeneration_{0}; // 0 = no active capture

    std::string activeSourceType_;  // "synthetic", "process", "application", "monitor", "endpoint-loopback", or ""
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
    std::atomic<uint64_t> onCaptureRejectedGeneration_{0};

    // Application Audio source diagnostics (energy, packet health)
    struct ApplicationAudioDiagnostics {
        std::atomic<uint64_t> packets{0};
        std::atomic<uint64_t> frames{0};
        std::atomic<uint64_t> silentFlagPackets{0};
        std::atomic<uint64_t> zeroDataPackets{0};
        std::atomic<uint64_t> nonZeroPackets{0};
        std::atomic<uint64_t> nonZeroSamples{0};
        std::atomic<float> peak{0.0f};
    };
    ApplicationAudioDiagnostics appAudioDiag_;

    // Phase 2F: Production diagnostics
    uint32_t helperStartCount_ = 0;
    uint64_t lastErrorTimestamp_ = 0; // 100ns QPC timestamp of last error
    std::chrono::steady_clock::time_point startTime_;

    // Parent process handle
    void* parentProcessHandle_ = nullptr;

    // Audio capture sources — each mode owns exactly one resource type
    std::unique_ptr<ApplicationCaptureSource> applicationSource_;     // Application Audio
    std::unique_ptr<FilteredMonitorController> filteredMonitor_;      // Filtered Monitor
    std::unique_ptr<EndpointLoopbackSource> endpointSource_;          // System Audio / Endpoint Loopback
    std::mutex audioLifecycleMutex_;                                  // Serializes start/stop transitions
};

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_SERVICE_SESSION_H
