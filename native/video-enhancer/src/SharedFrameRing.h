#pragma once
#include <cstdint>
#include <atomic>
#include "FrameTransport.h"

namespace screenlink::video {

/// Three-slot bounded frame ring with newest-frame semantics.
/// Slots: [0] = writer (renderer), [1] = processing (helper), [2] = completed (helper done).
class SharedFrameRing {
public:
    SharedFrameRing() = default;
    ~SharedFrameRing() = default;

    // Not copyable
    SharedFrameRing(const SharedFrameRing&) = delete;
    SharedFrameRing& operator=(const SharedFrameRing&) = delete;

    // Phase 7: Implement ring buffer management

private:
    // Slot states
    enum class SlotState : uint32_t {
        kFree = 0,
        kWriting = 1,
        kReady = 2,
        kProcessing = 3,
        kCompleted = 4,
    };

    struct Slot {
        std::atomic<SlotState> state{SlotState::kFree};
        uint8_t data[kMaxFrameSize];
        FrameHeader header{};
    };

    Slot slots_[kRingSlotCount]{};
    std::atomic<uint32_t> writeIndex_{0};
};

} // namespace screenlink::video
