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

private:
    void CaptureThread(std::function<bool(const AudioPacket&)> onPacket);

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
};

} // namespace screenlink::audio

#endif // SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H
