#include "NvidiaVsrContext.h"
#include <cstring>
#include <algorithm>
#include <cstdio>

namespace screenlink::video {

// ─── CPU-staging bilinear upscaler ────────────────────────────────────

/// Bilinear interpolation for a single pixel channel.
static uint8_t Lerp(uint8_t a, uint8_t b, float t) {
    return static_cast<uint8_t>(static_cast<float>(a) + (static_cast<float>(b) - static_cast<float>(a)) * t);
}

/// Perform a simple bilinear upscale from source to destination.
/// Both buffers are RGBA8 (4 bytes per pixel).
static void BilinearUpscale(const uint8_t* src, uint32_t srcW, uint32_t srcH,
                            uint8_t* dst, uint32_t dstW, uint32_t dstH) {
    for (uint32_t dy = 0; dy < dstH; ++dy) {
        // Map destination Y to source Y as float
        float srcYf = (static_cast<float>(dy) + 0.5f) * static_cast<float>(srcH) / static_cast<float>(dstH) - 0.5f;
        if (srcYf < 0.0f) srcYf = 0.0f;
        if (srcYf > static_cast<float>(srcH) - 1.001f) srcYf = static_cast<float>(srcH) - 1.001f;

        uint32_t srcY0 = static_cast<uint32_t>(srcYf);
        uint32_t srcY1 = std::min(srcY0 + 1, srcH - 1);
        float ty = srcYf - static_cast<float>(srcY0);

        for (uint32_t dx = 0; dx < dstW; ++dx) {
            float srcXf = (static_cast<float>(dx) + 0.5f) * static_cast<float>(srcW) / static_cast<float>(dstW) - 0.5f;
            if (srcXf < 0.0f) srcXf = 0.0f;
            if (srcXf > static_cast<float>(srcW) - 1.001f) srcXf = static_cast<float>(srcW) - 1.001f;

            uint32_t srcX0 = static_cast<uint32_t>(srcXf);
            uint32_t srcX1 = std::min(srcX0 + 1, srcW - 1);
            float tx = srcXf - static_cast<float>(srcX0);

            // Sample 4 pixels
            const uint8_t* p00 = src + (srcY0 * srcW + srcX0) * 4;
            const uint8_t* p10 = src + (srcY0 * srcW + srcX1) * 4;
            const uint8_t* p01 = src + (srcY1 * srcW + srcX0) * 4;
            const uint8_t* p11 = src + (srcY1 * srcW + srcX1) * 4;

            uint8_t* out = dst + (dy * dstW + dx) * 4;

            for (int c = 0; c < 4; ++c) {
                float top = static_cast<float>(Lerp(p00[c], p10[c], tx));
                float bot = static_cast<float>(Lerp(p01[c], p11[c], tx));
                out[c] = static_cast<uint8_t>(top + (bot - top) * ty);
            }
        }
    }
}

// ─── NvidiaVsrContext implementation ──────────────────────────────────

bool NvidiaVsrContext::Initialize(uint32_t inputW, uint32_t inputH,
                                   uint32_t outputW, uint32_t outputH) {
    inputWidth_ = inputW;
    inputHeight_ = inputH;
    outputWidth_ = outputW;
    outputHeight_ = outputH;
    initialized_ = true;
    printf("[NvidiaVsrContext] Initialized (CPU staging): %ux%u -> %ux%u\n",
           inputW, inputH, outputW, outputH);
    return true;
}

void NvidiaVsrContext::Shutdown() {
    if (initialized_) {
        printf("[NvidiaVsrContext] Shutdown\n");
    }
    initialized_ = false;
}

bool NvidiaVsrContext::ProcessFrame(const void* inputData, uint32_t inputSize,
                                     void* outputData, uint32_t outputSize) {
    if (!initialized_) return false;

    // Validate sizes
    uint32_t expectedInput = inputWidth_ * inputHeight_ * 4;
    uint32_t expectedOutput = outputWidth_ * outputHeight_ * 4;

    if (inputSize < expectedInput || outputSize < expectedOutput) {
        fprintf(stderr, "[NvidiaVsrContext] Buffer size mismatch: "
                "input %u/%u, output %u/%u\n",
                inputSize, expectedInput, outputSize, expectedOutput);
        return false;
    }

    // CPU-staging: bilinear upscale
    // Phase 7+: Replace with actual NVIDIA VSR SDK call
    BilinearUpscale(
        static_cast<const uint8_t*>(inputData), inputWidth_, inputHeight_,
        static_cast<uint8_t*>(outputData), outputWidth_, outputHeight_
    );

    return true;
}

} // namespace screenlink::video
