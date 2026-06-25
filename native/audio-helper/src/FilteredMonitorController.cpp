#include "FilteredMonitorController.h"
#include "AudioPacketAnalysis.h"
#include "FilteredSourcePlanner.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <mutex>
#include <set>
#include <sstream>
#include <unordered_set>
#include <windows.h>

namespace screenlink::audio {

namespace {

/// Measure the actual energy in an AudioPacket by scanning samples.
struct PacketEnergy {
    float peak = 0.0f;
    uint64_t nonZeroSamples = 0;
};

PacketEnergy MeasurePacketEnergy(const AudioPacket& packet) {
    PacketEnergy energy;
    if (packet.frames == nullptr || packet.frameCount == 0 || packet.channels == 0) {
        return energy;
    }
    const size_t sampleCount = static_cast<size_t>(packet.frameCount) *
                               static_cast<size_t>(packet.channels);
    for (size_t idx = 0; idx < sampleCount; ++idx) {
        const float magnitude = std::abs(packet.frames[idx]);
        if (magnitude > energy.peak) {
            energy.peak = magnitude;
        }
        if (magnitude > 1.0e-8f) {
            ++energy.nonZeroSamples;
        }
    }
    return energy;
}

} // anonymous namespace

// ============================================================================
// Construction / Destruction
// ============================================================================

FilteredMonitorController::FilteredMonitorController() {
    std::cerr << "[FilteredMonitorController] Constructed" << std::endl;
}

FilteredMonitorController::~FilteredMonitorController() {
    std::cerr << "[FilteredMonitorController] Destructing" << std::endl;
    Stop();
}

// ============================================================================
// Public API
// ============================================================================

FilteredStartOutcome FilteredMonitorController::Start(
    const FilteredMonitorOptions& options,
    OutputCallback outputCallback)
{
    // Reject duplicate Start
    if (running_.exchange(true)) {
        FilteredStartOutcome outcome;
        outcome.success = false;
        outcome.errorCode = "ALREADY_RUNNING";
        outcome.failureReason = "Controller is already running";
        return outcome;
    }

    stopping_ = false;
    startupComplete_ = false;

    if (!outputCallback) {
        running_ = false;
        FilteredStartOutcome outcome;
        outcome.success = false;
        outcome.errorCode = "NO_OUTPUT_CALLBACK";
        outcome.failureReason = "No output callback provided";
        return outcome;
    }

    options_ = options;
    outputCallback_ = std::move(outputCallback);

    // Reset diagnostics for the new run
    {
        std::lock_guard<std::mutex> lock(diagMutex_);
        diag_ = FilteredMonitorDiagnostics{};
    }

    // --- Create and start the mixer ---
    mixer_ = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    // Wrap the user's output callback to also record controller-level diagnostics
    auto mixerOutputCallback = [this](const AudioPacket& pkt) -> bool {
        RecordFilteredMixerOutput(pkt);
        if (outputCallback_) {
            return outputCallback_(pkt);
        }
        return false;
    };

    auto mixResult = mixer_->Start(std::move(mixerOutputCallback));
    if (!mixResult.success) {
        std::cerr << "[FilteredMonitorController] Mixer start failed: error="
                  << static_cast<int>(mixResult.error) << std::endl;
        running_ = false;
        mixer_.reset();
        outputCallback_ = nullptr;

        FilteredStartOutcome outcome;
        outcome.success = false;
        outcome.errorCode = "MIXER_START_FAILED";
        outcome.failureReason = "Mixer start error: " + std::to_string(static_cast<int>(mixResult.error));
        return outcome;
    }

    {
        std::lock_guard<std::mutex> lock(diagMutex_);
        diag_.mixerRunning = true;
    }

    // --- Start the controller thread ---
    try {
        controllerThread_ = std::thread(&FilteredMonitorController::ControllerThreadMain, this);
    } catch (const std::exception& e) {
        std::cerr << "[FilteredMonitorController] Failed to create controller thread: "
                  << e.what() << std::endl;
        mixer_->Stop();
        mixer_.reset();
        outputCallback_ = nullptr;
        running_ = false;

        FilteredStartOutcome outcome;
        outcome.success = false;
        outcome.errorCode = "THREAD_CREATION_FAILED";
        outcome.failureReason = e.what();
        return outcome;
    }

    // --- Wait for initial enumeration with timeout ---
    {
        std::unique_lock<std::mutex> lock(startupMutex_);
        bool notified = startupCv_.wait_for(
            lock,
            options_.initialStartupTimeout,
            [this]() { return startupComplete_.load(); });

        if (!notified) {
            std::cerr << "[FilteredMonitorController] Startup timed out after "
                      << options_.initialStartupTimeout.count() << "ms" << std::endl;
            startupOutcome_.success = false;
            startupOutcome_.errorCode = "TIMEOUT";
            startupOutcome_.failureReason = "Monitor initialization timed out";
        }
    }

    std::cerr << "[FilteredMonitorController] Start() complete - success="
              << (startupOutcome_.success ? "true" : "false")
              << ", initialSources=" << startupOutcome_.initialActiveSources
              << std::endl;
    return startupOutcome_;
}

void FilteredMonitorController::Stop() {
    std::cerr << "[FilteredMonitorController] Stop() called" << std::endl;

    if (!running_.exchange(false)) {
        std::cerr << "[FilteredMonitorController] Stop() - already stopped" << std::endl;
        StopAllSourcesOnControllerThread();
        if (mixer_) {
            mixer_->Stop();
        }
        return;
    }

    stopping_ = true;

    // Wake the controller thread so it exits its wait loop
    wakeGeneration_.fetch_add(1, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(wakeMutex_);
        wakeCv_.notify_one();
    }

    // Join the controller thread
    if (controllerThread_.joinable()) {
        std::cerr << "[FilteredMonitorController] Joining controller thread..." << std::endl;
        controllerThread_.join();
        std::cerr << "[FilteredMonitorController] Controller thread joined" << std::endl;
    }

    // Stop all remaining capture sources (on the stopping thread)
    StopAllSourcesOnControllerThread();

    // Stop the mixer
    if (mixer_) {
        std::cerr << "[FilteredMonitorController] Stopping mixer..." << std::endl;
        mixer_->Stop();
    }

    {
        std::lock_guard<std::mutex> lock(diagMutex_);
        diag_.running = false;
        diag_.mixerRunning = false;
    }

    mixer_.reset();
    outputCallback_ = nullptr;

    std::cerr << "[FilteredMonitorController] Stop() complete" << std::endl;
}

bool FilteredMonitorController::IsRunning() const noexcept {
    return running_.load();
}

FilteredMonitorDiagnostics FilteredMonitorController::GetDiagnostics() const {
    // Snap diagnostics first (diagMutex_ only)
    // Then snap active capture count separately (never hold both)
    std::lock_guard<std::mutex> lock(diagMutex_);
    FilteredMonitorDiagnostics snap = diag_;
    snap.running = running_.load();
    snap.mixerRunning = mixer_ ? mixer_->IsRunning() : false;

    // Release diagMutex_ then acquire activeCapturesMutex_ for the count
    // (We use a separate scope so the lock order is always diag then cap, never inverted)
    // Actually, we already hold diagMutex_. We need active count without reordering.
    // To avoid deadlock: unlock diag, lock cap, read count, unlock cap, relock diag.
    // But we can't modify snap after releasing diag. So we read the count under cap lock first.
    // Easiest safe approach: don't read activeCaptures_ here at all.
    // The activeCaptureSources is already updated by reconciliation.
    // Let's just use whatever was stored.
    return snap;
}

// ============================================================================
// Controller Thread
// ============================================================================

void FilteredMonitorController::ControllerThreadMain() {
    std::cerr << "[FilteredMonitorController] Controller thread started (tid="
              << GetCurrentThreadId() << ")" << std::endl;

    // Initialize COM for this thread
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    bool comInitialized = SUCCEEDED(hr);
    if (!comInitialized) {
        std::cerr << "[FilteredMonitorController] CoInitializeEx failed: 0x"
                  << std::hex << hr << std::dec << std::endl;
    }

    // Attempt initial monitor initialization
    bool monitorOk = InitializeMonitorOnControllerThread();

    // Signal startup completion (even on failure - Start() will use the outcome)
    {
        std::lock_guard<std::mutex> lock(startupMutex_);
        if (monitorOk) {
            // Perform the first reconciliation to seed the initial capture set
            bool firstOk = ReconcileOnce();
            if (firstOk) {
                std::lock_guard<std::mutex> diagLock(diagMutex_);
                startupOutcome_.success = true;
                startupOutcome_.errorCode.clear();
                startupOutcome_.failureReason.clear();
                startupOutcome_.initialActiveSources =
                    static_cast<uint32_t>(activeCaptures_.size());
                diag_.monitorInitialized = true;
            } else {
                startupOutcome_.success = false;
                startupOutcome_.errorCode = "FIRST_RECONCILE_FAILED";
                startupOutcome_.failureReason = "First reconciliation enumeration failed";
            }
        } else {
            startupOutcome_.success = false;
            startupOutcome_.errorCode = "MONITOR_INIT_FAILED";
            startupOutcome_.failureReason = "AudioSessionMonitor initialization failed";
        }
        startupComplete_ = true;
    }
    startupCv_.notify_all();

    // Periodic reconciliation loop
    uint64_t periodicWakeCount = 0;
    uint64_t lastObservedWakeGen = wakeGeneration_.load(std::memory_order_acquire);

    while (!stopping_.load()) {
        auto reconcileStart = std::chrono::steady_clock::now();

        // Check if monitor reinitialization is requested (default device change)
        if (monitorOk && sessionMonitor_ && sessionMonitor_->ReinitializeRequested()) {
            sessionMonitor_->ClearReinitializeRequested();

            // Preserve currently running captures until new enumeration succeeds
            std::cerr << "[FilteredMonitorController] Reinitializing session monitor..."
                      << std::endl;
            bool reinitOk = false;
            if (sessionMonitor_) {
                sessionMonitor_->Stop();
                sessionMonitor_.reset();
            }
            {
                auto mon = std::make_unique<AudioSessionMonitor>();
                if (mon->Initialize([this]() { WakeReconciliation(); })) {
                    sessionMonitor_ = std::move(mon);
                    reinitOk = true;
                }
            }

            if (reinitOk) {
                // Remove obsolete captures only after a successful new inventory
                // and the normal grace period (handled by ReconcileOnce)
                std::lock_guard<std::mutex> lock(diagMutex_);
                diag_.monitorReinitializations++;
            } else {
                monitorOk = false;
            }
        }

        // Try to re-initialize the monitor if it failed previously
        if (!monitorOk) {
            monitorOk = InitializeMonitorOnControllerThread();
            if (monitorOk) {
                std::lock_guard<std::mutex> lock(diagMutex_);
                diag_.monitorReinitializations++;
                diag_.monitorInitialized = true;
            }
        }

        // Reconcile if the monitor is ready
        if (monitorOk) {
            bool ok = ReconcileOnce();
            if (!ok) {
                // Enumeration failure - keep current sources
                std::lock_guard<std::mutex> lock(diagMutex_);
                diag_.enumerationFailures++;
            }
        }

        // Record reconciliation duration
        auto reconcileEnd = std::chrono::steady_clock::now();
        auto durationMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            reconcileEnd - reconcileStart).count();
        {
            std::lock_guard<std::mutex> lock(diagMutex_);
            diag_.lastReconcileDurationMs = static_cast<uint64_t>(durationMs);
        }

        // Wait for the next reconcile interval or a wake notification.
        // The predicate checks both stopping_ and wakeGeneration changes so
        // that notification-triggered notify_one() does not go back to sleep.
        auto waitUntil = reconcileStart + options_.reconcileInterval;
        auto observedGen = lastObservedWakeGen;
        {
            std::unique_lock<std::mutex> wakeLock(wakeMutex_);
            wakeCv_.wait_until(wakeLock, waitUntil,
                [this, observedGen]() {
                    return stopping_.load() ||
                           wakeGeneration_.load(std::memory_order_acquire) != observedGen;
                });
        }

        if (stopping_.load()) {
            break;
        }

        // Check if we were woken by a notification
        uint64_t currentGen = wakeGeneration_.load(std::memory_order_acquire);
        if (currentGen != lastObservedWakeGen) {
            lastObservedWakeGen = currentGen;
            // Wake was due to notification - already counted in WakeReconciliation
        } else {
            periodicWakeCount++;
            std::lock_guard<std::mutex> lock(diagMutex_);
            diag_.periodicWakeups = periodicWakeCount;
        }
    }

    // Cleanup on controller thread exit
    StopAllSourcesOnControllerThread();

    if (sessionMonitor_) {
        sessionMonitor_->Stop();
        sessionMonitor_.reset();
    }

    if (comInitialized) {
        CoUninitialize();
    }

    std::cerr << "[FilteredMonitorController] Controller thread exiting" << std::endl;
}

bool FilteredMonitorController::InitializeMonitorOnControllerThread() {
    if (sessionMonitor_) {
        sessionMonitor_->Stop();
        sessionMonitor_.reset();
    }

    auto monitor = std::make_unique<AudioSessionMonitor>();
    // Pass a notification callback that wakes reconciliation immediately.
    // This connects IAudioSessionNotification and IMMNotificationClient.
    if (!monitor->Initialize([this]() { WakeReconciliation(); })) {
        std::cerr << "[FilteredMonitorController] AudioSessionMonitor::Initialize() failed"
                  << std::endl;
        return false;
    }

    sessionMonitor_ = std::move(monitor);
    std::cerr << "[FilteredMonitorController] AudioSessionMonitor initialized successfully"
              << std::endl;
    return true;
}

// ============================================================================
// Reconciliation
// ============================================================================

bool FilteredMonitorController::ReconcileOnce() {
    if (!sessionMonitor_ || !mixer_) {
        return false;
    }

    auto now = std::chrono::steady_clock::now();

    // --- Enumerate sessions ---
    std::vector<AudioSessionInfo> sessions;
    try {
        sessions = sessionMonitor_->EnumerateSessions();
    } catch (const std::exception& e) {
        std::cerr << "[FilteredMonitorController] EnumerateSessions threw: "
                  << e.what() << std::endl;
        return false;
    }

    // --- Plan desired sources ---
    FilteredSourcePlanner planner;
    FilteredSourcePlan plan = planner.Plan(sessions, options_);

    {
        std::lock_guard<std::mutex> diagLock(diagMutex_);
        diag_.totalReconciliations++;
        diag_.totalSessionsLastScan = plan.totalSessions;
        diag_.activeSessionsLastScan = plan.activeSessions;
        diag_.inactiveSessionsLastScan = plan.inactiveSessions;
        diag_.invalidSessionsLastScan = plan.invalidSessions;
        diag_.expiredSessionsLastScan = plan.expiredSessions;
        diag_.systemSoundsSkippedLastScan = plan.systemSoundsSkipped;
        diag_.discordExcludedLastScan = plan.discordExcluded;
        diag_.screenLinkExcludedLastScan = plan.screenLinkExcluded;
        diag_.duplicateRootsLastScan = plan.duplicateRoots;
        diag_.sourceLimitSkippedLastScan = plan.sourceLimitSkipped;
        diag_.validatedLiveSessionsLastScan = plan.validatedLiveSessions;
        diag_.inconsistentIdentitySessionsLastScan = plan.inconsistentIdentitySessions;
        diag_.identityLookupFailuresLastScan = plan.identityLookupFailures;

        if (plan.inconsistentIdentitySessions > 0) {
            std::cerr << "[FilteredMonitor] session-identity-invariant-failure count="
                      << plan.inconsistentIdentitySessions << std::endl;
        }

        diag_.lastSuccessfulInventoryTimestamp = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
    }

    // --- Build a set of desired identities for quick lookup ---
    std::unordered_set<ProcessIdentity, ProcessIdentityHash> desiredIdentities;
    desiredIdentities.reserve(plan.desiredSources.size());
    for (const auto& candidate : plan.desiredSources) {
        desiredIdentities.insert(candidate.identity);
    }

    // --- Phase 1: Build list of new/existing sources to add (under activeCapturesMutex_) ---
    // Collect identities that are desired (new or retry). We must NOT hold
    // activeCapturesMutex_ while calling AddSource() because AddSource()
    // also tries to lock activeCapturesMutex_. And we must NOT lock diagMutex_
    // while holding activeCapturesMutex_ to avoid lock-order inversion.
    struct RetryEntry {
        ProcessIdentity identity;
        uint32_t previousFailureCount = 0;
        std::unique_ptr<ApplicationCaptureSource> oldSource;
        uint32_t oldMixerSourceId = 0;
    };
    std::vector<FilteredSourceCandidate> newCandidates;
    std::vector<RetryEntry> retryCleanups; // sources to stop outside the lock
    {
        std::lock_guard<std::mutex> capLock(activeCapturesMutex_);

        for (const auto& candidate : plan.desiredSources) {
            auto it = activeCaptures_.find(candidate.identity);
            if (it != activeCaptures_.end()) {
                it->second.lastSeenAt = now;

                // Check if source needs retry (null source or stopped unexpectedly)
                bool needsRetry = false;
                uint32_t prevFailureCount = it->second.consecutiveStartFailures;
                if (!it->second.source && now >= it->second.nextRetryAt) {
                    needsRetry = true;
                } else if (it->second.source && !it->second.source->IsRunning() &&
                           now >= it->second.nextRetryAt) {
                    needsRetry = true;
                }

                if (needsRetry) {
                    std::cerr << "[FilteredMonitorController] Retrying source PID="
                              << candidate.identity.pid
                              << " (failureCount=" << prevFailureCount << ")" << std::endl;

                    // Move old capture out for cleanup outside the lock
                    RetryEntry re;
                    re.identity = candidate.identity;
                    re.previousFailureCount = prevFailureCount;
                    re.oldSource = std::move(it->second.source);
                    re.oldMixerSourceId = it->second.mixerSourceId;
                    retryCleanups.push_back(std::move(re));

                    // Erase the old entry so the second loop below picks it up
                    activeCaptures_.erase(it);

                    // Mark for re-add via newCandidates (handled by the second loop)
                }
            }
        }

        // Now collect new desired sources (not already in activeCaptures_)
        // Since we erased retry entries above, they'll appear as "new" here.
        for (const auto& candidate : plan.desiredSources) {
            if (activeCaptures_.find(candidate.identity) == activeCaptures_.end()) {
                newCandidates.push_back(candidate);
            }
        }
    }
    // activeCapturesMutex_ is released here

    // Clean up old retry sources outside the lock (no mutex held)
    for (auto& re : retryCleanups) {
        if (re.oldSource) {
            re.oldSource->Stop();
        }
        if (mixer_ && re.oldMixerSourceId != 0) {
            mixer_->RemoveSource(re.oldMixerSourceId);
        }
    }

    // --- Phase 2: Add new/retry sources WITHOUT holding activeCapturesMutex_ ---
    // We collect candidates that need retries with their previous failure count
    // so AddSource can carry the backoff forward. We do this by modifying the
    // ActiveCapture entry after AddSource returns. But since AddSource creates
    // a fresh entry, we need to inject the preserved count afterwards.
    for (const auto& candidate : newCandidates) {
        // Check if this was a retry (existed in retryCleanups)
        bool isRetry = false;
        uint32_t preservedFailureCount = 0;
        for (const auto& re : retryCleanups) {
            if (re.identity == candidate.identity) {
                isRetry = true;
                preservedFailureCount = re.previousFailureCount;
                break;
            }
        }

        const bool added = AddSource(candidate);

        // Only preserve failure count when the retry failed again.
        // A successful retry keeps AddSource()'s values (zero failures).
        if (isRetry && !added) {
            std::lock_guard<std::mutex> capLock(activeCapturesMutex_);
            auto it = activeCaptures_.find(candidate.identity);
            if (it != activeCaptures_.end()) {
                const uint32_t totalFailures = preservedFailureCount + 1u;
                it->second.consecutiveStartFailures = totalFailures;
                // Backoff: 1s, 2s, 4s, 8s, then 30s maximum
                const uint64_t delayMs = totalFailures >= 5u
                    ? 30000ULL
                    : 1000ULL << (totalFailures - 1u);
                it->second.nextRetryAt = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(delayMs);
            }
        }

        // Track retry in diagnostics
        if (isRetry) {
            std::lock_guard<std::mutex> dLock(diagMutex_);
            diag_.sourceRetries++;
        }
    }

    // --- Phase 3: Handle removal grace period ---
    {
        std::unique_lock<std::mutex> capLock(activeCapturesMutex_);

        for (auto it = activeCaptures_.begin(); it != activeCaptures_.end(); ) {
            const auto& identity = it->first;
            if (desiredIdentities.find(identity) == desiredIdentities.end()) {
                auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                    now - it->second.lastSeenAt);
                if (elapsed >= options_.removalGracePeriod) {
                    std::cerr << "[FilteredMonitorController] Removing source PID="
                              << identity.pid << " after " << elapsed.count()
                              << "ms grace period" << std::endl;

                    auto capture = std::move(it->second);
                    it = activeCaptures_.erase(it);

                    // Stop outside the lock
                    capLock.unlock();

                    if (capture.source) {
                        capture.source->Stop();
                    }
                    if (mixer_) {
                        mixer_->RemoveSource(capture.mixerSourceId);
                    }
                    {
                        std::lock_guard<std::mutex> dLock(diagMutex_);
                        diag_.sourcesRemoved++;
                    }

                    // Re-acquire lock before continuing iteration
                    capLock.lock();
                    // Iterator was invalidated by erase. Restart from beginning.
                    // This is safe because we only erase one at a time.
                    it = activeCaptures_.begin();
                } else {
                    ++it;
                }
            } else {
                ++it;
            }
        }
    }

    // --- Update active capture count in diagnostics (no mutex nesting) ---
    uint32_t sourceCount = 0;
    {
        std::lock_guard<std::mutex> capLock(activeCapturesMutex_);
        for (const auto& [_, cap] : activeCaptures_) {
            if (cap.source) sourceCount++;
        }
    }
    {
        std::lock_guard<std::mutex> dLock(diagMutex_);
        diag_.activeCaptureSources = sourceCount;
    }

    // Snapshot per-active-source diagnostics
    SnapshotActiveSourceDiagnostics();

    return true;
}

// ============================================================================
// Source Lifecycle
// ============================================================================

bool FilteredMonitorController::AddSource(const FilteredSourceCandidate& candidate) {
    std::cerr << "[FilteredMonitorController] AddSource PID="
              << candidate.identity.pid << std::endl;

    auto now = std::chrono::steady_clock::now();

    // Reserve a source slot in the mixer
    // IMPORTANT: mixer_->AddSource() can return 0 when the source limit is reached.
    uint32_t sourceId = mixer_->AddSource(
        candidate.identity.pid,
        candidate.identity.creationTimeUtc100ns);

    if (sourceId == 0) {
        // Mixer source limit reached - record failure, don't start capture
        std::cerr << "[FilteredMonitorController] Mixer source limit reached for PID="
                  << candidate.identity.pid << std::endl;
        {
            std::lock_guard<std::mutex> lock(diagMutex_);
            diag_.sourceStartAttempts++;
            diag_.sourceStartFailures++;
            diag_.lastErrorCode = "MIXER_LIMIT";
            diag_.lastErrorMessage = "Mixer source limit reached";
        }
        return false;
    }

    // Create capture source
    auto captureSource = std::make_unique<ApplicationCaptureSource>();

    // Build the packet callback: forward to mixer
    auto captureCallback = [this, sourceId](const AudioPacket& pkt) -> bool {
        RecordFilteredInputPacket(pkt);
        if (mixer_) {
            mixer_->FeedPacket(sourceId, pkt);
        }
        return true;
    };

    // Track attempt
    {
        std::lock_guard<std::mutex> lock(diagMutex_);
        diag_.sourceStartAttempts++;
    }

    // Start capturing (blocks up to 5s for WASAPI init)
    auto outcome = captureSource->Start(
        candidate.identity.pid,
        candidate.identity.creationTimeUtc100ns,
        std::move(captureCallback));

    // Build the ActiveCapture entry
    ActiveCapture capture;
    capture.candidate = candidate;
    capture.mixerSourceId = sourceId;
    capture.lastSeenAt = now;

    bool startedOk = (outcome.result == AppCaptureStartResult::Success);

    if (startedOk) {
        capture.source = std::move(captureSource);
        capture.consecutiveStartFailures = 0;
        capture.nextRetryAt = {};

        std::cerr << "[FilteredMonitor] source-added sessionPid="
                  << candidate.sessionPid
                  << " captureRootPid=" << candidate.identity.pid
                  << " root=" << candidate.rootExecutableName
                  << " active=" << (candidate.activeSession ? "1" : "0")
                  << " sourceId=" << sourceId
                  << std::endl;

        {
            std::lock_guard<std::mutex> lock(diagMutex_);
            diag_.sourcesAdded++;
        }
    } else {
        // Start failed - cleanup the mixer slot
        std::cerr << "[FilteredMonitor] source-failed captureRootPid="
                  << candidate.identity.pid
                  << " root=" << candidate.rootExecutableName
                  << " error=" << outcome.failureReason
                  << std::endl;

        // Remove the mixer source since we won't use it
        if (mixer_) {
            mixer_->RemoveSource(sourceId);
        }
        capture.mixerSourceId = 0;

        // Compute retry backoff
        capture.consecutiveStartFailures = 1;
        uint64_t delayMs = 1000ULL * (1ULL << 0u); // 1 second
        capture.nextRetryAt = now + std::chrono::milliseconds(delayMs);

        {
            std::lock_guard<std::mutex> lock(diagMutex_);
            diag_.sourceStartFailures++;
        }
    }

    // Insert into the active captures map (source may be null if start failed)
    {
        std::lock_guard<std::mutex> lock(activeCapturesMutex_);
        activeCaptures_[candidate.identity] = std::move(capture);
    }

    return startedOk;
}

void FilteredMonitorController::RemoveSource(const ProcessIdentity& identity) {
    std::unique_lock<std::mutex> lock(activeCapturesMutex_);
    auto it = activeCaptures_.find(identity);
    if (it == activeCaptures_.end()) {
        return;
    }

    auto capture = std::move(it->second);
    activeCaptures_.erase(it);
    lock.unlock();

    {
        std::string removalReason = (capture.source && capture.source->IsRunning())
            ? "grace-expired" : "stopped";
        std::cerr << "[FilteredMonitor] source-removed captureRootPid="
                  << identity.pid
                  << " reason=" << removalReason
                  << " sourceId=" << capture.mixerSourceId
                  << std::endl;
    }

    if (capture.source) {
        capture.source->Stop();
    }
    if (mixer_ && capture.mixerSourceId != 0) {
        mixer_->RemoveSource(capture.mixerSourceId);
    }

    {
        std::lock_guard<std::mutex> dLock(diagMutex_);
        diag_.sourcesRemoved++;
    }
}

void FilteredMonitorController::StopAllSourcesOnControllerThread() {
    std::cerr << "[FilteredMonitorController] Stopping all capture sources..."
              << std::endl;

    std::vector<ActiveCapture> captures;
    {
        std::lock_guard<std::mutex> lock(activeCapturesMutex_);
        captures.reserve(activeCaptures_.size());
        for (auto& [_, cap] : activeCaptures_) {
            captures.push_back(std::move(cap));
        }
        activeCaptures_.clear();
    }

    for (auto& cap : captures) {
        if (cap.source) {
            cap.source->Stop();
        }
    }

    {
        std::lock_guard<std::mutex> lock(diagMutex_);
        diag_.activeCaptureSources = 0;
    }

    std::cerr << "[FilteredMonitorController] All capture sources stopped"
              << std::endl;
}

// ============================================================================
// Wake / Notification
// ============================================================================

void FilteredMonitorController::WakeReconciliation() {
    wakeGeneration_.fetch_add(1, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(wakeMutex_);
        wakeCv_.notify_one();
    }

    {
        std::lock_guard<std::mutex> dLock(diagMutex_);
        diag_.notificationWakeups++;
    }
}

// ============================================================================
// Diagnostics Recording
// ============================================================================

void FilteredMonitorController::RecordFilteredInputPacket(const AudioPacket& packet) {
    auto energy = MeasurePacketEnergy(packet);
    std::lock_guard<std::mutex> lock(diagMutex_);
    diag_.mixerInputPackets++;
    if (energy.HasAudibleSamples()) {
        diag_.mixerInputNonZeroPackets++;
    } else {
        diag_.mixerInputZeroPackets++;
    }
    diag_.lastInputPeak = energy.peak;
    if (energy.peak > diag_.maximumInputPeak) {
        diag_.maximumInputPeak = energy.peak;
    }
    diag_.lastInputRms = energy.Rms();
    if (energy.Rms() > diag_.maximumInputRms) {
        diag_.maximumInputRms = energy.Rms();
    }
}

void FilteredMonitorController::RecordFilteredMixerOutput(const AudioPacket& packet) {
    auto energy = MeasurePacketEnergy(packet);
    std::lock_guard<std::mutex> lock(diagMutex_);
    diag_.mixerOutputPackets++;
    if (energy.HasAudibleSamples()) {
        diag_.mixerOutputNonZeroPackets++;
    } else {
        diag_.mixerOutputZeroPackets++;
    }
    diag_.lastOutputPeak = energy.peak;
    if (energy.peak > diag_.maximumOutputPeak) {
        diag_.maximumOutputPeak = energy.peak;
    }
    diag_.lastOutputRms = energy.Rms();
    if (energy.Rms() > diag_.maximumOutputRms) {
        diag_.maximumOutputRms = energy.Rms();
    }
}

void FilteredMonitorController::SnapshotActiveSourceDiagnostics() {
    std::vector<ActiveSourceDiagnostics> sources;
    {
        std::lock_guard<std::mutex> lock(activeCapturesMutex_);
        sources.reserve(activeCaptures_.size());
        for (const auto& [identity, cap] : activeCaptures_) {
            if (!cap.source) continue;
            ActiveSourceDiagnostics as;
            as.logicalRootPid = identity.pid;
            as.physicalCaptureTargetPid = cap.candidate.identity.pid;
            as.sessionPid = cap.candidate.sessionPid;
            as.executableName = cap.candidate.rootExecutableName;
            sources.push_back(std::move(as));
        }
    }
    {
        std::lock_guard<std::mutex> lock(diagMutex_);
        diag_.activeSources = std::move(sources);
    }
}

} // namespace screenlink::audio
