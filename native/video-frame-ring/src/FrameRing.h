#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>

#include <windows.h>

#include "SlotLayout.h"

namespace screenlink::framering {

// ─── Error codes ──────────────────────────────────────────────────────────────
enum class FrameRingErrorCode {
    None               = 0,
    InvalidArgument    = 1,  // Bad slot index, null data, etc.
    MappingFailed      = 2,  // CreateFileMapping / OpenFileMapping failed
    ViewFailed         = 3,  // MapViewOfFile failed
    SlotOverflow       = 4,  // Computed byte offset overflowed
    SessionMismatch    = 5,  // Slot session GUIDs do not match
    NotInitialized     = 6,  // Open()/Create() not called or already closed
    AlreadyInitialized = 7,  // Create()/Open() called while already open
    EventFailed        = 8,  // CreateEvent failed
    SessionGuidFailed  = 9,  // UuidCreate failed
};

inline constexpr std::string_view FrameRingErrorCodeToString(FrameRingErrorCode code) {
    switch (code) {
        case FrameRingErrorCode::None:               return "No error";
        case FrameRingErrorCode::InvalidArgument:    return "Invalid argument";
        case FrameRingErrorCode::MappingFailed:      return "Failed to create/open file mapping";
        case FrameRingErrorCode::ViewFailed:         return "Failed to map view of file";
        case FrameRingErrorCode::SlotOverflow:       return "Computed slot offset overflow";
        case FrameRingErrorCode::SessionMismatch:    return "Session GUID mismatch between slots";
        case FrameRingErrorCode::NotInitialized:     return "Frame ring not initialized";
        case FrameRingErrorCode::AlreadyInitialized: return "Frame ring already initialized";
        case FrameRingErrorCode::EventFailed:        return "Failed to create event object";
        case FrameRingErrorCode::SessionGuidFailed:  return "Failed to generate session GUID";
    }
    return "Unknown error";
}

// ─── FrameRing ────────────────────────────────────────────────────────────────
//
// Manages a Win32 named file mapping with fixed three-slot layout.
// Each slot has a 128-byte header + configurable payload region.
//
class FrameRing {
public:
    FrameRing();
    ~FrameRing();

    // Non-copyable; movable
    FrameRing(const FrameRing&) = delete;
    FrameRing& operator=(const FrameRing&) = delete;
    FrameRing(FrameRing&& other) noexcept;
    FrameRing& operator=(FrameRing&& other) noexcept;

    /// Create a NEW file mapping with a random session GUID.
    /// @param mappingName  Base name (without "Local\\" prefix).
    /// @param slotPayloadSize  Size of each slot's payload region.
    /// @returns error code or None on success.
    FrameRingErrorCode Create(std::string_view mappingName,
                              size_t slotPayloadSize = kDefaultSlotPayloadSize);

    /// Open an EXISTING file mapping and validate its session GUID.
    /// @param mappingName  Base name (without "Local\\" prefix).
    /// @param expectedSessionGuid  Expected session GUID (all slots must match).
    /// @returns error code or None on success.
    FrameRingErrorCode Open(std::string_view mappingName,
                            const uint8_t* expectedSessionGuid);

    /// Close the mapping and all associated handles.
    void Close();

    bool IsValid() const { return m_mapping != nullptr && m_view != nullptr; }

    // ─── Accessors ────────────────────────────────────────────────────────

    const std::string& Name() const { return m_name; }
    size_t SlotPayloadSize() const { return m_slotPayloadSize; }
    uint32_t SlotCount() const { return kSlotCount; }
    const uint8_t* SessionGuid() const { return m_sessionGuid; }

    /// Full file mapping name including "Local\\" prefix.
    const std::string& FullMappingName() const { return m_fullName; }

    // ─── Slot operations ──────────────────────────────────────────────────

    /// Get a pointer to the slot header.
    SlotHeader*       GetSlotHeader(uint32_t slotIndex);
    const SlotHeader* GetSlotHeader(uint32_t slotIndex) const;

    /// Get a pointer to the slot payload region.
    uint8_t*       GetSlotPayload(uint32_t slotIndex);
    const uint8_t* GetSlotPayload(uint32_t slotIndex) const;

    /// Copy data into a slot's payload region.
    /// Returns bytes written (clamped to payloadSize).
    /// Sets dataSize in the header.
    size_t WriteSlot(uint32_t slotIndex, const uint8_t* data, size_t size);

    /// Set the FRAME_READY flag on a slot.
    void SetFrameReady(uint32_t slotIndex);

    /// Validate that all slots have the same session GUID.
    bool ValidateAllSlots() const;

    /// Validate that a specific slot has the expected session GUID.
    bool ValidateSlotSession(uint32_t slotIndex) const;

    // ─── Statics ──────────────────────────────────────────────────────────

    /// Fill a 16-byte buffer with a random UUID (via UuidCreate).
    static FrameRingErrorCode GenerateSessionGuid(uint8_t* guidOut);

    /// Convert binary session GUID to lowercase hex string (32 chars).
    static std::string SessionGuidToString(const uint8_t* guid);

    /// Parse 32-char hex string into 16-byte binary GUID.
    static bool StringToSessionGuid(std::string_view hexStr, uint8_t* guidOut);

private:
    std::string m_name;        // User-facing name (no prefix)
    std::string m_fullName;    // Full name with "Local\\" prefix
    HANDLE      m_mapping = nullptr;
    void*       m_view    = nullptr;
    size_t      m_totalSize         = 0;
    size_t      m_slotPayloadSize   = kDefaultSlotPayloadSize;
    uint8_t     m_sessionGuid[kSessionGuidBytes] = {};

    uint8_t* SlotBase(uint32_t slotIndex);
    const uint8_t* SlotBase(uint32_t slotIndex) const;
    size_t SlotTotalSize() const { return kHeaderSize + m_slotPayloadSize; }

    FrameRingErrorCode ValidateSlotIndex(uint32_t slotIndex) const;
    FrameRingErrorCode CheckInitialized() const;
};

} // namespace screenlink::framering
