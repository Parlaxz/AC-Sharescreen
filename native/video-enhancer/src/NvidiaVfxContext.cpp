#include "NvidiaVfxContext.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>

#ifdef _WIN32
#include <windows.h>
#endif

#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
#include "nvCVImage.h"
#include "nvVideoEffects.h"
#include "nvVFXVideoSuperRes.h"
#endif

#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
// Required by NVIDIA's nvVideoEffectsProxy.cpp.
// nullptr makes the proxy use the normal Windows DLL search path.
char* g_nvVFXSDKPath = nullptr;
#endif

namespace screenlink::video {

namespace {

bool DirectoryExists(const std::string& path) {
#ifdef _WIN32
    if (path.empty()) {
        return false;
    }

    const DWORD attributes = GetFileAttributesA(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
           (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
#else
    return false;
#endif
}

#ifdef SCREENLINK_NVIDIA_VFX_ENABLED

NvCVImage_PixelFormat ToNvFormat(NvVfxPixelFormat format) {
    return format == NvVfxPixelFormat::kBGRA8 ? NVCV_BGRA : NVCV_RGBA;
}

std::string StatusMessage(const char* operation, NvCV_Status status) {
    return std::string(operation) + " failed with code " +
           std::to_string(static_cast<int>(status));
}

#endif

} // namespace

bool NvidiaVfxContext::IsCompiled() {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
    return true;
#else
    return false;
#endif
}

std::string NvidiaVfxContext::FindSdkRoot() {
    const char* environmentRoot = std::getenv("NVIDIA_VFX_SDK_ROOT");
    if (environmentRoot && environmentRoot[0] != '\0') {
        return std::string(environmentRoot);
    }

#ifdef SCREENLINK_NVIDIA_VFX_SDK_ROOT
    const std::string compiledRoot = SCREENLINK_NVIDIA_VFX_SDK_ROOT;
    if (!compiledRoot.empty()) {
        return compiledRoot;
    }
#endif

#ifdef _WIN32
    const std::string knownPath =
        "C:\\Program Files\\NVIDIA Corporation\\NVIDIA Video Effects";

    if (DirectoryExists(knownPath)) {
        return knownPath;
    }
#endif

    return {};
}

std::string NvidiaVfxContext::FindModelDir(const std::string& sdkRoot) {
    const char* environmentModels = std::getenv("NVIDIA_VFX_MODEL_DIR");
    if (environmentModels && environmentModels[0] != '\0') {
        return std::string(environmentModels);
    }

#ifdef SCREENLINK_NVIDIA_VFX_MODEL_DIR
    const std::string compiledModels = SCREENLINK_NVIDIA_VFX_MODEL_DIR;
    if (!compiledModels.empty()) {
        return compiledModels;
    }
#endif

    if (!sdkRoot.empty()) {
#ifdef _WIN32
        const std::string candidate = sdkRoot + "\\bin\\models";
#else
        const std::string candidate = sdkRoot + "/bin/models";
#endif
        if (DirectoryExists(candidate)) {
            return candidate;
        }
    }

    return {};
}

NvidiaVfxContext::NvidiaVfxContext() = default;

NvidiaVfxContext::~NvidiaVfxContext() {
    Destroy();
}

#ifndef SCREENLINK_NVIDIA_VFX_ENABLED

NvVfxResult NvidiaVfxContext::Initialize(const NvVfxConfig& /*config*/) {
    lastError_ =
        "NVIDIA VFX SDK not compiled. Rebuild with "
        "-DSCREENLINK_ENABLE_NVIDIA_VFX=ON.";
    return NvVfxResult::kErrorNotCompiled;
}

NvVfxResult NvidiaVfxContext::CreateEffect() {
    return NvVfxResult::kErrorNotCompiled;
}

NvVfxResult NvidiaVfxContext::AllocateInput(const NvVfxImage& /*desc*/) {
    return NvVfxResult::kErrorNotCompiled;
}

NvVfxResult NvidiaVfxContext::AllocateOutput(const NvVfxImage& /*desc*/) {
    return NvVfxResult::kErrorNotCompiled;
}

NvVfxResult NvidiaVfxContext::UploadInput(
    const void* /*srcPixels*/,
    uint32_t /*srcWidth*/,
    uint32_t /*srcHeight*/,
    uint32_t /*srcStride*/,
    NvVfxPixelFormat /*srcFormat*/) {
    return NvVfxResult::kErrorNotCompiled;
}

NvVfxResult NvidiaVfxContext::DownloadOutput(
    void* /*dstPixels*/,
    uint32_t /*dstStride*/,
    uint32_t& /*outWidth*/,
    uint32_t& /*outHeight*/) {
    return NvVfxResult::kErrorNotCompiled;
}

void* NvidiaVfxContext::GetOutputGpuPointer() {
    return nullptr;
}

NvVfxResult NvidiaVfxContext::RunFrame() {
    return NvVfxResult::kErrorNotCompiled;
}

void NvidiaVfxContext::Destroy() {
    initialized_ = false;
    effectCreated_ = false;
    effectLoaded_ = false;
    effectLoadCount_ = 0;
}

#else

NvVfxResult NvidiaVfxContext::Initialize(const NvVfxConfig& config) {
    if (initialized_) {
        return NvVfxResult::kSuccess;
    }

    config_ = config;

    if (config_.modelDir.empty()) {
        config_.modelDir = FindModelDir(FindSdkRoot());
    }

    // Create persistent CUDA stream for upload/run/download sequencing
    if (!cudaStream_) {
        NvCV_Status streamStatus = NvVFX_CudaStreamCreate(
            reinterpret_cast<CUstream*>(&cudaStream_));
        if (streamStatus != NVCV_SUCCESS) {
            lastError_ = StatusMessage("NvVFX_CudaStreamCreate", streamStatus);
            // Nonfatal — will use default stream if unavailable
            cudaStream_ = nullptr;
        }
    }

    initialized_ = true;
    lastError_.clear();
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::CreateSuperResEffect() {
    if (effect_) {
        return NvVfxResult::kSuccess;
    }

    NvVFX_Handle effect = nullptr;
    const NvCV_Status status =
        NvVFX_CreateEffect(NVVFX_FX_VIDEO_SUPER_RES, &effect);

    if (status != NVCV_SUCCESS || !effect) {
        lastError_ = StatusMessage(
            "NvVFX_CreateEffect(VideoSuperRes)",
            status);
        return NvVfxResult::kErrorEffectCreate;
    }

    effect_ = effect;
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::CreateEffect() {
    if (!initialized_) {
        lastError_ = "NVIDIA VFX context is not initialized";
        return NvVfxResult::kErrorNotCompiled;
    }

    if (effectCreated_) {
        return NvVfxResult::kSuccess;
    }

    const NvVfxResult result = CreateSuperResEffect();
    if (result != NvVfxResult::kSuccess) {
        return result;
    }

    effectCreated_ = true;
    effectLoaded_ = false;
    return NvVfxResult::kSuccess;
}

void NvidiaVfxContext::FreeNvImage(void*& imagePtr) {
    if (!imagePtr) {
        return;
    }

    auto* image = static_cast<NvCVImage*>(imagePtr);
    delete image;
    imagePtr = nullptr;
}

NvVfxResult NvidiaVfxContext::AllocateNvImage(
    void*& imagePtr,
    const NvVfxImage& desc) {
    if (desc.width == 0 || desc.height == 0) {
        lastError_ = "Cannot allocate a zero-sized NVIDIA image";
        return NvVfxResult::kErrorInvalidInput;
    }

    FreeNvImage(imagePtr);

    auto* image = new (std::nothrow) NvCVImage();
    if (!image) {
        lastError_ = "Could not allocate an NvCVImage descriptor";
        return NvVfxResult::kErrorInvalidInput;
    }

    const NvCV_Status status = NvCVImage_Alloc(
        image,
        desc.width,
        desc.height,
        ToNvFormat(desc.format),
        NVCV_U8,
        NVCV_INTERLEAVED,
        NVCV_GPU,
        1);

    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage("NvCVImage_Alloc", status);
        delete image;
        return NvVfxResult::kErrorInvalidInput;
    }

    imagePtr = image;
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::LoadConfiguredEffect() {
    if (effectLoaded_) {
        return NvVfxResult::kSuccess;
    }

    if (!effectCreated_ || !inputImage_ || !outputImage_) {
        return NvVfxResult::kSuccess;
    }

    const auto effect = reinterpret_cast<NvVFX_Handle>(effect_);
    auto* inputImage = static_cast<NvCVImage*>(inputImage_);
    auto* outputImage = static_cast<NvCVImage*>(outputImage_);

    NvCV_Status status =
        NvVFX_SetImage(effect, NVVFX_INPUT_IMAGE, inputImage);

    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage("NvVFX_SetImage(input)", status);
        return NvVfxResult::kErrorEffectLoad;
    }

    status = NvVFX_SetImage(effect, NVVFX_OUTPUT_IMAGE, outputImage);
    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage("NvVFX_SetImage(output)", status);
        return NvVfxResult::kErrorEffectLoad;
    }

    // Validate canonical QualityLevel: 1..4, 8..11, 12..15, 16..19
    const int32_t ql = config_.qualityLevel;
    const bool valid =
        (ql >= 1 && ql <= 4) ||
        (ql >= 8 && ql <= 11) ||
        (ql >= 12 && ql <= 15) ||
        (ql >= 16 && ql <= 19);
    if (!valid) {
        lastError_ = "Invalid canonical QualityLevel: " + std::to_string(ql) +
                     ". Valid ranges: 1..4 (VSR), 8..11 (Denoise), "
                     "12..15 (Deblur), 16..19 (High-Bitrate)";
        return NvVfxResult::kErrorEffectLoad;
    }

    const unsigned int quality = static_cast<unsigned int>(ql);

    status = NvVFX_SetU32(effect, NVVFX_QUALITY_LEVEL, quality);
    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage(
            "NvVFX_SetU32(QualityLevel)",
            status);
        return NvVfxResult::kErrorEffectLoad;
    }

    // Bind the persistent CUDA stream to this effect BEFORE NvVFX_Load
    if (cudaStream_) {
        status = NvVFX_SetCudaStream(effect, NVVFX_CUDA_STREAM,
            reinterpret_cast<CUstream>(cudaStream_));
        if (status != NVCV_SUCCESS) {
            lastError_ = StatusMessage("NvVFX_SetCudaStream", status);
            return NvVfxResult::kErrorEffectLoad;
        }
    }

    status = NvVFX_Load(effect);
    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage(
            "NvVFX_Load(VideoSuperRes)",
            status);
        return NvVfxResult::kErrorEffectLoad;
    }

    effectLoaded_ = true;
    effectLoadCount_++;
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::AllocateInput(const NvVfxImage& desc) {
    if (!effectCreated_) {
        lastError_ = "CreateEffect must succeed before AllocateInput";
        return NvVfxResult::kErrorInvalidInput;
    }

    inputDesc_ = desc;
    inputDesc_.stride = inputDesc_.width * 4;

    effectLoaded_ = false;

    const NvVfxResult allocation = AllocateNvImage(inputImage_, inputDesc_);
    if (allocation != NvVfxResult::kSuccess) {
        return allocation;
    }

    return LoadConfiguredEffect();
}

NvVfxResult NvidiaVfxContext::AllocateOutput(const NvVfxImage& desc) {
    if (!effectCreated_) {
        lastError_ = "CreateEffect must succeed before AllocateOutput";
        return NvVfxResult::kErrorInvalidOutput;
    }

    outputDesc_ = desc;
    outputDesc_.stride = outputDesc_.width * 4;
    effectLoaded_ = false;

    const NvVfxResult allocation = AllocateNvImage(outputImage_, outputDesc_);
    if (allocation != NvVfxResult::kSuccess) {
        return NvVfxResult::kErrorInvalidOutput;
    }

    return LoadConfiguredEffect();
}

NvVfxResult NvidiaVfxContext::UploadInput(
    const void* srcPixels,
    uint32_t srcWidth,
    uint32_t srcHeight,
    uint32_t srcStride,
    NvVfxPixelFormat srcFormat) {
    if (!effectLoaded_ || !inputImage_ || !srcPixels) {
        lastError_ = "VSR input is not ready";
        return NvVfxResult::kErrorInvalidInput;
    }

    if (srcWidth != inputDesc_.width ||
        srcHeight != inputDesc_.height ||
        srcStride < srcWidth * 4) {
        lastError_ = "Input frame dimensions or stride do not match AllocateInput";
        return NvVfxResult::kErrorInvalidInput;
    }

    // Direct-wrap the incoming RGBA CPU buffer. The backing storage must
    // remain valid until stream sync completes (via the sync point in RunFrame).
    NvCVImage cpuInput;
    NvCV_Status status = NvCVImage_Init(
        &cpuInput,
        srcWidth,
        srcHeight,
        srcStride,
        const_cast<void*>(srcPixels),
        ToNvFormat(srcFormat),
        NVCV_U8,
        NVCV_INTERLEAVED,
        NVCV_CPU);

    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage("NvCVImage_Init(input)", status);
        return NvVfxResult::kErrorInvalidInput;
    }

    status = NvCVImage_Transfer(
        &cpuInput,
        static_cast<NvCVImage*>(inputImage_),
        1.0f,
        reinterpret_cast<CUstream>(cudaStream_),
        nullptr);

    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage(
            "NvCVImage_Transfer(CPU to GPU)",
            status);
        return NvVfxResult::kErrorInvalidInput;
    }

    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::RunFrame() {
    if (!effectLoaded_) {
        lastError_ = "NVIDIA Video Super Resolution effect is not loaded";
        return NvVfxResult::kErrorRun;
    }

    // Use the persistent CUDA stream for the run (parameter = 1 means streamed).
    // The stream sequences upload (from UploadInput's NvCVImage_Transfer) then
    // this GPU effect run. Synchronization happens after download transfer completes.
    const NvCV_Status status =
        NvVFX_Run(reinterpret_cast<NvVFX_Handle>(effect_), 1);

    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage(
            "NvVFX_Run(VideoSuperRes)",
            status);
        return NvVfxResult::kErrorRun;
    }

    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::DownloadOutput(
    void* dstPixels,
    uint32_t dstStride,
    uint32_t& outWidth,
    uint32_t& outHeight) {
    if (!effectLoaded_ || !outputImage_ || !dstPixels) {
        lastError_ = "VSR output is not ready";
        return NvVfxResult::kErrorInvalidOutput;
    }

    if (dstStride < outputDesc_.width * 4) {
        lastError_ = "Output stride is too small";
        return NvVfxResult::kErrorInvalidOutput;
    }

    NvCVImage cpuOutput;
    NvCV_Status status = NvCVImage_Init(
        &cpuOutput,
        outputDesc_.width,
        outputDesc_.height,
        dstStride,
        dstPixels,
        ToNvFormat(outputDesc_.format),
        NVCV_U8,
        NVCV_INTERLEAVED,
        NVCV_CPU);

    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage("NvCVImage_Init(output)", status);
        return NvVfxResult::kErrorInvalidOutput;
    }

    // Download GPU→CPU on the persistent CUDA stream
    status = NvCVImage_Transfer(
        static_cast<NvCVImage*>(outputImage_),
        &cpuOutput,
        1.0f,
        reinterpret_cast<CUstream>(cudaStream_),
        nullptr);

    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage(
            "NvCVImage_Transfer(GPU to CPU)",
            status);
        return NvVfxResult::kErrorInvalidOutput;
    }

    // Synchronize the CUDA stream to ensure upload → run → download all complete
    // before CPU reads the output pixel buffer.
    if (cudaStream_) {
        NvCV_Status syncStatus = NvVFX_CudaStreamSynchronize(
            reinterpret_cast<CUstream>(cudaStream_));
        if (syncStatus != NVCV_SUCCESS) {
            lastError_ = StatusMessage("NvVFX_CudaStreamSynchronize", syncStatus);
            return NvVfxResult::kErrorRun;
        }
    }

    outWidth = outputDesc_.width;
    outHeight = outputDesc_.height;
    return NvVfxResult::kSuccess;
}

void* NvidiaVfxContext::GetOutputGpuPointer() {
    if (!effectLoaded_ || !outputImage_) {
        return nullptr;
    }
    // NvCVImage allocated with NVCV_GPU has its pixels in CUDA device memory.
    // The pixels field is a CUDA device pointer accessible from the same CUDA
    // context used by the NVIDIA VFX SDK.
    auto* image = static_cast<NvCVImage*>(outputImage_);
    if (image->pixels) {
        return image->pixels;
    }
    return nullptr;
}

void NvidiaVfxContext::Destroy() {
    effectLoaded_ = false;
    effectLoadCount_ = 0;

    if (cudaStream_) {
        NvVFX_CudaStreamDestroy(reinterpret_cast<CUstream>(cudaStream_));
        cudaStream_ = nullptr;
    }

    if (effect_) {
        NvVFX_DestroyEffect(reinterpret_cast<NvVFX_Handle>(effect_));
        effect_ = nullptr;
    }

    FreeNvImage(inputImage_);
    FreeNvImage(outputImage_);

    inputBuffer_.clear();
    inputDesc_ = {};
    outputDesc_ = {};
    config_ = {};

    effectCreated_ = false;
    initialized_ = false;
    lastError_.clear();
}

#endif

} // namespace screenlink::video
