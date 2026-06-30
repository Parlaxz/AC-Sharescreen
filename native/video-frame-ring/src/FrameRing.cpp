#include "FrameRing.h"
#include "SlotLayout.h"

#include <algorithm>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <string>

#include <rpc.h>   // UuidCreate
#include <rpcdce.h>

#pragma comment(lib, "rpcrt4.lib")

namespace slfr = screenlink::framering;

// ─── Construction / destruction ───────────────────────────────────────────────

slfr::FrameRing::FrameRing() = default;

slfr::FrameRing::~FrameRing() {
    Close();
}

slfr::FrameRing::FrameRing(FrameRing&& other) noexcept
    : m_name(std::move(other.m_name))
    , m_fullName(std::move(other.m_fullName))
    , m_mapping(other.m_mapping)
    , m_view(other.m_view)
    , m_totalSize(other.m_totalSize)
    , m_slotPayloadSize(other.m_slotPayloadSize)
{
    std::memcpy(m_sessionGuid, other.m_sessionGuid, kSessionGuidBytes);
    other.m_mapping = nullptr;
    other.m_view = nullptr;
    other.m_totalSize = 0;
    other.m_slotPayloadSize = kDefaultSlotPayloadSize;
    std::memset(other.m_sessionGuid, 0, kSessionGuidBytes);
}

slfr::FrameRing& slfr::FrameRing::operator=(FrameRing&& other) noexcept {
    if (this != &other) {
        Close();
        m_name = std::move(other.m_name);
        m_fullName = std::move(other.m_fullName);
        m_mapping = other.m_mapping;
        m_view = other.m_view;
        m_totalSize = other.m_totalSize;
        m_slotPayloadSize = other.m_slotPayloadSize;
        std::memcpy(m_sessionGuid, other.m_sessionGuid, kSessionGuidBytes);

        other.m_mapping = nullptr;
        other.m_view = nullptr;
        other.m_totalSize = 0;
        other.m_slotPayloadSize = kDefaultSlotPayloadSize;
        std::memset(other.m_sessionGuid, 0, kSessionGuidBytes);
    }
    return *this;
}

// ─── Create / Open / Close ────────────────────────────────────────────────────

slfr::FrameRingErrorCode slfr::FrameRing::Create(
    std::string_view mappingName, size_t slotPayloadSize)
{
    if (IsValid()) {
        return FrameRingErrorCode::AlreadyInitialized;
    }
    if (mappingName.empty()) {
        return FrameRingErrorCode::InvalidArgument;
    }

    // Compute mapping size with overflow check
    size_t slotTotal = kHeaderSize + slotPayloadSize;
    size_t totalSize = kSlotCount * slotTotal;
    if (slotTotal < kHeaderSize) { // overflow in slotTotal
        return FrameRingErrorCode::SlotOverflow;
    }
    if (totalSize / kSlotCount != slotTotal) { // overflow in totalSize
        return FrameRingErrorCode::SlotOverflow;
    }

    // Generate session GUID
    FrameRingErrorCode guidErr = GenerateSessionGuid(m_sessionGuid);
    if (guidErr != FrameRingErrorCode::None) {
        return guidErr;
    }

    // Build full mapping name
    m_name = mappingName;
    m_fullName = std::string(kMappingNamePrefix) + std::string(kMappingNameBase) + m_name;

    // Create file mapping
    ULARGE_INTEGER ulSize;
    ulSize.QuadPart = static_cast<ULONGLONG>(totalSize);

    m_mapping = CreateFileMappingW(
        INVALID_HANDLE_VALUE,
        nullptr,
        PAGE_READWRITE,
        ulSize.HighPart,
        ulSize.LowPart,
        std::wstring(m_fullName.begin(), m_fullName.end()).c_str()
    );

    if (!m_mapping) {
        m_mapping = nullptr;
        m_name.clear();
        m_fullName.clear();
        return FrameRingErrorCode::MappingFailed;
    }

    // Map view
    m_view = MapViewOfFile(
        m_mapping,
        FILE_MAP_ALL_ACCESS,
        0, 0,
        totalSize
    );

    if (!m_view) {
        CloseHandle(m_mapping);
        m_mapping = nullptr;
        m_name.clear();
        m_fullName.clear();
        return FrameRingErrorCode::ViewFailed;
    }

    m_totalSize = totalSize;
    m_slotPayloadSize = slotPayloadSize;

    // Initialize all slot headers
    for (uint32_t i = 0; i < kSlotCount; ++i) {
        SlotHeader* hdr = GetSlotHeader(i);
        if (!hdr) {
            Close();
            return FrameRingErrorCode::SlotOverflow;
        }
        std::memset(hdr, 0, sizeof(SlotHeader));
        hdr->version     = kProtocolVersion;
        hdr->magic       = kMagic;
        hdr->slotIndex   = i;
        hdr->payloadSize = static_cast<uint32_t>(slotPayloadSize);
        hdr->dataSize    = 0;
        hdr->flags       = 0;
        std::memcpy(hdr->sessionGuid, m_sessionGuid, kSessionGuidBytes);
    }

    return FrameRingErrorCode::None;
}

slfr::FrameRingErrorCode slfr::FrameRing::Open(
    std::string_view mappingName, const uint8_t* expectedSessionGuid)
{
    if (IsValid()) {
        return FrameRingErrorCode::AlreadyInitialized;
    }
    if (mappingName.empty() || !expectedSessionGuid) {
        return FrameRingErrorCode::InvalidArgument;
    }

    m_name = mappingName;
    m_fullName = std::string(kMappingNamePrefix) + std::string(kMappingNameBase) + m_name;

    // Open existing file mapping
    m_mapping = OpenFileMappingW(
        FILE_MAP_ALL_ACCESS,
        FALSE,
        std::wstring(m_fullName.begin(), m_fullName.end()).c_str()
    );

    if (!m_mapping) {
        m_name.clear();
        m_fullName.clear();
        return FrameRingErrorCode::MappingFailed;
    }

    // Map view to read header first (discover size)
    // Map 1 page first to read header info
    m_view = MapViewOfFile(
        m_mapping,
        FILE_MAP_ALL_ACCESS,
        0, 0,
        kHeaderSize  // map just the first slot header to discover size
    );

    if (!m_view) {
        CloseHandle(m_mapping);
        m_mapping = nullptr;
        m_name.clear();
        m_fullName.clear();
        return FrameRingErrorCode::ViewFailed;
    }

    // Read header to discover payload size
    const SlotHeader* hdr0 = static_cast<const SlotHeader*>(m_view);
    if (hdr0->magic != kMagic || hdr0->version != kProtocolVersion) {
        UnmapViewOfFile(m_view);
        m_view = nullptr;
        CloseHandle(m_mapping);
        m_mapping = nullptr;
        m_name.clear();
        m_fullName.clear();
        return FrameRingErrorCode::SessionMismatch; // protocol mismatch
    }

    m_slotPayloadSize = hdr0->payloadSize;
    std::memcpy(m_sessionGuid, hdr0->sessionGuid, kSessionGuidBytes);

    // Validate expected session GUID
    if (std::memcmp(m_sessionGuid, expectedSessionGuid, kSessionGuidBytes) != 0) {
        UnmapViewOfFile(m_view);
        m_view = nullptr;
        CloseHandle(m_mapping);
        m_mapping = nullptr;
        m_name.clear();
        m_fullName.clear();
        return FrameRingErrorCode::SessionMismatch;
    }

    // Re-map full view
    UnmapViewOfFile(m_view);

    size_t slotTotal = kHeaderSize + m_slotPayloadSize;
    size_t totalSize = kSlotCount * slotTotal;
    if (slotTotal < kHeaderSize || totalSize / kSlotCount != slotTotal) {
        CloseHandle(m_mapping);
        m_mapping = nullptr;
        m_name.clear();
        m_fullName.clear();
        return FrameRingErrorCode::SlotOverflow;
    }

    ULARGE_INTEGER ulSize;
    ulSize.QuadPart = 0; // 0 = map the entire file

    m_view = MapViewOfFile(
        m_mapping,
        FILE_MAP_ALL_ACCESS,
        0, 0,
        totalSize
    );

    if (!m_view) {
        CloseHandle(m_mapping);
        m_mapping = nullptr;
        m_name.clear();
        m_fullName.clear();
        return FrameRingErrorCode::ViewFailed;
    }

    m_totalSize = totalSize;

    // Validate all slots
    if (!ValidateAllSlots()) {
        Close();
        return FrameRingErrorCode::SessionMismatch;
    }

    return FrameRingErrorCode::None;
}

void slfr::FrameRing::Close() {
    if (m_view) {
        UnmapViewOfFile(m_view);
        m_view = nullptr;
    }
    if (m_mapping) {
        CloseHandle(m_mapping);
        m_mapping = nullptr;
    }
    m_name.clear();
    m_fullName.clear();
    m_totalSize = 0;
    m_slotPayloadSize = kDefaultSlotPayloadSize;
    std::memset(m_sessionGuid, 0, kSessionGuidBytes);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

slfr::FrameRingErrorCode slfr::FrameRing::ValidateSlotIndex(uint32_t slotIndex) const {
    if (slotIndex >= kSlotCount) {
        return FrameRingErrorCode::InvalidArgument;
    }
    return FrameRingErrorCode::None;
}

slfr::FrameRingErrorCode slfr::FrameRing::CheckInitialized() const {
    if (!IsValid()) {
        return FrameRingErrorCode::NotInitialized;
    }
    return FrameRingErrorCode::None;
}

uint8_t* slfr::FrameRing::SlotBase(uint32_t slotIndex) {
    if (slotIndex >= kSlotCount) return nullptr;
    size_t offset = SlotByteOffset(slotIndex, m_slotPayloadSize);
    // Check overflow
    if (offset + kHeaderSize > m_totalSize) return nullptr;
    return static_cast<uint8_t*>(m_view) + offset;
}

const uint8_t* slfr::FrameRing::SlotBase(uint32_t slotIndex) const {
    if (slotIndex >= kSlotCount) return nullptr;
    size_t offset = SlotByteOffset(slotIndex, m_slotPayloadSize);
    if (offset + kHeaderSize > m_totalSize) return nullptr;
    return static_cast<const uint8_t*>(m_view) + offset;
}

// ─── Slot access ──────────────────────────────────────────────────────────────

slfr::SlotHeader* slfr::FrameRing::GetSlotHeader(uint32_t slotIndex) {
    uint8_t* base = SlotBase(slotIndex);
    return base ? reinterpret_cast<SlotHeader*>(base) : nullptr;
}

const slfr::SlotHeader* slfr::FrameRing::GetSlotHeader(uint32_t slotIndex) const {
    const uint8_t* base = SlotBase(slotIndex);
    return base ? reinterpret_cast<const SlotHeader*>(base) : nullptr;
}

uint8_t* slfr::FrameRing::GetSlotPayload(uint32_t slotIndex) {
    uint8_t* base = SlotBase(slotIndex);
    return base ? base + kHeaderSize : nullptr;
}

const uint8_t* slfr::FrameRing::GetSlotPayload(uint32_t slotIndex) const {
    const uint8_t* base = SlotBase(slotIndex);
    return base ? base + kHeaderSize : nullptr;
}

// ─── Operations ───────────────────────────────────────────────────────────────

size_t slfr::FrameRing::WriteSlot(uint32_t slotIndex, const uint8_t* data, size_t size) {
    SlotHeader* hdr = GetSlotHeader(slotIndex);
    uint8_t* payload = GetSlotPayload(slotIndex);
    if (!hdr || !payload || !data) return 0;

    size_t toWrite = (std::min)(size, m_slotPayloadSize);
    std::memcpy(payload, data, toWrite);
    hdr->dataSize = static_cast<uint32_t>(toWrite);
    return toWrite;
}

void slfr::FrameRing::SetFrameReady(uint32_t slotIndex) {
    SlotHeader* hdr = GetSlotHeader(slotIndex);
    if (!hdr) return;
    hdr->flags |= kFlagFrameReady;
}

bool slfr::FrameRing::ValidateAllSlots() const {
    for (uint32_t i = 0; i < kSlotCount; ++i) {
        if (!ValidateSlotSession(i)) return false;
    }
    return true;
}

bool slfr::FrameRing::ValidateSlotSession(uint32_t slotIndex) const {
    const SlotHeader* hdr = GetSlotHeader(slotIndex);
    if (!hdr) return false;
    if (hdr->magic != kMagic) return false;
    if (hdr->version != kProtocolVersion) return false;
    if (hdr->slotIndex != slotIndex) return false;
    if (std::memcmp(hdr->sessionGuid, m_sessionGuid, kSessionGuidBytes) != 0) return false;
    return true;
}

// ─── Statics ──────────────────────────────────────────────────────────────────

slfr::FrameRingErrorCode slfr::FrameRing::GenerateSessionGuid(uint8_t* guidOut) {
    UUID uuid;
    RPC_STATUS status = UuidCreate(&uuid);
    if (status != RPC_S_OK && status != RPC_S_UUID_LOCAL_ONLY) {
        return FrameRingErrorCode::SessionGuidFailed;
    }
    std::memcpy(guidOut, &uuid, kSessionGuidBytes);
    return FrameRingErrorCode::None;
}

std::string slfr::FrameRing::SessionGuidToString(const uint8_t* guid) {
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (size_t i = 0; i < kSessionGuidBytes; ++i) {
        oss << std::setw(2) << static_cast<int>(guid[i]);
    }
    return oss.str();
}

bool slfr::FrameRing::StringToSessionGuid(std::string_view hexStr, uint8_t* guidOut) {
    if (hexStr.size() != kSessionGuidBytes * 2) return false;
    for (size_t i = 0; i < kSessionGuidBytes; ++i) {
        char hi = hexStr[i * 2];
        char lo = hexStr[i * 2 + 1];
        auto hexChar = [](char c) -> uint8_t {
            if (c >= '0' && c <= '9') return static_cast<uint8_t>(c - '0');
            if (c >= 'a' && c <= 'f') return static_cast<uint8_t>(c - 'a' + 10);
            if (c >= 'A' && c <= 'F') return static_cast<uint8_t>(c - 'A' + 10);
            return 0xFF;
        };
        uint8_t hiV = hexChar(hi);
        uint8_t loV = hexChar(lo);
        if (hiV == 0xFF || loV == 0xFF) return false;
        guidOut[i] = static_cast<uint8_t>((hiV << 4) | loV);
    }
    return true;
}
