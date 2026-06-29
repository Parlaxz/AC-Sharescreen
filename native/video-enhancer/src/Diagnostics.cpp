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

void DiagnosticsCounters::RecordFrameDetails(
    uint64_t elapsedUs, bool success,
    uint64_t inputReceiveUs,
    uint64_t uploadUs,
    uint64_t effectUs,
    uint64_t downloadUs,
    uint64_t outputWriteUs)
{
    totalFramesSubmitted++;
    if (success) totalFramesCompleted++;
    else totalProcessingErrors++;

    lastProcessingTimeUs = elapsedUs;
    maxProcessingTimeUs = std::max(maxProcessingTimeUs.load(), elapsedUs);
    minProcessingTimeUs = std::min(minProcessingTimeUs.load(), elapsedUs);

    lastInputReceiveUs = inputReceiveUs;
    lastUploadUs = uploadUs;
    lastEffectUs = effectUs;
    lastDownloadUs = downloadUs;
    lastOutputWriteUs = outputWriteUs;
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
    lastInputReceiveUs = 0;
    lastUploadUs = 0;
    lastEffectUs = 0;
    lastDownloadUs = 0;
    lastOutputWriteUs = 0;
}

DiagnosticsCounters& GetDiagnosticsCounters() {
    return g_counters;
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

    // Phase 6: Native timing breakdown
    snap.lastInputReceiveUs = g_counters.lastInputReceiveUs;
    snap.lastUploadUs = g_counters.lastUploadUs;
    snap.lastEffectUs = g_counters.lastEffectUs;
    snap.lastDownloadUs = g_counters.lastDownloadUs;
    snap.lastOutputWriteUs = g_counters.lastOutputWriteUs;

    return snap;
}

} // namespace screenlink::video
