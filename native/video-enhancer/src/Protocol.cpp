#include "Protocol.h"
#include "Diagnostics.h"
#include <unordered_map>
#include <cstring>

namespace screenlink::video {

static const std::unordered_map<std::string_view, Command> kCommandMap = {
    {"hello", Command::kHello},
    {"capabilities", Command::kCapabilities},
    {"configure", Command::kConfigure},
    {"start", Command::kStart},
    {"stop", Command::kStop},
    {"flush", Command::kFlush},
    {"frameAvailable", Command::kFrameAvailable},
    {"frameComplete", Command::kFrameComplete},
    {"stats", Command::kStats},
    {"ping", Command::kPing},
    {"shutdown", Command::kShutdown},
    {"getDiagnostics", Command::kGetDiagnostics},
    {"resetDiagnostics", Command::kResetDiagnostics},
    {"benchmarkRun", Command::kBenchmarkRun},
    {"benchmarkStatus", Command::kBenchmarkStatus},
    {"benchmarkCancel", Command::kBenchmarkCancel},
    {"benchmarkGetResults", Command::kBenchmarkGetResults},
    {"presenterAttach", Command::kPresenterAttach},
    {"presenterDetach", Command::kPresenterDetach},
    {"presenterUpdateBounds", Command::kPresenterUpdateBounds},
    {"presenterSetVisible", Command::kPresenterSetVisible},
    {"presenterGetDiagnostics", Command::kPresenterGetDiagnostics},
    {"slotSubmit", Command::kSlotSubmit},
    {"slotCompleted", Command::kSlotCompleted},
    {"slotCompletedEvent", Command::kSlotCompletedEvent},
    {"sharedMemoryReady", Command::kSharedMemoryReady},
};

Command ParseCommand(std::string_view name) {
    auto it = kCommandMap.find(name);
    return it != kCommandMap.end() ? it->second : Command::kUnknown;
}

std::string_view CommandName(Command cmd) {
    switch (cmd) {
        case Command::kHello: return "hello";
        case Command::kCapabilities: return "capabilities";
        case Command::kConfigure: return "configure";
        case Command::kStart: return "start";
        case Command::kStop: return "stop";
        case Command::kFlush: return "flush";
        case Command::kFrameAvailable: return "frameAvailable";
        case Command::kFrameComplete: return "frameComplete";
        case Command::kStats: return "stats";
        case Command::kPing: return "ping";
        case Command::kShutdown: return "shutdown";
        case Command::kGetDiagnostics: return "getDiagnostics";
        case Command::kResetDiagnostics: return "resetDiagnostics";
        case Command::kBenchmarkRun: return "benchmarkRun";
        case Command::kBenchmarkStatus: return "benchmarkStatus";
        case Command::kBenchmarkCancel: return "benchmarkCancel";
        case Command::kBenchmarkGetResults: return "benchmarkGetResults";
        case Command::kPresenterAttach: return "presenterAttach";
        case Command::kPresenterDetach: return "presenterDetach";
        case Command::kPresenterUpdateBounds: return "presenterUpdateBounds";
        case Command::kPresenterSetVisible: return "presenterSetVisible";
        case Command::kPresenterGetDiagnostics: return "presenterGetDiagnostics";
        case Command::kSlotSubmit: return "slotSubmit";
        case Command::kSlotCompleted: return "slotCompleted";
        case Command::kSlotCompletedEvent: return "slotCompletedEvent";
        case Command::kSharedMemoryReady: return "sharedMemoryReady";
        default: return "unknown";
    }
}

BenchmarkResult SnapshotBenchmarkResult() {
    auto diag = GetDiagnostics();
    auto& counters = GetDiagnosticsCounters();
    BenchmarkResult result;
    result.success = !diag.benchmarkActive && diag.benchmarkFramesCompleted > 0;
    result.framesProcessed = diag.benchmarkFramesCompleted;
    result.totalTimeUs = diag.benchmarkTotalTimeUs;
    result.minTimeUs = diag.minProcessingTimeUs;
    result.maxTimeUs = diag.maxProcessingTimeUs;
    if (diag.benchmarkFramesCompleted > 0) {
        result.avgTimeUs = diag.benchmarkTotalTimeUs / diag.benchmarkFramesCompleted;
        result.avgFps = static_cast<double>(diag.benchmarkFramesCompleted) * 1000000.0
            / static_cast<double>(diag.benchmarkTotalTimeUs > 0 ? diag.benchmarkTotalTimeUs : 1);
    }
    if (diag.benchmarkFramesCompleted > 0) {
        result.avgInputReceiveUs = counters.benchmarkTotalInputReceiveUs.load() / diag.benchmarkFramesCompleted;
        result.avgUploadUs = counters.benchmarkTotalUploadUs.load() / diag.benchmarkFramesCompleted;
        result.avgEffectUs = counters.benchmarkTotalEffectUs.load() / diag.benchmarkFramesCompleted;
        result.avgDownloadUs = counters.benchmarkTotalDownloadUs.load() / diag.benchmarkFramesCompleted;
        result.avgOutputWriteUs = counters.benchmarkTotalOutputWriteUs.load() / diag.benchmarkFramesCompleted;
    }

    // Count dropped/errored frames: for benchmark, any frame that didn't
    // complete successfully is counted as a failure
    result.framesDropped = diag.totalFramesDropped;
    result.framesFailed = diag.totalProcessingErrors;

    return result;
}

} // namespace screenlink::video
