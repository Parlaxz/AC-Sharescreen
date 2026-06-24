#ifndef SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H
#define SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>

#include <atomic>
#include <cstdint>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "LoopbackCapture.h" // AudioPacket, PacketCallback

namespace screenlink::audio {

// Forward declaration for internal use
class LinearResampler;

/// Result of the endpoint startup handshake.
enum class EndpointStartResult {
    Success,                // WASAPI fully initialized and capturing
    ComInitFailed,          // CoInitializeEx failed
    EnumeratorFailed,       // MMDeviceEnumerator creation failed
    EndpointNotFound,       // No default render endpoint
    AudioClientActivationFailed, // IAudioClient::Activate failed
    GetMixFormatFailed,     // GetMixFormat failed
    InitializeFailed,       // IAudioClient::Initialize failed
    CaptureClientFailed,    // GetService(IAudioCaptureClient) failed
    AudioEngineStartFailed, // IAudioClient::Start failed
    Cancelled,              // Stop() called during startup
};

/// Structured outcome of Start() — success/failure with HRESULT for diagnostics.
struct EndpointStartOutcome {
    EndpointStartResult result = EndpointStartResult::Success;
    HRESULT hr = S_OK;  // relevant HRESULT for diagnostics
};

/// Diagnostics snapshot for the endpoint loopback source.
struct EndpointLoopbackDiagnostics {
    bool running = false;
    bool endpointActive = false;
    uint64_t packetsCaptured = 0;
    uint64_t nonZeroPackets = 0;
    uint64_t silentPackets = 0;
    uint64_t deviceInvalidations = 0;
    uint64_t resourcesInvalidated = 0;
    uint64_t serviceNotRunning = 0;
    uint64_t deviceRestarts = 0;
    uint64_t initializationFailures = 0;
    long lastHresult = S_OK;
    std::string lastError;
};

/// Captures audio from the default render endpoint using WASAPI endpoint
/// loopback (AUDCLNT_STREAMFLAGS_LOOPBACK). Runs in its own thread and
/// produces AudioPackets at 48 kHz stereo float32.
///
/// Unlike ApplicationCaptureSource (which captures a single process via the
/// process-loopback virtual device), EndpointLoopbackSource captures the
/// entire system audio output and feeds it into the mixer as one source.
///
/// Thread safety:
///   - Start/Stop: call from a single thread, not concurrently
///   - The onPacket callback is called from the capture thread
///   - Stop() is safe to call while the capture thread is blocked on WASAPI
///   - GetDiagnostics: thread-safe (can be called from any thread)
class EndpointLoopbackSource {
public:
    EndpointLoopbackSource();
    ~EndpointLoopbackSource();

    /// Start capturing from the default render endpoint.
    /// Blocks until WASAPI initialization completes or fails (5s timeout).
    /// @param onPacket          Callback for captured AudioPackets
    /// @return Outcome with success/failure and HRESULT
    EndpointStartOutcome Start(std::function<bool(const AudioPacket&)> onPacket);

    /// Stop the capture and join the thread.
    /// Safe to call while capture thread is blocked on WASAPI.
    void Stop();

    bool IsRunning() const { return running_.load(); }

    /// Get a thread-safe diagnostics snapshot.
    EndpointLoopbackDiagnostics GetDiagnostics() const;

private:
    void CaptureThread(std::function<bool(const AudioPacket&)> onPacket);

    /// Attempt to recover from a device-invalidated condition.
    /// Performs exponential backoff (250ms, 500ms, 1000ms, 2000ms) then
    /// tries to reinitialize the WASAPI endpoint. Returns true on success.
    /// The recovered session pointers are stored in recoverySession_ for
    /// CaptureThread to pick up.
    bool RecoverEndpoint();

    // ── WASAPI session state (recreated during recovery) ──
    struct WasapiSession {
        IMMDeviceEnumerator* enumerator = nullptr;
        IMMDevice* device = nullptr;
        IAudioClient* audioClient = nullptr;
        IAudioCaptureClient* captureClient = nullptr;
        WAVEFORMATEX* mixFormat = nullptr;

        bool IsValid() const { return audioClient != nullptr; }

        void Release() {
            if (mixFormat) { CoTaskMemFree(mixFormat); mixFormat = nullptr; }
            if (captureClient) { captureClient->Release(); captureClient = nullptr; }
            if (audioClient) { audioClient->Release(); audioClient = nullptr; }
            if (device) { device->Release(); device = nullptr; }
            if (enumerator) { enumerator->Release(); enumerator = nullptr; }
        }
    };

    /// Session produced by a successful RecoverEndpoint() call.
    WasapiSession recoverySession_;

    std::atomic<bool> running_{false};
    std::thread captureThread_;

    // Persistent pointer so Stop() can wake the capture thread.
    // Owned and released on the capture thread; Stop() only calls Stop()
    // on it from the control thread. Atomic to avoid data race since the
    // control thread reads it while the capture thread writes it.
    // Access pattern:
    //   - CaptureThread startup: .store(pAudioClient) before signaling success
    //   - Stop: .load() to read, call Stop() if non-null
    //   - CaptureThread cleanup: .store(nullptr) before release
    std::atomic<IAudioClient*> audioClient_{nullptr};

    // Set by IMMNotificationClient when the default render endpoint changes.
    // Checked in the capture loop to trigger early recovery.
    std::atomic<bool> deviceChangePending_{false};

    // Tracks whether the IMMNotificationClient sink is registered on the
    // current pEnumerator so we can unregister during cleanup.
    bool notificationRegistered_ = false;
    // Raw pointer to the registered sink (owned by the enumerator via refcounting).
    // Only valid when notificationRegistered_ is true.
    IMMNotificationClient* notificationSink_ = nullptr;

    // Stateful resampler — must persist across packets to avoid boundary clicks.
    LinearResampler* resampler_ = nullptr;
    uint32_t lastSourceRate_ = 0;

    // Per-packet conversion buffers (reused to reduce allocations)
    std::vector<float> conversionBuffer_;
    std::vector<float> stereoBuffer_;
    std::vector<float> resampleBuffer_;

    // Readiness handshake
    std::mutex startupMutex_;
    std::condition_variable startupCv_;
    EndpointStartOutcome startupOutcome_;
    bool startupComplete_ = false;

    // Helper to signal startup completion from capture thread
    void SignalStartupComplete(EndpointStartResult result, HRESULT hr);

    // Diagnostics
    mutable std::mutex diagMutex_;
    EndpointLoopbackDiagnostics diag_;
};

} // namespace screenlink::audio

#endif // SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H
