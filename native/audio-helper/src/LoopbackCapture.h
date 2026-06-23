#ifndef SCREENLINK_LOOPBACK_CAPTURE_H
#define SCREENLINK_LOOPBACK_CAPTURE_H

#include <cstdint>
#include <string>
#include <functional>

namespace screenlink::audio {

/// Configuration for process-loopback audio capture.
struct CaptureConfig {
    uint32_t targetPid = 0;
    uint64_t expectedCreationTimeUtc100ns = 0;  // 0 = skip validation
    bool includeMode = true;                     // true=include only target, false=exclude target
    uint32_t durationMs = 5000;                  // Capture duration in milliseconds
    std::string outputPath;                      // WAV output path (empty = auto-generated)
    bool overwrite = false;                      // Allow overwriting existing output file
};

/// Result of a capture operation.
struct CaptureResult {
    bool succeeded = false;
    uint64_t framesCaptured = 0;
    uint64_t bytesWritten = 0;
    std::string failureReason;
    std::string outputPath;
};

/// A single packet of captured audio with metadata.
struct AudioPacket {
    const float* frames = nullptr;
    uint32_t frameCount = 0;
    uint32_t channels = 0;
    uint64_t sequenceNumber = 0;
    uint64_t qpcPosition100ns = 0;
    uint64_t devicePosition = 0;
    bool isSilent = false;
    bool isDiscontinuous = false;
    bool hasTimestampError = false;
    bool isEndOfStream = false;
    uint32_t sourceId = 0;  // identifies the originating capture source
};

/// Packet callback: return true to continue, false to stop.
using PacketCallback = std::function<bool(const AudioPacket& packet)>;

/// Run process-loopback capture with a packet callback that receives
/// full metadata (timestamps, silence flags, etc.).
CaptureResult RunCaptureWithPacketCallback(const CaptureConfig& config, PacketCallback onPacket);

/// Frame callback: return true to continue, false to stop.
/// Called with interleaved float32 PCM data.
using FrameCallback = std::function<bool(const float* frames, uint32_t frameCount, uint32_t channels)>;

/// Run process-loopback capture with a frame callback instead of writing to WAV.
CaptureResult RunCaptureWithCallback(const CaptureConfig& config, FrameCallback onFrames);

/// Run process-loopback capture and write directly to a WAV file.
CaptureResult RunCapture(const CaptureConfig& config);

/// Check if current OS supports process-loopback capture.
/// @note Returns true on Windows build >= 20348 (documented) or
/// build >= 19041 with a successful runtime probe (experimental).
/// On builds below 19041, always returns false.
bool IsProcessLoopbackSupported();

} // namespace screenlink::audio

#endif // SCREENLINK_LOOPBACK_CAPTURE_H
