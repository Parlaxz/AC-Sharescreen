#pragma once
#include <cstdint>
#include <string>

namespace screenlink::video {

/// Encapsulates the NVIDIA VSR SDK context.
/// Phase 7+ will implement actual NVIDIA VSR SDK integration.
class NvidiaVsrContext {
public:
    NvidiaVsrContext() = default;
    ~NvidiaVsrContext() = default;

    NvidiaVsrContext(const NvidiaVsrContext&) = delete;
    NvidiaVsrContext& operator=(const NvidiaVsrContext&) = delete;

    /// Initialize the VSR context with input and output dimensions.
    bool Initialize(uint32_t inputW, uint32_t inputH, uint32_t outputW, uint32_t outputH);

    /// Shutdown and release all resources.
    void Shutdown();

    /// Process a single frame through the VSR pipeline.
    bool ProcessFrame(const void* inputData, uint32_t inputSize, void* outputData, uint32_t outputSize);

    /// Returns true if the context has been initialized.
    bool IsInitialized() const { return initialized_; }

private:
    bool initialized_ = false;
};

} // namespace screenlink::video
