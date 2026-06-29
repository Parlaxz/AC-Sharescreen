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

NvVfxResult NvidiaVfxContext::RunFrame() {
    return NvVfxResult::kErrorNotCompiled;
}

void NvidiaVfxContext::Destroy() {
    initialized_ = false;
    effectCreated_ = false;
    effectLoaded_ = false;
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

    const unsigned int quality =
        static_cast<unsigned int>(std::clamp(config_.strength, 0, 4));

    status = NvVFX_SetU32(effect, NVVFX_QUALITY_LEVEL, quality);
    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage(
            "NvVFX_SetU32(QualityLevel)",
            status);
        return NvVfxResult::kErrorEffectLoad;
    }

    status = NvVFX_Load(effect);
    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage(
            "NvVFX_Load(VideoSuperRes)",
            status);
        return NvVfxResult::kErrorEffectLoad;
    }

    effectLoaded_ = true;
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::AllocateInput(const NvVfxImage& desc) {
    if (!effectCreated_) {
        lastError_ = "CreateEffect must succeed before AllocateInput";
        return NvVfxResult::kErrorInvalidInput;
    }

    inputDesc_ = desc;
    inputDesc_.stride = inputDesc_.width * 4;
    inputBuffer_.assign(
        static_cast<size_t>(inputDesc_.stride) * inputDesc_.height,
        0);

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

    const auto* src = static_cast<const uint8_t*>(srcPixels);
    auto* dst = inputBuffer_.data();
    const uint32_t dstStride = inputDesc_.stride;

    if (srcFormat == inputDesc_.format) {
        for (uint32_t y = 0; y < srcHeight; ++y) {
            std::memcpy(
                dst + static_cast<size_t>(y) * dstStride,
                src + static_cast<size_t>(y) * srcStride,
                static_cast<size_t>(srcWidth) * 4);
        }
    }
    else {
        for (uint32_t y = 0; y < srcHeight; ++y) {
            for (uint32_t x = 0; x < srcWidth; ++x) {
                const size_t srcOffset =
                    static_cast<size_t>(y) * srcStride +
                    static_cast<size_t>(x) * 4;
                const size_t dstOffset =
                    static_cast<size_t>(y) * dstStride +
                    static_cast<size_t>(x) * 4;

                dst[dstOffset + 0] = src[srcOffset + 2];
                dst[dstOffset + 1] = src[srcOffset + 1];
                dst[dstOffset + 2] = src[srcOffset + 0];
                dst[dstOffset + 3] = src[srcOffset + 3];
            }
        }
    }

    NvCVImage cpuInput;
    NvCV_Status status = NvCVImage_Init(
        &cpuInput,
        inputDesc_.width,
        inputDesc_.height,
        inputDesc_.stride,
        inputBuffer_.data(),
        ToNvFormat(inputDesc_.format),
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
        nullptr,
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

    const NvCV_Status status =
        NvVFX_Run(reinterpret_cast<NvVFX_Handle>(effect_), 0);

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

    status = NvCVImage_Transfer(
        static_cast<NvCVImage*>(outputImage_),
        &cpuOutput,
        1.0f,
        nullptr,
        nullptr);

    if (status != NVCV_SUCCESS) {
        lastError_ = StatusMessage(
            "NvCVImage_Transfer(GPU to CPU)",
            status);
        return NvVfxResult::kErrorInvalidOutput;
    }

    outWidth = outputDesc_.width;
    outHeight = outputDesc_.height;
    return NvVfxResult::kSuccess;
}

void NvidiaVfxContext::Destroy() {
    effectLoaded_ = false;

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
