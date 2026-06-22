#include "SyntheticSource.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>

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

    // QPC frequency for timestamp conversion and pacing
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

    // ── High-resolution pacing setup (QPC-deadline-based waitable timer) ──
    HANDLE timer = nullptr;
    bool timerResolutionSet = false;
    uint64_t packetIntervalQpc = 0;
    LARGE_INTEGER nextDeadline = {};
    bool deadlineInitialized = false;

    if (config.pacingEnabled && config.sampleRate > 0) {
        // Compute per-packet interval in QPC units
        packetIntervalQpc = static_cast<uint64_t>(
            static_cast<double>(qpcFreq.QuadPart) *
            static_cast<double>(config.framesPerPacket) /
            static_cast<double>(config.sampleRate));

        // Try to create a high-resolution waitable timer (Windows 10+)
        timer = CreateWaitableTimerExW(
            nullptr, nullptr,
            CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
            TIMER_ALL_ACCESS);

        if (!timer) {
            // Fallback: standard waitable timer + 1ms timer resolution
            timer = CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_ALL_ACCESS);
            if (timer) {
                timeBeginPeriod(1);
                timerResolutionSet = true;
            }
        }

        // Initialize deadline to current QPC time
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        nextDeadline.QuadPart = now.QuadPart;
        deadlineInitialized = true;
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

        // Apply pending deadline-miss discontinuity (from the pacing section above)
        if (pendingDiscontinuity_) {
            isDiscontinuous = true;
            pendingDiscontinuity_ = false;
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

        // ── Pace: wait until next absolute deadline using high-resolution timer ──
        // Uses QPC-based relative time to avoid FILETIME conversion issues.
        if (config.pacingEnabled && deadlineInitialized) {
            nextDeadline.QuadPart += static_cast<LONGLONG>(packetIntervalQpc);

            // Compute remaining time from NOW to deadline in QPC ticks
            LARGE_INTEGER nowQpc;
            QueryPerformanceCounter(&nowQpc);
            int64_t remainingQpc = nextDeadline.QuadPart - nowQpc.QuadPart;

            if (remainingQpc > 0) {
                // Convert remaining QPC ticks to 100ns units for relative timer.
                // SetWaitableTimer relative time: negative value in 100ns intervals.
                int64_t relativeWait100ns = -static_cast<int64_t>(
                    (static_cast<double>(remainingQpc) * 10000000.0) /
                    static_cast<double>(qpcFreq.QuadPart));

                if (timer && relativeWait100ns < 0) {
                    LARGE_INTEGER dueTime;
                    dueTime.QuadPart = relativeWait100ns;
                    if (SetWaitableTimer(timer, &dueTime, 0, nullptr, nullptr, FALSE)) {
                        WaitForSingleObject(timer, 50);
                    } else {
                        // SetWaitableTimer failed — fallback to Sleep
                        if (!timerResolutionSet) {
                            timeBeginPeriod(1);
                            timerResolutionSet = true;
                        }
                        DWORD sleepMs = static_cast<DWORD>(
                            remainingQpc * 1000 / qpcFreq.QuadPart);
                        if (sleepMs > 0) Sleep(sleepMs);
                    }
                } else {
                    // No timer available — fallback: Sleep with 1ms resolution
                    if (!timerResolutionSet) {
                        timeBeginPeriod(1);
                        timerResolutionSet = true;
                    }
                    DWORD sleepMs = static_cast<DWORD>(
                        remainingQpc * 1000 / qpcFreq.QuadPart);
                    if (sleepMs > 0) Sleep(sleepMs);
                }
            } else {
                // Deadline already passed — handle miss
                int64_t missedIntervals = (-remainingQpc) / static_cast<int64_t>(packetIntervalQpc);
                if (missedIntervals > 0) {
                    accumulatedFrames += static_cast<uint64_t>(missedIntervals) * config.framesPerPacket;
                    currentSequence += static_cast<uint64_t>(missedIntervals);
                    // Advance deadline further by the missed intervals
                    nextDeadline.QuadPart += static_cast<LONGLONG>(missedIntervals * packetIntervalQpc);
                    // Track missed frames for discontinuity reporting on the next packet
                    pendingDiscontinuity_ = true;
                    pendingMissedFrames_ += static_cast<uint64_t>(missedIntervals) * config.framesPerPacket;
                }
            }
        }
    }

    // ── Cleanup ──
    if (timer) {
        CloseHandle(timer);
    }
    if (timerResolutionSet) {
        timeEndPeriod(1);
    }

    return packetsGenerated;
}

} // namespace screenlink::audio
