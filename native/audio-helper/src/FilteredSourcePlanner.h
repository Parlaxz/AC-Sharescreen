#ifndef SCREENLINK_FILTERED_SOURCE_PLANNER_H
#define SCREENLINK_FILTERED_SOURCE_PLANNER_H

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "FilteredMonitorTypes.h"
#include "AudioSessionMonitor.h" // AudioSessionInfo
#include "ProcessResolver.h"     // ProcessTreeResult

namespace screenlink::audio {

/// Process-tree resolver function type — injected for deterministic testing.
using ResolveProcessTreeFn =
    std::function<ProcessTreeResult(uint32_t)>;

/// Deterministic, side-effect-free planner that transforms
/// AudioSessionInfo entries into a desired set of unique process-tree captures.
///
/// Thread safety: not thread-safe. Designed for single-threaded use.
class FilteredSourcePlanner {
public:
    /// @param resolver  Optional process-tree resolver (defaults to real
    ///                  ResolveProcessTree). Tests supply a fake.
    explicit FilteredSourcePlanner(
        ResolveProcessTreeFn resolver = ResolveProcessTree);

    /// Plan which sources should be captured given the session inventory.
    /// @param sessions  Full session enumeration from AudioSessionMonitor
    /// @param options   Controller options (exclusions, etc.)
    /// @return A FilteredSourcePlan with desired sources and diagnostics counts.
    FilteredSourcePlan Plan(
        const std::vector<AudioSessionInfo>& sessions,
        const FilteredMonitorOptions& options) const;

private:
    bool IsDiscordSession(const AudioSessionInfo& session) const;
    bool IsScreenLinkSession(const AudioSessionInfo& session,
                              const FilteredMonitorOptions& options) const;

    ResolveProcessTreeFn resolveProcessTree_;
};

} // namespace screenlink::audio

#endif // SCREENLINK_FILTERED_SOURCE_PLANNER_H
