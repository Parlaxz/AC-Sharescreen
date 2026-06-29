#pragma once

#include <algorithm>
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
    int32_t strength = 1;
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

    std::string GetLastError() const { return lastError_; }

    static bool IsCompiled();
    static std::string FindSdkRoot();
    static std::string FindModelDir(const std::string& sdkRoot);

    void Destroy();

private:
    bool initialized_ = false;
    bool effectCreated_ = false;
    bool effectLoaded_ = false;
    std::string lastError_;

#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
    void* effect_ = nullptr;
    void* inputImage_ = nullptr;
    void* outputImage_ = nullptr;

    NvVfxConfig config_;
    NvVfxImage inputDesc_;
    NvVfxImage outputDesc_;
    std::vector<uint8_t> inputBuffer_;

    NvVfxResult CreateSuperResEffect();
    NvVfxResult LoadConfiguredEffect();
    NvVfxResult AllocateNvImage(void*& imagePtr, const NvVfxImage& desc);
    void FreeNvImage(void*& imagePtr);
#endif
};

} // namespace screenlink::video
