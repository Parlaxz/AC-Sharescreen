#ifndef SCREENLINK_SYNTHETIC_SOURCE_H
#define SCREENLINK_SYNTHETIC_SOURCE_H

#include <cstdint>

#include "LoopbackCapture.h"  // AudioPacket, PacketCallback

namespace screenlink::audio {

/// Deterministic synthetic PCM modes for transport testing.
enum class SyntheticMode {
    kContinuousTone,     // Continuous sine wave
    kSilence,            // All zeros
    kToneSilenceTone,    // Tone -> Silence -> Tone transitions
    kOneDiscontinuity,   // Continuous tone with one injected discontinuity flag
    kOneSkippedSequence, // Continuous tone with one skipped sequence number
    kEndOfStream,        // Normal packets then one with EndOfStream flag set
};

/// Configuration for synthetic PCM generation.
struct SyntheticConfig {
    SyntheticMode mode = SyntheticMode::kContinuousTone;
    uint32_t sampleRate = 48000;
    uint16_t channels = 2;
    uint32_t framesPerPacket = 480;  // 10ms at 48kHz
    uint32_t totalPackets = 0;       // 0 = infinite (stop via callback returning false)
    uint32_t streamGeneration = 0;
    bool pacingEnabled = true;       // Sleep between packets to match real-time rate
};

/// Deterministic PCM generator that produces AudioPackets.
///
/// Does not use any process-loopback API calls, making it suitable
/// for transport testing on all Windows builds including 19045.
///
/// Thread safety: NOT thread-safe. Call Run() from a single thread.
class SyntheticSource {
public:
    SyntheticSource() = default;
    ~SyntheticSource() = default;

    /// Run synthetic generation. Calls onPacket for each packet.
    /// Returns when totalPackets reached or callback returns false.
    /// @param config  Generation parameters
    /// @param onPacket  Callback invoked per packet (return false to stop)
    /// @return Number of packets generated
    uint64_t Run(SyntheticConfig config, PacketCallback onPacket);

    /// Returns the QPC frequency (ticks per second), cached after first call.
    static uint64_t GetQpcFrequency();

private:
    void GenerateTone(float* buffer, uint32_t frames, uint32_t channels,
                      uint64_t frameIndex, float amplitude);
    void GenerateSilence(float* buffer, uint32_t frames, uint32_t channels);

    // Deadline-miss tracking: set when pacing falls behind, consumed on next packet
    bool pendingDiscontinuity_ = false;
    uint64_t pendingMissedFrames_ = 0;

    static constexpr float kToneFrequency = 440.0f;  // A4
    static constexpr float kAmplitude = 0.25f;        // Safe level
};

} // namespace screenlink::audio

#endif // SCREENLINK_SYNTHETIC_SOURCE_H
