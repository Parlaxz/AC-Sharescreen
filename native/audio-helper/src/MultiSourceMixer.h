#ifndef SCREENLINK_MULTI_SOURCE_MIXER_H
#define SCREENLINK_MULTI_SOURCE_MIXER_H

#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "LoopbackCapture.h" // AudioPacket, PacketCallback

namespace screenlink::audio {

/// Per-source state snapshot for diagnostics.
struct MixerSourceState {
    uint32_t sourceId = 0;
    uint32_t pid = 0;
    uint64_t creationTimeUtc100ns = 0;
    bool active = false;
    size_t queueDepth = 0;
    uint64_t queueMaxAge100ns = 0;
    uint64_t latePackets = 0;
    uint64_t missingPackets = 0;
    uint64_t silentPackets = 0;
    uint64_t discontinuities = 0;
    uint64_t droppedPackets = 0;
    uint64_t droppedFrames = 0;
};

/// Full mixer diagnostics snapshot.
struct MixerDiagnostics {
    uint64_t outputPackets = 0;
    uint64_t outputFrames = 0;
    uint64_t silentOutputPackets = 0;
    uint64_t discontinuities = 0;
    uint32_t activeSourceCount = 0;
    uint32_t peakSourceCount = 0;
    uint32_t eligibleSessionCount = 0;
    uint32_t excludedDiscordCount = 0;
    uint32_t excludedScreenLinkCount = 0;
    uint32_t duplicateRootCount = 0;
    uint32_t invalidSessionCount = 0;
    uint32_t sourcesAdded = 0;
    uint32_t sourcesRemoved = 0;
    float peakMixLevel = 0.0f;
    float appliedHeadroomDb = 0.0f;
    uint64_t clippedSamples = 0;
    uint64_t limitedBlocks = 0;
    uint32_t maxQueueDepth = 0;
    uint64_t maxQueueAge100ns = 0;
    uint32_t sourceQueuesAtMax = 0;
    std::vector<MixerSourceState> sourceStates;
    std::string lastError;
};

/// A queued audio packet with owned frame data (copy of AudioPacket.frames).
struct QueuedPacket {
    AudioPacket header;           // metadata (frames pointer is invalid)
    std::vector<float> frameData; // owned copy of interleaved float32 samples
};

/// Multi-source mixer that receives timestamped AudioPackets from
/// multiple application capture sources and produces one continuous
/// mixed PCM output stream at 48kHz stereo.
///
/// Thread safety:
///   - FeedPacket: thread-safe (called from capture callback threads)
///   - AddSource/RemoveSource: thread-safe (called from control thread)
///   - GetDiagnostics: thread-safe (called from control thread)
///   - Start/Stop: not thread-safe (call from single thread)
class MultiSourceMixer {
public:
    explicit MultiSourceMixer(uint32_t sampleRate, uint16_t channels);
    ~MultiSourceMixer();

    // Add a source: receives AudioPackets from one process-loopback capture.
    // Returns a sourceId (opaque identifier) for remove/query.
    uint32_t AddSource(uint32_t pid, uint64_t creationTimeUtc100ns);

    // Add a synthetic source for testing (uses SyntheticSource internally).
    uint32_t AddSyntheticSource(int mode, int totalPackets);

    // Remove a source by sourceId.
    void RemoveSource(uint32_t sourceId);

    // Feed a packet from a capture source into the mixer.
    // Called from the capture callback thread.
    void FeedPacket(uint32_t sourceId, const AudioPacket& packet);

    // Start the mixer output thread. Produces 480-frame packets at 48kHz.
    // @param onPacket Callback for each mixed output packet
    void Start(PacketCallback onPacket);

    // Stop the mixer output thread.
    void Stop();

    bool IsRunning() const;

    // Get current mixer diagnostics.
    MixerDiagnostics GetDiagnostics() const;

    // Count of active (non-removed) sources.
    uint32_t SourceCount() const;

    static constexpr uint32_t kMaxSources = 32; ///< Hard limit on concurrent sources

private:
    void MixerThread();

    uint32_t sampleRate_;
    uint16_t channels_;
    uint32_t framesPerPacket_ = 480; // 10ms at 48kHz

    std::atomic<bool> running_{false};
    std::atomic<bool> threadStarted_{false};
    std::thread mixerThread_;

    // Per-source capture state
    struct CaptureSource {
        uint32_t sourceId;
        uint32_t pid;
        uint64_t creationTimeUtc100ns;

        std::deque<QueuedPacket> queue_;
        size_t maxQueuePackets_ = 4;         // ~40ms target (was 5 with contradictory 10ms age)
        uint64_t maxQueueAge100ns_ = 500000; // 50ms hard max (was 100000 = 10ms)
        mutable std::mutex queueMutex_;

        // Statistics
        uint64_t latePackets_ = 0;
        uint64_t missingPackets_ = 0;
        uint64_t silentPackets_ = 0;
        uint64_t discontinuities_ = 0;
        uint64_t droppedPackets_ = 0;
        uint64_t droppedFrames_ = 0;
        uint64_t lastSequence_ = 0;
        bool hasLastSequence_ = false;
    };

    // Use shared_ptr so FeedPacket can keep a source alive outside the lock
    std::vector<std::shared_ptr<CaptureSource>> sources_;
    mutable std::mutex sourcesMutex_;
    uint32_t nextSourceId_ = 1;

    PacketCallback outputCallback_;

    // Diagnostics (protected by diagMutex_)
    mutable std::mutex diagMutex_;
    MixerDiagnostics diag_;
};

} // namespace screenlink::audio

#endif // SCREENLINK_MULTI_SOURCE_MIXER_H
