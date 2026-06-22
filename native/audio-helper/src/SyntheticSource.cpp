#include "SyntheticSource.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cmath>
#include <cstring>
#include <vector>

namespace screenlink::audio {

// ── Static helper ──

uint64_t SyntheticSource::GetQpcFrequency() {
    static uint64_t freq = []() {
        LARGE_INTEGER f;
        QueryPerformanceFrequency(&f);
        return static_cast<uint64_t>(f.QuadPart);
    }();
    return freq;
}

// ── Private helpers ──

void SyntheticSource::GenerateTone(float* buffer, uint32_t frames,
                                   uint32_t channels, uint64_t frameIndex,
                                   float amplitude) {
    const double freq = static_cast<double>(kToneFrequency);
    for (uint32_t i = 0; i < frames; ++i) {
        const double phase = 2.0 * 3.14159265358979323846
                           * freq
                           * static_cast<double>(frameIndex + i)
                           / 48000.0;
        const float sample = amplitude * static_cast<float>(std::sin(phase));
        for (uint32_t ch = 0; ch < channels; ++ch) {
            buffer[i * channels + ch] = sample;
        }
    }
}

void SyntheticSource::GenerateSilence(float* buffer, uint32_t frames,
                                      uint32_t channels) {
    std::memset(buffer, 0, static_cast<size_t>(frames) * channels * sizeof(float));
}

// ── Run ──

uint64_t SyntheticSource::Run(SyntheticConfig config, PacketCallback onPacket) {
    if (config.framesPerPacket == 0 || config.channels == 0) {
        return 0;
    }

    // Pre-allocate scratch buffer for one packet (interleaved float32).
    const size_t bufferFloats =
        static_cast<size_t>(config.framesPerPacket) * config.channels;
    std::vector<float> buffer(bufferFloats, 0.0f);

    // QPC frequency for timestamp conversion
    LARGE_INTEGER qpcFreq;
    QueryPerformanceFrequency(&qpcFreq);
    const double hostFreq = static_cast<double>(qpcFreq.QuadPart);

    // Persistent state across packets
    uint64_t packetsGenerated = 0;
    uint64_t accumulatedFrames = 0;
    uint64_t currentSequence = 0;
    bool discontinuityInjected = false;
    bool sequenceSkipped = false;

    // Mode-specific pre-computation
    uint32_t discontinuityPacketIndex = UINT32_MAX;
    uint32_t skipPacketIndex = UINT32_MAX;
    uint32_t toneSilenceBoundary1 = 0;
    uint32_t toneSilenceBoundary2 = 0;

    if (config.totalPackets > 0) {
        switch (config.mode) {
            case SyntheticMode::kToneSilenceTone:
                toneSilenceBoundary1 = config.totalPackets / 3;
                toneSilenceBoundary2 = 2 * config.totalPackets / 3;
                break;
            case SyntheticMode::kOneDiscontinuity:
                discontinuityPacketIndex = config.totalPackets / 2;
                break;
            case SyntheticMode::kOneSkippedSequence:
                skipPacketIndex = config.totalPackets / 2;
                break;
            default:
                break;
        }
    }

    // ── Main generation loop ──
    while (true) {
        // Check termination: finite count
        if (config.totalPackets > 0 && packetsGenerated >= config.totalPackets) {
            break;
        }

        // ── Determine packet properties for the current mode ──
        bool isSilent = false;
        bool isDiscontinuous = false;
        bool isEndOfStream = false;

        switch (config.mode) {
            case SyntheticMode::kContinuousTone:
                // All regular tone — nothing special
                break;

            case SyntheticMode::kSilence:
                isSilent = true;
                break;

            case SyntheticMode::kToneSilenceTone:
                if (packetsGenerated >= toneSilenceBoundary1 &&
                    packetsGenerated < toneSilenceBoundary2) {
                    isSilent = true;
                    if (packetsGenerated == toneSilenceBoundary1) {
                        isDiscontinuous = true;
                    }
                }
                break;

            case SyntheticMode::kOneDiscontinuity:
                if (packetsGenerated == discontinuityPacketIndex && !discontinuityInjected) {
                    isDiscontinuous = true;
                    discontinuityInjected = true;
                }
                break;

            case SyntheticMode::kOneSkippedSequence:
                if (packetsGenerated == skipPacketIndex && !sequenceSkipped) {
                    currentSequence++;  // skip one sequence number (e.g. 5 -> 6)
                    isDiscontinuous = true;
                    sequenceSkipped = true;
                }
                break;

            case SyntheticMode::kEndOfStream:
                // Flag the last packet when totalPackets is finite
                if (config.totalPackets > 0 &&
                    packetsGenerated + 1 >= config.totalPackets) {
                    isEndOfStream = true;
                }
                // For totalPackets == 0 (infinite), the end-of-stream event
                // would be the packet that the callback rejects. That packet
                // won't have the flag, which is acceptable for the infinite case.
                break;
        }

        // ── Generate PCM frames ──
        if (isSilent) {
            GenerateSilence(buffer.data(), config.framesPerPacket, config.channels);
        } else {
            GenerateTone(buffer.data(), config.framesPerPacket, config.channels,
                         accumulatedFrames, kAmplitude);
        }

        // ── QPC timestamp (100ns units) ──
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        uint64_t qpc100ns = static_cast<uint64_t>(
            (static_cast<double>(now.QuadPart) * 10000000.0) / hostFreq);

        // For kOneDiscontinuity, inject a 100ms gap in the timestamp
        if (isDiscontinuous && config.mode == SyntheticMode::kOneDiscontinuity) {
            qpc100ns += 1000000;  // 100ms in 100ns units
        }

        // ── Build AudioPacket ──
        AudioPacket packet;
        packet.frames = buffer.data();
        packet.frameCount = config.framesPerPacket;
        packet.channels = config.channels;
        packet.sequenceNumber = currentSequence;
        packet.qpcPosition100ns = qpc100ns;
        packet.devicePosition = accumulatedFrames;
        packet.isSilent = isSilent;
        packet.isDiscontinuous = isDiscontinuous;
        packet.hasTimestampError = false;
        packet.isEndOfStream = isEndOfStream;

        // ── Deliver to callback ──
        bool shouldContinue = onPacket(packet);
        packetsGenerated++;

        if (!shouldContinue) {
            break;
        }

        // ── Advance state for next packet ──
        accumulatedFrames += config.framesPerPacket;
        currentSequence += 1;
    }

    return packetsGenerated;
}

} // namespace screenlink::audio
