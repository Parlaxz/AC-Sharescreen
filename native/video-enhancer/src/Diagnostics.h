#pragma once
#include <cstdint>
#include <atomic>
#include <string>

namespace screenlink::video {

/// Atomic counters for performance and error tracking.
struct DiagnosticsCounters {
    std::atomic<uint64_t> totalFramesSubmitted{0};
    std::atomic<uint64_t> totalFramesCompleted{0};
    std::atomic<uint64_t> totalFramesDropped{0};
    std::atomic<uint64_t> totalProcessingErrors{0};
    std::atomic<uint64_t> totalBytesProcessed{0};

    // Timing (microseconds)
    std::atomic<uint64_t> lastProcessingTimeUs{0};
    std::atomic<uint64_t> maxProcessingTimeUs{0};
    std::atomic<uint64_t> minProcessingTimeUs{UINT64_MAX};

    // Phase 6: Native timing breakdown (microseconds, process-local)
    // These are per-frame accumulators set on each RecordFrameDetails call.
    std::atomic<uint64_t> lastInputReceiveUs{0};
    std::atomic<uint64_t> lastUploadUs{0};
    std::atomic<uint64_t> lastEffectUs{0};
    std::atomic<uint64_t> lastDownloadUs{0};
    std::atomic<uint64_t> lastOutputWriteUs{0};

    /// Record a processed frame with its elapsed time and success status.
    void RecordFrame(uint64_t elapsedUs, bool success);

    /// Record detailed per-stage timing breakdown (Phase 6).
    void RecordFrameDetails(
        uint64_t elapsedUs, bool success,
        uint64_t inputReceiveUs,
        uint64_t uploadUs,
        uint64_t effectUs,
        uint64_t downloadUs,
        uint64_t outputWriteUs);

    /// Reset all counters to their initial state.
    void Reset();
};

/// Snapshot of diagnostic state at a point in time.
struct DiagnosticSnapshot {
    uint64_t totalFramesSubmitted;
    uint64_t totalFramesCompleted;
    uint64_t totalFramesDropped;
    uint64_t totalProcessingErrors;
    uint64_t totalBytesProcessed;
    uint64_t lastProcessingTimeUs;
    uint64_t maxProcessingTimeUs;
    uint64_t minProcessingTimeUs;
    uint64_t uptimeMs;
    std::string gpuName;
    std::string driverVersion;
    std::string sdkVersion;

    // Phase 6: Native timing breakdown (microseconds, process-local)
    uint64_t lastInputReceiveUs{0};
    uint64_t lastUploadUs{0};
    uint64_t lastEffectUs{0};
    uint64_t lastDownloadUs{0};
    uint64_t lastOutputWriteUs{0};
};

/// Get a snapshot of current diagnostics.
DiagnosticSnapshot GetDiagnostics();

/// Get the global diagnostics counters instance.
DiagnosticsCounters& GetDiagnosticsCounters();

} // namespace screenlink::video
