#ifndef SCREENLINK_FILTERED_MONITOR_CONTROLLER_H
#define SCREENLINK_FILTERED_MONITOR_CONTROLLER_H

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "FilteredMonitorTypes.h"
#include "AudioSessionMonitor.h"
#include "MultiSourceMixer.h"
#include "ApplicationCaptureSource.h"
#include "LoopbackCapture.h"

namespace screenlink::audio {

/// Struct describing the startup outcome of FilteredMonitorController::Start.
struct FilteredStartOutcome {
    bool success = false;
    std::string errorCode;
    std::string failureReason;
    uint32_t initialActiveSources = 0;
};

/// Active capture entry managed by the controller.
struct ActiveCapture {
    FilteredSourceCandidate candidate;
    uint32_t mixerSourceId = 0;
    std::unique_ptr<ApplicationCaptureSource> source;

    std::chrono::steady_clock::time_point lastSeenAt;
    std::chrono::steady_clock::time_point nextRetryAt;

    uint32_t consecutiveStartFailures = 0;
};

/// Owns the complete lifecycle of filtered monitor mode.
///
/// One AudioSessionMonitor.
/// One MultiSourceMixer.
/// One controller/reconciliation thread.
/// One map of active process identities to ActiveCapture records.
///
/// Thread safety:
///   - Start/Stop: call from a single thread, not concurrently
///   - GetDiagnostics: thread-safe (never holds activeCapturesMutex_ while diagMutex_ is held)
///   - Internal controller thread does all reconciliation work
class FilteredMonitorController {
public:
    using OutputCallback = std::function<bool(const AudioPacket&)>;

    FilteredMonitorController();
    ~FilteredMonitorController();

    /// Start the filtered monitor.
    /// Blocks until initial enumeration completes or times out.
    FilteredStartOutcome Start(
        const FilteredMonitorOptions& options,
        OutputCallback outputCallback);

    /// Stop the controller and all captures. Idempotent.
    void Stop();

    bool IsRunning() const noexcept;

    /// Get thread-safe diagnostics snapshot.
    FilteredMonitorDiagnostics GetDiagnostics() const;

private:
    void ControllerThreadMain();
    bool InitializeMonitorOnControllerThread();
    bool ReconcileOnce();
    void WakeReconciliation();
    bool AddSource(const FilteredSourceCandidate& candidate);
    void RemoveSource(const ProcessIdentity& identity);
    void StopAllSourcesOnControllerThread();

    // Diagnostics helpers
    void RecordFilteredInputPacket(const AudioPacket& packet);
    void RecordFilteredMixerOutput(const AudioPacket& packet);

    /// Wake generation counter: notifications increment this so the
    /// controller-thread wait_until predicate can detect a wake request.
    std::atomic<uint64_t> wakeGeneration_{0};

    // State
    FilteredMonitorOptions options_;
    OutputCallback outputCallback_;

    std::unique_ptr<AudioSessionMonitor> sessionMonitor_;
    std::unique_ptr<MultiSourceMixer> mixer_;

    std::thread controllerThread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stopping_{false};
    std::atomic<bool> startupComplete_{false};
    std::mutex startupMutex_;
    std::condition_variable startupCv_;
    FilteredStartOutcome startupOutcome_;

    mutable std::mutex activeCapturesMutex_;
    // keyed by ProcessIdentity
    std::unordered_map<ProcessIdentity, ActiveCapture, ProcessIdentityHash> activeCaptures_;

    // Wake mechanism
    std::mutex wakeMutex_;
    std::condition_variable wakeCv_;

    // Diagnostics (protected by diagMutex_)
    mutable std::mutex diagMutex_;
    FilteredMonitorDiagnostics diag_;
};

} // namespace screenlink::audio

#endif // SCREENLINK_FILTERED_MONITOR_CONTROLLER_H
