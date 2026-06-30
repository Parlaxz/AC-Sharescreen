#pragma once
#include <cstdint>
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

    // Shared memory ring coordination (Phase 9+)
    kProcessSlot,       // main -> helper: "slot N has input data ready"
    kSlotComplete,      // helper -> main: "slot N output is ready"
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

} // namespace screenlink::video
