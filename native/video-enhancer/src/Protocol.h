#pragma once
#include <cstdint>
#include <string>
#include <string_view>

namespace screenlink::video {

/// Current protocol version for capability reporting.
/// Bump this when adding, removing, or changing fields in the
/// capability response. Breaking changes = major bump.
inline constexpr std::string_view kProtocolVersion = "0.1.0";

/// Supported JSON-over-named-pipe commands
enum class Command : int {
    kUnknown = 0,
    kHello,
    kCapabilities,
    kConfigure,
    kStart,
    kStop,
    kFlush,
    kFrameAvailable,
    kFrameComplete,
    kStats,
    kPing,
    kShutdown,

    // Diagnostics / benchmark commands (Phase 7)
    kGetDiagnostics,
    kResetDiagnostics,
    kBenchmarkRun,
    kBenchmarkStatus,
    kBenchmarkCancel,
    kBenchmarkGetResults,

    // Shared memory ring coordination (Slice 4: async submission + completion event)
    kSlotSubmit,        // main -> helper: "slot N has input data ready" (async, no await)
    kSlotCompleted,     // helper -> main: "slot N output is ready" (sent as event)
    kSlotCompletedEvent,// helper -> main: async completion event (sent as unsolicited event)
    kSharedMemoryReady, // helper caps field: "shm is available at path"

    // Native presenter commands (GPU-resident display path)
    kPresenterAttach,
    kPresenterDetach,
    kPresenterUpdateBounds,
    kPresenterSetVisible,
    kPresenterGetDiagnostics,
};

/// Command exit codes
enum class ExitCode : int {
    kSuccess = 0,
    kUnknownCommand = 1,
    kInternalError = 2,
    kServeFailed = 40,
    kCapabilityDetectionFailed = 10,
    kConfigurationFailed = 20,
};

/// Parse a command name string into a Command enum.
Command ParseCommand(std::string_view name);

/// Convert a Command enum to its string representation.
std::string_view CommandName(Command cmd);

// ─── Benchmark config & result types ────────────────────────────────────

/// Configuration for a native benchmark run.
/// Mirrored on the TS side as NativeBenchmarkConfig.
struct BenchmarkConfig {
    std::string processingMode{"vsr"};
    std::string qualityLevel{"high"};
    uint32_t inputWidth{1920};
    uint32_t inputHeight{1080};
    uint32_t targetFrames{100};
    uint32_t frameTimeoutMs{5000};
};

/// Aggregated result of a completed benchmark run.
/// Mirrored on the TS side as NativeBenchmarkResult.
struct BenchmarkResult {
    bool success{false};
    std::string error;

    uint64_t framesProcessed{0};
    uint64_t framesDropped{0};
    uint64_t framesFailed{0};

    uint64_t totalTimeUs{0};
    uint64_t avgTimeUs{0};
    uint64_t minTimeUs{0};
    uint64_t maxTimeUs{0};

    // Per-stage averages (microseconds)
    uint64_t avgInputReceiveUs{0};
    uint64_t avgUploadUs{0};
    uint64_t avgEffectUs{0};
    uint64_t avgDownloadUs{0};
    uint64_t avgOutputWriteUs{0};

    double avgFps{0.0};
};

/// Build a BenchmarkResult from the current diagnostics counters.
/// Called when a benchmark run completes to snapshot results.
BenchmarkResult SnapshotBenchmarkResult();

} // namespace screenlink::video
