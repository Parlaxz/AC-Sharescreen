#include "MultiSourceMixer.h"
#include "SyntheticSource.h" // for GetQpcFrequency

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>

namespace screenlink::audio {

// ========================================================================
// MultiSourceMixer
// ========================================================================

MultiSourceMixer::MultiSourceMixer(uint32_t sampleRate, uint16_t channels)
    : sampleRate_(sampleRate)
    , channels_(channels)
{
}

MultiSourceMixer::~MultiSourceMixer() {
    Stop();
}

uint32_t MultiSourceMixer::AddSource(uint32_t pid, uint64_t creationTimeUtc100ns) {
    std::lock_guard<std::mutex> lock(sourcesMutex_);

    // Enforce source limit
    if (sources_.size() >= kMaxSources) {
        return 0; // 0 means "no source added"
    }

    auto source = std::make_shared<CaptureSource>();
    source->sourceId = nextSourceId_++;
    source->pid = pid;
    source->creationTimeUtc100ns = creationTimeUtc100ns;

    uint32_t sid = source->sourceId;
    sources_.push_back(std::move(source));

    {
        std::lock_guard<std::mutex> dlock(diagMutex_);
        diag_.sourcesAdded++;
    }

    return sid;
}

uint32_t MultiSourceMixer::AddSyntheticSource(int /*mode*/, int /*totalPackets*/) {
    // For testing — add a synthetic source with pid=0 and creationTime=0.
    // The synthetic source is driven externally; no automatic generation here.
    // The self-test will manually feed packets via FeedPacket.
    return AddSource(0, 0);
}

void MultiSourceMixer::RemoveSource(uint32_t sourceId) {
    std::lock_guard<std::mutex> lock(sourcesMutex_);

    auto it = std::find_if(sources_.begin(), sources_.end(),
        [sourceId](const auto& s) { return s->sourceId == sourceId; });

    if (it != sources_.end()) {
        // Drain the queue before removal
        {
            std::lock_guard<std::mutex> qlock((*it)->queueMutex_);
            (*it)->queue_.clear();
        }
        sources_.erase(it);

        {
            std::lock_guard<std::mutex> dlock(diagMutex_);
            diag_.sourcesRemoved++;
        }
    }
}

void MultiSourceMixer::FeedPacket(uint32_t sourceId, const AudioPacket& packet) {
    // Find and hold the source via shared_ptr to prevent use-after-free
    // if RemoveSource() runs concurrently.
    std::shared_ptr<CaptureSource> source;
    {
        std::lock_guard<std::mutex> lock(sourcesMutex_);
        for (auto& s : sources_) {
            if (s->sourceId == sourceId) {
                source = s; // copy shared_ptr, keeps object alive
                break;
            }
        }
    }

    if (!source) return; // Source was removed (and no shared owners remain)

    // Build a queued packet with owned frame data
    QueuedPacket qp;
    qp.header = packet;
    qp.header.frames = nullptr; // invalidate the pointer

    // Copy frame data
    if (packet.frames && packet.frameCount > 0) {
        size_t sampleCount = static_cast<size_t>(packet.frameCount) * packet.channels;
        qp.frameData.assign(packet.frames, packet.frames + sampleCount);
    }

    // Track sequence discontinuities
    if (source->hasLastSequence_) {
        if (packet.sequenceNumber != source->lastSequence_ + 1) {
            source->discontinuities_++;
        }
    }

    source->lastSequence_ = packet.sequenceNumber;
    source->hasLastSequence_ = true;

    // Push into per-source queue with bounded size
    {
        std::lock_guard<std::mutex> qlock(source->queueMutex_);

        // Check age limit: drop packets that are too old
        uint64_t now100ns = 0;
        {
            LARGE_INTEGER qpc;
            QueryPerformanceCounter(&qpc);
            uint64_t freq = SyntheticSource::GetQpcFrequency();
            now100ns = static_cast<uint64_t>(
                (static_cast<double>(qpc.QuadPart) * 10000000.0) /
                static_cast<double>(freq));
        }

        // Drop oldest packets that exceed max age
        while (!source->queue_.empty()) {
            auto& oldest = source->queue_.front();
            if (oldest.header.qpcPosition100ns + source->maxQueueAge100ns_ < now100ns) {
                source->droppedPackets_++;
                source->droppedFrames_ += oldest.header.frameCount;
                source->queue_.pop_front();
            } else {
                break;
            }
        }

        // Drop oldest if queue is full
        if (source->queue_.size() >= source->maxQueuePackets_) {
            auto& oldest = source->queue_.front();
            source->droppedPackets_++;
            source->droppedFrames_ += oldest.header.frameCount;
            source->queue_.pop_front();
        }

        source->queue_.push_back(std::move(qp));
    }
}

auto MultiSourceMixer::Start(PacketCallback onPacket) -> MultiSourceMixer::StartResult {
    StartResult result;
    std::cerr << "[Mixer] start.enter: sampleRate=" << sampleRate_
              << " channels=" << channels_
              << " running=" << running_.load()
              << " threadJoinable=" << mixerThread_.joinable() << std::endl;

    if (running_.load()) {
        result.error = StartError::AlreadyRunning;
        return result;
    }

    // Check for stale thread from a previous incomplete stop
    if (mixerThread_.joinable()) {
        result.error = StartError::StaleThreadNotJoined;
        std::cerr << "[Mixer] Start failed: previous thread still joinable" << std::endl;
        return result;
    }

    if (!onPacket) {
        result.error = StartError::NoOutputCallback;
        std::cerr << "[Mixer] Start failed: no output callback provided" << std::endl;
        return result;
    }

    if (sampleRate_ == 0 || channels_ == 0) {
        result.error = StartError::InvalidFormat;
        std::cerr << "[Mixer] Start failed: invalid format (rate="
                  << sampleRate_ << " ch=" << channels_ << ")" << std::endl;
        return result;
    }

    {
        std::lock_guard<std::mutex> lock(sourcesMutex_);
        result.registeredSources = sources_.size();
    }

    outputCallback_ = std::move(onPacket);
    threadStarted_.store(false);
    running_.store(true);

    try {
        mixerThread_ = std::thread(&MultiSourceMixer::MixerThread, this);
    } catch (const std::system_error& e) {
        running_.store(false);
        result.error = StartError::ThreadCreationFailed;
        std::cerr << "[Mixer] Start failed: thread creation error: " << e.what() << std::endl;
        return result;
    }

    // Wait for the mixer thread to actually start before returning
    {
        std::unique_lock<std::mutex> lock(threadStartedMutex_);
        if (!threadStartedCv_.wait_for(lock, std::chrono::seconds(1),
                [this]() { return threadStarted_.load(); })) {
        // Thread failed to start in reasonable time
            running_.store(false);
            if (mixerThread_.joinable()) mixerThread_.join();
            result.error = StartError::ThreadCreationFailed;
            std::cerr << "[Mixer] Start failed: thread did not start within timeout" << std::endl;
            return result;
        }
    }

    result.success = true;
    result.error = StartError::None;
    std::cerr << "[Mixer] Started successfully: " << result.registeredSources
              << " registered sources" << std::endl;
    return result;
}

void MultiSourceMixer::Stop() {
    if (!running_.load()) {
        if (mixerThread_.joinable()) {
            mixerThread_.join();
        }
        return;
    }

    running_.store(false);

    if (mixerThread_.joinable()) {
        mixerThread_.join();
    }
}

bool MultiSourceMixer::IsRunning() const {
    return running_.load();
}

uint32_t MultiSourceMixer::SourceCount() const {
    std::lock_guard<std::mutex> lock(sourcesMutex_);
    return static_cast<uint32_t>(sources_.size());
}

MixerDiagnostics MultiSourceMixer::GetDiagnostics() const {
    std::lock_guard<std::mutex> lock(sourcesMutex_);
    std::lock_guard<std::mutex> dlock(diagMutex_);

    MixerDiagnostics d = diag_;

    // Set diagnostics capture timestamp
    {
        LARGE_INTEGER qpc;
        QueryPerformanceCounter(&qpc);
        LARGE_INTEGER freq;
        QueryPerformanceFrequency(&freq);
        d.diagnosticsTimestamp = static_cast<uint64_t>(
            (static_cast<double>(qpc.QuadPart) * 10000000.0) /
            static_cast<double>(freq.QuadPart));
    }

    // Collect per-source states
    d.sourceStates.clear();
    d.activeSourceCount = 0;

    for (const auto& s : sources_) {
        MixerSourceState state;
        state.sourceId = s->sourceId;
        state.pid = s->pid;
        state.creationTimeUtc100ns = s->creationTimeUtc100ns;
        state.active = true;
        state.latePackets = s->latePackets_;
        state.missingPackets = s->missingPackets_;
        state.silentPackets = s->silentPackets_;
        state.discontinuities = s->discontinuities_;
        state.droppedPackets = s->droppedPackets_;
        state.droppedFrames = s->droppedFrames_;
        d.activeSourceCount++;

        {
            std::lock_guard<std::mutex> qlock(s->queueMutex_);
            state.queueDepth = s->queue_.size();
        }

        d.sourceStates.push_back(std::move(state));
    }

    return d;
}

void MultiSourceMixer::MixerThread() {
    // Signal that the thread has started
    {
        std::lock_guard<std::mutex> lock(threadStartedMutex_);
        threadStarted_.store(true);
    }
    threadStartedCv_.notify_one();

    // Set thread priority
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);

    // Pre-allocate output buffer
    const size_t outputSamples = static_cast<size_t>(framesPerPacket_) * channels_;
    std::vector<float> outputBuffer(outputSamples, 0.0f);

    // QPC frequency for timestamp conversion and pacing
    LARGE_INTEGER qpcFreq;
    QueryPerformanceFrequency(&qpcFreq);
    const double hostFreq = static_cast<double>(qpcFreq.QuadPart);

    // Per-packet interval in QPC units
    uint64_t packetIntervalQpc = static_cast<uint64_t>(
        static_cast<double>(qpcFreq.QuadPart) *
        static_cast<double>(framesPerPacket_) /
        static_cast<double>(sampleRate_));

    // High-resolution timer for pacing
    HANDLE timer = nullptr;
    bool timerResolutionSet = false;

    timer = CreateWaitableTimerExW(
        nullptr, nullptr,
        CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
        TIMER_ALL_ACCESS);

    if (!timer) {
        timer = CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_ALL_ACCESS);
        if (timer) {
            timeBeginPeriod(1);
            timerResolutionSet = true;
        }
    }

    // QPC deadline
    LARGE_INTEGER deadline;
    {
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        deadline.QuadPart = now.QuadPart;
    }

    // Temporary per-source scratch buffers
    // We'll mix directly into outputBuffer and sum contributions

    uint64_t outputSequence = 0;
    uint64_t outputFrames = 0;

    while (running_.load()) {
        // Advance deadline by one packet interval
        deadline.QuadPart += static_cast<LONGLONG>(packetIntervalQpc);

        // Clear output buffer
        std::memset(outputBuffer.data(), 0, outputSamples * sizeof(float));

        // Count active (non-silent) sources for headroom calculation
        uint32_t activeNonSilentSources = 0;
        uint32_t totalSources = 0;

        // Collect per-source contributions (with owned frame data)
        struct SourceContribution {
            std::vector<float> frameData; // owned copy of interleaved float32
            uint32_t frameCount = 0;
            uint32_t channels = 0;
            bool isSilent = false;
            bool isDiscontinuous = false;
            bool hasData = false;
        };

        // ── Source collection: consume the oldest queued packet ──
        // WASAPI capture timestamps (qpcPosition100ns) are device positions
        // and may not align with the mixer's wall-clock deadline. Instead of
        // trying to match an exact 10ms window, we simply consume the oldest
        // packet from each source's queue. Bounded queue age/depth protection
        // was already applied in FeedPacket().
        std::vector<SourceContribution> contributions;

        {
            std::lock_guard<std::mutex> lock(sourcesMutex_);

            for (auto& source : sources_) {
                SourceContribution contrib;
                totalSources++;

                std::lock_guard<std::mutex> qlock(source->queueMutex_);

                if (source->queue_.empty()) {
                    // No packet available — output silence
                    source->missingPackets_++;
                    contrib.isSilent = true;
                    contrib.hasData = false;
                } else {
                    // Consume the oldest queued packet regardless of timestamp.
                    // Bounded queue depth and age are enforced in FeedPacket.
                    auto qp = std::move(source->queue_.front());
                    source->queue_.pop_front();

                    contrib.frameData = std::move(qp.frameData);
                    contrib.frameCount = qp.header.frameCount;
                    contrib.channels = qp.header.channels;
                    contrib.isSilent = qp.header.isSilent;
                    contrib.isDiscontinuous = qp.header.isDiscontinuous;

                    if (qp.header.isSilent) {
                        source->silentPackets_++;
                    }

                    if (qp.header.isDiscontinuous) {
                        source->discontinuities_++;
                    }

                    contrib.hasData = true;

                    if (!qp.header.isSilent) {
                        bool nonZero = false;
                        for (size_t i = 0; i < contrib.frameData.size(); ++i) {
                            if (contrib.frameData[i] != 0.0f) {
                                nonZero = true;
                                break;
                            }
                        }
                        if (nonZero) {
                            activeNonSilentSources++;
                        }
                    }
                }

                contributions.push_back(std::move(contrib));
            }
        }

        // Compute headroom based on number of non-silent sources
        float headroom = 1.0f;
        if (activeNonSilentSources > 1) {
            headroom = 1.0f / std::sqrt(static_cast<float>(activeNonSilentSources));
        }

        float headroomDb = 20.0f * std::log10(headroom);
        if (headroomDb < -60.0f) headroomDb = -60.0f;

        // Mix: sum all source frames with headroom
        bool allSilent = true;
        bool anyDiscontinuous = false;
        uint64_t clippedSamplesThisBlock = 0;

        for (auto& contrib : contributions) {
            if (!contrib.hasData || contrib.isSilent) continue;

            if (contrib.isDiscontinuous) {
                anyDiscontinuous = true;
            }

            // Sum into output buffer with headroom
            uint32_t mixFrames = (std::min)(contrib.frameCount, framesPerPacket_);
            uint32_t mixChannels = (std::min)(contrib.channels, static_cast<uint32_t>(channels_));
            const float* srcData = contrib.frameData.data();

            for (uint32_t f = 0; f < mixFrames; ++f) {
                for (uint32_t ch = 0; ch < mixChannels; ++ch) {
                    size_t idx = static_cast<size_t>(f) * channels_ + ch;
                    size_t srcIdx = static_cast<size_t>(f) * contrib.channels + ch;
                    outputBuffer[idx] += srcData[srcIdx] * headroom;
                }
            }

            allSilent = false;
        }

        // Clamp output to [-1.0, 1.0]
        for (size_t i = 0; i < outputSamples; ++i) {
            if (outputBuffer[i] > 1.0f) {
                clippedSamplesThisBlock++;
                outputBuffer[i] = 1.0f;
            } else if (outputBuffer[i] < -1.0f) {
                clippedSamplesThisBlock++;
                outputBuffer[i] = -1.0f;
            }
        }

        // Compute peak level in this block and derive silence from actual samples
        float peak = 0.0f;
        for (size_t i = 0; i < outputSamples; ++i) {
            float absVal = std::abs(outputBuffer[i]);
            if (absVal > peak) peak = absVal;
        }
        static constexpr float kSilenceThreshold = 1.0e-8f;
        const bool outputIsSilent = peak <= kSilenceThreshold;

        // Build output AudioPacket
        AudioPacket output;
        output.frames = outputBuffer.data();
        output.frameCount = framesPerPacket_;
        output.channels = channels_;
        output.sequenceNumber = outputSequence;
        output.isSilent = outputIsSilent;
        output.isDiscontinuous = anyDiscontinuous;
        output.isEndOfStream = false;
        output.sourceId = 0; // mixed output

        // QPC timestamp (100ns)
        {
            LARGE_INTEGER now;
            QueryPerformanceCounter(&now);
            output.qpcPosition100ns = static_cast<uint64_t>(
                (static_cast<double>(now.QuadPart) * 10000000.0) / hostFreq);
        }

        // Update diagnostics
        {
            std::lock_guard<std::mutex> dlock(diagMutex_);
            diag_.outputPackets++;
            diag_.outputFrames += framesPerPacket_;
            if (allSilent) diag_.silentOutputPackets++;
            if (anyDiscontinuous) diag_.discontinuities++;
            if (peak > diag_.peakMixLevel) diag_.peakMixLevel = peak;
            diag_.appliedHeadroomDb = headroomDb;
            diag_.clippedSamples += clippedSamplesThisBlock;
            if (clippedSamplesThisBlock > 0) diag_.limitedBlocks++;
            if (totalSources > diag_.peakSourceCount) diag_.peakSourceCount = totalSources;
        }

        // Call output callback
        if (outputCallback_ && !outputCallback_(output)) {
            running_.store(false);
            break;
        }

        outputSequence++;
        outputFrames += framesPerPacket_;

        // ── Pace: wait until next deadline ──
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        int64_t remainingQpc = deadline.QuadPart - now.QuadPart;

        if (remainingQpc > 0) {
            int64_t relativeWait100ns = -static_cast<int64_t>(
                (static_cast<double>(remainingQpc) * 10000000.0) /
                static_cast<double>(qpcFreq.QuadPart));

            if (timer && relativeWait100ns < 0) {
                LARGE_INTEGER dueTime;
                dueTime.QuadPart = relativeWait100ns;
                if (SetWaitableTimer(timer, &dueTime, 0, nullptr, nullptr, FALSE)) {
                    WaitForSingleObject(timer, 50);
                } else {
                    // Fallback
                    if (!timerResolutionSet) {
                        timeBeginPeriod(1);
                        timerResolutionSet = true;
                    }
                    DWORD sleepMs = static_cast<DWORD>(
                        remainingQpc * 1000 / qpcFreq.QuadPart);
                    if (sleepMs > 0) Sleep(sleepMs);
                }
            } else {
                if (!timerResolutionSet) {
                    timeBeginPeriod(1);
                    timerResolutionSet = true;
                }
                DWORD sleepMs = static_cast<DWORD>(
                    remainingQpc * 1000 / qpcFreq.QuadPart);
                if (sleepMs > 0) Sleep(sleepMs);
            }
        } else {
            // Deadline missed — skip catch-up (just continue)
            // Re-align deadline to current time to avoid cascading delays
            LARGE_INTEGER now2;
            QueryPerformanceCounter(&now2);
            deadline.QuadPart = now2.QuadPart;
        }
    }

    // Cleanup
    if (timer) {
        CloseHandle(timer);
    }
    if (timerResolutionSet) {
        timeEndPeriod(1);
    }

    // Clear all queues
    {
        std::lock_guard<std::mutex> lock(sourcesMutex_);
        for (auto& source : sources_) {
            std::lock_guard<std::mutex> qlock(source->queueMutex_);
            source->queue_.clear();
        }
    }

    running_.store(false);
}

} // namespace screenlink::audio
