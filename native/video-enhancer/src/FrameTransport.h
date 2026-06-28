#pragma once
#include <cstdint>
#include <string>

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
    uint32_t slotIndex = 0;

    // Payload size
    uint32_t payloadBytes = 0;

    // Processing mode (maps to NvidiaProcessingMode)
    uint32_t processingMode = 0;

    // Quality level (maps to NvidiaQuality)
    uint32_t qualityLevel = 0;

    // Flags
    uint32_t flags = 0;

    // Result (set by helper after processing)
    uint32_t resultCode = 0; // 0=pending, 1=success, 2=error
};

} // namespace screenlink::video
