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

    /// Record a processed frame with its elapsed time and success status.
    void RecordFrame(uint64_t elapsedUs, bool success);

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
};

/// Get a snapshot of current diagnostics.
DiagnosticSnapshot GetDiagnostics();

} // namespace screenlink::video
