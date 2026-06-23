#ifndef SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H
#define SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <thread>
#include <vector>

#include "LoopbackCapture.h" // AudioPacket, PacketCallback

namespace screenlink::audio {

// Forward declaration for internal use
class LinearResampler;

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
    /// @param onPacket          Callback for captured AudioPackets
    /// @return true if capture thread started successfully
    bool Start(std::function<bool(const AudioPacket&)> onPacket);

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
    // on it from the control thread. The access pattern is:
    //   - Start: initialized on capture thread
    //   - Stop: read from control thread after running_ = false
    //   - CaptureThread: clears on exit
    IAudioClient* audioClient_ = nullptr;

    // Stateful resampler — must persist across packets to avoid boundary clicks.
    LinearResampler* resampler_ = nullptr;
    uint32_t lastSourceRate_ = 0;

    // Per-packet conversion buffers (reused to reduce allocations)
    std::vector<float> conversionBuffer_;
    std::vector<float> stereoBuffer_;
    std::vector<float> resampleBuffer_;
};

} // namespace screenlink::audio

#endif // SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H
