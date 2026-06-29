#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <windows.h>

namespace screenlink::video {

/// Maximum frame dimensions supported (4K UHD).
constexpr uint32_t kMaxFrameWidth = 3840;
constexpr uint32_t kMaxFrameHeight = 2160;
constexpr uint32_t kMaxFrameSize = kMaxFrameWidth * kMaxFrameHeight * 4; // RGBA

/// Frame ring slot count (3: one write, one process, one complete).
constexpr uint32_t kRingSlotCount = 3;

/// Pixel format enumeration.
enum class PixelFormat : uint32_t {
    kUnknown = 0,
    kBGRA8 = 1,
    kRGBA8 = 2,
};

/// Frame metadata sent alongside buffer data over the named pipe.
struct FrameHeader {
    uint64_t magic = 0x464C4156454D5246ULL; // "FRAMEFL" little-endian
    uint32_t headerSize = sizeof(FrameHeader);
    uint32_t wireVersion = 1;

    // Stream identification
    uint32_t generation = 0;
    uint32_t frameSequence = 0;
    uint64_t capturedAtUs = 0;

    // Frame dimensions
    uint32_t inputWidth = 0;
    uint32_t inputHeight = 0;
    uint32_t inputStride = 0;
    PixelFormat pixelFormat = PixelFormat::kUnknown;

    // Requested output dimensions
    uint32_t requestedOutputWidth = 0;
    uint32_t requestedOutputHeight = 0;

    // Slot index in the shared frame ring
    // Phase 3: Reused in output header to carry configurationId for stale-frame rejection.
    uint32_t slotIndex = 0;

    // Payload size
    uint32_t payloadBytes = 0;

    // Processing mode (maps to NvidiaProcessingMode)
    uint32_t processingMode = 0;

    // Quality level (maps to NvidiaQuality)
    uint32_t qualityLevel = 0;

    // Flags
    // Phase 3: Reused in output header to carry the canonical appliedQualityLevel.
    uint32_t flags = 0;

    // Result (set by helper after processing)
    uint32_t resultCode = 0; // 0=pending, 1=success, 2=error

    // Native per-stage timing (microseconds, filled by helper after processing)
    // Only pre-write known timings are included. nativeOutputWriteUs is always 0
    // in the per-frame header; it is available only in aggregate diagnostics.
    uint32_t nativeInputReceiveUs = 0;
    uint32_t nativeUploadUs = 0;
    uint32_t nativeEffectUs = 0;
    uint32_t nativeDownloadUs = 0;
    uint32_t nativeOutputWriteUs = 0; // always 0 in per-frame header; use aggregate diagnostics
    uint32_t nativeTotalUs = 0;       // pre-write total (inputReceive+upload+effect+download)
};

/// Named-pipe transport for control (JSON) and frame (binary) channels.
class FrameTransport {
public:
    FrameTransport() = default;
    ~FrameTransport() { CloseControlPipe(); CloseFramePipe(); }
    FrameTransport(const FrameTransport&) = delete;
    FrameTransport& operator=(const FrameTransport&) = delete;

    // Pipe creation
    bool CreateControlPipe(const std::string& name);
    bool CreateFramePipe(const std::string& name);

    // Client connection
    bool WaitForClient(HANDLE pipe);
    HANDLE GetControlPipe() const;
    HANDLE GetFramePipe() const;

    // Control messages (JSON, newline-delimited)
    std::string ReadControlMessage();
    bool WriteControlResponse(const std::string& response);

    // Frame I/O (binary header + pixel data)
    bool ReadFrame(FrameHeader& header, std::vector<uint8_t>& data);
    bool WriteFrame(const FrameHeader& header, const void* data, size_t dataSize);

    // Cleanup
    void CloseControlPipe();
    void CloseFramePipe();

private:
    HANDLE controlPipe_ = INVALID_HANDLE_VALUE;
    HANDLE framePipe_ = INVALID_HANDLE_VALUE;
};

} // namespace screenlink::video
