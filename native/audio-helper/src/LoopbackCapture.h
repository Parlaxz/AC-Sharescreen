#ifndef SCREENLINK_LOOPBACK_CAPTURE_H
#define SCREENLINK_LOOPBACK_CAPTURE_H

#include <cstdint>
#include <string>
#include <functional>

namespace screenlink::audio {

/// Configuration for process-loopback audio capture.
struct CaptureConfig {
    uint32_t targetPid = 0;       // PID to include or exclude
    bool includeMode = true;      // true=include only target, false=exclude target
    uint32_t durationMs = 5000;   // Capture duration in milliseconds
    std::string outputPath;       // WAV output path (empty = auto-generated)
};

/// Result of a capture operation.
struct CaptureResult {
    bool succeeded = false;
    uint64_t framesCaptured = 0;
    uint64_t bytesWritten = 0;
    std::string failureReason;
    std::string outputPath;
};

/// Run process-loopback capture and write directly to a WAV file.
/// @note Requires Windows build >= 20348. On older builds, returns
///       succeeded=false with error message.
CaptureResult RunCapture(const CaptureConfig& config);

/// Check if current OS supports process-loopback capture.
bool IsProcessLoopbackSupported();

/// Frame callback: return true to continue, false to stop.
/// Called with interleaved float32 PCM data.
using FrameCallback = std::function<bool(const float* frames, uint32_t frameCount, uint32_t channels)>;

/// Run process-loopback capture with a frame callback instead of writing to WAV.
/// @note Requires Windows build >= 20348. On older builds, returns
///       succeeded=false with error message.
CaptureResult RunCaptureWithCallback(const CaptureConfig& config, FrameCallback onFrames);

} // namespace screenlink::audio

#endif // SCREENLINK_LOOPBACK_CAPTURE_H
