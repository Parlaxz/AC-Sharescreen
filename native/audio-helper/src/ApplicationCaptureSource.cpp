#include "ApplicationCaptureSource.h"

#include <iostream>

namespace screenlink::audio {

ApplicationCaptureSource::ApplicationCaptureSource() = default;

ApplicationCaptureSource::~ApplicationCaptureSource() {
    Stop();
}

void ApplicationCaptureSource::SignalStartupComplete(AppCaptureStartResult result, std::string reason) {
    std::lock_guard<std::mutex> lock(startupMutex_);
    startupOutcome_.result = result;
    startupOutcome_.failureReason = std::move(reason);
    startupComplete_ = true;
    startupCv_.notify_one();
}

AppCaptureStartOutcome ApplicationCaptureSource::Start(
    uint32_t pid, uint64_t creationTimeUtc100ns,
    std::function<bool(const AudioPacket&)> onPacket) {
    if (running_.load()) {
        AppCaptureStartOutcome out;
        out.result = AppCaptureStartResult::AlreadyRunning;
        out.failureReason = "Capture source is already running";
        return out;
    }

    pid_ = pid;
    creationTimeUtc100ns_ = creationTimeUtc100ns;

    // Reset startup state
    {
        std::lock_guard<std::mutex> lock(startupMutex_);
        startupComplete_ = false;
        startupOutcome_ = {};
    }

    running_.store(true);

    try {
        captureThread_ = std::thread(&ApplicationCaptureSource::CaptureThread,
                                      this, pid, creationTimeUtc100ns, std::move(onPacket));
    } catch (const std::exception& e) {
        running_.store(false);
        AppCaptureStartOutcome out;
        out.result = AppCaptureStartResult::ThreadCreationFailed;
        out.failureReason = std::string("Thread creation failed: ") + e.what();
        return out;
    }

    // Wait for the capture thread to report readiness (bounded)
    AppCaptureStartOutcome out;
    {
        std::unique_lock<std::mutex> lock(startupMutex_);
        if (!startupCv_.wait_for(lock, std::chrono::seconds(5),
                [this] { return startupComplete_; }))
        {
            running_.store(false);
            if (captureThread_.joinable()) captureThread_.join();
            out.result = AppCaptureStartResult::ActivationFailed;
            out.failureReason = "WASAPI activation timed out (5s)";
            return out;
        }
        out = startupOutcome_;
    }

    if (out.result != AppCaptureStartResult::Success) {
        if (captureThread_.joinable()) captureThread_.join();
    }

    return out;
}

void ApplicationCaptureSource::Stop() {
    if (!running_.load()) {
        if (captureThread_.joinable()) {
            captureThread_.join();
        }
        return;
    }

    running_.store(false);

    if (captureThread_.joinable()) {
        captureThread_.join();
    }
}

void ApplicationCaptureSource::CaptureThread(uint32_t pid,
                                              uint64_t creationTimeUtc100ns,
                                              std::function<bool(const AudioPacket&)> onPacket) {
    // Build capture config: infinite duration (until stopped)
    CaptureConfig config;
    config.targetPid = pid;
    config.expectedCreationTimeUtc100ns = creationTimeUtc100ns;
    config.includeMode = true;
    config.durationMs = 0; // 0 = infinite (runs until callback returns false)

    // Delegate startup decision to RunCaptureWithPacketCallback:
    // Signal success as soon as WASAPI is ready (before first packet).
    // Keep firstPacketReceived as a separate diagnostic, NOT as readiness gate.
    std::atomic<bool> firstPacketReceived{false};

    // Lifecycle callbacks: onReady is called immediately after IAudioClient::Start
    // succeeds and before entering the capture wait loop.
    CaptureLifecycleCallbacks lifecycle;
    lifecycle.onReady = [this](const CaptureReadyInfo& /*info*/) {
        SignalStartupComplete(AppCaptureStartResult::Success, "");
    };

    std::cerr << "[ProcessLoopback] activate targetPid=" << pid
              << " mode=include-tree source=filtered-monitor"
              << " captureRootPid=" << pid
              << " rootCreationTime=" << creationTimeUtc100ns
              << std::endl;

    auto result = RunCaptureWithPacketCallback(config,
        [this, &onPacket, &firstPacketReceived](const AudioPacket& packet) -> bool {
            // Track first packet for diagnostics only — NOT for startup signaling
            firstPacketReceived.store(true, std::memory_order_relaxed);

            if (!running_.load()) return false;
            return onPacket(packet);
        },
        lifecycle);

    // If activation failed (RunCaptureWithPacketCallback returned without signaling ready),
    // signal failure now
    {
        std::lock_guard<std::mutex> lock(startupMutex_);
        if (!startupComplete_) {
            startupOutcome_.result = AppCaptureStartResult::ActivationFailed;
            startupOutcome_.failureReason = result.failureReason.empty()
                ? "Process-loopback activation failed"
                : result.failureReason;
            startupComplete_ = true;
            startupCv_.notify_one();
        }
    }

    running_.store(false);
}

} // namespace screenlink::audio
