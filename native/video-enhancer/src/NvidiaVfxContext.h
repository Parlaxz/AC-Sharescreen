#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <memory>
#include <algorithm>

namespace screenlink::video {

/// Result code for VFX operations
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

/// Pixel format for image resources
enum class NvVfxPixelFormat : uint32_t {
    kRGBA8 = 0,
    kBGRA8 = 1,
};

/// Image resource descriptor
struct NvVfxImage {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t stride = 0;       // bytes per row
    NvVfxPixelFormat format = NvVfxPixelFormat::kRGBA8;
    void* pixels = nullptr;     // owned externally
};

/// Configuration for Super Resolution effect
struct NvVfxConfig {
    std::string modelDir;       // path to NVIDIA VFX model directory
    int32_t strength = 1;       // 0-4 (0=lightest, 4=strongest)
    float sharpness = 0.5f;    // 0.0-1.0
};

/// Context for the NVIDIA Video Effects SDK Super Resolution.
/// Manages effect lifecycle, image resources, and frame processing.
/// When SDK is not compiled (SCREENLINK_NVIDIA_VFX_ENABLED off),
/// all methods return kErrorNotCompiled.
class NvidiaVfxContext {
public:
    NvidiaVfxContext();
    ~NvidiaVfxContext();

    NvidiaVfxContext(const NvidiaVfxContext&) = delete;
    NvidiaVfxContext& operator=(const NvidiaVfxContext&) = delete;

    /// Initialize context and load the NVIDIA VFX runtime.
    /// Returns kSuccess only when SDK is compiled and loaded.
    NvVfxResult Initialize(const NvVfxConfig& config);

    /// Create the Super Resolution effect.
    /// Must be called after Initialize succeeds.
    NvVfxResult CreateEffect();

    /// Allocate input image resource matching the source frame.
    NvVfxResult AllocateInput(const NvVfxImage& desc);

    /// Allocate output image resource matching the requested upscale.
    NvVfxResult AllocateOutput(const NvVfxImage& desc);

    /// Run Super Resolution on the input frame, producing output.
    /// Input pixels must already be copied into the allocated input resource.
    NvVfxResult RunFrame();

    /// Copy raw input pixels into the allocated input resource.
    /// Handles BGRA8↔RGBA8 conversion if format differs.
    NvVfxResult UploadInput(const void* srcPixels,
                            uint32_t srcWidth, uint32_t srcHeight,
                            uint32_t srcStride, NvVfxPixelFormat srcFormat);

    /// Copy processed output pixels out of the output resource.
    NvVfxResult DownloadOutput(void* dstPixels, uint32_t dstStride,
                               uint32_t& outWidth, uint32_t& outHeight);

    /// Get the last error message for diagnostics.
    std::string GetLastError() const { return lastError_; }

    /// Returns true if the SDK was compiled into this build.
    static bool IsCompiled();

    /// Discover SDK root from environment or known install paths.
    static std::string FindSdkRoot();

    /// Discover model directory from environment or SDK install.
    static std::string FindModelDir(const std::string& sdkRoot);

    /// Release all NVIDIA resources.
    void Destroy();

private:
    bool initialized_ = false;
    bool effectCreated_ = false;
    std::string lastError_;

#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
    // Real NVIDIA VFX SDK handles (opaque)
    // Pattern derived from NVIDIA VideoEffects SDK samples
    void* vfxHandle_ = nullptr;           // loaded DLL handle
    void* effect_ = nullptr;              // NvVFX effect handle
    void* inputImage_ = nullptr;          // NvCVImage input
    void* outputImage_ = nullptr;         // NvCVImage output
    NvVfxConfig config_;
    NvVfxImage inputDesc_;
    NvVfxImage outputDesc_;
    std::vector<uint8_t> inputBuffer_;
    std::vector<uint8_t> outputBuffer_;

    NvVfxResult LoadRuntime();
    NvVfxResult CreateSuperResEffect();
    NvVfxResult AllocateNvImage(void* imagePtr, const NvVfxImage& desc);
    void FreeNvImage();
#endif
};

} // namespace screenlink::video
