#include "SharedFrameRing.h"
#include <cstdio>
#include <string>

namespace screenlink::video {

// ─── Path helper ──────────────────────────────────────────────────────

std::string BuildSharedMemoryPath(const std::string& sessionId) {
    // Use SYSTEM temp directory
    char tmpBuf[MAX_PATH + 1] = {};
    DWORD len = GetTempPathA(MAX_PATH, tmpBuf);
    if (len == 0 || len > MAX_PATH) {
        // Fallback to current directory
        return "screenlink-shm-" + sessionId + ".bin";
    }
    return std::string(tmpBuf) + "screenlink-shm-" + sessionId + ".bin";
}

// ─── Destructor ─────────────────────────────────────────────────────────

SharedFrameRing::~SharedFrameRing() {
    Close();
}

// ─── Create / Close ───────────────────────────────────────────────────

bool SharedFrameRing::Create(const std::string& sessionId) {
    if (IsValid()) Close();

    sessionId_ = sessionId;
    filePath_ = BuildSharedMemoryPath(sessionId);

    // Delete any stale file from a previous session
    DeleteFileA(filePath_.c_str());

    // Create the backing file.  Use FILE_ATTRIBUTE_TEMPORARY +
    // FILE_FLAG_DELETE_ON_CLOSE hints to keep data in cache and
    // auto-clean on last handle close.
    fileHandle_ = CreateFileA(
        filePath_.c_str(),
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,  // main process opens RW too
        nullptr,                              // default security
        CREATE_ALWAYS,                        // always fresh
        FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE,
        nullptr
    );

    if (fileHandle_ == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "[SharedFrameRing] CreateFileA failed: %lu\n", GetLastError());
        return false;
    }

    // Set file size to accommodate the full ring
    LARGE_INTEGER fileSize;
    fileSize.QuadPart = static_cast<LONGLONG>(kRingTotalSize);
    if (!SetFilePointerEx(fileHandle_, fileSize, nullptr, FILE_BEGIN)) {
        fprintf(stderr, "[SharedFrameRing] SetFilePointerEx failed: %lu\n", GetLastError());
        Close();
        return false;
    }
    if (!SetEndOfFile(fileHandle_)) {
        fprintf(stderr, "[SharedFrameRing] SetEndOfFile failed: %lu\n", GetLastError());
        Close();
        return false;
    }

    // Create file mapping
    mappingHandle_ = CreateFileMappingA(
        fileHandle_,
        nullptr,                         // default security
        PAGE_READWRITE,
        0,                               // max size high
        static_cast<DWORD>(kRingTotalSize), // max size low (fits in 32-bit: ~190 MB)
        nullptr                          // unnamed (no need; main opens by file)
    );

    if (!mappingHandle_) {
        fprintf(stderr, "[SharedFrameRing] CreateFileMappingA failed: %lu\n", GetLastError());
        Close();
        return false;
    }

    // Map the entire file into our address space
    mappedView_ = MapViewOfFile(
        mappingHandle_,
        FILE_MAP_ALL_ACCESS,
        0, 0,
        kRingTotalSize
    );

    if (!mappedView_) {
        fprintf(stderr, "[SharedFrameRing] MapViewOfFile failed: %lu\n", GetLastError());
        Close();
        return false;
    }

    // Zero-initialize the entire ring
    memset(mappedView_, 0, kRingTotalSize);

    printf("[SharedFrameRing] Created: %s (%zu bytes)\n", filePath_.c_str(), kRingTotalSize);
    return true;
}

void SharedFrameRing::Close() {
    if (mappedView_) {
        UnmapViewOfFile(mappedView_);
        mappedView_ = nullptr;
    }
    if (mappingHandle_) {
        CloseHandle(mappingHandle_);
        mappingHandle_ = nullptr;
    }
    if (fileHandle_ != INVALID_HANDLE_VALUE) {
        CloseHandle(fileHandle_);
        fileHandle_ = INVALID_HANDLE_VALUE;
    }
    // FILE_FLAG_DELETE_ON_CLOSE handles cleanup of the temp file.
}

// ─── Slot access ──────────────────────────────────────────────────────

RingSlotLayout* SharedFrameRing::Slot(uint32_t slotIndex) {
    if (!mappedView_) return nullptr;
    if (slotIndex >= kRingSlotCount) return nullptr;

    auto* base = static_cast<uint8_t*>(mappedView_);
    size_t offset = static_cast<size_t>(slotIndex) * kSlotSize;
    return reinterpret_cast<RingSlotLayout*>(base + offset);
}

uint32_t SharedFrameRing::FindEmptySlot() {
    for (uint32_t i = 0; i < kRingSlotCount; ++i) {
        auto* slot = Slot(i);
        if (slot && slot->control == static_cast<uint32_t>(SlotState::kEmpty)) {
            return i;
        }
    }
    return kRingSlotCount; // none found
}

} // namespace screenlink::video
