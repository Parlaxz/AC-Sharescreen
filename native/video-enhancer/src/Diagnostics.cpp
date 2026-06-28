#include "Diagnostics.h"
#include <algorithm>

namespace screenlink::video {

static DiagnosticsCounters g_counters{};

void DiagnosticsCounters::RecordFrame(uint64_t elapsedUs, bool success) {
    totalFramesSubmitted++;
    if (success) totalFramesCompleted++;
    else totalProcessingErrors++;

    lastProcessingTimeUs = elapsedUs;
    maxProcessingTimeUs = std::max(maxProcessingTimeUs.load(), elapsedUs);
    minProcessingTimeUs = std::min(minProcessingTimeUs.load(), elapsedUs);
}

void DiagnosticsCounters::Reset() {
    totalFramesSubmitted = 0;
    totalFramesCompleted = 0;
    totalFramesDropped = 0;
    totalProcessingErrors = 0;
    totalBytesProcessed = 0;
    lastProcessingTimeUs = 0;
    maxProcessingTimeUs = 0;
    minProcessingTimeUs = UINT64_MAX;
}

DiagnosticSnapshot GetDiagnostics() {
    DiagnosticSnapshot snap;
    snap.totalFramesSubmitted = g_counters.totalFramesSubmitted;
    snap.totalFramesCompleted = g_counters.totalFramesCompleted;
    snap.totalFramesDropped = g_counters.totalFramesDropped;
    snap.totalProcessingErrors = g_counters.totalProcessingErrors;
    snap.totalBytesProcessed = g_counters.totalBytesProcessed;
    snap.lastProcessingTimeUs = g_counters.lastProcessingTimeUs;
    snap.maxProcessingTimeUs = g_counters.maxProcessingTimeUs;
    snap.minProcessingTimeUs = g_counters.minProcessingTimeUs;
    snap.uptimeMs = 0; // Phase 7: track uptime
    return snap;
}

} // namespace screenlink::video
