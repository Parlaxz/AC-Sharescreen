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
    std::atomic<uint64_t> totalProcessingTimeUs{0};

    // Phase 6: Native timing breakdown (microseconds, process-local)
    // These are per-frame accumulators set on each RecordFrameDetails call.
    std::atomic<uint64_t> lastInputReceiveUs{0};
    std::atomic<uint64_t> lastUploadUs{0};
    std::atomic<uint64_t> lastEffectUs{0};
    std::atomic<uint64_t> lastDownloadUs{0};
    std::atomic<uint64_t> lastOutputWriteUs{0};

    // Phase 7: Benchmark support
    std::atomic<bool> benchmarkActive{false};
    std::atomic<uint64_t> benchmarkTargetFrames{0};
    std::atomic<uint64_t> benchmarkFramesCompleted{0};
    std::atomic<uint64_t> benchmarkTotalTimeUs{0};

    // GPU lifecycle tracking
    std::atomic<uint32_t> effectLoadCount{0};

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
    uint64_t avgProcessingTimeUs{0};
    double currentFps{0.0};
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

    /// Number of times the NVIDIA VFX effect has been loaded/reloaded.
    uint32_t effectLoadCount{0};

    // Phase 7: Benchmark state
    bool benchmarkActive{false};
    uint64_t benchmarkTargetFrames{0};
    uint64_t benchmarkFramesCompleted{0};
    uint64_t benchmarkTotalTimeUs{0};

    // Native presenter diagnostics
    uint64_t presenterFramesPresented{0};
    uint64_t presenterFramesDropped{0};
    uint64_t presenterErrors{0};
    uint64_t presenterLastPresentUs{0};
    uint64_t presenterMaxPresentUs{0};
    uint64_t presenterAvgPresentUs{0};
    uint32_t presenterResizes{0};
    uint32_t presenterAttachCount{0};
    uint32_t presenterDetachCount{0};
    bool presenterActive{false};
};

/// Get a snapshot of current diagnostics.
DiagnosticSnapshot GetDiagnostics();

/// Get the global diagnostics counters instance.
DiagnosticsCounters& GetDiagnosticsCounters();

/// Reset all diagnostic counters to their initial state.
void ResetDiagnostics();

/// Store GPU info strings for inclusion in diagnostics snapshots.
/// Thread-safe: stores atomically via string copies.
void SetGpuInfo(const std::string& name, const std::string& driver, const std::string& sdk);

} // namespace screenlink::video
