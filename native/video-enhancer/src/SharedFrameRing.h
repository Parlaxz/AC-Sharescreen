#pragma once
#include <cstdint>
#include <atomic>
#include "FrameTransport.h"
#include "Diagnostics.h"

namespace screenlink::video {

/// Three-slot bounded frame ring with newest-frame semantics.
/// Slots: [0..2] cycle through Free → Writing → Ready → Processing → Completed → Free.
class SharedFrameRing {
public:
    SharedFrameRing() = default;
    ~SharedFrameRing() = default;

    SharedFrameRing(const SharedFrameRing&) = delete;
    SharedFrameRing& operator=(const SharedFrameRing&) = delete;

    /// Find a free slot and transition to Writing. Returns slot index or kRingSlotCount.
    uint32_t ClaimFreeSlot();

    /// Find a ready slot (data written) and transition to Processing. Returns index or kRingSlotCount.
    uint32_t ClaimReadySlot();

    /// Mark a slot as ready for processing (caller was Writing, now transition to Ready).
    bool MarkWritten(uint32_t index);

    /// Mark a slot as completed with a result code (caller was Processing, now transition to Completed).
    bool MarkComplete(uint32_t index, uint32_t resultCode = 1);

    /// Release a completed slot back to Free.
    bool ReleaseSlot(uint32_t index);

    /// Get pointer to pixel data for a slot.
    uint8_t* GetSlotData(uint32_t index);

    /// Get mutable reference to slot header.
    FrameHeader& GetSlotHeader(uint32_t index);

    /// Get current state of a slot.
    SlotState GetSlotState(uint32_t index) const;

    /// Number of slots.
    static constexpr uint32_t kSlotCount = kRingSlotCount;

private:
    friend class SharedFrameRingTest;

    enum class SlotState : uint32_t {
        kFree = 0,
        kWriting = 1,
        kReady = 2,
        kProcessing = 3,
        kCompleted = 4,
    };

    struct Slot {
        std::atomic<SlotState> state{SlotState::kFree};
        uint8_t data[kMaxFrameSize]{};
        FrameHeader header{};
    };

    Slot slots_[kRingSlotCount]{};
    std::atomic<uint32_t> writeIndex_{0};
};

/// Global shared frame ring instance.
SharedFrameRing& GetSharedFrameRing();

/// Global diagnostics counters.
DiagnosticsCounters& GetDiagnosticsCounters();

} // namespace screenlink::video
