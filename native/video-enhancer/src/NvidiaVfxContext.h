#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace screenlink::video {

enum class NvVfxResult : int32_t {
    kSuccess = 0,
    kErrorEffectCreate = -1,
    kErrorEffectLoad = -2,
    kErrorModelNotFound = -3,
    kErrorInvalidInput = -4,
    kErrorInvalidOutput = -5,
    kErrorRun = -6,
    kErrorNotCompiled = -7,
};

enum class NvVfxPixelFormat : uint32_t {
    kRGBA8 = 0,
    kBGRA8 = 1,
};

struct NvVfxImage {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t stride = 0;
    NvVfxPixelFormat format = NvVfxPixelFormat::kRGBA8;
    void* pixels = nullptr;
};

struct NvVfxConfig {
    std::string modelDir;
    /// Canonical QualityLevel encoding mode+quality:
    ///   VSR         1..4   (low..ultra)
    ///   Denoise     8..11
    ///   Deblur     12..15
    ///   High-Bitrate 16..19
    int32_t qualityLevel = 3;
    float sharpness = 0.5f;
};

class NvidiaVfxContext {
public:
    NvidiaVfxContext();
    ~NvidiaVfxContext();

    NvidiaVfxContext(const NvidiaVfxContext&) = delete;
    NvidiaVfxContext& operator=(const NvidiaVfxContext&) = delete;

    NvVfxResult Initialize(const NvVfxConfig& config);
    NvVfxResult CreateEffect();
    NvVfxResult AllocateInput(const NvVfxImage& desc);
    NvVfxResult AllocateOutput(const NvVfxImage& desc);
    NvVfxResult RunFrame();

    NvVfxResult UploadInput(
        const void* srcPixels,
        uint32_t srcWidth,
        uint32_t srcHeight,
        uint32_t srcStride,
        NvVfxPixelFormat srcFormat);

    NvVfxResult DownloadOutput(
        void* dstPixels,
        uint32_t dstStride,
        uint32_t& outWidth,
        uint32_t& outHeight);

    /// Get pointer to GPU-resident output buffer (for native presenter path).
    /// Returns nullptr if output image is not GPU-resident or not allocated.
    void* GetOutputGpuPointer();

    std::string GetLastError() const { return lastError_; }

    static bool IsCompiled();
    static std::string FindSdkRoot();
    static std::string FindModelDir(const std::string& sdkRoot);

    void Destroy();

    /// Number of times effect has been (re)loaded via LoadConfiguredEffect.
    /// Monotonically increasing; resets to 0 on Destroy.
    uint32_t effectLoadCount() const { return effectLoadCount_; }

    // -- Slice 6: Persistent resource and allocation counters --
    // Always available; return 0 when VFX support is not compiled in.

    /// Total allocations performed at configuration/setup time
    /// (CUDA stream, effect handle, GPU images, pinned buffers, staging).
    uint64_t configAllocations() const {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
        return configAllocations_;
#else
        return 0;
#endif
    }

    /// Allocations during frame processing (should be 0 in optimized steady state).
    uint64_t steadyStateAllocations() const {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
        return steadyStateAllocations_;
#else
        return 0;
#endif
    }

    /// Total bytes of page-locked (pinned) host memory allocated.
    uint64_t pinnedBytes() const {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
        return pinnedBytes_;
#else
        return 0;
#endif
    }

    /// How many times the persistent staging buffer has been passed to
    /// NvCVImage_Transfer (measures staging reuse across upload + download).
    uint64_t stagingReuseCount() const {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
        return stagingReuseCount_;
#else
        return 0;
#endif
    }

    /// How many times the persistent pinned input buffer has been reused
    /// without reallocation (equals number of UploadInput calls after setup).
    uint64_t inputSlotReuseCount() const {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
        return inputSlotReuseCount_;
#else
        return 0;
#endif
    }

    /// How many times the persistent pinned output fallback buffer has been
    /// reused without reallocation (equals number of DownloadOutput calls).
    uint64_t outputFallbackSlotReuseCount() const {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
        return outputFallbackSlotReuseCount_;
#else
        return 0;
#endif
    }

    /// Number of CPU-side downloads (DownloadOutput calls).
    uint64_t cpuDownloadCount() const {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
        return cpuDownloadCount_;
#else
        return 0;
#endif
    }

    /// Total number of NvidiaVfxContext instances alive.
    /// Always available; returns 0 when VFX support is not compiled in.
    static uint32_t contextCount() {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
        return contextCount_.load();
#else
        return 0;
#endif
    }

private:
    bool initialized_ = false;
    bool effectCreated_ = false;
    bool effectLoaded_ = false;
    uint32_t effectLoadCount_ = 0;
    std::string lastError_;

#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
    void* effect_ = nullptr;
    void* inputImage_ = nullptr;
    void* outputImage_ = nullptr;

    NvVfxConfig config_;
    NvVfxImage inputDesc_;
    NvVfxImage outputDesc_;
    /// Persistent CUDA stream for upload/run/download sequencing
    void* cudaStream_ = nullptr;

    // -- Slice 6: Persistent resources --
    /// Persistent staging buffer for NvCVImage_Transfer (replaces nullptr).
    /// SDK reshapes internally as needed; avoids per-frame ephemeral allocation.
    void* staging_ = nullptr;

    /// Fixed page-locked (pinned) CPU input buffer.
    /// CPU input data stays here across frames; then transferred to GPU input image.
    void* pinnedInput_ = nullptr;

    /// Fixed pinned CPU output fallback buffer.
    /// Used only when the native presenter (GPU→display) is unavailable.
    void* pinnedOutput_ = nullptr;

    // -- Slice 6: Allocation/resource counters --
    uint64_t configAllocations_ = 0;
    uint64_t steadyStateAllocations_ = 0;
    uint64_t pinnedBytes_ = 0;
    uint64_t stagingReuseCount_ = 0;
    uint64_t inputSlotReuseCount_ = 0;
    uint64_t outputFallbackSlotReuseCount_ = 0;
    uint64_t cpuDownloadCount_ = 0;

    static std::atomic<uint32_t> contextCount_;

    NvVfxResult CreateSuperResEffect();
    NvVfxResult LoadConfiguredEffect();
    NvVfxResult AllocateNvImage(void*& imagePtr, const NvVfxImage& desc);
    void FreeNvImage(void*& imagePtr);
    NvVfxResult AllocatePinnedInput(const NvVfxImage& desc);
    NvVfxResult AllocatePinnedOutput(const NvVfxImage& desc);
    void FreePinnedResources();
#endif
};

} // namespace screenlink::video
