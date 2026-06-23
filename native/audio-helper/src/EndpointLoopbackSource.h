#ifndef SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H
#define SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H

#include <atomic>
#include <cstdint>
#include <functional>
#include <thread>

#include "LoopbackCapture.h" // AudioPacket, PacketCallback

namespace screenlink::audio {

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
class EndpointLoopbackSource {
public:
    EndpointLoopbackSource();
    ~EndpointLoopbackSource();

    /// Start capturing from the default render endpoint.
    /// @param onPacket          Callback for captured AudioPackets
    /// @return true if capture thread started successfully
    bool Start(std::function<bool(const AudioPacket&)> onPacket);

    /// Stop the capture and join the thread.
    void Stop();

    bool IsRunning() const { return running_.load(); }

private:
    void CaptureThread(std::function<bool(const AudioPacket&)> onPacket);

    std::atomic<bool> running_{false};
    std::thread captureThread_;
};

} // namespace screenlink::audio

#endif // SCREENLINK_ENDPOINT_LOOPBACK_SOURCE_H
