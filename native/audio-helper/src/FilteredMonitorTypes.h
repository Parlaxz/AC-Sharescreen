#ifndef SCREENLINK_FILTERED_MONITOR_TYPES_H
#define SCREENLINK_FILTERED_MONITOR_TYPES_H

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "LoopbackCapture.h" // AudioPacket

namespace screenlink::audio {

/// Stable process identity: PID + creation time.
/// PID alone is insufficient because Windows reuses PIDs.
struct ProcessIdentity {
    uint32_t pid = 0;
    uint64_t creationTimeUtc100ns = 0;

    bool IsValid() const noexcept {
        return pid != 0 && creationTimeUtc100ns != 0;
    }

    bool operator==(const ProcessIdentity& other) const noexcept {
        return pid == other.pid &&
               creationTimeUtc100ns == other.creationTimeUtc100ns;
    }

    bool operator!=(const ProcessIdentity& other) const noexcept {
        return !(*this == other);
    }
};

struct ProcessIdentityHash {
    std::size_t operator()(const ProcessIdentity& value) const noexcept {
        const std::size_t a = std::hash<uint32_t>{}(value.pid);
        const std::size_t b =
            std::hash<uint64_t>{}(value.creationTimeUtc100ns);
        return a ^ (b + 0x9e3779b97f4a7c15ULL + (a << 6) + (a >> 2));
    }
};

/// Options for the filtered monitor controller.
struct FilteredMonitorOptions {
    bool excludeDiscord = true;
    bool excludeScreenLink = true;
    uint32_t screenLinkPid = 0;

    std::chrono::milliseconds reconcileInterval{1000};
    std::chrono::milliseconds removalGracePeriod{2000};
    std::chrono::milliseconds initialStartupTimeout{5000};
};

/// A candidate for inclusion in the filtered monitor's capture set.
struct FilteredSourceCandidate {
    ProcessIdentity identity;
    uint32_t sessionPid = 0;
    std::string executableName;
    std::string executablePath;
    std::string rootExecutableName;
    std::string rootExecutablePath;
    bool activeSession = false;
};

/// Deterministic plan produced by FilteredSourcePlanner.
struct FilteredSourcePlan {
    std::vector<FilteredSourceCandidate> desiredSources;

    uint32_t totalSessions = 0;
    uint32_t activeSessions = 0;
    uint32_t inactiveSessions = 0;
    uint32_t invalidSessions = 0;
    uint32_t expiredSessions = 0;
    uint32_t systemSoundsSkipped = 0;
    uint32_t discordExcluded = 0;
    uint32_t screenLinkExcluded = 0;
    uint32_t duplicateRoots = 0;
    uint32_t sourceLimitSkipped = 0;
};

/// Thread-safe diagnostics snapshot for FilteredMonitorController.
struct FilteredMonitorDiagnostics {
    bool running = false;
    bool monitorInitialized = false;
    bool mixerRunning = false;
    uint64_t totalReconciliations = 0;
    uint64_t notificationWakeups = 0;
    uint64_t periodicWakeups = 0;
    uint64_t enumerationFailures = 0;
    uint64_t monitorReinitializations = 0;
    uint32_t totalSessionsLastScan = 0;
    uint32_t activeSessionsLastScan = 0;
    uint32_t inactiveSessionsLastScan = 0;
    uint32_t desiredSourcesLastScan = 0;
    uint32_t activeCaptureSources = 0;
    uint64_t sourcesAdded = 0;
    uint64_t sourcesRemoved = 0;
    uint64_t sourceStartAttempts = 0;
    uint64_t sourceStartFailures = 0;
    uint64_t sourceUnexpectedStops = 0;
    uint64_t sourceRetries = 0;
    uint32_t invalidSessionsLastScan = 0;
    uint32_t expiredSessionsLastScan = 0;
    uint32_t systemSoundsSkippedLastScan = 0;
    uint32_t discordExcludedLastScan = 0;
    uint32_t screenLinkExcludedLastScan = 0;
    uint32_t duplicateRootsLastScan = 0;
    uint32_t sourceLimitSkippedLastScan = 0;
    uint64_t mixerInputPackets = 0;
    uint64_t mixerOutputPackets = 0;
    uint64_t mixerNonZeroOutputPackets = 0;
    uint64_t lastReconcileDurationMs = 0;
    uint64_t lastSuccessfulInventoryTimestamp = 0;
    std::string lastErrorCode;
    std::string lastErrorMessage;
};

} // namespace screenlink::audio

#endif // SCREENLINK_FILTERED_MONITOR_TYPES_H
