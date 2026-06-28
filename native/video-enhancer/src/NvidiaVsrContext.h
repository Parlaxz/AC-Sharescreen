#pragma once
#include <cstdint>
#include <string>

namespace screenlink::video {

/// Encapsulates the video processing context.
/// Phase 7: CPU-staging bilinear upscale.
/// Phase 7+: NVIDIA VSR SDK integration.
class NvidiaVsrContext {
public:
    NvidiaVsrContext() = default;
    ~NvidiaVsrContext() = default;

    NvidiaVsrContext(const NvidiaVsrContext&) = delete;
    NvidiaVsrContext& operator=(const NvidiaVsrContext&) = delete;

    /// Initialize the processing context with input and output dimensions.
    bool Initialize(uint32_t inputW, uint32_t inputH,
                    uint32_t outputW, uint32_t outputH);

    /// Shutdown and release all resources.
    void Shutdown();

    /// Process a single frame through the pipeline.
    /// In Phase 7 (CPU-staging), performs bilinear upscale.
    /// In Phase 7+, this will use the NVIDIA VSR SDK.
    bool ProcessFrame(const void* inputData, uint32_t inputSize,
                      void* outputData, uint32_t outputSize);

    /// Returns true if the context has been initialized.
    bool IsInitialized() const { return initialized_; }

private:
    bool initialized_ = false;
    uint32_t inputWidth_ = 0;
    uint32_t inputHeight_ = 0;
    uint32_t outputWidth_ = 0;
    uint32_t outputHeight_ = 0;
};

} // namespace screenlink::video
