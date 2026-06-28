#include "SharedFrameRing.h"

namespace screenlink::video {

// ─── Slot acquisition ─────────────────────────────────────────────────

/// Find the first slot with the given state and transition it to newState.
/// Returns slot index or kRingSlotCount if none found.
static uint32_t AcquireSlot(Slot slots[], SlotState from, SlotState to) {
    for (uint32_t i = 0; i < kRingSlotCount; ++i) {
        SlotState expected = from;
        if (slots[i].state.compare_exchange_strong(expected, to,
                                                     std::memory_order_acq_rel)) {
            return i;
        }
    }
    return kRingSlotCount; // not found
}

uint32_t SharedFrameRing::ClaimFreeSlot() {
    return AcquireSlot(slots_, SlotState::kFree, SlotState::kWriting);
}

uint32_t SharedFrameRing::ClaimReadySlot() {
    return AcquireSlot(slots_, SlotState::kReady, SlotState::kProcessing);
}

bool SharedFrameRing::MarkWritten(uint32_t index) {
    if (index >= kRingSlotCount) return false;
    SlotState expected = SlotState::kWriting;
    return slots_[index].state.compare_exchange_strong(expected,
                                                         SlotState::kReady,
                                                         std::memory_order_acq_rel);
}

bool SharedFrameRing::MarkComplete(uint32_t index, uint32_t resultCode) {
    if (index >= kRingSlotCount) return false;
    SlotState expected = SlotState::kProcessing;
    if (slots_[index].state.compare_exchange_strong(expected,
                                                      SlotState::kCompleted,
                                                      std::memory_order_acq_rel)) {
        slots_[index].header.resultCode = resultCode;
        return true;
    }
    return false;
}

bool SharedFrameRing::ReleaseSlot(uint32_t index) {
    if (index >= kRingSlotCount) return false;
    SlotState expected = SlotState::kCompleted;
    bool ok = slots_[index].state.compare_exchange_strong(expected,
                                                            SlotState::kFree,
                                                            std::memory_order_acq_rel);
    if (!ok) {
        // Force-free if something went wrong
        slots_[index].state.store(SlotState::kFree, std::memory_order_release);
    }
    return true;
}

// ─── Slot data access ─────────────────────────────────────────────────

uint8_t* SharedFrameRing::GetSlotData(uint32_t index) {
    if (index >= kRingSlotCount) return nullptr;
    return slots_[index].data;
}

FrameHeader& SharedFrameRing::GetSlotHeader(uint32_t index) {
    return slots_[index].header; // caller must bounds-check
}

SlotState SharedFrameRing::GetSlotState(uint32_t index) const {
    if (index >= kRingSlotCount) return SlotState::kFree;
    return slots_[index].state.load(std::memory_order_acquire);
}

// ─── Factory ──────────────────────────────────────────────────────────

SharedFrameRing& GetSharedFrameRing() {
    static SharedFrameRing ring;
    return ring;
}

DiagnosticsCounters& GetDiagnosticsCounters() {
    static DiagnosticsCounters counters;
    return counters;
}

} // namespace screenlink::video
