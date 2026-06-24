#include "FilteredMonitorController.h"
#include "FilteredSourcePlanner.h"

#include <algorithm>
#include <chrono>
#include <iostream>
#include <mutex>
#include <set>
#include <unordered_set>
#include <sstream>
#include <windows.h>

namespace screenlink::audio {

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
    std::cerr << "[FilteredMonitorController] Start() called" << std::endl;

    if (running_.exchange(true)) {
        std::cerr << "[FilteredMonitorController] Start() ignored – already running" << std::endl;
        FilteredStartOutcome outcome;
        outcome.success = false;
        outcome.errorCode = "ALREADY_RUNNING";
        outcome.failureReason = "Controller is already running";
        return outcome;
    }

    stopping_ = false;
    startupComplete_ = false;
    options_ = options;
    outputCallback_ = std::move(outputCallback);

    if (!outputCallback_) {
        std::cerr << "[FilteredMonitorController] Start() failed – no output callback" << std::endl;
        running_ = false;
        FilteredStartOutcome outcome;
        outcome.success = false;
        outcome.errorCode = "NO_OUTPUT_CALLBACK";
        outcome.failureReason = "Output callback is null";
        return outcome;
    }

    // --- Create and start the mixer ---
    {
        std::lock_guard<std::mutex> lock(diagMutex_);
        diag_ = FilteredMonitorDiagnostics{};
    }

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
        std::ostringstream ss;
        ss << "Mixer start error: " << static_cast<int>(mixResult.error);
        outcome.errorCode = "MIXER_START_FAILED";
        outcome.failureReason = ss.str();
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
            // Controller thread continues running – it will retry initialization.
        }
    }

    std::cerr << "[FilteredMonitorController] Start() complete – success="
              << (startupOutcome_.success ? "true" : "false")
              << ", initialSources=" << startupOutcome_.initialActiveSources
              << std::endl;
    return startupOutcome_;
}

void FilteredMonitorController::Stop() {
    std::cerr << "[FilteredMonitorController] Stop() called" << std::endl;

    if (!running_.exchange(false)) {
        // Already stopped; ensure mixer and sources are cleaned up
        std::cerr << "[FilteredMonitorController] Stop() – already stopped" << std::endl;
        StopAllSourcesOnControllerThread();
        if (mixer_) {
            mixer_->Stop();
        }
        return;
    }

    stopping_ = true;

    // Wake the controller thread so it exits its wait loop
    WakeReconciliation();

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
    std::lock_guard<std::mutex> lock(diagMutex_);

    // Capture live state into the diagnostics snapshot
    FilteredMonitorDiagnostics snap = diag_;
    snap.running = running_.load();
    snap.mixerRunning = mixer_ ? mixer_->IsRunning() : false;

    {
        std::lock_guard<std::mutex> capLock(activeCapturesMutex_);
        snap.activeCaptureSources = static_cast<uint32_t>(activeCaptures_.size());
    }

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

    // Signal startup completion (even on failure – Start() will use the outcome)
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
    while (!stopping_.load()) {
        auto reconcileStart = std::chrono::steady_clock::now();

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
                // Enumeration failure – keep current sources
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

        // Wait for the next reconcile interval or a wake notification
        auto waitUntil = reconcileStart + options_.reconcileInterval;
        {
            std::unique_lock<std::mutex> wakeLock(wakeMutex_);
            wakeCv_.wait_until(wakeLock, waitUntil,
                [this]() { return stopping_.load(); });
        }

        if (!stopping_.load()) {
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
    if (!monitor->Initialize()) {
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

    if (sessions.empty()) {
        // Could be a valid empty result or a failure. We treat empty + no exception
        // as a valid (empty) inventory – still reconcile.
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
        diag_.desiredSourcesLastScan = static_cast<uint32_t>(plan.desiredSources.size());
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

    // --- Reconcile desired sources with active captures ---
    {
        std::lock_guard<std::mutex> capLock(activeCapturesMutex_);

        // Process desired sources: add new ones, refresh existing ones
        for (const auto& candidate : plan.desiredSources) {
            auto it = activeCaptures_.find(candidate.identity);
            if (it != activeCaptures_.end()) {
                // Already captures this identity – refresh lastSeenAt
                it->second.lastSeenAt = now;

                // Check if the source needs a retry (stopped unexpectedly)
                if (it->second.source && !it->second.source->IsRunning() &&
                    now >= it->second.nextRetryAt) {
                    std::cerr << "[FilteredMonitorController] Retrying source PID="
                              << candidate.identity.pid << std::endl;
                    {
                        std::lock_guard<std::mutex> dLock(diagMutex_);
                        diag_.sourceRetries++;
                    }
                    // Stop the old source and remove from mixer, then re-add
                    it->second.source->Stop();
                    mixer_->RemoveSource(it->second.mixerSourceId);

                    ActiveCapture newCapture;
                    newCapture.candidate = candidate;
                    newCapture.lastSeenAt = now;
                    newCapture.consecutiveStartFailures =
                        it->second.consecutiveStartFailures;

                    // Re-add to mixer
                    newCapture.mixerSourceId = mixer_->AddSource(
                        candidate.identity.pid,
                        candidate.identity.creationTimeUtc100ns);

                    // Create and start new capture source
                    auto captureSource = std::make_unique<ApplicationCaptureSource>();
                    auto sourceId = newCapture.mixerSourceId;
                    auto captureCallback = [this, sourceId](const AudioPacket& pkt) -> bool {
                        RecordFilteredInputPacket(pkt);
                        if (mixer_) {
                            mixer_->FeedPacket(sourceId, pkt);
                        }
                        return true;
                    };

                    {
                        std::lock_guard<std::mutex> dLock(diagMutex_);
                        diag_.sourceStartAttempts++;
                    }

                    auto outcome = captureSource->Start(
                        candidate.identity.pid,
                        candidate.identity.creationTimeUtc100ns,
                        std::move(captureCallback));

                    if (outcome.result == AppCaptureStartResult::Success) {
                        newCapture.source = std::move(captureSource);
                        newCapture.consecutiveStartFailures = 0;
                        newCapture.nextRetryAt = {};

                        // Replace the old entry
                        it->second = std::move(newCapture);

                        {
                            std::lock_guard<std::mutex> dLock(diagMutex_);
                            diag_.sourceUnexpectedStops++;
                        }
                    } else {
                        // Retry failed – compute backoff
                        newCapture.consecutiveStartFailures++;
                        uint32_t f = newCapture.consecutiveStartFailures;
        uint64_t delayMs = 1000ULL * (1ULL << (std::min)((f > 0 ? f - 1u : 0u), 3u));
                        if (f > 4) delayMs = 30000;
                        newCapture.nextRetryAt = now + std::chrono::milliseconds(delayMs);
                        newCapture.source = std::move(captureSource);
                        // Source was stopped/removed, but we keep the entry for tracking

                        {
                            std::lock_guard<std::mutex> dLock(diagMutex_);
                            diag_.sourceStartFailures++;
                        }

                        it->second = std::move(newCapture);
                    }
                }
            } else {
                // New desired source – attempt to add
                AddSource(candidate);
            }
        }

        // Process sources that are no longer desired: apply grace period
        for (auto it = activeCaptures_.begin(); it != activeCaptures_.end(); ) {
            const auto& identity = it->first;
            if (desiredIdentities.find(identity) == desiredIdentities.end()) {
                // Not in desired set – check grace period
                auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                    now - it->second.lastSeenAt);
                if (elapsed >= options_.removalGracePeriod) {
                    std::cerr << "[FilteredMonitorController] Removing source PID="
                              << identity.pid << " after " << elapsed.count()
                              << "ms grace period" << std::endl;

                    // Stop outside the capture lock if possible, but we need to
                    // stop before erasing to avoid dangling references. We'll
                    // move the capture out, stop it, then erase.
                    auto capture = std::move(it->second);
                    it = activeCaptures_.erase(it);

                    // Stop the capture source (may block – do it after erase)
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
                } else {
                    ++it;
                }
            } else {
                ++it;
            }
        }
    }

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
    uint32_t sourceId = mixer_->AddSource(
        candidate.identity.pid,
        candidate.identity.creationTimeUtc100ns);

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

    // Start capturing
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

        std::cerr << "[FilteredMonitorController] Source PID="
                  << candidate.identity.pid << " started successfully" << std::endl;

        {
            std::lock_guard<std::mutex> lock(diagMutex_);
            diag_.sourcesAdded++;
        }
    } else {
        // Start failed – compute backoff
        capture.consecutiveStartFailures = 1;
        uint32_t f = capture.consecutiveStartFailures;
        uint64_t delayMs = 1000ULL * (1ULL << (std::min)((f > 0u ? f - 1u : 0u), 3u));
        if (f > 4) delayMs = 30000;
        capture.nextRetryAt = now + std::chrono::milliseconds(delayMs);

        std::cerr << "[FilteredMonitorController] Source PID="
                  << candidate.identity.pid << " failed to start: "
                  << outcome.failureReason << std::endl;

        {
            std::lock_guard<std::mutex> lock(diagMutex_);
            diag_.sourceStartFailures++;
        }

        // Still store the entry (with no running source) so we can retry later.
        // The mixer source slot remains allocated but idle.
    }

    // Insert into the active captures map
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

    std::cerr << "[FilteredMonitorController] RemoveSource PID="
              << identity.pid << std::endl;

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
    std::lock_guard<std::mutex> lock(wakeMutex_);
    wakeCv_.notify_one();

    {
        std::lock_guard<std::mutex> dLock(diagMutex_);
        diag_.notificationWakeups++;
    }
}

// ============================================================================
// Diagnostics Recording
// ============================================================================

void FilteredMonitorController::RecordFilteredInputPacket(const AudioPacket& /*packet*/) {
    std::lock_guard<std::mutex> lock(diagMutex_);
    diag_.mixerInputPackets++;
}

void FilteredMonitorController::RecordFilteredMixerOutput(const AudioPacket& packet) {
    std::lock_guard<std::mutex> lock(diagMutex_);
    diag_.mixerOutputPackets++;
    if (!packet.isSilent) {
        diag_.mixerNonZeroOutputPackets++;
    }
}

} // namespace screenlink::audio
