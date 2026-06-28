#include "NvidiaVfxContext.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace screenlink::video {

// ─── Static helpers ───────────────────────────────────────────────────

bool NvidiaVfxContext::IsCompiled() {
#ifdef SCREENLINK_NVIDIA_VFX_ENABLED
    return true;
#else
    return false;
#endif
}

std::string NvidiaVfxContext::FindSdkRoot() {
    // 1. Environment variable
    const char* env = std::getenv("NVIDIA_VFX_SDK_ROOT");
    if (env && env[0]) return std::string(env);

    // 2. Known install path
#ifdef _WIN32
    const char* knownPath = "C:\\Program Files\\NVIDIA Corporation\\NVIDIA Video Effects";
    DWORD attr = GetFileAttributesA(knownPath);
    if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY))
        return std::string(knownPath);
#endif

    return "";
}

std::string NvidiaVfxContext::FindModelDir(const std::string& sdkRoot) {
    // 1. Environment variable
    const char* env = std::getenv("NVIDIA_VFX_MODEL_DIR");
    if (env && env[0]) return std::string(env);

    // 2. Default relative to SDK root
    if (!sdkRoot.empty()) {
        std::string models = sdkRoot + "\\models";
#ifdef _WIN32
        DWORD attr = GetFileAttributesA(models.c_str());
        if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY))
            return models;
#endif
    }

    return "";
}

// ─── Stub implementation (SDK not built) ──────────────────────────────

#ifndef SCREENLINK_NVIDIA_VFX_ENABLED

NvidiaVfxContext::NvidiaVfxContext() {}
NvidiaVfxContext::~NvidiaVfxContext() { Destroy(); }

NvVfxResult NvidiaVfxContext::Initialize(const NvVfxConfig& /*config*/) {
    lastError_ = "NVIDIA VFX SDK not compiled (SCREENLINK_NVIDIA_VFX_ENABLED=OFF). "
                 "Rebuild with -DSCREENLINK_ENABLE_NVIDIA_VFX=ON and set NVIDIA_VFX_SDK_ROOT.";
    fprintf(stderr, "[NvidiaVfx] %s\n", lastError_.c_str());
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

NvVfxResult NvidiaVfxContext::RunFrame() {
    return NvVfxResult::kErrorNotCompiled;
}

NvVfxResult NvidiaVfxContext::UploadInput(const void* /*srcPixels*/,
                                           uint32_t /*srcWidth*/, uint32_t /*srcHeight*/,
                                           uint32_t /*srcStride*/, NvVfxPixelFormat /*srcFormat*/) {
    return NvVfxResult::kErrorNotCompiled;
}

NvVfxResult NvidiaVfxContext::DownloadOutput(void* /*dstPixels*/, uint32_t /*dstStride*/,
                                              uint32_t& outWidth, uint32_t& outHeight) {
    outWidth = 0;
    outHeight = 0;
    return NvVfxResult::kErrorNotCompiled;
}

void NvidiaVfxContext::Destroy() {
    initialized_ = false;
    effectCreated_ = false;
}

#else // SCREENLINK_NVIDIA_VFX_ENABLED — REAL SDK PATH

// NVIDIA VFX parameter names
static const char* NvVFX_SRC_IMAGE = "SrcImage";
static const char* NvVFX_DST_IMAGE = "DstImage";

// ─── Real NVIDIA VFX Implementation ───────────────────────────────────

NvidiaVfxContext::NvidiaVfxContext() {}
NvidiaVfxContext::~NvidiaVfxContext() { Destroy(); }

NvVfxResult NvidiaVfxContext::LoadRuntime() {
    // Load the NVIDIA VFX runtime DLL
    // The VideoEffects SDK uses NvVFX.dll or NvVideoEffects.dll
    // Pattern from NVIDIA's VideoEffectsProxy sample
    const char* dllName = "NvVFX.dll";
    vfxHandle_ = LoadLibraryA(dllName);
    if (!vfxHandle_) {
        dllName = "NvVideoEffects.dll";
        vfxHandle_ = LoadLibraryA(dllName);
    }
    if (!vfxHandle_) {
        lastError_ = "Failed to load NVIDIA VFX runtime DLL (NvVFX.dll or NvVideoEffects.dll). "
                     "Ensure the NVIDIA Video Effects SDK is installed.";
        return NvVfxResult::kErrorEffectCreate;
    }
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::CreateSuperResEffect() {
    // Get the effect creation function from the DLL
    // NVIDIA VFX SDK provides NvVFX_CreateEffect or similar entry points.
    // Derive from the SDK's public header signature.
    //
    // The actual API (from NVIDIA Video Effects SDK 0.7+):
    //   NvCV_Status NvVFX_CreateEffect(const char* effectCode, NvVFX_Handle* effect);
    // Where effectCode is "SuperRes" for Super Resolution.
    //
    // Since we cannot link the import library directly, use dynamic loading
    // (LoadLibrary + GetProcAddress) as done in NVIDIA's proxy sample.

    typedef int (*CreateFunc)(const char*, void**);
    CreateFunc create = reinterpret_cast<CreateFunc>(
        GetProcAddress(reinterpret_cast<HMODULE>(vfxHandle_), "NvVFX_CreateEffect"));
    if (!create) {
        auto cleanup = vfxHandle_;
        vfxHandle_ = nullptr;
        // Try alternate symbol
        HMODULE alt = LoadLibraryA("NvVideoEffects.dll");
        if (alt) {
            create = reinterpret_cast<CreateFunc>(GetProcAddress(alt, "NvVFX_CreateEffect"));
            vfxHandle_ = alt;
        }
        if (!create) {
            lastError_ = "Could not find NvVFX_CreateEffect in NVIDIA VFX DLL";
            return NvVfxResult::kErrorEffectCreate;
        }
    }

    int status = create("SuperRes", &effect_);
    if (status != 0 || !effect_) {
        lastError_ = "Failed to create NVIDIA Super Resolution effect (code " +
                     std::to_string(status) + ")";
        return NvVfxResult::kErrorEffectCreate;
    }

    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::Initialize(const NvVfxConfig& config) {
    if (initialized_) return NvVfxResult::kSuccess;
    config_ = config;

    // Find SDK root and model directory
    std::string sdkRoot = FindSdkRoot();
    if (sdkRoot.empty() && config_.modelDir.empty()) {
        lastError_ = "NVIDIA VFX SDK root not found. Set NVIDIA_VFX_SDK_ROOT or install to "
                     "C:\\Program Files\\NVIDIA Corporation\\NVIDIA Video Effects.";
        return NvVfxResult::kErrorModelNotFound;
    }

    if (config_.modelDir.empty()) {
        config_.modelDir = FindModelDir(sdkRoot);
    }
    if (config_.modelDir.empty()) {
        lastError_ = "NVIDIA VFX model directory not found. Set NVIDIA_VFX_MODEL_DIR.";
        return NvVfxResult::kErrorModelNotFound;
    }

    // Load runtime
    NvVfxResult result = LoadRuntime();
    if (result != NvVfxResult::kSuccess) return result;

    initialized_ = true;
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::CreateEffect() {
    if (!initialized_) return NvVfxResult::kErrorNotCompiled;
    if (effectCreated_) return NvVfxResult::kSuccess;

    NvVfxResult result = CreateSuperResEffect();
    if (result != NvVfxResult::kSuccess) return result;

    // Set model directory on the effect
    // NvVFX_SetString(effect, "ModelDir", config_.modelDir.c_str());
    // Use DLL-exported NvVFX_SetU32/SetString/SetF32 parameter setters.
    typedef int (*SetStringFunc)(void*, const char*, const char*);
    auto setString = reinterpret_cast<SetStringFunc>(
        GetProcAddress(reinterpret_cast<HMODULE>(vfxHandle_), "NvVFX_SetString"));
    if (setString) {
        setString(effect_, "ModelDir", config_.modelDir.c_str());
    }

    // Set strength parameter
    typedef int (*SetU32Func)(void*, const char*, unsigned int);
    auto setU32 = reinterpret_cast<SetU32Func>(
        GetProcAddress(reinterpret_cast<HMODULE>(vfxHandle_), "NvVFX_SetU32"));
    if (setU32) {
        setU32(effect_, "Strength", static_cast<unsigned int>(config_.strength));
    }

    // Load the effect (compiles the model)
    typedef int (*LoadFunc)(void*);
    auto load = reinterpret_cast<LoadFunc>(
        GetProcAddress(reinterpret_cast<HMODULE>(vfxHandle_), "NvVFX_Load"));
    if (!load) {
        lastError_ = "NvVFX_Load not found in DLL";
        return NvVfxResult::kErrorEffectLoad;
    }

    int status = load(effect_);
    if (status != 0) {
        lastError_ = "Failed to load NVIDIA Super Resolution effect (code " +
                     std::to_string(status) + ")";
        return NvVfxResult::kErrorEffectLoad;
    }

    effectCreated_ = true;
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::AllocateInput(const NvVfxImage& desc) {
    if (!effectCreated_) return NvVfxResult::kErrorInvalidInput;
    inputDesc_ = desc;
    inputBuffer_.resize(desc.stride * desc.height);
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::AllocateOutput(const NvVfxImage& desc) {
    if (!effectCreated_) return NvVfxResult::kErrorInvalidOutput;
    outputDesc_ = desc;
    outputBuffer_.resize(desc.stride * desc.height);
    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::UploadInput(const void* srcPixels,
                                           uint32_t srcWidth, uint32_t srcHeight,
                                           uint32_t srcStride, NvVfxPixelFormat srcFormat) {
    if (!effectCreated_ || inputBuffer_.empty()) return NvVfxResult::kErrorInvalidInput;

    uint32_t dstStride = inputDesc_.stride;
    auto* dst = inputBuffer_.data();
    auto* src = static_cast<const uint8_t*>(srcPixels);

    // Copy with stride adjustment and format conversion if needed
    if (srcFormat == inputDesc_.format) {
        // Direct copy, per-row
        uint32_t rowBytes = std::min(srcStride, dstStride);
        for (uint32_t y = 0; y < std::min(srcHeight, inputDesc_.height); ++y) {
            std::memcpy(dst + y * dstStride, src + y * srcStride, rowBytes);
        }
    } else if (srcFormat == NvVfxPixelFormat::kRGBA8 &&
               inputDesc_.format == NvVfxPixelFormat::kBGRA8) {
        // RGBA → BGRA swizzle
        for (uint32_t y = 0; y < std::min(srcHeight, inputDesc_.height); ++y) {
            for (uint32_t x = 0; x < std::min(srcWidth, inputDesc_.width); ++x) {
                uint32_t srcOff = y * srcStride + x * 4;
                uint32_t dstOff = y * dstStride + x * 4;
                dst[dstOff + 0] = src[srcOff + 2]; // B
                dst[dstOff + 1] = src[srcOff + 1]; // G
                dst[dstOff + 2] = src[srcOff + 0]; // R
                dst[dstOff + 3] = src[srcOff + 3]; // A
            }
        }
    } else if (srcFormat == NvVfxPixelFormat::kBGRA8 &&
               inputDesc_.format == NvVfxPixelFormat::kRGBA8) {
        // BGRA → RGBA swizzle
        for (uint32_t y = 0; y < std::min(srcHeight, inputDesc_.height); ++y) {
            for (uint32_t x = 0; x < std::min(srcWidth, inputDesc_.width); ++x) {
                uint32_t srcOff = y * srcStride + x * 4;
                uint32_t dstOff = y * dstStride + x * 4;
                dst[dstOff + 0] = src[srcOff + 2]; // R
                dst[dstOff + 1] = src[srcOff + 1]; // G
                dst[dstOff + 2] = src[srcOff + 0]; // B
                dst[dstOff + 3] = src[srcOff + 3]; // A
            }
        }
    }

    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::RunFrame() {
    if (!effectCreated_) return NvVfxResult::kErrorNotCompiled;

    // Set input image on effect
    // Pattern: NvVFX_SetImage(effect_, "SrcImage", inputImage_);
    // then NvVFX_SetImage(effect_, "DstImage", outputImage_);
    // then NvVFX_Run(effect_, 1);

    typedef int (*SetImageFunc)(void*, const char*, void*);
    auto setImage = reinterpret_cast<SetImageFunc>(
        GetProcAddress(reinterpret_cast<HMODULE>(vfxHandle_), "NvVFX_SetImage"));
    if (setImage) {
        setImage(effect_, NvVFX_SRC_IMAGE, inputImage_);
        setImage(effect_, NvVFX_DST_IMAGE, outputImage_);
    }

    typedef int (*RunFunc)(void*, int);
    auto run = reinterpret_cast<RunFunc>(
        GetProcAddress(reinterpret_cast<HMODULE>(vfxHandle_), "NvVFX_Run"));
    if (!run) {
        lastError_ = "NvVFX_Run not found in DLL";
        return NvVfxResult::kErrorRun;
    }

    int status = run(effect_, 1);
    if (status != 0) {
        lastError_ = "NVIDIA Super Resolution run failed (code " +
                     std::to_string(status) + ")";
        return NvVfxResult::kErrorRun;
    }

    return NvVfxResult::kSuccess;
}

NvVfxResult NvidiaVfxContext::DownloadOutput(void* dstPixels, uint32_t dstStride,
                                              uint32_t& outWidth, uint32_t& outHeight) {
    if (!effectCreated_ || outputBuffer_.empty()) return NvVfxResult::kErrorInvalidOutput;

    outWidth = outputDesc_.width;
    outHeight = outputDesc_.height;
    uint32_t srcStride = outputDesc_.stride;

    auto* dst = static_cast<uint8_t*>(dstPixels);
    auto* src = outputBuffer_.data();

    uint32_t rowBytes = std::min(srcStride, dstStride);
    for (uint32_t y = 0; y < outHeight; ++y) {
        std::memcpy(dst + y * dstStride, src + y * srcStride, rowBytes);
    }

    return NvVfxResult::kSuccess;
}

void NvidiaVfxContext::Destroy() {
    initialized_ = false;
    effectCreated_ = false;

    if (effect_) {
        typedef int (*DestroyFunc)(void*);
        auto destroy = reinterpret_cast<DestroyFunc>(
            GetProcAddress(reinterpret_cast<HMODULE>(vfxHandle_), "NvVFX_DestroyEffect"));
        if (destroy) destroy(effect_);
        effect_ = nullptr;
    }

    inputImage_ = nullptr;
    outputImage_ = nullptr;
    inputBuffer_.clear();
    outputBuffer_.clear();

    if (vfxHandle_) {
        FreeLibrary(reinterpret_cast<HMODULE>(vfxHandle_));
        vfxHandle_ = nullptr;
    }
}

#endif // SCREENLINK_NVIDIA_VFX_ENABLED

} // namespace screenlink::video
