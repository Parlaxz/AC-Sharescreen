#pragma once

#include <cstdint>
#include <atomic>
#include <string>
#include <memory>

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>

#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

namespace screenlink::video {

/// Diagnostics counters specific to the native presenter path.
struct PresenterDiagnostics {
    std::atomic<uint64_t> framesPresented{0};
    std::atomic<uint64_t> framesDropped{0};
    std::atomic<uint64_t> presentErrors{0};
    std::atomic<uint64_t> lastPresentUs{0};
    std::atomic<uint64_t> maxPresentUs{0};
    std::atomic<uint64_t> totalPresentUs{0};

    std::atomic<uint32_t> presenterResizes{0};
    std::atomic<uint32_t> presenterAttachCount{0};
    std::atomic<uint32_t> presenterDetachCount{0};

    void RecordPresent(uint64_t elapsedUs, bool success);
    void Reset();
    void RecordResize() { presenterResizes++; }
};

/// Snapshot of presenter diagnostics.
struct PresenterSnapshot {
    uint64_t framesPresented;
    uint64_t framesDropped;
    uint64_t presentErrors;
    uint64_t lastPresentUs;
    uint64_t maxPresentUs;
    uint64_t avgPresentUs;
    uint32_t presenterResizes;
    uint32_t presenterAttachCount;
    uint32_t presenterDetachCount;
    bool active;
};

/// Manages a D3D11 swapchain presenter window for GPU-resident output display.
///
/// The presenter creates a child window of the owner HWND, creates a D3D11
/// device and swapchain, and presents processed frames directly from GPU memory
/// with no CPU roundtrip.
///
/// Window behavior: WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED with
/// WS_CHILD style — non-activating, non-interactable, transparent to input.
class NativePresenter {
public:
    NativePresenter();
    ~NativePresenter();

    NativePresenter(const NativePresenter&) = delete;
    NativePresenter& operator=(const NativePresenter&) = delete;

    /// Attach to the given owner HWND. Creates D3D11 device, swapchain, and
    /// the presenter child window.  Returns true on success.
    bool Attach(HWND ownerHwnd, uint32_t initialWidth, uint32_t initialHeight);

    /// Detach from the owner HWND, destroy presenter window and release
    /// all D3D11 resources. Idempotent.
    void Detach();

    /// Update presenter surface bounds (position and size relative to owner).
    /// The presenter window is resized and repositioned to match.
    void UpdateBounds(int32_t x, int32_t y, uint32_t width, uint32_t height);

    /// Show or hide the presenter window.
    void SetVisible(bool visible);

    /// Present a GPU-resident frame from an external D3D11 texture.
    /// The texture must match our swapchain buffer format (DXGI_FORMAT_B8G8R8A8_UNORM).
    /// Returns true on success, false on error (triggers WebGL fallback).
    bool PresentFrame(ID3D11Texture2D* srcTexture);

    /// Present a GPU-resident frame from raw RGBA8 pixel data via GPU upload.
    /// Used as a GPU-to-GPU fallback when the source is already on-GPU but in
    /// a non-D3D format (e.g. CUDA NvCVImage). Internally uploads via D3D11
    /// UpdateSubresource (GPU→GPU copy within the same adapter).
    /// Returns true on success.
    bool PresentFrameFromCudaBuffer(const void* srcData, uint32_t width, uint32_t height, uint32_t stride);

    /// Present from a CUDA device pointer using CUDA-D3D11 interop.
    /// This is the true GPU-resident path — copies from CUDA device memory
    /// directly to the D3D11 swapchain backbuffer with no CPU roundtrip.
    /// Falls back to PresentFrameFromCudaBuffer if CUDA interop is unavailable.
    /// Returns true on success.
    bool PresentFrameFromCudaGpuBuffer(const void* cudaDevicePtr, uint32_t width, uint32_t height, uint32_t stride);

    // ── Accessors ──────────────────────────────────────────────────────

    bool IsActive() const { return active_; }
    HWND GetPresenterWindow() const { return presenterWnd_; }
    uint32_t SurfaceWidth() const { return surfaceWidth_; }
    uint32_t SurfaceHeight() const { return surfaceHeight_; }

    ID3D11Device* D3DDevice() const { return d3dDevice_.Get(); }
    ID3D11DeviceContext* D3DContext() const { return d3dContext_.Get(); }

    PresenterDiagnostics& Diagnostics() { return diag_; }
    PresenterSnapshot GetSnapshot() const;

private:
    bool CreateD3DResources(HWND ownerHwnd, uint32_t width, uint32_t height);
    void DestroyD3DResources();
    bool CreateSwapchain(HWND ownerHwnd, uint32_t width, uint32_t height);
    bool ResizeSwapchain(uint32_t width, uint32_t height);

    // Presenter window
    HWND ownerHwnd_ = nullptr;
    HWND presenterWnd_ = nullptr;
    uint32_t surfaceWidth_ = 0;
    uint32_t surfaceHeight_ = 0;
    int32_t surfaceX_ = 0;
    int32_t surfaceY_ = 0;
    bool visible_ = true;
    bool active_ = false;

    // D3D11 resources
    ComPtr<ID3D11Device> d3dDevice_;
    ComPtr<ID3D11DeviceContext> d3dContext_;
    ComPtr<IDXGISwapChain1> swapChain_;
    ComPtr<ID3D11Texture2D> backBuffer_;
    ComPtr<ID3D11Texture2D> stagingTexture_;   // For GPU-to-GPU fallback path

    // Diagnostics
    PresenterDiagnostics diag_;

    // Window class atom (lazy-registered once)
    static bool s_windowClassRegistered;
    static const wchar_t* kWindowClassName;

    static LRESULT CALLBACK PresenterWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);
};

/// Get global presenter diagnostics counters.
PresenterDiagnostics& GetPresenterDiagnostics();

} // namespace screenlink::video
