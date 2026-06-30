#include "Diagnostics.h"
#include "NativePresenter.h"
#include <algorithm>
#include <chrono>
#include <mutex>
#include <string>

namespace screenlink::video {

static DiagnosticsCounters g_counters{};

// Start time for uptime calculation (set once at module init)
static const std::chrono::steady_clock::time_point g_startTime =
    std::chrono::steady_clock::now();

// GPU info storage (thread-safe via mutex)
static std::mutex g_gpuInfoMutex;
static std::string g_gpuName;
static std::string g_driverVersion;
static std::string g_sdkVersion;

// FPS tracking: sliding window over last N frames
namespace {
    constexpr size_t kFpsWindowSize = 60;
    struct FpsTracker {
        std::mutex mtx;
        uint64_t timestampsUs[kFpsWindowSize]{0};
        size_t count{0};
        size_t head{0};
    };
    FpsTracker g_fpsTracker;
}

void DiagnosticsCounters::RecordFrame(uint64_t elapsedUs, bool success) {
    totalFramesSubmitted++;
    if (success) totalFramesCompleted++;
    else totalProcessingErrors++;

    lastProcessingTimeUs = elapsedUs;
    maxProcessingTimeUs = std::max(maxProcessingTimeUs.load(), elapsedUs);
    minProcessingTimeUs = std::min(minProcessingTimeUs.load(), elapsedUs);
    totalProcessingTimeUs.fetch_add(elapsedUs);
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
    totalProcessingTimeUs.fetch_add(elapsedUs);

    lastInputReceiveUs = inputReceiveUs;
    lastUploadUs = uploadUs;
    lastEffectUs = effectUs;
    lastDownloadUs = downloadUs;
    lastOutputWriteUs = outputWriteUs;

    if (benchmarkActive.load()) {
        benchmarkTotalInputReceiveUs.fetch_add(inputReceiveUs);
        benchmarkTotalUploadUs.fetch_add(uploadUs);
        benchmarkTotalEffectUs.fetch_add(effectUs);
        benchmarkTotalDownloadUs.fetch_add(downloadUs);
        benchmarkTotalOutputWriteUs.fetch_add(outputWriteUs);
    }

    // Track completed frame timestamps for FPS computation
    if (success) {
        auto now = std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
        std::lock_guard<std::mutex> lock(g_fpsTracker.mtx);
        g_fpsTracker.timestampsUs[g_fpsTracker.head] = static_cast<uint64_t>(now);
        g_fpsTracker.head = (g_fpsTracker.head + 1) % kFpsWindowSize;
        if (g_fpsTracker.count < kFpsWindowSize) {
            g_fpsTracker.count++;
        }
    }
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
    totalProcessingTimeUs = 0;
    lastInputReceiveUs = 0;
    lastUploadUs = 0;
    lastEffectUs = 0;
    lastDownloadUs = 0;
    lastOutputWriteUs = 0;
    // Slice 6: Persistent resource allocation counters
    configAllocations = 0;
    steadyStateAllocations = 0;
    pinnedBytes = 0;
    stagingReuseCount = 0;
    inputSlotReuseCount = 0;
    outputFallbackSlotReuseCount = 0;
    cpuDownloadCount = 0;
    contextCount = 0;

    benchmarkActive = false;
    benchmarkTargetFrames = 0;
    benchmarkFramesCompleted = 0;
    benchmarkTotalTimeUs = 0;
    benchmarkTotalInputReceiveUs = 0;
    benchmarkTotalUploadUs = 0;
    benchmarkTotalEffectUs = 0;
    benchmarkTotalDownloadUs = 0;
    benchmarkTotalOutputWriteUs = 0;
    effectLoadCount = 0;

    // Reset FPS tracker
    {
        std::lock_guard<std::mutex> lock(g_fpsTracker.mtx);
        g_fpsTracker.count = 0;
        g_fpsTracker.head = 0;
    }
}

DiagnosticsCounters& GetDiagnosticsCounters() {
    return g_counters;
}

void ResetDiagnostics() {
    g_counters.Reset();
}

void SetGpuInfo(const std::string& name, const std::string& driver, const std::string& sdk) {
    std::lock_guard<std::mutex> lock(g_gpuInfoMutex);
    g_gpuName = name;
    g_driverVersion = driver;
    g_sdkVersion = sdk;
}

static double ComputeFps() {
    std::lock_guard<std::mutex> lock(g_fpsTracker.mtx);
    if (g_fpsTracker.count < 2) return 0.0;

    // Find oldest timestamp in the window
    size_t oldestIdx = (g_fpsTracker.head + kFpsWindowSize - g_fpsTracker.count) % kFpsWindowSize;
    uint64_t oldest = g_fpsTracker.timestampsUs[oldestIdx];
    uint64_t newest = g_fpsTracker.timestampsUs[(g_fpsTracker.head + kFpsWindowSize - 1) % kFpsWindowSize];

    uint64_t spanUs = newest - oldest;
    if (spanUs == 0) return 0.0;

    return static_cast<double>(g_fpsTracker.count - 1) * 1000000.0 / static_cast<double>(spanUs);
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

    // Average processing time (over completed frames only)
    uint64_t completed = g_counters.totalFramesCompleted.load();
    uint64_t totalTime = g_counters.totalProcessingTimeUs.load();
    snap.avgProcessingTimeUs = (completed > 0) ? (totalTime / completed) : 0;

    // Uptime
    auto now = std::chrono::steady_clock::now();
    snap.uptimeMs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(now - g_startTime).count());

    // Current FPS from sliding window
    snap.currentFps = ComputeFps();

    // GPU info
    {
        std::lock_guard<std::mutex> lock(g_gpuInfoMutex);
        snap.gpuName = g_gpuName;
        snap.driverVersion = g_driverVersion;
        snap.sdkVersion = g_sdkVersion;
    }

    // Phase 6: Native timing breakdown
    snap.lastInputReceiveUs = g_counters.lastInputReceiveUs;
    snap.lastUploadUs = g_counters.lastUploadUs;
    snap.lastEffectUs = g_counters.lastEffectUs;
    snap.lastDownloadUs = g_counters.lastDownloadUs;
    snap.lastOutputWriteUs = g_counters.lastOutputWriteUs;

    // GPU lifecycle tracking
    snap.effectLoadCount = g_counters.effectLoadCount.load();

    // Slice 6: Persistent resource allocation counters
    snap.configAllocations = g_counters.configAllocations.load();
    snap.steadyStateAllocations = g_counters.steadyStateAllocations.load();
    snap.pinnedBytes = g_counters.pinnedBytes.load();
    snap.stagingReuseCount = g_counters.stagingReuseCount.load();
    snap.inputSlotReuseCount = g_counters.inputSlotReuseCount.load();
    snap.outputFallbackSlotReuseCount = g_counters.outputFallbackSlotReuseCount.load();
    snap.cpuDownloadCount = g_counters.cpuDownloadCount.load();
    snap.contextCount = g_counters.contextCount.load();

    // Phase 7: Benchmark state
    snap.benchmarkActive = g_counters.benchmarkActive.load();
    snap.benchmarkTargetFrames = g_counters.benchmarkTargetFrames.load();
    snap.benchmarkFramesCompleted = g_counters.benchmarkFramesCompleted.load();
    snap.benchmarkTotalTimeUs = g_counters.benchmarkTotalTimeUs.load();

    // Native presenter diagnostics (atomic reads, no copy of atomic struct)
    auto& presenterDiag = GetPresenterDiagnostics();
    snap.presenterFramesPresented = presenterDiag.framesPresented.load();
    snap.presenterFramesDropped = presenterDiag.framesDropped.load();
    snap.presenterErrors = presenterDiag.presentErrors.load();
    snap.presenterLastPresentUs = presenterDiag.lastPresentUs.load();
    snap.presenterMaxPresentUs = presenterDiag.maxPresentUs.load();
    uint64_t totalP = presenterDiag.totalPresentUs.load();
    uint64_t countP = presenterDiag.framesPresented.load();
    snap.presenterAvgPresentUs = countP > 0 ? totalP / countP : 0;
    snap.presenterResizes = presenterDiag.presenterResizes.load();
    snap.presenterAttachCount = presenterDiag.presenterAttachCount.load();
    snap.presenterDetachCount = presenterDiag.presenterDetachCount.load();

    // Slice 3: Presenter queue diagnostics
    snap.presenterQueueEnqueued = presenterDiag.queueEnqueued.load();
    snap.presenterQueueDequeued = presenterDiag.queueDequeued.load();
    snap.presenterQueueOverflowDrops = presenterDiag.queueOverflowDrops.load();
    snap.presenterStaleGenerationDrops = presenterDiag.staleGenerationDrops.load();
    snap.presenterQueueDepth = presenterDiag.queueDepth.load();
    snap.presenterQueueMaxDepth = presenterDiag.queueMaxDepth.load();

    // active is not tracked at the global diagnostics level; the per-instance
    // NativePresenter tracks its own active state via the instance snapshot.

    return snap;
}

} // namespace screenlink::video
