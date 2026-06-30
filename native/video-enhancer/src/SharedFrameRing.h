#pragma once
#include "FrameTransport.h"
#include <cstdint>
#include <string>
#include <windows.h>

namespace screenlink::video {

/// Slot control word values
enum class SlotState : uint32_t {
    kEmpty = 0,
    kSubmitted = 1,
    kProcessing = 2,
    kDone = 3,
    kError = 4,
};

/// Size of a single ring slot's pixel input region (matches max frame).
constexpr uint32_t kRingInputSize = kMaxFrameSize;

/// Size of a single ring slot's pixel output region (same-res,
/// denoise, deblur).  2x VSR output uses pipe fallback.
constexpr uint32_t kRingOutputSize = kMaxFrameSize;

/// Full ring slot layout (file-offset-based).
#pragma pack(push, 8)
struct RingSlotLayout {
    /// Slot state (SlotState).  Written by main (kEmpty, kSubmitted)
    /// or helper (kProcessing, kDone, kError).  Accessed with volatile
    /// loads on both sides.
    volatile uint32_t control;

    /// Explicit padding to align FrameHeader to 8 bytes.
    uint32_t padding;

    /// Frame header — input params written by main, output params
    /// written by helper on completion.
    FrameHeader header;

    /// Input pixel data (written by main, read by helper).
    uint8_t inputPixels[kRingInputSize];

    /// Output pixel data (written by helper, read by main).
    /// For passthrough / CPU fallback this is the same size as input.
    /// For NVIDIA VFX the helper downloads into this region.
    uint8_t outputPixels[kRingOutputSize];
};
#pragma pack(pop)

/// Byte offset of the inputPixels field within a RingSlotLayout.
constexpr size_t kSlotInputOffset = offsetof(RingSlotLayout, inputPixels);

/// Byte offset of the outputPixels field.
constexpr size_t kSlotOutputOffset = offsetof(RingSlotLayout, outputPixels);

/// Total byte size of one ring slot.
constexpr size_t kSlotSize = sizeof(RingSlotLayout);

/// Total byte size of the full 3-slot ring.
constexpr size_t kRingTotalSize = kRingSlotCount * kSlotSize;

/// Build the shared-memory temp-file path from a session ID.
/// Returns "%TEMP%\screenlink-shm-{sessionId}.bin".
std::string BuildSharedMemoryPath(const std::string& sessionId);

// -----------------------------------------------------------------------
// SharedFrameRing — manages a 3-slot ring buffer in a file-mapping-backed
// shared memory region visible to both the helper process and the main
// (Electron) process.
//
// The main process writes frames into slots via fs.write (file offsets).
// The helper reads/writes via a MapViewOfFile mapping (zero-copy).
// Coordination: the control word (RingSlotLayout::control) is a volatile
// uint32 written by one side and read by the other, plus JSON messages
// over the existing control named pipe (processSlot / slotComplete).
//
// Lifecycle:
//   Helper creates file + mapping + view at startup.
//   Helper calls WriteCapabilities() to advertise shm availability.
//   Main opens the same file by the deterministic path, uses fs.read/write.
//   Main sends {"command":"processSlot","slotIndex":N} over control pipe.
//   Helper receives it, processes the slot, writes output, signals done.
//   Main receives {"command":"slotComplete","slotIndex":N}, reads output.
// -----------------------------------------------------------------------
class SharedFrameRing {
public:
    SharedFrameRing() = default;
    ~SharedFrameRing();

    SharedFrameRing(const SharedFrameRing&) = delete;
    SharedFrameRing& operator=(const SharedFrameRing&) = delete;

    /// Create the temp file, file mapping, and map all 3 slots.
    /// Returns true on success, false on failure (caller falls back to pipe).
    /// @param sessionId  Used to build deterministic file path.
    bool Create(const std::string& sessionId);

    /// Close and release everything.  Idempotent.
    void Close();

    /// Returns true if Create() succeeded and the ring is usable.
    bool IsValid() const { return mappedView_ != nullptr; }

    /// Access a slot's layout pointer from the mapping (helper-side only).
    /// Returns nullptr if slotIndex is out of range or mapping invalid.
    RingSlotLayout* Slot(uint32_t slotIndex);

    /// Get the temp file path (for main process to open).
    const std::string& FilePath() const { return filePath_; }

    /// Get the total ring size in bytes.
    size_t TotalSize() const { return kRingTotalSize; }

    /// Find the first slot in kEmpty state.  Returns kRingSlotCount if none.
    uint32_t FindEmptySlot();

private:
    std::string filePath_;
    std::string sessionId_;

    // Win32 handles
    HANDLE fileHandle_ = INVALID_HANDLE_VALUE;
    HANDLE mappingHandle_ = nullptr;

    // Mapped view
    void* mappedView_ = nullptr;
};

} // namespace screenlink::video
