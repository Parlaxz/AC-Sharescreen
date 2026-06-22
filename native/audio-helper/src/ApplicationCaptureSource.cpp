#include "ApplicationCaptureSource.h"

#include <iostream>

namespace screenlink::audio {

ApplicationCaptureSource::ApplicationCaptureSource() = default;

ApplicationCaptureSource::~ApplicationCaptureSource() {
    Stop();
}

bool ApplicationCaptureSource::Start(uint32_t pid, uint64_t creationTimeUtc100ns,
                                      std::function<bool(const AudioPacket&)> onPacket) {
    if (running_.load()) return false;

    pid_ = pid;
    creationTimeUtc100ns_ = creationTimeUtc100ns;
    running_.store(true);

    try {
        captureThread_ = std::thread(&ApplicationCaptureSource::CaptureThread,
                                      this, pid, creationTimeUtc100ns, std::move(onPacket));
        return true;
    } catch (const std::exception&) {
        running_.store(false);
        return false;
    }
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

    // Run capture with the packet callback
    // The callback returns false when we should stop (signalled by running_ going false)
    RunCaptureWithPacketCallback(config, [this, &onPacket](const AudioPacket& packet) -> bool {
        if (!running_.load()) return false;
        return onPacket(packet);
    });

    running_.store(false);
}

} // namespace screenlink::audio
