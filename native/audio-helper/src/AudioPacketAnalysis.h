#ifndef SCREENLINK_AUDIO_PACKET_ANALYSIS_H
#define SCREENLINK_AUDIO_PACKET_ANALYSIS_H

#include <cmath>
#include <cstddef>
#include <cstdint>

#include "LoopbackCapture.h" // AudioPacket

namespace screenlink::audio {

constexpr float kAudioSilenceThreshold = 1.0e-8f;

/// Actual-sample energy measurement for a PCM float buffer.
/// Does NOT use packet.isSilent as evidence of real silence.
struct PacketEnergy {
    float peak = 0.0f;
    double sumSquares = 0.0;
    uint64_t sampleCount = 0;
    uint64_t nonZeroSampleCount = 0;

    bool HasAudibleSamples() const noexcept {
        return nonZeroSampleCount > 0;
    }

    double Rms() const noexcept {
        if (sampleCount == 0) {
            return 0.0;
        }
        return std::sqrt(sumSquares / static_cast<double>(sampleCount));
    }
};

/// Measure actual float PCM energy from a raw sample buffer.
/// @param samples  Pointer to interleaved float32 PCM data. Null is safe (returns zero energy).
/// @param sampleCount  Number of float samples. Zero is safe (returns zero energy).
inline PacketEnergy MeasurePacketEnergy(
    const float* samples,
    size_t sampleCount) noexcept
{
    PacketEnergy energy;
    if (samples == nullptr || sampleCount == 0) {
        return energy;
    }

    energy.sampleCount = sampleCount;

    for (size_t i = 0; i < sampleCount; ++i) {
        float sample = samples[i];
        float absVal = std::abs(sample);
        if (absVal > energy.peak) {
            energy.peak = absVal;
        }
        if (absVal > kAudioSilenceThreshold) {
            energy.nonZeroSampleCount++;
        }
        energy.sumSquares += static_cast<double>(absVal) * static_cast<double>(absVal);
    }

    return energy;
}

/// Measure actual float PCM energy from an AudioPacket.
inline PacketEnergy MeasurePacketEnergy(const AudioPacket& packet) noexcept {
    return MeasurePacketEnergy(packet.frames,
        static_cast<size_t>(packet.frameCount) * packet.channels);
}

} // namespace screenlink::audio

#endif // SCREENLINK_AUDIO_PACKET_ANALYSIS_H
