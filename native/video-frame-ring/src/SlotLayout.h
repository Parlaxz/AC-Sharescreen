#pragma once

#include <cstdint>
#include <cstddef>

namespace screenlink::framering {

// ─── Protocol version ─────────────────────────────────────────────────────────
// Encoded as 0xMMmmPP (major.minor.patch)
inline constexpr uint32_t kProtocolVersion = 0x00010000; // 1.0.0

// Magic identifier: "FR" + 0x01 0x00 (little-endian word = 0x01524602)
// In memory: 0x02, 0x46, 0x52, 0x01
inline constexpr uint32_t kMagic = 0x01524602u;

// ─── Slot geometry ────────────────────────────────────────────────────────────
inline constexpr uint32_t kSlotCount = 3;
inline constexpr size_t   kHeaderSize = 128;
inline constexpr size_t   kDefaultSlotPayloadSize = 4u * 1024u * 1024u; // 4 MiB

// Named slot indices
inline constexpr uint32_t kSlotInputA  = 0;
inline constexpr uint32_t kSlotInputB  = 1;
inline constexpr uint32_t kSlotOutput  = 2;

// ─── Slot flags ───────────────────────────────────────────────────────────────
inline constexpr uint32_t kFlagFrameReady = 1u << 0;
inline constexpr uint32_t kFlagSignalled  = 1u << 1;
inline constexpr uint32_t kFlagCorrupted  = 1u << 2;

// ─── Session GUID size ────────────────────────────────────────────────────────
inline constexpr size_t kSessionGuidBytes = 16;

// ─── File mapping prefix ──────────────────────────────────────────────────────
inline constexpr const char* kMappingNamePrefix = "Local\\";
inline constexpr const char* kMappingNameBase  = "ScreenLink-FrameRing-";

// ─── Per-slot header (packed, 128 bytes) ──────────────────────────────────────
#pragma pack(push, 1)
struct SlotHeader {
    uint32_t version;                       // Protocol version (kProtocolVersion)
    uint32_t magic;                         // Magic identifier (kMagic)
    uint8_t  sessionGuid[kSessionGuidBytes]; // Random session identifier
    uint32_t slotIndex;                     // 0, 1, or 2 — must match slot position
    uint32_t payloadSize;                   // Capacity of the payload region in bytes
    uint32_t dataSize;                      // Actual valid data written to payload
    uint32_t flags;                         // Bitmask (kFlag* constants)
    uint8_t  reserved[88];                  // Pad to 128 bytes total
};
static_assert(sizeof(SlotHeader) == kHeaderSize, "SlotHeader must be exactly 128 bytes");
#pragma pack(pop)

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Total number of bytes needed for the file mapping.
inline size_t TotalMappingSize(size_t payloadSize) {
    return static_cast<size_t>(kSlotCount) * (kHeaderSize + payloadSize);
}

/// Byte offset of a slot within the mapping.
inline size_t SlotByteOffset(uint32_t slotIndex, size_t payloadSize) {
    return static_cast<size_t>(slotIndex) * (kHeaderSize + payloadSize);
}

} // namespace screenlink::framering
